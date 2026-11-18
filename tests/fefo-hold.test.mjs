// First expiry, first out at packing, and unpaid online orders that stop
// holding stock after unpaid_hold_minutes() (owner's E2E test run, 2026-11-18).
//   npm run test:fefo
import assert from 'node:assert/strict';
import { bootDb, rpc } from './harness.mjs';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
const db = await bootDb();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const LOC = (await one(`select default_location_id() id`)).id;
// Each test gets a fresh item with no orders or stock, so it controls every batch and hold.
let sku, items = 0;
async function freshItem() {
  items += 1;
  const c = await rpc(db, 'admin', 'create_product_sku', { p: {
    brand_id: (await one(`select id from brands where code = 'MT'`)).id, category_id: (await one(`select id from categories where name = 'Cookies'`)).id,
    product_name: `FEFO Test Cookie ${items}`, sku_name: `FEFO Test Cookie ${items} 60 g`, pack_size: 60, pack_unit: 'g', mrp: 80, website_price: 75, shelf_life_days: 60 } });
  sku = { id: c.sku_id, code: c.sku_code };
}
const atp = async () => Number((await one(`select atp_qty($1, $2) q`, [sku.id, LOC])).q);
const shelfRows = async () => Number((await one(`select count(*) c from stock_movements`)).c);

// Clear this item's free stock before a test.
async function emptyShelf() {
  const rows = (await db.query(`select batch_id, qty from stock_balances where sku_id = $1 and location_id = $2 and status = 'available' and qty > 0`, [sku.id, LOC])).rows;
  const free = await atp();
  let left = free;
  for (const r of rows) {
    const take = Math.min(Number(r.qty), left); if (take <= 0) continue; left -= take;
    await rpc(db, 'admin', 'adjust_stock', { p_sku_id: sku.id, p_batch_id: r.batch_id, p_location_id: LOC, p_qty_delta: -take,
      p_reason: 'test setup', p_status: 'available', p_owner_id: null, p_idempotency_key: null });
  }
}
async function batch(expires_on, qty, qa = 'released') {
  const b = await rpc(db, 'warehouse', 'create_batch', { p: { sku_id: sku.id, manufactured_on: '2026-01-01', expires_on, unit_cost: 50, qa_status: qa } });
  await rpc(db, 'admin', 'receive_stock', { p_sku_id: sku.id, p_batch_id: b.batch_id, p_location_id: LOC, p_qty: qty,
    p_source: 'production', p_notes: 'test', p_idempotency_key: null });
  return b.batch_code;
}
let n = 0;
async function order(qty, payment = { status: 'cod', method: 'cod' }) {
  n += 1;
  const r = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: `fefo-${n}`, p_payload: {
    external_order_id: `FEFO${n}`, customer: { name: 'Hold Test', phone: `90000777${String(n).padStart(2, '0')}` },
    ship_to: { name: 'Hold Test', phone: `90000777${String(n).padStart(2, '0')}`, address1: 'x', city: 'Hyderabad', state: 'Telangana', pincode: '500034' },
    lines: [{ sku_code: sku.code, qty, unit_price: 75 }], shipping_amount: 0, payment } });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.order_id;
}
const get = (id) => rpc(db, 'admin', 'get_order', { p_order_id: id });
const scan = (id, code) => rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: code });
// Make an order look as if it reached us N minutes ago.
const age = (id, minutes) => db.query(`update orders set created_at = now() - make_interval(mins => $2) where id = $1`, [id, minutes]);

console.log('\nFirst expiry, first out · unpaid-order stock hold\n');

let OLD, NEW;
await test('Packing refuses a batch while one that expires sooner still has free stock, and says which to take', async () => {
  await freshItem();
  NEW = await batch('2027-06-30', 5);
  OLD = await batch('2027-01-31', 1);
  const id = await order(2);
  const before = await shelfRows();
  const r = await scan(id, NEW);
  assert.equal(r.result, 'not_earliest_expiry');
  assert.match(r.message, new RegExp(`Take batch ${OLD} first \\(best before 31 Jan 2027\\)`));
  assert.match(r.message, /Ask a manager to count it/);
  assert.equal(await shelfRows(), before, 'no stock moved');
  assert.equal((await get(id)).lines[0].scanned, 0);
  // the older batch goes first; once it is used up the newer one is accepted
  assert.equal((await scan(id, OLD)).result, 'accepted');
  assert.equal((await scan(id, NEW)).result, 'accepted');
  await rpc(db, 'packer', 'complete_packing', { p_order_id: id });
});

await test('Older stock that is expired, on hold or already scanned for another order does not block', async () => {
  await freshItem();
  await batch('2026-11-01', 4);                 // expired
  await batch('2027-02-01', 4, 'quarantined');   // on hold
  const fresh = await batch('2027-08-31', 6);
  const a = await order(1);
  assert.equal((await scan(a, fresh)).result, 'accepted', 'expired and on-hold batches are skipped');
  const older = await batch('2027-03-31', 1);
  const b = await order(1), c = await order(1);
  assert.equal((await scan(b, older)).result, 'accepted');
  assert.equal((await scan(c, fresh)).result, 'accepted', 'the only older pack is already scanned for order b');
});

await test('The batch list offered at packing is earliest expiry first', async () => {
  await freshItem();
  const late = await batch('2027-09-30', 2);
  const early = await batch('2027-04-30', 2);
  const id = await order(1);
  const r = await rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: (await one(`select barcode from skus where id = $1`, [sku.id])).barcode });
  assert.equal(r.result, 'batch_required');
  assert.deepEqual(r.eligible_batches.map((b) => b.code), [early, late]);
});

let UNPAID;
await test('An unpaid online order holds its stock for 30 minutes', async () => {
  await freshItem();
  await batch('2027-10-31', 3);
  assert.equal(Number((await one(`select unpaid_hold_minutes() m`)).m), 30);
  UNPAID = await order(3, { status: 'pending' });
  const o = await get(UNPAID);
  assert.deepEqual([o.status, o.payment_status, o.stock_shortfall], ['pending_payment', 'unpaid', false]);
  assert.equal(await atp(), 0);
  await age(UNPAID, 29);
  assert.equal(await atp(), 0, 'still held at 29 minutes');
  const q = await rpc(db, 'service', 'storefront_quote', { p_lines: [{ sku_code: sku.code, qty: 1 }] });
  assert.equal(q.problems[0]?.reason, 'sold_out');
});

let OTHER;
await test('After 30 minutes the stock is free again: the shop sells it and the hold is released', async () => {
  await age(UNPAID, 31);
  assert.equal(await atp(), 3, 'hold no longer counts');
  const q = await rpc(db, 'service', 'storefront_quote', { p_lines: [{ sku_code: sku.code, qty: 2 }] });
  assert.equal(q.problems.length, 0);
  OTHER = await order(2);                                    // another (COD) shopper buys two
  const o = await get(OTHER);
  assert.equal(o.stock_shortfall, false);
  const held = await one(`select count(*) filter (where status = 'active') a, count(*) filter (where status = 'released') r from stock_reservations where order_id = $1`, [UNPAID]);
  assert.deepEqual([Number(held.a), Number(held.r)], [0, 1], 'the expired hold was closed');
  assert.equal(await atp(), 1);
  const u = await get(UNPAID);
  assert.equal(u.status, 'pending_payment', 'the order itself is kept; staff can still see it');
});

await test('New stock is not given to an unpaid order whose hold ran out', async () => {
  await db.query(`update orders set stock_shortfall = true where id = $1`, [UNPAID]);
  await batch('2027-12-31', 2);
  const held = await one(`select count(*) c from stock_reservations where order_id = $1 and status = 'active'`, [UNPAID]);
  assert.equal(Number(held.c), 0);
  assert.equal(await atp(), 3);
  await db.query(`update orders set stock_shortfall = false where id = $1`, [UNPAID]);
});

await test('A late payment confirms the order and reserves again; if the stock has gone it waits for stock', async () => {
  const total = Number((await get(UNPAID)).total_amount);
  await rpc(db, 'service', 'ingest_payment', { p_source: 'woocommerce', p_event_id: 'late-pay', p_external_order_id: (await get(UNPAID)).external_order_id,
    p_payment: { amount: total, method: 'upi', gateway: 'razorpay', gateway_ref: 'pay_late' } });
  let o = await get(UNPAID);
  assert.deepEqual([o.status, o.payment_status, o.stock_shortfall], ['confirmed', 'paid', false], '3 were free again, so it is reserved');
  assert.equal(await atp(), 0);
  // second case: hold ran out and the stock was sold before the payment arrived
  const late = await order(1, { status: 'pending' });
  await age(late, 45);
  await emptyShelf();                                         // its stock is sold elsewhere meanwhile
  await rpc(db, 'service', 'ingest_payment', { p_source: 'woocommerce', p_event_id: 'late-pay-2', p_external_order_id: (await get(late)).external_order_id,
    p_payment: { amount: Number((await get(late)).total_amount), method: 'upi', gateway: 'razorpay', gateway_ref: 'pay_late_2' } });
  o = await get(late);
  assert.deepEqual([o.status, o.payment_status, o.stock_shortfall], ['confirmed', 'paid', true], 'paid, waiting for stock');
});

await test('A late payment does not keep a run-out hold on stock that was moved away meanwhile', async () => {
  await freshItem();
  await batch('2028-01-31', 2);
  const late = await order(1, { status: 'pending' });
  assert.equal(Number((await one(`select count(*) c from stock_reservations where order_id = $1 and status = 'active'`, [late])).c), 1, 'held at first');
  await age(late, 45);
  await emptyShelf();                    // no other order reserved, so the run-out hold is still marked active
  assert.equal(Number((await one(`select count(*) c from stock_reservations where order_id = $1 and status = 'active'`, [late])).c), 1);
  await rpc(db, 'service', 'ingest_payment', { p_source: 'woocommerce', p_event_id: 'late-pay-3', p_external_order_id: (await get(late)).external_order_id,
    p_payment: { amount: Number((await get(late)).total_amount), method: 'upi', gateway: 'razorpay', gateway_ref: 'pay_late_3' } });
  const o = await get(late);
  assert.deepEqual([o.status, o.payment_status, o.stock_shortfall], ['confirmed', 'paid', true], 'paid, waiting for stock — not falsely ready to pack');
  assert.equal(Number((await one(`select count(*) c from stock_reservations where order_id = $1 and status = 'active'`, [late])).c), 0, 'old hold released');
  assert.equal(await atp(), 0);
});

await test('Cash-on-delivery orders keep their stock however long they wait', async () => {
  await freshItem();
  await batch('2028-01-31', 2);
  const cod = await order(2);
  await age(cod, 60 * 24 * 3);
  assert.equal(await atp(), 0);
  assert.equal(Number((await one(`select count(*) c from stock_reservations where order_id = $1 and status = 'active'`, [cod])).c), 1);
});

await test('The hold functions are internal: staff and the public key cannot call them', async () => {
  for (const user of ['admin', 'anon']) {
    await assert.rejects(rpc(db, user, 'release_expired_unpaid_holds'), /permission denied/);
  }
});

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
