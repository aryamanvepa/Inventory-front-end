// Upgrade path: a database that already has operational data (as the live
// pilot did) receives the finance migrations afterwards. The backfill must
// post opening stock and past payments, and the books must balance.
//   npm run test:upgrade
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
const FINANCE_FROM = '20261112000200';
const db = new PGlite();
const run = async (f) => {
  try { await db.exec(readFileSync(f, 'utf8')); }
  catch (e) { throw new Error(`${f.split('/').pop()}: ${e.message}`); }
};
console.log('\nUpgrade path: existing data, then the finance migrations\n');
await run(join(root, 'local-shim.sql'));
const files = readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
for (const f of files.filter((f) => f < FINANCE_FROM)) await run(join(root, 'migrations', f));
await run(join(root, 'demo-users.sql'));
await db.exec(`update legal_entities set state_code = null, gstin = null`);   // as live: GST details not set yet
await run(join(root, 'seed.sql'));
for (const f of files.filter((f) => f >= FINANCE_FROM)) await run(join(root, 'migrations', f));   // each file on its own, like supabase db push

const one = async (s) => (await db.query(s)).rows[0];
const bal = async (code) => Number((await one(`select coalesce(sum(jl.debit) - sum(jl.credit), 0) b from journal_lines jl join accounts a on a.id = jl.account_id where a.code = '${code}'`)).b);
const tb = await one(`select sum(debit) dr, sum(credit) cr from journal_lines`);
assert.equal(Number(tb.dr), Number(tb.cr), 'books balance');
assert.equal(await bal('1310'), 11000, 'opening finished-goods stock at batch cost');
assert.equal(await bal('3100'), -11000, 'against opening balances');
const paid = Number((await one(`select sum(amount) s from payments where kind = 'payment'`)).s);
assert.equal(await bal('1130'), paid, 'past online payments posted to gateway clearing');
assert.equal(await bal('1200'), -paid, 'shown as customer advances until invoiced');
assert.equal((await one(`select count(*)::int n from accounting_exceptions`)).n, 0);
console.log('  ✓ Backfill posts opening stock and past payments; books balance\n\n1 passed, 0 failed\n');
