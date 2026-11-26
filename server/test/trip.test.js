import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LOCAL_DB_DIR = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-trip-'));
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
delete process.env.RESEND_API_KEY;
const { migrate, query } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { todayLocal } = await import('../src/pricing.js');
const { uploadsRoot, sniffMedia } = await import('../src/uploads.js');
const { tripWindows } = await import('../src/routes/trip.js');

await migrate();
await query(`insert into bikes (number, name) values (1, 'Kymco Like'), (2, 'Red Devil'), (3, 'SYM Mio')`);
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
let n = 0;
async function trip({ startIn = 0, days = 3, bikes = [1, 2], status = 'confirmed' } = {}) {
  const start = addDays(todayLocal(), startIn), end = addDays(start, days - 1);
  const token = 'trip-token-' + (++n) + '-'.repeat(20);
  const [b] = await query(
    `insert into bookings (access_token, scooter_count, customer_name, customer_email, customer_phone, customer_dob,
       licence_number, licence_type, start_date, end_date, days, rent_amount, bond_amount, bond_method, bond_status,
       status, agreement, signature_name, signature_date, agreement_signed_at)
     values ($1, $2, 'Jo Rider', 'jo@example.com', '0400 000 000', '1995-04-02', 'X1', 'Full car licence',
       $3, $4, $5, 18000, 25000, 'hold', 'held', $6, '{}', 'Jo Rider', $3, now()) returning *`,
    [token, bikes.length, start, end, days, status]);
  await query(`insert into booking_bikes (booking_id, bike_id) select $1, id from bikes where number = any($2::int[])`, [b.id, bikes]);
  return b;
}
// A tiny fake MP4: "....ftypisom" header + filler.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(2000, 7)]);
const upload = (tok, phase, bike, body, type = 'video/mp4') =>
  fetch(`${base}/api/trip/media?t=${tok}&phase=${phase}&bike=${bike}`, { method: 'POST', headers: { 'Content-Type': type }, body });

test('file types are recognised from their contents, not their names', () => {
  assert.equal(sniffMedia(MP4).mime, 'video/mp4');
  assert.equal(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(8)])).mime, 'video/quicktime');
  assert.equal(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(8)])).kind, 'photo');
  assert.equal(sniffMedia(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])).mime, 'image/jpeg');
  assert.equal(sniffMedia(Buffer.from('<html><script>alert(1)</script>')), null);
});

test('upload windows follow the hire dates', () => {
  const t0 = '2026-12-10';
  const b = { status: 'confirmed', start_date: '2026-12-10', end_date: '2026-12-12' };
  assert.deepEqual(tripWindows(b, '2026-12-08'), { pickup: false, return: false });
  assert.deepEqual(tripWindows(b, '2026-12-09'), { pickup: true, return: false });  // day before pickup
  assert.deepEqual(tripWindows(b, t0), { pickup: true, return: true });
  assert.deepEqual(tripWindows(b, '2026-12-19'), { pickup: false, return: true });   // a week after return
  assert.deepEqual(tripWindows(b, '2026-12-20'), { pickup: false, return: false });
  assert.equal(tripWindows({ ...b, status: 'cancelled' }, t0).pickup, false);
});

test('pickup video: saved privately per scooter, booking becomes active', async () => {
  const b = await trip();
  const r = await upload(b.access_token, 'pickup', 2, MP4);
  assert.equal(r.status, 201, await r.clone().text());
  const [m] = await query(`select * from booking_media where booking_id = $1`, [b.id]);
  assert.equal(m.phase, 'pickup');
  assert.equal(m.bike_number, 2);
  assert.equal(m.mime_type, 'video/mp4');
  assert.equal(m.size_bytes, MP4.length);
  assert.ok(fs.readFileSync(path.join(uploadsRoot(), m.file_path)).equals(MP4));
  const [after] = await query('select status from bookings where id = $1', [b.id]);
  assert.equal(after.status, 'active');
  // Files are never reachable from the website.
  assert.notEqual((await fetch(`${base}/${m.file_path}`)).status, 200);

  const info = await (await fetch(`${base}/api/trip?t=${b.access_token}`)).json();
  assert.equal(info.media.length, 1);
  assert.equal(info.media[0].bike, 2);
  assert.ok(!JSON.stringify(info).includes(m.file_path), 'storage paths are not exposed');

  // A return video does not mark the scooter as returned (only the owner does that).
  assert.equal((await upload(b.access_token, 'return', 1, MP4)).status, 201);
  const [still] = await query('select status from bookings where id = $1', [b.id]);
  assert.equal(still.status, 'active');
});

test('uploads are refused for the wrong file, scooter, link or day', async () => {
  const b = await trip({ bikes: [3] });
  const bad = await upload(b.access_token, 'pickup', 3, Buffer.from('<html>this is not a video at all</html>'), 'video/mp4');
  assert.equal(bad.status, 400);
  assert.equal((await upload(b.access_token, 'pickup', 1, MP4)).status, 400);         // not their scooter
  assert.equal((await upload('x'.repeat(30), 'pickup', 3, MP4)).status, 404);          // unknown link
  assert.equal((await upload(b.access_token, 'selfie', 3, MP4)).status, 400);
  const later = await trip({ startIn: 30, bikes: [3] });
  assert.equal((await upload(later.access_token, 'pickup', 3, MP4)).status, 400);     // too early
  const pending = await trip({ status: 'pending_payment', bikes: [3], startIn: 40 });
  assert.equal((await upload(pending.access_token, 'pickup', 3, MP4)).status, 400);    // unpaid
  const rows = await query(`select count(*) as n from booking_media where booking_id in ($1, $2, $3)`, [b.id, later.id, pending.id]);
  assert.equal(rows[0].n, 0);
  const left = fs.readdirSync(path.join(uploadsRoot(), 'trips', b.id));
  assert.deepEqual(left, [], 'refused uploads leave no files behind');
});
