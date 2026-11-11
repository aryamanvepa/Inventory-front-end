-- =====================================================================
-- Migration 0014 — Financial reports, MIS, backfill and security
--
--   trial_balance · profit_and_loss · balance_sheet · gst_summary
--   account_statement · list_journals · receivables/payables ageing
--   inventory_valuation (ledger vs stock reconciliation) · get_mis
--   Founder dashboard gains finance alerts (accounting exceptions).
--   ledger_backfill() posts everything that happened before the ledger.
-- =====================================================================

-- Every active staff member, now including accountants (plpgsql so the new
-- enum value is only looked up at run time)
create or replace function require_staff()
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or current_staff_role() is null then
    raise exception 'Not signed in as an active staff member' using errcode = '42501';
  end if;
  return auth.uid();
end; $$;

-- Finance readers: admin, manager, accountant, and viewer (the founder's read-only role).
-- Text compare keeps this safe in the same deployment that added 'accountant'.
create or replace function is_finance()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(current_staff_role()::text in ('admin', 'manager', 'accountant', 'viewer'), false)
$$;

create or replace function require_finance()
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not is_finance() then
    raise exception 'Only the founder, managers and accountants can see the accounts' using errcode = '42501';
  end if;
  return auth.uid();
end; $$;

-- Signed balance helper: natural sign by account type
create or replace function natural_balance(p_type account_type, p_debit numeric, p_credit numeric)
returns numeric language sql immutable as $$
  select case when p_type in ('asset', 'expense') then p_debit - p_credit else p_credit - p_debit end
$$;

create or replace function account_totals(p_from date, p_to date)
returns table (account_id uuid, code text, name text, type account_type, group_name text, system_key text,
               debit numeric, credit numeric, balance numeric)
language sql stable security definer set search_path = public as $$
  select a.id, a.code, a.name, a.type, a.group_name, a.system_key,
         coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0),
         natural_balance(a.type, coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0))
    from accounts a
    left join journal_lines jl on jl.account_id = a.id
     and exists (select 1 from journal_entries e where e.id = jl.entry_id
                  and (p_from is null or e.entry_date >= p_from) and (p_to is null or e.entry_date <= p_to))
   group by a.id
$$;

create or replace function list_accounts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_finance();
  return (select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'type', type, 'group', group_name,
            'system_key', system_key, 'active', active) order by code) from accounts);
end; $$;

create or replace function trial_balance(p_as_of date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_to date := coalesce(p_as_of, today_ist());
begin
  perform require_finance();
  return jsonb_build_object('as_of', v_to,
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'type', type,
               'debit', case when debit - credit > 0 then debit - credit else 0 end,
               'credit', case when credit - debit > 0 then credit - debit else 0 end) order by code), '[]'::jsonb)
             from account_totals(null, v_to) where debit <> 0 or credit <> 0),
    'total_debit', (select coalesce(sum(greatest(debit - credit, 0)), 0) from account_totals(null, v_to)),
    'total_credit', (select coalesce(sum(greatest(credit - debit, 0)), 0) from account_totals(null, v_to)));
end; $$;

create or replace function pnl_numbers(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = public as $$
  with t as (select * from account_totals(p_from, p_to))
  select jsonb_build_object(
    'revenue', (select coalesce(sum(balance), 0) from t where group_name = 'Revenue'),
    'cost_of_sales', (select coalesce(sum(balance), 0) from t where group_name = 'Cost of sales'),
    'operating_expenses', (select coalesce(sum(balance), 0) from t where group_name = 'Operating expenses'),
    'other_income', (select coalesce(sum(balance), 0) from t where group_name = 'Other income'),
    'gross_profit', (select coalesce(sum(balance) filter (where group_name = 'Revenue'), 0)
                          - coalesce(sum(balance) filter (where group_name = 'Cost of sales'), 0) from t),
    'net_profit', (select coalesce(sum(balance) filter (where type = 'income'), 0)
                        - coalesce(sum(balance) filter (where type = 'expense'), 0) from t))
$$;

create or replace function profit_and_loss(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare n jsonb := pnl_numbers(p_from, p_to);
begin
  perform require_finance();
  return n || jsonb_build_object('from', p_from, 'to', p_to,
    'gross_margin_pct', case when (n->>'revenue')::numeric <> 0
                             then round(100 * (n->>'gross_profit')::numeric / (n->>'revenue')::numeric, 1) end,
    'sections', (select jsonb_agg(jsonb_build_object('group', g, 'rows', rows, 'total', tot) order by ord) from (
        select group_name g, min(case group_name when 'Revenue' then 1 when 'Cost of sales' then 2 when 'Operating expenses' then 3 else 4 end) ord,
               jsonb_agg(jsonb_build_object('code', code, 'name', name, 'amount', balance) order by code) rows, sum(balance) tot
          from account_totals(p_from, p_to) where type in ('income', 'expense') and (debit <> 0 or credit <> 0)
         group by group_name) s),
    'by_brand', (select coalesce(jsonb_agg(jsonb_build_object('brand', b.name, 'revenue', x.rev, 'cogs', x.cogs,
                   'gross_profit', x.rev - x.cogs, 'gross_margin_pct', case when x.rev <> 0 then round(100 * (x.rev - x.cogs) / x.rev, 1) end)
                   order by x.rev desc), '[]'::jsonb)
                 from (select jl.brand_id,
                              sum(case when a.system_key in ('sales', 'sales_returns') then jl.credit - jl.debit else 0 end) rev,
                              sum(case when a.system_key = 'cogs' then jl.debit - jl.credit else 0 end) cogs
                         from journal_lines jl join journal_entries e on e.id = jl.entry_id join accounts a on a.id = jl.account_id
                        where e.entry_date between p_from and p_to and jl.brand_id is not null
                        group by jl.brand_id) x join brands b on b.id = x.brand_id),
    'by_channel', (select coalesce(jsonb_agg(jsonb_build_object('channel', c.name, 'revenue', x.rev) order by x.rev desc), '[]'::jsonb)
                   from (select jl.channel_id, sum(jl.credit - jl.debit) rev
                           from journal_lines jl join journal_entries e on e.id = jl.entry_id join accounts a on a.id = jl.account_id
                          where e.entry_date between p_from and p_to and a.group_name = 'Revenue' and jl.channel_id is not null
                          group by jl.channel_id) x join sales_channels c on c.id = x.channel_id));
end; $$;

create or replace function balance_sheet(p_as_of date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_to date := coalesce(p_as_of, today_ist()); v_earn numeric; v_assets numeric; v_le numeric;
begin
  perform require_finance();
  select coalesce(sum(balance) filter (where type = 'income'), 0) - coalesce(sum(balance) filter (where type = 'expense'), 0)
    into v_earn from account_totals(null, v_to);
  select coalesce(sum(balance), 0) into v_assets from account_totals(null, v_to) where type = 'asset';
  select coalesce(sum(balance), 0) + v_earn into v_le from account_totals(null, v_to) where type in ('liability', 'equity');
  return jsonb_build_object('as_of', v_to, 'total_assets', v_assets, 'total_liabilities_equity', v_le,
    'balanced', v_assets = v_le, 'current_earnings', v_earn,
    'sections', (select jsonb_agg(jsonb_build_object('type', type, 'group', group_name, 'rows', rows, 'total', tot) order by ord, group_name) from (
        select type, group_name, min(code) ord,
               jsonb_agg(jsonb_build_object('code', code, 'name', name, 'amount', balance) order by code) rows, sum(balance) tot
          from account_totals(null, v_to) where type in ('asset', 'liability', 'equity') and (debit <> 0 or credit <> 0)
         group by type, group_name) s));
end; $$;

-- GST summary for a return period: outward (invoices − credit notes) by rate, HSN and place of supply;
-- input credit from supplier bills; net payable per tax head (from the ledger).
create or replace function gst_summary(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_finance();
  return jsonb_build_object('from', p_from, 'to', p_to,
    'outward_by_rate', (select coalesce(jsonb_agg(jsonb_build_object('rate', rate, 'taxable', taxable, 'cgst', cgst, 'sgst', sgst, 'igst', igst) order by rate), '[]'::jsonb)
      from (select rate, sum(taxable) taxable, sum(cgst) cgst, sum(sgst) sgst, sum(igst) igst from (
              select l.gst_rate rate, l.taxable_value taxable, l.cgst, l.sgst, l.igst
                from invoice_lines l join invoices i on i.id = l.invoice_id where i.invoice_date between p_from and p_to
              union all
              select il.gst_rate, -cl.taxable_value, -cl.cgst, -cl.sgst, -cl.igst
                from credit_note_lines cl join credit_notes cn on cn.id = cl.credit_note_id
                join invoice_lines il on il.id = cl.invoice_line_id where cn.note_date between p_from and p_to) u
            group by rate) r),
    'hsn_summary', (select coalesce(jsonb_agg(jsonb_build_object('hsn', hsn, 'qty', qty, 'taxable', taxable, 'tax', tax) order by hsn), '[]'::jsonb)
      from (select coalesce(l.hsn, '—') hsn, sum(case when l.sku_id is not null then l.qty else 0 end) qty, sum(l.taxable_value) taxable,
                   sum(l.cgst + l.sgst + l.igst) tax
              from invoice_lines l join invoices i on i.id = l.invoice_id where i.invoice_date between p_from and p_to
             group by 1) h),
    'by_place_of_supply', (select coalesce(jsonb_agg(jsonb_build_object('state', s.name, 'code', x.pos, 'supply_type', x.st, 'taxable', x.taxable,
                              'tax', x.tax) order by x.pos), '[]'::jsonb)
      from (select place_of_supply pos, supply_type st, sum(taxable_value) taxable, sum(cgst + sgst + igst) tax
              from invoices where invoice_date between p_from and p_to group by 1, 2) x join gst_states s on s.code = x.pos),
    'inward', (select jsonb_build_object('taxable', coalesce(sum(taxable_value), 0), 'cgst', coalesce(sum(cgst), 0),
                 'sgst', coalesce(sum(sgst), 0), 'igst', coalesce(sum(igst), 0), 'bills', count(*))
               from purchase_bills where bill_date between p_from and p_to),
    'net_payable', (select jsonb_object_agg(head, amt) from (
        select 'cgst' head, coalesce(sum(balance) filter (where system_key = 'output_cgst'), 0) - coalesce(sum(balance) filter (where system_key = 'input_cgst'), 0) amt from account_totals(p_from, p_to)
        union all
        select 'sgst', coalesce(sum(balance) filter (where system_key = 'output_sgst'), 0) - coalesce(sum(balance) filter (where system_key = 'input_sgst'), 0) from account_totals(p_from, p_to)
        union all
        select 'igst', coalesce(sum(balance) filter (where system_key = 'output_igst'), 0) - coalesce(sum(balance) filter (where system_key = 'input_igst'), 0) from account_totals(p_from, p_to)) n),
    'note', 'Summary for review. File returns through the GST portal or your CA; confirm rates, HSN codes and composite-supply treatment.');
end; $$;

create or replace function account_statement(p_account text, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a accounts%rowtype; v_open numeric;
begin
  perform require_finance();
  select * into a from accounts where id = acct(p_account);
  select coalesce(natural_balance(a.type, sum(jl.debit), sum(jl.credit)), 0) into v_open
    from journal_lines jl join journal_entries e on e.id = jl.entry_id where jl.account_id = a.id and e.entry_date < p_from;
  return jsonb_build_object('account', jsonb_build_object('code', a.code, 'name', a.name, 'type', a.type), 'opening', v_open,
    'lines', (select coalesce(jsonb_agg(x order by x->>'date', x->>'code'), '[]'::jsonb) from (
       select jsonb_build_object('date', e.entry_date, 'code', e.code, 'narration', e.narration, 'debit', jl.debit, 'credit', jl.credit,
                'running', v_open + sum(natural_balance(a.type, jl.debit, jl.credit)) over (order by e.entry_date, e.code, jl.id)) x
         from journal_lines jl join journal_entries e on e.id = jl.entry_id
        where jl.account_id = a.id and e.entry_date between p_from and p_to) t),
    'closing', v_open + (select coalesce(natural_balance(a.type, sum(jl.debit), sum(jl.credit)), 0)
                           from journal_lines jl join journal_entries e on e.id = jl.entry_id
                          where jl.account_id = a.id and e.entry_date between p_from and p_to));
end; $$;

create or replace function list_journals(p_from date default null, p_to date default null, p_source text default null, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_finance();
  return (select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', e.id, 'code', e.code, 'date', e.entry_date, 'source_type', e.source_type, 'narration', e.narration,
      'created_at', e.created_at, 'reversed', journal_is_reversed(e.id),
      'by', (select full_name from staff_profiles where user_id = e.created_by),
      'lines', (select jsonb_agg(jsonb_build_object('code', a.code, 'account', a.name, 'debit', jl.debit, 'credit', jl.credit,
                  'brand', (select name from brands where id = jl.brand_id), 'memo', jl.memo) order by jl.debit desc, a.code)
                from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = e.id)) x
    from journal_entries e
    where (p_from is null or e.entry_date >= p_from) and (p_to is null or e.entry_date <= p_to)
      and (p_source is null or p_source = '' or e.source_type = p_source)
    order by e.created_at desc limit p_limit) t);
end; $$;

-- Receivables by invoice (order payments applied to the order's invoice)
create or replace function receivables_ageing()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_finance();
  return (with inv as (
      select i.id, i.code, i.invoice_date, i.buyer->>'name' customer, o.code order_code,
             i.total - coalesce((select sum(total) from credit_notes where invoice_id = i.id), 0)
                     - coalesce((select sum(case when kind = 'payment' then amount else -amount end) from payments where order_id = o.id), 0) due,
             today_ist() - i.invoice_date age
        from invoices i join orders o on o.id = i.order_id)
    select jsonb_build_object(
      'total_due', coalesce(sum(due) filter (where due > 0), 0),
      'buckets', jsonb_build_object('0_30', coalesce(sum(due) filter (where due > 0 and age <= 30), 0),
                                    '31_60', coalesce(sum(due) filter (where due > 0 and age between 31 and 60), 0),
                                    '61_90', coalesce(sum(due) filter (where due > 0 and age between 61 and 90), 0),
                                    '90_plus', coalesce(sum(due) filter (where due > 0 and age > 90), 0)),
      'customer_advances', (select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0) from payments p
                             where not exists (select 1 from invoices where order_id = p.order_id)),
      'open_invoices', coalesce(jsonb_agg(jsonb_build_object('code', code, 'date', invoice_date, 'customer', customer,
                         'order_code', order_code, 'due', due, 'age_days', age) order by invoice_date) filter (where due > 0), '[]'::jsonb))
    from inv);
end; $$;

create or replace function payables_ageing()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_finance();
  return (with b as (
      select pb.id, pb.code, pb.supplier_invoice_no, pb.bill_date, coalesce(pb.due_date, pb.bill_date) due_date,
             (select coalesce(display_name, legal_name) from business_partners where id = pb.supplier_id) supplier,
             pb.total - coalesce((select sum(amount) from supplier_payments where bill_id = pb.id), 0) due
        from purchase_bills pb)
    select jsonb_build_object(
      'total_due', coalesce(sum(due) filter (where due > 0), 0),
      'overdue', coalesce(sum(due) filter (where due > 0 and due_date < today_ist()), 0),
      'unallocated_payments', (select coalesce(sum(amount), 0) from supplier_payments where bill_id is null),
      'open_bills', coalesce(jsonb_agg(jsonb_build_object('code', code, 'supplier_invoice_no', supplier_invoice_no, 'supplier', supplier,
                      'bill_date', bill_date, 'due_date', due_date, 'due', due, 'overdue', due_date < today_ist())
                      order by due_date) filter (where due > 0), '[]'::jsonb))
    from b);
end; $$;

-- Stock at cost vs inventory accounts in the ledger (should match)
create or replace function inventory_valuation()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_finance();
  return (select jsonb_build_object(
    'by_type', (select jsonb_agg(jsonb_build_object('account', k, 'stock_value', sv, 'ledger_value', lv, 'difference', sv - lv) order by k)
      from (select k,
                   (select coalesce(sum(stock_value(s.id)), 0) from skus s where inventory_account_key(s.id) = k) sv,
                   (select balance from account_totals(null, null) where system_key = k) lv
              from unnest(array['inv_finished', 'inv_raw', 'inv_packaging']) k) z),
    'by_sku', (select coalesce(jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name, 'type', item_type_of(s.id),
                 'qty', q.qty, 'value', stock_value(s.id)) order by s.code), '[]'::jsonb)
               from skus s cross join lateral (select coalesce(sum(qty), 0) qty from stock_balances sb
                     where sb.sku_id = s.id and sb.owner_id = company_owner_id() and sb.status not in ('damaged', 'expired')) q
               where q.qty <> 0),
    'uncosted_batches', (select count(distinct b.id) from batches b join stock_balances sb on sb.batch_id = b.id
                          where b.unit_cost is null and sb.qty > 0 and sb.owner_id = company_owner_id())));
end; $$;

create or replace function list_accounting_exceptions()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_finance();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'ref_type', ref_type, 'ref_id', ref_id,
            'message', message, 'created_at', created_at) order by created_at desc), '[]'::jsonb)
          from accounting_exceptions where resolved_at is null);
end; $$;

create or replace function get_company()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return (select jsonb_build_object('name', name, 'gstin', gstin, 'pan', pan, 'state_code', state_code,
            'state', (select name from gst_states where code = state_code), 'registered_address', registered_address,
            'states', (select jsonb_agg(jsonb_build_object('code', code, 'name', name) order by name) from gst_states))
          from legal_entities order by created_at limit 1);
end; $$;

-- ---------------------------------------------------------------------
-- MIS: one call for the founder's finance view
-- ---------------------------------------------------------------------
create or replace function get_mis(p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_from date := coalesce(p_from, date_trunc('month', today_ist())::date); v_to date := coalesce(p_to, today_ist());
begin
  perform require_finance();
  return jsonb_build_object('from', v_from, 'to', v_to,
    'pnl', pnl_numbers(v_from, v_to),
    'by_brand', (profit_and_loss(v_from, v_to))->'by_brand',
    'cash', (select jsonb_object_agg(system_key, balance) from account_totals(null, v_to)
              where system_key in ('cash', 'bank', 'gateway_clearing')),
    'receivables', (select balance from account_totals(null, v_to) where system_key = 'receivables'),
    'receivables_ageing', (receivables_ageing())->'buckets',
    'payables', (select balance from account_totals(null, v_to) where system_key = 'payables'),
    'payables_overdue', (payables_ageing())->'overdue',
    'gst_payable', (gst_summary(v_from, v_to))->'net_payable',
    'inventory', (inventory_valuation())->'by_type',
    'production', (select jsonb_build_object('runs', count(*), 'units', coalesce(sum(output_qty), 0),
                     'avg_yield_pct', round(avg(100 * output_qty / planned_qty), 1),
                     'material_variance', (select coalesce(round(sum((c.qty - c.standard_qty * c.qty / nullif(t.tot, 0)) * coalesce(c.unit_cost, 0)), 2), 0)
                                             from production_consumptions c join production_orders po2 on po2.id = c.production_order_id
                                             join lateral (select sum(qty) tot from production_consumptions c2
                                                            where c2.production_order_id = c.production_order_id and c2.material_sku_id = c.material_sku_id) t on true
                                            where po2.completed_at::date between v_from and v_to))
                   from production_orders where status = 'completed' and completed_at::date between v_from and v_to),
    'overheads', (select jsonb_build_object(
                     'absorbed', coalesce(-sum(balance) filter (where system_key = 'overhead_absorbed'), 0),
                     'actual', coalesce(sum(balance) filter (where system_key = 'production_overheads'), 0))
                   from account_totals(v_from, v_to)),
    'unit_costs', (select coalesce(jsonb_agg(jsonb_build_object('sku', s.name, 'code', s.code, 'unit_cost', b.unit_cost,
                     'web_price', get_price(s.id, 'WEB'),
                     'margin_pct', case when get_price(s.id, 'WEB') > 0 and t.gst_rate is not null
                                        then round(100 * (get_price(s.id, 'WEB') * 100 / (100 + t.gst_rate) - b.unit_cost)
                                                   / (get_price(s.id, 'WEB') * 100 / (100 + t.gst_rate)), 1) end) order by s.code), '[]'::jsonb)
                   from skus s join products p on p.id = s.product_id left join tax_rates t on t.id = p.tax_rate_id
                   cross join lateral (select unit_cost from batches where sku_id = s.id and unit_cost is not null
                                        order by created_at desc limit 1) b
                   where p.item_type = 'finished'),
    'purchases_by_supplier', (select coalesce(jsonb_agg(jsonb_build_object('supplier', bp.name, 'amount', x.amt) order by x.amt desc), '[]'::jsonb)
                   from (select supplier_id, sum(taxable_value) amt from purchase_bills where bill_date between v_from and v_to group by 1) x
                   join lateral (select coalesce(display_name, legal_name) name from business_partners where id = x.supplier_id) bp on true),
    'open_purchase_orders', (select coalesce(sum(round((l.qty - l.received_qty) * l.unit_price, 2)), 0)
                   from purchase_order_lines l join purchase_orders po on po.id = l.po_id where po.status in ('open', 'partially_received')),
    'exceptions', (select count(*) from accounting_exceptions where resolved_at is null),
    'company_gst_set', (select state_code is not null from legal_entities order by created_at limit 1));
end; $$;

-- ---------------------------------------------------------------------
-- Founder dashboard: add finance alerts to the existing alert list
-- ---------------------------------------------------------------------
alter function get_dashboard(int) rename to get_dashboard_core;

create or replace function get_dashboard(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d jsonb := get_dashboard_core(p_days); v_extra jsonb := '[]'::jsonb;
begin
  if (select state_code is null from legal_entities order by created_at limit 1) then
    v_extra := v_extra || jsonb_build_object('severity', 'high', 'type', 'company_gst',
      'title', 'Company GSTIN and state not set', 'detail', 'GST invoices can''t be issued until this is set (Accounts → Company)', 'ref', null);
  end if;
  v_extra := v_extra || coalesce((select jsonb_agg(jsonb_build_object('severity', case when kind in ('invoice_failed', 'posting_failed') then 'high' else 'medium' end,
      'type', 'accounting', 'title', case kind when 'invoice_failed' then 'Invoice not issued' when 'posting_failed' then 'Accounting entry failed'
                                               when 'uncosted_stock' then 'Stock without a cost' else 'Accounts check' end,
      'detail', message, 'ref', id) order by created_at desc)
    from (select * from accounting_exceptions where resolved_at is null order by created_at desc limit 20) e), '[]'::jsonb);
  -- materials below reorder level are already included in low-stock alerts
  return jsonb_set(d, '{alerts}', v_extra || (d->'alerts'));
end; $$;

-- ---------------------------------------------------------------------
-- Backfill: post everything that happened before the ledger existed
-- (idempotent — safe to run again)
-- ---------------------------------------------------------------------
create or replace function ledger_backfill()
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; n_stock int := 0; n_inv int := 0; n_pay int := 0;
begin
  for r in select id from stock_transactions order by created_at loop
    perform ledger_post_stock_txn(r.id); n_stock := n_stock + 1;
  end loop;
  for r in select id from orders where status in ('dispatched', 'delivered', 'delivery_failed') order by dispatched_at loop
    perform try_issue_invoice(r.id); n_inv := n_inv + 1;
  end loop;
  for r in select id from payments order by received_at loop
    perform ledger_post_payment(r.id); n_pay := n_pay + 1;
  end loop;
  return jsonb_build_object('stock_transactions', n_stock, 'dispatched_orders', n_inv, 'payments', n_pay);
end; $$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['gst_states', 'accounts', 'journal_entries', 'journal_lines', 'accounting_periods', 'accounting_exceptions',
                           'purchase_orders', 'purchase_order_lines', 'purchase_receipts', 'purchase_bills', 'purchase_bill_lines',
                           'supplier_payments', 'recipes', 'recipe_lines', 'production_orders', 'production_consumptions',
                           'invoices', 'invoice_lines', 'credit_notes', 'credit_note_lines'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  -- operational tables: any staff member may read
  foreach t in array array['gst_states', 'purchase_orders', 'purchase_order_lines', 'purchase_receipts', 'recipes', 'recipe_lines',
                           'production_orders', 'production_consumptions'] loop
    execute format('create policy staff_read on public.%I for select to authenticated using (is_staff())', t);
  end loop;
  -- finance tables: admin, manager, accountant
  foreach t in array array['accounts', 'journal_entries', 'journal_lines', 'accounting_periods', 'accounting_exceptions',
                           'purchase_bills', 'purchase_bill_lines', 'supplier_payments', 'invoices', 'invoice_lines',
                           'credit_notes', 'credit_note_lines'] loop
    execute format('create policy finance_read on public.%I for select to authenticated using (is_finance())', t);
  end loop;
end $$;

revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on function storefront_catalogue(), storefront_order_status(text, text) to anon;

-- Staff-callable API (each checks the caller's role itself)
grant execute on function is_finance() to authenticated;
grant execute on function
  set_company_details(text, text, text, text), get_company(), list_accounts(), post_manual_journal(jsonb),
  reverse_journal(uuid, text, date), lock_period(date, boolean), resolve_accounting_exception(uuid),
  create_material(jsonb), list_materials(text), create_purchase_order(jsonb), receive_purchase(uuid, numeric, jsonb, uuid, text),
  record_purchase_bill(jsonb), record_supplier_payment(uuid, numeric, text, text, uuid, date, text),
  list_purchase_orders(text), list_bills(uuid),
  save_recipe(jsonb), get_recipe(uuid), list_recipes(), create_production_order(jsonb), get_production_order(uuid),
  list_production_orders(text), complete_production(jsonb), cancel_production_order(uuid, text),
  issue_invoice(uuid), issue_credit_note(uuid, numeric, text), record_gateway_settlement(numeric, numeric, numeric, text, date),
  get_invoice(uuid), list_invoices(date, date, text), invoice_for_order(uuid),
  trial_balance(date), profit_and_loss(date, date), balance_sheet(date), gst_summary(date, date),
  account_statement(text, date, date), list_journals(date, date, text, int), receivables_ageing(), payables_ageing(),
  inventory_valuation(), list_accounting_exceptions(), get_mis(date, date), get_dashboard(int)
to authenticated;

-- Internal helpers: only callable from other database functions
revoke execute on function
  next_fy_code(text, date), post_journal(date, text, uuid, text, text, jsonb), acct(text),
  log_accounting_exception(text, text, uuid, text), issue_invoice_core(uuid), try_issue_invoice(uuid),
  issue_credit_note_core(uuid, numeric, text, uuid), ledger_post_payment(uuid), ledger_post_stock_txn(uuid),
  refresh_po_status(uuid), production_requirements(uuid, numeric), account_totals(date, date), pnl_numbers(date, date),
  ledger_backfill(), get_dashboard_core(int)
from authenticated, service_role;

-- Backfill last: it writes journals whose balance checks run at commit, and
-- Postgres won't alter a table with such checks pending.
select ledger_backfill();
set constraints all immediate;
