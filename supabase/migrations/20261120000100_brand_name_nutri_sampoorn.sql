-- =====================================================================
-- Brand name correction (owner, 2026-11-14): the brand is
-- "Nutri Sampoorn", not "Nutri Sampoorna". Brand code NS and every
-- SKU code (NS-…) stay the same.
-- =====================================================================
update brands set name = 'Nutri Sampoorn' where code = 'NS' and name <> 'Nutri Sampoorn';
