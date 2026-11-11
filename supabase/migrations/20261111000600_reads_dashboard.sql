-- =====================================================================
-- Migration 0006 — Read functions for the app, admin helpers and the
-- founder dashboard (exception-driven alerts + MIS).
-- =====================================================================

create or replace function owner_name(p_owner uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(e.name, coalesce(bp.display_name, bp.legal_name))
    from stock_owners o
    left join legal_entities e on e.id = o.legal_entity_id
    left join business_partners bp on bp.id = o.partner_id
   where o.id = p_owner
$$;

-- How a balance is held: own stock, consignment at a partner, or partner-owned (sold outright)
create or replace function holding_type(p_owner uuid, p_location uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when p_owner <> company_owner_id() then 'partner_owned'
    when l.type = 'contract_manufacturer' then 'at_contract_manufacturer'
    when l.partner_id is not null then 'consignment'
    when l.type = 'in_transit' then 'in_transit'
    else 'own_location' end
  from locations l where l.id = p_location
$$;

-- ---------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------
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
    'reservations', (select coalesce(jsonb_agg(jsonb_build_object('sku_id', r.sku_id, 'qty', r.qty, 'status', r.status)), '[]'::jsonb)
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

create or replace function find_order(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_id uuid;
begin
  perform require_staff();
  select id into v_id from orders
   where upper(code) = upper(trim(p_code)) or external_order_id = trim(p_code)
   order by created_at desc limit 1;
  if v_id is null then return null; end if;
  return get_order(v_id);
end; $$;

create or replace function list_orders(p_filter text default 'all', p_search text default null, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return (select coalesce(jsonb_agg(x order by x->>'placed_at'), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', o.id, 'code', o.code, 'status', o.status, 'payment_status', o.payment_status,
      'stock_shortfall', o.stock_shortfall, 'placed_at', o.placed_at, 'total_amount', o.total_amount,
      'customer_name', coalesce(c.full_name, o.ship_to->>'name'), 'city', o.ship_to->>'city',
      'channel', ch.code, 'external_order_id', o.external_order_id,
      'units', (select sum(qty) from order_lines where order_id = o.id),
      'items', (select string_agg(s.name || ' × ' || trim(to_char(ol.qty, 'FM999999990.###')), ', ' order by ol.line_no)
                  from order_lines ol join skus s on s.id = ol.sku_id where ol.order_id = o.id),
      'shipment', (select jsonb_build_object('provider', dp.name, 'booking_ref', sh.booking_ref, 'tracking_url', sh.tracking_url)
                     from shipments sh join delivery_providers dp on dp.id = sh.provider_id
                    where sh.order_id = o.id order by sh.dispatched_at desc limit 1)
    ) x
    from orders o
    join sales_channels ch on ch.id = o.channel_id
    left join customers c on c.id = o.customer_id
    where case coalesce(p_filter, 'all')
        when 'to_pack' then order_is_packable(o)
        when 'to_dispatch' then o.status = 'packed'
        when 'out_for_delivery' then o.status = 'dispatched'
        when 'awaiting_payment' then o.status = 'pending_payment'
        when 'attention' then o.stock_shortfall or o.status = 'delivery_failed'
             or (o.status = 'cancelled' and o.payment_status in ('paid', 'partially_refunded'))
        when 'open' then o.status not in ('delivered', 'cancelled')
        else true end
      and (p_search is null or p_search = ''
           or o.code ilike '%' || p_search || '%' or o.external_order_id ilike '%' || p_search || '%'
           or c.full_name ilike '%' || p_search || '%' or c.phone ilike '%' || p_search || '%')
    order by o.placed_at desc
    limit p_limit) t);
end; $$;

create or replace function get_work_queue()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return jsonb_build_object(
    'to_pack', (select count(*) from orders o where order_is_packable(o)),
    'to_dispatch', (select count(*) from orders where status = 'packed'),
    'out_for_delivery', (select count(*) from orders where status = 'dispatched'),
    'awaiting_payment', (select count(*) from orders where status = 'pending_payment'),
    'attention', (select count(*) from orders o where o.stock_shortfall and o.status in ('pending_payment', 'confirmed')
                     or o.status = 'delivery_failed'
                     or (o.status = 'cancelled' and o.payment_status in ('paid', 'partially_refunded'))),
    'oldest_to_pack', (select min(placed_at) from orders o where order_is_packable(o))
  );
end; $$;

-- ---------------------------------------------------------------------
-- Inventory reads
-- ---------------------------------------------------------------------
create or replace function list_skus(p_search text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_loc uuid := default_location_id(); v_owner uuid := company_owner_id();
begin
  perform require_staff();
  return (select coalesce(jsonb_agg(x order by x->>'brand', x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', s.id, 'code', s.code, 'name', s.name, 'product', p.name, 'product_id', p.id, 'brand', b.name, 'brand_code', b.code,
      'category', cat.name, 'pack_size', s.pack_size, 'pack_unit', s.pack_unit, 'mrp', s.mrp,
      'web_price', get_price(s.id, 'WEB'), 'reorder_level', s.reorder_level, 'active', s.active,
      'is_batch_tracked', p.is_batch_tracked, 'shelf_life_days', p.shelf_life_days,
      'hsn', t.hsn_code, 'gst_rate', t.gst_rate,
      'gtins', (select coalesce(jsonb_agg(g.gtin), '[]'::jsonb) from gtins g where g.sku_id = s.id),
      'sellable', sellable_qty(s.id, v_loc), 'reserved', reserved_qty(s.id, v_loc), 'atp', atp_qty(s.id, v_loc),
      'packed', (select coalesce(sum(qty), 0) from stock_balances where sku_id = s.id and status = 'packed'),
      'company_total', (select coalesce(sum(qty), 0) from stock_balances where sku_id = s.id and owner_id = v_owner),
      'low_stock', atp_qty(s.id, v_loc) <= s.reorder_level
    ) x
    from skus s join products p on p.id = s.product_id join brands b on b.id = p.brand_id
    left join categories cat on cat.id = p.category_id
    left join tax_rates t on t.id = p.tax_rate_id
    where p_search is null or p_search = '' or s.name ilike '%' || p_search || '%' or s.code ilike '%' || p_search || '%'
       or p.name ilike '%' || p_search || '%' or b.name ilike '%' || p_search || '%'
  ) t);
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
      from stock_reservations r join orders o on o.id = r.order_id where r.sku_id = p_sku_id and r.status = 'active'),
    'movements', (select coalesce(jsonb_agg(m order by m->>'at' desc), '[]'::jsonb) from (
        select jsonb_build_object('txn_code', t.code, 'type', t.txn_type, 'qty', sm.qty, 'status', sm.status,
          'location', l.name, 'owner', owner_name(sm.owner_id), 'batch_code', bt.code, 'reason', t.reason,
          'at', sm.created_at, 'by', (select full_name from staff_profiles where user_id = t.created_by)) m
        from stock_movements sm join stock_transactions t on t.id = sm.transaction_id
        join locations l on l.id = sm.location_id left join batches bt on bt.id = sm.batch_id
        where sm.sku_id = p_sku_id order by sm.id desc limit 40) z)
  );
end; $$;

create or replace function get_reference_data()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return jsonb_build_object(
    'legal_entity', (select jsonb_build_object('id', id, 'name', name, 'gstin', gstin) from legal_entities order by created_at limit 1),
    'brands', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name) order by name), '[]') from brands where active),
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]') from categories),
    'tax_rates', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'hsn_code', hsn_code, 'description', description, 'gst_rate', gst_rate) order by hsn_code), '[]') from tax_rates where effective_to is null),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'brand', b.name) order by b.name, p.name), '[]')
                   from products p join brands b on b.id = p.brand_id where p.active),
    'locations', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'code', l.code, 'name', l.name, 'type', l.type,
                     'partner_id', l.partner_id, 'is_default', l.is_default_fulfilment) order by l.is_default_fulfilment desc, l.name), '[]')
                   from locations l where l.active),
    'providers', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'scope', scope) order by name), '[]') from delivery_providers where active),
    'channels', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name) order by name), '[]') from sales_channels where active),
    'partners', (select coalesce(jsonb_agg(jsonb_build_object('id', bp.id, 'code', bp.code, 'name', coalesce(bp.display_name, bp.legal_name),
                    'roles', (select coalesce(jsonb_agg(jsonb_build_object('role', pr.role, 'code', pr.code)), '[]') from partner_roles pr where pr.partner_id = bp.id),
                    'owner_id', (select id from stock_owners where partner_id = bp.id)) order by bp.legal_name), '[]')
                   from business_partners bp where bp.active),
    'company_owner_id', company_owner_id(),
    'me', get_my_profile()
  );
end; $$;

create or replace function list_integration_events(p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_role('manager');
  return (select coalesce(jsonb_agg(x order by x->>'received_at' desc), '[]') from (
    select jsonb_build_object('id', e.id, 'source', e.source, 'event_id', e.event_id, 'event_type', e.event_type,
      'status', e.status, 'attempts', e.attempts, 'error', e.error, 'received_at', e.received_at,
      'processed_at', e.processed_at, 'order_code', o.code, 'external_order_id', e.payload->>'external_order_id') x
    from integration_events e left join orders o on o.id = e.order_id
    order by e.received_at desc limit p_limit) t);
end; $$;

-- ---------------------------------------------------------------------
-- Partners, locations and staff administration
-- ---------------------------------------------------------------------
create or replace function create_partner(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; r text; v_loc uuid;
begin
  perform require_role('manager');
  insert into business_partners (legal_name, display_name, gstin, phone, email, address, city, state, pincode)
  values (p->>'legal_name', nullif(p->>'display_name', ''), nullif(p->>'gstin', ''), nullif(p->>'phone', ''),
          nullif(p->>'email', ''), nullif(p->>'address', ''), nullif(p->>'city', ''), nullif(p->>'state', ''), nullif(p->>'pincode', ''))
  returning id into v_id;
  for r in select jsonb_array_elements_text(coalesce(p->'roles', '[]'::jsonb)) loop
    insert into partner_roles (partner_id, role) values (v_id, r::partner_role);
  end loop;
  if nullif(p->>'location_type', '') is not null then
    insert into locations (name, type, partner_id, city, state, pincode)
    values (coalesce(nullif(p->>'location_name', ''), coalesce(nullif(p->>'display_name', ''), p->>'legal_name')),
            (p->>'location_type')::location_type, v_id, nullif(p->>'city', ''), nullif(p->>'state', ''), nullif(p->>'pincode', ''))
    returning id into v_loc;
  end if;
  perform owner_for_partner(v_id);
  return jsonb_build_object('partner_id', v_id, 'code', (select code from business_partners where id = v_id), 'location_id', v_loc);
end; $$;

create or replace function create_location(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v locations%rowtype;
begin
  perform require_role('manager');
  insert into locations (name, type, partner_id, address, city, state, pincode)
  values (p->>'name', (p->>'type')::location_type, nullif(p->>'partner_id', '')::uuid, nullif(p->>'address', ''),
          nullif(p->>'city', ''), nullif(p->>'state', ''), nullif(p->>'pincode', ''))
  returning * into v;
  return jsonb_build_object('location_id', v.id, 'code', v.code);
end; $$;

create or replace function list_staff()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_role('admin');
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', sp.user_id, 'full_name', sp.full_name, 'role', sp.role,
            'active', sp.active, 'email', u.email) order by sp.full_name), '[]')
          from staff_profiles sp left join auth.users u on u.id = sp.user_id);
end; $$;

-- Give a signed-up user a role (they must have created a login first).
create or replace function set_staff(p_email text, p_full_name text, p_role staff_role, p_active boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  perform require_role('admin');
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is null then raise exception 'No login found for %. Ask them to sign up first.', p_email; end if;
  if v_uid = auth.uid() and (p_role <> 'admin' or not p_active) then
    raise exception 'You cannot remove your own admin access';
  end if;
  insert into staff_profiles (user_id, full_name, role, active) values (v_uid, p_full_name, p_role, p_active)
  on conflict (user_id) do update set full_name = excluded.full_name, role = excluded.role, active = excluded.active;
  return jsonb_build_object('ok', true);
end; $$;

-- ---------------------------------------------------------------------
-- Founder dashboard: KPIs, exception alerts and MIS
-- ---------------------------------------------------------------------
create or replace function get_dashboard(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := today_ist();
  v_from timestamptz := ((today_ist() - (p_days - 1))::timestamp at time zone 'Asia/Kolkata');
  v_loc uuid := default_location_id();
  v_owner uuid := company_owner_id();
  v_alerts jsonb := '[]'::jsonb;
begin
  perform require_role('manager', 'viewer');   -- sales & margins: founder/managers only

  -- Low stock
  v_alerts := v_alerts || coalesce((select jsonb_agg(jsonb_build_object('severity', case when atp_qty(s.id, v_loc) <= 0 then 'high' else 'medium' end,
      'type', 'low_stock', 'title', s.name || ' is low',
      'detail', 'Free stock ' || atp_qty(s.id, v_loc)::int || ' (reorder level ' || s.reorder_level || ')', 'ref', s.id))
    from skus s where s.active and atp_qty(s.id, v_loc) <= s.reorder_level), '[]');

  -- Batches expiring within 30 days that still hold stock
  v_alerts := v_alerts || coalesce((select jsonb_agg(jsonb_build_object(
      'severity', case when b.expires_on < v_today then 'high' else 'medium' end,
      'type', 'expiry', 'title', 'Batch ' || b.code || case when b.expires_on < v_today then ' has expired' else ' expires ' || b.expires_on end,
      'detail', s.name || ' · ' || q.qty::int || ' units in stock', 'ref', s.id))
    from batches b join skus s on s.id = b.sku_id
    join lateral (select sum(qty) qty from stock_balances sb where sb.batch_id = b.id and sb.owner_id = v_owner and sb.status = 'available') q on q.qty > 0
    where b.expires_on <= v_today + 30), '[]');

  -- Batches on QA hold with stock
  v_alerts := v_alerts || coalesce((select jsonb_agg(jsonb_build_object('severity', 'medium', 'type', 'quality',
      'title', 'Batch ' || b.code || ' is ' || b.qa_status, 'detail', s.name || ' — cannot be packed until released', 'ref', s.id))
    from batches b join skus s on s.id = b.sku_id
    where b.qa_status <> 'released' and exists (select 1 from stock_balances sb where sb.batch_id = b.id and sb.qty > 0)), '[]');

  -- Orders waiting for stock
  v_alerts := v_alerts || coalesce((select jsonb_agg(jsonb_build_object('severity', 'high', 'type', 'stock_shortfall',
      'title', o.code || ' is waiting for stock', 'detail', 'Restock, then retry the reservation — or cancel and refund', 'ref', o.id))
    from orders o where o.stock_shortfall and o.status in ('pending_payment', 'confirmed')), '[]');

  -- Orders paid > 24 h ago and still not packed
  v_alerts := v_alerts || coalesce((select jsonb_agg(jsonb_build_object('severity', 'medium', 'type', 'packing_delay',
      'title', o.code || ' not packed after ' || floor(extract(epoch from now() - o.placed_at) / 3600)::int || ' h',
      'detail', coalesce(o.ship_to->>'name', '') , 'ref', o.id))
    from orders o where order_is_packable(o) and o.placed_at < now() - interval '24 hours'), '[]');

  -- Shipments out > 5 days
  v_alerts := v_alerts || coalesce((select jsonb_agg(jsonb_build_object('severity', 'medium', 'type', 'shipment_delay',
      'title', o.code || ' out for delivery ' || (v_today - (o.dispatched_at at time zone 'Asia/Kolkata')::date) || ' days',
      'detail', 'Check with the delivery provider', 'ref', o.id))
    from orders o where o.status = 'dispatched' and o.dispatched_at < now() - interval '5 days'), '[]');

  -- Failed deliveries
  v_alerts := v_alerts || coalesce((select jsonb_agg(jsonb_build_object('severity', 'high', 'type', 'delivery_failed',
      'title', 'Delivery failed: ' || o.code, 'detail', coalesce((select failure_reason from shipments where order_id = o.id order by dispatched_at desc limit 1), ''), 'ref', o.id))
    from orders o where o.status = 'delivery_failed'), '[]');

  -- Cancelled but not refunded
  v_alerts := v_alerts || coalesce((select jsonb_agg(jsonb_build_object('severity', 'high', 'type', 'refund_due',
      'title', 'Refund due on ' || o.code, 'detail', 'Order cancelled but payment still held', 'ref', o.id))
    from orders o where o.status = 'cancelled' and o.payment_status in ('paid', 'partially_refunded')), '[]');

  -- Storefront total differs from the system's calculation (price list / tax mismatch)
  v_alerts := v_alerts || coalesce((select jsonb_agg(jsonb_build_object('severity', 'medium', 'type', 'total_mismatch',
      'title', o.code || ': website charged ' || o.external_total || ', system calculated ' || o.total_amount,
      'detail', 'Check website prices and tax settings against the price list', 'ref', o.id))
    from orders o where o.external_total is not null and abs(o.external_total - o.total_amount) > 1
     and o.placed_at >= now() - interval '30 days'), '[]');

  -- Failed website integration events
  v_alerts := v_alerts || coalesce((select jsonb_agg(jsonb_build_object('severity', 'high', 'type', 'integration',
      'title', 'Website order failed to import (' || e.source || ' ' || coalesce(e.payload->>'external_order_id', e.event_id) || ')',
      'detail', e.error, 'ref', e.id))
    from integration_events e where e.status = 'failed'), '[]');

  return jsonb_build_object(
    'kpis', jsonb_build_object(
      'sales_today', (select coalesce(sum(total_amount), 0) from orders where status <> 'cancelled' and (placed_at at time zone 'Asia/Kolkata')::date = v_today),
      'orders_today', (select count(*) from orders where status <> 'cancelled' and (placed_at at time zone 'Asia/Kolkata')::date = v_today),
      'outstanding_payments', (select coalesce(sum(o.total_amount - coalesce(p.net, 0)), 0) from orders o
                                 left join (select order_id, sum(case when kind = 'payment' then amount else -amount end) net from payments group by order_id) p on p.order_id = o.id
                                where o.status <> 'cancelled' and o.payment_status in ('unpaid', 'cod_pending')),
      'low_stock_count', (select count(*) from skus s where s.active and atp_qty(s.id, v_loc) <= s.reorder_level),
      'sales_period', (select coalesce(sum(total_amount), 0) from orders where status <> 'cancelled' and placed_at >= v_from),
      'orders_period', (select count(*) from orders where status <> 'cancelled' and placed_at >= v_from)
    ),
    'alerts', v_alerts,
    'queue', get_work_queue(),
    'sales_by_brand', (select coalesce(jsonb_agg(jsonb_build_object('brand', x.brand, 'revenue', x.revenue, 'revenue_ex_tax', x.rev_ex,
          'cogs', x.cogs, 'gross_margin_pct', case when x.rev_ex_costed > 0 then round(100 * (x.rev_ex_costed - x.cogs) / x.rev_ex_costed, 1) end) order by x.revenue desc), '[]')
        from (select b.name brand, sum(ol.line_total) revenue, sum(ol.line_total - ol.tax_amount) rev_ex,
                     sum(c.cost) cogs, sum(case when c.cost is not null then ol.line_total - ol.tax_amount end) rev_ex_costed
                from order_lines ol join orders o on o.id = ol.order_id
                join skus s on s.id = ol.sku_id join products p on p.id = s.product_id join brands b on b.id = p.brand_id
                left join lateral (select sum(ps.qty * bt.unit_cost) cost from pack_scans ps join batches bt on bt.id = ps.batch_id
                                    where ps.order_line_id = ol.id and ps.result = 'accepted' and bt.unit_cost is not null) c on true
               where o.status <> 'cancelled' and o.placed_at >= v_from
               group by b.name) x),
    'sales_by_channel', (select coalesce(jsonb_agg(jsonb_build_object('channel', ch.name, 'revenue', x.rev, 'orders', x.n) order by x.rev desc), '[]')
        from (select channel_id, sum(total_amount) rev, count(*) n from orders where status <> 'cancelled' and placed_at >= v_from group by channel_id) x
        join sales_channels ch on ch.id = x.channel_id),
    'top_products', (select coalesce(jsonb_agg(jsonb_build_object('sku', x.name, 'brand', x.brand, 'units', x.units, 'revenue', x.rev) order by x.rev desc), '[]')
        from (select s.name, b.name brand, sum(ol.qty) units, sum(ol.line_total) rev
                from order_lines ol join orders o on o.id = ol.order_id join skus s on s.id = ol.sku_id
                join products p on p.id = s.product_id join brands b on b.id = p.brand_id
               where o.status <> 'cancelled' and o.placed_at >= v_from
               group by s.name, b.name order by sum(ol.line_total) desc limit 10) x),
    'daily_sales', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'revenue',
          (select coalesce(sum(total_amount), 0) from orders where status <> 'cancelled' and (placed_at at time zone 'Asia/Kolkata')::date = d::date)) order by d), '[]')
        from generate_series(v_today - (least(p_days, 60) - 1), v_today, interval '1 day') d),
    'repeat_purchase_rate', (select case when count(*) > 0 then round(100.0 * count(*) filter (where n > 1) / count(*), 1) end
        from (select customer_id, count(*) n from orders where customer_id is not null and status <> 'cancelled' group by customer_id) x),
    'stock_chain', (select coalesce(jsonb_agg(jsonb_build_object('holding', h, 'units', u) order by h), '[]')
        from (select holding_type(owner_id, location_id) h, sum(qty) u from stock_balances where qty > 0 group by 1) x),
    'inventory_ageing', (select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'units', u) order by ord), '[]')
        from (select case when age <= 30 then '0–30 days' when age <= 60 then '31–60 days' when age <= 90 then '61–90 days' else '90+ days' end bucket,
                     case when age <= 30 then 1 when age <= 60 then 2 when age <= 90 then 3 else 4 end ord, sum(qty) u
                from (select sb.qty, v_today - coalesce(bt.manufactured_on, v_today) age
                        from stock_balances sb left join batches bt on bt.id = sb.batch_id
                       where sb.owner_id = v_owner and sb.status = 'available' and sb.qty > 0) a
               group by 1, 2) x)
  );
end; $$;
