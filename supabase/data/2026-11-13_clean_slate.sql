-- =====================================================================
-- Clean slate (approved by the owner on 2026-11-13): there are no real
-- orders yet, so every order, customer, stock movement, accounting entry
-- and test record is removed. Stock, MIS, dashboard and bestsellers start
-- from zero; order/payment/batch/stock/shipment/journal/customer numbering
-- restarts at 000001.
--
-- KEPT: products and SKUs (incl. the 3 TEST products, now with no stock),
-- prices, barcodes, categories, GST rates, recipes, partners, locations,
-- staff, app settings, Storage photos, and the audit history of catalogue,
-- price, staff and settings changes.
--
-- One transaction; TRUNCATE is used because ledgers are append-only
-- (row-level no-delete/immutable triggers don't fire on TRUNCATE).
-- =====================================================================
begin;

truncate table
  -- orders, website, customers
  order_lines, stock_reservations, payments, pack_scans, shipments,
  invoice_lines, credit_note_lines, credit_notes, invoices,
  integration_events, stock_alert_requests, customer_external_refs, customer_consents,
  orders, customers,
  -- stock and production
  stock_movements, stock_balances, stock_counts, inventory_requests,
  production_consumptions, production_orders,
  purchase_receipts, purchase_bill_lines, purchase_bills, supplier_payments, purchase_order_lines, purchase_orders,
  stock_transactions, batches,
  -- accounting
  journal_lines, journal_entries, accounting_exceptions, accounting_periods,
  -- promos
  promo_codes;

-- change history of the records removed above
delete from audit_log where table_name in ('orders', 'batches', 'shipments', 'stock_counts', 'promo_codes',
  'production_orders', 'purchase_orders');

-- numbering restarts at 000001 for transactions (yearly counters, FY journal/invoice counters) and customers;
-- product, SKU, partner, location and legal-entity numbering is untouched
delete from code_sequences where year <> 0 or prefix = 'CUS';

commit;
