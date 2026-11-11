-- =====================================================================
-- Migration 0011 — Materials and purchasing
--
-- Ingredients and packaging live in the SAME product/SKU/batch/stock
-- ledger as finished goods ("one inventory system"): products gain an
-- item_type. Materials have no brand and get RM-/PK- codes. They never
-- appear in the storefront or customer orders.
--
-- Purchasing: purchase order -> goods receipt (creates a costed batch,
-- Dr Inventory / Cr Goods-received-not-invoiced) -> supplier bill
-- (Dr GRNI + Input GST / Cr Payables, price variance to PPV) ->
-- supplier payment (Dr Payables / Cr Bank). Expense bills (rent, gas,
-- freight …) go straight to an expense account.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Item types
-- ---------------------------------------------------------------------
alter table products add column item_type text not null default 'finished'
  check (item_type in ('finished', 'raw_material', 'packaging'));
alter table products alter column brand_id drop not null;
alter table products add constraint finished_goods_have_brand check (item_type <> 'finished' or brand_id is not null);
create unique index products_material_name on products (lower(name)) where brand_id is null;

create or replace function trg_assign_sku_code()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_prefix text;
begin
  if new.code is null or new.code = '' then
    select case p.item_type when 'raw_material' then 'RM' when 'packaging' then 'PK' else b.sku_prefix end
      into v_prefix
      from products p left join brands b on b.id = p.brand_id where p.id = new.product_id;
    new.code := next_code(v_prefix);
  end if;
  return new;
end; $$;

-- 50.000 -> '50', 1.250 -> '1.25' (for messages)
create or replace function fmt_qty(p numeric)
returns text language sql immutable as $$
  select case when p is null then '' when p = trunc(p) then trunc(p)::bigint::text
              else rtrim(rtrim(p::text, '0'), '.') end
$$;

create or replace function item_type_of(p_sku uuid)
returns text language sql stable security definer set search_path = public as $$
  select p.item_type from skus s join products p on p.id = s.product_id where s.id = p_sku
$$;

create or replace function inventory_account_key(p_sku uuid)
returns text language sql stable security definer set search_path = public as $$
  select case item_type_of(p_sku) when 'raw_material' then 'inv_raw' when 'packaging' then 'inv_packaging' else 'inv_finished' end
$$;

-- Customers can only order finished goods
create or replace function trg_order_line_finished_only()
returns trigger language plpgsql as $$
begin
  if item_type_of(new.sku_id) <> 'finished' then
    raise exception 'Line %: % is a material, not a product for sale', new.line_no, (select code from skus where id = new.sku_id);
  end if;
  return new;
end; $$;
create trigger finished_only before insert on order_lines for each row execute function trg_order_line_finished_only();

-- Create an ingredient or packaging material
create or replace function create_material(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_prod uuid; v_sku skus%rowtype;
begin
  perform require_role('manager', 'accountant');
  if coalesce(p->>'item_type', '') not in ('raw_material', 'packaging') then raise exception 'Choose raw material or packaging'; end if;
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'Enter the material name'; end if;
  insert into products (brand_id, category_id, name, description, tax_rate_id, shelf_life_days, is_batch_tracked, item_type)
  values (null, null, trim(p->>'name'), nullif(p->>'description', ''), nullif(p->>'tax_rate_id', '')::uuid,
          nullif(p->>'shelf_life_days', '')::int, true, p->>'item_type')
  returning id into v_prod;
  insert into skus (product_id, name, pack_size, pack_unit, reorder_level)
  values (v_prod, trim(p->>'name'), 1, coalesce(nullif(p->>'unit', ''), 'kg'), coalesce(nullif(p->>'reorder_level', '')::numeric, 0)::int)
  returning * into v_sku;
  return jsonb_build_object('sku_id', v_sku.id, 'sku_code', v_sku.code);
end; $$;

-- Valued company stock of one SKU (company-owned, not written off)
create or replace function stock_value(p_sku uuid, p_location uuid default null)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(sb.qty * coalesce(b.unit_cost, 0)), 0)
    from stock_balances sb left join batches b on b.id = sb.batch_id
   where sb.sku_id = p_sku and sb.owner_id = company_owner_id() and sb.status not in ('damaged', 'expired')
     and (p_location is null or sb.location_id = p_location)
$$;

create or replace function list_materials(p_search text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return (select coalesce(jsonb_agg(x order by x->>'item_type', x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name, 'item_type', p.item_type, 'unit', s.pack_unit,
      'reorder_level', s.reorder_level, 'shelf_life_days', p.shelf_life_days, 'active', s.active,
      'on_hand', (select coalesce(sum(qty), 0) from stock_balances sb where sb.sku_id = s.id and sb.owner_id = company_owner_id()
                    and sb.status not in ('damaged', 'expired')),
      'by_location', (select coalesce(jsonb_agg(jsonb_build_object('location', l.name, 'qty', q.qty) order by l.name), '[]'::jsonb)
                        from (select location_id, sum(qty) qty from stock_balances sb
                               where sb.sku_id = s.id and sb.owner_id = company_owner_id() and sb.status = 'available'
                               group by location_id having sum(qty) <> 0) q join locations l on l.id = q.location_id),
      'value', stock_value(s.id),
      'last_cost', (select unit_cost from batches where sku_id = s.id and unit_cost is not null order by created_at desc limit 1),
      'low', (select coalesce(sum(qty), 0) from stock_balances sb where sb.sku_id = s.id and sb.owner_id = company_owner_id()
                and sb.status = 'available') <= s.reorder_level) x
    from skus s join products p on p.id = s.product_id
    where p.item_type in ('raw_material', 'packaging')
      and (p_search is null or p_search = '' or s.name ilike '%' || p_search || '%' or s.code ilike '%' || p_search || '%')
  ) t);
end; $$;

-- GST state of a partner: from GSTIN if present, else the state text
create or replace function partner_state_code(p_partner uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(case when is_valid_gstin(gstin) then left(gstin, 2) end, gst_state_code(state))
    from business_partners where id = p_partner
$$;

create or replace function company_state_code()
returns text language sql stable security definer set search_path = public as $$
  select state_code from legal_entities order by created_at limit 1
$$;

-- ---------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------
create table purchase_orders (
  id             uuid primary key default gen_random_uuid(),
  code           text unique,                         -- PO-2026-000001
  supplier_id    uuid not null references business_partners(id),
  status         text not null default 'open' check (status in ('open', 'partially_received', 'received', 'closed', 'cancelled')),
  order_date     date not null default today_ist(),
  expected_date  date,
  deliver_to_location_id uuid not null references locations(id),
  notes          text,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create trigger assign_code before insert on purchase_orders for each row execute function trg_assign_code('PO', 'yearly');
create trigger audit after insert or update or delete on purchase_orders for each row execute function trg_audit();
create trigger no_delete before delete on purchase_orders for each row execute function trg_no_delete();

create table purchase_order_lines (
  id           uuid primary key default gen_random_uuid(),
  po_id        uuid not null references purchase_orders(id),
  line_no      int not null,
  sku_id       uuid not null references skus(id),
  qty          numeric(14,3) not null check (qty > 0),
  unit_price   numeric(12,4) not null check (unit_price >= 0),    -- excluding GST
  gst_rate     numeric(5,2) not null default 0 check (gst_rate >= 0),
  received_qty numeric(14,3) not null default 0,
  billed_qty   numeric(14,3) not null default 0,
  unique (po_id, line_no)
);
create trigger no_delete before delete on purchase_order_lines for each row execute function trg_no_delete();

create table purchase_receipts (
  id             uuid primary key default gen_random_uuid(),
  po_line_id     uuid not null references purchase_order_lines(id),
  batch_id       uuid not null references batches(id),
  location_id    uuid not null references locations(id),
  qty            numeric(14,3) not null check (qty > 0),
  unit_cost      numeric(12,4) not null,
  stock_txn_id   uuid references stock_transactions(id),
  idempotency_key text unique,
  received_by    uuid,
  received_at    timestamptz not null default now()
);
create trigger immutable before update or delete on purchase_receipts for each row execute function trg_immutable();

create table purchase_bills (
  id                  uuid primary key default gen_random_uuid(),
  code                text unique,                      -- BILL-2026-000001 (internal)
  supplier_id         uuid not null references business_partners(id),
  supplier_invoice_no text not null,
  bill_date           date not null,
  due_date            date,
  po_id               uuid references purchase_orders(id),
  supply_type         text not null check (supply_type in ('intra', 'inter')),
  taxable_value       numeric(14,2) not null,
  cgst                numeric(14,2) not null default 0,
  sgst                numeric(14,2) not null default 0,
  igst                numeric(14,2) not null default 0,
  total               numeric(14,2) not null,
  notes               text,
  idempotency_key     text unique,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  unique (supplier_id, supplier_invoice_no)
);
create trigger assign_code before insert on purchase_bills for each row execute function trg_assign_code('BILL', 'yearly');
create trigger immutable before update or delete on purchase_bills for each row execute function trg_immutable();

create table purchase_bill_lines (
  id            uuid primary key default gen_random_uuid(),
  bill_id       uuid not null references purchase_bills(id),
  po_line_id    uuid references purchase_order_lines(id),
  account_id    uuid references accounts(id),           -- expense lines
  description   text not null,
  qty           numeric(14,3) not null default 1,
  unit_price    numeric(12,4) not null,
  taxable_value numeric(14,2) not null,
  gst_rate      numeric(5,2) not null default 0,
  tax           numeric(14,2) not null default 0,
  check ((po_line_id is null) <> (account_id is null))
);
create trigger immutable before update or delete on purchase_bill_lines for each row execute function trg_immutable();

create table supplier_payments (
  id               uuid primary key default gen_random_uuid(),
  code             text unique,                         -- SPAY-2026-000001
  supplier_id      uuid not null references business_partners(id),
  bill_id          uuid references purchase_bills(id),
  amount           numeric(14,2) not null check (amount > 0),
  method           text not null default 'bank_transfer',
  reference        text,
  paid_on          date not null default today_ist(),
  idempotency_key  text unique,
  created_by       uuid,
  created_at       timestamptz not null default now()
);
create trigger assign_code before insert on supplier_payments for each row execute function trg_assign_code('SPAY', 'yearly');
create trigger immutable before update or delete on supplier_payments for each row execute function trg_immutable();

create or replace function create_purchase_order(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_po purchase_orders%rowtype; l jsonb; n int := 0;
begin
  perform require_role('manager', 'accountant');
  if not exists (select 1 from partner_roles where partner_id = (p->>'supplier_id')::uuid and role in ('supplier', 'manufacturer')) then
    raise exception 'Choose a supplier (a partner with the supplier or manufacturer role)';
  end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then raise exception 'Add at least one line'; end if;
  insert into purchase_orders (supplier_id, expected_date, deliver_to_location_id, notes, created_by)
  values ((p->>'supplier_id')::uuid, nullif(p->>'expected_date', '')::date,
          coalesce(nullif(p->>'deliver_to_location_id', '')::uuid, default_location_id()), nullif(p->>'notes', ''), auth.uid())
  returning * into v_po;
  for l in select * from jsonb_array_elements(p->'lines') loop
    n := n + 1;
    insert into purchase_order_lines (po_id, line_no, sku_id, qty, unit_price, gst_rate)
    values (v_po.id, n, (l->>'sku_id')::uuid, (l->>'qty')::numeric, (l->>'unit_price')::numeric, coalesce(nullif(l->>'gst_rate', '')::numeric, 0));
  end loop;
  return jsonb_build_object('po_id', v_po.id, 'code', v_po.code);
end; $$;

create or replace function refresh_po_status(p_po uuid)
returns void language sql security definer set search_path = public as $$
  update purchase_orders po set status = case
      when po.status in ('cancelled', 'closed') then po.status
      when not exists (select 1 from purchase_order_lines where po_id = po.id and received_qty < qty) then 'received'
      when exists (select 1 from purchase_order_lines where po_id = po.id and received_qty > 0) then 'partially_received'
      else 'open' end
   where po.id = p_po
$$;

-- Goods receipt against a PO line: creates a costed batch and posts to the ledger
create or replace function receive_purchase(p_po_line_id uuid, p_qty numeric, p_lot jsonb default '{}'::jsonb,
                                            p_location_id uuid default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := require_role('warehouse', 'manager');
  l purchase_order_lines%rowtype; po purchase_orders%rowtype; v_loc uuid; v_batch uuid; v_txn uuid; v_rec uuid;
  v_shelf int; v_exp date; v_mfg date;
begin
  if p_idempotency_key is not null then
    select id into v_rec from purchase_receipts where idempotency_key = p_idempotency_key;
    if v_rec is not null then return jsonb_build_object('receipt_id', v_rec, 'duplicate', true); end if;
  end if;
  select * into l from purchase_order_lines where id = p_po_line_id for update;
  if l.id is null then raise exception 'Purchase order line not found'; end if;
  select * into po from purchase_orders where id = l.po_id;
  if po.status in ('cancelled', 'closed') then raise exception 'Purchase order % is %', po.code, po.status; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be more than zero'; end if;
  if l.received_qty + p_qty > l.qty then
    raise exception 'Only % more can be received on this line', fmt_qty(l.qty - l.received_qty);
  end if;
  v_loc := coalesce(p_location_id, po.deliver_to_location_id);
  v_mfg := coalesce(nullif(p_lot->>'manufactured_on', '')::date, today_ist());
  select pr.shelf_life_days into v_shelf from skus s join products pr on pr.id = s.product_id where s.id = l.sku_id;
  v_exp := coalesce(nullif(p_lot->>'expires_on', '')::date, v_mfg + coalesce(v_shelf, 365));

  insert into batches (sku_id, manufacturer_partner_id, external_lot_no, manufactured_on, expires_on, quantity_produced,
                       unit_cost, qa_status, created_by)
  values (l.sku_id, case when item_type_of(l.sku_id) = 'finished' then po.supplier_id end, nullif(p_lot->>'supplier_lot_no', ''),
          v_mfg, v_exp, p_qty, l.unit_price,
          coalesce(nullif(p_lot->>'qa_status', '')::qa_status, 'released'), v_uid)
  returning id into v_batch;

  insert into purchase_receipts (po_line_id, batch_id, location_id, qty, unit_cost, idempotency_key, received_by)
  values (l.id, v_batch, v_loc, p_qty, l.unit_price, p_idempotency_key, v_uid) returning id into v_rec;

  v_txn := post_stock_txn('goods_receipt', jsonb_build_array(jsonb_build_object('sku_id', l.sku_id, 'batch_id', v_batch,
              'location_id', v_loc, 'owner_id', company_owner_id(), 'status', 'available', 'qty', p_qty)),
            'Received against ' || po.code, 'purchase_receipt', v_rec, null, true, true);

  perform post_journal(today_ist(), 'purchase_receipt', v_rec, 'main', 'Goods received ' || po.code,
    jsonb_build_array(
      jsonb_build_object('account', inventory_account_key(l.sku_id), 'debit', round(p_qty * l.unit_price, 2),
                         'brand_id', sku_brand(l.sku_id), 'partner_id', po.supplier_id),
      jsonb_build_object('account', 'grni', 'credit', round(p_qty * l.unit_price, 2), 'partner_id', po.supplier_id)));

  update purchase_order_lines set received_qty = received_qty + p_qty where id = l.id;
  perform refresh_po_status(po.id);
  -- new stock may unblock customer orders waiting for this SKU
  perform reserve_waiting_orders(l.sku_id, v_loc);

  return jsonb_build_object('receipt_id', v_rec, 'batch_id', v_batch,
    'batch_code', (select code from batches where id = v_batch), 'po_status', (select status from purchase_orders where id = po.id));
end; $$;

-- Split GST between CGST/SGST (same state) or IGST (different state)
create or replace function gst_split(p_tax numeric, p_supply_type text)
returns jsonb language sql immutable as $$
  select case when p_supply_type = 'intra'
    then jsonb_build_object('cgst', round(p_tax / 2, 2), 'sgst', p_tax - round(p_tax / 2, 2), 'igst', 0)
    else jsonb_build_object('cgst', 0, 'sgst', 0, 'igst', p_tax) end
$$;

-- Supplier bill. lines: [{po_line_id, qty, unit_price?, gst_rate?} | {expense_account, description, amount, gst_rate}]
create or replace function record_purchase_bill(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_supplier uuid := (p->>'supplier_id')::uuid; v_bill purchase_bills%rowtype; v_key text := nullif(p->>'idempotency_key', '');
  v_supply text; v_company text := company_state_code(); v_sup_state text;
  l jsonb; pol purchase_order_lines%rowtype; v_qty numeric; v_price numeric; v_rate numeric; v_taxable numeric; v_tax numeric;
  v_tot_taxable numeric := 0; v_tot_tax numeric := 0; v_jl jsonb := '[]'::jsonb; v_split jsonb; v_id uuid; v_date date;
  v_lines jsonb := '[]'::jsonb;
begin
  perform require_role('accountant', 'manager');
  if v_key is not null then
    select * into v_bill from purchase_bills where idempotency_key = v_key;
    if v_bill.id is not null then return jsonb_build_object('bill_id', v_bill.id, 'code', v_bill.code, 'duplicate', true); end if;
  end if;
  if coalesce(trim(p->>'supplier_invoice_no'), '') = '' then raise exception 'Enter the supplier''s invoice number'; end if;
  if v_company is null then raise exception 'Set the company GSTIN and state first (Accounts → Company)'; end if;
  v_sup_state := partner_state_code(v_supplier);
  v_supply := case when v_sup_state is null or v_sup_state = v_company then 'intra' else 'inter' end;
  v_date := coalesce(nullif(p->>'bill_date', '')::date, today_ist());
  if v_date > today_ist() then raise exception 'The bill date can''t be in the future'; end if;

  for l in select * from jsonb_array_elements(p->'lines') loop
    if nullif(l->>'po_line_id', '') is not null then
      select * into pol from purchase_order_lines where id = (l->>'po_line_id')::uuid for update;
      if pol.id is null then raise exception 'Purchase order line not found'; end if;
      v_qty := (l->>'qty')::numeric;
      if v_qty is null or v_qty <= 0 or pol.billed_qty + v_qty > pol.received_qty then
        raise exception 'Can bill at most % of % (received but not yet billed)', fmt_qty(pol.received_qty - pol.billed_qty),
          (select code from skus where id = pol.sku_id);
      end if;
      v_price := coalesce(nullif(l->>'unit_price', '')::numeric, pol.unit_price);
      v_rate := coalesce(nullif(l->>'gst_rate', '')::numeric, pol.gst_rate);
      v_taxable := round(v_qty * v_price, 2);
      v_tax := round(v_taxable * v_rate / 100, 2);
      update purchase_order_lines set billed_qty = billed_qty + v_qty where id = pol.id;
      v_jl := v_jl || jsonb_build_object('account', 'grni', 'debit', round(v_qty * pol.unit_price, 2), 'partner_id', v_supplier)
                   || jsonb_build_object('account', 'ppv', 'amount', v_taxable - round(v_qty * pol.unit_price, 2), 'partner_id', v_supplier);
      v_lines := v_lines || jsonb_build_object('po_line_id', pol.id, 'description', (select name from skus where id = pol.sku_id),
                   'qty', v_qty, 'unit_price', v_price, 'taxable', v_taxable, 'rate', v_rate, 'tax', v_tax);
    else
      v_taxable := round((l->>'amount')::numeric, 2);
      if v_taxable is null or v_taxable <= 0 then raise exception 'Enter the amount (before GST) for each expense line'; end if;
      v_rate := coalesce(nullif(l->>'gst_rate', '')::numeric, 0);
      v_tax := round(v_taxable * v_rate / 100, 2);
      v_jl := v_jl || jsonb_build_object('account', coalesce(l->>'expense_account', 'other_expenses'), 'debit', v_taxable,
                                         'partner_id', v_supplier, 'memo', l->>'description');
      v_lines := v_lines || jsonb_build_object('account_id', acct(coalesce(l->>'expense_account', 'other_expenses')),
                   'description', coalesce(nullif(l->>'description', ''), 'Expense'), 'qty', 1, 'unit_price', v_taxable,
                   'taxable', v_taxable, 'rate', v_rate, 'tax', v_tax);
    end if;
    v_tot_taxable := v_tot_taxable + v_taxable; v_tot_tax := v_tot_tax + v_tax;
  end loop;
  if v_tot_taxable <= 0 then raise exception 'The bill has no lines'; end if;

  v_split := gst_split(v_tot_tax, v_supply);
  insert into purchase_bills (supplier_id, supplier_invoice_no, bill_date, due_date, po_id, supply_type, taxable_value,
                              cgst, sgst, igst, total, notes, idempotency_key, created_by)
  values (v_supplier, trim(p->>'supplier_invoice_no'), v_date, nullif(p->>'due_date', '')::date, nullif(p->>'po_id', '')::uuid,
          v_supply, v_tot_taxable, (v_split->>'cgst')::numeric, (v_split->>'sgst')::numeric, (v_split->>'igst')::numeric,
          v_tot_taxable + v_tot_tax, nullif(p->>'notes', ''), v_key, auth.uid())
  returning * into v_bill;

  insert into purchase_bill_lines (bill_id, po_line_id, account_id, description, qty, unit_price, taxable_value, gst_rate, tax)
  select v_bill.id, nullif(x->>'po_line_id', '')::uuid, nullif(x->>'account_id', '')::uuid, x->>'description',
         (x->>'qty')::numeric, (x->>'unit_price')::numeric, (x->>'taxable')::numeric, (x->>'rate')::numeric, (x->>'tax')::numeric
    from jsonb_array_elements(v_lines) x;

  v_jl := v_jl
    || jsonb_build_object('account', 'input_cgst', 'debit', (v_split->>'cgst')::numeric, 'partner_id', v_supplier)
    || jsonb_build_object('account', 'input_sgst', 'debit', (v_split->>'sgst')::numeric, 'partner_id', v_supplier)
    || jsonb_build_object('account', 'input_igst', 'debit', (v_split->>'igst')::numeric, 'partner_id', v_supplier)
    || jsonb_build_object('account', 'payables', 'credit', v_bill.total, 'partner_id', v_supplier);
  v_id := post_journal(v_date, 'purchase_bill', v_bill.id, 'main',
            'Bill ' || v_bill.supplier_invoice_no || ' from ' || (select coalesce(display_name, legal_name) from business_partners where id = v_supplier), v_jl);
  return jsonb_build_object('bill_id', v_bill.id, 'code', v_bill.code, 'total', v_bill.total, 'supply_type', v_supply,
    'journal_code', (select code from journal_entries where id = v_id));
end; $$;

create or replace function payment_account_key(p_method text, p_gateway text default null)
returns text language sql immutable as $$
  select case
    when lower(coalesce(p_method, '')) in ('cash', 'cod') then 'cash'
    when p_gateway is not null and lower(p_gateway) not in ('manual', '') then 'gateway_clearing'
    when lower(coalesce(p_method, '')) in ('upi', 'card', 'netbanking', 'wallet') then 'gateway_clearing'
    else 'bank' end
$$;

create or replace function record_supplier_payment(p_supplier_id uuid, p_amount numeric, p_method text default 'bank_transfer',
  p_reference text default null, p_bill_id uuid default null, p_paid_on date default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text; v_date date := coalesce(p_paid_on, today_ist());
begin
  perform require_role('accountant', 'manager');
  if p_idempotency_key is not null then
    select id, code into v_id, v_code from supplier_payments where idempotency_key = p_idempotency_key;
    if v_id is not null then return jsonb_build_object('payment_id', v_id, 'code', v_code, 'duplicate', true); end if;
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if p_bill_id is not null and not exists (select 1 from purchase_bills where id = p_bill_id and supplier_id = p_supplier_id) then
    raise exception 'That bill belongs to a different supplier';
  end if;
  insert into supplier_payments (supplier_id, bill_id, amount, method, reference, paid_on, idempotency_key, created_by)
  values (p_supplier_id, p_bill_id, p_amount, coalesce(p_method, 'bank_transfer'), p_reference, v_date, p_idempotency_key, auth.uid())
  returning id, code into v_id, v_code;
  perform post_journal(v_date, 'supplier_payment', v_id, 'main', 'Payment ' || v_code || coalesce(' ref ' || p_reference, ''),
    jsonb_build_array(
      jsonb_build_object('account', 'payables', 'debit', p_amount, 'partner_id', p_supplier_id),
      jsonb_build_object('account', payment_account_key(p_method), 'credit', p_amount, 'partner_id', p_supplier_id)));
  return jsonb_build_object('payment_id', v_id, 'code', v_code);
end; $$;

-- Read helpers
create or replace function list_purchase_orders(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_role('warehouse', 'manager', 'accountant');
  return (select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', po.id, 'code', po.code, 'status', po.status, 'order_date', po.order_date,
      'expected_date', po.expected_date, 'created_at', po.created_at,
      'supplier', (select coalesce(display_name, legal_name) from business_partners where id = po.supplier_id),
      'supplier_id', po.supplier_id, 'location', (select name from locations where id = po.deliver_to_location_id),
      'value', (select sum(round(qty * unit_price, 2)) from purchase_order_lines where po_id = po.id),
      'lines', (select jsonb_agg(jsonb_build_object('id', l.id, 'sku_id', l.sku_id, 'sku_code', s.code, 'name', s.name,
                  'unit', s.pack_unit, 'qty', l.qty, 'unit_price', l.unit_price, 'gst_rate', l.gst_rate,
                  'received_qty', l.received_qty, 'billed_qty', l.billed_qty) order by l.line_no)
                from purchase_order_lines l join skus s on s.id = l.sku_id where l.po_id = po.id)) x
    from purchase_orders po
    where p_status is null or p_status = '' or po.status = p_status
       or (p_status = 'open_any' and po.status in ('open', 'partially_received'))
       or (p_status = 'to_bill' and exists (select 1 from purchase_order_lines where po_id = po.id and billed_qty < received_qty))
  ) t);
end; $$;

create or replace function list_bills(p_supplier_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_role('manager', 'accountant');
  return (select coalesce(jsonb_agg(x order by x->>'bill_date' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', b.id, 'code', b.code, 'supplier_invoice_no', b.supplier_invoice_no, 'bill_date', b.bill_date,
      'due_date', b.due_date, 'supplier', (select coalesce(display_name, legal_name) from business_partners where id = b.supplier_id),
      'supplier_id', b.supplier_id, 'taxable_value', b.taxable_value, 'tax', b.cgst + b.sgst + b.igst, 'total', b.total,
      'paid', (select coalesce(sum(amount), 0) from supplier_payments where bill_id = b.id),
      'outstanding', b.total - (select coalesce(sum(amount), 0) from supplier_payments where bill_id = b.id)) x
    from purchase_bills b where p_supplier_id is null or b.supplier_id = p_supplier_id
  ) t);
end; $$;
