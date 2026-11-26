// LOCAL TESTING ONLY: adds a few confirmed fake bookings so the calendar
// shows different numbers of free scooters on different days.
// Run: npm.cmd run demo   (refuses to run against a real DATABASE_URL)
import { migrate, query, closeDb } from './db.js';
import { todayLocal } from './pricing.js';

if (process.env.DATABASE_URL || process.env.DATA_DIR) {
  console.error('Refusing to add demo bookings outside the local test database.');
  process.exit(1);
}
await migrate();
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const t = todayLocal();
const demo = [
  { bikes: [1], start: addDays(t, 5), end: addDays(t, 10) },       // 4 free for a week
  { bikes: [2, 3], start: addDays(t, 8), end: addDays(t, 9) },     // 2 free on two days
  { bikes: [4], start: addDays(t, 14), end: addDays(t, 14) },      // 4 free for a day
];
for (const d of demo) {
  const [b] = await query(
    `insert into bookings (access_token, scooter_count, customer_name, customer_email, customer_phone,
       licence_number, licence_type, start_date, end_date, days, rent_amount, bond_amount, bond_method,
       status, agreement, signature_name, signature_date, agreement_signed_at)
     values (md5(random()::text), $1, 'Demo Customer', 'demo@example.com', '0400000000', 'DEMO', 'Full car licence',
       $2, $3, 1, 0, 0, 'charge', 'confirmed', '{"demo":true}'::jsonb, 'Demo Customer', current_date, now())
     returning id`,
    [d.bikes.length, d.start, d.end],
  );
  await query(`insert into booking_bikes (booking_id, bike_id) select $1, id from bikes where number = any($2::int[])`, [b.id, d.bikes]);
  console.log(`demo booking: Bike ${d.bikes.join(', ')} ${d.start} → ${d.end}`);
}
await closeDb();
process.exit(0);
