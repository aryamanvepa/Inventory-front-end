-- =====================================================================
-- Shelf life is optional for ops (owner, 2026-11-23)
--
-- Products without a shelf life no longer block Stock in, Make or
-- Receive. When no expiry date is typed and the product has no shelf
-- life, the batch gets today + the default shelf life
-- (app_settings.default_shelf_life_days, admin setting, 1–3650,
-- default 90). A product's own shelf life or a typed expiry still wins.
-- =====================================================================

alter table app_settings drop constraint if exists app_settings_key_check;
alter table app_settings add constraint app_settings_key_check
  check (key in ('testing_mode', 'storage_public_url', 'unpaid_hold_minutes', 'default_shelf_life_days'));
insert into app_settings (key, value) values ('default_shelf_life_days', '90'::jsonb) on conflict (key) do nothing;

create or replace function default_shelf_life_days()
returns int language sql stable security definer set search_path = public as $$
  -- anything odd falls back to 90
  select coalesce((select case when jsonb_typeof(value) = 'number'
                                and round((value #>> '{}')::numeric) between 1 and 3650
                               then round((value #>> '{}')::numeric)::int end
                     from app_settings where key = 'default_shelf_life_days'), 90)
$$;

create or replace function set_app_setting(p_key text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := require_role('admin');
begin
  if p_key = 'testing_mode' and jsonb_typeof(p_value) <> 'boolean' then raise exception 'testing_mode is on or off'; end if;
  if p_key = 'unpaid_hold_minutes' and not (jsonb_typeof(p_value) = 'number'
       and (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
       and (p_value #>> '{}')::numeric between 5 and 1440) then
    raise exception 'The payment hold is a whole number of minutes from 5 to 1440 (24 hours)';
  end if;
  if p_key = 'default_shelf_life_days' and not (jsonb_typeof(p_value) = 'number'
       and (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
       and (p_value #>> '{}')::numeric between 1 and 3650) then
    raise exception 'The default shelf life is a whole number of days from 1 to 3650';
  end if;
  if p_key in ('unpaid_hold_minutes', 'default_shelf_life_days') then
    p_value := to_jsonb(((p_value #>> '{}')::numeric)::int);   -- store 30.0 as 30
  end if;
  insert into app_settings (key, value, updated_at, updated_by) values (p_key, p_value, now(), v_uid)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = v_uid;
  return get_app_settings();
end; $$;

CREATE OR REPLACE FUNCTION public.create_batch(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    v_exp := v_mfg + coalesce(v_life, default_shelf_life_days());   -- no shelf life set: use the default
  end if;
  insert into batches (sku_id, manufacturer_partner_id, external_lot_no, manufactured_on, packed_on, expires_on,
                       quantity_produced, unit_cost, qa_status, qa_notes, created_by)
  values (v_sku, nullif(p->>'manufacturer_partner_id', '')::uuid, nullif(p->>'external_lot_no', ''),
          v_mfg, nullif(p->>'packed_on', '')::date, v_exp, nullif(p->>'quantity_produced', '')::numeric,
          nullif(p->>'unit_cost', '')::numeric,
          coalesce(nullif(p->>'qa_status', '')::qa_status, 'released'), nullif(p->>'qa_notes', ''), v_uid)
  returning * into v_b;
  return jsonb_build_object('batch_id', v_b.id, 'batch_code', v_b.code, 'expires_on', v_b.expires_on);
end; $function$;

CREATE OR REPLACE FUNCTION public.complete_production(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := require_role('manager', 'warehouse');
  po production_orders%rowtype; v_out numeric := (p->>'output_qty')::numeric;
  v_conv numeric := round(coalesce(nullif(p->>'conversion_cost', '')::numeric, 0), 2);
  v_mfg date := coalesce(nullif(p->>'manufactured_on', '')::date, today_ist()); v_exp date; v_shelf int;
  req record; v_actual numeric; v_left numeric; b record; v_take numeric;
  v_lines jsonb := '[]'::jsonb; v_jl jsonb := '[]'::jsonb; v_mat_cost numeric := 0; v_line_cost numeric;
  v_batch uuid; v_owner uuid := company_owner_id(); v_short text := '';
  v_cons jsonb := '[]'::jsonb; v_by_acct jsonb := '{}'::jsonb; k text;
begin
  select * into po from production_orders where id = (p->>'production_order_id')::uuid for update;
  if po.id is null then raise exception 'Production order not found'; end if;
  if po.status = 'completed' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'order', get_production_order(po.id));
  end if;
  if po.status <> 'planned' then raise exception 'Production order is %', po.status; end if;
  if v_out is null or v_out <= 0 then raise exception 'Enter how many packs were produced'; end if;
  if v_conv < 0 then raise exception 'Conversion cost cannot be negative'; end if;

  -- materials: actual (given) or standard for the actual output; pick oldest expiry first
  for req in select * from production_requirements(po.id, v_out) loop
    select coalesce((select (c->>'qty')::numeric from jsonb_array_elements(coalesce(p->'consumptions', '[]'::jsonb)) c
                      where (c->>'material_sku_id')::uuid = req.material_sku_id limit 1), req.standard_qty)
      into v_actual;
    v_left := v_actual;
    perform lock_sku_location(req.material_sku_id, po.location_id);
    for b in select sb.batch_id, sb.qty, bt.unit_cost
               from stock_balances sb join batches bt on bt.id = sb.batch_id
              where sb.sku_id = req.material_sku_id and sb.location_id = po.location_id and sb.owner_id = v_owner
                and sb.status = 'available' and sb.qty > 0 and bt.qa_status = 'released' and bt.expires_on >= today_ist()
              order by bt.expires_on, bt.created_at loop
      exit when v_left <= 0;
      v_take := least(v_left, b.qty);
      v_lines := v_lines || jsonb_build_object('sku_id', req.material_sku_id, 'batch_id', b.batch_id, 'location_id', po.location_id,
                   'owner_id', v_owner, 'status', 'available', 'qty', -v_take);
      v_line_cost := round(v_take * coalesce(b.unit_cost, 0), 2);
      v_mat_cost := v_mat_cost + v_line_cost;
      k := inventory_account_key(req.material_sku_id);
      v_by_acct := jsonb_set(v_by_acct, array[k], to_jsonb(coalesce((v_by_acct->>k)::numeric, 0) + v_line_cost));
      v_cons := v_cons || jsonb_build_object('material_sku_id', req.material_sku_id, 'batch_id', b.batch_id, 'qty', v_take,
                  'unit_cost', b.unit_cost, 'standard_qty', req.standard_qty);
      if b.unit_cost is null then
        perform log_accounting_exception('uncosted_stock', 'production_order', po.id,
          'Material batch without cost used in ' || po.code || ' — finished goods cost is understated');
      end if;
      v_left := v_left - v_take;
    end loop;
    if v_left > 0 then
      v_short := v_short || format('%s: need %s more %s; ', (select name from skus where id = req.material_sku_id),
                   fmt_qty(round(v_left, 3)), (select pack_unit from skus where id = req.material_sku_id));
    end if;
  end loop;
  if v_short <> '' then raise exception 'Not enough material at this location — %', v_short; end if;

  select shelf_life_days into v_shelf from skus s join products pr on pr.id = s.product_id where s.id = po.sku_id;
  v_exp := coalesce(nullif(p->>'expires_on', '')::date, v_mfg + coalesce(v_shelf, default_shelf_life_days()));

  insert into batches (sku_id, manufacturer_partner_id, manufactured_on, packed_on, expires_on, quantity_produced, unit_cost,
                       qa_status, qa_notes, created_by)
  values (po.sku_id, po.manufacturer_partner_id, v_mfg, v_mfg, v_exp, v_out, round((v_mat_cost + v_conv) / v_out, 4),
          case when coalesce((p->>'hold_for_qa')::boolean, false) then 'pending' else 'released' end::qa_status,
          'From ' || po.code, v_uid)
  returning id into v_batch;

  v_lines := v_lines || jsonb_build_object('sku_id', po.sku_id, 'batch_id', v_batch, 'location_id', po.location_id,
               'owner_id', v_owner, 'status', 'available', 'qty', v_out);
  perform post_stock_txn('production_receipt', v_lines, 'Production ' || po.code, 'production_order', po.id,
                         'production:' || po.id, true, false);

  insert into production_consumptions (production_order_id, material_sku_id, batch_id, qty, unit_cost, standard_qty)
  select po.id, (c->>'material_sku_id')::uuid, (c->>'batch_id')::uuid, (c->>'qty')::numeric,
         nullif(c->>'unit_cost', '')::numeric, (c->>'standard_qty')::numeric
    from jsonb_array_elements(v_cons) c;

  -- Journal: finished goods in at full cost; materials out; conversion absorbed
  v_jl := v_jl || jsonb_build_object('account', 'inv_finished', 'debit', v_mat_cost + v_conv, 'brand_id', sku_brand(po.sku_id));
  for k in select jsonb_object_keys(v_by_acct) loop
    v_jl := v_jl || jsonb_build_object('account', k, 'credit', (v_by_acct->>k)::numeric, 'brand_id', sku_brand(po.sku_id));
  end loop;
  v_jl := v_jl || jsonb_build_object('account', 'overhead_absorbed', 'credit', v_conv, 'brand_id', sku_brand(po.sku_id));
  perform post_journal(v_mfg, 'production_order', po.id, 'main', 'Production ' || po.code, v_jl);

  update production_orders set status = 'completed', output_qty = v_out, output_batch_id = v_batch, material_cost = v_mat_cost,
         conversion_cost = v_conv, unit_cost = round((v_mat_cost + v_conv) / v_out, 4), completed_at = now(), completed_by = v_uid
   where id = po.id;

  -- finished stock may unblock waiting customer orders
  perform reserve_waiting_orders(po.sku_id, po.location_id);
  return jsonb_build_object('ok', true, 'batch_code', (select code from batches where id = v_batch), 'order', get_production_order(po.id));
end; $function$;

CREATE OR REPLACE FUNCTION public.inv_item(p_sku_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_loc uuid := default_location_id(); v jsonb; v_type text;
begin
  perform require_staff();
  v := inv_item_json(p_sku_id);
  if v is null then raise exception 'Item not found'; end if;
  v_type := v->>'item_type';
  return v || jsonb_build_object(
    'location', (select name from locations where id = v_loc),
    'reserved', reserved_qty(p_sku_id, v_loc),
    'batches', (select coalesce(jsonb_agg(jsonb_build_object('id', bt.id, 'code', coalesce(bt.code, 'No batch'),
                   'qty', sb.qty, 'expires_on', bt.expires_on, 'days_left', bt.expires_on - today_ist(),
                   'qa_status', bt.qa_status, 'expired', bt.expires_on < today_ist(),
                   'on_hold', coalesce(bt.qa_status <> 'released', false))
                 order by bt.expires_on nulls last, bt.created_at), '[]'::jsonb)
                from stock_balances sb left join batches bt on bt.id = sb.batch_id
               where sb.sku_id = p_sku_id and sb.location_id = v_loc and sb.owner_id = company_owner_id()
                 and sb.status = 'available' and sb.qty > 0),
    'incoming', (select coalesce(jsonb_agg(jsonb_build_object('po_line_id', l.id, 'po_code', po.code,
                   'supplier', coalesce(bp.display_name, bp.legal_name), 'remaining', l.qty - l.received_qty,
                   'expected_date', po.expected_date) order by po.order_date, po.code), '[]'::jsonb)
                 from purchase_order_lines l join purchase_orders po on po.id = l.po_id
                 join business_partners bp on bp.id = po.supplier_id
                where l.sku_id = p_sku_id and l.received_qty < l.qty and po.status in ('open', 'partially_received')),
    'kitchen', case when v_type = 'finished' then jsonb_build_object(
                   'planned', (select jsonb_build_object('code', code, 'planned_qty', planned_qty) from production_orders
                                where sku_id = p_sku_id and status = 'planned' and location_id = v_loc
                                order by planned_date, created_at limit 1),
                   'has_recipe', exists (select 1 from recipes where sku_id = p_sku_id and active),
                   'can_make', true) end,   -- shelf life is optional now (default used)
    'pending_counts', (select count(*) from stock_counts where sku_id = p_sku_id and status = 'pending'));
end; $function$;

revoke execute on all functions in schema public from public, anon;
revoke execute on function unpaid_hold_minutes(), default_shelf_life_days() from authenticated, service_role;
grant execute on function storefront_catalogue(), storefront_order_status(text, text),
  storefront_notify_me(text, text, boolean, text), storefront_request_cancellation(text, text, text)
  to anon, authenticated, service_role;
