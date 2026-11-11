// Finance layer acceptance tests: materials, purchasing, BOM/production,
// GST invoices & credit notes, double-entry ledger, reports and MIS.
//   npm run test:finance
import assert from 'node:assert/strict';
import { bootDb, rpc, USERS } from './harness.mjs';

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

const db = await bootDb();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
// extra roles for permission tests
USERS.accountant = '00000000-0000-4000-a000-000000000004';
USERS.viewer = '00000000-0000-4000-a000-000000000005';
await db.exec(`insert into auth.users (id, email) values ('${USERS.accountant}', 'acc@demo.local'), ('${USERS.viewer}', 'view@demo.local');
  insert into staff_profiles (user_id, full_name, role) values ('${USERS.accountant}', 'Asha (accountant)', 'accountant'),
                                                               ('${USERS.viewer}', 'Founder viewer', 'viewer');`);

const ref = await rpc(db, 'admin', 'get_reference_data');
const WH = ref.locations.find((l) => l.is_default).id;
const accountBal = async (key) => {
  const tb = await rpc(db, 'admin', 'trial_balance');
  const a = (await rpc(db, 'admin', 'list_accounts')).find((x) => x.system_key === key);
  const r = tb.rows.find((x) => x.code === a.code);
  return r ? n2(Number(r.debit) - Number(r.credit)) : 0;           // debit-positive
};
const assertBooksBalance = async () => {
  const tb = await rpc(db, 'admin', 'trial_balance');
  assert.equal(n2(tb.total_debit), n2(tb.total_credit), 'trial balance');
  const bs = await rpc(db, 'admin', 'balance_sheet');
  assert.equal(bs.balanced, true, `balance sheet ${bs.total_assets} vs ${bs.total_liabilities_equity}`);
  const iv = await rpc(db, 'admin', 'inventory_valuation');
  for (const r of iv.by_type) assert.equal(n2(r.difference), 0, `inventory ${r.account}: stock ${r.stock_value} vs ledger ${r.ledger_value}`);
};

console.log('\nTorte Living OS — finance, purchasing & production tests\n');

let FLOUR, BUTTER, BOX, SUP_TG, SUP_KA, PO;
await test('Opening position: books balance and stock at cost equals the inventory accounts', async () => {
  await assertBooksBalance();
  assert.equal(await accountBal('inv_finished'), 11000);
  assert.equal(await accountBal('opening'), -11000);
});

await test('Materials get RM-/PK- codes and can never be ordered by customers', async () => {
  FLOUR = await rpc(db, 'admin', 'create_material', { p: { name: 'Refined wheat flour', item_type: 'raw_material', unit: 'kg', reorder_level: 10 } });
  BUTTER = await rpc(db, 'admin', 'create_material', { p: { name: 'Unsalted butter', item_type: 'raw_material', unit: 'kg', shelf_life_days: 60 } });
  BOX = await rpc(db, 'admin', 'create_material', { p: { name: 'Cookie box 200 g', item_type: 'packaging', unit: 'pcs' } });
  assert.deepEqual([FLOUR.sku_code, BUTTER.sku_code, BOX.sku_code], ['RM-000001', 'RM-000002', 'PK-000001']);
  const r = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: 'rm-1', p_payload: {
    external_order_id: 'RM1', customer: { name: 'X', phone: '9000000001' }, ship_to: { state: 'Telangana' },
    lines: [{ sku_code: 'RM-000001', qty: 1, unit_price: 10 }], payment: { status: 'unpaid' } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /material/);
  const cat = await rpc(db, 'anon', 'storefront_catalogue');
  assert.ok(!cat.some((s) => s.code.startsWith('RM') || s.code.startsWith('PK')), 'materials never in the shop');
  await rejects(rpc(db, 'packer', 'create_material', { p: { name: 'x', item_type: 'packaging' } }), /not allowed/);
});

await test('Purchase order → goods receipt creates costed batches: Dr Inventory / Cr GRNI', async () => {
  SUP_TG = await rpc(db, 'admin', 'create_partner', { p: { legal_name: 'Deccan Mills Pvt Ltd', roles: ['supplier'], state: 'Telangana', city: 'Hyderabad' } });
  SUP_KA = await rpc(db, 'admin', 'create_partner', { p: { legal_name: 'Mysore Dairy LLP', roles: ['supplier'], gstin: '29AAAFM1234B1Z3' } });
  PO = await rpc(db, 'accountant', 'create_purchase_order', { p: { supplier_id: SUP_TG.partner_id, lines: [
    { sku_id: FLOUR.sku_id, qty: 50, unit_price: 40, gst_rate: 5 },
    { sku_id: BOX.sku_id, qty: 200, unit_price: 6, gst_rate: 18 }] } });
  assert.match(PO.code, /^PO-\d{4}-\d{6}$/);
  const po = (await rpc(db, 'warehouse', 'list_purchase_orders', { p_status: 'open' })).find((x) => x.id === PO.po_id);
  const [lFlour, lBox] = po.lines;
  await rejects(rpc(db, 'warehouse', 'receive_purchase', { p_po_line_id: lFlour.id, p_qty: 60 }), /Only 50 more/);
  await rejects(rpc(db, 'accountant', 'receive_purchase', { p_po_line_id: lFlour.id, p_qty: 10 }), /not allowed/);
  const r1 = await rpc(db, 'warehouse', 'receive_purchase', { p_po_line_id: lFlour.id, p_qty: 50, p_lot: { supplier_lot_no: 'DM-881', expires_on: '2027-06-30' }, p_idempotency_key: 'grn-1' });
  const again = await rpc(db, 'warehouse', 'receive_purchase', { p_po_line_id: lFlour.id, p_qty: 50, p_idempotency_key: 'grn-1' });
  assert.equal(again.duplicate, true);
  assert.equal(r1.po_status, 'partially_received');
  await rpc(db, 'warehouse', 'receive_purchase', { p_po_line_id: lBox.id, p_qty: 200 });
  assert.equal(await accountBal('inv_raw'), 2000);
  assert.equal(await accountBal('inv_packaging'), 1200);
  assert.equal(await accountBal('grni'), -3200);
  // butter from the other-state supplier
  const po2 = await rpc(db, 'admin', 'create_purchase_order', { p: { supplier_id: SUP_KA.partner_id, lines: [{ sku_id: BUTTER.sku_id, qty: 10, unit_price: 450, gst_rate: 12 }] } });
  const l2 = (await rpc(db, 'admin', 'list_purchase_orders', {})).find((x) => x.id === po2.po_id).lines[0];
  await rpc(db, 'warehouse', 'receive_purchase', { p_po_line_id: l2.id, p_qty: 10 });
  assert.equal(await accountBal('inv_raw'), 6500);
  await assertBooksBalance();
});

await test('Supplier bills: CGST+SGST in-state, IGST out-of-state, price variance, GRNI cleared', async () => {
  const po = (await rpc(db, 'admin', 'list_purchase_orders', { p_status: 'to_bill' }));
  const tg = po.find((x) => x.id === PO.po_id);
  const b1 = await rpc(db, 'accountant', 'record_purchase_bill', { p: { supplier_id: SUP_TG.partner_id, supplier_invoice_no: 'DM/1042',
    due_date: '2099-12-31', lines: [
      { po_line_id: tg.lines[0].id, qty: 50, unit_price: 42 },          // billed ₹2 above PO price
      { po_line_id: tg.lines[1].id, qty: 200 }] } });
  assert.equal(b1.supply_type, 'intra');
  await rejects(rpc(db, 'accountant', 'record_purchase_bill', { p: { supplier_id: SUP_TG.partner_id, supplier_invoice_no: 'FUT-1',
    bill_date: '2099-01-01', lines: [{ expense_account: 'rent', amount: 10 }] } }), /future/);
  // taxable 2100 + 1200 = 3300; GST 105 + 216 = 321
  assert.equal(n2(b1.total), 3621);
  assert.equal(await accountBal('input_cgst'), 160.5);
  assert.equal(await accountBal('input_sgst'), 160.5);
  assert.equal(await accountBal('ppv'), 100);
  await rejects(rpc(db, 'accountant', 'record_purchase_bill', { p: { supplier_id: SUP_TG.partner_id, supplier_invoice_no: 'DM/1042',
    lines: [{ expense_account: 'rent', amount: 10 }] } }), /duplicate|unique/i);
  await rejects(rpc(db, 'accountant', 'record_purchase_bill', { p: { supplier_id: SUP_TG.partner_id, supplier_invoice_no: 'DM/1043',
    lines: [{ po_line_id: tg.lines[0].id, qty: 1 }] } }), /at most 0/);
  const ka = (await rpc(db, 'admin', 'list_purchase_orders', { p_status: 'to_bill' })).find((x) => x.supplier_id === SUP_KA.partner_id);
  const b2 = await rpc(db, 'accountant', 'record_purchase_bill', { p: { supplier_id: SUP_KA.partner_id, supplier_invoice_no: 'MD-77',
    lines: [{ po_line_id: ka.lines[0].id, qty: 10 }] } });
  assert.equal(b2.supply_type, 'inter');
  assert.equal(await accountBal('input_igst'), 540);
  assert.equal(await accountBal('grni'), 0, 'all receipts billed');
  // expense bill (rent, no GST)
  await rpc(db, 'accountant', 'record_purchase_bill', { p: { supplier_id: SUP_TG.partner_id, supplier_invoice_no: 'RENT-NOV',
    lines: [{ expense_account: 'rent', description: 'Kitchen rent November', amount: 15000 }] } });
  assert.equal(await accountBal('payables'), -(3621 + 5040 + 15000));
  await assertBooksBalance();
});

await test('Supplier payments clear payables; ageing shows what is still due', async () => {
  const bills = await rpc(db, 'accountant', 'list_bills', {});
  const dm = bills.find((b) => b.supplier_invoice_no === 'DM/1042');
  await rpc(db, 'accountant', 'record_supplier_payment', { p_supplier_id: SUP_TG.partner_id, p_amount: 3621, p_method: 'bank_transfer',
    p_reference: 'UTR123', p_bill_id: dm.id, p_idempotency_key: 'sp-1' });
  const dup = await rpc(db, 'accountant', 'record_supplier_payment', { p_supplier_id: SUP_TG.partner_id, p_amount: 3621, p_bill_id: dm.id, p_idempotency_key: 'sp-1' });
  assert.equal(dup.duplicate, true);
  const ap = await rpc(db, 'accountant', 'payables_ageing');
  assert.equal(n2(ap.total_due), 5040 + 15000);
  assert.ok(!ap.open_bills.some((b) => b.supplier_invoice_no === 'DM/1042'));
  assert.equal(await accountBal('bank'), -3621);
});

let PRD, NEWBATCH;
await test('Recipes are versioned; production consumes materials (oldest expiry first) and costs the batch', async () => {
  const cookies = (await rpc(db, 'admin', 'list_skus', { p_search: 'MT-000001' }))[0];
  const recipe = { sku_id: cookies.id, output_qty: 20, lines: [
    { material_sku_id: FLOUR.sku_id, qty: 2, wastage_pct: 5 }, { material_sku_id: BUTTER.sku_id, qty: 0.8 },
    { material_sku_id: BOX.sku_id, qty: 20 }] };
  assert.equal((await rpc(db, 'admin', 'save_recipe', { p: recipe })).version, 1);
  assert.equal((await rpc(db, 'admin', 'save_recipe', { p: recipe })).version, 2);
  const r = await rpc(db, 'warehouse', 'get_recipe', { p_sku_id: cookies.id });
  assert.equal(r.version, 2);
  // standard: (2*1.05*42? no — latest batch cost is the PO price 40) => (2.1*40 + 0.8*450 + 20*6) / 20
  assert.equal(n2(r.standard_cost_per_unit), n2((2.1 * 40 + 0.8 * 450 + 20 * 6) / 20));
  await rejects(rpc(db, 'admin', 'save_recipe', { p: { ...recipe, lines: [{ material_sku_id: cookies.id, qty: 1 }] } }), /Only raw materials/);

  PRD = await rpc(db, 'warehouse', 'create_production_order', { p: { sku_id: cookies.id, planned_qty: 40, location_id: WH } });
  const plan = await rpc(db, 'warehouse', 'get_production_order', { p_id: PRD.production_order_id });
  assert.deepEqual(plan.requirements.map((x) => [x.code, n2(x.required)]), [['PK-000001', 40], ['RM-000001', 4.2], ['RM-000002', 1.6]]);
  await rejects(rpc(db, 'packer', 'complete_production', { p: { production_order_id: PRD.production_order_id, output_qty: 38 } }), /not allowed/);
  await rejects(rpc(db, 'warehouse', 'complete_production', { p: { production_order_id: PRD.production_order_id, output_qty: 38,
    consumptions: [{ material_sku_id: BUTTER.sku_id, qty: 25 }] } }), /Not enough material.*butter/i);

  const done = await rpc(db, 'warehouse', 'complete_production', { p: { production_order_id: PRD.production_order_id, output_qty: 38,
    conversion_cost: 380, idempotency_key: 'prd-1' } });
  NEWBATCH = done.batch_code;
  const o = done.order;
  // standard for 38 packs: flour 3.99 kg, butter 1.52 kg, boxes 38
  const mat = 3.99 * 40 + 1.52 * 450 + 38 * 6;
  assert.equal(n2(o.material_cost), n2(mat));
  assert.equal(n2(o.unit_cost), n2((mat + 380) / 38));
  assert.equal(Number(o.yield_pct), 95);
  const b = await one(`select unit_cost, quantity_produced from batches where code = $1`, [NEWBATCH]);
  assert.equal(n2(b.unit_cost), n2((mat + 380) / 38));
  assert.equal(await accountBal('inv_raw'), n2(6500 - 3.99 * 40 - 1.52 * 450));
  assert.equal(await accountBal('inv_packaging'), 1200 - 228);
  assert.equal(await accountBal('overhead_absorbed'), -380);
  const again = await rpc(db, 'warehouse', 'complete_production', { p: { production_order_id: PRD.production_order_id, output_qty: 38 } });
  assert.equal(again.duplicate, true);
  await assertBooksBalance();
});

async function sellAndDispatch(eventId, payload, batchCodes) {
  const r = await rpc(db, 'service', 'ingest_order', { p_source: 'storefront', p_event_id: eventId, p_payload: payload });
  assert.equal(r.ok, true, r.error);
  for (const code of batchCodes) {
    const s = await rpc(db, 'packer', 'pack_scan', { p_order_id: r.order_id, p_code: code });
    assert.equal(s.result, 'accepted', s.message);
  }
  await rpc(db, 'packer', 'complete_packing', { p_order_id: r.order_id });
  await rpc(db, 'packer', 'dispatch_order', { p_order_id: r.order_id, p_provider_code: 'OWN' });
  return r.order_id;
}

let INV1, ORDER1;
await test('Dispatch issues a GST invoice automatically (in-state: CGST+SGST) and posts COGS at batch cost', async () => {
  const cogsBefore = await accountBal('cogs');
  ORDER1 = await sellAndDispatch('fin-1', { external_order_id: 'F1', channel: 'WEB',
    customer: { name: 'Meera Iyer', phone: '9000011122', email: 'meera@example.com' },
    ship_to: { name: 'Meera Iyer', phone: '9000011122', address1: '8 Lake View', city: 'Hyderabad', state: 'TG', pincode: '500081' },
    lines: [{ sku_code: 'MT-000001', qty: 2 }], shipping_amount: 50,
    payment: { status: 'paid', method: 'upi', gateway: 'razorpay', gateway_ref: 'pay_F1' } }, [NEWBATCH, NEWBATCH]);
  const inv = await rpc(db, 'packer', 'invoice_for_order', { p_order_id: ORDER1 });
  INV1 = inv;
  assert.match(inv.code, /^INV\/\d\d-\d\d\/000001$/);
  assert.equal(inv.supply_type, 'intra');
  assert.equal(n2(inv.total), 500);
  assert.equal(n2(inv.taxable_value), 423.73);          // 381.36 goods + 42.37 delivery
  assert.equal(n2(inv.cgst), 38.14);
  assert.equal(n2(inv.sgst), 38.13);
  assert.equal(Number(inv.igst), 0);
  assert.equal(inv.lines.length, 2);
  assert.equal(inv.lines[1].description, 'Delivery charges');
  assert.equal(inv.seller.gstin, '36AAACT1234A1Z5');
  const unit = (await one(`select unit_cost from batches where code = $1`, [NEWBATCH])).unit_cost;
  assert.equal(n2(await accountBal('cogs') - cogsBefore), n2(2 * Number(unit)));
  await assertBooksBalance();
});

await test('Out-of-state delivery is charged IGST; invoice numbers are sequential', async () => {
  const id = await sellAndDispatch('fin-2', { external_order_id: 'F2', channel: 'WEB',
    customer: { name: 'Vikram Shah', phone: '9900022222' },
    ship_to: { name: 'Vikram Shah', address1: '44 12th Main', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' },
    lines: [{ sku_code: 'NS-000001', qty: 1 }], shipping_amount: 80, payment: { status: 'cod' } }, ['BAT-2026-000003']);
  const inv = await rpc(db, 'admin', 'invoice_for_order', { p_order_id: id });
  assert.match(inv.code, /\/000002$/);
  assert.equal(inv.supply_type, 'inter');
  assert.equal(n2(inv.igst), 9.05);
  assert.equal(Number(inv.cgst) + Number(inv.sgst), 0);
  assert.equal(n2(inv.total), 190);
  assert.equal(inv.place_of_supply, '29');
  // cash collected on delivery
  await rpc(db, 'packer', 'record_payment', { p_order_id: id, p_amount: 190, p_method: 'cash', p_reference: 'COD' });
  assert.ok(await accountBal('cash') >= 190);
});

await test('A refund on an invoiced order creates a credit note and reverses GST pro-rata', async () => {
  const gstBefore = await accountBal('output_cgst');
  await rpc(db, 'admin', 'record_refund', { p_order_id: ORDER1, p_amount: 100, p_reference: 'rf_1', p_reason: 'One box arrived broken' });
  const inv = await rpc(db, 'accountant', 'get_invoice', { p_id: INV1.id });
  assert.equal(inv.credit_notes.length, 1);
  assert.match(inv.credit_notes[0].code, /^CN\/\d\d-\d\d\/000001$/);
  assert.equal(n2(inv.credit_notes[0].total), 100);
  assert.equal(n2(await accountBal('output_cgst') - gstBefore), 7.64);   // credit balance reduced
  const ar = await rpc(db, 'admin', 'receivables_ageing');
  assert.ok(!ar.open_invoices.some((x) => x.code === INV1.code), 'paid, refunded and credited: nothing due');
  await rejects(rpc(db, 'accountant', 'issue_credit_note', { p_invoice_id: INV1.id, p_amount: 1000, p_reason: 'x' }).then(async () => {
    const i2 = await rpc(db, 'accountant', 'get_invoice', { p_id: INV1.id });
    if (n2(i2.credit_notes.reduce((t, c) => t + Number(c.total), 0)) > 500) throw new Error('over-credited');
    throw new Error('capped');
  }), /capped/);
  await assertBooksBalance();
});

await test('No company GSTIN/state: invoice is held as an alert, then issued once it is set', async () => {
  await db.exec(`update legal_entities set state_code = null, gstin = null`);
  const id = await sellAndDispatch('fin-3', { external_order_id: 'F3', customer: { name: 'A', phone: '9000033333' },
    ship_to: { name: 'A', address1: 'x', city: 'Hyderabad', state: 'Telangana', pincode: '500001' },
    lines: [{ sku_code: 'NS-000001', qty: 1 }], payment: { status: 'cod' } }, ['BAT-2026-000003']);
  assert.equal(await rpc(db, 'admin', 'invoice_for_order', { p_order_id: id }), null);
  const dash = await rpc(db, 'admin', 'get_dashboard');
  assert.ok(dash.alerts.some((a) => a.type === 'company_gst'));
  assert.ok(dash.alerts.some((a) => a.title === 'Invoice not issued'));
  await rejects(rpc(db, 'admin', 'set_company_details', { p_gstin: '36ABC', p_state_code: 'Telangana', p_registered_address: 'x' }), /15-character/);
  await rejects(rpc(db, 'admin', 'set_company_details', { p_gstin: '29AAACT1234A1Z5', p_state_code: 'Telangana', p_registered_address: 'x' }), /starts with 29/);
  await rejects(rpc(db, 'accountant', 'set_company_details', { p_gstin: '36AAACT1234A1Z5', p_state_code: 'TG', p_registered_address: 'x' }), /not allowed/);
  await rpc(db, 'admin', 'set_company_details', { p_gstin: '36AAACT1234A1Z5', p_state_code: 'TG', p_registered_address: 'Hyderabad' });
  const inv = await rpc(db, 'accountant', 'issue_invoice', { p_order_id: id });
  assert.equal(inv.supply_type, 'intra');
  const ex = await rpc(db, 'accountant', 'list_accounting_exceptions');
  assert.ok(!ex.some((e) => e.kind === 'invoice_failed'));
});

await test('Damaged stock is written off at cost; manual journals must balance and can only be reversed', async () => {
  const atta = (await rpc(db, 'admin', 'list_skus', { p_search: 'NS-000001' }))[0];
  const bid = (await one(`select id from batches where code = 'BAT-2026-000003'`)).id;
  const adjBefore = await accountBal('inventory_adj');
  await rpc(db, 'admin', 'change_stock_status', { p_sku_id: atta.id, p_batch_id: bid, p_location_id: WH, p_from: 'available', p_to: 'damaged', p_qty: 2, p_reason: 'Torn packs' });
  assert.equal(n2(await accountBal('inventory_adj') - adjBefore), 124);
  await rejects(rpc(db, 'accountant', 'post_manual_journal', { p: { narration: 'bad', lines: [{ account: 'bank', debit: 100 }, { account: 'capital', credit: 90 }] } }), /does not balance/);
  await rejects(rpc(db, 'packer', 'post_manual_journal', { p: { narration: 'x', lines: [] } }), /not allowed/);
  const j = await rpc(db, 'accountant', 'post_manual_journal', { p: { narration: 'Capital introduced by founder', idempotency_key: 'cap-1',
    lines: [{ account: '1120', debit: 500000 }, { account: '3000', credit: 500000 }] } });
  assert.match(j.code, /^JV\//);
  assert.equal((await rpc(db, 'accountant', 'post_manual_journal', { p: { narration: 'again', idempotency_key: 'cap-1', lines: [] } })).duplicate, true);
  await rejects(db.query(`update journal_lines set debit = 1`), /permanent/);
  await rejects(db.query(`delete from journal_entries`), /permanent/);
  const rev = await rpc(db, 'accountant', 'reverse_journal', { p_entry_id: j.entry_id, p_reason: 'Posted to wrong bank' });
  assert.ok(rev.code);
  await rejects(rpc(db, 'accountant', 'reverse_journal', { p_entry_id: j.entry_id, p_reason: 'again' }), /Already reversed/);
  await assertBooksBalance();
});

await test('Locked months reject postings; gateway settlement moves money to the bank net of fees', async () => {
  const month = new Date().toISOString().slice(0, 8) + '01';
  await rejects(rpc(db, 'accountant', 'lock_period', { p_month: month }), /not allowed/);
  await rpc(db, 'admin', 'lock_period', { p_month: month });
  await rejects(rpc(db, 'accountant', 'post_manual_journal', { p: { narration: 'x', lines: [{ account: 'bank', debit: 1 }, { account: 'capital', credit: 1 }] } }), /locked/);
  await rpc(db, 'admin', 'lock_period', { p_month: month, p_locked: false });
  const clearing = await accountBal('gateway_clearing');
  const s = await rpc(db, 'accountant', 'record_gateway_settlement', { p_gross: 1000, p_fees: 20, p_gst_on_fees: 3.6, p_reference: 'setl_01' });
  assert.equal(n2(s.net_to_bank), 976.4);
  assert.equal(n2(await accountBal('gateway_clearing')), n2(clearing - 1000));
  await assertBooksBalance();
});

await test('Reports: P&L, balance sheet, GST summary and MIS agree with the transactions', async () => {
  const from = '2026-01-01', to = '2027-12-31';
  const pnl = await rpc(db, 'admin', 'profit_and_loss', { p_from: from, p_to: to });
  const invoiceTaxable = Number((await one(`select sum(taxable_value) t from invoices`)).t);
  const cnTaxable = Number((await one(`select coalesce(sum(taxable_value), 0) t from credit_notes`)).t);
  assert.equal(n2(pnl.revenue), n2(invoiceTaxable - cnTaxable));
  assert.equal(n2(pnl.gross_profit), n2(Number(pnl.revenue) - Number(pnl.cost_of_sales)));
  assert.ok(pnl.by_brand.some((b) => b.brand === 'Mia Torte'));
  assert.ok(pnl.by_channel.length >= 1);
  const gst = await rpc(db, 'accountant', 'gst_summary', { p_from: from, p_to: to });
  const outTax = gst.outward_by_rate.reduce((t, r) => t + Number(r.cgst) + Number(r.sgst) + Number(r.igst), 0);
  const ledgerOut = -(await accountBal('output_cgst') + await accountBal('output_sgst') + await accountBal('output_igst'));
  assert.equal(n2(outTax), n2(ledgerOut), 'GST summary matches ledger output tax');
  assert.equal(n2(gst.inward.igst), 540);
  assert.ok(gst.hsn_summary.some((h) => h.hsn === '1905'));
  const mis = await rpc(db, 'viewer', 'get_mis', { p_from: from, p_to: to });
  assert.equal(mis.production.runs, 1);
  assert.equal(Number(mis.production.avg_yield_pct), 95);
  assert.ok(mis.unit_costs.some((u) => u.code === 'MT-000001' && u.margin_pct !== null));
  assert.equal(mis.company_gst_set, true);
  assert.equal(Number(mis.overheads.absorbed), 380, 'overheads absorbed into batch cost');
  assert.equal(Number(mis.overheads.actual), 0, 'no actual overhead bills recorded');
  const mt = pnl.by_brand.find((b) => b.brand === 'Mia Torte');
  assert.ok(Number(mt.cogs) > 0 && Number(mt.gross_margin_pct) < 100, 'brand margin uses cost of goods sold only');
  const st = await rpc(db, 'accountant', 'account_statement', { p_account: 'receivables', p_from: from, p_to: to });
  assert.equal(n2(st.closing), await accountBal('receivables'));
  await assertBooksBalance();
});

await test('Permissions: packers and warehouse staff cannot see the books; accountants cannot move stock', async () => {
  await rejects(rpc(db, 'packer', 'trial_balance'), /founder, managers and accountants/);
  await rejects(rpc(db, 'warehouse', 'list_journals'), /founder, managers and accountants/);
  await rejects(rpc(db, 'packer', 'get_mis'), /founder, managers and accountants/);
  await rejects(rpc(db, 'accountant', 'pack_scan', { p_order_id: ORDER1, p_code: 'x' }), /not allowed/);
  assert.ok((await rpc(db, 'accountant', 'get_reference_data')).brands.length > 0, 'accountants can load reference data');
  assert.ok(Array.isArray(await rpc(db, 'accountant', 'list_orders', { p_filter: 'all' })));
  await rejects(rpc(db, 'admin', 'post_journal', { p_date: '2026-11-12', p_source_type: null, p_source_id: null, p_purpose: null,
    p_narration: 'x', p_lines: [] }), /permission denied/);
  await rejects(rpc(db, 'anon', 'trial_balance'), /permission denied/);
  const rows = await db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USERS.packer, role: 'authenticated' })]);
    return (await tx.query('select count(*)::int n from journal_lines')).rows[0].n;
  });
  assert.equal(rows, 0, 'RLS hides journal lines from packers');
});

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
