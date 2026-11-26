import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rentFor, hireDays, quote } from '../src/pricing.js';

test('rent: daily rate, single day costs extra', () => {
  const p = { dailyRate: 6000, oneDayExtra: 1500, weeklyRate: 0 };
  assert.equal(rentFor(1, p).rent, 7500);   // $60 + $15
  assert.equal(rentFor(2, p).rent, 12000);  // 2 × $60
  assert.equal(rentFor(7, p).rent, 42000);
  assert.equal(rentFor(10, p).rent, 60000);
  const p2 = { dailyRate: 5000, oneDayExtra: 1000, weeklyRate: 0 };
  assert.equal(rentFor(1, p2).rent, 6000);  // whatever the daily rate is, one day is the extra on top
  assert.equal(rentFor(3, p2).rent, 15000);
});

test('rent: optional weekly price', () => {
  const p = { dailyRate: 6000, oneDayExtra: 1500, weeklyRate: 30000 };
  assert.equal(rentFor(6, p).rent, 36000);  // under a week: daily
  assert.equal(rentFor(7, p).rent, 30000);
  assert.equal(rentFor(8, p).rent, 36000);  // week + $60
  assert.equal(rentFor(13, p).rent, 60000); // extra days capped at another week
});

test('day counting (both ends count)', () => {
  assert.equal(hireDays('2026-12-01', '2026-12-01'), 1);
  assert.equal(hireDays('2026-12-01', '2026-12-03'), 3);
});

test('quote validation and bond method', () => {
  const now = new Date('2026-12-01T00:00:00+10:00');
  assert.ok(quote('2026-11-30', '2026-12-02', 1, now).error);          // past
  assert.ok(quote('2026-12-05', '2026-12-02', 1, now).error);          // reversed
  assert.ok(quote('2026-12-01', 'nope', 1, now).error);
  assert.ok(quote('2026-12-01', '2026-12-02', 0, now).error);          // no scooters
  assert.equal(quote('2026-12-01', '2026-12-07', 1, now).bondMethod, 'hold');   // returns 6 days out
  assert.equal(quote('2026-12-01', '2026-12-08', 1, now).bondMethod, 'charge');
  assert.equal(quote('2026-12-20', '2026-12-21', 1, now).bondMethod, 'charge'); // booked far ahead
});

test('several scooters multiply rent and bond', () => {
  const now = new Date('2026-12-01T00:00:00+10:00');
  const q = quote('2026-12-01', '2026-12-03', 3, now);
  assert.equal(q.rentEach, 18000);          // 3 × $60 (default prices)
  assert.equal(q.rent, 54000);
  assert.equal(q.bond, 75000);
});

test('phone numbers: any normal format and any digit style', async () => {
  const { phoneDigitCount } = await import('../src/routes/bookings.js');
  const ok = (p) => { const n = phoneDigitCount(p); return n >= 8 && n <= 15; };
  for (const p of ['0478 393 479', '0478393479', '+61 478 393 479', '+61 (0)478-393-479', '(07) 4946 1234',
    '+44 7911 123456', '０４７８３９３４７９', '٠٤٧٨٣٩٣٤٧٩', '‪0478 393 479‬']) assert.ok(ok(p), p);
  for (const p of ['123', '0478', 'phone me', '1234567890123456']) assert.ok(!ok(p), p);
});
