-- =====================================================================
-- Live database view (admin only, read-only): what every table holds, and a
-- feed of every change as it happens — record changes (audit log), stock
-- movements, accounting entries, payments, packing scans, invoices, website
-- events and back-in-stock requests — so a tester can see what each click does.
-- =====================================================================
create or replace function inspect_tables()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record; v_n bigint; out jsonb := '[]'::jsonb;
begin
  perform require_role('admin');
  for r in select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' order by c.relname loop
    execute format('select count(*) from public.%I', r.t) into v_n;
    out := out || jsonb_build_object('table', r.t, 'rows', v_n, 'area', case
      when r.t in ('brands', 'categories', 'products', 'skus', 'gtins', 'tax_rates', 'price_lists', 'price_list_items', 'sales_channels', 'recipes', 'recipe_lines') then 'Catalogue'
      when r.t in ('batches', 'stock_transactions', 'stock_movements', 'stock_balances', 'stock_reservations', 'locations', 'stock_owners', 'stock_counts', 'inventory_requests') then 'Stock'
      when r.t in ('orders', 'order_lines', 'payments', 'pack_scans', 'shipments', 'customers', 'customer_external_refs', 'customer_consents', 'delivery_providers', 'integration_events', 'stock_alert_requests') then 'Orders & customers'
      when r.t in ('business_partners', 'partner_roles', 'purchase_orders', 'purchase_order_lines', 'purchase_receipts', 'purchase_bills', 'purchase_bill_lines', 'supplier_payments', 'production_orders', 'production_consumptions') then 'Purchasing & production'
      when r.t in ('accounts', 'journal_entries', 'journal_lines', 'accounting_periods', 'accounting_exceptions', 'invoices', 'invoice_lines', 'credit_notes', 'credit_note_lines', 'gst_states', 'legal_entities') then 'Accounts & GST'
      else 'System' end,
      'about', obj_description(format('public.%I', r.t)::regclass, 'pg_class'));
  end loop;
  return jsonb_build_object('tables', out,
    'auth_users', (select count(*) from auth.users),
    'database_size', pg_size_pretty(pg_database_size(current_database())),
    'server_time', now());
end; $$;

-- Feed of changes after p_since (newest first). Each item: at, kind, table, action, title, detail.
create or replace function inspect_activity(p_since timestamptz default null, p_limit int default 150)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_since timestamptz := coalesce(p_since, now() - interval '15 minutes');
begin
  perform require_role('admin');
  return (select coalesce(jsonb_agg(x order by (x->>'at')::timestamptz desc, x->>'seq' desc), '[]'::jsonb) from (
    select * from (
      -- record changes on audited tables (orders, products, batches, purchase/production orders, settings…)
      select jsonb_build_object('at', a.occurred_at, 'seq', a.id::text, 'kind', 'record', 'table', a.table_name, 'action', a.action,
        'title', coalesce(a.new_data->>'code', a.old_data->>'code', a.new_data->>'name', a.old_data->>'name', a.new_data->>'key', a.record_id::text),
        'detail', case a.action
          when 'UPDATE' then coalesce((select jsonb_object_agg(k, jsonb_build_object('from', a.old_data->k, 'to', a.new_data->k))
                                from jsonb_object_keys(a.new_data) k where a.new_data->k is distinct from a.old_data->k), '{}'::jsonb)
          when 'INSERT' then a.new_data else a.old_data end,
        'who', (select full_name from staff_profiles where user_id = a.actor)) x
        from audit_log a where a.occurred_at > v_since
      union all
      -- stock movements (append-only ledger)
      select jsonb_build_object('at', t.created_at, 'seq', t.id::text, 'kind', 'stock', 'table', 'stock_transactions + stock_movements', 'action', 'INSERT',
        'title', coalesce(t.code, 'stock') || ' · ' || t.txn_type || coalesce(' · ' || t.reason, ''),
        'detail', jsonb_build_object('lines', (select jsonb_agg(jsonb_build_object('sku', s.code, 'item', s.name, 'batch', b.code, 'location', l.name,
                     'status', m.status, 'qty', m.qty) order by m.id) from stock_movements m join skus s on s.id = m.sku_id
                     join locations l on l.id = m.location_id left join batches b on b.id = m.batch_id where m.transaction_id = t.id)),
        'who', (select full_name from staff_profiles where user_id = t.created_by))
        from stock_transactions t where t.created_at > v_since
      union all
      -- accounting entries (double-entry ledger)
      select jsonb_build_object('at', j.created_at, 'seq', j.id::text, 'kind', 'ledger', 'table', 'journal_entries + journal_lines', 'action', 'INSERT',
        'title', j.code || ' · ' || coalesce(j.narration, j.source_type),
        'detail', jsonb_build_object('source', j.source_type, 'lines', (select jsonb_agg(jsonb_build_object('account', ac.code || ' ' || ac.name,
                     'debit', nullif(jl.debit, 0), 'credit', nullif(jl.credit, 0)) order by jl.debit desc, jl.id) from journal_lines jl
                     join accounts ac on ac.id = jl.account_id where jl.entry_id = j.id)),
        'who', (select full_name from staff_profiles where user_id = j.created_by))
        from journal_entries j where j.created_at > v_since
      union all
      select jsonb_build_object('at', p.received_at, 'seq', p.id::text, 'kind', 'payment', 'table', 'payments', 'action', 'INSERT',
        'title', p.code || ' · ' || p.kind || ' ₹' || p.amount || coalesce(' · ' || p.method, ''),
        'detail', jsonb_build_object('order', (select code from orders where id = p.order_id), 'gateway_ref', p.gateway_ref),
        'who', (select full_name from staff_profiles where user_id = p.created_by))
        from payments p where p.received_at > v_since
      union all
      select jsonb_build_object('at', sc.scanned_at, 'seq', sc.id::text, 'kind', 'scan', 'table', 'pack_scans', 'action', 'INSERT',
        'title', (select code from orders where id = sc.order_id) || ' · ' || sc.result || ' · ' || sc.scanned_code,
        'detail', jsonb_build_object('message', sc.message, 'qty', sc.qty, 'manual_batch', sc.manual_batch),
        'who', (select full_name from staff_profiles where user_id = sc.scanned_by))
        from pack_scans sc where sc.scanned_at > v_since
      union all
      select jsonb_build_object('at', i.created_at, 'seq', i.id::text, 'kind', 'invoice', 'table', 'invoices + invoice_lines', 'action', 'INSERT',
        'title', i.code || ' · ₹' || i.total || ' (GST ' || (i.cgst + i.sgst + i.igst) || ')',
        'detail', jsonb_build_object('order', (select code from orders where id = i.order_id), 'taxable', i.taxable_value,
                   'cgst', i.cgst, 'sgst', i.sgst, 'igst', i.igst, 'supply', i.supply_type),
        'who', (select full_name from staff_profiles where user_id = i.created_by))
        from invoices i where i.created_at > v_since
      union all
      select jsonb_build_object('at', e.received_at, 'seq', e.id::text, 'kind', 'website', 'table', 'integration_events', 'action', 'INSERT',
        'title', e.source || ' · ' || coalesce(e.event_type, 'event') || ' · ' || e.status,
        'detail', jsonb_build_object('order', (select code from orders where id = e.order_id), 'error', e.error), 'who', null)
        from integration_events e where e.received_at > v_since
      union all
      select jsonb_build_object('at', r.created_at, 'seq', r.id::text, 'kind', 'website', 'table', 'stock_alert_requests', 'action', 'INSERT',
        'title', 'Notify me · ' || (select name from skus where id = r.sku_id),
        'detail', jsonb_build_object('email', regexp_replace(r.email, '^(.).*(@.*)$', '\1•••\2'), 'status', r.status), 'who', null)
        from stock_alert_requests r where r.created_at > v_since
    ) u order by (x->>'at')::timestamptz desc limit greatest(1, least(p_limit, 500))
  ) t);
end; $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function storefront_catalogue(), storefront_order_status(text, text) to anon, authenticated, service_role;
grant execute on function storefront_notify_me(text, text, boolean, text) to anon, authenticated, service_role;
grant execute on function inspect_tables(), inspect_activity(timestamptz, int) to authenticated;
