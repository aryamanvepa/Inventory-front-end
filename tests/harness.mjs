// Test harness: boots a real PostgreSQL (PGlite, in-process) with the
// Supabase migrations, and calls functions exactly as the PostgREST API
// would — as the `authenticated` role with a JWT claim for the user.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
export const USERS = {
  admin: '00000000-0000-4000-a000-000000000001',
  packer: '00000000-0000-4000-a000-000000000002',
  warehouse: '00000000-0000-4000-a000-000000000003',
};

export async function bootDb({ seed = true } = {}) {
  const db = new PGlite();
  await db.exec(readFileSync(join(root, 'local-shim.sql'), 'utf8'));
  const files = readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    try {
      await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
    } catch (e) {
      throw new Error(`Migration ${f} failed: ${e.message}`);
    }
  }
  await db.exec(readFileSync(join(root, 'demo-users.sql'), 'utf8'));
  if (seed) await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  return db;
}

// Call a database function with named arguments, as a given user.
// user: 'admin' | 'packer' | 'warehouse' | 'service' | 'anon'
export async function rpc(db, user, fn, args = {}) {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  const params = keys.map((k) => {
    const v = args[k];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  const claims =
    user === 'service' ? { role: 'service_role' }
    : user === 'anon' ? { role: 'anon' }
    : { sub: USERS[user], role: 'authenticated' };
  const pgRole = user === 'service' ? 'service_role' : user === 'anon' ? 'anon' : 'authenticated';
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${pgRole}`);
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    const res = await tx.query(sql, params);
    return res.rows[0].r;
  });
}

// Run raw SQL as a given API role (to prove direct table access is blocked)
export async function sqlAs(db, user, sql, params = []) {
  const claims = { sub: USERS[user], role: 'authenticated' };
  return db.transaction(async (tx) => {
    await tx.exec(`set local role authenticated`);
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    return (await tx.query(sql, params)).rows;
  });
}
