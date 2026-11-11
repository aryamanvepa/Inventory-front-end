// Tests the storefront → canonical order mapping, then feeds the result
// through the real ingest_order function.  `npm run test:webhook`
import assert from 'node:assert/strict';
import { fromWooCommerce, fromGeneric, safeEqual } from '../supabase/functions/order-webhook/map.ts';
import { bootDb, rpc } from './harness.mjs';

const woo = {
  id: 4321, status: 'processing', payment_method: 'razorpay', payment_method_title: 'UPI / Cards', transaction_id: 'pay_Nx81',
  date_created_gmt: '2026-11-10T09:15:00', total: '595.00', shipping_total: '40.00', shipping_tax: '0.00', customer_id: 77,
  customer_note: 'Ring the bell',
  billing: { first_name: 'Meera', last_name: 'Iyer', email: 'meera@example.com', phone: '+91 90000 11122', address_1: '8 Lake View', city: 'Hyderabad', state: 'TG', postcode: '500081' },
  shipping: { first_name: 'Meera', last_name: 'Iyer', address_1: '8 Lake View', city: 'Hyderabad', state: 'TG', postcode: '500081' },
  line_items: [
    { product_id: 10, sku: 'MT-000001', quantity: 1, total: '190.68', total_tax: '34.32' },
    { product_id: 11, sku: 'NS-000001', quantity: 3, total: '314.29', total_tax: '15.71' },
  ],
};

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log(`  ✓ ${name}`); };
console.log('\nWebsite webhook mapping\n');

await t('WooCommerce paid order maps to canonical order', () => {
  const [a] = fromWooCommerce(woo, 'order.created');
  assert.equal(a.kind, 'order');
  assert.equal(a.eventId, 'woo:order:4321');
  assert.equal(a.order.payment.status, 'paid');
  assert.equal(a.order.payment.gateway_ref, 'pay_Nx81');
  assert.equal(a.order.customer.name, 'Meera Iyer');
  assert.deepEqual(a.order.lines.map((l) => [l.sku_code, l.qty, l.unit_price]), [['MT-000001', 1, 225], ['NS-000001', 3, 110]]);
  assert.equal(a.order.shipping_amount, 40);
});

await t('COD, unpaid and cancelled statuses', () => {
  assert.equal(fromWooCommerce({ ...woo, payment_method: 'cod' }, 'order.created')[0].order.payment.status, 'cod');
  assert.equal(fromWooCommerce({ ...woo, status: 'pending' }, 'order.created')[0].order.payment.status, 'unpaid');
  assert.equal(fromWooCommerce({ ...woo, status: 'cancelled' }, 'order.updated')[0].kind, 'ignore');
  const upd = fromWooCommerce(woo, 'order.updated');
  assert.equal(upd.length, 2);
  assert.equal(upd[1].kind, 'payment');
});

await t('Generic format and signature comparison', () => {
  const [a] = fromGeneric({ event_id: 'e1', type: 'order.created', order: { external_order_id: 'X' } });
  assert.equal(a.kind, 'order');
  assert.equal(fromGeneric({})[0].kind, 'ignore');
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
});

await t('Mapped WooCommerce order flows into the database once, then payment update is idempotent', async () => {
  const db = await bootDb();
  const [pending] = fromWooCommerce({ ...woo, status: 'pending' }, 'order.created');
  const r1 = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: pending.eventId, p_payload: pending.order });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.status, 'pending_payment');
  assert.equal(Number(r1.total_amount), 595);
  // A storefront total that disagrees with the price list raises an alert
  const [odd] = fromWooCommerce({ ...woo, id: 999, status: 'pending', total: '450.00' }, 'order.created');
  await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: odd.eventId, p_payload: odd.order });
  const dash = await rpc(db, 'admin', 'get_dashboard');
  assert.ok(dash.alerts.some((x) => x.type === 'total_mismatch' && x.title.includes('450')));
  assert.equal(dash.alerts.filter((x) => x.type === 'total_mismatch').length, 1, 'matching order raises no alert');
  // Payment arrives as order.updated — twice (webhook retry)
  for (let i = 0; i < 2; i++) {
    for (const a of fromWooCommerce(woo, 'order.updated')) {
      if (a.kind === 'order') {
        const r = await rpc(db, 'service', 'ingest_order', { p_source: 'woocommerce', p_event_id: a.eventId, p_payload: a.order });
        assert.equal(r.duplicate, true);
      } else {
        await rpc(db, 'service', 'ingest_payment', { p_source: 'woocommerce', p_event_id: a.eventId, p_external_order_id: a.externalOrderId, p_payment: a.payment });
      }
    }
  }
  const o = await rpc(db, 'admin', 'get_order', { p_order_id: r1.order_id });
  assert.equal(o.payment_status, 'paid');
  assert.equal(o.status, 'confirmed');
  assert.equal(o.payments.length, 1);
});

console.log(`\n${pass} passed\n`);
