// Sets up the fleet as Bikes 1–7. Safe to run again: it updates the names,
// photos and licence flag of these bike numbers (edit them in the admin page after).
//   npm.cmd run seed
import { migrate, query, closeDb } from './db.js';

const SUPER8 = 'Static/Kymco Super 8 50cc/ChatGPT Image May 19, 2026, 11_34_54 AM.png';
const AGILITY = 'Static/Kymco Agility 50cc/ChatGPT Image May 19, 2026, 11_28_19 AM.png';
const fleet = [
  { number: 1, name: 'Kymco Like 50cc', photo: 'Static/Kymco like 50cc/Red scooter at sunset by the beach.png' },
  { number: 2, name: 'Kymco Super 8 50cc (black)', photo: SUPER8 },
  { number: 3, name: 'Kymco Super 8 50cc (red)', photo: SUPER8 },
  { number: 4, name: 'Kymco Agility 50cc', photo: AGILITY },
  { number: 5, name: 'Kymco Agility 50cc', photo: AGILITY },
  { number: 6, name: 'Kymco Agility 50cc', photo: AGILITY },
  { number: 7, name: 'Suzuki Address 100cc', photo: null, needsMotorcycleLicence: true },
];

await migrate();
// --if-empty: used on every server start, so it only fills a brand-new database
// and never overwrites changes made in the admin page.
if (process.argv.includes('--if-empty')) {
  const [{ n }] = await query('select count(*)::int as n from bikes');
  if (n > 0) { await closeDb(); process.exit(0); }
}
for (const b of fleet) {
  const [row] = await query(
    `insert into bikes (number, name, photo, needs_motorcycle_licence) values ($1, $2, $3, $4)
     on conflict (number) do update set name = excluded.name, photo = excluded.photo,
       needs_motorcycle_licence = excluded.needs_motorcycle_licence, updated_at = now()
     returning (xmax = 0) as inserted`,
    [b.number, b.name, b.photo, Boolean(b.needsMotorcycleLicence)],
  );
  console.log(`${row.inserted ? 'added  ' : 'updated'} Bike ${b.number} — ${b.name}`);
}
await closeDb();
process.exit(0);
