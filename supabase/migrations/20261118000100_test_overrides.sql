-- =====================================================================
-- Test overrides (only while testing mode is on)
--
-- Before launch most products have no recipe, no shelf life and no raw
-- materials on the shelf, so Make / Repack / Stock in stop the test flow.
-- test_stock_in() adds stock for ANY item in one step, skipping:
--   - the recipe (no ingredients are used up),
--   - the raw-material check,
--   - the shelf life (expiry = today + shelf life, or + 30 days if unset),
--   - the purchase order for ingredients and packaging.
-- The stock is real (it can be reserved, packed and dispatched), its
-- batch is marked TEST STOCK, it is valued at the last known cost (else 0)
-- and posted like other stock received without a purchase order.
-- Waiting customer orders are reserved straight away.
-- It refuses to run when testing mode is off.
-- =====================================================================

create or replace function testing_mode_on()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from app_settings where key = 'testing_mode'), false)
$$;

-- p: {sku_id, qty, idempotency_key, expires_on?}
create or replace function test_stock_in(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := require_role('warehouse', 'manager');
  v_key text := nullif(p->>'idempotency_key', '');
  v_sku uuid := nullif(p->>'sku_id', '')::uuid;
  v_qty numeric := nullif(p->>'qty', '')::numeric;
  v_loc uuid := default_location_id();
  v_prev jsonb; v_tracked boolean; v_life int; v_exp date; v_batch uuid; v_type text; v_res jsonb;
begin
  if not testing_mode_on() then
    raise exception 'Test override is only available in testing mode (More → Testing tools)';
  end if;
  v_prev := inv_request_seen(v_key);
  if v_prev is not null then return v_prev; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'Enter how many came in'; end if;
  select pr.is_batch_tracked, pr.shelf_life_days into v_tracked, v_life
    from skus s join products pr on pr.id = s.product_id where s.id = v_sku;
  if v_tracked is null then raise exception 'Item not found'; end if;
  v_type := item_type_of(v_sku)::text;
  v_exp := coalesce(nullif(p->>'expires_on', '')::date, today_ist() + coalesce(v_life, 30));
  if v_exp < today_ist() then raise exception 'The expiry date can''t be in the past'; end if;

  if v_tracked then
    insert into batches (sku_id, manufactured_on, packed_on, expires_on, quantity_produced, unit_cost, qa_status, qa_notes, created_by)
    values (v_sku, today_ist(), today_ist(), v_exp, v_qty, coalesce(latest_unit_cost(v_sku), 0), 'released',
            'TEST STOCK — added by test override (no recipe, materials or purchase order)', v_uid)
    returning id into v_batch;
  end if;
  perform receive_stock(v_sku, v_batch, v_loc, v_qty,
    case when v_type = 'finished' then 'production' else 'purchase' end,
    'TEST override', null);

  v_res := jsonb_build_object('ok', true, 'route', 'test', 'test', true, 'qty', v_qty,
    'batch', (select jsonb_build_object('id', id, 'code', code, 'expires_on', expires_on) from batches where id = v_batch),
    'item', inv_item_json(v_sku));
  if v_key is not null then
    insert into inventory_requests (idempotency_key, fn, result, created_by) values (v_key, 'test_stock_in', v_res, v_uid);
  end if;
  return v_res;
end; $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function storefront_catalogue(), storefront_order_status(text, text),
  storefront_notify_me(text, text, boolean, text), storefront_request_cancellation(text, text, text)
  to anon, authenticated, service_role;
grant execute on function testing_mode_on(), test_stock_in(jsonb) to authenticated;
