// Test override: add stock for any item while testing mode is on,
// skipping recipe, materials, shelf life and purchase order.
//   npm run test:overrides
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
const n2 = (v) => Math.round(Number(v) * 100) / 100;
const db = await bootDb();
const booksBalance = async () => {
  const tb = await rpc(db, 'admin', 'trial_balance');
  assert.equal(n2(tb.total_debit), n2(tb.total_credit), 'trial balance');
  const iv = await rpc(db, 'admin', 'inventory_valuation');
  for (const r of iv.by_type) assert.equal(n2(r.difference), 0, `inventory ${r.account}: stock ${r.stock_value} vs ledger ${r.ledger_value}`);
};
const addDays = (n) => { const d = new Date(Date.now() + 5.5 * 3600e3); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

console.log('\nTorte Living OS — test overrides\n');

let PROD, PROD_CODE, MAT, orderId;
await test('Setup: a product with no recipe and no shelf life, and a website order waiting for it', async () => {
  const ms = (await rpc(db, 'admin', 'get_reference_data')).brands.find((b) => b.code === 'MT');
  const p = await rpc(db, 'admin', 'create_product_sku', { p: {
    brand_id: ms.id, product_name: 'Test Brownie', sku_name: 'Test Brownie 6 pc', pack_size: 6, pack_unit: 'pcs', mrp: 400, website_price: 400 } });
  PROD = p.sku_id; PROD_CODE = p.sku_code;
  MAT = (await rpc(db, 'admin', 'create_material', { p: { name: 'Test cocoa', item_type: 'raw_material', unit: 'kg' } })).sku_id;
  const r = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'ov-1', p_payload: {
    external_order_id: 'OV1', channel: 'WEB',
    customer: { external_id: 'ov', name: 'Override Buyer', phone: '9000000301', email: 'ov@example.com' },
    ship_to: { name: 'Override Buyer', address1: '1 Test Road', city: 'Hyderabad', pincode: '500001' },
    lines: [{ sku_code: PROD_CODE, qty: 2 }], payment: { status: 'paid', method: 'upi', gateway: 'razorpay', gateway_ref: 'pay_ov1' } } });
  assert.equal(r.ok, true, r.error);
  orderId = r.order_id;
  assert.equal(r.stock_reserved, false);
  // the normal route is blocked: no shelf life means "From kitchen" isn't offered, and materials need a purchase order
  assert.equal((await rpc(db, 'warehouse', 'inv_item', { p_sku_id: PROD })).kitchen.can_make, false);
  await rejects(rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: MAT, qty: 5, source: 'kitchen' } }), /purchase order/);
});

await test('Only warehouse/manager staff can use it, and only in testing mode', async () => {
  await rejects(rpc(db, 'packer', 'test_stock_in', { p: { sku_id: PROD, qty: 1 } }), /not allowed/);
  await rejects(rpc(db, 'anon', 'test_stock_in', { p: { sku_id: PROD, qty: 1 } }), /permission denied/);
  await rpc(db, 'admin', 'set_app_setting', { p_key: 'testing_mode', p_value: false });
  await rejects(rpc(db, 'warehouse', 'test_stock_in', { p: { sku_id: PROD, qty: 1 } }), /only available in testing mode/);
  await rpc(db, 'admin', 'set_app_setting', { p_key: 'testing_mode', p_value: true });
  await rejects(rpc(db, 'warehouse', 'test_stock_in', { p: { sku_id: PROD, qty: 0 } }), /how many/);
});

let first;
await test('Finished product: stock arrives in a TEST STOCK batch (30-day expiry) and the waiting order is reserved', async () => {
  first = await rpc(db, 'warehouse', 'test_stock_in', { p: { sku_id: PROD, qty: 3, idempotency_key: 'ov-k1' } });
  assert.equal(first.ok, true); assert.equal(first.test, true); assert.equal(first.route, 'test');
  assert.equal(first.batch.expires_on, addDays(30));
  assert.equal(Number(first.item.on_shelf), 3);
  assert.equal(Number(first.item.free), 1, '2 of the 3 are now held for the waiting order');
  // repeating the same tap doesn't add stock twice
  const again = await rpc(db, 'warehouse', 'test_stock_in', { p: { sku_id: PROD, qty: 3, idempotency_key: 'ov-k1' } });
  assert.equal(again.duplicate, true);
  assert.equal(Number((await rpc(db, 'warehouse', 'inv_item', { p_sku_id: PROD })).on_shelf), 3);
  await booksBalance();
});

await test('Ingredient without a purchase order, and a product with a shelf life / chosen expiry', async () => {
  const m = await rpc(db, 'warehouse', 'test_stock_in', { p: { sku_id: MAT, qty: 2.5, idempotency_key: 'ov-k2' } });
  assert.equal(Number(m.item.on_shelf), 2.5);
  const items = await rpc(db, 'warehouse', 'inv_items');
  const cookies = items.find((i) => i.code === 'MT-000001');
  const c = await rpc(db, 'warehouse', 'test_stock_in', { p: { sku_id: cookies.id, qty: 1, idempotency_key: 'ov-k3' } });
  assert.equal(c.batch.expires_on, addDays(90));
  const d = await rpc(db, 'warehouse', 'test_stock_in', { p: { sku_id: cookies.id, qty: 1, expires_on: addDays(5), idempotency_key: 'ov-k4' } });
  assert.equal(d.batch.expires_on, addDays(5));
  await rejects(rpc(db, 'warehouse', 'test_stock_in', { p: { sku_id: cookies.id, qty: 1, expires_on: addDays(-1) } }), /past/);
  await booksBalance();
});

await test('The order then packs normally from the test stock', async () => {
  let o = await rpc(db, 'packer', 'get_order', { p_order_id: orderId });
  for (let i = 0; i < 2; i++) {
    const r = await rpc(db, 'packer', 'pack_scan', { p_order_id: orderId, p_code: first.batch.code,
      p_batch_code: null, p_manual_batch: false, p_idempotency_key: `ov-scan-${i}` });
    assert.equal(r.result, 'accepted', r.message);
  }
  await rpc(db, 'packer', 'complete_packing', { p_order_id: orderId });
  o = await rpc(db, 'packer', 'get_order', { p_order_id: orderId });
  assert.equal(o.status, 'packed');
  await booksBalance();
});

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
