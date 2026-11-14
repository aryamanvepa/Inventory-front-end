-- =====================================================================
-- Migration 0008 — Customer storefront (Mia Torte / Nutri Sampoorn shop)
--
-- Three read-only functions; orders still enter only through ingest_order.
--
--   storefront_catalogue()                    anon     — public price list + availability
--   storefront_order_status(code, phone)      anon     — order tracking (status + items only)
--   storefront_quote(lines, event_id, phone)  service  — server-side cart check used by the
--                                                         storefront-order Edge Function
--
-- Nothing here exposes cost, batches, exact stock levels, customers or
-- any other internal data. Prices come from the WEB price list (tax-inclusive).
-- =====================================================================

-- A stock number is shown to shoppers only at or below this level ("Only 3 left").
create or replace function storefront_low_stock_display_cap()
returns int language sql immutable as $$ select 5 $$;

-- Maximum units of one SKU per storefront order (mirrors the Edge Function).
create or replace function storefront_max_line_qty()
returns int language sql immutable as $$ select 20 $$;

-- ---------------------------------------------------------------------
-- Public catalogue: every active, web-priced SKU of an active brand.
-- availability: sold_out (ATP <= 0), low (ATP <= reorder level), in_stock.
-- only_left:    a number only when ATP is at or below the display cap.
-- max_qty:      the most a shopper may add (never more than the line cap).
-- ---------------------------------------------------------------------
create or replace function storefront_catalogue()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_loc uuid := default_location_id();
  v_cap int := storefront_low_stock_display_cap();
  v_max int := storefront_max_line_qty();
begin
  return (select coalesce(jsonb_agg(x order by x->>'brand_code', x->>'category', x->>'product', (x->>'pack_grams')::numeric), '[]'::jsonb) from (
    select jsonb_build_object(
      'code', s.code,
      'name', s.name,
      'product', p.name,
      'brand', b.name,
      'brand_code', b.code,
      'category', cat.name,
      'pack_size', s.pack_size,
      'pack_unit', s.pack_unit,
      'pack_grams', s.pack_size * case s.pack_unit when 'kg' then 1000 when 'l' then 1000 else 1 end,
      'mrp', s.mrp,
      'price', q.price,
      'availability', case when q.atp <= 0 then 'sold_out'
                           when q.atp <= s.reorder_level then 'low'
                           else 'in_stock' end,
      'only_left', case when q.atp > 0 and q.atp <= v_cap then floor(q.atp)::int end,
      'max_qty', case when q.atp <= 0 then 0 when q.atp <= v_cap then floor(q.atp)::int else v_max end
    ) x
    from skus s
    join products p on p.id = s.product_id
    join brands b on b.id = p.brand_id
    left join categories cat on cat.id = p.category_id
    cross join lateral (select get_price(s.id, 'WEB') as price,
                               coalesce(atp_qty(s.id, v_loc), 0) as atp) q
    where s.active and p.active and b.active and q.price is not null
  ) t);
end; $$;

-- ---------------------------------------------------------------------
-- Server-side cart check for the storefront-order Edge Function (service_role only).
--   p_lines    [{sku_code, qty}]
--   p_event_id the client's idempotency key: if that order was already
--              placed, already_placed = true (the stock it reserved is ours).
--   p_phone    shopper's phone, for a simple abuse guard.
-- Returns current WEB prices, the subtotal and any lines that can't be supplied.
-- ---------------------------------------------------------------------
create or replace function storefront_quote(p_lines jsonb, p_event_id text default null, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_loc uuid := default_location_id();
  v_line jsonb; v_sku record; v_qty numeric; v_atp numeric; v_price numeric;
  v_out jsonb := '[]'::jsonb; v_problems jsonb := '[]'::jsonb; v_sub numeric := 0;
  v_phone text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  v_recent int := 0;
begin
  if p_event_id is not null and exists (
       select 1 from integration_events
        where source = 'storefront' and event_id = p_event_id and status in ('processed', 'duplicate')) then
    return jsonb_build_object('already_placed', true);
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Your bag is empty';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := nullif(v_line->>'qty', '')::numeric;
    select s.id, s.code, s.name into v_sku
      from skus s join products p on p.id = s.product_id join brands b on b.id = p.brand_id
     where upper(s.code) = upper(v_line->>'sku_code') and s.active and p.active and b.active;
    v_price := case when v_sku.id is not null then get_price(v_sku.id, 'WEB') end;
    if v_sku.id is null or v_price is null then
      v_problems := v_problems || jsonb_build_object('sku_code', v_line->>'sku_code', 'reason', 'unavailable', 'available', 0);
      continue;
    end if;
    v_atp := greatest(coalesce(atp_qty(v_sku.id, v_loc), 0), 0);
    if v_atp < v_qty then
      v_problems := v_problems || jsonb_build_object('sku_code', v_sku.code, 'name', v_sku.name,
        'reason', case when v_atp = 0 then 'sold_out' else 'insufficient' end,
        'available', least(floor(v_atp), storefront_max_line_qty())::int);
    end if;
    v_out := v_out || jsonb_build_object('sku_code', v_sku.code, 'name', v_sku.name, 'qty', v_qty,
      'unit_price', v_price, 'line_total', round(v_qty * v_price, 2));
    v_sub := v_sub + round(v_qty * v_price, 2);
  end loop;

  if length(v_phone) = 10 then
    select count(*) into v_recent from orders o
     where o.external_source = 'storefront' and o.placed_at > now() - interval '24 hours'
       and right(regexp_replace(coalesce(o.ship_to->>'phone', ''), '\D', '', 'g'), 10) = v_phone;
  end if;

  return jsonb_build_object('already_placed', false, 'lines', v_out, 'subtotal', v_sub,
    'problems', v_problems, 'recent_orders_for_phone', v_recent);
end; $$;

-- ---------------------------------------------------------------------
-- Order tracking for shoppers: needs the order code AND the phone used.
-- A wrong code and a wrong phone give the same answer (found = false).
-- ---------------------------------------------------------------------
create or replace function storefront_order_status(p_order_code text, p_phone text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_phone text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  v_order orders%rowtype;
begin
  if length(v_phone) <> 10 or coalesce(trim(p_order_code), '') = '' then
    return jsonb_build_object('found', false);
  end if;
  select o.* into v_order
    from orders o left join customers c on c.id = o.customer_id
   where upper(o.code) = upper(trim(p_order_code)) and o.kind = 'consumer'
     and (right(regexp_replace(coalesce(o.ship_to->>'phone', ''), '\D', '', 'g'), 10) = v_phone
          or c.phone_norm = v_phone)
   limit 1;
  if v_order.id is null then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object(
    'found', true,
    'code', v_order.code,
    'status', v_order.status,
    'placed_on', (v_order.placed_at at time zone 'Asia/Kolkata')::date,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('sku_code', s.code, 'name', s.name, 'qty', ol.qty) order by ol.line_no), '[]'::jsonb)
                from order_lines ol join skus s on s.id = ol.sku_id where ol.order_id = v_order.id)
  );
end; $$;

-- ---------------------------------------------------------------------
-- Grants: the publishable (anon) key may call exactly the two public
-- read functions; storefront_quote is for the Edge Function only.
-- ---------------------------------------------------------------------
revoke execute on function storefront_low_stock_display_cap() from public, anon, authenticated;
revoke execute on function storefront_max_line_qty() from public, anon, authenticated;
revoke execute on function storefront_quote(jsonb, text, text) from public, anon, authenticated;
grant execute on function storefront_quote(jsonb, text, text) to service_role;
grant execute on function storefront_catalogue() to anon, authenticated, service_role;
grant execute on function storefront_order_status(text, text) to anon, authenticated, service_role;
