-- =====================================================================
-- Migration 0007 — Security: row-level security, grants, reference data
--
-- * Every table has RLS enabled. Staff can read operational data;
--   only managers/admins can maintain master data; only admins can
--   change prices, tax rates or staff.
-- * Ledgers, orders, scans, payments and shipments have NO write
--   policies at all: they change only through the role-checked
--   database functions above.
-- * The anonymous (public) key can do nothing.
-- =====================================================================

create or replace function is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select current_staff_role() is not null
$$;

create or replace function has_role(variadic p_roles staff_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select current_staff_role() = 'admin' or current_staff_role() = any (p_roles)
$$;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Read access for staff
do $$
declare t text;
begin
  foreach t in array array[
    'legal_entities', 'brands', 'categories', 'tax_rates', 'products', 'skus', 'gtins', 'sales_channels',
    'price_lists', 'price_list_items', 'business_partners', 'partner_roles', 'stock_owners', 'locations',
    'customers', 'customer_external_refs', 'delivery_providers', 'batches', 'stock_transactions',
    'stock_movements', 'stock_balances', 'orders', 'order_lines', 'stock_reservations', 'payments',
    'pack_scans', 'shipments'] loop
    execute format('create policy staff_read on public.%I for select to authenticated using (is_staff())', t);
  end loop;
end $$;

create policy managers_read on customer_consents   for select to authenticated using (has_role('manager'));
create policy managers_read on integration_events  for select to authenticated using (has_role('manager'));
create policy managers_read on audit_log           for select to authenticated using (has_role('manager'));
create policy own_or_admin_read on staff_profiles  for select to authenticated using (user_id = auth.uid() or has_role('admin'));

-- Master-data maintenance (manager/admin)
do $$
declare t text;
begin
  foreach t in array array['categories', 'products', 'skus', 'gtins', 'business_partners', 'partner_roles',
                           'locations', 'delivery_providers', 'customers'] loop
    execute format('create policy managers_insert on public.%I for insert to authenticated with check (has_role(''manager''))', t);
    execute format('create policy managers_update on public.%I for update to authenticated using (has_role(''manager'')) with check (has_role(''manager''))', t);
  end loop;
end $$;

-- Pricing, tax, brands, channels, legal entity: admin only
do $$
declare t text;
begin
  foreach t in array array['price_lists', 'price_list_items', 'tax_rates', 'brands', 'sales_channels', 'legal_entities'] loop
    execute format('create policy admin_insert on public.%I for insert to authenticated with check (has_role(''admin''))', t);
    execute format('create policy admin_update on public.%I for update to authenticated using (has_role(''admin'')) with check (has_role(''admin''))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;

-- Internal helpers: callable only from inside other database functions.
revoke execute on function next_code(text, boolean) from authenticated, service_role;
revoke execute on function post_stock_txn(stock_txn_type, jsonb, text, text, uuid, text, boolean, boolean) from authenticated, service_role;
revoke execute on function owner_for_entity(uuid) from authenticated, service_role;
revoke execute on function owner_for_partner(uuid) from authenticated, service_role;
revoke execute on function reserve_order_stock(uuid) from authenticated, service_role;
revoke execute on function release_order_reservations(uuid) from authenticated, service_role;
revoke execute on function reserve_waiting_orders(uuid, uuid) from authenticated, service_role;
revoke execute on function upsert_customer(text, jsonb) from authenticated, service_role;
revoke execute on function insert_payment(uuid, payment_kind, numeric, text, text, text, text, text) from authenticated, service_role;
revoke execute on function refresh_payment_status(uuid) from authenticated, service_role;
revoke execute on function lock_sku_location(uuid, uuid) from authenticated, service_role;

alter default privileges in schema public revoke execute on functions from public, anon;

-- ---------------------------------------------------------------------
-- Reference data (safe to run once; real catalogue is loaded separately)
-- ---------------------------------------------------------------------
insert into legal_entities (name, registered_address, state_code)
values ('Torte Living Pvt Limited', null, null);
select owner_for_entity(id) from legal_entities;

insert into brands (code, name, legal_entity_id, sku_prefix)
select 'MT', 'Mia Torte', id, 'MT' from legal_entities
union all
select 'NS', 'Nutri Sampoorna', id, 'NS' from legal_entities;

insert into categories (name) values
  ('Cookies'), ('Brownies'), ('Cakes'), ('Atta'), ('Dosa & batter mixes'), ('Snacks');

-- Indicative HSN/GST rates — MUST be confirmed by Torte Living's CA before go-live.
insert into tax_rates (hsn_code, description, gst_rate) values
  ('1905', 'Biscuits, cookies, cakes, brownies (bakery wares)', 18),
  ('1101', 'Wheat flour / atta (pre-packaged, labelled)', 5),
  ('1102', 'Multigrain / other cereal flours (pre-packaged, labelled)', 5),
  ('2106', 'Ready mixes / food preparations n.e.s.', 18);

insert into sales_channels (code, name) values
  ('WEB', 'Website'), ('WHATSAPP', 'WhatsApp'), ('DIRECT', 'Direct sale'),
  ('DISTRIBUTOR', 'Distributor'), ('RETAIL_POS', 'Retail sell-through'), ('CORPORATE', 'Corporate & institutional');

insert into price_lists (code, name, price_type, channel_id) values
  ('MRP', 'Maximum retail price', 'mrp', null),
  ('WEB', 'Website price', 'website', (select id from sales_channels where code = 'WEB')),
  ('WHOLESALE', 'Wholesale price', 'wholesale', null),
  ('DISTRIBUTOR', 'Distributor price', 'distributor', (select id from sales_channels where code = 'DISTRIBUTOR')),
  ('INSTITUTIONAL', 'Institutional price', 'institutional', (select id from sales_channels where code = 'CORPORATE'));

insert into delivery_providers (code, name, scope, tracking_url_template) values
  ('RAPIDO', 'Rapido', 'local', null),
  ('ICARRY', 'iCarry', 'national', null),
  ('OWN', 'Own delivery', 'local', null);

insert into locations (name, type, is_default_fulfilment) values ('Main warehouse', 'warehouse', true);
