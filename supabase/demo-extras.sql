-- =====================================================================
-- DEMO MODE ONLY (loaded by the in-browser demo after seed.sql; never
-- pushed to Supabase, never used by the tests). Sample raw materials,
-- recipes and three orders so every Process case can be tried:
--   * Mia Torte cookies order  -> Make first (materials in stock)
--   * Nutri Sampoorn atta order -> Repack first (bulk atta in stock)
--   * Mia Torte biscotti order -> Raw material out (almonds short)
-- =====================================================================
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

-- Raw materials and packaging (no brand; RM-/PK- codes are assigned automatically)
insert into products (brand_id, name, item_type, shelf_life_days) values
  (null, 'Refined wheat flour', 'raw_material', 180), (null, 'Sugar', 'raw_material', 365),
  (null, 'Dark chocolate chips', 'raw_material', 240), (null, 'Butter', 'raw_material', 60),
  (null, 'Almonds', 'raw_material', 180), (null, 'Multigrain atta (bulk)', 'raw_material', 120),
  (null, 'Cookie box 200 g', 'packaging', 730), (null, 'Pouch 1 kg', 'packaging', 730), (null, 'Pouch 5 kg', 'packaging', 730);
insert into skus (product_id, name, pack_size, pack_unit, reorder_level)
select id, name, 1, case when item_type = 'packaging' then 'pcs' else 'kg' end, 0 from products where item_type <> 'finished';

-- A second Mia Torte product, with no stock yet
insert into products (brand_id, category_id, name, tax_rate_id, shelf_life_days)
select (select id from brands where code = 'MT'), (select id from categories where name = 'Cookies'),
       'Almond Biscotti', (select id from tax_rates where hsn_code = '1905'), 60;
insert into skus (product_id, name, pack_size, pack_unit, mrp, reorder_level)
select id, 'Almond Biscotti 150 g', 150, 'g', 300, 5 from products where name = 'Almond Biscotti';
insert into price_list_items (price_list_id, sku_id, price)
select pl.id, s.id, case pl.code when 'WEB' then 280 when 'DISTRIBUTOR' then 210 else 300 end
  from price_lists pl, skus s where s.name = 'Almond Biscotti 150 g' and pl.code in ('MRP', 'WEB', 'DISTRIBUTOR');

-- Material stock: costed batches; flour and bulk atta have an older and a newer lot (first in, first out)
insert into batches (sku_id, external_lot_no, manufactured_on, expires_on, quantity_produced, unit_cost)
select s.id, v.lot, today_ist() - 10, today_ist() + v.exp, v.qty, v.cost
  from skus s join (values
    ('Refined wheat flour', 'DM-881', 30, 10, 40), ('Refined wheat flour', 'DM-907', 150, 15, 41),
    ('Sugar', 'SG-12', 300, 10, 45), ('Dark chocolate chips', 'CH-5', 200, 5, 600), ('Butter', 'BT-3', 40, 4, 450),
    ('Almonds', 'AL-1', 150, 0.5, 900),
    ('Multigrain atta (bulk)', 'SCF-B11', 60, 25, 48), ('Multigrain atta (bulk)', 'SCF-B12', 110, 35, 48),
    ('Cookie box 200 g', 'PK-77', 700, 200, 6), ('Pouch 1 kg', 'PO-1', 700, 300, 2), ('Pouch 5 kg', 'PO-5', 700, 100, 5)
  ) v(name, lot, exp, qty, cost) on v.name = s.name;

select post_stock_txn('goods_receipt', jsonb_build_array(jsonb_build_object(
         'sku_id', b.sku_id, 'batch_id', b.id, 'location_id', default_location_id(), 'owner_id', company_owner_id(),
         'status', 'available', 'qty', b.quantity_produced)),
       'Opening balance (demo materials)', 'batch', b.id, 'demo:' || b.id, true, false)
  from batches b join skus s on s.id = b.sku_id join products p on p.id = s.product_id where p.item_type <> 'finished';

-- Recipes: Mia Torte is cooked; Nutri Sampoorn is repacked from the bulk sack
insert into recipes (sku_id, version, output_qty, notes)
select id, 1, case name when 'Chocolate Chip Cookies 200 g' then 20 when 'Almond Biscotti 150 g' then 20 else 1 end,
       case when name like 'Multigrain%' then 'Repack from bulk atta' else 'Demo recipe' end
  from skus where name in ('Chocolate Chip Cookies 200 g', 'Almond Biscotti 150 g', 'Multigrain Atta 1 kg', 'Multigrain Atta 5 kg');
insert into recipe_lines (recipe_id, material_sku_id, qty, wastage_pct)
select r.id, m.id, v.qty, v.waste
  from (values
    ('Chocolate Chip Cookies 200 g', 'Refined wheat flour', 2, 5), ('Chocolate Chip Cookies 200 g', 'Sugar', 0.6, 0),
    ('Chocolate Chip Cookies 200 g', 'Dark chocolate chips', 0.8, 0), ('Chocolate Chip Cookies 200 g', 'Butter', 0.8, 0),
    ('Chocolate Chip Cookies 200 g', 'Cookie box 200 g', 20, 0),
    ('Almond Biscotti 150 g', 'Refined wheat flour', 1.5, 5), ('Almond Biscotti 150 g', 'Almonds', 1.2, 0),
    ('Almond Biscotti 150 g', 'Sugar', 0.5, 0), ('Almond Biscotti 150 g', 'Cookie box 200 g', 20, 0),
    ('Multigrain Atta 1 kg', 'Multigrain atta (bulk)', 1, 1), ('Multigrain Atta 1 kg', 'Pouch 1 kg', 1, 0),
    ('Multigrain Atta 5 kg', 'Multigrain atta (bulk)', 5, 1), ('Multigrain Atta 5 kg', 'Pouch 5 kg', 1, 0)
  ) v(product, material, qty, waste)
  join skus p on p.name = v.product join recipes r on r.sku_id = p.id join skus m on m.name = v.material;

-- Three orders that need processing
select ingest_order('website-sim', 'demo-evt-' || n, jsonb_build_object(
  'external_order_id', 'D' || (2000 + n), 'channel', 'WEB', 'placed_at', (now() - make_interval(hours => 4 - n))::text,
  'customer', jsonb_build_object('external_id', 'c-3', 'name', 'Meera Iyer', 'phone', '+91 90000 33333', 'city', 'Hyderabad', 'state', 'Telangana', 'pincode', '500081'),
  'ship_to', jsonb_build_object('name', 'Meera Iyer', 'phone', '+91 90000 33333', 'address1', 'Plot 7, Hitech City Road', 'city', 'Hyderabad', 'state', 'Telangana', 'pincode', '500081'),
  'lines', case n
     when 1 then jsonb_build_array(jsonb_build_object('sku_code', (select code from skus where name = 'Chocolate Chip Cookies 200 g'), 'qty', 60))
     when 2 then jsonb_build_array(jsonb_build_object('sku_code', (select code from skus where name = 'Multigrain Atta 5 kg'), 'qty', 9))
     else jsonb_build_array(jsonb_build_object('sku_code', (select code from skus where name = 'Almond Biscotti 150 g'), 'qty', 10)) end,
  'shipping_amount', 40,
  'payment', jsonb_build_object('status', 'paid', 'method', 'upi', 'gateway', 'razorpay', 'gateway_ref', 'pay_DEMO' || n)
)) from generate_series(1, 3) n;

select set_config('request.jwt.claims', '', false);
