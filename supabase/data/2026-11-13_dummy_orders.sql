-- =====================================================================
-- Dummy test orders, one for every order screen state (owner request
-- 2026-11-13). Everything is TEST data: WEB-TEST orders with a "TEST ORDER"
-- note, customers "Test Customer …" (phones 90000004xx, @example.com),
-- TEST · ingredients and recipes only on the 3 TEST · products, and stock
-- added with the testing-mode override (batches noted TEST STOCK).
-- Runs as the admin in one transaction; any order landing in the wrong
-- state raises an error and nothing is saved.
-- =====================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"90673fd3-c268-4ba0-a0c7-f188fdf488a7","role":"authenticated"}', true);

do $$
declare
  cookies uuid := (select id from skus where code = 'MT-000001');
  atta1 uuid := (select id from skus where code = 'NS-000001');
  atta5 uuid := (select id from skus where code = 'NS-000002');
  flour uuid; butter uuid; box uuid; bulk uuid; pouch5 uuid; pouch1 uuid;
  n int := 0; o jsonb; ids jsonb := '{}'; v_state text; bc text; r jsonb; want text; k text;
  expect jsonb := '{}';
begin
  if not testing_mode_on() then raise exception 'Testing mode must be on'; end if;
  if exists (select 1 from skus where name like 'TEST · %' and code like 'RM-%' or name like 'TEST · %' and code like 'PK-%') then
    raise exception 'Dummy ingredients already exist — this script has been run before';
  end if;

  -- 1. TEST ingredients and packaging
  flour  := (create_material('{"name":"TEST · Refined flour","item_type":"raw_material","unit":"kg"}')->>'sku_id')::uuid;
  butter := (create_material('{"name":"TEST · Butter","item_type":"raw_material","unit":"kg"}')->>'sku_id')::uuid;
  bulk   := (create_material('{"name":"TEST · Multigrain atta (bulk)","item_type":"raw_material","unit":"kg"}')->>'sku_id')::uuid;
  box    := (create_material('{"name":"TEST · Cookie box","item_type":"packaging","unit":"pcs"}')->>'sku_id')::uuid;
  pouch5 := (create_material('{"name":"TEST · 5 kg pouch","item_type":"packaging","unit":"pcs"}')->>'sku_id')::uuid;
  pouch1 := (create_material('{"name":"TEST · 1 kg pouch","item_type":"packaging","unit":"pcs"}')->>'sku_id')::uuid;

  -- 2. TEST recipes (only on the TEST · products)
  perform save_recipe(jsonb_build_object('sku_id', cookies, 'output_qty', 10, 'notes', 'TEST recipe for screen testing',
    'lines', jsonb_build_array(jsonb_build_object('material_sku_id', flour, 'qty', 1, 'wastage_pct', 0),
                               jsonb_build_object('material_sku_id', butter, 'qty', 0.5, 'wastage_pct', 0),
                               jsonb_build_object('material_sku_id', box, 'qty', 10, 'wastage_pct', 0))));
  perform save_recipe(jsonb_build_object('sku_id', atta5, 'output_qty', 1, 'notes', 'TEST repack recipe',
    'lines', jsonb_build_array(jsonb_build_object('material_sku_id', bulk, 'qty', 5, 'wastage_pct', 0),
                               jsonb_build_object('material_sku_id', pouch5, 'qty', 1, 'wastage_pct', 0))));
  perform save_recipe(jsonb_build_object('sku_id', atta1, 'output_qty', 1, 'notes', 'TEST repack recipe',
    'lines', jsonb_build_array(jsonb_build_object('material_sku_id', bulk, 'qty', 1, 'wastage_pct', 0),
                               jsonb_build_object('material_sku_id', pouch1, 'qty', 1, 'wastage_pct', 0))));

  -- 3. TEST stock: 5 cookies; ingredients for cookies and the 5 kg atta; NO 1 kg pouches
  perform test_stock_in(jsonb_build_object('sku_id', cookies, 'qty', 5));
  perform test_stock_in(jsonb_build_object('sku_id', flour, 'qty', 5));
  perform test_stock_in(jsonb_build_object('sku_id', butter, 'qty', 3));
  perform test_stock_in(jsonb_build_object('sku_id', box, 'qty', 50));
  perform test_stock_in(jsonb_build_object('sku_id', bulk, 'qty', 15));
  perform test_stock_in(jsonb_build_object('sku_id', pouch5, 'qty', 5));

  -- 4. Orders (labels A–J), each placed like a website test order
  for k, r, want in
    select * from (values
      ('A', '{"lines":[{"sku_code":"MT-000001","qty":2}],"pay":"cod"}'::jsonb, 'ready'),
      ('B', '{"lines":[{"sku_code":"MT-000001","qty":1}],"pay":"cod"}', 'packed'),
      ('C', '{"lines":[{"sku_code":"MT-000001","qty":1}],"pay":"cod"}', 'sent'),
      ('D', '{"lines":[{"sku_code":"MT-000001","qty":1}],"pay":"cod"}', 'failed'),
      ('E', '{"lines":[{"sku_code":"MT-000001","qty":12}],"pay":"cod"}', 'make'),
      ('F', '{"lines":[{"sku_code":"NS-000002","qty":2}],"pay":"cod"}', 'repack'),
      ('G', '{"lines":[{"sku_code":"NS-000001","qty":3}],"pay":"cod"}', 'rm_short'),
      ('H', '{"lines":[{"sku_code":"MT-000021","qty":2}],"pay":"cod"}', 'no_recipe'),
      ('I', '{"lines":[{"sku_code":"MT-000001","qty":1},{"sku_code":"NS-000002","qty":1}],"pay":"cod"}', 'make_mixed'),
      ('J', '{"lines":[{"sku_code":"NS-000002","qty":1}],"pay":"unpaid"}', 'unpaid')
    ) v(k, r, want)
  loop
    n := n + 1;
    o := ingest_order('WEB-TEST', 'dummy-2026-11-13-' || k, jsonb_build_object(
      'external_order_id', 'DUMMY-' || k, 'channel', 'WEB',
      'customer', jsonb_build_object('name', 'Test Customer ' || k, 'phone', '90000004' || lpad(n::text, 2, '0'),
                                     'email', 'test+' || lower(k) || '@example.com', 'city', 'Hyderabad', 'state', 'Telangana', 'pincode', '500034'),
      'ship_to', jsonb_build_object('name', 'Test Customer ' || k, 'phone', '90000004' || lpad(n::text, 2, '0'),
                                    'address1', 'TEST ADDRESS ' || k || ', Road No. 1', 'city', 'Hyderabad', 'state', 'Telangana', 'pincode', '500034'),
      'lines', r->'lines', 'shipping_amount', 0,
      'payment', jsonb_build_object('status', r->>'pay', 'method', case when r->>'pay' = 'cod' then 'cod' end),
      'notes', 'TEST ORDER — dummy order for screen testing (expected: ' || want || ')'));
    if not (o->>'ok')::boolean then raise exception 'Order % not placed: %', k, o; end if;
    ids := ids || jsonb_build_object(k, o->>'order_id');
    expect := expect || jsonb_build_object(k, want);

    -- move B, C, D along: pack (scan each pack from the TEST batch), then dispatch / fail
    if k in ('B', 'C', 'D') then
      bc := (select b.code from batches b where b.sku_id = cookies order by b.created_at limit 1);
      r := pack_scan(p_order_id => (o->>'order_id')::uuid, p_code => bc, p_idempotency_key => 'dummy-scan-' || k);
      if r->>'result' <> 'accepted' then raise exception 'Pack scan for % refused: %', k, r->>'message'; end if;
      perform complete_packing((o->>'order_id')::uuid);
      if k in ('C', 'D') then
        perform dispatch_order((o->>'order_id')::uuid, 'OWN', 'TEST-DUMMY-' || k);
      end if;
      if k = 'D' then
        perform mark_delivery_failed((o->>'order_id')::uuid, 'TEST — customer not at home (dummy order)');
      end if;
    end if;
  end loop;

  -- 5. Check every order is where it should be (else roll everything back)
  for k in select jsonb_object_keys(ids) loop
    select o2.code || ' ' || o2.status || case when o2.stock_shortfall then ' short' else '' end into v_state
      from orders o2 where o2.id = (ids->>k)::uuid;
    want := expect->>k;
    if not (
         (want = 'ready'     and v_state ~ ' confirmed$')
      or (want = 'packed'    and v_state ~ ' packed$')
      or (want = 'sent'      and v_state ~ ' dispatched$')
      or (want = 'failed'    and v_state ~ ' delivery_failed$')
      or (want in ('make', 'repack', 'rm_short', 'no_recipe', 'make_mixed') and v_state ~ ' confirmed short$')
      or (want = 'unpaid'    and v_state ~ ' pending_payment')) then
      raise exception 'Order % (%): expected %, got %', k, (ids->>k), want, v_state;
    end if;
    raise notice '% → % (%)', k, v_state, want;
  end loop;
end $$;

commit;
