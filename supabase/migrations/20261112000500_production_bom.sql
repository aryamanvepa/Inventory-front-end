-- =====================================================================
-- Migration 0012 — Recipes (bill of materials) and production orders
--
-- Recipe: for one finished SKU, the materials (ingredients + packaging)
-- needed to make `output_qty` packs, with an allowance for wastage.
-- Recipes are versioned, never edited: saving creates a new version.
--
-- Production order: plan -> complete. Completing it
--   * consumes materials at the production location (own factory, or
--     company-owned stock held at a contract manufacturer), oldest
--     expiry first, recording actual vs standard quantities;
--   * creates the finished batch with a true unit cost
--     (materials consumed + conversion cost) / packs produced;
--   * posts one stock transaction and one journal:
--       Dr Inventory–finished   Cr Inventory–raw/packaging
--                               Cr Production overheads absorbed
-- =====================================================================

create table recipes (
  id          uuid primary key default gen_random_uuid(),
  sku_id      uuid not null references skus(id),
  version     int not null,
  output_qty  numeric(14,3) not null check (output_qty > 0),   -- packs produced per run of this recipe
  notes       text,
  active      boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (sku_id, version)
);
create unique index recipes_one_active on recipes (sku_id) where active;
create trigger no_delete before delete on recipes for each row execute function trg_no_delete();

create table recipe_lines (
  id              uuid primary key default gen_random_uuid(),
  recipe_id       uuid not null references recipes(id),
  material_sku_id uuid not null references skus(id),
  qty             numeric(14,4) not null check (qty > 0),      -- in the material's unit, per run
  wastage_pct     numeric(5,2) not null default 0 check (wastage_pct >= 0 and wastage_pct < 100),
  unique (recipe_id, material_sku_id)
);
create trigger immutable before update or delete on recipe_lines for each row execute function trg_immutable();

create table production_orders (
  id                      uuid primary key default gen_random_uuid(),
  code                    text unique,                    -- PRD-2026-000001
  sku_id                  uuid not null references skus(id),
  recipe_id               uuid not null references recipes(id),
  planned_qty             numeric(14,3) not null check (planned_qty > 0),
  location_id             uuid not null references locations(id),
  manufacturer_partner_id uuid references business_partners(id),   -- null = own facility
  status                  text not null default 'planned' check (status in ('planned', 'completed', 'cancelled')),
  planned_date            date not null default today_ist(),
  output_qty              numeric(14,3),
  output_batch_id         uuid references batches(id),
  material_cost           numeric(14,2),
  conversion_cost         numeric(14,2),
  unit_cost               numeric(12,4),
  notes                   text,
  created_by              uuid,
  created_at              timestamptz not null default now(),
  completed_at            timestamptz,
  completed_by            uuid
);
create trigger assign_code before insert on production_orders for each row execute function trg_assign_code('PRD', 'yearly');
create trigger audit after insert or update or delete on production_orders for each row execute function trg_audit();
create trigger no_delete before delete on production_orders for each row execute function trg_no_delete();

create table production_consumptions (
  id                  uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references production_orders(id),
  material_sku_id     uuid not null references skus(id),
  batch_id            uuid not null references batches(id),
  qty                 numeric(14,4) not null check (qty > 0),
  unit_cost           numeric(12,4),
  standard_qty        numeric(14,4) not null          -- this material's standard for the actual output (per material, repeated per batch row)
);
create trigger immutable before update or delete on production_consumptions for each row execute function trg_immutable();

-- Latest known cost of a material (for standard-cost estimates)
create or replace function latest_unit_cost(p_sku uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select unit_cost from batches where sku_id = p_sku and unit_cost is not null order by created_at desc limit 1
$$;

-- Save a recipe (creates a new version and makes it active)
-- p: {sku_id, output_qty, notes, lines:[{material_sku_id, qty, wastage_pct}]}
create or replace function save_recipe(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_sku uuid := (p->>'sku_id')::uuid; v_ver int; v_id uuid; l jsonb;
begin
  perform require_role('manager');
  if item_type_of(v_sku) is distinct from 'finished' then raise exception 'Recipes are for finished products'; end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then raise exception 'Add at least one material'; end if;
  perform pg_advisory_xact_lock(hashtext('recipe:' || v_sku));
  select coalesce(max(version), 0) + 1 into v_ver from recipes where sku_id = v_sku;
  update recipes set active = false where sku_id = v_sku and active;
  insert into recipes (sku_id, version, output_qty, notes, created_by)
  values (v_sku, v_ver, (p->>'output_qty')::numeric, nullif(p->>'notes', ''), auth.uid()) returning id into v_id;
  for l in select * from jsonb_array_elements(p->'lines') loop
    if item_type_of((l->>'material_sku_id')::uuid) not in ('raw_material', 'packaging') then
      raise exception 'Only raw materials and packaging can go into a recipe';
    end if;
    insert into recipe_lines (recipe_id, material_sku_id, qty, wastage_pct)
    values (v_id, (l->>'material_sku_id')::uuid, (l->>'qty')::numeric, coalesce(nullif(l->>'wastage_pct', '')::numeric, 0));
  end loop;
  return jsonb_build_object('recipe_id', v_id, 'version', v_ver);
end; $$;

-- Recipe with standard cost per pack (from latest material costs)
create or replace function get_recipe(p_sku_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r recipes%rowtype;
begin
  perform require_staff();
  select * into r from recipes where sku_id = p_sku_id and active;
  if r.id is null then return null; end if;
  return jsonb_build_object('id', r.id, 'version', r.version, 'output_qty', r.output_qty, 'notes', r.notes, 'created_at', r.created_at,
    'sku', (select jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name) from skus s where s.id = r.sku_id),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('material_sku_id', m.id, 'code', m.code, 'name', m.name, 'unit', m.pack_unit,
                'item_type', item_type_of(m.id), 'qty', rl.qty, 'wastage_pct', rl.wastage_pct,
                'unit_cost', latest_unit_cost(m.id),
                'cost', round(rl.qty * (1 + rl.wastage_pct / 100) * coalesce(latest_unit_cost(m.id), 0), 2)) order by m.code), '[]'::jsonb)
              from recipe_lines rl join skus m on m.id = rl.material_sku_id where rl.recipe_id = r.id),
    'standard_cost_per_unit', (select round(sum(rl.qty * (1 + rl.wastage_pct / 100) * coalesce(latest_unit_cost(rl.material_sku_id), 0)) / r.output_qty, 4)
                                 from recipe_lines rl where rl.recipe_id = r.id),
    'missing_costs', (select count(*) from recipe_lines rl where rl.recipe_id = r.id and latest_unit_cost(rl.material_sku_id) is null));
end; $$;

create or replace function list_recipes()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return (select coalesce(jsonb_agg(get_recipe(r.sku_id) order by s.code), '[]'::jsonb)
            from recipes r join skus s on s.id = r.sku_id where r.active);
end; $$;

-- Plan a production run
create or replace function create_production_order(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_sku uuid := (p->>'sku_id')::uuid; v_recipe uuid; v_loc uuid; v_partner uuid; v_po production_orders%rowtype;
begin
  perform require_role('manager', 'warehouse');
  select id into v_recipe from recipes where sku_id = v_sku and active;
  if v_recipe is null then raise exception 'This product has no recipe yet'; end if;
  v_loc := coalesce(nullif(p->>'location_id', '')::uuid, default_location_id());
  select partner_id into v_partner from locations where id = v_loc;
  insert into production_orders (sku_id, recipe_id, planned_qty, location_id, manufacturer_partner_id, planned_date, notes, created_by)
  values (v_sku, v_recipe, (p->>'planned_qty')::numeric, v_loc, v_partner,
          coalesce(nullif(p->>'planned_date', '')::date, today_ist()), nullif(p->>'notes', ''), auth.uid())
  returning * into v_po;
  return jsonb_build_object('production_order_id', v_po.id, 'code', v_po.code);
end; $$;

-- Material requirement for a quantity of output
create or replace function production_requirements(p_order uuid, p_output numeric default null)
returns table (material_sku_id uuid, standard_qty numeric)
language sql stable security definer set search_path = public as $$
  select rl.material_sku_id,
         round(rl.qty * (1 + rl.wastage_pct / 100) * coalesce(p_output, po.planned_qty) / r.output_qty, 4)
    from production_orders po join recipes r on r.id = po.recipe_id join recipe_lines rl on rl.recipe_id = r.id
   where po.id = p_order
$$;

create or replace function get_production_order(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare po production_orders%rowtype;
begin
  perform require_staff();
  select * into po from production_orders where id = p_id;
  if po.id is null then raise exception 'Production order not found'; end if;
  return jsonb_build_object('id', po.id, 'code', po.code, 'status', po.status, 'planned_qty', po.planned_qty,
    'planned_date', po.planned_date, 'output_qty', po.output_qty, 'material_cost', po.material_cost,
    'conversion_cost', po.conversion_cost, 'unit_cost', po.unit_cost, 'notes', po.notes, 'completed_at', po.completed_at,
    'yield_pct', case when po.output_qty is not null then round(100 * po.output_qty / po.planned_qty, 1) end,
    'sku', (select jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name) from skus s where s.id = po.sku_id),
    'location', (select jsonb_build_object('id', l.id, 'name', l.name, 'type', l.type) from locations l where l.id = po.location_id),
    'recipe_version', (select version from recipes where id = po.recipe_id),
    'output_batch', (select jsonb_build_object('id', b.id, 'code', b.code, 'expires_on', b.expires_on, 'qa_status', b.qa_status)
                       from batches b where b.id = po.output_batch_id),
    'requirements', (select coalesce(jsonb_agg(jsonb_build_object('material_sku_id', m.id, 'code', m.code, 'name', m.name, 'unit', m.pack_unit,
                       'required', req.standard_qty, 'available', sellable_qty(m.id, po.location_id),
                       'short', greatest(req.standard_qty - sellable_qty(m.id, po.location_id), 0)) order by m.code), '[]'::jsonb)
                     from production_requirements(po.id) req join skus m on m.id = req.material_sku_id),
    'consumptions', (select coalesce(jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'unit', m.pack_unit,
                       'batch', b.code, 'qty', c.qty, 'unit_cost', c.unit_cost, 'standard_qty', c.standard_qty) order by m.code), '[]'::jsonb)
                     from production_consumptions c join skus m on m.id = c.material_sku_id join batches b on b.id = c.batch_id
                     where c.production_order_id = po.id));
end; $$;

create or replace function list_production_orders(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return (select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', po.id, 'code', po.code, 'status', po.status, 'planned_qty', po.planned_qty,
      'output_qty', po.output_qty, 'planned_date', po.planned_date, 'unit_cost', po.unit_cost, 'created_at', po.created_at,
      'sku_name', s.name, 'sku_code', s.code, 'location', l.name,
      'yield_pct', case when po.output_qty is not null then round(100 * po.output_qty / po.planned_qty, 1) end) x
    from production_orders po join skus s on s.id = po.sku_id join locations l on l.id = po.location_id
    where p_status is null or p_status = '' or po.status = p_status) t);
end; $$;

-- Complete a production run.
-- p: {production_order_id, output_qty, manufactured_on?, expires_on?, conversion_cost?, hold_for_qa?,
--     consumptions?: [{material_sku_id, qty}]  (default: recipe standard for the actual output),
--     idempotency_key?}
create or replace function complete_production(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
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
  v_exp := coalesce(nullif(p->>'expires_on', '')::date, v_mfg + v_shelf);
  if v_exp is null then raise exception 'Enter an expiry date (product has no shelf life set)'; end if;

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
end; $$;

create or replace function cancel_production_order(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform require_role('manager', 'warehouse');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  update production_orders set status = 'cancelled', notes = coalesce(notes || E'\n', '') || 'Cancelled: ' || p_reason
   where id = p_id and status = 'planned';
  if not found then raise exception 'Only planned production orders can be cancelled'; end if;
  return jsonb_build_object('ok', true);
end; $$;
