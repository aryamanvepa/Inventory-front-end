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

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
