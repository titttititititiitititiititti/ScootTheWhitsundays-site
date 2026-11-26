// Local development: runs the server and restarts it when code in src/ (or a
// migration in db/) changes. Node's own --watch also reacts to the database
// files in .localdb, which restarted the server in the middle of bookings.
import { spawn } from 'node:child_process';
import { watch, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeArgs = ['--env-file-if-exists=.env', 'src/index.js'];
let child = null;
let timer = null;
const seen = new Map(); // file → "mtime:size" when we last saw it
for (const dir of ['src', 'db']) {
  for (const f of readdirSync(path.join(root, dir), { recursive: true })) {
    const full = path.join(root, dir, f);
    try { const st = statSync(full); if (st.isFile()) seen.set(full, `${st.mtimeMs}:${st.size}`); } catch { /* ignore */ }
  }
}

function start() {
  child = spawn(process.execPath, nodeArgs, { cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) console.log(`[dev] server stopped (exit ${code}) — save a file to restart`);
  });
}

function restart(file) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`[dev] ${file} changed — restarting`);
    if (child && child.exitCode === null) {
      child.once('exit', start);
      stop(child);
    } else {
      start();
    }
  }, 200);
}

for (const dir of ['src', 'db']) {
  watch(path.join(root, dir), { recursive: true }, (_event, file) => {
    if (!file || !/\.(js|sql|json)$/.test(file)) return;
    // Windows also reports files that were only read or scanned; restart only on a real edit.
    const full = path.join(root, dir, file);
    let stamp = '';
    try { const st = statSync(full); stamp = `${st.mtimeMs}:${st.size}`; } catch { stamp = 'deleted'; }
    if (seen.get(full) === stamp) return;
    seen.set(full, stamp);
    restart(path.join(dir, file));
  });
}
// Ask the server to close the database cleanly (on Windows a kill is a hard stop); force it after 5 s.
function stop(c) {
  try { c.send('shutdown'); } catch { c.kill(); }
  setTimeout(() => { if (c.exitCode === null) c.kill(); }, 5000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (!child || child.exitCode !== null) process.exit(0);
    child.once('exit', () => process.exit(0));
    stop(child);
  });
}
start();
