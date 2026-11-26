import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LOCAL_DB_DIR = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-lt-'));
process.env.ADMIN_PIN = '1357';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
process.env.OWNER_NOTIFY_EMAIL = 'owner@example.com';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.RESEND_API_KEY;
const { migrate, query } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { todayLocal, quote } = await import('../src/pricing.js');
const { loadSettings } = await import('../src/settings.js');
const { dueDates, rentStatus, sendRentReminders } = await import('../src/longTerm.js');
const { setEmailSinkForTests } = await import('../src/email.js');
const { buildAgreement, allItemIds } = await import('../src/agreement.js');

const sent = [];
setEmailSinkForTests(async (m) => { sent.push(m); });
await migrate();
await loadSettings();
await query(`insert into bikes (number, name) values (4, 'Agility'), (5, 'Agility'), (6, 'Agility')`);
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const today = todayLocal();
let cookie = '';
const api = async (p, { method = 'GET', body } = {}) => {
  if (!cookie) {
    const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1357' }) });
    cookie = r.headers.get('set-cookie').split(';')[0];
  }
  return fetch(base + '/api/admin' + p, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
};
const bikeId = async (n) => (await query('select id from bikes where number = $1', [n]))[0].id;
const bikeOf = async (n) => (await (await api('/overview')).json()).bikes.find((b) => b.number === n);

test('rent days: the start day and every 7 days after', () => {
  const r = { start_date: '2026-11-02', end_date: null };
  assert.deepEqual(dueDates(r, '2026-11-20'), ['2026-11-02', '2026-11-09', '2026-11-16']);
  const s = rentStatus(r, ['2026-11-02'], '2026-11-20');
  assert.deepEqual(s.owed, ['2026-11-09', '2026-11-16']);
  assert.equal(s.next, '2026-11-23');
  // Paid ahead: next due skips the paid week.
  assert.equal(rentStatus(r, ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'], '2026-11-20').next, '2026-11-30');
  // Returned on a rent day: that week isn't owed.
  assert.deepEqual(dueDates({ start_date: '2026-11-02', end_date: '2026-11-16' }, '2026-11-30'), ['2026-11-02', '2026-11-09']);
});

test('long-term rental: blocks online booking, tracks paid weeks and income', async () => {
  const id = await bikeId(4);
  const start = addDays(today, -14); // started two weeks ago → 3 rent days so far
  const r = await api(`/bikes/${id}/long-term`, { method: 'POST', body: { renterName: 'Kai', renterPhone: '0411 111 111', weeklyRate: '150', start } });
  assert.equal(r.status, 201);
  // Second rental on the same scooter is refused.
  assert.equal((await api(`/bikes/${id}/long-term`, { method: 'POST', body: { renterName: 'X', weeklyRate: '100', start: today } })).status, 400);

  const avail = await (await fetch(`${base}/api/availability?start=${addDays(today, 30)}&end=${addDays(today, 31)}&count=1`)).json();
  assert.ok(!avail.bikes.some((b) => b.number === 4), 'not bookable online while rented long-term');

  let b = await bikeOf(4);
  assert.equal(b.today.state, 'longterm');
  assert.deepEqual(b.longTerm.owed, [start, addDays(start, 7), today]);
  let o = await (await api('/overview')).json();
  assert.equal(o.longTermWeekly, 15000);
  assert.equal(o.rentDue.length, 3);

  for (const d of [start, addDays(start, 7)]) {
    assert.equal((await api(`/long-term/${b.longTerm.id}/paid`, { method: 'POST', body: { dueDate: d } })).status, 200);
  }
  assert.equal((await api(`/long-term/${b.longTerm.id}/paid`, { method: 'POST', body: { dueDate: addDays(today, 1) } })).status, 400, 'not a rent day');
  b = await bikeOf(4);
  assert.deepEqual(b.longTerm.owed, [today]);
  assert.equal(b.longTerm.totalPaid, 30000);
  assert.equal(Number(b.income.longTermAllTime), 30000);
  assert.equal(Number(b.income.longTermWeeks), 2);

  // Price change applies to weeks paid after it.
  assert.equal((await api(`/long-term/${b.longTerm.id}`, { method: 'PATCH', body: { weeklyRate: '170' } })).status, 200);
  await api(`/long-term/${b.longTerm.id}/paid`, { method: 'POST', body: { dueDate: today } });
  b = await bikeOf(4);
  assert.equal(b.longTerm.totalPaid, 30000 + 17000);
  assert.deepEqual(b.longTerm.owed, []);
  assert.equal(b.longTerm.nextDue, addDays(today, 7));
  // Undo.
  await api(`/long-term/${b.longTerm.id}/paid`, { method: 'POST', body: { dueDate: today, undo: true } });
  assert.deepEqual((await bikeOf(4)).longTerm.owed, [today]);

  // Scooter returned (on a rent day, so no new week is owed) with the first week still unpaid.
  await api(`/long-term/${b.longTerm.id}/paid`, { method: 'POST', body: { dueDate: start, undo: true } });
  assert.equal((await api(`/long-term/${b.longTerm.id}/end`, { method: 'POST', body: {} })).status, 200);
  const after = await (await fetch(`${base}/api/availability?start=${addDays(today, 1)}&end=${addDays(today, 2)}&count=1`)).json();
  assert.ok(after.bikes.some((x) => x.number === 4));
  o = await (await api('/overview')).json();
  assert.equal(o.longTermWeekly, 0);
  assert.ok(o.rentDue.some((d) => d.dueDate === start), 'unpaid week stays on the list');
  assert.ok(!o.rentDue.some((d) => d.dueDate === today), 'returned on rent day: no new week');
  assert.equal((await bikeOf(4)).longTerm, null);
});

test('rent-due email: once, on rent day, after the reminder hour, only if unpaid', async () => {
  const start = addDays(today, -7);
  await api(`/bikes/${await bikeId(5)}/long-term`, { method: 'POST', body: { renterName: 'Mia', weeklyRate: '140', start } });
  await api(`/bikes/${await bikeId(6)}/long-term`, { method: 'POST', body: { renterName: 'Leo', weeklyRate: '160', start } });
  const leo = (await bikeOf(6)).longTerm;
  await api(`/long-term/${leo.id}/paid`, { method: 'POST', body: { dueDate: today } }); // Leo paid today already
  sent.length = 0;
  const at = (hh) => new Date(`${today}T${hh}:00:00+10:00`);
  assert.equal(await sendRentReminders(at('07')), 0, 'too early');
  assert.equal(await sendRentReminders(at('10')), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.match(sent[0].subject, /^Rent due today: Bike 5 – Mia – \$140/);
  assert.match(sent[0].html, /Also not marked paid/); // last week's rent too
  assert.equal(await sendRentReminders(at('14')), 0, 'only once per rent day');
});

test('delivery and pick-up: $10 per scooter per trip, added to the total', async () => {
  const s = addDays(today, 40), e = addDays(today, 42);
  const q = quote(s, e, 2, new Date(), { delivery: true, collection: true });
  assert.equal(q.rent, 2 * 3 * 6000);
  assert.equal(q.deliveryEach, 2000);
  assert.equal(q.deliveryTotal, 4000);
  assert.equal(quote(s, e, 1, new Date(), { delivery: true }).deliveryTotal, 1000);
  assert.equal(quote(s, s, 1).rent, 7000, 'one day = $60 + $10');
  const pay = buildAgreement(q)[0].items.find((i) => i.id === 'agreePayment').text;
  assert.match(pay, /plus \$40 AUD for delivery and collection/);
  assert.match(buildAgreement(q)[0].items.find((i) => i.id === 'agreeReturn').text, /ready for collection/);

  // Booking with delivery needs an address and stores the fee.
  await query(`insert into bikes (number, name) values (8, 'Like')`);
  const q1 = quote(s, e, 1, new Date(), { delivery: true });
  const body = (address) => ({
    start: s, end: e, bikeIds: [await8], name: 'Jo Rider', dob: '1995-04-02', phone: '0400 000 000', email: 'jo@example.com',
    address, licNumber: 'ABC', licType: 'Full car licence', lic12m: 'Yes', accidents: 'No', restrictions: 'No',
    accepted: allItemIds(buildAgreement(q1)), signatureName: 'Jo Rider', signatureDate: today, delivery: true,
    licencePhotos: ['data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString('base64')],
  });
  const await8 = await bikeId(8);
  const post = (b) => fetch(base + '/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const noAddr = await post(body(''));
  assert.equal(noAddr.status, 400);
  assert.match((await noAddr.json()).error, /address for delivery/);
  const ok = await post(body('5 Coral Esplanade, Airlie Beach'));
  assert.equal(ok.status, 201);
  const { bookingId } = await ok.json();
  const [row] = await query('select delivery, collection, delivery_amount, rent_amount from bookings where id = $1', [bookingId]);
  assert.deepEqual([row.delivery, row.collection, row.delivery_amount, row.rent_amount], [true, false, 1000, 18000]);
});
