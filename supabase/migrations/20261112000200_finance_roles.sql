-- =====================================================================
-- Migration 0009 — New staff role for the finance layer.
-- (Enum values must be added in their own migration before use.)
--   accountant: invoices, credit notes, purchase bills, supplier payments,
--               journals and financial reports. No stock or packing.
-- =====================================================================
alter type staff_role add value if not exists 'accountant';
