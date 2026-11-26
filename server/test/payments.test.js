import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LOCAL_DB_DIR = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-pay-'));
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
const { migrate, query } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { todayLocal } = await import('../src/pricing.js');
const { buildAgreement, allItemIds } = await import('../src/agreement.js');
const payments = await import('../src/payments.js');

// ── A fake Stripe that records what we ask of it ──
const calls = [];
let holdShouldFail = false;
let n = 0;
const fake = {
  checkout: { sessions: {
    create: async (p) => { calls.push(['session', p]); n++; return { id: `cs_${n}`, url: `https://checkout.stripe.test/${n}` }; },
    expire: async (id) => { calls.push(['expire', id]); return {}; },
    retrieve: async () => ({ status: 'expired' }),
  } },
  paymentIntents: {
    retrieve: async (id) => ({ id, customer: 'cus_1', payment_method: 'pm_1', status: id.startsWith('pi_bond') ? 'requires_capture' : 'succeeded' }),
    create: async (p) => {
      calls.push(['hold', p]);
      if (holdShouldFail) { const e = new Error('Your card requires authentication'); e.code = 'authentication_required'; throw e; }
      return { id: 'pi_hold_1', status: 'requires_capture' };
    },
  },
  refunds: { create: async (p) => { calls.push(['refund', p]); return {}; } },
};
payments.setStripeForTests(fake);
const confirmed = [];
payments.setOnConfirmed(async (id, status) => { confirmed.push([id, status]); });

await migrate();
await query(`insert into bikes (number, name) values (1,'A'),(2,'B'),(3,'C')`);
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const addDays = (iso, k) => new Date(Date.parse(iso + 'T00:00:00Z') + k * 86400000).toISOString().slice(0, 10);
const PHOTO = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString('base64');

async function book({ startIn, days, bikeIds }) {
  const start = addDays(todayLocal(), startIn);
  const end = addDays(start, days - 1);
  const q = { start, end, days, count: bikeIds.length, rent: 1, bond: 1, bondEach: 1, bondMethod: 'x' };
  const res = await fetch(base + '/api/bookings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start, end, bikeIds, name: 'Jo Rider', dob: '1995-04-02', phone: '0400 000 000', email: 'jo@example.com',
      licNumber: 'ABC123', licType: 'Full car licence', lic12m: 'Yes', accidents: 'No', restrictions: 'No',
      accepted: allItemIds(buildAgreement(q)), signatureName: 'Jo Rider', signatureDate: todayLocal(),
      licencePhotos: bikeIds.map(() => PHOTO),
    }),
  });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  const [b] = await query('select * from bookings where id = $1', [data.bookingId]);
  return { data, b };
}
const lastSession = () => calls.filter((c) => c[0] === 'session').at(-1)[1];
const completed = (b, extra = {}) => payments.handleStripeEvent({
  type: 'checkout.session.completed',
  data: { object: { id: b.stripe_checkout_session_id, payment_status: 'paid', payment_intent: 'pi_rent_' + b.id.slice(0, 4), customer: 'cus_1', metadata: { bookingId: b.id, kind: 'booking' }, ...extra } },
});
const reload = async (id) => (await query('select * from bookings where id = $1', [id]))[0];

test('long hire: rent + bond in one checkout, confirmed by webhook, bond charged', async () => {
  const { data, b } = await book({ startIn: 20, days: 3, bikeIds: [1, 2] });
  assert.match(data.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
  const s = lastSession();
  assert.equal(s.line_items.length, 2);
  assert.equal(s.line_items[0].price_data.unit_amount, 36000); // 2 scooters × 3 days × $60
  assert.equal(s.line_items[1].price_data.unit_amount, 50000); // 2 × $250 bond
  assert.equal(s.payment_intent_data.setup_future_usage, undefined);
  assert.equal(b.status, 'pending_payment');

  await completed(b);
  const after = await reload(b.id);
  assert.equal(after.status, 'confirmed');
  assert.equal(after.bond_status, 'charged');
  assert.equal(after.stripe_bond_payment_intent_id, after.stripe_payment_intent_id);
  assert.deepEqual(confirmed.at(-1), [b.id, 'confirmed']);

  // Stripe sometimes delivers the same event twice: process it only once.
  const before = confirmed.length;
  await completed(b);
  assert.equal(confirmed.length, before);
});

test('short hire: rent in checkout, then an automatic $250 card hold', async () => {
  const { b } = await book({ startIn: 1, days: 2, bikeIds: [3] });
  const s = lastSession();
  assert.equal(s.line_items.length, 1);                       // rent only
  assert.equal(s.payment_intent_data.setup_future_usage, 'off_session');
  await completed(b);
  const hold = calls.filter((c) => c[0] === 'hold').at(-1)[1];
  assert.equal(hold.amount, 25000);
  assert.equal(hold.capture_method, 'manual');
  const after = await reload(b.id);
  assert.equal(after.status, 'confirmed');
  assert.equal(after.bond_status, 'held');
  assert.equal(after.stripe_bond_payment_intent_id, 'pi_hold_1');
});

test('declined hold → awaiting bond (bikes stay blocked) → customer confirms bond → confirmed', async () => {
  holdShouldFail = true;
  const { b } = await book({ startIn: 3, days: 1, bikeIds: [1] });
  await completed(b);
  holdShouldFail = false;
  let after = await reload(b.id);
  assert.equal(after.status, 'awaiting_bond');
  const free = await fetch(`${base}/api/availability?start=${b.start_date}&end=${b.end_date}`).then((r) => r.json());
  assert.ok(!free.bikes.some((x) => x.number === 1));

  const r = await fetch(base + '/api/bond-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: b.access_token }) });
  assert.ok((await r.json()).url);
  assert.equal(lastSession().payment_intent_data.capture_method, 'manual');

  await payments.handleStripeEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_bond', payment_status: 'unpaid', payment_intent: 'pi_bond_9', metadata: { bookingId: b.id, kind: 'bond' } } } });
  after = await reload(b.id);
  assert.equal(after.status, 'confirmed');
  assert.equal(after.bond_status, 'held');
});

test('customer backs out of Stripe: booking cancelled, bikes and licence photos released', async () => {
  const { b } = await book({ startIn: 30, days: 2, bikeIds: [2] });
  const res = await fetch(base + '/api/bookings/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: b.access_token }) });
  assert.deepEqual(await res.json(), { cancelled: true });
  assert.ok(calls.some((c) => c[0] === 'expire' && c[1] === b.stripe_checkout_session_id));
  assert.equal((await reload(b.id)).status, 'cancelled');
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'uploads', 'licences', b.id)), false);
  const free = await fetch(`${base}/api/availability?start=${b.start_date}&end=${b.end_date}`).then((r) => r.json());
  assert.ok(free.bikes.some((x) => x.number === 2));
});

test('Stripe checkout expires unpaid → cancelled; a late payment on a cancelled booking is refunded', async () => {
  const { b } = await book({ startIn: 40, days: 2, bikeIds: [3] });
  await payments.handleStripeEvent({ type: 'checkout.session.expired', data: { object: { id: b.stripe_checkout_session_id, metadata: { bookingId: b.id, kind: 'booking' } } } });
  assert.equal((await reload(b.id)).status, 'cancelled');
  await completed(b);
  assert.equal((await reload(b.id)).status, 'cancelled');
  assert.ok(calls.some((c) => c[0] === 'refund'));
});

test('webhook rejects requests without a valid Stripe signature', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  fake.webhooks = { constructEvent: () => { throw new Error('No signatures found'); } };
  const r = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"checkout.session.completed"}' });
  assert.equal(r.status, 400);
});
