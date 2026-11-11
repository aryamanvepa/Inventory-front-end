-- =====================================================================
-- Migration 0005 — Operational transactions (database functions)
--
-- All business rules live here, not in the app:
--   * stock can't go negative; completed movements can't be deleted
--   * adjustments record who, when and why
--   * every scan is linked to a user, order, SKU and batch
--   * an order can't be packed until every item is validated
--   * a network retry can't process a transaction twice (idempotency keys)
--   * two orders can't take the same last unit (per-SKU/location locks)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------
-- Sellable stock: company-owned, 'available', in a released, unexpired batch.
create or replace function sellable_qty(p_sku uuid, p_location uuid, p_batch uuid default null)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(b.qty), 0)
    from stock_balances b
    left join batches bt on bt.id = b.batch_id
   where b.sku_id = p_sku and b.location_id = p_location
     and b.owner_id = company_owner_id() and b.status = 'available'
     and (p_batch is null or b.batch_id = p_batch)
     and (b.batch_id is null or (bt.qa_status = 'released' and bt.expires_on >= today_ist()))
$$;

create or replace function reserved_qty(p_sku uuid, p_location uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(qty), 0) from stock_reservations
   where sku_id = p_sku and location_id = p_location and status = 'active'
$$;

-- Available to promise = sellable − active reservations
create or replace function atp_qty(p_sku uuid, p_location uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select sellable_qty(p_sku, p_location) - reserved_qty(p_sku, p_location)
$$;

create or replace function batch_is_sellable(p_batch uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_batch is null or exists (select 1 from batches where id = p_batch and qa_status = 'released' and expires_on >= today_ist())
$$;

create or replace function default_location_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from locations where is_default_fulfilment and active limit 1
$$;

-- ---------------------------------------------------------------------
-- Scan resolution
-- Accepts: batch code (BAT-2026-000001), SKU code (MT-000001),
-- GTIN/EAN-13, GS1 element strings ((01)…(10)…) and GS1 Digital Link
-- URLs (…/01/<gtin>/10/<batch>).
-- ---------------------------------------------------------------------
create or replace function resolve_scan(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_code  text := trim(coalesce(p_code, ''));
  v_gtin  text;
  v_lot   text;
  v_sku   skus%rowtype;
  v_batch batches%rowtype;
  v_units int := 1;
  v_sku_id uuid;
  v_m     text[];
begin
  perform require_staff();
  if v_code = '' then return jsonb_build_object('kind', 'unknown'); end if;

  -- GS1 Digital Link: https://…/01/09501101530003/10/BAT-2026-000001
  v_m := regexp_match(v_code, '/01/(\d{8,14})(?:/10/([^/?#]+))?');
  if v_m is not null then
    v_gtin := lpad(v_m[1], 14, '0'); v_lot := v_m[2];
  else
    -- GS1 element string with brackets: (01)09501101530003(10)LOT
    v_m := regexp_match(v_code, '^\(01\)(\d{14})(?:\(17\)\d{6})?(?:\(10\)(.+))?$');
    if v_m is not null then
      v_gtin := v_m[1]; v_lot := v_m[2];
    else
      -- Raw GS1-128 / DataMatrix: 01 + 14 digits [+17 + 6 digits] [+10 + lot]
      v_m := regexp_match(v_code, '^01(\d{14})(?:17\d{6})?(?:10(.+))?$');
      if v_m is not null then v_gtin := v_m[1]; v_lot := v_m[2]; end if;
    end if;
  end if;

  if v_lot is not null then
    select * into v_batch from batches where upper(code) = upper(v_lot);
  end if;

  if v_gtin is null and v_batch.id is null then
    -- Plain codes
    select * into v_batch from batches where upper(code) = upper(v_code);
    if v_batch.id is null then
      select * into v_sku from skus where upper(code) = upper(v_code);
      if v_sku.id is null and v_code ~ '^\d{8}$|^\d{12,14}$' then
        v_gtin := v_code;
      end if;
    end if;
  end if;

  if v_gtin is not null and v_sku.id is null then
    select g.sku_id, g.units_per_pack into v_sku_id, v_units
      from gtins g where ltrim(g.gtin, '0') = ltrim(v_gtin, '0');
    if v_sku_id is not null then
      select * into v_sku from skus where id = v_sku_id;
    end if;
  end if;

  if v_batch.id is not null then
    if v_sku.id is not null and v_sku.id <> v_batch.sku_id then
      return jsonb_build_object('kind', 'mismatch',
        'message', 'The barcode and batch label belong to different products');
    end if;
    select * into v_sku from skus where id = v_batch.sku_id;
  end if;

  if v_sku.id is null then
    return jsonb_build_object('kind', 'unknown', 'code', v_code);
  end if;

  return jsonb_build_object(
    'kind', case when v_batch.id is not null then 'batch' else 'sku' end,
    'units', v_units,
    'sku', (select jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name, 'mrp', s.mrp,
                    'product', p.name, 'brand', b.name, 'is_batch_tracked', p.is_batch_tracked,
                    'shelf_life_days', p.shelf_life_days)
              from skus s join products p on p.id = s.product_id join brands b on b.id = p.brand_id
             where s.id = v_sku.id),
    'batch', case when v_batch.id is null then null else jsonb_build_object(
               'id', v_batch.id, 'code', v_batch.code, 'expires_on', v_batch.expires_on,
               'manufactured_on', v_batch.manufactured_on, 'qa_status', v_batch.qa_status) end
  );
end; $$;

-- ---------------------------------------------------------------------
-- Master data: products, SKUs, prices
-- ---------------------------------------------------------------------
create or replace function create_product_sku(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_product uuid := nullif(p->>'product_id', '')::uuid;
  v_sku     skus%rowtype;
begin
  perform require_role('manager');
  if v_product is null then
    insert into products (brand_id, category_id, name, description, tax_rate_id, shelf_life_days, is_batch_tracked)
    values ((p->>'brand_id')::uuid, nullif(p->>'category_id', '')::uuid, p->>'product_name', p->>'description',
            nullif(p->>'tax_rate_id', '')::uuid, nullif(p->>'shelf_life_days', '')::int,
            coalesce((p->>'is_batch_tracked')::boolean, true))
    returning id into v_product;
  end if;

  insert into skus (product_id, name, pack_size, pack_unit, mrp, reorder_level, weight_grams)
  values (v_product, p->>'sku_name', (p->>'pack_size')::numeric, p->>'pack_unit',
          nullif(p->>'mrp', '')::numeric, coalesce(nullif(p->>'reorder_level', '')::int, 0),
          nullif(p->>'weight_grams', '')::numeric)
  returning * into v_sku;

  if nullif(p->>'gtin', '') is not null then
    insert into gtins (sku_id, gtin) values (v_sku.id, p->>'gtin');
  end if;
  if nullif(p->>'website_price', '') is not null then
    insert into price_list_items (price_list_id, sku_id, price)
    select id, v_sku.id, (p->>'website_price')::numeric from price_lists where code = 'WEB';
  end if;
  if v_sku.mrp is not null then
    insert into price_list_items (price_list_id, sku_id, price)
    select id, v_sku.id, v_sku.mrp from price_lists where code = 'MRP';
  end if;

  return jsonb_build_object('product_id', v_product, 'sku_id', v_sku.id, 'sku_code', v_sku.code);
end; $$;

-- Price changes are admin-only and dated (history is never rewritten).
create or replace function set_price(p_sku_id uuid, p_price_list_code text, p_price numeric, p_effective_from date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_list uuid; v_from date := coalesce(p_effective_from, today_ist());
begin
  perform require_role('admin');
  select id into v_list from price_lists where code = p_price_list_code;
  if v_list is null then raise exception 'Unknown price list %', p_price_list_code; end if;
  if p_price is null or p_price < 0 then raise exception 'Price must be zero or more'; end if;

  update price_list_items set effective_to = v_from - 1
   where price_list_id = v_list and sku_id = p_sku_id and effective_from < v_from
     and (effective_to is null or effective_to >= v_from);
  insert into price_list_items (price_list_id, sku_id, price, effective_from)
  values (v_list, p_sku_id, p_price, v_from)
  on conflict (price_list_id, sku_id, effective_from) do update set price = excluded.price;
  return jsonb_build_object('ok', true);
end; $$;

-- ---------------------------------------------------------------------
-- Batches
-- ---------------------------------------------------------------------
create or replace function create_batch(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := require_role('manager', 'warehouse');
  v_sku uuid := (p->>'sku_id')::uuid;
  v_mfg date := coalesce(nullif(p->>'manufactured_on', '')::date, today_ist());
  v_exp date := nullif(p->>'expires_on', '')::date;
  v_life int;
  v_b batches%rowtype;
begin
  if v_exp is null then
    select pr.shelf_life_days into v_life from skus s join products pr on pr.id = s.product_id where s.id = v_sku;
    if v_life is null then raise exception 'Enter an expiry date (product has no shelf life set)'; end if;
    v_exp := v_mfg + v_life;
  end if;
  insert into batches (sku_id, manufacturer_partner_id, external_lot_no, manufactured_on, packed_on, expires_on,
                       quantity_produced, unit_cost, qa_status, qa_notes, created_by)
  values (v_sku, nullif(p->>'manufacturer_partner_id', '')::uuid, nullif(p->>'external_lot_no', ''),
          v_mfg, nullif(p->>'packed_on', '')::date, v_exp, nullif(p->>'quantity_produced', '')::numeric,
          nullif(p->>'unit_cost', '')::numeric,
          coalesce(nullif(p->>'qa_status', '')::qa_status, 'released'), nullif(p->>'qa_notes', ''), v_uid)
  returning * into v_b;
  return jsonb_build_object('batch_id', v_b.id, 'batch_code', v_b.code, 'expires_on', v_b.expires_on);
end; $$;

-- Quality decision on a batch. Releasing quarantined stock is manager/admin only.
create or replace function set_batch_qa(p_batch_id uuid, p_status qa_status, p_notes text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform require_role('manager');
  if coalesce(trim(p_notes), '') = '' then raise exception 'Record a reason for the quality decision'; end if;
  update batches set qa_status = p_status,
         qa_notes = coalesce(qa_notes || E'\n', '') || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') || ' ' || p_status || ': ' || p_notes
   where id = p_batch_id;
  if not found then raise exception 'Batch not found'; end if;
  return jsonb_build_object('ok', true);
end; $$;

-- ---------------------------------------------------------------------
-- Receive stock (purchase, own production, contract manufacturer)
-- ---------------------------------------------------------------------
create or replace function receive_stock(
  p_sku_id uuid, p_batch_id uuid, p_location_id uuid, p_qty numeric,
  p_source text default 'production',          -- 'production' | 'contract_manufacturer' | 'purchase' | 'opening_balance'
  p_notes text default null,
  p_idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_txn uuid; v_batch_sku uuid; v_tracked boolean; v_unblocked jsonb;
begin
  perform require_role('manager', 'warehouse');
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be more than zero'; end if;
  select pr.is_batch_tracked into v_tracked from skus s join products pr on pr.id = s.product_id where s.id = p_sku_id;
  if v_tracked is null then raise exception 'Unknown SKU'; end if;
  if v_tracked and p_batch_id is null then raise exception 'This product is batch-tracked: select or create a batch'; end if;
  if p_batch_id is not null then
    select sku_id into v_batch_sku from batches where id = p_batch_id;
    if v_batch_sku is distinct from p_sku_id then raise exception 'That batch belongs to a different SKU'; end if;
  end if;

  v_txn := post_stock_txn(
    case when p_source in ('production', 'contract_manufacturer') then 'production_receipt' else 'goods_receipt' end::stock_txn_type,
    jsonb_build_array(jsonb_build_object('sku_id', p_sku_id, 'batch_id', p_batch_id, 'location_id', p_location_id,
      'owner_id', company_owner_id(), 'status', 'available', 'qty', p_qty)),
    coalesce(p_source, 'receipt') || coalesce(': ' || p_notes, ''), 'batch', p_batch_id, p_idempotency_key, true, false);

  -- (separate statement so the availability below sees the new reservations)
  v_unblocked := reserve_waiting_orders(p_sku_id, p_location_id);
  return jsonb_build_object('transaction_id', v_txn,
    'transaction_code', (select code from stock_transactions where id = v_txn),
    'orders_unblocked', v_unblocked,
    'atp', atp_qty(p_sku_id, p_location_id));
end; $$;

-- ---------------------------------------------------------------------
-- Stock transfer between locations, recording whether ownership changes.
--   p_ownership = 'keep'       -> physical move only (e.g. consignment to a distributor,
--                                 stock sent to a contract manufacturer)
--   p_ownership = 'to_partner' -> outright sale: owner becomes the destination's partner
-- ---------------------------------------------------------------------
create or replace function transfer_stock(
  p_sku_id uuid, p_batch_id uuid, p_from_location uuid, p_to_location uuid, p_qty numeric,
  p_ownership text default 'keep', p_from_owner uuid default null, p_status stock_status default 'available',
  p_reason text default null, p_idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_from_owner uuid := coalesce(p_from_owner, company_owner_id());
  v_to_owner uuid;
  v_to_partner uuid;
  v_txn uuid;
begin
  perform require_role('manager', 'warehouse');
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be more than zero'; end if;
  if p_from_location = p_to_location then raise exception 'Choose two different locations'; end if;

  if p_ownership = 'to_partner' then
    select partner_id into v_to_partner from locations where id = p_to_location;
    if v_to_partner is null then raise exception 'Ownership can only transfer to a partner-operated location'; end if;
    v_to_owner := owner_for_partner(v_to_partner);
  elsif p_ownership = 'keep' then
    v_to_owner := v_from_owner;
  else
    raise exception 'p_ownership must be keep or to_partner';
  end if;

  perform lock_sku_location(p_sku_id, p_from_location);
  -- Don't let a transfer consume stock already promised to customer orders.
  if v_from_owner = company_owner_id() and p_status = 'available' and batch_is_sellable(p_batch_id)
     and p_qty > atp_qty(p_sku_id, p_from_location) then
    raise exception 'Only % units are free to transfer; the rest are reserved for orders',
      greatest(atp_qty(p_sku_id, p_from_location), 0);
  end if;

  v_txn := post_stock_txn(
    case when v_to_owner <> v_from_owner then 'ownership_transfer' else 'transfer' end::stock_txn_type,
    jsonb_build_array(
      jsonb_build_object('sku_id', p_sku_id, 'batch_id', p_batch_id, 'location_id', p_from_location,
        'owner_id', v_from_owner, 'status', p_status, 'qty', -p_qty),
      jsonb_build_object('sku_id', p_sku_id, 'batch_id', p_batch_id, 'location_id', p_to_location,
        'owner_id', v_to_owner, 'status', p_status, 'qty', p_qty)),
    p_reason, null, null, p_idempotency_key, true, v_to_owner <> v_from_owner);

  return jsonb_build_object('transaction_id', v_txn,
    'transaction_code', (select code from stock_transactions where id = v_txn),
    'ownership_changed', v_to_owner <> v_from_owner);
end; $$;

-- Status change (e.g. available -> damaged / quarantine / expired, or back)
create or replace function change_stock_status(
  p_sku_id uuid, p_batch_id uuid, p_location_id uuid, p_from stock_status, p_to stock_status,
  p_qty numeric, p_reason text, p_owner_id uuid default null, p_idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_owner uuid := coalesce(p_owner_id, company_owner_id()); v_txn uuid;
begin
  perform require_role('manager');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be more than zero'; end if;
  if p_from in ('packed') or p_to in ('packed') then raise exception 'Packed stock changes only through packing'; end if;
  perform lock_sku_location(p_sku_id, p_location_id);
  if p_from = 'available' and v_owner = company_owner_id() and batch_is_sellable(p_batch_id)
     and p_qty > atp_qty(p_sku_id, p_location_id) then
    raise exception 'Only % units are free; the rest are reserved for orders', greatest(atp_qty(p_sku_id, p_location_id), 0);
  end if;
  v_txn := post_stock_txn('status_change', jsonb_build_array(
      jsonb_build_object('sku_id', p_sku_id, 'batch_id', p_batch_id, 'location_id', p_location_id,
        'owner_id', v_owner, 'status', p_from, 'qty', -p_qty),
      jsonb_build_object('sku_id', p_sku_id, 'batch_id', p_batch_id, 'location_id', p_location_id,
        'owner_id', v_owner, 'status', p_to, 'qty', p_qty)),
    p_reason, null, null, p_idempotency_key);
  return jsonb_build_object('transaction_id', v_txn);
end; $$;

-- Manual adjustment (stock count difference, write-off). Who, when and why are recorded.
create or replace function adjust_stock(
  p_sku_id uuid, p_batch_id uuid, p_location_id uuid, p_qty_delta numeric, p_reason text,
  p_status stock_status default 'available', p_owner_id uuid default null, p_idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_txn uuid; v_owner uuid := coalesce(p_owner_id, company_owner_id());
begin
  perform require_role('manager');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required for every adjustment'; end if;
  if p_qty_delta is null or p_qty_delta = 0 then raise exception 'Adjustment quantity cannot be zero'; end if;
  if p_status = 'packed' then raise exception 'Packed stock changes only through packing'; end if;
  perform lock_sku_location(p_sku_id, p_location_id);
  if p_qty_delta < 0 and p_status = 'available' and v_owner = company_owner_id() and batch_is_sellable(p_batch_id)
     and -p_qty_delta > atp_qty(p_sku_id, p_location_id) then
    raise exception 'Only % units are free; the rest are reserved for orders', greatest(atp_qty(p_sku_id, p_location_id), 0);
  end if;
  v_txn := post_stock_txn('adjustment', jsonb_build_array(
      jsonb_build_object('sku_id', p_sku_id, 'batch_id', p_batch_id, 'location_id', p_location_id,
        'owner_id', v_owner, 'status', p_status, 'qty', p_qty_delta)),
    p_reason, null, null, p_idempotency_key);
  return jsonb_build_object('transaction_id', v_txn, 'transaction_code', (select code from stock_transactions where id = v_txn));
end; $$;

-- ---------------------------------------------------------------------
-- Reservations
-- All-or-nothing per order. SKUs are locked in a fixed order to avoid
-- deadlocks; the lock makes "two buyers, one last packet" safe.
-- ---------------------------------------------------------------------
create or replace function reserve_order_stock(p_order_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_loc uuid; r record; v_ok boolean := true;
begin
  select fulfilment_location_id into v_loc from orders where id = p_order_id;
  if exists (select 1 from stock_reservations where order_id = p_order_id and status = 'active') then
    return true;
  end if;
  for r in select sku_id, sum(qty) as qty from order_lines where order_id = p_order_id group by sku_id order by sku_id loop
    perform lock_sku_location(r.sku_id, v_loc);
    if atp_qty(r.sku_id, v_loc) < r.qty then v_ok := false; end if;
  end loop;

  if v_ok then
    insert into stock_reservations (order_id, order_line_id, sku_id, location_id, qty)
    select p_order_id, id, sku_id, v_loc, qty from order_lines where order_id = p_order_id;
  end if;
  update orders set stock_shortfall = not v_ok where id = p_order_id;
  return v_ok;
end; $$;

-- After new stock arrives, reserve it for orders that were waiting, oldest first.
create or replace function reserve_waiting_orders(p_sku_id uuid, p_location_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; v_done jsonb := '[]'::jsonb;
begin
  for r in select o.id, o.code from orders o
            where o.stock_shortfall and o.status in ('pending_payment', 'confirmed')
              and o.fulfilment_location_id = p_location_id
              and exists (select 1 from order_lines l where l.order_id = o.id and l.sku_id = p_sku_id)
            order by o.placed_at loop
    if reserve_order_stock(r.id) then v_done := v_done || to_jsonb(r.code); end if;
  end loop;
  return v_done;
end; $$;

create or replace function release_order_reservations(p_order_id uuid)
returns void language sql security definer set search_path = public as $$
  update stock_reservations set status = 'released', closed_at = now()
   where order_id = p_order_id and status = 'active'
$$;

-- Retry reservation for an order that was short of stock (after restocking)
create or replace function retry_order_reservation(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  perform require_role('manager', 'warehouse');
  if not exists (select 1 from orders where id = p_order_id and status in ('pending_payment', 'confirmed') and stock_shortfall) then
    raise exception 'Order is not waiting for stock';
  end if;
  v_ok := reserve_order_stock(p_order_id);
  return jsonb_build_object('reserved', v_ok);
end; $$;

-- ---------------------------------------------------------------------
-- Customers (dedupe: external ref -> email -> phone)
-- ---------------------------------------------------------------------
create or replace function upsert_customer(p_source text, c jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_email text := lower(trim(nullif(c->>'email', '')));
  v_phone text := right(regexp_replace(coalesce(c->>'phone', ''), '\D', '', 'g'), 10);
begin
  if nullif(c->>'external_id', '') is not null then
    select customer_id into v_id from customer_external_refs where source = p_source and external_id = c->>'external_id';
  end if;
  if v_id is null and v_email is not null then
    select id into v_id from customers where email_norm = v_email order by created_at limit 1;
  end if;
  if v_id is null and length(v_phone) = 10 then
    select id into v_id from customers where phone_norm = v_phone order by created_at limit 1;
  end if;

  if v_id is null then
    insert into customers (full_name, phone, email, city, state, pincode)
    values (coalesce(nullif(c->>'name', ''), 'Website customer'), nullif(c->>'phone', ''), v_email,
            c->>'city', c->>'state', c->>'pincode')
    returning id into v_id;
  else
    update customers set
      phone = coalesce(phone, nullif(c->>'phone', '')),
      email = coalesce(email, v_email),
      city = coalesce(nullif(c->>'city', ''), city),
      state = coalesce(nullif(c->>'state', ''), state),
      pincode = coalesce(nullif(c->>'pincode', ''), pincode)
    where id = v_id;
  end if;

  if nullif(c->>'external_id', '') is not null then
    insert into customer_external_refs (customer_id, source, external_id)
    values (v_id, p_source, c->>'external_id') on conflict (source, external_id) do nothing;
  end if;

  if c ? 'marketing_consent' and jsonb_typeof(c->'marketing_consent') = 'boolean' then
    insert into customer_consents (customer_id, purpose, granted, source)
    values (v_id, 'marketing_email', (c->>'marketing_consent')::boolean, p_source);
  end if;
  return v_id;
end; $$;

-- ---------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------
create or replace function refresh_payment_status(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_paid numeric; v_refunded numeric; v_total numeric; v_cod boolean;
begin
  select coalesce(sum(amount) filter (where kind = 'payment'), 0),
         coalesce(sum(amount) filter (where kind = 'refund'), 0)
    into v_paid, v_refunded from payments where order_id = p_order_id;
  select total_amount, payment_status = 'cod_pending' into v_total, v_cod from orders where id = p_order_id;
  update orders set payment_status = case
      when v_refunded > 0 and v_refunded >= v_paid then 'refunded'
      when v_refunded > 0 then 'partially_refunded'
      when v_paid >= v_total then 'paid'
      when v_cod then 'cod_pending'
      else 'unpaid' end::payment_status,
    status = case when status = 'pending_payment' and v_paid >= v_total then 'confirmed'::order_status else status end
   where id = p_order_id;
end; $$;

create or replace function insert_payment(p_order_id uuid, p_kind payment_kind, p_amount numeric, p_method text,
  p_gateway text, p_gateway_ref text, p_notes text, p_idempotency_key text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_idempotency_key is not null then
    select id into v_id from payments where idempotency_key = p_idempotency_key;
    if v_id is not null then return v_id; end if;
  end if;
  if p_gateway_ref is not null then
    select id into v_id from payments where gateway is not distinct from p_gateway and gateway_ref = p_gateway_ref and kind = p_kind;
    if v_id is not null then return v_id; end if;
  end if;
  insert into payments (order_id, kind, amount, method, gateway, gateway_ref, notes, idempotency_key, created_by)
  values (p_order_id, p_kind, p_amount, p_method, p_gateway, p_gateway_ref, p_notes, p_idempotency_key, auth.uid())
  returning id into v_id;
  perform refresh_payment_status(p_order_id);
  return v_id;
end; $$;

create or replace function record_payment(p_order_id uuid, p_amount numeric, p_method text,
  p_reference text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform require_role('manager', 'packer', 'warehouse');
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if exists (select 1 from orders where id = p_order_id and status = 'cancelled') then
    raise exception 'Order is cancelled';
  end if;
  v_id := insert_payment(p_order_id, 'payment', p_amount, p_method, 'manual', p_reference, null, p_idempotency_key);
  return jsonb_build_object('payment_id', v_id, 'payment_code', (select code from payments where id = v_id));
end; $$;

create or replace function record_refund(p_order_id uuid, p_amount numeric, p_reference text,
  p_reason text, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_paid numeric; v_refunded numeric; v_id uuid;
begin
  perform require_role('manager');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required for a refund'; end if;
  if p_idempotency_key is not null and exists (select 1 from payments where idempotency_key = p_idempotency_key) then
    select id into v_id from payments where idempotency_key = p_idempotency_key;
    return jsonb_build_object('payment_id', v_id, 'duplicate', true);
  end if;
  select coalesce(sum(amount) filter (where kind = 'payment'), 0), coalesce(sum(amount) filter (where kind = 'refund'), 0)
    into v_paid, v_refunded from payments where order_id = p_order_id;
  if p_amount is null or p_amount <= 0 then raise exception 'Refund amount must be more than zero'; end if;
  if p_amount > v_paid - v_refunded then
    raise exception 'Refund (%) exceeds the amount still held (%)', p_amount, v_paid - v_refunded;
  end if;
  v_id := insert_payment(p_order_id, 'refund', p_amount, 'refund', 'manual', p_reference, p_reason, p_idempotency_key);
  return jsonb_build_object('payment_id', v_id, 'payment_code', (select code from payments where id = v_id),
    'payment_status', (select payment_status from orders where id = p_order_id));
end; $$;

-- ---------------------------------------------------------------------
-- Order intake — the single entry point for website / WhatsApp / manual orders.
--
-- Canonical payload:
-- { "external_order_id": "1042", "channel": "WEB", "placed_at": "…",
--   "customer": {"external_id","name","phone","email","city","state","pincode","marketing_consent"},
--   "ship_to":  {"name","phone","address1","address2","city","state","pincode"},
--   "lines":    [{"sku_code" | "gtin", "qty", "unit_price"}],
--   "shipping_amount", "discount_amount", "total_amount" (storefront's total, cross-checked),
--   "payment": {"status": "paid"|"unpaid"|"cod", "amount", "method", "gateway", "gateway_ref"},
--   "notes" }
--
-- Idempotent on (source, event_id) and on (source, external_order_id):
-- a retried or duplicated webhook returns the existing order.
-- Failures are logged in integration_events for the reconciliation report.
-- ---------------------------------------------------------------------
create or replace function ingest_order(p_source text, p_event_id text, p_payload jsonb, p_event_type text default 'order.created')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_event integration_events%rowtype;
  v_order orders%rowtype;
  v_channel uuid; v_customer uuid; v_loc uuid; v_le uuid;
  v_line jsonb; v_sku record; v_n int := 0;
  v_price numeric; v_qty numeric; v_disc numeric; v_total numeric; v_tax numeric;
  v_pay jsonb := p_payload->'payment';
  v_reserved boolean;
  v_err text;
begin
  if v_jwt_role <> 'service_role' then
    perform require_role('admin');     -- admins may enter/simulate orders from the app
  end if;
  if coalesce(p_source, '') = '' or coalesce(p_event_id, '') = '' then
    raise exception 'source and event_id are required';
  end if;

  perform pg_advisory_xact_lock(hashtext('ingest:' || p_source || ':' || p_event_id)::bigint);

  select * into v_event from integration_events where source = p_source and event_id = p_event_id;
  if v_event.id is not null and v_event.status in ('processed', 'duplicate') then
    return jsonb_build_object('ok', true, 'duplicate', true, 'order_id', v_event.order_id,
      'order_code', (select code from orders where id = v_event.order_id));
  end if;

  if v_event.id is null then
    insert into integration_events (source, event_id, event_type, payload)
    values (p_source, p_event_id, p_event_type, p_payload) returning * into v_event;
  else
    update integration_events set attempts = attempts + 1, payload = p_payload, status = 'received', error = null
     where id = v_event.id;
  end if;

  -- Same order delivered under a different event id?
  if nullif(p_payload->>'external_order_id', '') is not null then
    select * into v_order from orders where external_source = p_source and external_order_id = p_payload->>'external_order_id';
    if v_order.id is not null then
      update integration_events set status = 'duplicate', order_id = v_order.id, processed_at = now() where id = v_event.id;
      return jsonb_build_object('ok', true, 'duplicate', true, 'order_id', v_order.id, 'order_code', v_order.code);
    end if;
  end if;

  begin
    select id into v_channel from sales_channels where code = coalesce(nullif(p_payload->>'channel', ''), 'WEB');
    if v_channel is null then raise exception 'Unknown sales channel %', p_payload->>'channel'; end if;
    v_loc := default_location_id();
    if v_loc is null then raise exception 'No default fulfilment location is configured'; end if;
    select id into v_le from legal_entities order by created_at limit 1;
    if jsonb_typeof(p_payload->'lines') <> 'array' or jsonb_array_length(p_payload->'lines') = 0 then
      raise exception 'Order has no lines';
    end if;

    v_customer := upsert_customer(p_source, coalesce(p_payload->'customer', '{}'::jsonb));

    insert into orders (kind, legal_entity_id, channel_id, customer_id, fulfilment_location_id, ship_to,
                        shipping_amount, discount_amount, external_total, external_source, external_order_id, notes, placed_at,
                        payment_status, created_by)
    values ('consumer', v_le, v_channel, v_customer, v_loc, coalesce(p_payload->'ship_to', '{}'::jsonb),
            coalesce(nullif(p_payload->>'shipping_amount', '')::numeric, 0),
            coalesce(nullif(p_payload->>'discount_amount', '')::numeric, 0),
            nullif(p_payload->>'total_amount', '')::numeric,
            p_source, nullif(p_payload->>'external_order_id', ''), p_payload->>'notes',
            coalesce(nullif(p_payload->>'placed_at', '')::timestamptz, now()),
            case when v_pay->>'status' = 'cod' then 'cod_pending' else 'unpaid' end::payment_status,
            auth.uid())
    returning * into v_order;

    for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
      v_n := v_n + 1;
      select s.id, s.mrp, coalesce(t.gst_rate, 0) as gst_rate, coalesce(g.units_per_pack, 1) as units
        into v_sku
        from skus s
        join products pr on pr.id = s.product_id
        left join tax_rates t on t.id = pr.tax_rate_id
        left join gtins g on g.sku_id = s.id and nullif(v_line->>'gtin', '') is not null
                         and ltrim(g.gtin, '0') = ltrim(v_line->>'gtin', '0')
       where (nullif(v_line->>'sku_code', '') is not null and upper(s.code) = upper(v_line->>'sku_code'))
          or (nullif(v_line->>'gtin', '') is not null and g.id is not null)
       limit 1;
      if v_sku.id is null then
        raise exception 'Line %: unknown product % %', v_n, coalesce(v_line->>'sku_code', ''), coalesce(v_line->>'gtin', '');
      end if;
      v_qty := (v_line->>'qty')::numeric * v_sku.units;
      if v_qty is null or v_qty <= 0 then raise exception 'Line %: quantity must be more than zero', v_n; end if;
      v_price := coalesce(nullif(v_line->>'unit_price', '')::numeric / v_sku.units,
                          get_price(v_sku.id, 'WEB'), v_sku.mrp);
      if v_price is null then raise exception 'Line %: no price available', v_n; end if;
      v_disc := coalesce(nullif(v_line->>'discount_amount', '')::numeric, 0);
      v_total := round(v_qty * v_price - v_disc, 2);
      v_tax := round(v_total * v_sku.gst_rate / (100 + v_sku.gst_rate), 2);
      insert into order_lines (order_id, line_no, sku_id, qty, unit_price, discount_amount, tax_rate, tax_amount, line_total,
                               price_list_id)
      values (v_order.id, v_n, v_sku.id, v_qty, v_price, v_disc, v_sku.gst_rate, v_tax, v_total,
              (select id from price_lists where code = 'WEB'));
    end loop;

    update orders o set
      subtotal = x.sub, tax_amount = x.tax,
      total_amount = x.sub - o.discount_amount + o.shipping_amount
    from (select sum(line_total) sub, sum(tax_amount) tax from order_lines where order_id = v_order.id) x
    where o.id = v_order.id
    returning o.* into v_order;

    v_reserved := reserve_order_stock(v_order.id);

    if v_pay->>'status' = 'paid' then
      perform insert_payment(v_order.id, 'payment',
        coalesce(nullif(v_pay->>'amount', '')::numeric, v_order.total_amount),
        v_pay->>'method', coalesce(v_pay->>'gateway', p_source), v_pay->>'gateway_ref', null,
        'ingest:' || p_source || ':' || p_event_id);
    elsif v_pay->>'status' = 'cod' then
      update orders set status = 'confirmed' where id = v_order.id;
    end if;

    update integration_events set status = 'processed', order_id = v_order.id, processed_at = now(), error = null
     where id = v_event.id;

    select * into v_order from orders where id = v_order.id;
    return jsonb_build_object('ok', true, 'duplicate', false, 'order_id', v_order.id, 'order_code', v_order.code,
      'status', v_order.status, 'payment_status', v_order.payment_status, 'stock_reserved', v_reserved,
      'total_amount', v_order.total_amount);
  exception when others then
    get stacked diagnostics v_err = message_text;
    update integration_events set status = 'failed', error = v_err where id = v_event.id;
    return jsonb_build_object('ok', false, 'error', v_err, 'event_id', p_event_id);
  end;
end; $$;

-- Payment confirmation from the website/gateway (webhook) for an existing order
create or replace function ingest_payment(p_source text, p_event_id text, p_external_order_id text, p_payment jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_order orders%rowtype; v_id uuid;
begin
  if v_jwt_role <> 'service_role' then perform require_role('admin'); end if;
  select * into v_order from orders where external_source = p_source and external_order_id = p_external_order_id;
  if v_order.id is null then
    insert into integration_events (source, event_id, event_type, payload, status, error)
    values (p_source, p_event_id, 'payment', p_payment, 'failed', 'Order ' || p_external_order_id || ' not found')
    on conflict (source, event_id) do update set attempts = integration_events.attempts + 1;
    return jsonb_build_object('ok', false, 'error', 'order not found');
  end if;
  v_id := insert_payment(v_order.id, coalesce(p_payment->>'kind', 'payment')::payment_kind,
            coalesce(nullif(p_payment->>'amount', '')::numeric, v_order.total_amount),
            p_payment->>'method', coalesce(p_payment->>'gateway', p_source), p_payment->>'gateway_ref', null,
            'ingest:' || p_source || ':' || p_event_id);
  insert into integration_events (source, event_id, event_type, payload, status, order_id, processed_at)
  values (p_source, p_event_id, 'payment', p_payment, 'processed', v_order.id, now())
  on conflict (source, event_id) do update set attempts = integration_events.attempts + 1;
  return jsonb_build_object('ok', true, 'payment_id', v_id);
end; $$;

-- ---------------------------------------------------------------------
-- Packing
-- ---------------------------------------------------------------------
create or replace function order_is_packable(o orders)
returns boolean language sql stable as $$
  select o.status in ('confirmed', 'packing') and not o.stock_shortfall
     and o.payment_status in ('paid', 'cod_pending')
$$;

-- Units of a batch already claimed by scans on orders that are not yet packed
create or replace function batch_scanned_unpacked(p_batch uuid, p_location uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(s.qty), 0)
    from pack_scans s join orders o on o.id = s.order_id
   where s.batch_id = p_batch and s.result = 'accepted'
     and o.status in ('confirmed', 'packing') and o.fulfilment_location_id = p_location
$$;

create or replace function line_scanned_qty(p_line uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(qty), 0) from pack_scans where order_line_id = p_line and result = 'accepted'
$$;

create or replace function pack_scan(
  p_order_id uuid, p_code text, p_batch_code text default null,
  p_manual_batch boolean default false, p_idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := require_role('packer', 'warehouse', 'manager');
  v_order orders%rowtype;
  v_res jsonb; v_bres jsonb;
  v_sku_id uuid; v_batch batches%rowtype; v_units numeric;
  v_line order_lines%rowtype; v_tracked boolean;
  v_result scan_result; v_msg text; v_scan uuid; v_free numeric;
begin
  if p_idempotency_key is not null then
    select id into v_scan from pack_scans where idempotency_key = p_idempotency_key;
    if v_scan is not null then
      return (select jsonb_build_object('result', result, 'message', message, 'scan_id', id, 'duplicate', true,
                                        'order', get_order(order_id)) from pack_scans where id = v_scan);
    end if;
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  if not order_is_packable(v_order) then
    v_result := 'order_not_packable';
    v_msg := case
      when v_order.stock_shortfall then 'Order is waiting for stock'
      when v_order.status = 'pending_payment' then 'Order is not paid yet'
      else 'Order is ' || v_order.status end;
  else
    v_res := resolve_scan(p_code);
    if v_res->>'kind' = 'mismatch' then
      v_result := 'wrong_product'; v_msg := v_res->>'message';
    elsif v_res->>'kind' = 'unknown' then
      v_result := 'unknown_code'; v_msg := 'Code not recognised: ' || coalesce(p_code, '');
    else
      v_sku_id := (v_res->'sku'->>'id')::uuid;
      v_units := coalesce((v_res->>'units')::numeric, 1);
      v_tracked := (v_res->'sku'->>'is_batch_tracked')::boolean;

      if v_res->'batch' is not null and jsonb_typeof(v_res->'batch') = 'object' then
        select * into v_batch from batches where id = (v_res->'batch'->>'id')::uuid;
      elsif nullif(p_batch_code, '') is not null then
        v_bres := resolve_scan(p_batch_code);
        if v_bres->>'kind' <> 'batch' then
          v_result := 'unknown_code'; v_msg := 'Batch label not recognised: ' || p_batch_code;
        elsif (v_bres->'sku'->>'id')::uuid <> v_sku_id then
          v_result := 'wrong_product'; v_msg := 'That batch label belongs to ' || (v_bres->'sku'->>'name');
        else
          select * into v_batch from batches where id = (v_bres->'batch'->>'id')::uuid;
        end if;
      end if;

      if v_result is null then
        select * into v_line from order_lines
         where order_id = p_order_id and sku_id = v_sku_id
           and line_scanned_qty(id) < qty
         order by line_no limit 1;
        if v_line.id is null then
          if exists (select 1 from order_lines where order_id = p_order_id and sku_id = v_sku_id) then
            v_result := 'excess_quantity'; v_msg := 'Already scanned enough of ' || (v_res->'sku'->>'name');
          else
            v_result := 'wrong_product'; v_msg := (v_res->'sku'->>'name') || ' is not in this order';
          end if;
        elsif line_scanned_qty(v_line.id) + v_units > v_line.qty then
          v_result := 'excess_quantity'; v_msg := 'This would exceed the ordered quantity';
        elsif v_tracked and v_batch.id is null then
          -- Not an error: ask the packer for the batch label. Not recorded as a scan.
          return jsonb_build_object('result', 'batch_required', 'message', 'Scan the batch label for ' || (v_res->'sku'->>'name'),
            'sku', v_res->'sku',
            'eligible_batches', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'expires_on', b.expires_on,
                                   'free', sellable_qty(b.sku_id, v_order.fulfilment_location_id, b.id) - batch_scanned_unpacked(b.id, v_order.fulfilment_location_id))
                                   order by b.expires_on), '[]'::jsonb)
                                   from batches b where b.sku_id = v_sku_id
                                    and sellable_qty(b.sku_id, v_order.fulfilment_location_id, b.id) - batch_scanned_unpacked(b.id, v_order.fulfilment_location_id) > 0));
        elsif v_batch.id is not null and v_batch.expires_on < today_ist() then
          v_result := 'batch_expired'; v_msg := 'Batch ' || v_batch.code || ' expired on ' || v_batch.expires_on;
        elsif v_batch.id is not null and v_batch.qa_status <> 'released' then
          v_result := 'batch_not_released'; v_msg := 'Batch ' || v_batch.code || ' is ' || v_batch.qa_status || ' — do not pack';
        else
          if v_batch.id is not null then
            v_free := sellable_qty(v_sku_id, v_order.fulfilment_location_id, v_batch.id)
                      - batch_scanned_unpacked(v_batch.id, v_order.fulfilment_location_id);
          else
            v_free := sellable_qty(v_sku_id, v_order.fulfilment_location_id);
          end if;
          if v_free < v_units then
            v_result := 'insufficient_batch_stock';
            v_msg := 'System shows no free stock of ' || coalesce('batch ' || v_batch.code, 'this product') || ' here. Check the batch label.';
          else
            v_result := 'accepted';
            v_msg := (v_res->'sku'->>'name') || coalesce(' · ' || v_batch.code, '') || ' ✓';
          end if;
        end if;
      end if;
    end if;
  end if;

  insert into pack_scans (order_id, order_line_id, sku_id, batch_id, scanned_code, result, qty, manual_batch,
                          message, idempotency_key, scanned_by)
  values (p_order_id, case when v_result = 'accepted' then v_line.id end, v_sku_id, v_batch.id,
          coalesce(p_code, '') || coalesce(' + ' || p_batch_code, ''), v_result,
          case when v_result = 'accepted' then v_units else 0 end,
          coalesce(p_manual_batch, false) and v_result = 'accepted', v_msg, p_idempotency_key, v_uid)
  returning id into v_scan;

  if v_result = 'accepted' and v_order.status = 'confirmed' then
    update orders set status = 'packing' where id = p_order_id;
  end if;

  return jsonb_build_object('result', v_result, 'message', v_msg, 'scan_id', v_scan, 'order', get_order(p_order_id));
end; $$;

-- Undo an accepted scan (posts a reversing row — nothing is deleted)
create or replace function undo_pack_scan(p_scan_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := require_role('packer', 'warehouse', 'manager'); s pack_scans%rowtype;
begin
  select * into s from pack_scans where id = p_scan_id;
  if s.id is null or s.result <> 'accepted' or s.qty <= 0 then raise exception 'Only an accepted scan can be undone'; end if;
  if exists (select 1 from pack_scans where reverses_scan_id = p_scan_id) then raise exception 'Scan already undone'; end if;
  if not exists (select 1 from orders where id = s.order_id and status in ('confirmed', 'packing')) then
    raise exception 'Order is already packed';
  end if;
  insert into pack_scans (order_id, order_line_id, sku_id, batch_id, scanned_code, result, qty, reverses_scan_id, message, scanned_by)
  values (s.order_id, s.order_line_id, s.sku_id, s.batch_id, s.scanned_code, 'accepted', -s.qty, s.id, 'Undo', v_uid);
  return jsonb_build_object('ok', true, 'order', get_order(s.order_id));
end; $$;

-- All items validated -> move stock available -> packed, consume reservations.
create or replace function complete_packing(p_order_id uuid, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype; v_lines jsonb := '[]'::jsonb; r record; v_txn uuid; v_owner uuid := company_owner_id();
begin
  perform require_role('packer', 'warehouse', 'manager');
  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if v_order.status = 'packed' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'order', get_order(p_order_id));
  end if;
  if not order_is_packable(v_order) then raise exception 'Order cannot be packed (status %)', v_order.status; end if;
  if exists (select 1 from order_lines l where l.order_id = p_order_id and line_scanned_qty(l.id) <> l.qty) then
    raise exception 'Not every item has been scanned yet';
  end if;

  for r in select s.sku_id, s.batch_id, sum(s.qty) qty
             from pack_scans s where s.order_id = p_order_id and s.result = 'accepted'
            group by s.sku_id, s.batch_id order by s.sku_id loop
    perform lock_sku_location(r.sku_id, v_order.fulfilment_location_id);
    v_lines := v_lines
      || jsonb_build_object('sku_id', r.sku_id, 'batch_id', r.batch_id, 'location_id', v_order.fulfilment_location_id,
                            'owner_id', v_owner, 'status', 'available', 'qty', -r.qty)
      || jsonb_build_object('sku_id', r.sku_id, 'batch_id', r.batch_id, 'location_id', v_order.fulfilment_location_id,
                            'owner_id', v_owner, 'status', 'packed', 'qty', r.qty);
  end loop;

  v_txn := post_stock_txn('pack', v_lines, 'Packed order ' || v_order.code, 'order', p_order_id,
                          coalesce(p_idempotency_key, 'pack:' || p_order_id));
  update stock_reservations set status = 'consumed', closed_at = now() where order_id = p_order_id and status = 'active';
  update orders set status = 'packed', packed_at = now() where id = p_order_id;
  return jsonb_build_object('ok', true, 'order', get_order(p_order_id));
end; $$;

-- ---------------------------------------------------------------------
-- Dispatch & delivery
-- ---------------------------------------------------------------------
create or replace function dispatch_order(
  p_order_id uuid, p_provider_code text, p_booking_ref text default null,
  p_tracking_url text default null, p_freight_cost numeric default null, p_idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := require_role('packer', 'warehouse', 'manager');
  v_order orders%rowtype; v_provider delivery_providers%rowtype; v_ship shipments%rowtype;
  v_lines jsonb := '[]'::jsonb; r record;
begin
  if p_idempotency_key is not null then
    select * into v_ship from shipments where idempotency_key = p_idempotency_key;
    if v_ship.id is not null then
      return jsonb_build_object('ok', true, 'duplicate', true, 'shipment_code', v_ship.code, 'order', get_order(v_ship.order_id));
    end if;
  end if;
  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if v_order.status <> 'packed' then raise exception 'Only packed orders can be dispatched (this one is %)', v_order.status; end if;
  select * into v_provider from delivery_providers where code = p_provider_code and active;
  if v_provider.id is null then raise exception 'Choose a delivery provider'; end if;
  if v_provider.code <> 'OWN' and coalesce(trim(p_booking_ref), '') = '' then
    raise exception 'Enter the % booking reference', v_provider.name;
  end if;

  insert into shipments (order_id, provider_id, booking_ref, tracking_url, freight_cost, dispatched_by, idempotency_key)
  values (p_order_id, v_provider.id, nullif(trim(p_booking_ref), ''),
          coalesce(nullif(p_tracking_url, ''), replace(v_provider.tracking_url_template, '{ref}', coalesce(p_booking_ref, ''))),
          p_freight_cost, v_uid, p_idempotency_key)
  returning * into v_ship;

  -- Packed stock leaves inventory (sold to the consumer)
  for r in select s.sku_id, s.batch_id, sum(s.qty) qty from pack_scans s
            where s.order_id = p_order_id and s.result = 'accepted' group by s.sku_id, s.batch_id loop
    v_lines := v_lines || jsonb_build_object('sku_id', r.sku_id, 'batch_id', r.batch_id,
      'location_id', v_order.fulfilment_location_id, 'owner_id', company_owner_id(), 'status', 'packed', 'qty', -r.qty);
  end loop;
  perform post_stock_txn('sale_issue', v_lines, 'Dispatched ' || v_order.code || ' via ' || v_provider.name,
                         'shipment', v_ship.id, 'dispatch:' || p_order_id, true, true);

  update orders set status = 'dispatched', dispatched_at = now() where id = p_order_id;
  return jsonb_build_object('ok', true, 'shipment_code', v_ship.code, 'order', get_order(p_order_id));
end; $$;

create or replace function mark_delivered(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform require_role('packer', 'warehouse', 'manager');
  update shipments set status = 'delivered', delivered_at = now()
   where order_id = p_order_id and status = 'dispatched';
  update orders set status = 'delivered', delivered_at = now()
   where id = p_order_id and status in ('dispatched', 'delivery_failed');
  if not found then raise exception 'Order is not out for delivery'; end if;
  return jsonb_build_object('ok', true, 'order', get_order(p_order_id));
end; $$;

create or replace function mark_delivery_failed(p_order_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform require_role('packer', 'warehouse', 'manager');
  if coalesce(trim(p_reason), '') = '' then raise exception 'Record why delivery failed'; end if;
  update shipments set status = 'failed', failure_reason = p_reason where order_id = p_order_id and status = 'dispatched';
  update orders set status = 'delivery_failed' where id = p_order_id and status = 'dispatched';
  if not found then raise exception 'Order is not out for delivery'; end if;
  return jsonb_build_object('ok', true, 'order', get_order(p_order_id));
end; $$;

-- ---------------------------------------------------------------------
-- Cancellation (before dispatch). Releases reservations; packed goods
-- go back to available stock. Refunds are recorded separately.
-- ---------------------------------------------------------------------
create or replace function cancel_order(p_order_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_lines jsonb := '[]'::jsonb; r record;
begin
  perform require_role('manager');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required to cancel'; end if;
  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if v_order.status = 'cancelled' then return jsonb_build_object('ok', true, 'duplicate', true, 'order', get_order(p_order_id)); end if;
  if v_order.status in ('dispatched', 'delivered', 'delivery_failed') then
    raise exception 'Order has already left the warehouse — record a return instead';
  end if;

  if v_order.status = 'packed' then
    for r in select s.sku_id, s.batch_id, sum(s.qty) qty from pack_scans s
              where s.order_id = p_order_id and s.result = 'accepted' group by s.sku_id, s.batch_id loop
      v_lines := v_lines
        || jsonb_build_object('sku_id', r.sku_id, 'batch_id', r.batch_id, 'location_id', v_order.fulfilment_location_id,
                              'owner_id', company_owner_id(), 'status', 'packed', 'qty', -r.qty)
        || jsonb_build_object('sku_id', r.sku_id, 'batch_id', r.batch_id, 'location_id', v_order.fulfilment_location_id,
                              'owner_id', company_owner_id(), 'status', 'available', 'qty', r.qty);
    end loop;
    perform post_stock_txn('unpack', v_lines, 'Cancelled ' || v_order.code || ': ' || p_reason, 'order', p_order_id,
                           'unpack:' || p_order_id);
  end if;

  perform release_order_reservations(p_order_id);
  update orders set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason where id = p_order_id;
  return jsonb_build_object('ok', true, 'order', get_order(p_order_id),
    'refund_due', (select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0) from payments where order_id = p_order_id));
end; $$;
