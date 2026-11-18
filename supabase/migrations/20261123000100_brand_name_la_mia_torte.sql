-- =====================================================================
-- Brand rename (owner, 2026-11-18): "Mia Torte" is now "La Mia Torte"
-- (the name Mia Torte was not available). Brand code MT and every SKU
-- code (MT-…) stay the same.
-- =====================================================================
update brands set name = 'La Mia Torte' where code = 'MT' and name <> 'La Mia Torte';
