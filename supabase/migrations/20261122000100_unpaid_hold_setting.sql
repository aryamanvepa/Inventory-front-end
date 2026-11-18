-- =====================================================================
-- Tidy-up after the FEFO / unpaid-hold change (owner, 2026-11-18)
--
-- 1. The unpaid-order stock hold is an admin setting
--    (app_settings.unpaid_hold_minutes, 5–1440, default 30) instead of a
--    fixed 30 minutes. Changing it applies to every unpaid order at once.
-- 2. Lapsed holds no longer show as stock promised to an order:
--    get_sku_stock leaves them out, and get_order marks them 'lapsed'
--    until they are released.
-- =====================================================================

alter table app_settings drop constraint if exists app_settings_key_check;
alter table app_settings add constraint app_settings_key_check check (key in ('testing_mode', 'storage_public_url', 'unpaid_hold_minutes'));
insert into app_settings (key, value) values ('unpaid_hold_minutes', '30'::jsonb) on conflict (key) do nothing;

create or replace function unpaid_hold_minutes()
returns int language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::int from app_settings where key = 'unpaid_hold_minutes'), 30)
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
  insert into app_settings (key, value, updated_at, updated_by) values (p_key, p_value, now(), v_uid)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = v_uid;
  return get_app_settings();
end; $$;

create or replace function get_order(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform require_staff();
  select jsonb_build_object(
    'id', o.id, 'code', o.code, 'kind', o.kind, 'status', o.status, 'payment_status', o.payment_status,
    'stock_shortfall', o.stock_shortfall, 'packable', order_is_packable(o),
    'placed_at', o.placed_at, 'packed_at', o.packed_at, 'dispatched_at', o.dispatched_at,
    'delivered_at', o.delivered_at, 'cancelled_at', o.cancelled_at, 'cancel_reason', o.cancel_reason,
    'channel', ch.name, 'external_source', o.external_source, 'external_order_id', o.external_order_id,
    'ship_to', o.ship_to, 'notes', o.notes,
    'subtotal', o.subtotal, 'discount_amount', o.discount_amount, 'shipping_amount', o.shipping_amount,
    'tax_amount', o.tax_amount, 'total_amount', o.total_amount,
    'customer', case when c.id is null then null else jsonb_build_object('id', c.id, 'code', c.code, 'name', c.full_name, 'phone', c.phone, 'email', c.email) end,
    'location', jsonb_build_object('id', l.id, 'name', l.name),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', ol.id, 'line_no', ol.line_no, 'sku_id', s.id, 'sku_code', s.code, 'sku_name', s.name,
        'brand', b.name, 'qty', ol.qty, 'scanned', line_scanned_qty(ol.id), 'unit_price', ol.unit_price,
        'line_total', ol.line_total, 'tax_rate', ol.tax_rate, 'is_batch_tracked', p.is_batch_tracked,
        'batches', (select coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'qty', x.q, 'expires_on', x.expires_on)), '[]'::jsonb)
                      from (select bt.code, bt.expires_on, sum(ps.qty) q from pack_scans ps join batches bt on bt.id = ps.batch_id
                             where ps.order_line_id = ol.id and ps.result = 'accepted'
                             group by bt.code, bt.expires_on having sum(ps.qty) <> 0) x)
      ) order by ol.line_no), '[]'::jsonb)
      from order_lines ol join skus s on s.id = ol.sku_id join products p on p.id = s.product_id join brands b on b.id = p.brand_id
      where ol.order_id = o.id),
    'scans', (select coalesce(jsonb_agg(x order by x->>'scanned_at' desc), '[]'::jsonb) from (
        select jsonb_build_object('id', ps.id, 'result', ps.result, 'message', ps.message, 'qty', ps.qty,
          'scanned_code', ps.scanned_code, 'manual_batch', ps.manual_batch, 'scanned_at', ps.scanned_at,
          'undone', exists (select 1 from pack_scans r where r.reverses_scan_id = ps.id),
          'is_reversal', ps.reverses_scan_id is not null,
          'by', (select full_name from staff_profiles where user_id = ps.scanned_by)) x
          from pack_scans ps where ps.order_id = o.id order by ps.scanned_at desc limit 30) t),
    'shipments', (select coalesce(jsonb_agg(jsonb_build_object('code', sh.code, 'provider', dp.name, 'booking_ref', sh.booking_ref,
        'tracking_url', sh.tracking_url, 'status', sh.status, 'freight_cost', sh.freight_cost, 'dispatched_at', sh.dispatched_at,
        'delivered_at', sh.delivered_at, 'failure_reason', sh.failure_reason) order by sh.dispatched_at), '[]'::jsonb)
        from shipments sh join delivery_providers dp on dp.id = sh.provider_id where sh.order_id = o.id),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('code', py.code, 'kind', py.kind, 'amount', py.amount,
        'method', py.method, 'gateway_ref', py.gateway_ref, 'notes', py.notes, 'received_at', py.received_at) order by py.received_at), '[]'::jsonb)
        from payments py where py.order_id = o.id),
    'amount_paid', (select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0) from payments where order_id = o.id),
    'reservations', (select coalesce(jsonb_agg(jsonb_build_object('sku_id', r.sku_id, 'qty', r.qty,
        'status', case when r.status = 'active' and unpaid_hold_expired(o) then 'lapsed' else r.status::text end)), '[]'::jsonb)
        from stock_reservations r where r.order_id = o.id)
  ) into v
  from orders o
  join sales_channels ch on ch.id = o.channel_id
  join locations l on l.id = o.fulfilment_location_id
  left join customers c on c.id = o.customer_id
  where o.id = p_order_id;
  if v is null then raise exception 'Order not found'; end if;
  return v;
end; $$;

create or replace function get_sku_stock(p_sku_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_loc uuid := default_location_id();
begin
  perform require_staff();
  return jsonb_build_object(
    'sku', (select x from jsonb_array_elements(list_skus(null)) x where (x->>'id')::uuid = p_sku_id),
    'balances', (select coalesce(jsonb_agg(jsonb_build_object(
        'batch_id', sb.batch_id, 'batch_code', bt.code, 'expires_on', bt.expires_on, 'qa_status', bt.qa_status,
        'location_id', sb.location_id, 'location', l.name, 'location_type', l.type,
        'owner_id', sb.owner_id, 'owner', owner_name(sb.owner_id), 'holding', holding_type(sb.owner_id, sb.location_id),
        'status', sb.status, 'qty', sb.qty) order by l.name, bt.expires_on nulls last, sb.status), '[]'::jsonb)
      from stock_balances sb join locations l on l.id = sb.location_id left join batches bt on bt.id = sb.batch_id
      where sb.sku_id = p_sku_id and sb.qty <> 0),
    'batches', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'manufactured_on', b.manufactured_on,
        'expires_on', b.expires_on, 'qa_status', b.qa_status, 'qa_notes', b.qa_notes, 'external_lot_no', b.external_lot_no,
        'manufacturer', coalesce((select coalesce(display_name, legal_name) from business_partners where id = b.manufacturer_partner_id), 'Own facility'),
        'quantity_produced', b.quantity_produced, 'unit_cost', b.unit_cost,
        'on_hand', (select coalesce(sum(qty), 0) from stock_balances where batch_id = b.id),
        'expired', b.expires_on < today_ist()) order by b.expires_on desc), '[]'::jsonb)
      from batches b where b.sku_id = p_sku_id),
    'reservations', (select coalesce(jsonb_agg(jsonb_build_object('order_code', o.code, 'order_id', o.id, 'qty', r.qty, 'since', r.created_at)
        order by r.created_at), '[]'::jsonb)
      from stock_reservations r join orders o on o.id = r.order_id where r.sku_id = p_sku_id and r.status = 'active'
        and not unpaid_hold_expired(o)),
    'movements', (select coalesce(jsonb_agg(m order by m->>'at' desc), '[]'::jsonb) from (
        select jsonb_build_object('txn_code', t.code, 'type', t.txn_type, 'qty', sm.qty, 'status', sm.status,
          'location', l.name, 'owner', owner_name(sm.owner_id), 'batch_code', bt.code, 'reason', t.reason,
          'at', sm.created_at, 'by', (select full_name from staff_profiles where user_id = t.created_by)) m
        from stock_movements sm join stock_transactions t on t.id = sm.transaction_id
        join locations l on l.id = sm.location_id left join batches bt on bt.id = sm.batch_id
        where sm.sku_id = p_sku_id order by sm.id desc limit 40) z)
  );
end; $$;

revoke execute on all functions in schema public from public, anon;
revoke execute on function unpaid_hold_minutes() from authenticated, service_role;
grant execute on function storefront_catalogue(), storefront_order_status(text, text),
  storefront_notify_me(text, text, boolean, text), storefront_request_cancellation(text, text, text)
  to anon, authenticated, service_role;
