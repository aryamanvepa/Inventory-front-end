-- =====================================================================
-- Migration 0002 — Master data
-- core:      legal entity, brands, categories, products, SKUs, locations
-- catalogue: GTINs/barcodes, tax (HSN/GST), price lists
-- partners:  customers, business partners (multi-role), stock owners
-- =====================================================================

-- ---------------------------------------------------------------------
-- Legal entity & brands
-- Torte Living Pvt Limited is the legal entity (GST, statutory books);
-- Mia Torte and Nutri Sampoorn are brands under it.
-- ---------------------------------------------------------------------
create table legal_entities (
  id                 uuid primary key default gen_random_uuid(),
  code               text unique,
  name               text not null,
  gstin              text,
  pan                text,
  registered_address text,
  state_code         text,
  created_at         timestamptz not null default now()
);
create trigger assign_code before insert on legal_entities
  for each row execute function trg_assign_code('LE');

create table brands (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,              -- 'MT', 'NS'
  name            text not null unique,
  legal_entity_id uuid not null references legal_entities(id),
  sku_prefix      text not null unique,              -- SKU codes: MT-000001, NS-000001
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create table categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  parent_id  uuid references categories(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Tax configuration (HSN + GST). Rates must be confirmed by the CA.
-- ---------------------------------------------------------------------
create table tax_rates (
  id             uuid primary key default gen_random_uuid(),
  hsn_code       text not null,
  description    text not null,
  gst_rate       numeric(5,2) not null check (gst_rate >= 0 and gst_rate <= 40),
  effective_from date not null default '2017-07-01',
  effective_to   date,
  unique (hsn_code, gst_rate, effective_from)
);

-- ---------------------------------------------------------------------
-- Products and SKUs
-- A product is the recipe/identity; an SKU is each sellable pack size.
-- The SKU code is generated per brand (MT-000001 / NS-000001).
-- ---------------------------------------------------------------------
create table products (
  id               uuid primary key default gen_random_uuid(),
  code             text unique,
  brand_id         uuid not null references brands(id),
  category_id      uuid references categories(id),
  name             text not null,
  description      text,
  tax_rate_id      uuid references tax_rates(id),
  shelf_life_days  int check (shelf_life_days > 0),
  is_batch_tracked boolean not null default true,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (brand_id, name)
);
create trigger assign_code before insert on products
  for each row execute function trg_assign_code('PRD');

create table skus (
  id            uuid primary key default gen_random_uuid(),
  code          text unique,
  product_id    uuid not null references products(id),
  name          text not null,                 -- e.g. "Multigrain Atta 1 kg"
  pack_size     numeric(12,3) not null check (pack_size > 0),
  pack_unit     text not null check (pack_unit in ('g', 'kg', 'ml', 'l', 'pcs')),
  mrp           numeric(12,2) check (mrp >= 0),
  reorder_level int not null default 0 check (reorder_level >= 0),
  weight_grams  numeric(12,2),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create or replace function trg_assign_sku_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_prefix text;
begin
  if new.code is null or new.code = '' then
    select b.sku_prefix into v_prefix
      from products p join brands b on b.id = p.brand_id
     where p.id = new.product_id;
    new.code := next_code(v_prefix);
  end if;
  return new;
end;
$$;
create trigger assign_code before insert on skus
  for each row execute function trg_assign_sku_code();

-- GS1 GTIN check-digit validation (GTIN-8/12/13/14).
create or replace function is_valid_gtin(p text)
returns boolean
language plpgsql
immutable
as $$
declare
  s int := 0; d int; i int; n int;
begin
  if p is null or p !~ '^\d{8}$|^\d{12,14}$' then return false; end if;
  n := length(p);
  for i in 1 .. n - 1 loop
    d := substr(p, n - i, 1)::int;
    s := s + case when i % 2 = 1 then d * 3 else d end;
  end loop;
  return (10 - (s % 10)) % 10 = substr(p, n, 1)::int;
end;
$$;

create table gtins (
  id             uuid primary key default gen_random_uuid(),
  sku_id         uuid not null references skus(id),
  gtin           text not null unique check (is_valid_gtin(gtin)),
  level          text not null default 'each' check (level in ('each', 'inner', 'case')),
  units_per_pack int not null default 1 check (units_per_pack > 0),
  issued_by      text not null default 'GS1 India',
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Sales channels and price lists (no single selling price on the SKU)
-- ---------------------------------------------------------------------
create table sales_channels (
  id     uuid primary key default gen_random_uuid(),
  code   text not null unique,   -- WEB, WHATSAPP, DIRECT, DISTRIBUTOR, RETAIL_POS, CORPORATE
  name   text not null,
  active boolean not null default true
);

create table price_lists (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  price_type price_type not null,
  channel_id uuid references sales_channels(id),
  currency   text not null default 'INR',
  tax_inclusive boolean not null default true,
  active     boolean not null default true
);

create table price_list_items (
  id             uuid primary key default gen_random_uuid(),
  price_list_id  uuid not null references price_lists(id),
  sku_id         uuid not null references skus(id),
  price          numeric(12,2) not null check (price >= 0),
  effective_from date not null default '2000-01-01',
  effective_to   date,
  created_at     timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (price_list_id, sku_id, effective_from)
);

create or replace function get_price(p_sku_id uuid, p_price_list_code text, p_on date default null)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select i.price
    from price_list_items i join price_lists l on l.id = i.price_list_id
   where l.code = p_price_list_code and i.sku_id = p_sku_id
     and i.effective_from <= coalesce(p_on, today_ist())
     and (i.effective_to is null or i.effective_to >= coalesce(p_on, today_ist()))
   order by i.effective_from desc
   limit 1
$$;

-- ---------------------------------------------------------------------
-- Business partners (distributors, retailers, suppliers, manufacturers …)
-- One partner, many roles — no duplicate records for multi-role firms.
-- ---------------------------------------------------------------------
create table business_partners (
  id           uuid primary key default gen_random_uuid(),
  code         text unique,
  legal_name   text not null,
  display_name text,
  gstin        text,
  phone        text,
  email        text,
  address      text,
  city         text,
  state        text,
  pincode      text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create trigger assign_code before insert on business_partners
  for each row execute function trg_assign_code('BP');

create table partner_roles (
  id         uuid primary key default gen_random_uuid(),
  partner_id uuid not null references business_partners(id),
  role       partner_role not null,
  code       text unique,   -- DST-000001, RTL-000001, SUP-000001, MFR-000001 …
  active     boolean not null default true,
  unique (partner_id, role)
);

create or replace function trg_assign_partner_role_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.code is null then
    new.code := next_code(case new.role
      when 'distributor' then 'DST' when 'sub_distributor' then 'SDT'
      when 'retailer' then 'RTL' when 'wholesaler' then 'WHL'
      when 'supplier' then 'SUP' when 'manufacturer' then 'MFR'
      when 'logistics_provider' then 'LSP' else 'INS' end);
  end if;
  return new;
end;
$$;
create trigger assign_code before insert on partner_roles
  for each row execute function trg_assign_partner_role_code();

-- ---------------------------------------------------------------------
-- Stock owners — who legally/economically owns stock.
-- Either the company (legal entity) or a business partner.
-- ---------------------------------------------------------------------
create table stock_owners (
  id              uuid primary key default gen_random_uuid(),
  legal_entity_id uuid unique references legal_entities(id),
  partner_id      uuid unique references business_partners(id),
  check ((legal_entity_id is null) <> (partner_id is null))
);

create or replace function owner_for_entity(p_legal_entity_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from stock_owners where legal_entity_id = p_legal_entity_id;
  if v is null then
    insert into stock_owners (legal_entity_id) values (p_legal_entity_id)
    on conflict (legal_entity_id) do nothing returning id into v;
    if v is null then select id into v from stock_owners where legal_entity_id = p_legal_entity_id; end if;
  end if;
  return v;
end; $$;

create or replace function owner_for_partner(p_partner_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from stock_owners where partner_id = p_partner_id;
  if v is null then
    insert into stock_owners (partner_id) values (p_partner_id)
    on conflict (partner_id) do nothing returning id into v;
    if v is null then select id into v from stock_owners where partner_id = p_partner_id; end if;
  end if;
  return v;
end; $$;

-- The company's own stock-owner id (single legal entity: Torte Living).
create or replace function company_owner_id()
returns uuid language sql stable security definer set search_path = public as $$
  select o.id from stock_owners o
    join legal_entities e on e.id = o.legal_entity_id
   order by e.created_at limit 1
$$;

-- ---------------------------------------------------------------------
-- Locations — physical places stock can be.
-- Partner-operated locations (distributor, contract manufacturer)
-- reference the partner; ownership is tracked separately on the ledger.
-- ---------------------------------------------------------------------
create table locations (
  id          uuid primary key default gen_random_uuid(),
  code        text unique,
  name        text not null unique,
  type        location_type not null,
  partner_id  uuid references business_partners(id),
  address     text,
  city        text,
  state       text,
  pincode     text,
  is_default_fulfilment boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  check (type not in ('distributor', 'retailer', 'contract_manufacturer') or partner_id is not null)
);
create trigger assign_code before insert on locations
  for each row execute function trg_assign_code('LOC');
create unique index locations_one_default on locations (is_default_fulfilment) where is_default_fulfilment;

-- ---------------------------------------------------------------------
-- Customers (individual consumers) + external references + consent.
-- Marketing consent is stored separately from the fact of an order.
-- ---------------------------------------------------------------------
create table customers (
  id         uuid primary key default gen_random_uuid(),
  code       text unique,
  full_name  text not null,
  phone      text,
  phone_norm text generated always as (right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10)) stored,
  email      text,
  email_norm text generated always as (lower(trim(email))) stored,
  city       text,
  state      text,
  pincode    text,
  created_at timestamptz not null default now()
);
create trigger assign_code before insert on customers
  for each row execute function trg_assign_code('CUS');
create index customers_phone_norm on customers (phone_norm) where phone_norm <> '';
create index customers_email_norm on customers (email_norm) where email_norm is not null;

create table customer_external_refs (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  source      text not null,          -- 'woocommerce', 'hostinger', 'shopify' …
  external_id text not null,
  unique (source, external_id)
);

create table customer_consents (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  purpose     text not null check (purpose in ('marketing_email', 'marketing_whatsapp', 'marketing_sms')),
  granted     boolean not null,
  source      text not null,
  recorded_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Delivery providers (Rapido locally, iCarry nationally, own delivery)
-- ---------------------------------------------------------------------
create table delivery_providers (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  scope         text not null default 'local' check (scope in ('local', 'national', 'any')),
  tracking_url_template text,          -- e.g. https://track.example.com/{ref}
  active        boolean not null default true
);

-- Audit master-data changes
create trigger audit after insert or update or delete on products         for each row execute function trg_audit();
create trigger audit after insert or update or delete on skus             for each row execute function trg_audit();
create trigger audit after insert or update or delete on gtins            for each row execute function trg_audit();
create trigger audit after insert or update or delete on price_list_items for each row execute function trg_audit();
create trigger audit after insert or update or delete on tax_rates        for each row execute function trg_audit();
create trigger audit after insert or update or delete on locations        for each row execute function trg_audit();
create trigger audit after insert or update or delete on business_partners for each row execute function trg_audit();
create trigger audit after insert or update or delete on staff_profiles   for each row execute function trg_audit();
