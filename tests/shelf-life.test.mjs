// Shelf life is optional for ops: no shelf life → default (app_settings.default_shelf_life_days)
// (owner, 2026-11-23).
//   npm run test:shelf
import assert from 'node:assert/strict';
import { bootDb, rpc } from './harness.mjs';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
const rejects = (p, re) => assert.rejects(p, re);
const db = await bootDb();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const inDays = async (d) => (await one(`select (today_ist() + $1::int)::text d`, [d])).d;
let items = 0;
async function product(shelf_life_days = null) {
  items += 1;
  const c = await rpc(db, 'admin', 'create_product_sku', { p: {
    brand_id: (await one(`select id from brands where code = 'MT'`)).id, product_name: `Shelf Test ${items}`,
    sku_name: `Shelf Test ${items} 100 g`, pack_size: 100, pack_unit: 'g', mrp: 100, website_price: 100, shelf_life_days } });
  return c.sku_id;
}

console.log('\nOptional shelf life\n');
await rpc(db, 'admin', 'set_app_setting', { p_key: 'testing_mode', p_value: false });   // as on the live site

await test('No shelf life: "From kitchen" is offered and the stock gets the default 90-day expiry', async () => {
  const sku = await product();
  assert.equal((await rpc(db, 'warehouse', 'inv_item', { p_sku_id: sku })).kitchen.can_make, true);
  const r = await rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: sku, qty: 4, source: 'kitchen', idempotency_key: 'sl-1' } });
  assert.equal(r.ok, true);
  assert.equal(r.batch.expires_on, await inDays(90));
  assert.equal(Number(r.item.on_shelf), 4);
});

await test('New batch with no expiry typed: the default for no shelf life, the product\'s own shelf life when set', async () => {
  const none = await rpc(db, 'warehouse', 'create_batch', { p: { sku_id: await product() } });
  assert.equal(none.expires_on, await inDays(90));
  const own = await rpc(db, 'warehouse', 'create_batch', { p: { sku_id: await product(20) } });
  assert.equal(own.expires_on, await inDays(20));
  const typed = await rpc(db, 'warehouse', 'create_batch', { p: { sku_id: await product(), expires_on: '2027-03-01' } });
  assert.equal(typed.expires_on, '2027-03-01');
});

await test('Admin can change the default; new stock uses it', async () => {
  const s = await rpc(db, 'admin', 'set_app_setting', { p_key: 'default_shelf_life_days', p_value: 45.0 });
  assert.equal(s.default_shelf_life_days, 45);
  assert.equal((await one(`select jsonb_typeof(value) t, value #>> '{}' v from app_settings where key = 'default_shelf_life_days'`)).v, '45');
  const b = await rpc(db, 'warehouse', 'create_batch', { p: { sku_id: await product() } });
  assert.equal(b.expires_on, await inDays(45));
});

await test('Bad defaults are refused, and only an admin can change it', async () => {
  for (const v of [0, 3651, 1.5, '"30"', true]) {
    await rejects(rpc(db, 'admin', 'set_app_setting', { p_key: 'default_shelf_life_days', p_value: v }), /whole number of days/);
  }
  await rejects(rpc(db, 'warehouse', 'set_app_setting', { p_key: 'default_shelf_life_days', p_value: 10 }), /not allowed/);
  await rejects(rpc(db, 'anon', 'default_shelf_life_days'), /permission denied/);
});

await test('A broken stored value falls back to 90 instead of breaking stock-in', async () => {
  await db.query(`update app_settings set value = '"oops"'::jsonb where key = 'default_shelf_life_days'`);
  const b = await rpc(db, 'warehouse', 'create_batch', { p: { sku_id: await product() } });
  assert.equal(b.expires_on, await inDays(90));
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed\n`);
process.exit(failed ? 1 : 0);
