// Database access.
// Default: embedded Postgres (PGlite) stored in a folder — DATA_DIR/db.
//   Locally DATA_DIR defaults to server/.localdb; on Render it's the
//   persistent disk (e.g. /var/data). No database server to pay for.
// Upgrade path: set DATABASE_URL to a managed Postgres and the same SQL runs there.
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATE_OID = 1082;
const keepDateAsString = (v) => v; // 'YYYY-MM-DD', no timezone surprises

let impl;

/** Where the database and uploaded videos live (the Render disk in production). */
export function dataDir() {
  return process.env.DATA_DIR || path.join(here, '..', '.localdb');
}

/** Flush and close cleanly (Render sends SIGTERM before each deploy/restart). */
export async function closeDb() {
  if (impl?.close) await impl.close();
}

async function init() {
  if (impl) return impl;
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(DATE_OID, keepDateAsString);
    pg.types.setTypeParser(20, (v) => Number(v)); // count(*) / bigint → number
    // Render's *internal* database address is a bare name like "dpg-abc123-a" (private
    // network, no SSL); external addresses have a full domain and need SSL.
    const host = new URL(process.env.DATABASE_URL).hostname;
    const useSsl = host.includes('.') && !/^(localhost|127\.0\.0\.1)$/.test(host);
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: 5,
    });
    impl = {
      kind: 'postgres',
      close: () => pool.end(),
      query: async (text, params) => (await pool.query(text, params)).rows,
      exec: async (text) => { await pool.query(text); },
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn({ query: async (t, p) => (await client.query(t, p)).rows });
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.LOCAL_DB_DIR || path.join(dataDir(), 'db');
    if (dir !== ':memory:') await mkdir(path.dirname(dir), { recursive: true });
    // Postgres' default 128MB cache is far more than this small database needs and
    // pushes the server past Render Starter's 512MB, so keep its memory small.
    const lowMemory = ['-c', 'shared_buffers=16MB', '-c', 'temp_buffers=2MB', '-c', 'wal_buffers=1MB', '-c', 'work_mem=2MB', '-c', 'maintenance_work_mem=8MB'];
    const db = new PGlite(dir === ':memory:' ? undefined : dir, {
      startParams: [...(PGlite.defaultStartParams || []), ...lowMemory],
    });
    // Passed on every query: this PGlite version ignores parsers given to the constructor.
    const opts = { parsers: { [DATE_OID]: keepDateAsString, 20: (v) => Number(v) } };
    impl = {
      kind: 'pglite',
      close: () => db.close(),
      query: async (text, params) => (await db.query(text, params, opts)).rows,
      exec: async (text) => { await db.exec(text); },
      tx: (fn) => db.transaction((t) => fn({ query: async (q, p) => (await t.query(q, p, opts)).rows })),
    };
  }
  return impl;
}

export async function query(text, params = []) {
  return (await init()).query(text, params);
}

export async function tx(fn) {
  return (await init()).tx(fn);
}

/** Applies any new files in db/migrations (in name order) exactly once. */
export async function migrate() {
  const db = await init();
  await db.exec(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query('select name from schema_migrations')).map((r) => r.name));
  const dir = path.join(here, '..', 'db', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    await db.exec(sql);
    await db.query('insert into schema_migrations (name) values ($1)', [f]);
    console.log(`[db] applied ${f}`);
  }
  return db.kind;
}
