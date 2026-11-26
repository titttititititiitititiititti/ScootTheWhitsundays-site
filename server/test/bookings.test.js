import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LOCAL_DB_DIR = ':memory:';
process.env.DATA_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'ash-test-'));
delete process.env.STRIPE_SECRET_KEY;
delete process.env.DATABASE_URL;
const { migrate, query } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { todayLocal } = await import('../src/pricing.js');
const { buildAgreement, allItemIds } = await import('../src/agreement.js');

await migrate();
await query(`insert into bikes (number, name) values (1,'A'),(2,'B')`);
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const start = addDays(todayLocal(), 10);
const end = addDays(start, 2);
const ids = allItemIds(buildAgreement({ start, end, days: 3, count: 1, rent: 18000, bond: 25000, bondEach: 25000, bondMethod: 'charge' }));
const ids2 = allItemIds(buildAgreement({ start, end, days: 3, count: 2, rent: 36000, bond: 50000, bondEach: 25000, bondMethod: 'charge' }));

export const PHOTO = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]).toString('base64');
const body = (over = {}) => ({
  start, end, bikeIds: [1], name: 'Jo Rider', dob: '1995-04-02', phone: '0400 000 000', email: 'jo@example.com',
  licNumber: 'ABC123', licType: 'Full car licence', lic12m: 'Yes', accidents: 'No',
  restrictions: 'No', accepted: ids, signatureName: 'Jo Rider', signatureDate: todayLocal(), licencePhotos: [PHOTO, PHOTO], ...over,
});
const post = (b) => fetch(base + '/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

test('rejects missing agreement ticks', async () => {
  const r = await post(body({ accepted: ids.slice(1) }));
  assert.equal(r.status, 400);
});

test('creates a pending booking with the signed agreement, then blocks double booking', async () => {
  const r = await post(body());
  assert.equal(r.status, 201);
  const { bookingId } = await r.json();
  const [b] = await query('select status, rent_amount, bond_method, agreement, pending_expires_at from bookings where id = $1', [bookingId]);
  assert.equal(b.status, 'pending_payment');
  assert.equal(b.rent_amount, 18000);
  assert.equal(b.bond_method, 'charge');
  assert.ok(b.pending_expires_at);
  assert.equal(b.agreement.sections.flatMap((s) => s.items).length, ids.length);

  const again = await post(body({ start: end, end: addDays(end, 1) })); // overlaps on the return day
  assert.equal(again.status, 409);
  const other = await post(body({ bikeIds: [2] }));
  assert.equal(other.status, 201);
});

test('books several scooters at once, all or nothing', async () => {
  const s2 = addDays(start, 20), e2 = addDays(s2, 2);
  const mk = (bikeIds, accepted) => post(body({ start: s2, end: e2, bikeIds, accepted }));
  const r = await mk([1, 3], ids2);
  assert.equal(r.status, 400); // bike 3 doesn't exist
  const ok = await mk([1, 2], ids2);
  assert.equal(ok.status, 201);
  const data = await ok.json();
  assert.deepEqual(data.bikeNumbers, [1, 2]);
  assert.equal(data.quote.rent, 36000);
  assert.equal(data.quote.bond, 50000);
  const [b] = await query('select scooter_count, rent_amount from bookings where id = $1', [data.bookingId]);
  assert.equal(b.scooter_count, 2);
  const again = await mk([2], ids);
  assert.equal(again.status, 409);
  // the group clause is required for 2+ scooters
  const missing = await post(body({ start: addDays(s2, 10), end: addDays(s2, 11), bikeIds: [1, 2], accepted: ids }));
  assert.equal(missing.status, 400);
});

test('licence photos: one per scooter, real images only', async () => {
  const s3 = addDays(start, 40), e3 = addDays(s3, 1);
  const few = await post(body({ start: s3, end: e3, bikeIds: [1, 2], accepted: ids2, licencePhotos: [PHOTO] }));
  assert.equal(few.status, 400);
  assert.match((await few.json()).error, /2 needed/);
  const fake = await post(body({ start: s3, end: e3, licencePhotos: ['data:image/jpeg;base64,' + Buffer.from('<script>').toString('base64')] }));
  assert.equal(fake.status, 400);
  const ok = await post(body({ start: s3, end: e3 }));
  assert.equal(ok.status, 201);
  const { bookingId } = await ok.json();
  const media = await query('select phase, file_path from booking_media where booking_id = $1', [bookingId]);
  assert.equal(media.length, 2);
  assert.ok(media.every((m) => m.phase === 'licence'));
  const fs = await import('node:fs');
  const path = await import('node:path');
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'uploads', media[0].file_path)));
  // licence photos are never served publicly
  const leak = await fetch(base + '/uploads/' + media[0].file_path);
  assert.notEqual(leak.status, 200);
});

test('pressing Continue again after a lost reply reuses the same reservation', async () => {
  const s3 = addDays(start, 70), e3 = addDays(s3, 2);
  const key = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const first = await post(body({ start: s3, end: e3, requestKey: key }));
  assert.equal(first.status, 201);
  const a = await first.json();
  const second = await post(body({ start: s3, end: e3, requestKey: key }));
  assert.equal(second.status, 200);
  const b = await second.json();
  assert.equal(b.bookingId, a.bookingId);
  assert.equal(b.resumed, true);
  const rows = await query('select count(*) as n from bookings where request_key = $1', [key]);
  assert.equal(rows[0].n, 1);
  const media = await query(`select count(*) as n from booking_media where booking_id = $1`, [a.bookingId]);
  assert.equal(media[0].n, 2);
  // A different submission (no key / new key) for the same bike and dates is still refused.
  const other = await post(body({ start: s3, end: e3, requestKey: 'ffffffffffffffffffffffffffffffff' }));
  assert.equal(other.status, 409);
});
