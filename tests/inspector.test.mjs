// Live database view: admin-only table overview and change feed
//   npm run test:inspector
import assert from 'node:assert/strict';
import { bootDb, rpc } from './harness.mjs';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
async function rejects(promise, pattern) {
  try { await promise; } catch (e) { if (pattern && !pattern.test(e.message)) throw new Error(`Expected ${pattern}, got: ${e.message}`); return; }
  throw new Error(`Expected an error matching ${pattern}`);
}
const db = await bootDb();
console.log('\nTorte Living OS — live database view\n');

await test('Every table is listed with its row count and area', async () => {
  const r = await rpc(db, 'admin', 'inspect_tables');
  assert.ok(r.tables.length >= 50, `${r.tables.length} tables`);
  const orders = r.tables.find((x) => x.table === 'orders');
  assert.equal(orders.area, 'Orders & customers');
  assert.equal(orders.rows, 10);
  assert.ok(r.auth_users >= 3);
});

await test('Clicks show up in the feed: stock in, accounting entry, packing scan, payment', async () => {
  const since = (await db.query('select now() - interval \'1 second\' t')).rows[0].t;
  const items = await rpc(db, 'warehouse', 'inv_items');
  const atta = items.find((i) => i.code === 'NS-000001');
  await rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: atta.id, qty: 5, source: 'kitchen' } });
  const o = (await rpc(db, 'admin', 'list_orders', { p_filter: 'to_pack' }))[0];
  const ord = await rpc(db, 'admin', 'get_order', { p_order_id: o.id });
  const batch = (await rpc(db, 'packer', 'inv_item', { p_sku_id: ord.lines[0].sku_id })).batches.find((b) => !b.expired);
  await rpc(db, 'packer', 'pack_scan', { p_order_id: o.id, p_code: batch.code });
  const unpaid = (await rpc(db, 'admin', 'list_orders', { p_filter: 'awaiting_payment' }))[0];
  await rpc(db, 'admin', 'record_payment', { p_order_id: unpaid.id, p_amount: 10, p_method: 'manual', p_reference: 'T', p_idempotency_key: 'insp-pay' });
  const feed = await rpc(db, 'admin', 'inspect_activity', { p_since: since });
  const kinds = new Set(feed.map((f) => f.kind));
  for (const k of ['stock', 'ledger', 'scan', 'payment', 'record']) assert.ok(kinds.has(k), `feed has ${k}: ${[...kinds]}`);
  const stock = feed.find((f) => f.kind === 'stock');
  assert.ok(stock.detail.lines.some((l) => l.sku === 'NS-000001' && Number(l.qty) === 5));
  assert.equal(stock.who, 'Sunita (warehouse)');
  const jv = feed.find((f) => f.kind === 'ledger');
  const dr = jv.detail.lines.reduce((a, l) => a + Number(l.debit ?? 0), 0), cr = jv.detail.lines.reduce((a, l) => a + Number(l.credit ?? 0), 0);
  assert.equal(Math.round(dr * 100), Math.round(cr * 100), 'each entry balances');
  const upd = feed.filter((f) => f.kind === 'record' && f.action === 'UPDATE' && f.table === 'orders');
  assert.ok(upd.some((f) => Object.keys(f.detail).length > 0), 'order updates show what changed');
  for (let i = 1; i < feed.length; i++) assert.ok(feed[i - 1].at >= feed[i].at, 'newest first');
});

await test('Only admins can use it; the public key cannot', async () => {
  await rejects(rpc(db, 'warehouse', 'inspect_tables'), /not allowed/);
  await rejects(rpc(db, 'warehouse', 'inspect_activity', {}), /not allowed/);
  await rejects(rpc(db, 'anon', 'inspect_tables'), /permission denied/);
});

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
