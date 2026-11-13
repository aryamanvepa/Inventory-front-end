-- =====================================================================
-- B15 · Catalogue status (requested by the storefront, 2026-11-13)
-- Every storefront_catalogue row gets
--   status: 'available' | 'out_of_stock' | 'coming_soon' | 'discontinued'
-- derived from existing data (no schema change):
--   discontinued  = the SKU, its product or its brand is switched off
--                   (these rows are now returned too: price may be null,
--                   max_qty 0, availability 'sold_out')
--   available     = free stock to sell now
--   out_of_stock  = none free now, but it has really been stocked or sold
--   coming_soon   = never stocked or sold (stock added with the testing
--                   override and WEB-TEST orders don't count)
-- quote/place are unchanged: they already refuse switched-off products
-- ('unavailable') and anything without free stock ('sold_out').
-- =====================================================================
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
    ranked as (select product_id, dense_rank() over (order by units desc)::int rnk from sold),
    -- ever really stocked (test-override stock doesn't count) or sold (test orders don't count)
    history as (
      select s.id sku_id,
             exists (select 1 from stock_movements m left join batches bt on bt.id = m.batch_id
                      where m.sku_id = s.id and m.qty > 0 and m.status = 'available'
                        and coalesce(bt.qa_notes, '') not like 'TEST STOCK%') stocked,
             exists (select 1 from order_lines ol join orders o on o.id = ol.order_id
                      where ol.sku_id = s.id and o.status <> 'cancelled' and coalesce(o.external_source, '') <> 'WEB-TEST') sold
        from skus s)
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
      'status', case when not q.live then 'discontinued'
                     when q.atp > 0 then 'available'
                     when h.stocked or h.sold then 'out_of_stock'
                     else 'coming_soon' end,
      'availability', case when not q.live or q.atp <= 0 then 'sold_out'
                           when q.atp <= s.reorder_level then 'low'
                           else 'in_stock' end,
      'only_left', case when q.live and q.atp > 0 and q.atp <= v_cap then floor(q.atp)::int end,
      'max_qty', case when not q.live or q.atp <= 0 then 0 when q.atp <= v_cap then floor(q.atp)::int else v_max end,
      'bestseller_rank', case when q.live then (select rnk from ranked where product_id = p.id) end,
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
    join history h on h.sku_id = s.id
    cross join lateral (select get_price(s.id, 'WEB') as price,
                               coalesce(atp_qty(s.id, v_loc), 0) as atp,
                               (s.active and p.active and b.active) as live) q
    -- on sale (with a web price), or discontinued: kept so old links and bags can say "no longer available"
    where (q.live and q.price is not null) or not q.live
  ) t);
end; $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function storefront_catalogue(), storefront_order_status(text, text),
  storefront_notify_me(text, text, boolean, text), storefront_request_cancellation(text, text, text)
  to anon, authenticated, service_role;
