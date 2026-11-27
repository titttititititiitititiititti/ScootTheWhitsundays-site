import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LOCAL_DB_DIR = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-vis-'));
process.env.ADMIN_PIN = '1357';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
process.env.OWNER_NOTIFY_EMAIL = 'owner@example.com';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.RESEND_API_KEY;
const { migrate, query } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { todayLocal } = await import('../src/pricing.js');
const { loadSettings } = await import('../src/settings.js');
const { setEmailSinkForTests } = await import('../src/email.js');
const { sourceFrom, isBot, sendPriceAlerts, sendDailySummary, stats } = await import('../src/visitors.js');

const sent = [];
setEmailSinkForTests(async (m) => { sent.push(m); });
await migrate();
await loadSettings();
await query(`insert into bikes (number, name) values (4, 'Agility'), (5, 'Agility')`);
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const today = todayLocal();
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const as = (ip, ua = PHONE) => ({ 'User-Agent': ua, 'CF-Connecting-IP': ip });
const trackVisit = (ip, body, ua) => fetch(base + '/api/track', {
  method: 'POST', headers: { ...as(ip, ua), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const checkPrice = (ip, start, end, count = 1) =>
  fetch(`${base}/api/availability?view=1&start=${start}&end=${end}&count=${count}`, { headers: as(ip) });
const settle = () => new Promise((r) => setTimeout(r, 150)); // tracking runs after the response is sent

test('where visitors came from', () => {
  assert.equal(sourceFrom('', 'https://www.google.com.au/', 'airliescooterhire.com'), 'Google');
  assert.equal(sourceFrom('', 'https://l.instagram.com/?u=x', 'airliescooterhire.com'), 'Instagram');
  assert.equal(sourceFrom('ig', '', 'airliescooterhire.com'), 'Instagram');
  assert.equal(sourceFrom('', '', 'airliescooterhire.com'), 'Direct');
  assert.equal(sourceFrom('', 'https://www.airliescooterhire.com/', 'airliescooterhire.com'), null); // own page
  assert.equal(sourceFrom('', 'https://hostelworld.com/x', 'airliescooterhire.com'), 'hostelworld.com');
  assert.ok(isBot('Googlebot/2.1') && isBot('') && isBot('curl/8') && !isBot(PHONE));
});

test('visits, price checks and the funnel; bots ignored', async () => {
  const start = addDays(today, 5), end = addDays(today, 7);
  await trackVisit('10.0.0.1', { kind: 'visit', ref: 'https://www.google.com/' });
  await trackVisit('10.0.0.1', { kind: 'visit', ref: 'https://www.google.com/' }); // same person again
  await trackVisit('10.0.0.1', { kind: 'book_open', ref: base + '/' });
  await checkPrice('10.0.0.1', start, end);
  await checkPrice('10.0.0.1', start, end, 2);
  await trackVisit('10.0.0.2', { kind: 'visit', utm: 'instagram' });
  await trackVisit('10.0.0.3', { kind: 'visit' }, 'Googlebot/2.1');
  await fetch(`${base}/api/availability?start=${start}&end=${end}&count=1`, { headers: as('10.0.0.4') }); // not from the booking page
  await settle();
  const s = await stats(today, today);
  assert.deepEqual({ ...s.funnel }, { visit: 2, bookOpen: 1, priceSeen: 1, checkout: 0, paid: 0, anyone: 2 });
  assert.deepEqual(s.sources.map((x) => [x.source, x.visitors]).sort(), [['Google', 1], ['Instagram', 1]]);
  assert.deepEqual(s.lengths, [{ length: '2–3 days', saw_price: 1, went_to_payment: 0 }]);
  const [{ n }] = await query(`select count(*)::int as n from site_events where visitor ~ '[^0-9a-f]'`);
  assert.equal(n, 0, 'only hashes are stored');
});

test('price-check email: waits until they stop looking, sent once, says what they saw', async () => {
  sent.length = 0;
  assert.equal(await sendPriceAlerts(new Date()), 0, 'not while they might still be looking');
  const later = new Date(Date.now() + 5 * 60 * 1000);
  assert.equal(await sendPriceAlerts(later), 1);
  assert.equal(await sendPriceAlerts(later), 0, 'only once per visitor per day');
  const m = sent[0];
  assert.equal(m.to, 'owner@example.com');
  assert.match(m.subject, /Someone checked prices: 3 days, 2 scooters, \$360/);
  assert.match(m.html, /1 scooter · \$180/);
  assert.match(m.html, /2 scooters · \$360/);
  assert.match(m.html, /Came from:<\/b> Google/);
  assert.match(m.html, /Saw the price and left/);
  assert.doesNotMatch(m.html, /10\.0\.0\.1/);
});

test('your own visits while logged into admin are not counted', async () => {
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { ...as('10.0.0.9'), 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1357' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await fetch(base + '/api/track', { method: 'POST', headers: { ...as('10.0.0.9'), Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'visit' }) });
  await settle();
  assert.equal((await stats(today, today)).funnel.visit, 2);
  const v = await (await fetch(base + '/api/admin/visitors?days=7', { headers: { ...as('10.0.0.9'), Cookie: cookie } })).json();
  assert.equal(v.days, 7);
  assert.equal(v.recent.length, 1);
  assert.equal(v.recent[0].outcome, 'left');
  assert.equal(v.recent[0].options.length, 2);
});

test('evening summary: only after the summary hour, once a day', async () => {
  sent.length = 0;
  const at = (hour) => new Date(`${today}T${String(hour).padStart(2, '0')}:30:00+10:00`); // Brisbane is UTC+10
  assert.equal(await sendDailySummary(at(14)), false);
  assert.equal(await sendDailySummary(at(20)), true);
  assert.equal(await sendDailySummary(at(21)), false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Today on the website: 2 visitors, 1 price check, 0 bookings/);
  assert.match(sent[0].html, /1 person<\/b> saw a price and didn't go on to payment/);
});
