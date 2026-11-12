-- =====================================================================
-- All stock: one read-only list of every item (finished goods, raw
-- materials, packaging) with where the quantity is and what it is worth.
-- No data changes.
-- =====================================================================
create or replace function inv_stock_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_loc uuid := default_location_id(); v_owner uuid := company_owner_id();
begin
  perform require_staff();
  return (select coalesce(jsonb_agg(x order by x->>'sort', x->>'brand', x->>'category', x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', s.id, 'code', s.code, 'name', s.name, 'item_type', p.item_type,
      'sort', case p.item_type when 'finished' then '1' when 'raw_material' then '2' else '3' end,
      'brand', b.name, 'brand_code', b.code, 'category', cat.name, 'unit', s.pack_unit, 'pack_size', s.pack_size,
      'barcode', s.barcode, 'mrp', s.mrp, 'web_price', get_price(s.id, 'WEB'),
      'is_test', s.name like 'TEST%',
      'on_shelf', q.on_shelf, 'reserved', reserved_qty(s.id, v_loc), 'free', atp_qty(s.id, v_loc),
      'expired', q.expired, 'on_hold', q.on_hold, 'packed', q.packed, 'elsewhere', q.elsewhere, 'written_off', q.written_off,
      'value', stock_value(s.id),
      'last_cost', (select unit_cost from batches where sku_id = s.id and unit_cost is not null order by created_at desc limit 1),
      'reorder_level', s.reorder_level,
      'low', atp_qty(s.id, v_loc) <= s.reorder_level,
      'next_expiry', (select min(bt.expires_on) from stock_balances sb join batches bt on bt.id = sb.batch_id
                       where sb.sku_id = s.id and sb.owner_id = v_owner and sb.status = 'available' and sb.qty > 0
                         and bt.expires_on >= today_ist())) x
    from skus s join products p on p.id = s.product_id
    left join brands b on b.id = p.brand_id
    left join categories cat on cat.id = p.category_id
    cross join lateral (
      select
        coalesce(sum(sb.qty) filter (where sb.location_id = v_loc and sb.status = 'available'), 0) on_shelf,
        coalesce(sum(sb.qty) filter (where sb.location_id = v_loc and sb.status = 'available' and bt.expires_on < today_ist()), 0) expired,
        coalesce(sum(sb.qty) filter (where sb.location_id = v_loc and sb.status = 'available' and bt.expires_on >= today_ist()
                                       and bt.qa_status <> 'released'), 0) on_hold,
        coalesce(sum(sb.qty) filter (where sb.status = 'packed'), 0) packed,
        coalesce(sum(sb.qty) filter (where sb.location_id <> v_loc and sb.status = 'available'), 0) elsewhere,
        coalesce(sum(sb.qty) filter (where sb.status in ('damaged', 'expired')), 0) written_off
      from stock_balances sb left join batches bt on bt.id = sb.batch_id
      where sb.sku_id = s.id and sb.owner_id = v_owner) q
    where s.active and p.active) t);
end; $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function storefront_catalogue(), storefront_order_status(text, text) to anon;
grant execute on function inv_stock_list() to authenticated;
