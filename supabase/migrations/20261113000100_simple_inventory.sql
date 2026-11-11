-- =====================================================================
-- Simple inventory for floor staff
--   * every item (finished goods, ingredients, packaging) gets its own
--     barcode, printed on stickers and scanned by phone or scanner
--   * one-step Stock in / Stock out / Count / Find functions that pick
--     the batch, location and accounting route for the user
--   * stock counts that differ from the system wait for a manager's OK
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Internal barcodes
-- EAN-13 in the GS1 "restricted circulation" range (prefix 200): every
-- scanner and till reads it, but it is only valid inside Torte Living.
-- Products sold through other retailers or marketplaces need a GS1 India
-- GTIN (gtins table); when one exists, labels print that instead.
-- ---------------------------------------------------------------------
create sequence internal_barcode_seq;

create or replace function ean13_with_check(p12 text)
returns text language plpgsql immutable as $$
declare s int := 0; i int;
begin
  if p12 !~ '^\d{12}$' then raise exception 'ean13_with_check needs 12 digits'; end if;
  for i in 1 .. 12 loop
    s := s + substr(p12, i, 1)::int * case when i % 2 = 0 then 3 else 1 end;
  end loop;
  return p12 || ((10 - s % 10) % 10)::text;
end; $$;

create or replace function next_internal_barcode()
returns text language sql security definer set search_path = public as $$
  select ean13_with_check('200' || lpad(nextval('internal_barcode_seq')::text, 9, '0'))
$$;

alter table skus add column barcode text unique check (barcode is null or is_valid_gtin(barcode));

create or replace function trg_sku_barcode()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.barcode is null or new.barcode = '' then new.barcode := next_internal_barcode(); end if;
  elsif old.barcode is not null and new.barcode is distinct from old.barcode then
    raise exception 'A barcode can''t change once it has been printed';
  end if;
  return new;
end; $$;
create trigger assign_barcode before insert or update on skus for each row execute function trg_sku_barcode();

do $$ declare r record; begin
  for r in select id from skus where barcode is null order by created_at, code loop
    update skus set barcode = next_internal_barcode() where id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. Scanning also recognises internal barcodes and materials
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
    if v_sku_id is null then
      -- our own sticker barcode
      select id into v_sku_id from skus where ltrim(barcode, '0') = ltrim(v_gtin, '0');
      v_units := 1;
    end if;
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
    'units', coalesce(v_units, 1),
    'sku', (select jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name, 'mrp', s.mrp,
                    'product', p.name, 'brand', b.name, 'is_batch_tracked', p.is_batch_tracked,
                    'shelf_life_days', p.shelf_life_days, 'item_type', p.item_type, 'unit', s.pack_unit,
                    'barcode', s.barcode)
              from skus s join products p on p.id = s.product_id left join brands b on b.id = p.brand_id
             where s.id = v_sku.id),
    'batch', case when v_batch.id is null then null else jsonb_build_object(
               'id', v_batch.id, 'code', v_batch.code, 'expires_on', v_batch.expires_on,
               'manufactured_on', v_batch.manufactured_on, 'qa_status', v_batch.qa_status) end
  );
end; $$;

-- ---------------------------------------------------------------------
-- 3. Reads for the simple screens
-- ---------------------------------------------------------------------
-- Everything physically on the shelf (any batch, expired or on hold included)
create or replace function shelf_qty(p_sku uuid, p_location uuid, p_batch uuid default null)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(qty), 0) from stock_balances
   where sku_id = p_sku and location_id = p_location and owner_id = company_owner_id()
     and status = 'available' and (p_batch is null or batch_id = p_batch)
$$;

create or replace function inv_item_json(p_sku uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', s.id, 'code', s.code, 'name', s.name, 'item_type', p.item_type, 'brand', b.name,
    'unit', s.pack_unit, 'pack_size', s.pack_size, 'mrp', s.mrp, 'barcode', s.barcode,
    'gtin', (select g.gtin from gtins g where g.sku_id = s.id and g.level = 'each' order by g.created_at limit 1),
    'on_shelf', shelf_qty(s.id, default_location_id()),
    'free', atp_qty(s.id, default_location_id()),
    'reorder_level', s.reorder_level,
    'low', atp_qty(s.id, default_location_id()) <= s.reorder_level,
    'is_batch_tracked', p.is_batch_tracked, 'shelf_life_days', p.shelf_life_days)
  from skus s join products p on p.id = s.product_id left join brands b on b.id = p.brand_id
  where s.id = p_sku
$$;

create or replace function inv_items(p_search text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return (select coalesce(jsonb_agg(inv_item_json(s.id)
            order by case p.item_type when 'finished' then 1 when 'raw_material' then 2 else 3 end, s.name), '[]'::jsonb)
    from skus s join products p on p.id = s.product_id
   where s.active and p.active
     and (coalesce(trim(p_search), '') = '' or s.name ilike '%' || trim(p_search) || '%' or s.code ilike '%' || trim(p_search) || '%'
          or p.name ilike '%' || trim(p_search) || '%' or s.barcode = trim(p_search)));
end; $$;

-- One item with its batches on the shelf and where new stock can come from
create or replace function inv_item(p_sku_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
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
                   'can_make', (v->>'shelf_life_days') is not null
                               or exists (select 1 from recipes where sku_id = p_sku_id and active)) end,
    'pending_counts', (select count(*) from stock_counts where sku_id = p_sku_id and status = 'pending'));
end; $$;

-- ---------------------------------------------------------------------
-- 4. One-step actions
-- ---------------------------------------------------------------------
-- Repeat taps (bad network, double press) return the first result.
create table inventory_requests (
  idempotency_key text primary key,
  fn              text not null,
  result          jsonb not null,
  created_by      uuid,
  created_at      timestamptz not null default now()
);

create or replace function inv_request_seen(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if p_key is null then return null; end if;
  perform pg_advisory_xact_lock(hashtext('invreq:' || p_key));
  select result into v from inventory_requests where idempotency_key = p_key;
  return case when v is null then null else v || '{"duplicate": true}'::jsonb end;
end; $$;

-- Stock in. p: {sku_id, qty, source: 'po' | 'kitchen', po_line_id?, idempotency_key}
--   po      -> received against the purchase order (costed batch, GRNI)
--   kitchen -> finished goods made by us: completes the oldest planned
--              production run (or one created now from the active recipe),
--              consuming ingredients at recipe standard; without a recipe,
--              a new batch at the last known cost
create or replace function inv_stock_in(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := require_role('warehouse', 'manager');
  v_key text := nullif(p->>'idempotency_key', '');
  v_sku uuid := (p->>'sku_id')::uuid;
  v_qty numeric := nullif(p->>'qty', '')::numeric;
  v_loc uuid := default_location_id();
  v_prev jsonb; v_po uuid; v_batch uuid; v_tracked boolean; r jsonb; v_res jsonb; v_route text;
begin
  v_prev := inv_request_seen(v_key);
  if v_prev is not null then return v_prev; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'Enter how many came in'; end if;
  select pr.is_batch_tracked into v_tracked from skus s join products pr on pr.id = s.product_id where s.id = v_sku;
  if v_tracked is null then raise exception 'Item not found'; end if;

  if p->>'source' = 'po' then
    if not exists (select 1 from purchase_order_lines where id = (p->>'po_line_id')::uuid and sku_id = v_sku) then
      raise exception 'That purchase order is for a different item';
    end if;
    r := receive_purchase((p->>'po_line_id')::uuid, v_qty, '{}'::jsonb, null, null);
    v_batch := (r->>'batch_id')::uuid; v_route := 'purchase';
  elsif p->>'source' = 'kitchen' then
    if item_type_of(v_sku) <> 'finished' then
      raise exception 'Ingredients and packaging come in against a purchase order. Ask your manager to make one.';
    end if;
    select id into v_po from production_orders
     where sku_id = v_sku and status = 'planned' and location_id = v_loc order by planned_date, created_at limit 1;
    if v_po is null and exists (select 1 from recipes where sku_id = v_sku and active) then
      v_po := (create_production_order(jsonb_build_object('sku_id', v_sku, 'planned_qty', v_qty,
                 'notes', 'Started from Stock in'))->>'production_order_id')::uuid;
    end if;
    if v_po is not null then
      perform complete_production(jsonb_build_object('production_order_id', v_po, 'output_qty', v_qty));
      select output_batch_id into v_batch from production_orders where id = v_po;
      v_route := 'production';
    else
      if v_tracked then
        v_batch := (create_batch(jsonb_build_object('sku_id', v_sku, 'unit_cost', latest_unit_cost(v_sku)))->>'batch_id')::uuid;
      end if;
      perform receive_stock(v_sku, v_batch, v_loc, v_qty, 'production', 'Stock in', null);
      v_route := 'receipt';
    end if;
  else
    raise exception 'Choose where the stock came from';
  end if;

  v_res := jsonb_build_object('ok', true, 'route', v_route, 'qty', v_qty,
    'batch', (select jsonb_build_object('id', id, 'code', code, 'expires_on', expires_on) from batches where id = v_batch),
    'item', inv_item_json(v_sku));
  if v_key is not null then
    insert into inventory_requests (idempotency_key, fn, result, created_by) values (v_key, 'stock_in', v_res, v_uid);
  end if;
  return v_res;
end; $$;

-- Stock out. p: {sku_id, batch_id?, qty, reason: 'damaged' | 'expired' | 'sample', note?, idempotency_key}
-- Takes the oldest-expiry stock first (expired batches first for 'expired').
-- Damaged/expired stock stays on record under that status; samples leave stock.
create or replace function inv_stock_out(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := require_role('warehouse', 'manager');
  v_key text := nullif(p->>'idempotency_key', '');
  v_sku uuid := (p->>'sku_id')::uuid;
  v_batch uuid := nullif(p->>'batch_id', '')::uuid;
  v_qty numeric := nullif(p->>'qty', '')::numeric;
  v_reason text := p->>'reason';
  v_loc uuid := default_location_id(); v_owner uuid := company_owner_id();
  v_prev jsonb; v_left numeric; v_take numeric; v_sellable numeric := 0; b record;
  v_lines jsonb := '[]'::jsonb; v_txn uuid; v_label text; v_res jsonb;
begin
  v_prev := inv_request_seen(v_key);
  if v_prev is not null then return v_prev; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'Enter how many'; end if;
  v_label := case v_reason when 'damaged' then 'Damaged / broken' when 'expired' then 'Expired'
                           when 'sample' then 'Free sample / tasting' end;
  if v_label is null then raise exception 'Choose why the stock is going out'; end if;

  perform lock_sku_location(v_sku, v_loc);
  v_left := v_qty;
  for b in select sb.batch_id, sb.qty,
                  (sb.batch_id is null or (bt.qa_status = 'released' and bt.expires_on >= today_ist())) sellable
             from stock_balances sb left join batches bt on bt.id = sb.batch_id
            where sb.sku_id = v_sku and sb.location_id = v_loc and sb.owner_id = v_owner
              and sb.status = 'available' and sb.qty > 0 and (v_batch is null or sb.batch_id = v_batch)
              -- never give away expired or held stock as a sample
              and (v_reason <> 'sample' or sb.batch_id is null or (bt.qa_status = 'released' and bt.expires_on >= today_ist()))
            order by case when (bt.expires_on < today_ist()) = (v_reason = 'expired') then 0 else 1 end,
                     bt.expires_on nulls last, bt.created_at loop
    exit when v_left <= 0;
    v_take := least(v_left, b.qty);
    if b.sellable then v_sellable := v_sellable + v_take; end if;
    v_lines := v_lines || jsonb_build_object('sku_id', v_sku, 'batch_id', b.batch_id, 'location_id', v_loc,
                 'owner_id', v_owner, 'status', 'available', 'qty', -v_take);
    if v_reason <> 'sample' then
      v_lines := v_lines || jsonb_build_object('sku_id', v_sku, 'batch_id', b.batch_id, 'location_id', v_loc,
                   'owner_id', v_owner, 'status', v_reason, 'qty', v_take);
    end if;
    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then
    raise exception 'Only % on the shelf%', fmt_qty(v_qty - v_left), case when v_batch is not null then ' in this batch' else '' end;
  end if;
  if v_sellable > 0 and v_sellable > atp_qty(v_sku, v_loc) then
    raise exception 'Only % can go out — the rest are kept for customer orders. Ask your manager.',
      fmt_qty(greatest(atp_qty(v_sku, v_loc), 0));
  end if;

  v_txn := post_stock_txn(case when v_reason = 'sample' then 'adjustment' else 'status_change' end::stock_txn_type,
             v_lines, v_label || coalesce(': ' || nullif(trim(p->>'note'), ''), ''), null, null, null);
  v_res := jsonb_build_object('ok', true, 'qty', v_qty, 'reason', v_reason,
    'transaction_code', (select code from stock_transactions where id = v_txn), 'item', inv_item_json(v_sku));
  if v_key is not null then
    insert into inventory_requests (idempotency_key, fn, result, created_by) values (v_key, 'stock_out', v_res, v_uid);
  end if;
  return v_res;
end; $$;

-- ---------------------------------------------------------------------
-- 5. Stock counts
-- A count that matches closes itself. A difference counted by staff waits
-- for a manager; a manager's own count is applied straight away.
-- The difference is taken against the system figure at the moment of
-- counting, so sales between count and approval don't distort it.
-- ---------------------------------------------------------------------
create table stock_counts (
  id             uuid primary key default gen_random_uuid(),
  code           text unique,                       -- CNT-2026-000001
  sku_id         uuid not null references skus(id),
  batch_id       uuid references batches(id),
  location_id    uuid not null references locations(id),
  system_qty     numeric(14,3) not null,
  counted_qty    numeric(14,3) not null check (counted_qty >= 0),
  status         text not null check (status in ('matched', 'pending', 'applied', 'rejected', 'replaced')),
  counted_by     uuid,
  counted_at     timestamptz not null default now(),
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  review_note    text,
  transaction_id uuid references stock_transactions(id),
  idempotency_key text unique
);
create trigger assign_code before insert on stock_counts for each row execute function trg_assign_code('CNT', 'yearly');
create trigger audit after insert or update or delete on stock_counts for each row execute function trg_audit();
create trigger no_delete before delete on stock_counts for each row execute function trg_no_delete();
create index stock_counts_pending on stock_counts (status) where status = 'pending';

create or replace function inv_count_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', c.id, 'code', c.code, 'status', c.status, 'sku_id', c.sku_id, 'sku_name', s.name,
    'sku_code', s.code, 'unit', s.pack_unit, 'item_type', p.item_type, 'batch_code', bt.code,
    'system_qty', c.system_qty, 'counted_qty', c.counted_qty, 'difference', c.counted_qty - c.system_qty,
    'value', round((c.counted_qty - c.system_qty) * coalesce(bt.unit_cost, latest_unit_cost(c.sku_id), 0), 2),
    'counted_by', (select full_name from staff_profiles where user_id = c.counted_by), 'counted_at', c.counted_at,
    'reviewed_by', (select full_name from staff_profiles where user_id = c.reviewed_by), 'reviewed_at', c.reviewed_at,
    'review_note', c.review_note, 'transaction_code', (select code from stock_transactions where id = c.transaction_id))
  from stock_counts c join skus s on s.id = c.sku_id join products p on p.id = s.product_id
  left join batches bt on bt.id = c.batch_id
  where c.id = p_id
$$;

create or replace function inv_apply_count(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  c stock_counts%rowtype; v_diff numeric; v_left numeric; v_take numeric; b record; v_add uuid; v_tracked boolean;
  v_lines jsonb := '[]'::jsonb; v_owner uuid := company_owner_id(); v_txn uuid;
begin
  select * into c from stock_counts where id = p_id for update;
  v_diff := c.counted_qty - c.system_qty;
  if v_diff = 0 then return; end if;
  perform lock_sku_location(c.sku_id, c.location_id);
  select pr.is_batch_tracked into v_tracked from skus s join products pr on pr.id = s.product_id where s.id = c.sku_id;

  if v_diff > 0 then
    -- extra stock: into the counted batch, else the newest batch of this item
    v_add := c.batch_id;
    if v_add is null and v_tracked then
      select id into v_add from batches where sku_id = c.sku_id
       order by (expires_on >= today_ist()) desc, created_at desc limit 1;
      if v_add is null then raise exception 'This item has no batch yet — use Stock in instead'; end if;
    end if;
    v_lines := jsonb_build_array(jsonb_build_object('sku_id', c.sku_id, 'batch_id', v_add, 'location_id', c.location_id,
                 'owner_id', v_owner, 'status', 'available', 'qty', v_diff));
  else
    -- missing stock: from the oldest-expiry batches (as far as stock remains)
    v_left := -v_diff;
    for b in select sb.batch_id, sb.qty from stock_balances sb left join batches bt on bt.id = sb.batch_id
              where sb.sku_id = c.sku_id and sb.location_id = c.location_id and sb.owner_id = v_owner
                and sb.status = 'available' and sb.qty > 0 and (c.batch_id is null or sb.batch_id = c.batch_id)
              order by bt.expires_on nulls last, bt.created_at loop
      exit when v_left <= 0;
      v_take := least(v_left, b.qty);
      v_lines := v_lines || jsonb_build_object('sku_id', c.sku_id, 'batch_id', b.batch_id, 'location_id', c.location_id,
                   'owner_id', v_owner, 'status', 'available', 'qty', -v_take);
      v_left := v_left - v_take;
    end loop;
    if jsonb_array_length(v_lines) = 0 then return; end if;
  end if;

  v_txn := post_stock_txn('adjustment', v_lines,
             'Stock count ' || c.code || ': system ' || fmt_qty(c.system_qty) || ', counted ' || fmt_qty(c.counted_qty),
             'stock_count', c.id, 'count:' || c.id);
  update stock_counts set transaction_id = v_txn where id = c.id;
end; $$;

-- p: {sku_id, batch_id?, counted, idempotency_key}
create or replace function inv_submit_count(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := require_role('warehouse', 'packer', 'manager');
  v_key text := nullif(p->>'idempotency_key', '');
  v_sku uuid := (p->>'sku_id')::uuid;
  v_batch uuid := nullif(p->>'batch_id', '')::uuid;
  v_counted numeric := nullif(p->>'counted', '')::numeric;
  v_loc uuid := default_location_id();
  v_sys numeric; v_id uuid; v_status text;
  v_mgr boolean := current_staff_role()::text in ('admin', 'manager');
begin
  if v_key is not null then
    select id into v_id from stock_counts where idempotency_key = v_key;
    if v_id is not null then return inv_count_json(v_id) || jsonb_build_object('item', inv_item_json(v_sku), 'duplicate', true); end if;
  end if;
  if v_counted is null or v_counted < 0 then raise exception 'Enter how many you counted'; end if;
  if not exists (select 1 from skus where id = v_sku) then raise exception 'Item not found'; end if;
  if v_batch is not null and not exists (select 1 from batches where id = v_batch and sku_id = v_sku) then
    raise exception 'That batch belongs to a different item';
  end if;

  perform lock_sku_location(v_sku, v_loc);
  v_sys := shelf_qty(v_sku, v_loc, v_batch);
  v_status := case when v_counted = v_sys then 'matched' else 'pending' end;

  -- a newer count of the same thing replaces one still waiting
  update stock_counts set status = 'replaced', review_note = 'Counted again'
   where sku_id = v_sku and location_id = v_loc and batch_id is not distinct from v_batch and status = 'pending';

  insert into stock_counts (sku_id, batch_id, location_id, system_qty, counted_qty, status, counted_by, idempotency_key)
  values (v_sku, v_batch, v_loc, v_sys, v_counted, v_status, v_uid, v_key) returning id into v_id;

  if v_status = 'pending' and v_mgr then
    perform inv_apply_count(v_id);
    update stock_counts set status = 'applied', reviewed_by = v_uid, reviewed_at = now(), review_note = 'Counted by a manager'
     where id = v_id;
  end if;
  return inv_count_json(v_id) || jsonb_build_object('item', inv_item_json(v_sku));
end; $$;

create or replace function inv_review_count(p_id uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := require_role('manager'); v_status text;
begin
  select status into v_status from stock_counts where id = p_id for update;
  if v_status is null then raise exception 'Count not found'; end if;
  if v_status <> 'pending' then raise exception 'This count is already %', v_status; end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then raise exception 'Say why the count is rejected'; end if;
  if p_approve then perform inv_apply_count(p_id); end if;
  update stock_counts set status = case when p_approve then 'applied' else 'rejected' end,
         reviewed_by = v_uid, reviewed_at = now(), review_note = nullif(trim(p_note), '')
   where id = p_id;
  return inv_count_json(p_id);
end; $$;

create or replace function inv_list_counts(p_status text default 'pending')
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return (select coalesce(jsonb_agg(inv_count_json(id) order by counted_at desc), '[]'::jsonb) from (
    select id, counted_at from stock_counts
     where (p_status = 'pending' and status = 'pending') or (coalesce(p_status, 'recent') <> 'pending')
     order by counted_at desc limit 60) t);
end; $$;

-- ---------------------------------------------------------------------
-- 6. Dashboard: counts waiting for approval
-- ---------------------------------------------------------------------
create or replace function get_dashboard(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d jsonb := get_dashboard_core(p_days); v_extra jsonb := '[]'::jsonb; v_counts int;
begin
  if (select state_code is null from legal_entities order by created_at limit 1) then
    v_extra := v_extra || jsonb_build_object('severity', 'high', 'type', 'company_gst',
      'title', 'Company GSTIN and state not set', 'detail', 'GST invoices can''t be issued until this is set (Accounts → Company)', 'ref', null);
  end if;
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
-- 7. Security
-- ---------------------------------------------------------------------
alter table inventory_requests enable row level security;
alter table stock_counts enable row level security;

revoke all on all tables in schema public from anon;
revoke all on sequence internal_barcode_seq from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function storefront_catalogue(), storefront_order_status(text, text) to anon;

grant execute on function
  resolve_scan(text), inv_items(text), inv_item(uuid), inv_stock_in(jsonb), inv_stock_out(jsonb),
  inv_submit_count(jsonb), inv_review_count(uuid, boolean, text), inv_list_counts(text), get_dashboard(int)
to authenticated;

revoke execute on function
  next_internal_barcode(), inv_request_seen(text), inv_apply_count(uuid), inv_item_json(uuid), inv_count_json(uuid),
  shelf_qty(uuid, uuid, uuid)
from authenticated, service_role;
