// The product catalogue import (supabase/data/2026-11-12_product_catalogue.sql)
// on a database that already has the pilot samples, orders and books.
//   npm run test:catalogue
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootDb, rpc } from './harness.mjs';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
const n2 = (v) => Math.round(Number(v) * 100) / 100;
async function rejects(promise, pattern) {
  try { await promise; } catch (e) {
    if (pattern && !pattern.test(e.message)) throw new Error(`Expected ${pattern}, got: ${e.message}`);
    return;
  }
  throw new Error(`Expected an error matching ${pattern}`);
}
const db = await bootDb();
const script = readFileSync(new URL('../supabase/data/2026-11-12_product_catalogue.sql', import.meta.url), 'utf8');
const before = await rpc(db, 'admin', 'trial_balance');

console.log('\nTorte Living OS — product catalogue import\n');

await test('Loads all 60 products with codes, barcodes, MRP and website prices', async () => {
  await db.exec(script);
  const list = await rpc(db, 'admin', 'inv_stock_list');
  const real = list.filter((x) => !x.is_test && x.item_type === 'finished');
  assert.equal(real.length, 60);
  assert.equal(real.filter((x) => x.brand_code === 'NS').length, 17);
  assert.equal(real.filter((x) => x.brand_code === 'MT').length, 43);
  for (const x of real) {
    assert.ok(/^\d{13}$/.test(x.barcode), `${x.name} barcode`);
    assert.ok(Number(x.mrp) > 0 && Number(x.web_price) > 0, `${x.name} prices`);
    assert.ok(Number(x.web_price) <= Number(x.mrp), `${x.name}: website price above MRP`);
  }
  const muesli = real.find((x) => x.name === 'Fruit & Nut Muesli 250 g Pouch');
  assert.deepEqual([Number(muesli.mrp), Number(muesli.web_price), muesli.category], [290, 290, 'Muesli']);
  const ragi = real.find((x) => x.name === 'Ragi Flour 1 kg');
  assert.deepEqual([Number(ragi.mrp), Number(ragi.web_price), ragi.brand_code, Number(ragi.pack_size), ragi.unit], [200, 180, 'NS', 1, 'kg']);
  const s = await db.query(`select get_price(id, 'WEB_STRATEGIC') p from skus where name = 'Fruit & Nut Muesli 250 g Pouch'`);
  assert.equal(Number(s.rows[0].p), 285, 'strategic price kept separately');
});

await test('Running it again changes nothing', async () => {
  const count = async () => Number((await db.query(`select (select count(*) from skus) + (select count(*) from products) * 1000
    + (select count(*) from price_list_items) * 100000 n`)).rows[0].n);
  const a = await count();
  await db.exec(script);
  assert.equal(await count(), a);
});

await test('The shop lists the 60 real products and none of the test ones', async () => {
  const cat = await rpc(db, 'anon', 'storefront_catalogue');
  assert.equal(cat.length, 60);
  assert.ok(!cat.some((x) => x.name.startsWith('TEST')));
  const cookie = cat.find((x) => x.name === 'Biscoff Indulgence 70 g');
  assert.deepEqual([cookie.brand_code, cookie.category, Number(cookie.price), Number(cookie.mrp)], ['MT', 'Cookies', 190, 200]);
});

await test('Pilot samples are kept for testing, marked TEST, with their history', async () => {
  const tests = (await rpc(db, 'admin', 'inv_stock_list')).filter((x) => x.is_test);
  assert.deepEqual(tests.map((x) => x.name).sort(), ['TEST · Chocolate Chip Cookies 200 g', 'TEST · Multigrain Atta 1 kg', 'TEST · Multigrain Atta 5 kg']);
  assert.equal(tests.find((x) => x.code === 'MT-000001').on_shelf, 46, 'stock untouched');
  const orders = await rpc(db, 'admin', 'list_orders', { p_filter: 'all' });
  assert.equal(orders.length, 10, 'test orders kept');
});

await test('GST: current rates are 5% (indicative) and every product has one; the books are untouched', async () => {
  const r = await db.query(`select count(*) n from products p join tax_rates t on t.id = p.tax_rate_id
     where p.item_type = 'finished' and (t.effective_to is not null or t.gst_rate <> 5)`);
  assert.equal(Number(r.rows[0].n), 0);
  const after = await rpc(db, 'admin', 'trial_balance');
  assert.equal(n2(after.total_debit), n2(before.total_debit));
  assert.equal(n2(after.total_debit), n2(after.total_credit));
});

await test('Orders for the new products go through at 5% GST and wait for stock until some is made', async () => {
  const r = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'cat-1', p_payload: {
    external_order_id: 'CAT1', customer: { name: 'Test buyer', phone: '9000000099' }, ship_to: { state: 'Telangana', city: 'Hyderabad' },
    lines: [{ sku_code: (await db.query(`select code from skus where name = 'Ragi Flour 1 kg'`)).rows[0].code, qty: 2, unit_price: 180 }],
    payment: { status: 'unpaid' } } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const o = await rpc(db, 'admin', 'get_order', { p_order_id: r.order_id });
  assert.equal(Number(o.lines[0].tax_rate), 5);
  assert.equal(o.stock_shortfall, true, 'no stock yet, so it waits');
});

// ---------------------------------------------------------------------
// A real product, start to finish
// ---------------------------------------------------------------------
const id = async (name) => (await db.query(`select id, code, product_id from skus where name = $1`, [name])).rows[0];
let MUESLI, ORDER;
await test('A manager fills in shelf life and label information; confirming needs ingredients and the veg mark', async () => {
  MUESLI = await id('Fruit & Nut Muesli 250 g Pouch');
  await rejects(rpc(db, 'admin', 'update_product', { p_product_id: MUESLI.product_id, p: { content_confirmed: true } }), /ingredients and veg mark/);
  await rejects(rpc(db, 'packer', 'update_product', { p_product_id: MUESLI.product_id, p: { shelf_life_days: 120 } }), /not allowed/);
  await rejects(rpc(db, 'admin', 'update_product', { p_product_id: MUESLI.product_id, p: { nutrition: { energy_kcal: 'lots' } } }), /must be a number/);
  const d = await rpc(db, 'admin', 'update_product', { p_product_id: MUESLI.product_id, p: {
    shelf_life_days: 120, ingredients: 'Rolled oats, mixed nuts, raisins, honey', allergens: 'Contains nuts. May contain gluten.',
    diet: 'veg', storage: 'Store in a cool, dry place. Keep sealed.', nutrition: { energy_kcal: '410', protein_g: 11.5, junk: 3 } } });
  assert.deepEqual(d.nutrition, { energy_kcal: 410, protein_g: 11.5 }, 'unknown keys dropped, numbers cleaned');
  const c = await rpc(db, 'admin', 'update_product', { p_product_id: MUESLI.product_id, p: { content_confirmed: true } });
  assert.equal(c.content_confirmed, true);
  await rpc(db, 'admin', 'update_sku', { p_sku_id: MUESLI.id, p: { reorder_level: 5 } });
  await rejects(rpc(db, 'warehouse', 'update_sku', { p_sku_id: MUESLI.id, p: { mrp: 999 } }), /not allowed/);
  const shop = (await rpc(db, 'anon', 'storefront_catalogue')).find((x) => x.code === MUESLI.code);
  assert.equal(shop.details.diet, 'veg');
  assert.equal(shop.details.confirmed, true);
  assert.equal(shop.details.shelf_life_days, 120);
});

await test('Raw materials are bought and received; the recipe is saved', async () => {
  const mats = {};
  for (const [name, type, unit] of [['Rolled oats', 'raw_material', 'kg'], ['Mixed nuts', 'raw_material', 'kg'],
    ['Honey', 'raw_material', 'kg'], ['Muesli pouch 250 g', 'packaging', 'pcs']]) {
    mats[name] = (await rpc(db, 'admin', 'create_material', { p: { name, item_type: type, unit, shelf_life_days: 180 } })).sku_id;
  }
  const sup = await rpc(db, 'admin', 'create_partner', { p: { legal_name: 'Grain House Pvt Ltd', roles: ['supplier'], state: 'Telangana' } });
  await rpc(db, 'admin', 'create_purchase_order', { p: { supplier_id: sup.partner_id, lines: [
    { sku_id: mats['Rolled oats'], qty: 10, unit_price: 90, gst_rate: 5 }, { sku_id: mats['Mixed nuts'], qty: 4, unit_price: 800, gst_rate: 5 },
    { sku_id: mats['Honey'], qty: 2, unit_price: 400, gst_rate: 5 }, { sku_id: mats['Muesli pouch 250 g'], qty: 100, unit_price: 4, gst_rate: 18 }] } });
  for (const m of Object.values(mats)) {
    const it = await rpc(db, 'warehouse', 'inv_item', { p_sku_id: m });
    await rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: m, qty: it.incoming[0].remaining, source: 'po', po_line_id: it.incoming[0].po_line_id } });
  }
  await rpc(db, 'admin', 'save_recipe', { p: { sku_id: MUESLI.id, output_qty: 10, lines: [
    { material_sku_id: mats['Rolled oats'], qty: 1.6, wastage_pct: 2 }, { material_sku_id: mats['Mixed nuts'], qty: 0.6 },
    { material_sku_id: mats['Honey'], qty: 0.3 }, { material_sku_id: mats['Muesli pouch 250 g'], qty: 10 }] } });
});

await test('A website order waits for stock, is made, packed, dispatched and invoiced at 5% GST', async () => {
  const r = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'cat-muesli', p_payload: {
    external_order_id: 'CATM1', customer: { name: 'Meera Iyer', phone: '9000000077' },
    ship_to: { name: 'Meera Iyer', phone: '9000000077', address1: 'Plot 7', city: 'Hyderabad', state: 'Telangana', pincode: '500081' },
    lines: [{ sku_code: MUESLI.code, qty: 2, unit_price: 290 }], shipping_amount: 0,
    payment: { status: 'paid', method: 'upi', gateway: 'razorpay', gateway_ref: 'pay_CATM1' } } });
  ORDER = r.order_id;
  assert.equal((await rpc(db, 'admin', 'get_order', { p_order_id: ORDER })).stock_shortfall, true);
  const made = await rpc(db, 'warehouse', 'inv_stock_in', { p: { sku_id: MUESLI.id, qty: 10, source: 'kitchen' } });
  assert.equal(made.route, 'production', 'made from the recipe, materials consumed');
  const cost = (await db.query(`select unit_cost, expires_on - manufactured_on life from batches where id = $1`, [made.batch.id])).rows[0];
  assert.equal(Number(cost.life), 120, 'expiry from the shelf life set in the app');
  assert.ok(Number(cost.unit_cost) > 0, 'batch is costed');
  let o = await rpc(db, 'admin', 'get_order', { p_order_id: ORDER });
  assert.equal(o.stock_shortfall, false, 'reserved automatically once made');
  await rpc(db, 'packer', 'pack_scan', { p_order_id: ORDER, p_code: made.batch.code });
  o = (await rpc(db, 'packer', 'pack_scan', { p_order_id: ORDER, p_code: made.batch.code })).order;
  assert.equal(o.lines[0].scanned, 2);
  await rpc(db, 'packer', 'complete_packing', { p_order_id: ORDER, p_idempotency_key: 'pack:cat' });
  await rpc(db, 'packer', 'dispatch_order', { p_order_id: ORDER, p_provider_code: 'OWN', p_idempotency_key: 'disp:cat' });
  const inv = await rpc(db, 'admin', 'invoice_for_order', { p_order_id: ORDER });
  assert.ok(inv, 'invoice issued');
  assert.equal(Number(inv.total), 580);
  assert.equal(n2(inv.taxable_value), 552.38, '580 incl. 5% GST');
  assert.equal(n2(Number(inv.cgst) + Number(inv.sgst)), 27.62);
  assert.equal(Number(inv.lines[0].rate), 5);
  const tb = await rpc(db, 'admin', 'trial_balance');
  assert.equal(n2(tb.total_debit), n2(tb.total_credit));
  const iv = await rpc(db, 'admin', 'inventory_valuation');
  for (const x of iv.by_type) assert.equal(n2(x.difference), 0, `inventory ${x.account}`);
});

await test('A product with history cannot switch brand; an unused one can', async () => {
  await rejects(rpc(db, 'admin', 'update_product', { p_product_id: MUESLI.product_id, p: { brand_id: (await db.query(`select id from brands where code = 'NS'`)).rows[0].id } }), /can't change/);
  const chips = await id('Peri Peri Vegie Chips 90 g Pouch');
  const ns = (await db.query(`select id from brands where code = 'NS'`)).rows[0].id;
  const d = await rpc(db, 'admin', 'update_product', { p_product_id: chips.product_id, p: { brand_id: ns } });
  assert.equal(d.brand_id, ns);
});

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
