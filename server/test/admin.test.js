import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LOCAL_DB_DIR = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-admin-'));
process.env.ADMIN_PIN = '1357';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
delete process.env.STRIPE_SECRET_KEY;
const { migrate, query } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { todayLocal, quote } = await import('../src/pricing.js');
const { loadSettings } = await import('../src/settings.js');
const { resetLoginLimitsForTests } = await import('../src/routes/admin.js');
const { buildAgreement, allItemIds } = await import('../src/agreement.js');

await migrate();
await loadSettings();
await query(`insert into bikes (number, name, needs_motorcycle_licence) values (1, 'Agility', false), (2, 'Super 8', false), (7, 'Suzuki Address 100cc', true)`);
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const today = todayLocal();
let cookie = '';
const api = (p, { method = 'GET', body, auth = true } = {}) => fetch(base + '/api/admin' + p, {
  method,
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const bikeId = async (n) => (await query('select id from bikes where number = $1', [n]))[0].id;

test('PIN login: wrong PINs are limited, the right one gives a session cookie', async () => {
  assert.equal((await api('/overview', { auth: false })).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await api('/login', { method: 'POST', body: { pin: '1111' } })).status, 401);
  assert.equal((await api('/login', { method: 'POST', body: { pin: '1357' } })).status, 429, 'locked after 5 wrong tries');
  resetLoginLimitsForTests();
  const ok = await api('/login', { method: 'POST', body: { pin: '1357' } });
  assert.equal(ok.status, 200);
  const set = ok.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
  assert.equal((await api('/overview')).status, 200);
  // A forged cookie doesn't work.
  const forged = cookie.slice(0, -4) + 'AAAA';
  assert.equal((await fetch(base + '/api/admin/overview', { headers: { Cookie: forged } })).status, 401);
});

test('prices: saved from admin, used for new quotes, one day costs the extra', async () => {
  const r = await api('/pricing', { method: 'PUT', body: { dailyRate: '55', oneDayExtra: '10', weeklyRate: '' } });
  assert.equal(r.status, 200);
  const q1 = quote(addDays(today, 3), addDays(today, 3), 1);
  assert.equal(q1.rent, 6500);                 // $55 + $10
  const q3 = quote(addDays(today, 3), addDays(today, 5), 2);
  assert.equal(q3.rentEach, 16500);            // 3 Ã— $55
  assert.equal(q3.rent, 33000);
  assert.equal((await api('/pricing', { method: 'PUT', body: { dailyRate: '-5' } })).status, 400);
  // Survives a restart.
  const { setPricingForTests, loadSettings: reload, getPricing } = await import('../src/settings.js');
  setPricingForTests({});
  await reload();
  assert.equal(getPricing().dailyRate, 5500);
  await api('/pricing', { method: 'PUT', body: { dailyRate: '60', oneDayExtra: '10', weeklyRate: '0' } });
});

test('availability blocks hide a scooter from booking for those dates', async () => {
  const id = await bikeId(2);
  const s = addDays(today, 10), e = addDays(today, 12);
  const avail = async (a, b) => (await (await fetch(`${base}/api/availability?start=${a}&end=${b}&count=1`)).json()).bikes.map((x) => x.number);
  assert.ok((await avail(s, e)).includes(2));
  const r = await api(`/bikes/${id}/blocks`, { method: 'POST', body: { start: s, end: e, reason: 'Repair' } });
  assert.equal(r.status, 201);
  const { id: blockId } = await r.json();
  assert.ok(!(await avail(s, e)).includes(2));
  assert.ok(!(await avail(e, addDays(e, 3))).includes(2), 'overlap on the last day');
  assert.ok((await avail(addDays(e, 1), addDays(e, 2))).includes(2), 'free again after');
  const cal = await (await fetch(`${base}/api/calendar?from=${s}&to=${addDays(e, 1)}`)).json();
  const freeOn = (d) => cal.days.find((x) => x.date === d).free;
  assert.equal(freeOn(s), 2);
  assert.equal(freeOn(addDays(e, 1)), 3);
  // Open-ended ("until I change it") long-term rental.
  const lt = await api(`/bikes/${await bikeId(1)}/blocks`, { method: 'POST', body: { start: today, end: null, reason: 'Long-term rental' } });
  assert.equal(lt.status, 201);
  assert.ok(!(await avail(addDays(today, 200), addDays(today, 201))).includes(1));
  const { id: ltId } = await lt.json();
  assert.equal((await api('/blocks/' + ltId, { method: 'DELETE' })).status, 200);
  assert.equal((await api('/blocks/' + blockId, { method: 'DELETE' })).status, 200);
  assert.ok((await avail(s, e)).includes(2));
  assert.equal((await api(`/bikes/${id}/blocks`, { method: 'POST', body: { start: e, end: s } })).status, 400);
});

test('a scooter over 50cc needs a motorcycle licence', async () => {
  const start = addDays(today, 20), end = addDays(today, 21);
  const q = quote(start, end, 1);
  const body = (licType) => ({
    start, end, bikeIds: [await7], name: 'Jo Rider', dob: '1995-04-02', phone: '0400 000 000', email: 'jo@example.com',
    licNumber: 'ABC', licType, lic12m: 'Yes', accidents: 'No', restrictions: 'No',
    accepted: allItemIds(buildAgreement(q)), signatureName: 'Jo Rider', signatureDate: today,
    licencePhotos: ['data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString('base64')],
  });
  const await7 = await bikeId(7);
  const post = (b) => fetch(base + '/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const car = await post(body('Full car licence'));
  assert.equal(car.status, 400);
  assert.match((await car.json()).error, /motorcycle licence/);
  assert.equal((await post(body('Motorcycle licence'))).status, 201);
});

test('income per scooter and the bookings list', async () => {
  const mk = async (bikes, rent, status, startIn) => {
    const s = addDays(today, startIn);
    const [b] = await query(
      `insert into bookings (access_token, scooter_count, customer_name, customer_email, customer_phone, licence_number, licence_type,
         start_date, end_date, days, rent_amount, bond_amount, bond_method, status, agreement, signature_name, signature_date,
         agreement_signed_at, paid_at)
       values (md5(random()::text), $1, 'Sam', 's@example.com', '0400', 'X', 'Full car licence', $2, $2, 1, $3, 25000, 'hold', $4,
         '{}', 'Sam', $2, now(), case when $4 = 'pending_payment' then null else now() end) returning id`,
      [bikes.length, s, rent, status]);
    for (const n of bikes) await query('insert into booking_bikes values ($1, $2)', [b.id, await bikeId(n)]);
  };
  await mk([1], 7500, 'confirmed', 0);
  await mk([1, 2], 24000, 'active', 0);          // $120 each
  await mk([2], 99900, 'cancelled', 0);          // never counts
  const o = await (await api('/overview')).json();
  const inc = (n) => o.bikes.find((b) => b.number === n).income;
  assert.equal(Number(inc(1).allTime), 7500 + 12000);
  assert.equal(Number(inc(1).hires), 2);
  assert.equal(Number(inc(2).allTime), 12000 + 0);
  assert.equal(o.bikes.find((b) => b.number === 1).today.state, 'booked');
  assert.ok(o.bookings.every((b) => b.status !== 'cancelled'));
  assert.ok(o.bookings.some((b) => b.start === today));
});
