-- =====================================================================
-- Products can be edited after creation, and carry the label information
-- the website must show (ingredients, allergens, veg mark, nutrition,
-- storage, shelf life). Until the client confirms a product's label
-- information, the website shows it as a draft.
-- =====================================================================
alter table products
  add column ingredients text,
  add column allergens text,
  add column diet text check (diet in ('veg', 'vegan', 'egg', 'non_veg')),
  add column nutrition jsonb check (nutrition is null or jsonb_typeof(nutrition) = 'object'),
  add column storage text,
  add column content_confirmed boolean not null default false,
  add column content_confirmed_at timestamptz,
  add column content_confirmed_by uuid;

-- Nutrition per 100 g: only known keys, numbers ≥ 0
create or replace function clean_nutrition(p jsonb)
returns jsonb language plpgsql immutable as $$
declare k text; v jsonb; r jsonb := '{}'::jsonb;
  allowed text[] := array['energy_kcal', 'protein_g', 'carbohydrate_g', 'total_sugars_g', 'added_sugars_g', 'fat_g',
                          'saturated_fat_g', 'trans_fat_g', 'fibre_g', 'sodium_mg', 'cholesterol_mg'];
begin
  if p is null or jsonb_typeof(p) <> 'object' then return null; end if;
  for k, v in select * from jsonb_each(p) loop
    continue when not (k = any(allowed)) or v is null or v = 'null'::jsonb or v = '""'::jsonb;
    if jsonb_typeof(v) not in ('number', 'string') or (v #>> '{}') !~ '^\d+(\.\d+)?$' then
      raise exception 'Nutrition "%" must be a number', k;
    end if;
    r := r || jsonb_build_object(k, (v #>> '{}')::numeric);
  end loop;
  return nullif(r, '{}'::jsonb);
end; $$;

-- Everything the edit screen needs for one product and its packs
create or replace function get_product_details(p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform require_staff();
  select jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'item_type', p.item_type, 'brand_id', p.brand_id,
      'category_id', p.category_id, 'tax_rate_id', p.tax_rate_id, 'shelf_life_days', p.shelf_life_days, 'active', p.active,
      'description', p.description, 'ingredients', p.ingredients, 'allergens', p.allergens, 'diet', p.diet, 'nutrition', p.nutrition,
      'storage', p.storage, 'content_confirmed', p.content_confirmed, 'content_confirmed_at', p.content_confirmed_at,
      'has_history', exists (select 1 from skus s where s.product_id = p.id
                              and (exists (select 1 from order_lines ol where ol.sku_id = s.id)
                                   or exists (select 1 from stock_movements m where m.sku_id = s.id))),
      'skus', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name, 'mrp', s.mrp,
                 'reorder_level', s.reorder_level, 'weight_grams', s.weight_grams, 'active', s.active, 'barcode', s.barcode,
                 'web_price', get_price(s.id, 'WEB'), 'strategic_price', get_price(s.id, 'WEB_STRATEGIC')) order by s.pack_size, s.name), '[]'::jsonb)
               from skus s where s.product_id = p.id))
    into v from products p where p.id = p_product_id;
  if v is null then raise exception 'Product not found'; end if;
  return v;
end; $$;

-- Edit a product. p: any of {name, brand_id, category_id, tax_rate_id, shelf_life_days, active, description,
--   ingredients, allergens, diet, nutrition, storage, content_confirmed}
create or replace function update_product(p_product_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := require_role('manager'); r products%rowtype; v_hist boolean;
begin
  select * into r from products where id = p_product_id for update;
  if r.id is null then raise exception 'Product not found'; end if;
  v_hist := (get_product_details(p_product_id)->>'has_history')::boolean;

  if p ? 'brand_id' and (p->>'brand_id')::uuid is distinct from r.brand_id then
    if r.item_type <> 'finished' then raise exception 'Raw materials and packaging have no brand'; end if;
    if v_hist then raise exception 'This product already has orders or stock, so its brand can''t change. Create a new product instead.'; end if;
    r.brand_id := (p->>'brand_id')::uuid;
  end if;
  if p ? 'name' then
    if coalesce(trim(p->>'name'), '') = '' then raise exception 'A product needs a name'; end if;
    r.name := trim(p->>'name');
  end if;
  if p ? 'category_id' then r.category_id := nullif(p->>'category_id', '')::uuid; end if;
  if p ? 'tax_rate_id' then r.tax_rate_id := nullif(p->>'tax_rate_id', '')::uuid; end if;
  if p ? 'shelf_life_days' then
    r.shelf_life_days := nullif(p->>'shelf_life_days', '')::int;
    if r.shelf_life_days is not null and r.shelf_life_days <= 0 then raise exception 'Shelf life must be more than 0 days'; end if;
  end if;
  if p ? 'active' then r.active := (p->>'active')::boolean; end if;
  if p ? 'description' then r.description := nullif(trim(p->>'description'), ''); end if;
  if p ? 'ingredients' then r.ingredients := nullif(trim(p->>'ingredients'), ''); end if;
  if p ? 'allergens' then r.allergens := nullif(trim(p->>'allergens'), ''); end if;
  if p ? 'diet' then r.diet := nullif(p->>'diet', ''); end if;
  if p ? 'nutrition' then r.nutrition := clean_nutrition(p->'nutrition'); end if;
  if p ? 'storage' then r.storage := nullif(trim(p->>'storage'), ''); end if;
  if p ? 'content_confirmed' then
    if (p->>'content_confirmed')::boolean and not r.content_confirmed then
      if r.ingredients is null or r.diet is null then
        raise exception 'Fill in at least the ingredients and veg mark before confirming the label information';
      end if;
      r.content_confirmed := true; r.content_confirmed_at := now(); r.content_confirmed_by := v_uid;
    elsif not (p->>'content_confirmed')::boolean then
      r.content_confirmed := false; r.content_confirmed_at := null; r.content_confirmed_by := null;
    end if;
  end if;

  update products set brand_id = r.brand_id, name = r.name, category_id = r.category_id, tax_rate_id = r.tax_rate_id,
         shelf_life_days = r.shelf_life_days, active = r.active, description = r.description, ingredients = r.ingredients,
         allergens = r.allergens, diet = r.diet, nutrition = r.nutrition, storage = r.storage,
         content_confirmed = r.content_confirmed, content_confirmed_at = r.content_confirmed_at, content_confirmed_by = r.content_confirmed_by
   where id = r.id;
  return get_product_details(r.id);
end; $$;

-- Edit a pack (SKU). p: any of {name, reorder_level, weight_grams, active, mrp}. MRP changes are admin-only.
create or replace function update_sku(p_sku_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r skus%rowtype;
begin
  perform require_role('manager');
  select * into r from skus where id = p_sku_id for update;
  if r.id is null then raise exception 'Pack not found'; end if;
  if p ? 'name' then
    if coalesce(trim(p->>'name'), '') = '' then raise exception 'A pack needs a name'; end if;
    r.name := trim(p->>'name');
  end if;
  if p ? 'reorder_level' then r.reorder_level := coalesce(nullif(p->>'reorder_level', '')::int, 0); end if;
  if p ? 'weight_grams' then r.weight_grams := nullif(p->>'weight_grams', '')::numeric; end if;
  if p ? 'active' then r.active := (p->>'active')::boolean; end if;
  if p ? 'mrp' and nullif(p->>'mrp', '')::numeric is distinct from r.mrp then
    if current_staff_role()::text <> 'admin' then raise exception 'Only an admin can change MRP'; end if;
    r.mrp := nullif(p->>'mrp', '')::numeric;
    if r.mrp is not null then perform set_price(r.id, 'MRP', r.mrp); end if;
  end if;
  update skus set name = r.name, reorder_level = r.reorder_level, weight_grams = r.weight_grams, active = r.active, mrp = r.mrp
   where id = r.id;
  return jsonb_build_object('ok', true);
end; $$;

-- The website catalogue also carries each product's label information
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
      'max_qty', case when q.atp <= 0 then 0 when q.atp <= v_cap then floor(q.atp)::int else v_max end,
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

revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on function storefront_catalogue(), storefront_order_status(text, text) to anon, authenticated, service_role;
grant execute on function storefront_notify_me(text, text, boolean, text) to anon, authenticated, service_role;
grant execute on function get_product_details(uuid), update_product(uuid, jsonb), update_sku(uuid, jsonb) to authenticated;
