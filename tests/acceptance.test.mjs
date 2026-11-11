// Acceptance tests from the requirements specification, run against the
// real migrations on an in-process PostgreSQL.  `npm run test:db`
import assert from 'node:assert/strict';
import { bootDb, rpc, sqlAs } from './harness.mjs';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}
async function rejects(promise, pattern) {
  try {
    await promise;
  } catch (e) {
    if (pattern && !pattern.test(e.message)) throw new Error(`Expected error ${pattern}, got: ${e.message}`);
    return e.message;
  }
  throw new Error(`Expected an error matching ${pattern}`);
}

const db = await bootDb();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const sku = async (code) => (await rpc(db, 'admin', 'list_skus', { p_search: code }))[0];
const COOKIES = 'MT-000001', ATTA1 = 'NS-000001', ATTA5 = 'NS-000002';
const batchCode = async (skuCode, expired = false) =>
  (await one(`select b.code from batches b join skus s on s.id = b.sku_id where s.code = $1 and (b.expires_on < today_ist()) = $2
              order by b.created_at limit 1`, [skuCode, expired])).code;

let n = 0;
const order = (lines, extra = {}) => ({
  external_order_id: `X${++n}`,
  channel: 'WEB',
  customer: { external_id: 'cx-9', name: 'Test Buyer', phone: '9876543210', email: 'Buyer@Example.com' },
  ship_to: { name: 'Test Buyer', address1: '1 Test Road', city: 'Hyderabad', pincode: '500001' },
  lines,
  payment: { status: 'paid', method: 'upi', gateway: 'razorpay', gateway_ref: `pay_X${n}` },
  ...extra,
});

console.log('\nTorte Living OS — acceptance tests\n');

// ---------------------------------------------------------------------
await test('New product created: SKU code generated once, by brand, visible to the app', async () => {
  const brands = (await rpc(db, 'admin', 'get_reference_data')).brands;
  const ns = brands.find((b) => b.code === 'NS');
  const r = await rpc(db, 'admin', 'create_product_sku', { p: {
    brand_id: ns.id, product_name: 'Ragi Dosa Mix', sku_name: 'Ragi Dosa Mix 500 g', pack_size: 500, pack_unit: 'g',
    mrp: 180, website_price: 165, shelf_life_days: 180, reorder_level: 5 } });
  assert.equal(r.sku_code, 'NS-000003');
  const listed = await sku('NS-000003');
  assert.equal(listed.name, 'Ragi Dosa Mix 500 g');
  assert.equal(Number(listed.web_price), 165);
  await rejects(rpc(db, 'packer', 'create_product_sku', { p: { product_id: r.product_id, sku_name: 'x', pack_size: 1, pack_unit: 'kg' } }), /not allowed/);
});

let o1;
await test('Website order placed: appears with the correct customer and line items', async () => {
  const before = await sku(COOKIES);
  const r = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'evt-1',
    p_payload: order([{ sku_code: COOKIES, qty: 2 }, { sku_code: ATTA1, qty: 1 }], { shipping_amount: 50 }) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 'confirmed');
  assert.equal(r.payment_status, 'paid');
  o1 = await rpc(db, 'packer', 'get_order', { p_order_id: r.order_id });
  assert.match(o1.code, /^ORD-\d{4}-\d{6}$/);
  assert.equal(o1.customer.name, 'Test Buyer');
  assert.equal(o1.lines.length, 2);
  assert.equal(Number(o1.total_amount), 2 * 225 + 110 + 50);
  // GST is computed inside the tax-inclusive price (18% on cookies, 5% on atta)
  assert.equal(Number(o1.tax_amount), Math.round((450 * 18 / 118 + 110 * 5 / 105) * 100) / 100);
  // Stock reserved: available-to-promise reflects the order
  const after = await sku(COOKIES);
  assert.equal(Number(after.atp), Number(before.atp) - 2);
});

await test('Same customer recognised by email/phone (no duplicate customer)', async () => {
  const r = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'evt-2',
    p_payload: { ...order([{ sku_code: ATTA1, qty: 1 }]), customer: { name: 'T. Buyer', email: 'buyer@example.com' } } });
  const o = await rpc(db, 'admin', 'get_order', { p_order_id: r.order_id });
  assert.equal(o.customer.code, o1.customer.code);
});

await test('Connection interrupted: retried webhook does not create a duplicate order or reservation', async () => {
  const atpBefore = Number((await sku(COOKIES)).atp);
  const payload = order([{ sku_code: COOKIES, qty: 1 }]);
  const a = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'evt-3', p_payload: payload });
  const b = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'evt-3', p_payload: payload });
  const c = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'evt-3-redelivery', p_payload: payload });
  assert.equal(b.duplicate, true);
  assert.equal(c.duplicate, true);
  assert.equal(b.order_id, a.order_id);
  assert.equal(c.order_id, a.order_id);
  assert.equal(Number((await sku(COOKIES)).atp), atpBefore - 1);
  const cnt = await one(`select count(*)::int n from payments where gateway_ref = $1`, [payload.payment.gateway_ref]);
  assert.equal(cnt.n, 1);
});

await test('Failed import is logged, then succeeds when retried with corrected data', async () => {
  const bad = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'evt-bad',
    p_payload: order([{ sku_code: 'NOPE-1', qty: 1 }], { external_order_id: 'BAD-1' }) });
  assert.equal(bad.ok, false);
  const ev = await one(`select status, error from integration_events where event_id = 'evt-bad'`);
  assert.equal(ev.status, 'failed');
  assert.equal(await one(`select count(*)::int n from orders where external_order_id = 'BAD-1'`).then((r) => r.n), 0);
  const dash = await rpc(db, 'admin', 'get_dashboard');
  assert.ok(dash.alerts.some((a) => a.type === 'integration'));
  const good = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'evt-bad',
    p_payload: order([{ sku_code: ATTA1, qty: 1 }], { external_order_id: 'BAD-1' }) });
  assert.equal(good.ok, true);
  assert.equal((await one(`select attempts from integration_events where event_id = 'evt-bad'`)).attempts, 2);
});

await test('Anonymous (public website key) cannot call anything', async () => {
  await rejects(rpc(db, 'anon', 'get_work_queue'), /permission denied/);
  await rejects(rpc(db, 'anon', 'ingest_order', { p_source: 'x', p_event_id: 'y', p_payload: {} }), /permission denied/);
});

await test('Product scanned: wrong product, unknown code, expired and quarantined batches are rejected', async () => {
  const id = o1.id;
  let r = await rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: ATTA5 });
  assert.equal(r.result, 'wrong_product');
  r = await rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: 'GARBAGE-123' });
  assert.equal(r.result, 'unknown_code');
  r = await rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: await batchCode(COOKIES, true) });
  assert.equal(r.result, 'batch_expired');
  // Product barcode alone on a batch-tracked product -> ask for the batch label
  r = await rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: COOKIES });
  assert.equal(r.result, 'batch_required');
  assert.equal(r.eligible_batches.length, 1, 'expired batch is not offered');
  // Quarantine a batch -> cannot pack it; only a manager can release it
  const atta = await batchCode(ATTA1);
  const bid = (await one(`select id from batches where code = $1`, [atta])).id;
  await rejects(rpc(db, 'packer', 'set_batch_qa', { p_batch_id: bid, p_status: 'quarantined', p_notes: 'x' }), /not allowed/);
  await rpc(db, 'admin', 'set_batch_qa', { p_batch_id: bid, p_status: 'quarantined', p_notes: 'Moisture check' });
  r = await rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: atta });
  assert.equal(r.result, 'batch_not_released');
  await rpc(db, 'admin', 'set_batch_qa', { p_batch_id: bid, p_status: 'released', p_notes: 'Re-tested OK' });
  const rejectedRows = await one(`select count(*)::int n from pack_scans where order_id = $1 and result <> 'accepted'`, [id]);
  assert.equal(rejectedRows.n, 4, 'every rejected scan is recorded against the order');
});

await test('Order cannot be packed until every item is validated; excess is flagged', async () => {
  const id = o1.id;
  const cookieBatch = await batchCode(COOKIES);
  let r = await rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: cookieBatch, p_idempotency_key: 'scan-1' });
  assert.equal(r.result, 'accepted');
  assert.equal(r.order.status, 'packing');
  // Network retry of the same scan does not double count
  r = await rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: cookieBatch, p_idempotency_key: 'scan-1' });
  assert.equal(r.duplicate, true);
  assert.equal(Number(r.order.lines.find((l) => l.sku_code === COOKIES).scanned), 1);
  await rejects(rpc(db, 'packer', 'complete_packing', { p_order_id: id }), /Not every item/);
  // Product barcode + batch label as two scans
  r = await rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: COOKIES, p_batch_code: cookieBatch });
  assert.equal(r.result, 'accepted');
  r = await rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: cookieBatch });
  assert.equal(r.result, 'excess_quantity');
  r = await rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: await batchCode(ATTA1) });
  assert.equal(r.result, 'accepted');
  const scan = r.scan_id;
  // Undo posts a reversal (nothing deleted), then re-scan
  r = await rpc(db, 'packer', 'undo_pack_scan', { p_scan_id: scan });
  assert.equal(Number(r.order.lines.find((l) => l.sku_code === ATTA1).scanned), 0);
  r = await rpc(db, 'packer', 'pack_scan', { p_order_id: id, p_code: await batchCode(ATTA1) });
  assert.equal(r.result, 'accepted');
});

await test('Order packed: status updated, stock moved available → packed, reservation consumed', async () => {
  const before = await sku(COOKIES);
  const r = await rpc(db, 'packer', 'complete_packing', { p_order_id: o1.id });
  assert.equal(r.order.status, 'packed');
  const after = await sku(COOKIES);
  assert.equal(Number(after.sellable), Number(before.sellable) - 2);
  assert.equal(Number(after.reserved), Number(before.reserved) - 2);
  assert.equal(Number(after.atp), Number(before.atp), 'free stock unchanged by packing');
  assert.equal(Number(after.packed), Number(before.packed) + 2);
  const again = await rpc(db, 'packer', 'complete_packing', { p_order_id: o1.id });
  assert.equal(again.duplicate, true);
});

await test('Dispatch recorded: provider and booking reference linked, stock leaves inventory', async () => {
  await rejects(rpc(db, 'packer', 'dispatch_order', { p_order_id: o1.id, p_provider_code: 'RAPIDO' }), /booking reference/);
  const before = await sku(COOKIES);
  const r = await rpc(db, 'packer', 'dispatch_order', { p_order_id: o1.id, p_provider_code: 'RAPIDO',
    p_booking_ref: 'RPD-778812', p_freight_cost: 65, p_idempotency_key: 'disp-1' });
  assert.match(r.shipment_code, /^SHP-\d{4}-\d{6}$/);
  assert.equal(r.order.status, 'dispatched');
  assert.equal(r.order.shipments[0].booking_ref, 'RPD-778812');
  const retry = await rpc(db, 'packer', 'dispatch_order', { p_order_id: o1.id, p_provider_code: 'RAPIDO',
    p_booking_ref: 'RPD-778812', p_idempotency_key: 'disp-1' });
  assert.equal(retry.duplicate, true);
  const after = await sku(COOKIES);
  assert.equal(Number(after.packed), Number(before.packed) - 2);
  assert.equal(Number(after.company_total), Number(before.company_total) - 2);
  const d = await rpc(db, 'packer', 'mark_delivered', { p_order_id: o1.id });
  assert.equal(d.order.status, 'delivered');
  await rejects(rpc(db, 'admin', 'cancel_order', { p_order_id: o1.id, p_reason: 'late' }), /record a return/);
});

await test('Order cancelled: reservation released (before and after packing)', async () => {
  const atp0 = Number((await sku(ATTA1)).atp);
  const a = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'evt-c1', p_payload: order([{ sku_code: ATTA1, qty: 3 }]) });
  assert.equal(Number((await sku(ATTA1)).atp), atp0 - 3);
  await rejects(rpc(db, 'packer', 'cancel_order', { p_order_id: a.order_id, p_reason: 'customer asked' }), /not allowed/);
  await rejects(rpc(db, 'admin', 'cancel_order', { p_order_id: a.order_id, p_reason: '' }), /reason/);
  const c = await rpc(db, 'admin', 'cancel_order', { p_order_id: a.order_id, p_reason: 'Customer changed mind' });
  assert.equal(c.order.status, 'cancelled');
  assert.equal(Number(c.refund_due), 330);
  assert.equal(Number((await sku(ATTA1)).atp), atp0);

  // Packed then cancelled -> goods return to available stock
  const b = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'evt-c2', p_payload: order([{ sku_code: ATTA1, qty: 1 }]) });
  await rpc(db, 'packer', 'pack_scan', { p_order_id: b.order_id, p_code: await batchCode(ATTA1) });
  await rpc(db, 'packer', 'complete_packing', { p_order_id: b.order_id });
  const sellable = Number((await sku(ATTA1)).sellable);
  await rpc(db, 'admin', 'cancel_order', { p_order_id: b.order_id, p_reason: 'Address unserviceable' });
  assert.equal(Number((await sku(ATTA1)).sellable), sellable + 1);
  assert.equal(Number((await sku(ATTA1)).atp), atp0);
});

await test('Refund processed: payment and order records reconciled; over-refund blocked', async () => {
  const id = (await one(`select id from orders where external_order_id = (select external_order_id from orders o join integration_events e on e.order_id = o.id where e.event_id = 'evt-c1')`)).id;
  await rejects(rpc(db, 'packer', 'record_refund', { p_order_id: id, p_amount: 330, p_reference: 'rfnd_1', p_reason: 'x' }), /not allowed/);
  await rejects(rpc(db, 'admin', 'record_refund', { p_order_id: id, p_amount: 500, p_reference: 'rfnd_1', p_reason: 'Cancelled' }), /exceeds/);
  let r = await rpc(db, 'admin', 'record_refund', { p_order_id: id, p_amount: 130, p_reference: 'rfnd_1', p_reason: 'Cancelled', p_idempotency_key: 'rf-1' });
  assert.equal(r.payment_status, 'partially_refunded');
  r = await rpc(db, 'admin', 'record_refund', { p_order_id: id, p_amount: 130, p_reference: 'rfnd_1', p_reason: 'Cancelled', p_idempotency_key: 'rf-1' });
  assert.equal(r.duplicate, true);
  r = await rpc(db, 'admin', 'record_refund', { p_order_id: id, p_amount: 200, p_reference: 'rfnd_2', p_reason: 'Cancelled' });
  assert.equal(r.payment_status, 'refunded');
  const o = await rpc(db, 'admin', 'get_order', { p_order_id: id });
  assert.equal(Number(o.amount_paid), 0);
});

await test('Two customers cannot buy the same last packet', async () => {
  const brands = (await rpc(db, 'admin', 'get_reference_data')).brands;
  const s = await rpc(db, 'admin', 'create_product_sku', { p: { brand_id: brands.find((b) => b.code === 'MT').id,
    product_name: 'Fudge Brownie', sku_name: 'Fudge Brownie 1 pc', pack_size: 1, pack_unit: 'pcs', mrp: 90, website_price: 90, shelf_life_days: 7 } });
  const b = await rpc(db, 'warehouse', 'create_batch', { p: { sku_id: s.sku_id } });
  assert.match(b.batch_code, /^BAT-\d{4}-\d{6}$/);
  const loc = (await rpc(db, 'admin', 'get_reference_data')).locations.find((l) => l.is_default).id;
  await rpc(db, 'warehouse', 'receive_stock', { p_sku_id: s.sku_id, p_batch_id: b.batch_id, p_location_id: loc, p_qty: 1, p_source: 'production' });
  const [x, y] = await Promise.all([
    rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'race-1', p_payload: order([{ sku_code: s.sku_code, qty: 1 }]) }),
    rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'race-2', p_payload: order([{ sku_code: s.sku_code, qty: 1 }]) }),
  ]);
  assert.deepEqual([x.stock_reserved, y.stock_reserved].sort(), [false, true]);
  assert.equal(Number((await sku(s.sku_code)).atp), 0);
  const loser = x.stock_reserved ? y : x;
  const r = await rpc(db, 'packer', 'pack_scan', { p_order_id: loser.order_id, p_code: b.batch_code });
  assert.equal(r.result, 'order_not_packable');
  const dash = await rpc(db, 'admin', 'get_dashboard');
  assert.ok(dash.alerts.some((a) => a.type === 'stock_shortfall'));
  // Restocking automatically reserves for the waiting order
  const rec = await rpc(db, 'warehouse', 'receive_stock', { p_sku_id: s.sku_id, p_batch_id: b.batch_id, p_location_id: loc, p_qty: 3, p_source: 'production' });
  assert.deepEqual(rec.orders_unblocked, [(await rpc(db, 'admin', 'get_order', { p_order_id: loser.order_id })).code]);
  assert.equal(Number(rec.atp), 2);
});

await test('Stock cannot go negative; adjustments need a reason and a manager', async () => {
  const s = await sku(ATTA5);
  const bid = (await one(`select b.id from batches b where b.sku_id = $1`, [s.id])).id;
  const loc = (await rpc(db, 'admin', 'get_reference_data')).locations.find((l) => l.is_default).id;
  await rejects(rpc(db, 'warehouse', 'adjust_stock', { p_sku_id: s.id, p_batch_id: bid, p_location_id: loc, p_qty_delta: -1, p_reason: 'count' }), /not allowed/);
  await rejects(rpc(db, 'admin', 'adjust_stock', { p_sku_id: s.id, p_batch_id: bid, p_location_id: loc, p_qty_delta: -1, p_reason: ' ' }), /reason/);
  await rejects(rpc(db, 'admin', 'adjust_stock', { p_sku_id: s.id, p_batch_id: bid, p_location_id: loc, p_qty_delta: -1000, p_reason: 'count' }), /reserved|Insufficient/);
  const r = await rpc(db, 'admin', 'adjust_stock', { p_sku_id: s.id, p_batch_id: bid, p_location_id: loc, p_qty_delta: 2, p_reason: 'Stock count found 2 extra' });
  assert.match(r.transaction_code, /^ADJ-/);
  const t = await one(`select reason, created_by from stock_transactions where code = $1`, [r.transaction_code]);
  assert.equal(t.reason, 'Stock count found 2 extra');
  assert.ok(t.created_by, 'who made the adjustment is recorded');
});

await test('Completed records cannot be edited or deleted, even directly', async () => {
  await rejects(db.query(`update stock_movements set qty = 999`), /permanent/);
  await rejects(db.query(`delete from stock_transactions`), /permanent/);
  await rejects(db.query(`delete from payments`), /permanent/);
  await rejects(db.query(`delete from pack_scans`), /permanent/);
  await rejects(db.query(`delete from orders`), /cannot be deleted/);
  await rejects(db.query(`update stock_balances set qty = 1000`), /cannot be edited directly/);
  // Through the API as staff: no write policy at all
  const rows = await sqlAs(db, 'admin', `update orders set total_amount = 1 returning id`);
  assert.equal(rows.length, 0, 'RLS: orders are not directly writable');
  await rejects(sqlAs(db, 'admin', `select post_stock_txn('adjustment', '[]'::jsonb)`), /permission denied/);
  await rejects(sqlAs(db, 'packer', `insert into price_list_items (price_list_id, sku_id, price) select pl.id, s.id, 1 from price_lists pl, skus s limit 1`), /row-level security/);
});

await test('Consignment vs outright transfer: location and ownership tracked separately', async () => {
  const ref = await rpc(db, 'admin', 'get_reference_data');
  const wh = ref.locations.find((l) => l.is_default).id;
  const dist = ref.locations.find((l) => l.type === 'distributor').id;
  const s = await sku(ATTA1);
  const bid = (await one(`select id from batches where sku_id = $1`, [s.id])).id;
  const a = await rpc(db, 'warehouse', 'transfer_stock', { p_sku_id: s.id, p_batch_id: bid, p_from_location: wh, p_to_location: dist, p_qty: 5, p_ownership: 'keep', p_reason: 'Consignment' });
  assert.equal(a.ownership_changed, false);
  const b = await rpc(db, 'warehouse', 'transfer_stock', { p_sku_id: s.id, p_batch_id: bid, p_from_location: wh, p_to_location: dist, p_qty: 4, p_ownership: 'to_partner', p_reason: 'Outright sale' });
  assert.equal(b.ownership_changed, true);
  const st = await rpc(db, 'warehouse', 'get_sku_stock', { p_sku_id: s.id });
  const at = (h) => st.balances.filter((x) => x.location_id === dist && x.holding === h).reduce((t, x) => t + Number(x.qty), 0);
  assert.equal(at('consignment'), 15);   // 10 from seed + 5
  assert.equal(at('partner_owned'), 4);
  await rejects(rpc(db, 'warehouse', 'transfer_stock', { p_sku_id: s.id, p_batch_id: bid, p_from_location: wh, p_to_location: dist, p_qty: 10000 }), /free to transfer/);
  const dash = await rpc(db, 'admin', 'get_dashboard');
  assert.ok(dash.stock_chain.some((c) => c.holding === 'partner_owned' && Number(c.units) === 4));
});

await test('GS1 barcodes: invalid GTIN rejected; GTIN and Digital Link QR resolve to SKU + batch', async () => {
  const s = await sku(COOKIES);
  await rejects(db.query(`insert into gtins (sku_id, gtin) values ($1, '8901234567892')`, [s.id]), /check/);
  await db.query(`insert into gtins (sku_id, gtin) values ($1, '8901234567890')`, [s.id]);   // test number, valid check digit
  let r = await rpc(db, 'packer', 'resolve_scan', { p_code: '8901234567890' });
  assert.equal(r.kind, 'sku'); assert.equal(r.sku.code, COOKIES);
  const bc = await batchCode(COOKIES);
  r = await rpc(db, 'packer', 'resolve_scan', { p_code: `https://id.example.in/01/08901234567890/10/${bc}` });
  assert.equal(r.kind, 'batch'); assert.equal(r.batch.code, bc);
  r = await rpc(db, 'packer', 'resolve_scan', { p_code: `(01)08901234567890(10)${bc}` });
  assert.equal(r.kind, 'batch');
});

await test('Price change is dated and does not rewrite old orders', async () => {
  const s = await sku(COOKIES);
  const lineBefore = await one(`select unit_price from order_lines where order_id = $1 and sku_id = $2`, [o1.id, s.id]);
  await rejects(rpc(db, 'packer', 'set_price', { p_sku_id: s.id, p_price_list_code: 'WEB', p_price: 199 }), /not allowed/);
  await rpc(db, 'admin', 'set_price', { p_sku_id: s.id, p_price_list_code: 'WEB', p_price: 199 });
  assert.equal(Number((await sku(COOKIES)).web_price), 199);
  const lineAfter = await one(`select unit_price from order_lines where order_id = $1 and sku_id = $2`, [o1.id, s.id]);
  assert.equal(Number(lineAfter.unit_price), Number(lineBefore.unit_price));
  const hist = await one(`select count(*)::int n from price_list_items i join price_lists l on l.id = i.price_list_id where l.code = 'WEB' and i.sku_id = $1`, [s.id]);
  assert.equal(hist.n, 2);
});

await test('Cash-on-delivery order: payment collected later marks it paid', async () => {
  const id = (await one(`select id from orders where payment_status = 'cod_pending' order by placed_at limit 1`)).id;
  const o = await rpc(db, 'admin', 'get_order', { p_order_id: id });
  await rpc(db, 'packer', 'record_payment', { p_order_id: id, p_amount: o.total_amount, p_method: 'cash', p_reference: 'COD-cash' });
  assert.equal((await rpc(db, 'admin', 'get_order', { p_order_id: id })).payment_status, 'paid');
});

await test('Founder dashboard returns KPIs, alerts and MIS', async () => {
  const d = await rpc(db, 'admin', 'get_dashboard');
  for (const k of ['sales_today', 'orders_today', 'outstanding_payments', 'low_stock_count']) assert.ok(k in d.kpis, k);
  assert.ok(d.sales_by_brand.length >= 2);
  assert.ok(d.alerts.some((a) => a.type === 'expiry'));
  assert.ok(d.sales_by_brand.some((b) => b.gross_margin_pct !== null), 'margin computed from batch cost');
  await rejects(rpc(db, 'packer', 'get_dashboard'), /not allowed/);
  const audit = await one(`select count(*)::int n from audit_log`);
  assert.ok(audit.n > 0);
});

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
