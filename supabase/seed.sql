-- =====================================================================
-- Pilot sample data (for a TEST project only — not real products/prices)
--   3 products: 1 Mia Torte, 2 Nutri Sampoorn variants
--   batches, opening stock, 1 sample contract manufacturer,
--   1 sample distributor, 2 customers and 10 test orders
-- Replace with the real catalogue before go-live.
-- =====================================================================
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

-- Sample partners
with p as (
  insert into business_partners (legal_name, display_name, city, state)
  values ('Sample Contract Foods Pvt Ltd', 'Sample Contract Foods', 'Hyderabad', 'Telangana') returning id
), r as (insert into partner_roles (partner_id, role) select id, 'manufacturer' from p)
insert into locations (name, type, partner_id, city, state)
select 'Sample Contract Foods – plant', 'contract_manufacturer', id, 'Hyderabad', 'Telangana' from p;

with p as (
  insert into business_partners (legal_name, display_name, city, state)
  values ('Sample Distributors LLP', 'Distributor A (sample)', 'Hyderabad', 'Telangana') returning id
), r as (insert into partner_roles (partner_id, role) select id, 'distributor' from p)
insert into locations (name, type, partner_id, city, state)
select 'Distributor A – godown', 'distributor', id, 'Hyderabad', 'Telangana' from p;

select owner_for_partner(id) from business_partners;

-- Products & SKUs
insert into products (brand_id, category_id, name, tax_rate_id, shelf_life_days)
select (select id from brands where code = 'MT'), (select id from categories where name = 'Cookies'),
       'Chocolate Chip Cookies', (select id from tax_rates where hsn_code = '1905'), 90;
insert into products (brand_id, category_id, name, tax_rate_id, shelf_life_days)
select (select id from brands where code = 'NS'), (select id from categories where name = 'Atta'),
       'Multigrain Atta', (select id from tax_rates where hsn_code = '1102'), 120;

insert into skus (product_id, name, pack_size, pack_unit, mrp, reorder_level)
select id, 'Chocolate Chip Cookies 200 g', 200, 'g', 250, 10 from products where name = 'Chocolate Chip Cookies';
insert into skus (product_id, name, pack_size, pack_unit, mrp, reorder_level)
select id, 'Multigrain Atta 1 kg', 1, 'kg', 120, 15 from products where name = 'Multigrain Atta';
insert into skus (product_id, name, pack_size, pack_unit, mrp, reorder_level)
select id, 'Multigrain Atta 5 kg', 5, 'kg', 550, 5 from products where name = 'Multigrain Atta';

insert into price_list_items (price_list_id, sku_id, price)
select (select id from price_lists where code = 'MRP'), id, mrp from skus;
insert into price_list_items (price_list_id, sku_id, price)
select (select id from price_lists where code = 'WEB'), id,
       case name when 'Chocolate Chip Cookies 200 g' then 225 when 'Multigrain Atta 1 kg' then 110 else 520 end
  from skus;
insert into price_list_items (price_list_id, sku_id, price)
select (select id from price_lists where code = 'DISTRIBUTOR'), id, round(mrp * 0.7, 2) from skus;

-- Batches (own facility for cookies; contract manufacturer for atta)
insert into batches (sku_id, manufactured_on, packed_on, expires_on, quantity_produced, unit_cost)
select id, today_ist() - 10, today_ist() - 10, today_ist() + 80, 60, 95 from skus where name = 'Chocolate Chip Cookies 200 g';
insert into batches (sku_id, manufactured_on, packed_on, expires_on, quantity_produced, unit_cost, qa_notes)
select id, today_ist() - 120, today_ist() - 120, today_ist() - 2, 10, 90, 'Old batch — kept to demonstrate expiry blocking'
  from skus where name = 'Chocolate Chip Cookies 200 g';
insert into batches (sku_id, manufacturer_partner_id, external_lot_no, manufactured_on, packed_on, expires_on, quantity_produced, unit_cost)
select id, (select id from business_partners where display_name = 'Sample Contract Foods'), 'SCF-L2041',
       today_ist() - 20, today_ist() - 19, today_ist() + 100, 100, 62 from skus where name = 'Multigrain Atta 1 kg';
insert into batches (sku_id, manufacturer_partner_id, external_lot_no, manufactured_on, packed_on, expires_on, quantity_produced, unit_cost)
select id, (select id from business_partners where display_name = 'Sample Contract Foods'), 'SCF-L2042',
       today_ist() - 20, today_ist() - 19, today_ist() + 100, 12, 290 from skus where name = 'Multigrain Atta 5 kg';

-- Opening stock into the main warehouse (via the ledger, never by editing balances)
select post_stock_txn('production_receipt', jsonb_build_array(jsonb_build_object(
         'sku_id', b.sku_id, 'batch_id', b.id, 'location_id', default_location_id(), 'owner_id', company_owner_id(),
         'status', 'available', 'qty', q.qty)),
       'Opening balance (pilot sample)', 'batch', b.id, 'seed:' || b.id, true, false)
  from batches b join skus s on s.id = b.sku_id
  join (values ('Chocolate Chip Cookies 200 g', 80, 40), ('Chocolate Chip Cookies 200 g', -2, 6),
               ('Multigrain Atta 1 kg', 100, 70), ('Multigrain Atta 5 kg', 100, 8)) q(name, exp_offset, qty)
    on q.name = s.name and b.expires_on = today_ist() + q.exp_offset;

-- Consignment example: 10 packs of atta at Distributor A, still owned by Torte Living
select post_stock_txn('transfer', jsonb_build_array(
    jsonb_build_object('sku_id', b.sku_id, 'batch_id', b.id, 'location_id', default_location_id(), 'owner_id', company_owner_id(), 'status', 'available', 'qty', -10),
    jsonb_build_object('sku_id', b.sku_id, 'batch_id', b.id, 'location_id', (select id from locations where name = 'Distributor A – godown'),
                       'owner_id', company_owner_id(), 'status', 'available', 'qty', 10)),
  'Consignment stock to Distributor A (sample)', null, null, 'seed:consignment', true, false)
  from batches b join skus s on s.id = b.sku_id where s.name = 'Multigrain Atta 1 kg';

-- Ten test website orders (through the same intake function the website will use)
select ingest_order('website-sim', 'seed-evt-' || n, jsonb_build_object(
  'external_order_id', 'T' || (1000 + n),
  'channel', case when n in (4, 8) then 'WHATSAPP' else 'WEB' end,
  'placed_at', (now() - make_interval(hours => (11 - n) * 2 + case when n = 1 then 12 else 0 end))::text,
  'customer', case when n % 2 = 0
      then jsonb_build_object('external_id', 'c-1', 'name', 'Ananya Rao', 'phone', '+91 98480 11111', 'email', 'ananya.sample@example.com',
                              'city', 'Hyderabad', 'state', 'Telangana', 'pincode', '500034', 'marketing_consent', true)
      else jsonb_build_object('external_id', 'c-2', 'name', 'Vikram Shah', 'phone', '+91 99000 22222', 'email', 'vikram.sample@example.com',
                              'city', 'Bengaluru', 'state', 'Karnataka', 'pincode', '560038', 'marketing_consent', false) end,
  'ship_to', case when n % 2 = 0
      then jsonb_build_object('name', 'Ananya Rao', 'phone', '+91 98480 11111', 'address1', 'Flat 12, Road No. 10, Banjara Hills', 'city', 'Hyderabad', 'state', 'Telangana', 'pincode', '500034')
      else jsonb_build_object('name', 'Vikram Shah', 'phone', '+91 99000 22222', 'address1', '44, 12th Main, Indiranagar', 'city', 'Bengaluru', 'state', 'Karnataka', 'pincode', '560038') end,
  'lines', case n % 3
      when 0 then jsonb_build_array(jsonb_build_object('sku_code', (select code from skus where name = 'Chocolate Chip Cookies 200 g'), 'qty', 2),
                                    jsonb_build_object('sku_code', (select code from skus where name = 'Multigrain Atta 1 kg'), 'qty', 1))
      when 1 then jsonb_build_array(jsonb_build_object('sku_code', (select code from skus where name = 'Multigrain Atta 1 kg'), 'qty', 2))
      else jsonb_build_array(jsonb_build_object('sku_code', (select code from skus where name = 'Chocolate Chip Cookies 200 g'), 'qty', 1),
                             jsonb_build_object('sku_code', (select code from skus where name = 'Multigrain Atta 5 kg'), 'qty', 1)) end,
  'shipping_amount', case when n % 2 = 0 then 40 else 80 end,
  'payment', case when n = 9 then jsonb_build_object('status', 'unpaid')
                  when n in (4, 8) then jsonb_build_object('status', 'cod')
                  else jsonb_build_object('status', 'paid', 'method', 'upi', 'gateway', 'razorpay', 'gateway_ref', 'pay_SAMPLE' || n) end
)) from generate_series(1, 10) n;

select set_config('request.jwt.claims', '', false);
