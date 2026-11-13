// Storefront back end round 2 (website brief): test orders, order tracking,
// catalogue extras, product photos, PIN-code delivery, promo codes,
// customer cancellations, failure logging, and the Stage 3 checks.
//   npm run test:storefront2
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootDb, rpc } from './harness.mjs';
import { validatePlaceRequest, decidePlace, totalsFor } from '../supabase/functions/storefront-order/logic.ts';

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
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];

// The Edge Function's quote + place, minus HTTP (same logic module).
async function quote(lines, extra = {}) {
  return rpc(db, 'service', 'storefront_quote', { p_lines: lines, ...extra });
}
async function place(body) {
  const v = validatePlaceRequest(body);
  if (!v.ok) return { http: 400, error: 'invalid', fields: v.errors };
  const o = v.value;
  const q = await rpc(db, 'service', 'storefront_quote', { p_lines: o.lines, p_event_id: o.idempotency_key, p_phone: o.customer.phone,
    p_pincode: o.address.pincode, p_promo_code: o.promo_code, p_test: o.test });
  const d = decidePlace(o, q);
  if (d.kind === 'reject') return { http: d.http, ...d.body };
  const r = await rpc(db, 'service', 'storefront_place_order', { p_source: d.source, p_event_id: o.idempotency_key, p_payload: d.payload, p_require_stock: !o.test });
  if (r.error === 'sold_out') return { http: 409, ...r };
  if (r.ok && !r.duplicate && d.redeemPromo) await rpc(db, 'service', 'storefront_redeem_promo', { p_code: d.redeemPromo });
  return { http: r.ok ? 200 : 422, ...r, test: o.test || undefined };
}
async function expectedTotal(lines, extra = {}) { return totalsFor(await quote(lines, extra)).total; }
const shopper = async (lines, extra = {}) => ({
  action: 'place', idempotency_key: randomUUID(), lines,
  customer: { name: 'Ananya Rao', phone: '+91 98480 12345', email: 'ananya@example.com', marketing_consent: false },
  address: { address1: '12, Banjara Hills Road 3', address2: '', city: 'Hyderabad', state: 'Telangana', pincode: '500034' },
  notes: '', website: '', expected_total: await expectedTotal(lines, { p_promo_code: extra.promo_code ?? null }), ...extra,
});
const status = (code, phone = '9848012345') => rpc(db, 'anon', 'storefront_order_status', { p_order_code: code, p_phone: phone });
const atp = async (code) => Number((await rpc(db, 'admin', 'list_skus', { p_search: code }))[0].atp);

console.log('\nStorefront back end (round 2)\n');

// ------------------------------------------------------------------ B5
await test('B5 · PIN codes: Hyderabad local (Rapido, 0–1 days), rest of Telangana, rest of India, not serviceable', async () => {
  const d = (p) => one(`select storefront_delivery_for($1) d`, [p]).then((r) => r.d);
  assert.deepEqual(await d('500034'), { serviceable: true, zone: 'local', carrier: 'Rapido', eta_min_days: 0, eta_max_days: 1, message: 'Same or next day in Hyderabad' });
  assert.equal((await d('506001')).eta_max_days, 4);
  assert.equal((await d('560038')).carrier, 'iCarry');
  assert.equal((await d('560038')).eta_max_days, 7);
  assert.equal((await d('999001')).serviceable, false);
  assert.equal((await d('12345')).serviceable, false);
  const q = await quote([{ sku_code: 'NS-000001', qty: 1 }], { p_pincode: '500034' });
  assert.equal(q.delivery.zone, 'local');
  const r = await place(await shopper([{ sku_code: 'NS-000001', qty: 1 }], { address: { address1: 'Army post office 56', address2: '', city: 'APO', state: 'Delhi', pincode: '999001' } }));
  assert.equal(r.http, 422);
  assert.equal(r.error, 'unserviceable_pincode');
});

// ------------------------------------------------------------------ B6
await test('B6 · Promo codes: managers create them; quote applies percent/flat with caps, minimum, expiry and limits', async () => {
  await rejects(rpc(db, 'packer', 'save_promo_code', { p: { code: 'X1Y', kind: 'flat', value: 10 } }), /not allowed/);
  await rejects(rpc(db, 'admin', 'save_promo_code', { p: { code: 'bad code', kind: 'flat', value: 10 } }), /letters or numbers/);
  await rpc(db, 'admin', 'save_promo_code', { p: { code: 'WELCOME10', kind: 'percent', value: 10, max_discount: 25, description: 'First order' } });
  await rpc(db, 'admin', 'save_promo_code', { p: { code: 'FLAT50', kind: 'flat', value: 50, min_subtotal: 400, usage_limit: 1 } });
  await rpc(db, 'admin', 'save_promo_code', { p: { code: 'OLD', kind: 'flat', value: 20, starts_at: '2025-01-01', ends_at: '2025-02-01' } });
  let q = await quote([{ sku_code: 'NS-000001', qty: 2 }], { p_promo_code: 'welcome10' });   // ₹220
  assert.deepEqual([q.promo.valid, Number(q.promo.discount), Number(q.discount)], [true, 22, 22]);
  q = await quote([{ sku_code: 'NS-000002', qty: 1 }], { p_promo_code: 'WELCOME10' });          // ₹520 → capped at 25
  assert.equal(Number(q.discount), 25);
  q = await quote([{ sku_code: 'NS-000001', qty: 1 }], { p_promo_code: 'FLAT50' });
  assert.deepEqual([q.promo.valid, q.promo.error, Number(q.discount)], [false, 'promo_min_subtotal', 0]);
  assert.match(q.promo.message, /Add ₹290\.00 more/);
  assert.equal((await quote([{ sku_code: 'NS-000001', qty: 1 }], { p_promo_code: 'OLD' })).promo.error, 'promo_expired');
  assert.equal((await quote([{ sku_code: 'NS-000001', qty: 1 }], { p_promo_code: 'NOPE' })).promo.error, 'promo_invalid');
});

await test('B6 · A promo order stores the discount (total and GST invoice basis) and counts towards the usage limit', async () => {
  const lines = [{ sku_code: 'NS-000002', qty: 1 }];                    // ₹520 + ₹60 delivery
  const r = await place(await shopper(lines, { promo_code: 'FLAT50' }));
  assert.equal(r.http, 200, JSON.stringify(r));
  const o = await rpc(db, 'admin', 'get_order', { p_order_id: r.order_id });
  assert.deepEqual([Number(o.discount_amount), Number(o.total_amount)], [50, 530]);
  assert.match(o.notes ?? '', /Promo FLAT50/);
  assert.equal((await rpc(db, 'admin', 'list_promo_codes')).find((c) => c.code === 'FLAT50').used_count, 1);
  const again = await place(await shopper(lines, { promo_code: 'FLAT50' }));
  assert.deepEqual([again.http, again.error], [409, 'promo_invalid'], 'limit of 1 reached');
  await rpc(db, 'admin', 'set_promo_active', { p_code: 'WELCOME10', p_active: false });
  assert.equal((await quote(lines, { p_promo_code: 'WELCOME10' })).promo.valid, false);
  await rejects(rpc(db, 'anon', 'list_promo_codes'), /permission denied/);
});

// ------------------------------------------------------------------ B1
await test('B1 · Test orders: refused while testing mode is off; accepted while on, made to order, marked WEB-TEST', async () => {
  await rpc(db, 'admin', 'set_app_setting', { p_key: 'testing_mode', p_value: false });
  const big = [{ sku_code: 'NS-000002', qty: 20 }];                     // far more than in stock
  let r = await place(await shopper(big, { test: true }));
  assert.deepEqual([r.http, r.error], [403, 'test_mode_off']);
  await rpc(db, 'admin', 'set_app_setting', { p_key: 'testing_mode', p_value: true });
  const body = await shopper(big, { test: true });
  r = await place(body);
  assert.equal(r.http, 200, JSON.stringify(r));
  assert.equal(r.test, true);
  const o = await rpc(db, 'admin', 'get_order', { p_order_id: r.order_id });
  assert.equal(o.external_source, 'WEB-TEST');
  assert.equal(o.stock_shortfall, true, 'waits for stock to be made');
  assert.match(o.notes, /^TEST ORDER/);
  const dup = await place(body);                                        // a retry
  assert.equal(dup.duplicate, true);
  assert.equal(dup.order_code, r.order_code);
  r = await place(await shopper([{ sku_code: 'NS-999999', qty: 1 }], { test: true }));
  assert.deepEqual([r.http, r.error], [409, 'sold_out'], 'unknown products still block test orders');
});

// ------------------------------------------------------------------ B2
let ORDER;
await test('B2 · Tracking shows total, payment, timeline, shipment, cancellable and refund — only to the right phone', async () => {
  const r = await place(await shopper([{ sku_code: 'NS-000001', qty: 1 }]));
  ORDER = r;
  let s = await status(r.order_code);
  assert.deepEqual([s.found, s.payment_method, s.payment_status, s.cancellable, s.cancel_requested, s.shipment, s.refund],
    [true, 'cod', 'cod_pending', true, false, null, null]);
  assert.equal(Number(s.total), 170);
  assert.ok(s.timeline.placed_at && !s.timeline.packed_at);
  // pack and dispatch it, then look again
  const o = await rpc(db, 'admin', 'get_order', { p_order_id: r.order_id });
  const batch = (await rpc(db, 'packer', 'inv_item', { p_sku_id: o.lines[0].sku_id })).batches.find((b) => !b.expired);
  await rpc(db, 'packer', 'pack_scan', { p_order_id: r.order_id, p_code: batch.code });
  await rpc(db, 'packer', 'complete_packing', { p_order_id: r.order_id, p_idempotency_key: 'pk-' + r.order_id });
  await rpc(db, 'packer', 'dispatch_order', { p_order_id: r.order_id, p_provider_code: 'RAPIDO', p_booking_ref: 'RPD-123',
    p_tracking_url: 'https://track.example/RPD-123', p_idempotency_key: 'ds-' + r.order_id });
  s = await status(r.order_code);
  assert.equal(s.status, 'dispatched');
  assert.equal(s.cancellable, false);
  assert.deepEqual(s.shipment, { carrier: 'Rapido', booking_ref: 'RPD-123', tracking_url: 'https://track.example/RPD-123' });
  assert.ok(s.timeline.packed_at && s.timeline.dispatched_at);
  assert.deepEqual(await status(r.order_code, '9000000000'), { found: false });
});

// ------------------------------------------------------------------ B7
await test('B7 · Customer cancels before packing: order cancelled and stock released', async () => {
  const before = await atp('NS-000001');
  const r = await place(await shopper([{ sku_code: 'NS-000001', qty: 2 }]));
  assert.equal(await atp('NS-000001'), before - 2);
  assert.deepEqual(await rpc(db, 'anon', 'storefront_request_cancellation', { p_order_code: r.order_code, p_phone: '9000000000', p_reason: 'x' }),
    { ok: false, error: 'not_found' });
  const c = await rpc(db, 'anon', 'storefront_request_cancellation', { p_order_code: r.order_code, p_phone: '+91 98480 12345', p_reason: 'Ordered twice' });
  assert.deepEqual(c, { ok: true, result: 'cancelled' });
  assert.equal(await atp('NS-000001'), before, 'stock released');
  const o = await rpc(db, 'admin', 'get_order', { p_order_id: r.order_id });
  assert.equal(o.status, 'cancelled');
  assert.match(o.cancel_reason, /Cancelled by customer on the website: Ordered twice/);
  assert.equal((await rpc(db, 'anon', 'storefront_request_cancellation', { p_order_code: r.order_code, p_phone: '9848012345' })).error, 'already_cancelled');
});

await test('B7 · After dispatch the customer can only ask: recorded once, shown on tracking and the dashboard', async () => {
  const c = await rpc(db, 'anon', 'storefront_request_cancellation', { p_order_code: ORDER.order_code, p_phone: '9848012345', p_reason: 'Not home this week' });
  assert.deepEqual(c, { ok: true, result: 'requested' });
  await rpc(db, 'anon', 'storefront_request_cancellation', { p_order_code: ORDER.order_code, p_phone: '9848012345' });
  const o = await rpc(db, 'admin', 'get_order', { p_order_id: ORDER.order_id });
  assert.equal((o.notes.match(/\[Cancellation requested/g) ?? []).length, 1, 'recorded once');
  assert.equal((await status(ORDER.order_code)).cancel_requested, true);
  const d = await rpc(db, 'admin', 'get_dashboard', { p_days: 30 });
  assert.ok(d.alerts.some((a) => a.type === 'cancel_request' && a.title.startsWith(ORDER.order_code)));
  await rejects(rpc(db, 'anon', 'cancel_order_core', { p_order_id: ORDER.order_id, p_reason: 'x' }), /permission denied/);
  await rejects(rpc(db, 'packer', 'cancel_order', { p_order_id: ORDER.order_id, p_reason: 'x' }), /not allowed/);
});

// ------------------------------------------------------------------ B3 / B4 / B10
await test('B3/B4 · Catalogue: product_code, bestseller_rank (no tests or cancellations), is_new, photos in order', async () => {
  const cat = await rpc(db, 'anon', 'storefront_catalogue');
  const atta = cat.find((x) => x.code === 'NS-000001');
  assert.match(atta.product_code, /^PRD-/);
  assert.equal(typeof atta.is_new, 'boolean');
  assert.deepEqual(atta.images, []);
  assert.ok(cat.some((x) => x.bestseller_rank === 1), 'something ranks first');
  // photos: rows in storage.objects for this product code, ordered 1, 2, 10
  for (const n of [10, 2, 1]) await db.query(`insert into storage.objects (bucket_id, name) values ('product-images', $1)`, [`${atta.product_code}/${n}.jpg`]);
  const imgs = (await rpc(db, 'anon', 'storefront_catalogue')).find((x) => x.code === 'NS-000001').images;
  assert.deepEqual(imgs.map((u) => u.split('/').pop()), ['1.jpg', '2.jpg', '10.jpg']);
  assert.match(imgs[0], /^https:\/\/jizhfkithgkkyfymtlfd\.supabase\.co\/storage\/v1\/object\/public\/product-images\/PRD-/);
  const staff = await rpc(db, 'packer', 'list_product_images', { p_product_code: atta.product_code });
  assert.equal(staff.length, 3);
  assert.equal(staff[0].n, 1);
  const b = await one(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'product-images'`);
  assert.equal(b.public, true);
  assert.ok((await one(`select count(*) n from categories where name = 'Gifting'`)).n == 1);
});

// ------------------------------------------------------------------ B11 / Stage 3
await test('Stage 3 · Two shoppers, one last pack: only one order takes it; the other is refused before an order is made', async () => {
  const free = await atp('NS-000002');
  // bring free stock down to exactly 1
  if (free > 1) await place(await shopper([{ sku_code: 'NS-000002', qty: free - 1 }]));
  assert.equal(await atp('NS-000002'), 1);
  const a = await shopper([{ sku_code: 'NS-000002', qty: 1 }]);
  const b = await shopper([{ sku_code: 'NS-000002', qty: 1 }], { customer: { name: 'Vikram Shah', phone: '9900022222', email: 'v@example.com', marketing_consent: false } });
  const [ra, rb] = await Promise.all([place(a), place(b)]);
  const ok = [ra, rb].filter((r) => r.http === 200);
  assert.equal(ok.length, 1, JSON.stringify([ra, rb]));
  const lost = [ra, rb].find((r) => r.http !== 200);
  assert.equal(lost.error, 'sold_out');
  assert.equal(await atp('NS-000002'), 0, 'never oversold');
  // the winner cancels: stock comes back
  const winner = ok[0];
  await rpc(db, 'anon', 'storefront_request_cancellation', { p_order_code: winner.order_code, p_phone: winner === ra ? '9848012345' : '9900022222' });
  assert.equal(await atp('NS-000002'), 1, 'released on cancellation');
});

await test('Stage 3 · The same place sent twice (auto-retry) makes one order; stock running out mid-checkout is refused', async () => {
  const meera = { name: 'Meera Iyer', phone: '9000033333', email: 'm@example.com', marketing_consent: false };
  const body = await shopper([{ sku_code: 'NS-000002', qty: 1 }], { customer: meera });
  const [x, y] = await Promise.all([place(body), place(body)]);
  assert.ok(x.order_code && x.order_code === y.order_code, JSON.stringify([x, y]));
  const n = await one(`select count(*) n from orders where external_order_id = $1`, ['SF-' + body.idempotency_key.replace(/-/g, '').slice(0, 12).toUpperCase()]);
  assert.equal(Number(n.n), 1);
  assert.equal(await atp('NS-000002'), 0);
  // a shopper who quoted earlier now tries to place: rejected with what's left
  const late = await place(await shopper([{ sku_code: 'NS-000001', qty: 1 }], { lines: [{ sku_code: 'NS-000002', qty: 1 }], customer: meera }));
  assert.deepEqual([late.http, late.error], [409, 'sold_out']);
});

await test('B11 · Checkout failures are logged; 3 in an hour raise a dashboard alert; the website cannot write the log', async () => {
  for (let i = 0; i < 3; i++) await rpc(db, 'service', 'storefront_log_failure', { p_key: 'k' + i, p_stage: 'place', p_error: 'boom', p_detail: {} });
  const d = await rpc(db, 'admin', 'get_dashboard', { p_days: 30 });
  assert.ok(d.alerts.some((a) => a.type === 'checkout_failures' && /3 website checkout failures/.test(a.title)));
  await rejects(rpc(db, 'anon', 'storefront_log_failure', { p_key: 'x', p_stage: 'x', p_error: 'x' }), /permission denied/);
  await rejects(rpc(db, 'anon', 'storefront_quote', { p_lines: [] }), /permission denied/);
  await rejects(rpc(db, 'anon', 'storefront_redeem_promo', { p_code: 'FLAT50' }), /permission denied/);
});

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
