// Demo mode: runs the real Supabase migrations inside the browser using
// PGlite (PostgreSQL compiled to WebAssembly), stored in IndexedDB.
// Calls go through exactly the same database functions, under the
// `authenticated` role with a JWT claim — so the rules behave as in production.
import { PGlite } from '@electric-sql/pglite';
import type { Backend, DemoUser } from './backend';

import shim from '../../supabase/local-shim.sql?raw';
import seed from '../../supabase/seed.sql?raw';
import demoUsers from '../../supabase/demo-users.sql?raw';

const migrations = import.meta.glob('../../supabase/migrations/*.sql', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

// The demo database is rebuilt automatically whenever the SQL changes.
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const DB_NAME = 'torte-living-demo-v2-' + hash(shim + Object.keys(migrations).sort().map((k) => migrations[k]).join('') + demoUsers + seed);
const DATA_DIR = 'idb://' + DB_NAME;
const USER_KEY = 'tl-demo-user';

const USERS: DemoUser[] = [
  { id: '00000000-0000-4000-a000-000000000001', label: 'Founder (admin)', role: 'admin' },
  { id: '00000000-0000-4000-a000-000000000003', label: 'Sunita (warehouse)', role: 'warehouse' },
  { id: '00000000-0000-4000-a000-000000000002', label: 'Ravi (packer)', role: 'packer' },
];

function storedUser(): string | null {
  try { return localStorage.getItem(USER_KEY); } catch { return null; }
}
function storeUser(id: string | null) {
  try { id ? localStorage.setItem(USER_KEY, id) : localStorage.removeItem(USER_KEY); } catch { /* private mode */ }
}

// One transaction: if the page is closed or reloaded mid-install, nothing is
// kept and the next visit installs cleanly (no half-built database).
async function install(db: PGlite) {
  await db.transaction(async (tx) => {
    await tx.exec(shim);
    for (const path of Object.keys(migrations).sort()) await tx.exec(migrations[path]);
    await tx.exec(demoUsers);
    await tx.exec(seed);
    await tx.exec('create table public.demo_installed (at timestamptz default now()); insert into public.demo_installed default values;');
  });
}

async function open(): Promise<PGlite> {
  let db: PGlite;
  try {
    db = await PGlite.create(DATA_DIR);
  } catch {
    db = await PGlite.create(); // storage blocked: in-memory
  }
  const r = await db.query<{ ok: string | null }>(`select to_regclass('public.demo_installed')::text as ok`);
  if (!r.rows[0].ok) await install(db);
  return db;
}

export async function createDemoBackend(): Promise<Backend> {
  let dbPromise = open();
  let userId = storedUser();

  return {
    mode: 'demo',
    demoUsers: USERS,
    async rpc(fn, args = {}) {
      const db = await dbPromise;
      const keys = Object.keys(args).filter((k) => args[k] !== undefined);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
      const params = keys.map((k) => {
        const v = args[k];
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      const claims = JSON.stringify(userId ? { sub: userId, role: 'authenticated' } : { role: 'anon' });
      return db.transaction(async (tx) => {
        await tx.exec(`set local role ${userId ? 'authenticated' : 'anon'}`);
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
        const res = await tx.query<{ r: any }>(sql, params);
        return res.rows[0]?.r;
      });
    },
    async currentUser() {
      if (!userId) return null;
      const u = USERS.find((x) => x.id === userId);
      return u ? { id: u.id, email: u.label } : null;
    },
    async signIn() {
      throw new Error('Demo mode: choose a demo user');
    },
    async signUp() {
      return 'Demo mode has fixed demo users.';
    },
    async signInDemo(id: string) {
      userId = id;
      storeUser(id);
    },
    async signOut() {
      userId = null;
      storeUser(null);
    },
    async resetDemo() {
      const db = await dbPromise;
      await db.close();
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('/pglite/' + DB_NAME);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
      dbPromise = open();
      await dbPromise;
    },
  };
}
