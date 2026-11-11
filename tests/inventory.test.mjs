// Simple inventory acceptance tests: barcodes, Stock in / Stock out /
// Count / Find, manager approval of counts, and the books staying right.
//   npm run test:inventory
import assert from 'node:assert/strict';
import { bootDb, rpc, sqlAs } from './harness.mjs';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
async function rejects(promise, pattern) {
  try { await promise; } catch (e) {
    if (pattern && !pattern.test(e.message)) throw new Error(`Expected ${pattern}, got: ${e.message}`);
    return;
  }
  throw new Error(`Expected an error matching ${pattern}`);
}
const n2 = (v) => Math.round(Number(v) * 100) / 100;
const ean13ok = (c) => {
  if (!/^\d{13}$/.test(c)) return false;
  const s = [...c.slice(0, 12)].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (s % 10)) % 10 === Number(c[12]);
};

const db = await bootDb();
const item = (id) => rpc(db, 'warehouse', 'inv_item', { p_sku_id: id });
const booksBalance = async () => {
  const tb = await rpc(db, 'admin', 'trial_balance');
  assert.equal(n2(tb.total_debit), n2(tb.total_credit), 'trial balance');
  const iv = await rpc(db, 'admin', 'inventory_valuation');
  for (const r of iv.by_type) assert.equal(n2(r.difference), 0, `inventory ${r.account}: stock ${r.stock_value} vs ledger ${r.ledger_value}`);
};

console.log('\nTorte Living OS — simple inventory & barcode tests\n');

let items, COOKIES, ATTA1, ATTA5, FLOUR;
await test('Every item gets its own scannable EAN-13 barcode (internal 200… range), and it never changes', async () => {
  items = await rpc(db, 'warehouse', 'inv_items');
  [COOKIES, ATTA1, ATTA5] = ['MT-000001', 'NS-000001', 'NS-000002'].map((c) => items.find((i) => i.code === c));
  for (const i of items) {
    assert.ok(ean13ok(i.barcode), `${i.code} barcode ${i.barcode}`);
    assert.ok(i.barcode.startsWith('200'));
  }
  assert.equal(new Set(items.map((i) => i.barcode)).size, items.length, 'unique');
  FLOUR = await rpc(db, 'admin', 'create_material', { p: { name: 'Refined wheat flour', item_type: 'raw_material', unit: 'kg', shelf_life_days: 180 } });
  const all = await rpc(db, 'warehouse', 'inv_items');
  const f = all.find((i) => i.id === FLOUR.sku_id);
  assert.ok(ean13ok(f.barcode), 'materials get one too');
  assert.equal(f.item_type, 'raw_material');
  await rejects(db.query(`update skus set barcode = '2000000009990' where id = $1`, [COOKIES.id]), /can't change/);
});

await test('Scanning the sticker barcode finds the item — finished goods and ingredients alike', async () => {
  const a = await rpc(db, 'packer', 'resolve_scan', { p_code: COOKIES.barcode });
  assert.equal(a.kind, 'sku');
  assert.equal(a.sku.id, COOKIES.id);
  const f = (await rpc(db, 'warehouse', 'inv_items', { p_search: 'flour' }))[0];
  const b = await rpc(db, 'warehouse', 'resolve_scan', { p_code: f.barcode });
  assert.equal(b.sku.id, FLOUR.sku_id);
  assert.equal(b.sku.item_type, 'raw_material');
  assert.equal(b.sku.brand, null);
  const c = await rpc(db, 'warehouse', 'resolve_scan', { p_code: '2000000999995' });
  assert.equal(c.kind, 'unknown');
  // a scan of a batch label still identifies the batch
  const it = await item(COOKIES.id);
  const d = await rpc(db, 'warehouse', 'resolve_scan', { p_code: it.batches[0].code });
  assert.equal(d.kind, 'batch');
});

await test('Find shows the shelf by batch, oldest expiry first, with expired stock flagged', async () => {
  const it = await item(COOKIES.id);
  assert.equal(it.on_shelf, 46);
  assert.equal(it.free, 31);
  assert.equal(it.reserved, 9);
  assert.equal(it.batches.length, 2);
  assert.equal(it.batches[0].expired, true);
  assert.equal(it.batches[1].expired, false);
  assert.ok(it.batches[1].days_left > 0);
  assert.equal(it.kitchen.can_make, true);
});

await test('Stock in from the kitchen (no recipe yet): new batch dated today, expiry from shelf life; repeat taps count once', async () => {
  const r = await rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: ATTA1.id, qty: 24, source: 'kitchen', idempotency_key: 'in-1' } });
  assert.equal(r.route, 'receipt');
  assert.match(r.batch.code, /^BAT-/);
  assert.equal(r.item.on_shelf, 84);
  const again = await rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: ATTA1.id, qty: 24, source: 'kitchen', idempotency_key: 'in-1' } });
  assert.equal(again.duplicate, true);
  assert.equal((await item(ATTA1.id)).on_shelf, 84);
  await rejects(rpc(db, 'packer', 'inv_stock_in', { p: { sku_id: ATTA1.id, qty: 1, source: 'kitchen' } }), /not allowed/);
  await rejects(rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: ATTA1.id, qty: 0, source: 'kitchen' } }), /how many/);
  await booksBalance();
});

await test('Ingredients come in only against a purchase order; the PO is shown and received in one step', async () => {
  await rejects(rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: FLOUR.sku_id, qty: 10, source: 'kitchen' } }), /purchase order/);
  const sup = await rpc(db, 'admin', 'create_partner', { p: { legal_name: 'Deccan Mills Pvt Ltd', roles: ['supplier'], state: 'Telangana' } });
  await rpc(db, 'admin', 'create_purchase_order', { p: { supplier_id: sup.partner_id, lines: [{ sku_id: FLOUR.sku_id, qty: 50, unit_price: 40, gst_rate: 5 }] } });
  const it = await item(FLOUR.sku_id);
  assert.equal(it.incoming.length, 1);
  assert.equal(it.incoming[0].remaining, 50);
  assert.equal(it.kitchen, null);
  const r = await rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: FLOUR.sku_id, qty: 30, source: 'po', po_line_id: it.incoming[0].po_line_id, idempotency_key: 'in-po' } });
  assert.equal(r.route, 'purchase');
  assert.equal(r.item.on_shelf, 30);
  assert.equal((await item(FLOUR.sku_id)).incoming[0].remaining, 20);
  await rejects(rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: COOKIES.id, qty: 1, source: 'po', po_line_id: it.incoming[0].po_line_id } }), /different item/);
  await booksBalance();
});

await test('Stock in from the kitchen with a recipe runs production: ingredients are used up and the batch is costed', async () => {
  await rpc(db, 'admin', 'save_recipe', { p: { sku_id: ATTA5.id, output_qty: 10, lines: [{ material_sku_id: FLOUR.sku_id, qty: 50 }] } });
  assert.equal((await item(ATTA5.id)).kitchen.has_recipe, true);
  const r = await rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: ATTA5.id, qty: 4, source: 'kitchen' } });
  assert.equal(r.route, 'production');
  assert.equal((await item(FLOUR.sku_id)).on_shelf, 10, '4 × 5 kg of flour used');
  const b = await db.query(`select unit_cost from batches where id = $1`, [r.batch.id]);
  assert.equal(Number(b.rows[0].unit_cost), 200, '5 kg × ₹40');
  await rejects(rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: ATTA5.id, qty: 10, source: 'kitchen' } }), /Not enough material/);
  await booksBalance();
});

await test('Stock out: damaged takes the oldest batch; expired takes expired batches first; samples leave stock', async () => {
  let it = await item(COOKIES.id);
  const [expired, good] = it.batches;
  const r1 = await rpc(db, 'warehouse', 'inv_stock_out', { p: { sku_id: COOKIES.id, qty: 4, reason: 'expired', idempotency_key: 'out-1' } });
  assert.equal(r1.item.on_shelf, 42);
  it = await item(COOKIES.id);
  assert.equal(it.batches.find((b) => b.id === expired.id).qty, 2, 'came from the expired batch');
  assert.equal(it.batches.find((b) => b.id === good.id).qty, 40);
  assert.equal(it.free, 31, 'expired stock was never free to sell');
  const dup = await rpc(db, 'warehouse', 'inv_stock_out', { p: { sku_id: COOKIES.id, qty: 4, reason: 'expired', idempotency_key: 'out-1' } });
  assert.equal(dup.duplicate, true);
  const r2 = await rpc(db, 'warehouse', 'inv_stock_out', { p: { sku_id: COOKIES.id, batch_id: good.id, qty: 3, reason: 'damaged' } });
  assert.equal(r2.item.free, 28);
  const dmg = await db.query(`select sum(qty) q from stock_balances where sku_id = $1 and status = 'damaged'`, [COOKIES.id]);
  assert.equal(Number(dmg.rows[0].q), 3, 'damaged stock stays on record');
  const r3 = await rpc(db, 'warehouse', 'inv_stock_out', { p: { sku_id: COOKIES.id, qty: 2, reason: 'sample', note: 'Tasting at Inorbit' } });
  assert.equal(r3.item.on_shelf, 37);
  assert.equal((await item(COOKIES.id)).batches.find((b) => b.id === expired.id).qty, 2, 'samples never come from expired stock');
  await booksBalance();
});

await test('Stock out never takes stock promised to customer orders, or more than is on the shelf', async () => {
  const it = await item(COOKIES.id);           // free 26, reserved 9
  await rejects(rpc(db, 'warehouse', 'inv_stock_out', { p: { sku_id: COOKIES.id, qty: 100, reason: 'damaged' } }), /Only 37 on the shelf/);
  await rejects(rpc(db, 'warehouse', 'inv_stock_out', { p: { sku_id: COOKIES.id, qty: it.free + 3, reason: 'damaged' } }), /kept for customer orders/);
  await rejects(rpc(db, 'warehouse', 'inv_stock_out', { p: { sku_id: COOKIES.id, qty: 1, reason: 'lost' } }), /Choose why/);
  await rejects(rpc(db, 'packer', 'inv_stock_out', { p: { sku_id: COOKIES.id, qty: 1, reason: 'damaged' } }), /not allowed/);
});

let PENDING;
await test('A count that matches closes itself; a different count waits for a manager and changes nothing yet', async () => {
  const ok = await rpc(db, 'packer', 'inv_submit_count', { p: { sku_id: ATTA1.id, counted: 84, idempotency_key: 'cnt-1' } });
  assert.equal(ok.status, 'matched');
  assert.match(ok.code, /^CNT-\d{4}-\d{6}$/);
  PENDING = await rpc(db, 'warehouse', 'inv_submit_count', { p: { sku_id: ATTA1.id, counted: 80, idempotency_key: 'cnt-2' } });
  assert.equal(PENDING.status, 'pending');
  assert.equal(PENDING.difference, -4);
  assert.equal((await item(ATTA1.id)).on_shelf, 84, 'unchanged until approved');
  assert.equal((await item(ATTA1.id)).pending_counts, 1);
  const dup = await rpc(db, 'warehouse', 'inv_submit_count', { p: { sku_id: ATTA1.id, counted: 80, idempotency_key: 'cnt-2' } });
  assert.equal(dup.id, PENDING.id);
  const d = await rpc(db, 'admin', 'get_dashboard', { p_days: 30 });
  assert.ok(d.alerts.some((a) => a.type === 'stock_count'), 'dashboard asks the manager');
  const list = await rpc(db, 'admin', 'inv_list_counts', { p_status: 'pending' });
  assert.deepEqual(list.map((c) => c.id), [PENDING.id]);
});

await test('Manager approves: the difference (against the figure at counting time) is posted; reject needs a reason', async () => {
  await rpc(db, 'warehouse', 'inv_stock_out', { p: { sku_id: ATTA1.id, qty: 2, reason: 'sample' } });   // movement after counting
  await rejects(rpc(db, 'warehouse', 'inv_review_count', { p_id: PENDING.id, p_approve: true }), /not allowed/);
  await rejects(rpc(db, 'admin', 'inv_review_count', { p_id: PENDING.id, p_approve: false }), /why/);
  const r = await rpc(db, 'admin', 'inv_review_count', { p_id: PENDING.id, p_approve: true });
  assert.equal(r.status, 'applied');
  assert.match(r.transaction_code, /.+/);
  assert.equal((await item(ATTA1.id)).on_shelf, 78, '84 − 2 sample − 4 missing');
  await rejects(rpc(db, 'admin', 'inv_review_count', { p_id: PENDING.id, p_approve: true }), /already applied/);
  await booksBalance();
});

await test('Recounting replaces a waiting count; extra stock found goes into the newest batch; a manager\'s count applies at once', async () => {
  const c1 = await rpc(db, 'warehouse', 'inv_submit_count', { p: { sku_id: ATTA5.id, counted: 20 } });
  const c2 = await rpc(db, 'warehouse', 'inv_submit_count', { p: { sku_id: ATTA5.id, counted: 14 } });
  const old = (await rpc(db, 'admin', 'inv_list_counts', { p_status: 'recent' })).find((c) => c.id === c1.id);
  assert.equal(old.status, 'replaced');
  const shelf = (await item(ATTA5.id)).on_shelf;
  const m = await rpc(db, 'admin', 'inv_submit_count', { p: { sku_id: ATTA5.id, counted: shelf + 2 } });
  assert.equal(m.status, 'applied');
  assert.equal((await item(ATTA5.id)).on_shelf, shelf + 2);
  assert.equal((await rpc(db, 'admin', 'inv_list_counts', { p_status: 'recent' })).find((c) => c.id === c2.id).status, 'replaced');
  await booksBalance();
});

await test('Counting a single batch (scanned batch label) only touches that batch', async () => {
  const it = await item(COOKIES.id);
  const b = it.batches.find((x) => !x.expired);
  const r = await rpc(db, 'admin', 'inv_submit_count', { p: { sku_id: COOKIES.id, batch_id: b.id, counted: b.qty - 1 } });
  assert.equal(r.system_qty, b.qty);
  const after = await item(COOKIES.id);
  assert.equal(after.batches.find((x) => x.id === b.id).qty, b.qty - 1);
  assert.equal(after.batches.find((x) => x.expired).qty, it.batches.find((x) => x.expired).qty);
  await rejects(rpc(db, 'admin', 'inv_submit_count', { p: { sku_id: ATTA1.id, batch_id: b.id, counted: 1 } }), /different item/);
  await booksBalance();
});

await test('Locked down: the anon key can\'t use any of it, and staff can\'t read the tables directly', async () => {
  await rejects(rpc(db, 'anon', 'inv_items'), /permission denied/);
  await rejects(rpc(db, 'anon', 'inv_stock_in', { p: {} }), /permission denied/);
  await rejects(rpc(db, 'warehouse', 'inv_apply_count', { p_id: PENDING.id }), /permission denied/);
  await rejects(rpc(db, 'warehouse', 'next_internal_barcode'), /permission denied/);
  const rows = await sqlAs(db, 'warehouse', 'select * from stock_counts');
  assert.equal(rows.length, 0, 'RLS hides counts');
});

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
