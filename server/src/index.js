import { createApp } from './app.js';
import { migrate, closeDb, dataDir } from './db.js';
import { loadSettings } from './settings.js';
import { startRentReminderSweep } from './longTerm.js';
import { setOnConfirmed } from './payments.js';
import { onBookingConfirmed, startEmailRetrySweep } from './notify.js';

const port = Number(process.env.PORT) || 3000;
const kind = await migrate();
await loadSettings();
setOnConfirmed(onBookingConfirmed);
startEmailRetrySweep();
startRentReminderSweep();
if (!process.env.RESEND_API_KEY) console.log('[email] RESEND_API_KEY not set: emails are saved to the outbox folder instead of sent');
const server = createApp().listen(port, () => {
  console.log(`[server] database: ${kind === 'pglite' ? `embedded, stored in ${dataDir()}` : 'Postgres (DATABASE_URL)'}`);
  console.log(`[server] http://localhost:${port}`);
});

// Phone videos on mobile data can take a while to upload (Node's default cut-off is 5 minutes).
server.requestTimeout = 30 * 60 * 1000;

// Close the database cleanly so nothing is lost on deploys/restarts.
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  closeDb().finally(() => process.exit(0));
}
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, shutdown);
process.on('message', (m) => { if (m === 'shutdown') shutdown(); }); // from scripts/dev.js
