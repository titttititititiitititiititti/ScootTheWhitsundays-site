// Writes sample versions of every booking email to server/.localdb/outbox
// so you can open them in a browser and check how they look.
//   npm.cmd run preview-emails
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { customerConfirmation, ownerNotification, bondNeeded } from './notify.js';
import { outboxDir } from './email.js';

const b = {
  id: '3f2a9c1e-0000-4000-8000-000000000000', access_token: 'sample-token-sample-token',
  customer_name: 'Sam Example', customer_email: 'sam@example.com', customer_phone: '0412 345 678',
  customer_dob: '1996-03-14', customer_address: '12 Shute Harbour Rd, Airlie Beach',
  licence_type: 'Full car licence', licence_number: '123456789', licence_country: 'Australia', licence_expiry: '2029-05-01',
  licence_12_months: true, at_fault_accidents: false, driving_restrictions: false,
  start_date: '2026-12-01', end_date: '2026-12-03', days: 3, rent_amount: 36000, bond_amount: 50000,
  bond_method: 'hold', bond_status: 'held', signature_name: 'Sam Example', signature_date: '2026-11-25',
};
const bikes = [
  { number: 2, name: 'Red Devil 50cc', lockbox_number: '2', lockbox_code: '4821' },
  { number: 4, name: 'Kymco Super 8 50cc', lockbox_number: null, lockbox_code: null },
];

const dir = path.join(outboxDir(), 'preview');
await mkdir(dir, { recursive: true });
for (const [file, m] of [
  ['customer-confirmation.html', customerConfirmation(b, bikes)],
  ['owner-notification.html', ownerNotification(b, bikes, 2)],
  ['bond-needed.html', bondNeeded(b)],
]) {
  await writeFile(path.join(dir, file), `<!-- Subject: ${m.subject} -->\n` + m.html);
  console.log(`${m.subject}\n  → ${path.join(dir, file)}`);
}
