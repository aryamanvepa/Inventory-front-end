-- =====================================================================
-- Storefront back end, round 2 (website brief):
--   B1  test orders while testing mode is on
--   B2  fuller order tracking (timeline, shipment, payment, refund, cancel)
--   B3  catalogue: product_code, bestseller_rank, is_new, images
--   B4  product photos in the public Storage bucket "product-images"
--   B5  PIN-code delivery check with an estimated delivery time
--   B6  promo codes (the one new table)
--   B7  customers can cancel (before packing) or ask to cancel (after)
--   B10 "Gifting" category
--   B11 checkout failures logged and surfaced on the dashboard
-- =====================================================================

-- ---------------------------------------------------------------------
-- Settings: where public Storage files are served from (for photo URLs)
-- ---------------------------------------------------------------------
alter table app_settings drop constraint if exists app_settings_key_check;
alter table app_settings add constraint app_settings_key_check check (key in ('testing_mode', 'storage_public_url'));
insert into app_settings (key, value)
values ('storage_public_url', to_jsonb('https://jizhfkithgkkyfymtlfd.supabase.co/storage/v1/object/public'::text))
on conflict (key) do nothing;

-- B10
insert into categories (name) select 'Gifting' where not exists (select 1 from categories where name = 'Gifting');

-- ---------------------------------------------------------------------
-- B4 · Product photos: public bucket, managers upload under Admin → Products
-- Path: <product code>/<n>.<jpg|webp|png>  (n = 1 is the main photo)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function is_catalogue_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(current_staff_role()::text in ('admin', 'manager'), false)
$$;

drop policy if exists product_images_select on storage.objects;
drop policy if exists product_images_insert on storage.objects;
drop policy if exists product_images_update on storage.objects;
drop policy if exists product_images_delete on storage.objects;
create policy product_images_select on storage.objects for select to authenticated
  using (bucket_id = 'product-images' and public.is_catalogue_manager());
create policy product_images_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_catalogue_manager());
create policy product_images_update on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and public.is_catalogue_manager())
  with check (bucket_id = 'product-images' and public.is_catalogue_manager());
create policy product_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.is_catalogue_manager());

create or replace function product_image_urls(p_product_code text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg((select value #>> '{}' from app_settings where key = 'storage_public_url') || '/product-images/' || o.name
                            order by coalesce(substring(o.name from '/(\d+)\.[a-z]+$')::int, 999), o.name), '[]'::jsonb)
    from storage.objects o
   where o.bucket_id = 'product-images' and o.name like p_product_code || '/%'
$$;

-- for the ops screen: each photo's path and URL
create or replace function list_product_images(p_product_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return (select coalesce(jsonb_agg(jsonb_build_object('path', o.name,
            'url', (select value #>> '{}' from app_settings where key = 'storage_public_url') || '/product-images/' || o.name,
            'n', substring(o.name from '/(\d+)\.[a-z]+$')::int)
            order by coalesce(substring(o.name from '/(\d+)\.[a-z]+$')::int, 999), o.name), '[]'::jsonb)
    from storage.objects o where o.bucket_id = 'product-images' and o.name like p_product_code || '/%');
end; $$;

-- ---------------------------------------------------------------------
-- B5 · Delivery by PIN code (rules here until the client wants to edit them)
-- ---------------------------------------------------------------------
create or replace function storefront_delivery_for(p_pincode text)
returns jsonb language plpgsql immutable as $$
declare v text := regexp_replace(coalesce(p_pincode, ''), '\s', '', 'g'); n int;
begin
  if v !~ '^[1-9]\d{5}$' then
    return jsonb_build_object('serviceable', false, 'zone', null, 'carrier', null, 'eta_min_days', null, 'eta_max_days', null,
      'message', 'Enter a valid 6-digit PIN code');
  end if;
  n := v::int;
  if n between 500001 and 500100 then
    return jsonb_build_object('serviceable', true, 'zone', 'local', 'carrier', 'Rapido', 'eta_min_days', 0, 'eta_max_days', 1,
      'message', 'Same or next day in Hyderabad');
  elsif n between 500101 and 509999 then
    return jsonb_build_object('serviceable', true, 'zone', 'national', 'carrier', 'iCarry', 'eta_min_days', 2, 'eta_max_days', 4,
      'message', 'Delivered in 2–4 days');
  elsif n >= 900000 then
    return jsonb_build_object('serviceable', false, 'zone', null, 'carrier', null, 'eta_min_days', null, 'eta_max_days', null,
      'message', 'We can''t deliver to this PIN code yet');
  end if;
  return jsonb_build_object('serviceable', true, 'zone', 'national', 'carrier', 'iCarry', 'eta_min_days', 3, 'eta_max_days', 7,
    'message', 'Delivered in 3–7 days');
end; $$;

-- ---------------------------------------------------------------------
-- B6 · Promo codes
-- ---------------------------------------------------------------------
create table promo_codes (
  code         text primary key check (code ~ '^[A-Z0-9]{3,20}$'),
  kind         text not null check (kind in ('percent', 'flat')),
  value        numeric(10,2) not null check (value > 0),
  min_subtotal numeric(10,2) not null default 0 check (min_subtotal >= 0),
  max_discount numeric(10,2) check (max_discount is null or max_discount > 0),
  starts_at    timestamptz,
  ends_at      timestamptz,
  usage_limit  int check (usage_limit is null or usage_limit > 0),
  used_count   int not null default 0,
  active       boolean not null default true,
  description  text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  check (kind <> 'percent' or value <= 90),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
alter table promo_codes enable row level security;
create trigger audit after insert or update or delete on promo_codes for each row execute function trg_audit();

-- {code, valid, discount, message, error}
create or replace function promo_evaluate(p_code text, p_subtotal numeric)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c promo_codes%rowtype; v_code text := upper(trim(coalesce(p_code, ''))); v_disc numeric;
  bad jsonb := jsonb_build_object('code', upper(trim(coalesce(p_code, ''))), 'valid', false, 'discount', 0);
begin
  select * into c from promo_codes where code = v_code;
  if c.code is null or not c.active or (c.starts_at is not null and c.starts_at > now())
     or (c.usage_limit is not null and c.used_count >= c.usage_limit) then
    return bad || jsonb_build_object('error', 'promo_invalid', 'message', 'This code isn''t valid');
  end if;
  if c.ends_at is not null and c.ends_at <= now() then
    return bad || jsonb_build_object('error', 'promo_expired', 'message', 'This code has expired');
  end if;
  if coalesce(p_subtotal, 0) < c.min_subtotal then
    return bad || jsonb_build_object('error', 'promo_min_subtotal',
      'message', 'Add ₹' || trim(to_char(c.min_subtotal - coalesce(p_subtotal, 0), 'FM999999990.00')) || ' more to use this code');
  end if;
  v_disc := case c.kind when 'percent' then round(p_subtotal * c.value / 100, 2) else c.value end;
  v_disc := least(v_disc, coalesce(c.max_discount, v_disc), p_subtotal);
  return jsonb_build_object('code', c.code, 'valid', true, 'discount', v_disc, 'error', null,
    'message', case c.kind when 'percent' then trim(to_char(c.value, 'FM990.##')) || '% off' else '₹' || trim(to_char(c.value, 'FM999990.##')) || ' off' end
               || coalesce(' — ' || c.description, ''));
end; $$;

-- counted when an order using it is placed (service role, from the checkout)
create or replace function storefront_redeem_promo(p_code text)
returns void language sql security definer set search_path = public as $$
  update promo_codes set used_count = used_count + 1 where code = upper(trim(coalesce(p_code, '')))
$$;

create or replace function list_promo_codes()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_role('manager');
  return (select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object(
      'live', c.active and (c.starts_at is null or c.starts_at <= now()) and (c.ends_at is null or c.ends_at > now())
              and (c.usage_limit is null or c.used_count < c.usage_limit)) order by c.created_at desc), '[]'::jsonb)
    from promo_codes c);
end; $$;

-- p: {code, kind, value, min_subtotal, max_discount, starts_at, ends_at, usage_limit, description, active}
create or replace function save_promo_code(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := require_role('manager'); v_code text := upper(trim(coalesce(p->>'code', '')));
begin
  if v_code !~ '^[A-Z0-9]{3,20}$' then raise exception 'A code is 3–20 letters or numbers, no spaces'; end if;
  insert into promo_codes (code, kind, value, min_subtotal, max_discount, starts_at, ends_at, usage_limit, description, active, created_by)
  values (v_code, p->>'kind', (p->>'value')::numeric, coalesce(nullif(p->>'min_subtotal', '')::numeric, 0),
          nullif(p->>'max_discount', '')::numeric, nullif(p->>'starts_at', '')::timestamptz, nullif(p->>'ends_at', '')::timestamptz,
          nullif(p->>'usage_limit', '')::int, nullif(trim(p->>'description'), ''), coalesce((p->>'active')::boolean, true), v_uid)
  on conflict (code) do update set kind = excluded.kind, value = excluded.value, min_subtotal = excluded.min_subtotal,
    max_discount = excluded.max_discount, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
    usage_limit = excluded.usage_limit, description = excluded.description, active = excluded.active;
  return (select to_jsonb(c) from promo_codes c where code = v_code);
end; $$;

create or replace function set_promo_active(p_code text, p_active boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform require_role('manager');
  update promo_codes set active = p_active where code = upper(trim(p_code));
  if not found then raise exception 'No such code'; end if;
  return jsonb_build_object('code', upper(trim(p_code)), 'active', p_active);
end; $$;

-- ---------------------------------------------------------------------
-- Cart check for the checkout (service role). Adds B1 test flag, B5 delivery
-- and B6 promo; still answers the old 3-argument call.
-- ---------------------------------------------------------------------
drop function if exists storefront_quote(jsonb, text, text);
create or replace function storefront_quote(p_lines jsonb, p_event_id text default null, p_phone text default null,
  p_pincode text default null, p_promo_code text default null, p_test boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_loc uuid := default_location_id();
  v_line jsonb; v_sku record; v_qty numeric; v_atp numeric; v_price numeric;
  v_out jsonb := '[]'::jsonb; v_problems jsonb := '[]'::jsonb; v_sub numeric := 0;
  v_phone text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  v_recent int := 0; v_promo jsonb;
  v_testing boolean := coalesce((select value = 'true'::jsonb from app_settings where key = 'testing_mode'), false);
begin
  if p_event_id is not null and exists (
       select 1 from integration_events
        where source in ('storefront', 'WEB-TEST') and event_id = p_event_id and status in ('processed', 'duplicate')) then
    return jsonb_build_object('already_placed', true, 'testing_mode', v_testing);
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
  if nullif(trim(coalesce(p_promo_code, '')), '') is not null then v_promo := promo_evaluate(p_promo_code, v_sub); end if;

  return jsonb_build_object('already_placed', false, 'lines', v_out, 'subtotal', v_sub,
    'problems', v_problems, 'recent_orders_for_phone', v_recent,
    'discount', coalesce((v_promo->>'discount')::numeric, 0),
    'promo', v_promo,
    'delivery', case when p_pincode is not null then storefront_delivery_for(p_pincode) end,
    'testing_mode', v_testing, 'test', coalesce(p_test, false));
end; $$;

-- ---------------------------------------------------------------------
-- B3 + B4 · Catalogue with product_code, bestseller_rank, is_new, images
-- ---------------------------------------------------------------------
create or replace function storefront_catalogue()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_loc uuid := default_location_id();
  v_cap int := storefront_low_stock_display_cap();
  v_max int := storefront_max_line_qty();
begin
  return (with sold as (
      select s.product_id, sum(ol.qty) units
        from order_lines ol join orders o on o.id = ol.order_id join skus s on s.id = ol.sku_id
       where o.status <> 'cancelled' and coalesce(o.external_source, '') <> 'WEB-TEST' and s.name not like 'TEST%'
         and o.placed_at > now() - interval '90 days'
       group by s.product_id),
    ranked as (select product_id, dense_rank() over (order by units desc)::int rnk from sold)
  select coalesce(jsonb_agg(x order by x->>'brand_code', x->>'category', x->>'product', (x->>'pack_grams')::numeric), '[]'::jsonb) from (
    select jsonb_build_object(
      'code', s.code,
      'name', s.name,
      'product', p.name,
      'product_code', p.code,
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
      'max_qty', case when q.atp <= 0 then 0 when q.atp <= v_cap then floor(q.atp)::int else v_max end,
      'bestseller_rank', (select rnk from ranked where product_id = p.id),
      'is_new', p.created_at > now() - interval '60 days',
      'images', product_image_urls(p.code),
      'details', jsonb_build_object('description', p.description, 'ingredients', p.ingredients, 'allergens', p.allergens,
                   'diet', p.diet, 'nutrition_per_100g', p.nutrition, 'storage', p.storage, 'shelf_life_days', p.shelf_life_days,
                   'confirmed', p.content_confirmed)
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
-- B2 · Order tracking for customers (code + phone; same "not found" either way)
-- ---------------------------------------------------------------------
create or replace function storefront_find_order(p_order_code text, p_phone text)
returns uuid language sql stable security definer set search_path = public as $$
  select o.id from orders o left join customers c on c.id = o.customer_id
   where length(right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10)) = 10
     and upper(o.code) = upper(trim(coalesce(p_order_code, ''))) and o.kind = 'consumer'
     and (right(regexp_replace(coalesce(o.ship_to->>'phone', ''), '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
          or c.phone_norm = right(regexp_replace(p_phone, '\D', '', 'g'), 10))
   limit 1
$$;

create or replace function storefront_order_status(p_order_code text, p_phone text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_order orders%rowtype; v_paid numeric; v_refunded numeric; v_ship record;
begin
  select * into v_order from orders where id = storefront_find_order(p_order_code, p_phone);
  if v_order.id is null then return jsonb_build_object('found', false); end if;
  select coalesce(sum(amount) filter (where kind = 'payment'), 0), coalesce(sum(amount) filter (where kind = 'refund'), 0)
    into v_paid, v_refunded from payments where order_id = v_order.id;
  select dp.name carrier, sh.booking_ref, sh.tracking_url into v_ship
    from shipments sh join delivery_providers dp on dp.id = sh.provider_id
   where sh.order_id = v_order.id order by sh.dispatched_at desc nulls last limit 1;
  return jsonb_build_object(
    'found', true,
    'code', v_order.code,
    'status', v_order.status,
    'placed_on', (v_order.placed_at at time zone 'Asia/Kolkata')::date,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('sku_code', s.code, 'name', s.name, 'qty', ol.qty) order by ol.line_no), '[]'::jsonb)
                from order_lines ol join skus s on s.id = ol.sku_id where ol.order_id = v_order.id),
    'total', v_order.total_amount,
    'payment_status', v_order.payment_status,
    'payment_method', case when v_order.payment_status = 'cod_pending'
                             or exists (select 1 from payments where order_id = v_order.id and kind = 'payment' and method = 'cod')
                           then 'cod' else 'online' end,
    'timeline', jsonb_build_object('placed_at', v_order.placed_at, 'packed_at', v_order.packed_at, 'dispatched_at', v_order.dispatched_at,
                                   'delivered_at', v_order.delivered_at, 'cancelled_at', v_order.cancelled_at),
    'shipment', case when v_ship.carrier is not null then jsonb_build_object('carrier', v_ship.carrier, 'booking_ref', v_ship.booking_ref,
                                                                             'tracking_url', v_ship.tracking_url) end,
    'cancellable', v_order.status in ('pending_payment', 'confirmed', 'packing'),
    'cancel_requested', coalesce(v_order.notes, '') like '%[Cancellation requested%',
    'refund', case when v_refunded > 0 then jsonb_build_object('status', case when v_refunded >= v_paid then 'full' else 'partial' end,
                                                               'amount', v_refunded) end
  );
end; $$;

-- ---------------------------------------------------------------------
-- B7 · Customers cancel (before packing) or ask to cancel (after)
-- cancel_order's body moves to cancel_order_core so the website can use it
-- without a staff login; staff still go through cancel_order (manager check).
-- ---------------------------------------------------------------------
create or replace function cancel_order_core(p_order_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_lines jsonb := '[]'::jsonb; r record;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required to cancel'; end if;
  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if v_order.status = 'cancelled' then return jsonb_build_object('ok', true, 'duplicate', true); end if;
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
  return jsonb_build_object('ok', true,
    'refund_due', (select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0) from payments where order_id = p_order_id));
end; $$;

create or replace function cancel_order(p_order_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  perform require_role('manager');
  r := cancel_order_core(p_order_id, p_reason);        -- separate statement, so the order below is read after the change
  return r || jsonb_build_object('order', get_order(p_order_id));
end; $$;

create or replace function storefront_request_cancellation(p_order_code text, p_phone text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_order orders%rowtype; v_reason text := left(nullif(trim(coalesce(p_reason, '')), ''), 300);
begin
  select * into v_order from orders where id = storefront_find_order(p_order_code, p_phone) for update;
  if v_order.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_order.status = 'cancelled' then return jsonb_build_object('ok', false, 'error', 'already_cancelled'); end if;
  if v_order.status = 'delivered' then return jsonb_build_object('ok', false, 'error', 'delivered'); end if;
  -- a public endpoint: at most 100 cancellation actions an hour across the shop
  if (select count(*) from orders where cancelled_at > now() - interval '1 hour' and cancel_reason like 'Cancelled by customer%') >= 100 then
    return jsonb_build_object('ok', false, 'error', 'try_later');
  end if;
  if v_order.status in ('pending_payment', 'confirmed', 'packing') then
    perform cancel_order_core(v_order.id, 'Cancelled by customer on the website' || coalesce(': ' || v_reason, ''));
    return jsonb_build_object('ok', true, 'result', 'cancelled');
  end if;
  if coalesce(v_order.notes, '') not like '%[Cancellation requested%' then
    update orders set notes = coalesce(notes || E'\n', '') || '[Cancellation requested by customer '
           || to_char(now() at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || coalesce(': ' || v_reason, '') || ']'
     where id = v_order.id;
  end if;
  return jsonb_build_object('ok', true, 'result', 'requested');
end; $$;

-- ---------------------------------------------------------------------
-- Stage 3 · One atomic "place" for the checkout: if the order can't hold its
-- stock (someone else took the last pack a moment ago), the whole order is
-- undone and the shopper is told it sold out. Test orders are made to order.
-- ---------------------------------------------------------------------
create or replace function storefront_place_order(p_source text, p_event_id text, p_payload jsonb, p_require_stock boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_lines jsonb;
begin
  begin
    r := ingest_order(p_source, p_event_id, p_payload);
    if coalesce((r->>'ok')::boolean, false) and not coalesce((r->>'duplicate')::boolean, false)
       and not coalesce((r->>'stock_reserved')::boolean, true) and p_require_stock then
      raise exception 'storefront_sold_out_race';
    end if;
    return r;
  exception when raise_exception then
    if sqlerrm <> 'storefront_sold_out_race' then raise; end if;
  end;
  -- everything above was rolled back; say what is left now
  select coalesce(jsonb_agg(jsonb_build_object('sku_code', l->>'sku_code', 'qty', (l->>'qty')::numeric)), '[]'::jsonb)
    into v_lines from jsonb_array_elements(p_payload->'lines') l;
  return jsonb_build_object('ok', false, 'error', 'sold_out', 'problems', storefront_quote(v_lines)->'problems');
end; $$;

-- ---------------------------------------------------------------------
-- B11 · Checkout failures (from the storefront-order Edge Function)
-- ---------------------------------------------------------------------
create or replace function storefront_log_failure(p_key text, p_stage text, p_error text, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into integration_events (source, event_id, event_type, payload, status, error)
  values ('storefront-error', left(coalesce(p_key, 'no-key'), 80) || ':' || left(coalesce(p_stage, 'unknown'), 30) || ':' || gen_random_uuid(),
          left(coalesce(p_stage, 'unknown'), 40), coalesce(p_detail, '{}'::jsonb), 'failed', left(coalesce(p_error, ''), 1000))
$$;

-- ---------------------------------------------------------------------
-- Dashboard: customer cancellation requests and repeated checkout failures
-- ---------------------------------------------------------------------
create or replace function get_dashboard(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d jsonb := get_dashboard_core(p_days); v_extra jsonb := '[]'::jsonb; v_counts int; v_fail int; v_loc uuid := default_location_id();
begin
  select count(*) into v_fail from integration_events
   where source in ('storefront', 'storefront-error', 'WEB-TEST') and status = 'failed' and received_at > now() - interval '1 hour';
  if v_fail >= 3 then
    v_extra := v_extra || jsonb_build_object('severity', 'high', 'type', 'checkout_failures',
      'title', v_fail || ' website checkout failures in the last hour', 'detail', 'Shoppers may not be able to order. See Admin → Website orders.', 'ref', null);
  end if;
  v_extra := v_extra || coalesce((select jsonb_agg(jsonb_build_object('severity', 'high', 'type', 'cancel_request',
      'title', o.code || ': customer asked to cancel', 'detail', 'The order is ' || o.status || '. Call the customer, then cancel or record a return.', 'ref', o.id))
    from orders o where coalesce(o.notes, '') like '%[Cancellation requested%' and o.status not in ('cancelled', 'delivered')), '[]'::jsonb);
  if coalesce((select value = 'true'::jsonb from app_settings where key = 'testing_mode'), false) then
    v_extra := v_extra || jsonb_build_object('severity', 'medium', 'type', 'testing_mode',
      'title', 'Testing mode is on', 'detail', 'Every scan screen has Scan override, every order has a scan bypass, and the website can place test orders. An admin turns it off before go-live (More → Testing tools).', 'ref', null);
  end if;
  if (select state_code is null from legal_entities order by created_at limit 1) then
    v_extra := v_extra || jsonb_build_object('severity', 'high', 'type', 'company_gst',
      'title', 'Company GSTIN and state not set', 'detail', 'GST invoices can''t be issued until this is set (Accounts → Company)', 'ref', null);
  end if;
  v_extra := v_extra || coalesce((select jsonb_agg(jsonb_build_object('severity', 'medium', 'type', 'stock_alert',
      'title', x.name || ' is back in stock — ' || x.n || ' customer' || case when x.n = 1 then '' else 's' end || ' waiting',
      'detail', 'Email them, then mark them notified (More → Back-in-stock alerts)', 'ref', x.sku_id) order by x.n desc)
    from (select r.sku_id, s.name, count(*) n from stock_alert_requests r join skus s on s.id = r.sku_id
           where r.status = 'waiting' and atp_qty(r.sku_id, v_loc) > 0 group by r.sku_id, s.name) x), '[]'::jsonb);
  select count(*) into v_counts from stock_counts where status = 'pending';
  if v_counts > 0 then
    v_extra := v_extra || jsonb_build_object('severity', 'medium', 'type', 'stock_count',
      'title', v_counts || ' stock count' || case when v_counts = 1 then '' else 's' end || ' waiting for your OK',
      'detail', 'Staff counted a different number than the system shows (Stock → Counts to check)', 'ref', null);
  end if;
  v_extra := v_extra || coalesce((select jsonb_agg(jsonb_build_object('severity', case when kind in ('invoice_failed', 'posting_failed') then 'high' else 'medium' end,
      'type', 'accounting', 'title', case kind when 'invoice_failed' then 'Invoice not issued' when 'posting_failed' then 'Accounting entry failed'
                                               when 'uncosted_stock' then 'Stock without a cost' else 'Accounts check' end,
      'detail', message, 'ref', id) order by created_at desc)
    from (select * from accounting_exceptions where resolved_at is null order by created_at desc limit 20) e), '[]'::jsonb);
  return jsonb_set(d, '{alerts}', v_extra || (d->'alerts'));
end; $$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on function storefront_catalogue(), storefront_order_status(text, text),
  storefront_notify_me(text, text, boolean, text), storefront_request_cancellation(text, text, text)
  to anon, authenticated, service_role;
grant execute on function storefront_quote(jsonb, text, text, text, text, boolean), storefront_redeem_promo(text),
  storefront_log_failure(text, text, text, jsonb), ingest_order(text, text, jsonb, text),
  storefront_place_order(text, text, jsonb, boolean) to service_role;
revoke execute on function storefront_quote(jsonb, text, text, text, text, boolean), storefront_redeem_promo(text),
  storefront_log_failure(text, text, text, jsonb), cancel_order_core(uuid, text), promo_evaluate(text, numeric),
  storefront_find_order(text, text), product_image_urls(text), storefront_place_order(text, text, jsonb, boolean) from authenticated;
grant execute on function is_catalogue_manager() to authenticated;
grant execute on function list_product_images(text), list_promo_codes(), save_promo_code(jsonb), set_promo_active(text, boolean),
  cancel_order(uuid, text), get_dashboard(int) to authenticated;
