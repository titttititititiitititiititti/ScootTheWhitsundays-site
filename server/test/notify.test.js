import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LOCAL_DB_DIR = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-mail-'));
process.env.OWNER_NOTIFY_EMAIL = 'owner@example.com';
process.env.PUBLIC_BASE_URL = 'https://airliescooterhire.test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
delete process.env.RESEND_API_KEY;
const { migrate, query } = await import('../src/db.js');
const { setEmailSinkForTests } = await import('../src/email.js');
const notify = await import('../src/notify.js');

let sent = [];
let failNext = false;
setEmailSinkForTests(async (m) => {
  if (failNext) { failNext = false; throw new Error('Resend 503'); }
  sent.push(m);
});

await migrate();
await query(`insert into bikes (number, name, lockbox_number, lockbox_code) values
  (2, 'Red Devil 50cc', 'LB2', '4821'), (4, 'Kymco Super 8 50cc', null, null)`);

async function makeBooking(overrides = {}) {
  const v = {
    status: 'confirmed', bond_status: 'held', name: 'Jo <b>Rider</b>', ...overrides,
  };
  const [b] = await query(
    `insert into bookings (access_token, scooter_count, customer_name, customer_email, customer_phone, customer_dob,
       licence_number, licence_type, start_date, end_date, days, rent_amount, bond_amount, bond_method, bond_status,
       status, agreement, signature_name, signature_date, agreement_signed_at)
     values ($1, 2, $2, 'jo@example.com', '0400 000 000', '1995-04-02', 'ABC123', 'Full car licence',
       '2026-12-01', '2026-12-03', 3, 36000, 50000, 'hold', $3, $4, '{}', 'Jo Rider', '2026-11-25', now())
     returning *`, ['tok_' + Math.random().toString(36).slice(2).padEnd(24, 'x'), v.name, v.bond_status, v.status]);
  const bikes = await query('select id from bikes order by number');
  for (const bk of bikes) await query('insert into booking_bikes values ($1, $2)', [b.id, bk.id]);
  return b;
}

test('confirmed booking: customer + owner emails, sent once', async () => {
  sent = [];
  const b = await makeBooking();
  assert.equal(await notify.sendConfirmation(b.id), true);
  assert.equal(sent.length, 2);
  const [cust, owner] = sent;

  assert.equal(cust.to, 'jo@example.com');
  assert.match(cust.html, /Bike 2/);
  assert.match(cust.html, /LB2/);
  assert.match(cust.html, /4821/);
  assert.match(cust.html, /text you the lockbox code/);            // Bike 4 has no code yet
  assert.match(cust.html, /Tue, 1 Dec/);
  assert.match(cust.html, /Thu, 3 Dec/);
  assert.ok(cust.html.includes(`https://airliescooterhire.test/trip?t=${b.access_token}`));
  assert.ok(!cust.html.includes('<b>Rider</b>'), 'customer name must be escaped');
  assert.match(cust.text, /code 4821/);

  assert.equal(owner.to, 'owner@example.com');
  assert.equal(owner.subject, 'Booking: Jo <b>Rider</b> – Bikes 2, 4 – 1 Dec–3 Dec');
  assert.equal(owner.replyTo, 'jo@example.com');
  assert.match(owner.html, /No lockbox code set for Bike 4/);

  // A second webhook / sweep must not send again.
  assert.equal(await notify.sendConfirmation(b.id), false);
  assert.equal(sent.length, 2);
});

test('a failed send is retried by the sweep', async () => {
  sent = [];
  const b = await makeBooking();
  failNext = true;
  assert.equal(await notify.sendConfirmation(b.id), true); // owner email sent; customer one failed
  const [row] = await query('select confirmation_sent_at from bookings where id = $1', [b.id]);
  assert.equal(row.confirmation_sent_at, null);
  // The sweep only looks at future-or-current hires; this one ends 2026-12-03.
  await query(`update bookings set start_date = current_date, end_date = current_date + 2 where id = $1`, [b.id]);
  assert.equal(sent.filter((m) => m.to === 'owner@example.com').length, 1); // owner email still went out
  await notify.retryUnsentConfirmations();
  assert.ok(sent.some((m) => m.to === 'jo@example.com'));
  assert.equal(sent.filter((m) => m.to === 'owner@example.com').length, 1); // and is not sent twice
});

test('awaiting bond: customer gets the "one more step" email, no lockbox code', async () => {
  sent = [];
  const b = await makeBooking({ status: 'awaiting_bond', bond_status: 'none' });
  await notify.onBookingConfirmed(b.id, 'awaiting_bond');
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /confirm your bond hold/);
  assert.ok(!sent[0].html.includes('4821'));
  assert.ok(sent[0].html.includes(`/booked?t=${b.access_token}`));
  // Not confirmed yet, so no confirmation is sent.
  assert.equal(await notify.sendConfirmation(b.id), false);
});

test('without a Resend key, emails are saved to the outbox folder', async () => {
  setEmailSinkForTests(null);
  const { sendEmail, outboxDir } = await import('../src/email.js');
  await sendEmail({ to: 'x@example.com', subject: 'Hello there', html: '<p>hi</p>', text: 'hi' });
  const files = fs.readdirSync(outboxDir());
  assert.ok(files.some((f) => f.includes('Hello-there')));
});
