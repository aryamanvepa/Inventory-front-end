// "Notify me when available": the website can add requests (with consent),
// never read them; managers see and clear them; the dashboard flags
// products back in stock with people waiting.
//   npm run test:notify
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

const db = await bootDb();
const sku = async (name) => (await db.query(`select id, code from skus where name = $1`, [name])).rows[0];
// a product with no stock, sold on the website
await db.exec(`insert into products (brand_id, name) select id, 'Ragi Flour' from brands where code = 'NS';
  insert into skus (product_id, name, pack_size, pack_unit, mrp) select id, 'Ragi Flour 1 kg', 1, 'kg', 200 from products where name = 'Ragi Flour';
  insert into price_list_items (price_list_id, sku_id, price) select pl.id, s.id, 180 from price_lists pl, skus s where pl.code = 'WEB' and s.name = 'Ragi Flour 1 kg';`);
const RAGI = await sku('Ragi Flour 1 kg');

console.log('\nTorte Living OS — back-in-stock alerts\n');

await test('A shopper can ask to be notified — only with consent and a valid email', async () => {
  assert.deepEqual(await rpc(db, 'anon', 'storefront_notify_me', { p_sku_code: RAGI.code, p_email: 'meera@example.com', p_consent: false }),
    { ok: false, error: 'consent_required' });
  assert.equal((await rpc(db, 'anon', 'storefront_notify_me', { p_sku_code: RAGI.code, p_email: 'not-an-email', p_consent: true })).error, 'invalid_email');
  assert.equal((await rpc(db, 'anon', 'storefront_notify_me', { p_sku_code: 'NOPE-1', p_email: 'a@b.co', p_consent: true })).error, 'unknown_product');
  const r = await rpc(db, 'anon', 'storefront_notify_me', { p_sku_code: RAGI.code, p_email: ' Meera@Example.com ', p_consent: true, p_name: 'Meera' });
  assert.deepEqual(r, { ok: true });
});

await test('Asking twice keeps one request, and the answer is the same (the list cannot be probed)', async () => {
  const r = await rpc(db, 'anon', 'storefront_notify_me', { p_sku_code: RAGI.code, p_email: 'meera@example.com', p_consent: true });
  assert.deepEqual(r, { ok: true });
  const n = await db.query(`select count(*) n from stock_alert_requests where email = 'meera@example.com'`);
  assert.equal(Number(n.rows[0].n), 1);
  await rpc(db, 'anon', 'storefront_notify_me', { p_sku_code: RAGI.code, p_email: 'ravi@example.com', p_consent: true });
});

await test('Materials and products not on the website cannot be requested', async () => {
  const mat = await rpc(db, 'admin', 'create_material', { p: { name: 'Ragi grain', item_type: 'raw_material', unit: 'kg' } });
  assert.equal((await rpc(db, 'anon', 'storefront_notify_me', { p_sku_code: mat.sku_code, p_email: 'x@y.co', p_consent: true })).error, 'unknown_product');
});

await test('The public key cannot read the list or call staff functions; staff tables are hidden', async () => {
  await rejects(rpc(db, 'anon', 'list_stock_alerts'), /permission denied/);
  await rejects(rpc(db, 'anon', 'mark_stock_alerts_notified', { p_sku_id: RAGI.id }), /permission denied/);
  await rejects(db.transaction(async (tx) => { await tx.exec('set local role anon'); await tx.query('select * from stock_alert_requests'); }), /permission denied/);
  await rejects(rpc(db, 'packer', 'list_stock_alerts'), /not allowed/);
  const rows = await sqlAs(db, 'warehouse', 'select * from stock_alert_requests');
  assert.equal(rows.length, 0, 'RLS hides the table from staff too');
});

await test('Managers see who is waiting; the dashboard flags it once the product is back in stock', async () => {
  const list = await rpc(db, 'admin', 'list_stock_alerts');
  assert.equal(list.length, 1);
  assert.equal(list[0].waiting, 2);
  assert.equal(list[0].in_stock, false);
  assert.deepEqual(list[0].people.map((p) => p.email), ['meera@example.com', 'ravi@example.com']);
  let d = await rpc(db, 'admin', 'get_dashboard', { p_days: 30 });
  assert.ok(!d.alerts.some((a) => a.type === 'stock_alert'), 'not while sold out');
  await rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: RAGI.id, qty: 0 + 1, source: 'kitchen' } })
    .catch(async () => {   // no shelf life or recipe: receive a dated batch directly
      const b = await rpc(db, 'admin', 'create_batch', { p: { sku_id: RAGI.id, expires_on: '2027-06-30', unit_cost: 120 } });
      const ref = await rpc(db, 'admin', 'get_reference_data');
      await rpc(db, 'admin', 'receive_stock', { p_sku_id: RAGI.id, p_batch_id: b.batch_id, p_location_id: ref.locations.find((l) => l.is_default).id, p_qty: 10, p_source: 'production' });
    });
  d = await rpc(db, 'admin', 'get_dashboard', { p_days: 30 });
  const a = d.alerts.find((x) => x.type === 'stock_alert');
  assert.match(a.title, /Ragi Flour 1 kg is back in stock — 2 customers waiting/);
  assert.equal((await rpc(db, 'admin', 'list_stock_alerts'))[0].in_stock, true);
});

await test('Marking notified clears the list and the alert; a new request after that starts fresh', async () => {
  await rejects(rpc(db, 'warehouse', 'mark_stock_alerts_notified', { p_sku_id: RAGI.id }), /not allowed/);
  assert.equal((await rpc(db, 'admin', 'mark_stock_alerts_notified', { p_sku_id: RAGI.id })).notified, 2);
  assert.equal((await rpc(db, 'admin', 'list_stock_alerts')).length, 0);
  const d = await rpc(db, 'admin', 'get_dashboard', { p_days: 30 });
  assert.ok(!d.alerts.some((x) => x.type === 'stock_alert'));
  assert.deepEqual(await rpc(db, 'anon', 'storefront_notify_me', { p_sku_code: RAGI.code, p_email: 'meera@example.com', p_consent: true }), { ok: true });
  assert.equal((await rpc(db, 'admin', 'list_stock_alerts'))[0].waiting, 1);
});

await test('An email can be erased on request', async () => {
  assert.equal((await rpc(db, 'admin', 'erase_stock_alert_email', { p_email: 'MEERA@example.com' })).erased, 2);
  const n = await db.query(`select count(*) n from stock_alert_requests where email = 'meera@example.com'`);
  assert.equal(Number(n.rows[0].n), 0);
});

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
