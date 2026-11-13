// B15 · storefront_catalogue status: available / out_of_stock / coming_soon / discontinued
//   npm run test:status
import assert from 'node:assert/strict';
import { bootDb, rpc } from './harness.mjs';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
const db = await bootDb();
const row = async (code) => (await rpc(db, 'anon', 'storefront_catalogue')).find((x) => x.code === code);
const quote = (code) => rpc(db, 'service', 'storefront_quote', { p_lines: [{ sku_code: code, qty: 1 }] });
console.log('\nTorte Living OS — catalogue status (B15)\n');

let NEW, NEW_ID, OLD, OLD_ID;
await test('Every row has a status; stocked seed products are available', async () => {
  const cat = await rpc(db, 'anon', 'storefront_catalogue');
  assert.ok(cat.length > 0 && cat.every((x) => ['available', 'out_of_stock', 'coming_soon', 'discontinued'].includes(x.status)));
  const c = cat.find((x) => x.code === 'MT-000001');
  assert.equal(c.status, 'available'); assert.notEqual(c.availability, 'sold_out');
});

await test('A new product that was never stocked or sold is coming_soon, and quote refuses it', async () => {
  const mt = (await rpc(db, 'admin', 'get_reference_data')).brands.find((b) => b.code === 'MT');
  for (const [k, name] of [['NEW', 'Status Brownie'], ['OLD', 'Status Blondie']]) {
    const p = await rpc(db, 'admin', 'create_product_sku', { p: { brand_id: mt.id, product_name: name, sku_name: `${name} 6 pc`,
      pack_size: 6, pack_unit: 'pcs', mrp: 300, website_price: 300, shelf_life_days: 30 } });
    if (k === 'NEW') { NEW = p.sku_code; NEW_ID = p.sku_id; } else { OLD = p.sku_code; OLD_ID = p.sku_id; }
  }
  const r = await row(NEW);
  assert.equal(r.status, 'coming_soon'); assert.equal(r.availability, 'sold_out'); assert.equal(r.max_qty, 0);
  assert.equal((await quote(NEW)).problems[0].reason, 'sold_out');
});

await test('Test-override stock makes it available, and once gone it is coming_soon again (test stock never counts)', async () => {
  await rpc(db, 'warehouse', 'test_stock_in', { p: { sku_id: NEW_ID, qty: 2 } });
  assert.equal((await row(NEW)).status, 'available');
  await rpc(db, 'warehouse', 'inv_stock_out', { p: { sku_id: NEW_ID, qty: 2, reason: 'damaged' } });
  assert.equal((await row(NEW)).status, 'coming_soon');
});

await test('Really stocked, then at 0: out_of_stock', async () => {
  await rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: OLD_ID, qty: 3, source: 'kitchen' } });
  assert.equal((await row(OLD)).status, 'available');
  await rpc(db, 'warehouse', 'inv_stock_out', { p: { sku_id: OLD_ID, qty: 3, reason: 'damaged' } });
  const r = await row(OLD);
  assert.equal(r.status, 'out_of_stock'); assert.equal(r.max_qty, 0);
});

await test('Switched off: still listed as discontinued (no qty, no bestseller), and quote refuses it as unavailable', async () => {
  await rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: OLD_ID, qty: 3, source: 'kitchen' } });
  await rpc(db, 'admin', 'update_sku', { p_sku_id: OLD_ID, p: { active: false } });
  const r = await row(OLD);
  assert.equal(r.status, 'discontinued'); assert.equal(r.availability, 'sold_out');
  assert.equal(r.max_qty, 0); assert.equal(r.only_left, null); assert.equal(r.bestseller_rank, null);
  assert.equal((await quote(OLD)).problems[0].reason, 'unavailable');
});

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
