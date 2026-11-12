// Storefront: public catalogue, order tracking, server-side quote, and the
// storefront-order Edge Function's logic fed through the real ingest_order.
// `npm run test:storefront`
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootDb, rpc } from './harness.mjs';
import {
  validatePlaceRequest, validateLines, normalisePhone, buildIngestPayload, totalsFor, shippingFor,
  externalOrderIdFor, SHIPPING_FLAT, FREE_SHIPPING_ABOVE, MAX_LINES,
} from '../supabase/functions/storefront-order/logic.ts';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
async function rejects(promise, pattern) {
  try { await promise; } catch (e) {
    if (pattern && !pattern.test(e.message)) throw new Error(`Expected error ${pattern}, got: ${e.message}`);
    return;
  }
  throw new Error(`Expected an error matching ${pattern}`);
}

const db = await bootDb();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const atp = async (code) => Number((await rpc(db, 'admin', 'list_skus', { p_search: code }))[0].atp);
const catalogue = () => rpc(db, 'anon', 'storefront_catalogue');
const item = async (code) => (await catalogue()).find((s) => s.code === code);

// What the Edge Function does for action "place", minus HTTP.
async function place(body) {
  const v = validatePlaceRequest(body);
  if (!v.ok) return { http: 400, error: 'invalid', fields: v.errors };
  const q = await rpc(db, 'service', 'storefront_quote', { p_lines: v.value.lines, p_event_id: v.value.idempotency_key, p_phone: v.value.customer.phone });
  if (!q.already_placed) {
    if (q.problems.length) return { http: 409, error: 'sold_out', problems: q.problems };
    if (Math.abs(totalsFor(q).total - v.value.expected_total) > 0.005) return { http: 409, error: 'price_changed', ...totalsFor(q) };
  }
  const r = await rpc(db, 'service', 'ingest_order', { p_source: 'storefront', p_event_id: v.value.idempotency_key,
    p_payload: buildIngestPayload(v.value, q.already_placed ? { subtotal: 0 } : q) });
  return { http: r.ok ? 200 : 422, ...r };
}

const shopper = (lines, extra = {}) => ({
  action: 'place', idempotency_key: randomUUID(), lines,
  customer: { name: 'Ananya Rao', phone: '+91 98480 12345', email: 'Ananya@Example.com', marketing_consent: true },
  address: { address1: '12, Banjara Hills Road 3', address2: 'Near the park', city: 'Hyderabad', state: 'telangana', pincode: '500034' },
  notes: 'Call before delivery', website: '', ...extra,
});

console.log('\nStorefront — tests\n');

await test('Catalogue: the publishable (anon) key can read it; prices come from the WEB price list', async () => {
  const c = await catalogue();
  const cookies = c.find((s) => s.code === 'MT-000001');
  assert.equal(cookies.brand, 'Mia Torte');
  assert.equal(cookies.category, 'Cookies');
  assert.equal(Number(cookies.mrp), 250);
  assert.equal(Number(cookies.price), 225);
  assert.equal(Number(cookies.pack_size), 200);
  assert.equal(cookies.pack_unit, 'g');
  assert.equal(Number(c.find((s) => s.code === 'NS-000001').price), 110);
  assert.equal(Number(c.find((s) => s.code === 'NS-000002').price), 520);
});

await test('Catalogue exposes no cost, batch, stock-level or internal fields', async () => {
  const allowed = ['code', 'name', 'product', 'brand', 'brand_code', 'category', 'pack_size', 'pack_unit', 'pack_grams',
    'mrp', 'price', 'availability', 'only_left', 'max_qty', 'details'];
  for (const s of await catalogue()) {
    for (const k of Object.keys(s)) assert.ok(allowed.includes(k), `unexpected field ${k}`);
  }
});

await test('Availability: in_stock / low (≤ reorder level) / sold_out; a number only when ≤ 5 left', async () => {
  // NS-000002 (reorder level 5): bring ATP down to exactly 4 with a staff adjustment
  const a5 = await atp('NS-000002');
  const sku5 = await one(`select id from skus where code = 'NS-000002'`);
  const batch = await one(`select batch_id from stock_balances where sku_id = $1 and status = 'available' and location_id = default_location_id() order by qty desc limit 1`, [sku5.id]);
  await rpc(db, 'admin', 'adjust_stock', { p_sku_id: sku5.id, p_batch_id: batch.batch_id,
    p_location_id: (await one(`select default_location_id() id`)).id, p_qty_delta: 4 - a5, p_reason: 'test: low stock' });
  assert.equal(await atp('NS-000002'), 4);
  const low = await item('NS-000002');
  assert.equal(low.availability, 'low');
  assert.equal(low.only_left, 4);
  assert.equal(low.max_qty, 4);

  const cookies = await item('MT-000001');
  assert.equal(cookies.availability, 'in_stock');
  assert.equal(cookies.only_left, null);
  assert.equal(cookies.max_qty, 20);

  await db.query(`update skus set reorder_level = 0 where code = 'NS-000002'`);
  assert.equal((await item('NS-000002')).availability, 'in_stock', 'above reorder level');
  assert.equal((await item('NS-000002')).only_left, 4, 'number still shown at ≤ 5');
  await db.query(`update skus set reorder_level = 5 where code = 'NS-000002'`);
});

await test('Inactive or unpriced SKUs are hidden; a new SKU with a WEB price appears automatically', async () => {
  const brands = (await rpc(db, 'admin', 'get_reference_data')).brands;
  await rpc(db, 'admin', 'create_product_sku', { p: { brand_id: brands.find((b) => b.code === 'MT').id, product_name: 'Fudge Brownies',
    sku_name: 'Fudge Brownies 6 pcs', pack_size: 6, pack_unit: 'pcs', mrp: 420, website_price: 399, reorder_level: 4 } });
  const fresh = (await catalogue()).find((s) => s.name === 'Fudge Brownies 6 pcs');
  assert.ok(fresh, 'new SKU listed');
  assert.equal(fresh.availability, 'sold_out');
  assert.equal(fresh.max_qty, 0);
  await db.query(`update skus set active = false where code = $1`, [fresh.code]);
  assert.equal((await catalogue()).some((s) => s.code === fresh.code), false);
});

await test('The anon key still cannot touch tables, ingest_order or storefront_quote', async () => {
  await rejects(rpc(db, 'anon', 'ingest_order', { p_source: 'storefront', p_event_id: 'x', p_payload: {} }), /permission denied/);
  await rejects(rpc(db, 'anon', 'storefront_quote', { p_lines: [] }), /permission denied/);
  await rejects(rpc(db, 'anon', 'list_skus'), /permission denied/);
  await rejects(db.transaction(async (tx) => { await tx.exec('set local role anon'); await tx.query('select * from skus'); }), /permission denied/);
  await rejects(rpc(db, 'packer', 'storefront_quote', { p_lines: [] }), /permission denied/);
});

await test('Edge Function validation: lines, quantities, phone, PIN code, email, state, honeypot', async () => {
  assert.equal(normalisePhone('+91 98480-12345'), '+919848012345');
  assert.equal(normalisePhone('09848012345'), '+919848012345');
  assert.equal(normalisePhone('919848012345'), '+919848012345');
  assert.equal(normalisePhone('5848012345'), null, 'Indian mobiles start 6–9');
  assert.equal(normalisePhone('98480 1234'), null);
  assert.equal(validatePlaceRequest(shopper([{ sku_code: 'MT-000001', qty: 1 }], { expected_total: 285 })).ok, true);

  const bad = validatePlaceRequest({ ...shopper([{ sku_code: 'MT-000001', qty: 21 }, { sku_code: 'MT-000001', qty: 0 }]),
    customer: { name: 'A', phone: '12345', email: 'nope' }, address: { address1: 'x', city: '', state: 'Atlantis', pincode: '012345' } });
  assert.equal(bad.ok, false);
  for (const f of ['lines.0.qty', 'lines.1.sku_code', 'lines.1.qty', 'customer.name', 'customer.phone', 'customer.email',
    'address.address1', 'address.city', 'address.state', 'address.pincode', 'expected_total']) assert.ok(f in bad.errors, f);

  const many = Array.from({ length: MAX_LINES + 1 }, (_, i) => ({ sku_code: `MT-${String(i + 1).padStart(6, '0')}`, qty: 1 }));
  assert.equal(validateLines(many).ok, false);
  assert.equal(validateLines([{ sku_code: 'MT-000001', qty: 1.5 }]).ok, false);
  assert.equal(validatePlaceRequest(shopper([{ sku_code: 'MT-000001', qty: 1 }], { expected_total: 285, website: 'http://spam' })).ok, false);
  assert.equal(validatePlaceRequest(shopper([{ sku_code: 'MT-000001', qty: 1 }], { expected_total: 285, idempotency_key: 'abc' })).ok, false);
});

await test('Shipping rule: flat ₹60, free above ₹999; external order id is deterministic', async () => {
  assert.equal(SHIPPING_FLAT, 60);
  assert.equal(FREE_SHIPPING_ABOVE, 999);
  assert.equal(shippingFor(225), 60);
  assert.equal(shippingFor(999), 60);
  assert.equal(shippingFor(1000), 0);
  const k = '3f1c2a9e-1b2c-4d3e-9f00-123456789abc';
  assert.equal(externalOrderIdFor(k), 'SF-3F1C2A9E1B2C');
  assert.equal(externalOrderIdFor(k), externalOrderIdFor(k));
});

let placed, body;
await test('Place order (COD): confirmed straight into the Pack queue with the right customer, lines and total', async () => {
  const before = await atp('MT-000001');
  body = shopper([{ sku_code: 'MT-000001', qty: 2 }, { sku_code: 'NS-000001', qty: 1 }], { expected_total: 2 * 225 + 110 + 60 });
  placed = await place(body);
  assert.equal(placed.http, 200, placed.error);
  assert.equal(placed.ok, true);
  assert.match(placed.order_code, /^ORD-\d{4}-\d{6}$/);
  assert.equal(placed.stock_reserved, true);
  const o = await rpc(db, 'admin', 'get_order', { p_order_id: placed.order_id });
  assert.equal(o.status, 'confirmed');
  assert.equal(o.payment_status, 'cod_pending');
  assert.equal(o.packable, true);
  assert.equal(o.external_source, 'storefront');
  assert.equal(o.external_order_id, externalOrderIdFor(body.idempotency_key));
  assert.equal(o.customer.name, 'Ananya Rao');
  assert.equal(o.customer.email, 'ananya@example.com');
  assert.equal(o.ship_to.state, 'Telangana');
  assert.equal(o.ship_to.pincode, '500034');
  assert.deepEqual(o.lines.map((l) => [l.sku_code, Number(l.qty), Number(l.unit_price)]), [['MT-000001', 2, 225], ['NS-000001', 1, 110]]);
  assert.equal(Number(o.shipping_amount), 60);
  assert.equal(Number(o.total_amount), 620);
  assert.equal(await atp('MT-000001'), before - 2);
  const toPack = await rpc(db, 'packer', 'list_orders', { p_filter: 'to_pack' });
  assert.ok(toPack.some((x) => x.code === placed.order_code), 'in the Pack queue');
  const consent = await one(`select granted from customer_consents cc join customers c on c.id = cc.customer_id where c.email_norm = 'ananya@example.com'`);
  assert.equal(consent.granted, true);
  // No founder total-mismatch alert: the storefront total equals the database's total
  const d = await rpc(db, 'admin', 'get_dashboard');
  assert.equal(d.alerts.some((a) => a.type === 'total_mismatch' && a.title.startsWith(placed.order_code)), false);
});

await test('Retried submit (same idempotency key) returns the same order: no duplicate order or reservation', async () => {
  const atpBefore = await atp('MT-000001');
  const again = await place(body);
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.order_code, placed.order_code);
  assert.equal(await atp('MT-000001'), atpBefore);
  const n = await one(`select count(*)::int n from orders where external_source = 'storefront'`);
  assert.equal(n.n, 1);
});

await test('Free delivery above ₹999 is applied and cross-checks with the database total', async () => {
  const r = await place(shopper([{ sku_code: 'MT-000001', qty: 5 }], { expected_total: 1125 }));
  assert.equal(r.ok, true, r.error);
  const o = await rpc(db, 'admin', 'get_order', { p_order_id: r.order_id });
  assert.equal(Number(o.shipping_amount), 0);
  assert.equal(Number(o.total_amount), 1125);
});

await test('Sold out / not enough stock: rejected before an order is created, with what is left', async () => {
  const left = await atp('NS-000002');
  const before = await one(`select count(*)::int n from orders`);
  const r = await place(shopper([{ sku_code: 'NS-000002', qty: left + 1 }], { expected_total: (left + 1) * 520 + 0 }));
  assert.equal(r.http, 409);
  assert.equal(r.error, 'sold_out');
  assert.equal(r.problems[0].sku_code, 'NS-000002');
  assert.equal(r.problems[0].reason, 'insufficient');
  assert.equal(r.problems[0].available, left);
  assert.equal((await one(`select count(*)::int n from orders`)).n, before.n);
});

await test('Price changed since the shopper saw it: rejected with the new total', async () => {
  const r = await place(shopper([{ sku_code: 'NS-000001', qty: 1 }], { expected_total: 100 }));
  assert.equal(r.http, 409);
  assert.equal(r.error, 'price_changed');
  assert.equal(r.total, 170);
});

await test('Quote flags unknown SKUs and counts recent orders for a phone (abuse guard)', async () => {
  const q = await rpc(db, 'service', 'storefront_quote', { p_lines: [{ sku_code: 'MT-999999', qty: 1 }, { sku_code: 'NS-000001', qty: 2 }], p_phone: '9848012345' });
  assert.equal(q.problems[0].reason, 'unavailable');
  assert.equal(Number(q.subtotal), 220);
  assert.equal(q.recent_orders_for_phone, 2);
});

await test('Order tracking: code + phone gives status and items only; wrong phone reveals nothing', async () => {
  const s = await rpc(db, 'anon', 'storefront_order_status', { p_order_code: placed.order_code.toLowerCase(), p_phone: '98480 12345' });
  assert.equal(s.found, true);
  assert.equal(s.status, 'confirmed');
  assert.deepEqual(s.items.map((i) => [i.sku_code, Number(i.qty)]), [['MT-000001', 2], ['NS-000001', 1]]);
  for (const k of Object.keys(s)) assert.ok(['found', 'code', 'status', 'placed_on', 'items'].includes(k), `unexpected ${k}`);
  assert.deepEqual(await rpc(db, 'anon', 'storefront_order_status', { p_order_code: placed.order_code, p_phone: '9000000000' }), { found: false });
  assert.deepEqual(await rpc(db, 'anon', 'storefront_order_status', { p_order_code: 'ORD-1999-000001', p_phone: '9848012345' }), { found: false });
  assert.deepEqual(await rpc(db, 'anon', 'storefront_order_status', { p_order_code: placed.order_code, p_phone: '' }), { found: false });
});

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
