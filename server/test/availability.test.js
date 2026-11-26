import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LOCAL_DB_DIR = ':memory:';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
const { migrate, query } = await import('../src/db.js');
const { availableBikes, freePerDay, fleetToday } = await import('../src/availability.js');

await migrate();
await query(`insert into bikes (number, name) values (1,'A'),(2,'B'),(3,'C')`);
await query(`update bikes set status='in_repair' where number=3`);

async function book(bikeNumbers, start, end, status, expiresSql = 'null') {
  const [b] = await query(
    `insert into bookings (access_token, scooter_count, customer_name, customer_email, customer_phone,
       licence_number, licence_type, start_date, end_date, days, rent_amount, bond_amount, bond_method,
       status, pending_expires_at, agreement, signature_name, signature_date, agreement_signed_at)
     values (md5(random()::text), $1, 'x','x@x','1','L','Full', $2, $3, 1, 1, 1, 'hold',
       $4, ${expiresSql}, '{}'::jsonb, 'x', current_date, now())
     returning id`,
    [bikeNumbers.length, start, end, status],
  );
  await query(
    `insert into booking_bikes (booking_id, bike_id) select $1, id from bikes where number = any($2::int[])`,
    [b.id, bikeNumbers],
  );
}

const nums = async (s, e) => (await availableBikes(s, e)).map((b) => b.number);

test('in-repair bikes are hidden', async () => {
  assert.deepEqual(await nums('2026-12-01', '2026-12-02'), [1, 2]);
});

test('confirmed bookings block overlapping dates (inclusive)', async () => {
  await book([1], '2026-12-10', '2026-12-12', 'confirmed');
  assert.deepEqual(await nums('2026-12-12', '2026-12-14'), [2]); // overlaps on return day
  assert.deepEqual(await nums('2026-12-13', '2026-12-14'), [1, 2]);
  assert.deepEqual(await nums('2026-12-01', '2026-12-20'), [2]);
});

test('a multi-bike booking blocks every bike in it', async () => {
  await book([1, 2], '2027-02-01', '2027-02-02', 'confirmed');
  assert.deepEqual(await nums('2027-02-02', '2027-02-03'), []);
});

test('cancelled and expired-unpaid bookings do not block; live unpaid ones do', async () => {
  await book([2], '2027-01-05', '2027-01-06', 'cancelled');
  await book([2], '2027-01-05', '2027-01-06', 'pending_payment', `now() - interval '1 minute'`);
  assert.deepEqual(await nums('2027-01-05', '2027-01-06'), [1, 2]);
  await book([2], '2027-01-05', '2027-01-06', 'pending_payment', `now() + interval '20 minutes'`);
  assert.deepEqual(await nums('2027-01-05', '2027-01-06'), [1]);
});

test('free count per day, and why the whole period is checked separately', async () => {
  // Bike 1 busy on the 1st, bike 2 busy on the 2nd: 1 free each day, but 0 free for both days.
  await book([1], '2027-03-01', '2027-03-01', 'confirmed');
  await book([2], '2027-03-02', '2027-03-02', 'confirmed');
  const days = await freePerDay('2027-02-28', '2027-03-03');
  assert.deepEqual(days, [
    { date: '2027-02-28', free: 2 },
    { date: '2027-03-01', free: 1 },
    { date: '2027-03-02', free: 1 },
    { date: '2027-03-03', free: 2 },
  ]);
  assert.deepEqual(await nums('2027-03-01', '2027-03-02'), []);
});

test('fleet today: names and free/busy only (booking, long-term, repair all count as busy)', async () => {
  // 2027-03-01: bike 1 booked (above), bike 2 free, bike 3 in repair.
  assert.deepEqual(await fleetToday('2027-03-01'), [
    { name: 'A', free: false },
    { name: 'B', free: true },
    { name: 'C', free: false },
  ]);
  await query(`insert into long_term_rentals (bike_id, renter_name, weekly_rate, start_date)
               select id, 'R', 15000, '2027-02-20' from bikes where number = 2`);
  assert.equal((await fleetToday('2027-03-01'))[1].free, false);
  assert.equal((await fleetToday('2027-02-19'))[1].free, true);
  assert.deepEqual(Object.keys((await fleetToday('2027-03-01'))[0]).sort(), ['free', 'name']);
});