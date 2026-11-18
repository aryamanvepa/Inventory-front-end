-- =====================================================================
-- Two stock-control fixes from the owner's E2E test run (2026-11-18)
--
-- 1. First expiry, first out (test INV-010 / E2E-006).
--    Packing used to accept any in-date batch; the app only warned.
--    pack_scan now refuses a batch while an in-date, released batch of the
--    same item that expires sooner still has free stock at that location
--    (result 'not_earliest_expiry'). If that older batch can't be found,
--    a manager counts it (Stock → Count) and the shelf figure is corrected.
--
-- 2. Unpaid online orders stop holding stock (test INV-003 / PAY-010).
--    An order waiting for an online payment holds its stock for
--    unpaid_hold_minutes() (30) after it reached us. After that the hold
--    no longer counts, so other shoppers can buy the stock, and it is
--    released the next time any order reserves stock. If the payment
--    arrives later, the order is confirmed and tries to reserve again; if
--    the stock has gone it waits for stock like any other short order.
--    Cash-on-delivery orders are confirmed at once and are not affected.
-- =====================================================================

alter type scan_result add value if not exists 'not_earliest_expiry';

create or replace function unpaid_hold_minutes()
returns int language sql immutable as $$ select 30 $$;

-- An unpaid online order whose stock hold has run out
create or replace function unpaid_hold_expired(o orders)
returns boolean language sql stable set search_path = public as $$
  select o.status = 'pending_payment' and o.payment_status = 'unpaid'
     and o.created_at < now() - make_interval(mins => unpaid_hold_minutes())
$$;

-- Stock promised to orders: no longer counts holds that ran out
create or replace function reserved_qty(p_sku uuid, p_location uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(r.qty), 0) from stock_reservations r join orders o on o.id = r.order_id
   where r.sku_id = p_sku and r.location_id = p_location and r.status = 'active'
     and not unpaid_hold_expired(o)
$$;

-- Close the holds that ran out (any item). Returns how many lines were released.
create or replace function release_expired_unpaid_holds()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update stock_reservations r set status = 'released', closed_at = now()
    from orders o
   where o.id = r.order_id and r.status = 'active' and unpaid_hold_expired(o);
  get diagnostics n = row_count;
  return n;
end; $$;

create or replace function reserve_order_stock(p_order_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_loc uuid; r record; v_ok boolean := true;
begin
  perform release_expired_unpaid_holds();
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

-- New stock goes to waiting orders, oldest first — but not to unpaid orders whose hold ran out
create or replace function reserve_waiting_orders(p_sku_id uuid, p_location_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; v_done jsonb := '[]'::jsonb;
begin
  for r in select o.id, o.code from orders o
            where o.stock_shortfall and o.status in ('pending_payment', 'confirmed')
              and not unpaid_hold_expired(o)
              and o.fulfilment_location_id = p_location_id
              and exists (select 1 from order_lines l where l.order_id = o.id and l.sku_id = p_sku_id)
            order by o.placed_at loop
    if reserve_order_stock(r.id) then v_done := v_done || to_jsonb(r.code); end if;
  end loop;
  return v_done;
end; $$;

-- A payment that completes an order whose hold ran out: confirm it, then reserve again
-- (it waits for stock if what it held has been sold in the meantime).
create or replace function refresh_payment_status(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_paid numeric; v_refunded numeric; v_total numeric; v_cod boolean; v_was_pending boolean;
begin
  select coalesce(sum(amount) filter (where kind = 'payment'), 0),
         coalesce(sum(amount) filter (where kind = 'refund'), 0)
    into v_paid, v_refunded from payments where order_id = p_order_id;
  select total_amount, payment_status = 'cod_pending', status = 'pending_payment'
    into v_total, v_cod, v_was_pending from orders where id = p_order_id;
  update orders set payment_status = case
      when v_refunded > 0 and v_refunded >= v_paid then 'refunded'
      when v_refunded > 0 then 'partially_refunded'
      when v_paid >= v_total then 'paid'
      when v_cod then 'cod_pending'
      else 'unpaid' end::payment_status,
    status = case when status = 'pending_payment' and v_paid >= v_total then 'confirmed'::order_status else status end
   where id = p_order_id;
  if v_was_pending and v_paid >= v_total then
    perform reserve_order_stock(p_order_id);   -- no-op while the original hold is still active
  end if;
end; $$;

create or replace function pack_scan(
  p_order_id uuid, p_code text, p_batch_code text default null,
  p_manual_batch boolean default false, p_idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := require_role('packer', 'warehouse', 'manager');
  v_order orders%rowtype;
  v_res jsonb; v_bres jsonb;
  v_sku_id uuid; v_batch batches%rowtype; v_older batches%rowtype; v_units numeric;
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

      if v_result is null and v_batch.id is not null then
        select b2.* into v_older from batches b2
         where b2.sku_id = v_sku_id and b2.id <> v_batch.id
           and b2.qa_status = 'released' and b2.expires_on >= today_ist() and b2.expires_on < v_batch.expires_on
           and sellable_qty(v_sku_id, v_order.fulfilment_location_id, b2.id)
               - batch_scanned_unpacked(b2.id, v_order.fulfilment_location_id) > 0
         order by b2.expires_on, b2.created_at limit 1;
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
        elsif v_batch.id is not null and v_older.id is not null then
          -- first expiry, first out: an in-date batch that expires sooner still has free stock here
          v_result := 'not_earliest_expiry';
          v_msg := 'Take batch ' || v_older.code || ' first (best before ' || to_char(v_older.expires_on, 'DD Mon YYYY')
                   || '). This one, ' || v_batch.code || ', keeps until ' || to_char(v_batch.expires_on, 'DD Mon YYYY')
                   || '. Can''t find ' || v_older.code || '? Ask a manager to count it.';
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

revoke execute on all functions in schema public from public, anon;
revoke execute on function release_expired_unpaid_holds(), unpaid_hold_expired(orders), unpaid_hold_minutes()
  from authenticated, service_role;
grant execute on function storefront_catalogue(), storefront_order_status(text, text),
  storefront_notify_me(text, text, boolean, text), storefront_request_cancellation(text, text, text)
  to anon, authenticated, service_role;
