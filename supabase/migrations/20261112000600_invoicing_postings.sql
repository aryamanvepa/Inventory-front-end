-- =====================================================================
-- Migration 0013 — GST invoices, credit notes and automatic postings
--
-- Invoices: issued automatically when an order is dispatched (time of
-- supply for goods). One invoice per order, numbered INV/26-27/000001.
-- Prices are GST-inclusive, so tax is extracted line by line:
--   taxable = gross × 100 / (100 + rate); tax = gross − taxable.
-- Place of supply = delivery state. Same state as the company -> CGST+SGST,
-- otherwise IGST. Delivery charges follow the principal supply (rate of
-- the largest line) — confirm this treatment with the CA.
--
-- Credit notes: issued automatically when money is refunded on an
-- invoiced order (pro-rata across the invoice lines), CN/26-27/000001.
--
-- Automatic postings (all idempotent, none can block operations):
--   payment received   Dr Cash/Bank/Gateway clearing   Cr Receivables
--   refund             Dr Receivables                  Cr Cash/Bank/Gateway
--   invoice            Dr Receivables   Cr Sales (by brand) / Delivery / Output GST
--   credit note        Dr Sales returns / Delivery / Output GST   Cr Receivables
--   stock movements    inventory value change (batch cost) against
--                      COGS (sales), write-offs/adjustments, or opening
--                      balances (stock received without a purchase order)
-- =====================================================================

create table invoices (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique,            -- INV/26-27/000001
  invoice_date         date not null,
  order_id             uuid not null unique references orders(id),
  seller               jsonb not null,                  -- name, gstin, state_code, address (snapshot)
  buyer                jsonb not null,                  -- name, phone, email, address, gstin?
  place_of_supply      text not null references gst_states(code),
  supply_type          text not null check (supply_type in ('intra', 'inter')),
  taxable_value        numeric(14,2) not null,
  cgst                 numeric(14,2) not null default 0,
  sgst                 numeric(14,2) not null default 0,
  igst                 numeric(14,2) not null default 0,
  total                numeric(14,2) not null,
  created_by           uuid,
  created_at           timestamptz not null default now()
);
create trigger immutable before update or delete on invoices for each row execute function trg_immutable();

create table invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references invoices(id),
  line_no       int not null,
  sku_id        uuid references skus(id),
  brand_id      uuid references brands(id),
  description   text not null,
  hsn           text,
  qty           numeric(14,3) not null,
  unit          text,
  gross_amount  numeric(14,2) not null,                 -- GST-inclusive
  taxable_value numeric(14,2) not null,
  gst_rate      numeric(5,2) not null,
  cgst          numeric(14,2) not null default 0,
  sgst          numeric(14,2) not null default 0,
  igst          numeric(14,2) not null default 0,
  unique (invoice_id, line_no)
);
create trigger immutable before update or delete on invoice_lines for each row execute function trg_immutable();

create table credit_notes (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,                   -- CN/26-27/000001
  note_date     date not null,
  invoice_id    uuid not null references invoices(id),
  payment_id    uuid unique references payments(id),    -- the refund that triggered it
  reason        text not null,
  taxable_value numeric(14,2) not null,
  cgst          numeric(14,2) not null default 0,
  sgst          numeric(14,2) not null default 0,
  igst          numeric(14,2) not null default 0,
  total         numeric(14,2) not null,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create trigger immutable before update or delete on credit_notes for each row execute function trg_immutable();

create table credit_note_lines (
  id              uuid primary key default gen_random_uuid(),
  credit_note_id  uuid not null references credit_notes(id),
  invoice_line_id uuid not null references invoice_lines(id),
  gross_amount    numeric(14,2) not null,
  taxable_value   numeric(14,2) not null,
  cgst            numeric(14,2) not null default 0,
  sgst            numeric(14,2) not null default 0,
  igst            numeric(14,2) not null default 0
);
create trigger immutable before update or delete on credit_note_lines for each row execute function trg_immutable();

-- ---------------------------------------------------------------------
-- Invoice issue (lines are computed first, then the invoice is written once)
-- ---------------------------------------------------------------------
create or replace function issue_invoice_core(p_order_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype; le legal_entities%rowtype; c customers%rowtype;
  v_inv uuid; v_pos text; v_supply text; v_date date := today_ist();
  v_goods numeric; v_disc numeric; v_left numeric; v_n int := 0; v_cnt int; r record;
  v_gross numeric; v_taxable numeric; v_tax numeric; v_split jsonb;
  v_lines jsonb := '[]'::jsonb; v_jl jsonb := '[]'::jsonb; v_prate numeric; v_phsn text; v_pgross numeric := -1;
  t_taxable numeric := 0; t_cgst numeric := 0; t_sgst numeric := 0; t_igst numeric := 0;
begin
  select id into v_inv from invoices where order_id = p_order_id;
  if v_inv is not null then return v_inv; end if;
  select * into o from orders where id = p_order_id for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status not in ('dispatched', 'delivered', 'delivery_failed') then
    raise exception 'An invoice is issued when the order is dispatched (% is %)', o.code, o.status;
  end if;
  select * into le from legal_entities where id = o.legal_entity_id;
  if le.state_code is null then raise exception 'Set the company GSTIN and state first (Accounts → Company)'; end if;
  select * into c from customers where id = o.customer_id;
  v_pos := coalesce(gst_state_code(o.ship_to->>'state'), gst_state_code(c.state));
  if v_pos is null then
    raise exception 'Delivery state for % is missing or not recognised (%)', o.code, coalesce(o.ship_to->>'state', 'blank');
  end if;
  v_supply := case when v_pos = le.state_code then 'intra' else 'inter' end;

  -- goods lines, with any order-level discount spread pro-rata
  select coalesce(sum(line_total), 0), count(*) into v_goods, v_cnt from order_lines where order_id = o.id;
  v_disc := least(coalesce(o.discount_amount, 0), v_goods); v_left := v_disc;
  for r in select ol.*, s.name sku_name, pr.brand_id, t.hsn_code
             from order_lines ol join skus s on s.id = ol.sku_id join products pr on pr.id = s.product_id
             left join tax_rates t on t.id = pr.tax_rate_id
            where ol.order_id = o.id order by ol.line_no loop
    v_n := v_n + 1;
    if v_n = v_cnt then v_gross := r.line_total - v_left;
    else
      v_gross := r.line_total - case when v_goods > 0 then round(v_disc * r.line_total / v_goods, 2) else 0 end;
      v_left := v_left - (r.line_total - v_gross);
    end if;
    v_taxable := round(v_gross * 100 / (100 + r.tax_rate), 2);
    v_tax := v_gross - v_taxable;
    v_split := gst_split(v_tax, v_supply);
    v_lines := v_lines || jsonb_build_object('line_no', v_n, 'sku_id', r.sku_id, 'brand_id', r.brand_id, 'description', r.sku_name,
                 'hsn', r.hsn_code, 'qty', r.qty, 'unit', 'pcs', 'gross', v_gross, 'taxable', v_taxable, 'rate', r.tax_rate,
                 'cgst', v_split->'cgst', 'sgst', v_split->'sgst', 'igst', v_split->'igst');
    v_jl := v_jl || jsonb_build_object('account', 'sales', 'credit', v_taxable, 'brand_id', r.brand_id,
                                       'channel_id', o.channel_id, 'customer_id', o.customer_id);
    if v_gross > v_pgross then v_pgross := v_gross; v_prate := r.tax_rate; v_phsn := r.hsn_code; end if;
    t_taxable := t_taxable + v_taxable; t_cgst := t_cgst + (v_split->>'cgst')::numeric;
    t_sgst := t_sgst + (v_split->>'sgst')::numeric; t_igst := t_igst + (v_split->>'igst')::numeric;
  end loop;

  -- delivery charges: composite supply, taxed at the principal (largest) line's rate
  if coalesce(o.shipping_amount, 0) > 0 then
    v_n := v_n + 1;
    v_taxable := round(o.shipping_amount * 100 / (100 + coalesce(v_prate, 0)), 2);
    v_tax := o.shipping_amount - v_taxable;
    v_split := gst_split(v_tax, v_supply);
    v_lines := v_lines || jsonb_build_object('line_no', v_n, 'description', 'Delivery charges', 'hsn', v_phsn, 'qty', 1,
                 'unit', 'service', 'gross', o.shipping_amount, 'taxable', v_taxable, 'rate', coalesce(v_prate, 0),
                 'cgst', v_split->'cgst', 'sgst', v_split->'sgst', 'igst', v_split->'igst');
    v_jl := v_jl || jsonb_build_object('account', 'delivery_income', 'credit', v_taxable,
                                       'channel_id', o.channel_id, 'customer_id', o.customer_id);
    t_taxable := t_taxable + v_taxable; t_cgst := t_cgst + (v_split->>'cgst')::numeric;
    t_sgst := t_sgst + (v_split->>'sgst')::numeric; t_igst := t_igst + (v_split->>'igst')::numeric;
  end if;

  insert into invoices (code, invoice_date, order_id, seller, buyer, place_of_supply, supply_type, taxable_value,
                        cgst, sgst, igst, total, created_by)
  values (next_fy_code('INV', v_date), v_date, o.id,
          jsonb_build_object('name', le.name, 'gstin', le.gstin, 'pan', le.pan, 'state_code', le.state_code,
                             'state', (select name from gst_states where code = le.state_code), 'address', le.registered_address),
          jsonb_build_object('name', coalesce(o.ship_to->>'name', c.full_name), 'phone', coalesce(o.ship_to->>'phone', c.phone),
                             'email', c.email, 'customer_code', c.code,
                             'address', concat_ws(', ', nullif(o.ship_to->>'address1', ''), nullif(o.ship_to->>'address2', ''),
                                                  nullif(o.ship_to->>'city', ''), nullif(o.ship_to->>'state', ''), nullif(o.ship_to->>'pincode', ''))),
          v_pos, v_supply, t_taxable, t_cgst, t_sgst, t_igst, t_taxable + t_cgst + t_sgst + t_igst, auth.uid())
  returning id into v_inv;

  insert into invoice_lines (invoice_id, line_no, sku_id, brand_id, description, hsn, qty, unit, gross_amount, taxable_value,
                             gst_rate, cgst, sgst, igst)
  select v_inv, (x->>'line_no')::int, nullif(x->>'sku_id', '')::uuid, nullif(x->>'brand_id', '')::uuid, x->>'description',
         x->>'hsn', (x->>'qty')::numeric, x->>'unit', (x->>'gross')::numeric, (x->>'taxable')::numeric, (x->>'rate')::numeric,
         (x->>'cgst')::numeric, (x->>'sgst')::numeric, (x->>'igst')::numeric
    from jsonb_array_elements(v_lines) x;

  v_jl := v_jl
    || jsonb_build_object('account', 'output_cgst', 'credit', t_cgst)
    || jsonb_build_object('account', 'output_sgst', 'credit', t_sgst)
    || jsonb_build_object('account', 'output_igst', 'credit', t_igst)
    || jsonb_build_object('account', 'receivables', 'debit', t_taxable + t_cgst + t_sgst + t_igst,
                          'channel_id', o.channel_id, 'customer_id', o.customer_id);
  perform post_journal(v_date, 'invoice', v_inv, 'main', 'Invoice for ' || o.code, v_jl);
  return v_inv;
end; $$;

-- Never blocks the caller: failures become accounting exceptions (alerts)
create or replace function try_issue_invoice(p_order_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid; v_err text;
begin
  begin
    v := issue_invoice_core(p_order_id);
    update accounting_exceptions set resolved_at = now()
     where kind = 'invoice_failed' and ref_id = p_order_id and resolved_at is null;
    return v;
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform log_accounting_exception('invoice_failed', 'order', p_order_id,
      'Invoice not issued for ' || (select code from orders where id = p_order_id) || ': ' || v_err);
    return null;
  end;
end; $$;

-- Manual issue / retry (e.g. after setting the company GSTIN)
create or replace function issue_invoice(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  perform require_role('accountant', 'manager');
  v := issue_invoice_core(p_order_id);
  update accounting_exceptions set resolved_at = now(), resolved_by = auth.uid()
   where kind = 'invoice_failed' and ref_id = p_order_id and resolved_at is null;
  return get_invoice(v);
end; $$;

create or replace function trg_invoice_on_dispatch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'dispatched' and old.status is distinct from 'dispatched' then
    perform try_issue_invoice(new.id);
  end if;
  return null;
end; $$;
create trigger invoice_on_dispatch after update of status on orders for each row execute function trg_invoice_on_dispatch();

-- ---------------------------------------------------------------------
-- Credit notes (pro-rata across the invoice's lines)
-- ---------------------------------------------------------------------
create or replace function issue_credit_note_core(p_invoice_id uuid, p_amount numeric, p_reason text, p_payment_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  inv invoices%rowtype; o orders%rowtype; v_remaining numeric; v_amt numeric; v_cn uuid; l record; v_n int := 0; v_cnt int;
  v_gross numeric; v_taxable numeric; v_split jsonb; v_left numeric; v_lines jsonb := '[]'::jsonb; v_jl jsonb := '[]'::jsonb;
  t_taxable numeric := 0; t_cgst numeric := 0; t_sgst numeric := 0; t_igst numeric := 0; v_date date := today_ist();
begin
  if p_payment_id is not null then
    select id into v_cn from credit_notes where payment_id = p_payment_id;
    if v_cn is not null then return v_cn; end if;
  end if;
  select * into inv from invoices where id = p_invoice_id for update;
  if inv.id is null then raise exception 'Invoice not found'; end if;
  select * into o from orders where id = inv.order_id;
  v_remaining := inv.total - (select coalesce(sum(total), 0) from credit_notes where invoice_id = inv.id);
  v_amt := round(least(p_amount, v_remaining), 2);
  if v_amt <= 0 then return null; end if;

  select count(*) into v_cnt from invoice_lines where invoice_id = inv.id;
  v_left := v_amt;
  for l in select * from invoice_lines where invoice_id = inv.id order by line_no loop
    v_n := v_n + 1;
    v_gross := case when v_n = v_cnt then v_left else round(v_amt * l.gross_amount / inv.total, 2) end;
    v_left := v_left - v_gross;
    v_taxable := round(v_gross * 100 / (100 + l.gst_rate), 2);
    v_split := gst_split(v_gross - v_taxable, inv.supply_type);
    v_lines := v_lines || jsonb_build_object('invoice_line_id', l.id, 'gross', v_gross, 'taxable', v_taxable,
                 'cgst', v_split->'cgst', 'sgst', v_split->'sgst', 'igst', v_split->'igst');
    v_jl := v_jl || jsonb_build_object('account', case when l.sku_id is null then 'delivery_income' else 'sales_returns' end,
                 'debit', v_taxable, 'brand_id', l.brand_id, 'channel_id', o.channel_id, 'customer_id', o.customer_id);
    t_taxable := t_taxable + v_taxable; t_cgst := t_cgst + (v_split->>'cgst')::numeric;
    t_sgst := t_sgst + (v_split->>'sgst')::numeric; t_igst := t_igst + (v_split->>'igst')::numeric;
  end loop;

  insert into credit_notes (code, note_date, invoice_id, payment_id, reason, taxable_value, cgst, sgst, igst, total, created_by)
  values (next_fy_code('CN', v_date), v_date, inv.id, p_payment_id, coalesce(nullif(trim(p_reason), ''), 'Refund'),
          t_taxable, t_cgst, t_sgst, t_igst, v_amt, auth.uid())
  returning id into v_cn;
  insert into credit_note_lines (credit_note_id, invoice_line_id, gross_amount, taxable_value, cgst, sgst, igst)
  select v_cn, (x->>'invoice_line_id')::uuid, (x->>'gross')::numeric, (x->>'taxable')::numeric,
         (x->>'cgst')::numeric, (x->>'sgst')::numeric, (x->>'igst')::numeric from jsonb_array_elements(v_lines) x;

  v_jl := v_jl
    || jsonb_build_object('account', 'output_cgst', 'debit', t_cgst)
    || jsonb_build_object('account', 'output_sgst', 'debit', t_sgst)
    || jsonb_build_object('account', 'output_igst', 'debit', t_igst)
    || jsonb_build_object('account', 'receivables', 'credit', v_amt, 'channel_id', o.channel_id, 'customer_id', o.customer_id);
  perform post_journal(v_date, 'credit_note', v_cn, 'main', 'Credit note against ' || inv.code, v_jl);
  return v_cn;
end; $$;

-- Manual credit note (e.g. price adjustment without a refund through the system)
create or replace function issue_credit_note(p_invoice_id uuid, p_amount numeric, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  perform require_role('accountant', 'manager');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  v := issue_credit_note_core(p_invoice_id, p_amount, p_reason, null);
  if v is null then raise exception 'Nothing left to credit on this invoice'; end if;
  return jsonb_build_object('credit_note_id', v, 'code', (select code from credit_notes where id = v));
end; $$;

-- ---------------------------------------------------------------------
-- Customer payments and refunds -> ledger (+ credit note on invoiced refunds)
-- ---------------------------------------------------------------------
create or replace function ledger_post_payment(p_payment_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare py payments%rowtype; o orders%rowtype; v_acct text; v_inv uuid; v_err text;
begin
  select * into py from payments where id = p_payment_id;
  select * into o from orders where id = py.order_id;
  v_acct := payment_account_key(py.method, py.gateway);
  begin
    if py.kind = 'payment' then
      perform post_journal((py.received_at at time zone 'Asia/Kolkata')::date, 'payment', py.id, 'main',
        'Payment ' || py.code || ' for ' || o.code,
        jsonb_build_array(
          jsonb_build_object('account', v_acct, 'debit', py.amount, 'channel_id', o.channel_id, 'customer_id', o.customer_id),
          jsonb_build_object('account', 'receivables', 'credit', py.amount, 'channel_id', o.channel_id, 'customer_id', o.customer_id)));
    else
      perform post_journal((py.received_at at time zone 'Asia/Kolkata')::date, 'payment', py.id, 'main',
        'Refund ' || py.code || ' for ' || o.code,
        jsonb_build_array(
          jsonb_build_object('account', 'receivables', 'debit', py.amount, 'channel_id', o.channel_id, 'customer_id', o.customer_id),
          jsonb_build_object('account', v_acct, 'credit', py.amount, 'channel_id', o.channel_id, 'customer_id', o.customer_id)));
      select id into v_inv from invoices where order_id = o.id;
      if v_inv is not null then
        perform issue_credit_note_core(v_inv, py.amount, coalesce(py.notes, 'Refund'), py.id);
      end if;
    end if;
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform log_accounting_exception('posting_failed', 'payment', py.id, 'Payment ' || py.code || ' not posted: ' || v_err);
  end;
end; $$;

create or replace function trg_post_payment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform ledger_post_payment(new.id);
  return null;
end; $$;
create trigger ledger_post after insert on payments for each row execute function trg_post_payment();

-- Payment-gateway settlement: clearing -> bank, less fees (+ GST on fees as input credit)
create or replace function record_gateway_settlement(p_gross numeric, p_fees numeric, p_gst_on_fees numeric default 0,
  p_reference text default null, p_date date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_net numeric := round(p_gross - coalesce(p_fees, 0) - coalesce(p_gst_on_fees, 0), 2);
begin
  perform require_role('accountant', 'manager');
  if p_gross is null or p_gross <= 0 or v_net < 0 then raise exception 'Check the settlement amounts'; end if;
  v_id := post_journal(coalesce(p_date, today_ist()), 'gateway_settlement', gen_random_uuid(), 'main',
    'Gateway settlement' || coalesce(' ' || p_reference, ''),
    jsonb_build_array(
      jsonb_build_object('account', 'bank', 'debit', v_net),
      jsonb_build_object('account', 'gateway_fees', 'debit', coalesce(p_fees, 0)),
      jsonb_build_object('account', 'input_igst', 'debit', coalesce(p_gst_on_fees, 0)),
      jsonb_build_object('account', 'gateway_clearing', 'credit', p_gross)));
  return jsonb_build_object('entry_id', v_id, 'code', (select code from journal_entries where id = v_id), 'net_to_bank', v_net);
end; $$;

-- ---------------------------------------------------------------------
-- Stock movements -> inventory value (batch cost), posted at commit
-- ---------------------------------------------------------------------
create or replace function ledger_post_stock_txn(p_txn_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  t stock_transactions%rowtype; r record; v_counter text; v_jl jsonb := '[]'::jsonb; v_uncosted int; v_err text;
begin
  select * into t from stock_transactions where id = p_txn_id;
  -- purchases and production post their own, richer journals
  if t.reference_type in ('purchase_receipt', 'production_order') then return; end if;
  v_counter := case
    when t.txn_type in ('goods_receipt', 'production_receipt') then 'opening'
    when t.txn_type in ('sale_issue', 'ownership_transfer', 'return_receipt') then 'cogs'
    else 'inventory_adj' end;
  begin
    for r in select inventory_account_key(m.sku_id) acct, sku_brand(m.sku_id) brand,
                    round(sum(m.qty * b.unit_cost), 2) val
               from stock_movements m join batches b on b.id = m.batch_id
              where m.transaction_id = t.id and m.owner_id = company_owner_id()
                and m.status not in ('damaged', 'expired') and b.unit_cost is not null
              group by 1, 2 loop
      continue when r.val = 0;
      v_jl := v_jl || jsonb_build_object('account', r.acct, 'amount', r.val, 'brand_id', r.brand)
                   || jsonb_build_object('account', v_counter, 'amount', -r.val, 'brand_id', r.brand);
    end loop;
    perform post_journal((t.created_at at time zone 'Asia/Kolkata')::date, 'stock_txn', t.id, 'main',
                         coalesce(t.code, '') || ' ' || t.txn_type || coalesce(': ' || t.reason, ''), v_jl);

    select count(*) into v_uncosted from stock_movements m left join batches b on b.id = m.batch_id
     where m.transaction_id = t.id and m.owner_id = company_owner_id() and m.status not in ('damaged', 'expired')
       and (b.id is null or b.unit_cost is null);
    if v_uncosted > 0 and t.txn_type not in ('pack', 'unpack', 'transfer') then
      perform log_accounting_exception('uncosted_stock', 'stock_txn', t.id,
        coalesce(t.code, 'Stock movement') || ': ' || v_uncosted || ' line(s) have no batch cost, so inventory value is incomplete');
    end if;
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform log_accounting_exception('posting_failed', 'stock_txn', t.id, coalesce(t.code, 'Stock movement') || ' not posted: ' || v_err);
  end;
end; $$;

create or replace function trg_post_stock_txn()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform ledger_post_stock_txn(new.id);
  return null;
end; $$;
-- deferred: runs at commit, once all movement lines of the transaction exist
create constraint trigger ledger_post after insert on stock_transactions
  deferrable initially deferred for each row execute function trg_post_stock_txn();

-- ---------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------
create or replace function get_invoice(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform require_role('manager', 'accountant', 'packer', 'warehouse');
  select jsonb_build_object('id', i.id, 'code', i.code, 'invoice_date', i.invoice_date, 'seller', i.seller, 'buyer', i.buyer,
      'place_of_supply', i.place_of_supply, 'place_of_supply_name', (select name from gst_states where code = i.place_of_supply),
      'supply_type', i.supply_type, 'taxable_value', i.taxable_value, 'cgst', i.cgst, 'sgst', i.sgst, 'igst', i.igst,
      'total', i.total, 'order_id', o.id, 'order_code', o.code,
      'lines', (select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'description', l.description, 'hsn', l.hsn, 'qty', l.qty,
                 'unit', l.unit, 'gross', l.gross_amount, 'taxable', l.taxable_value, 'rate', l.gst_rate,
                 'cgst', l.cgst, 'sgst', l.sgst, 'igst', l.igst) order by l.line_no) from invoice_lines l where l.invoice_id = i.id),
      'credit_notes', (select coalesce(jsonb_agg(jsonb_build_object('id', cn.id, 'code', cn.code, 'date', cn.note_date,
                 'total', cn.total, 'reason', cn.reason) order by cn.note_date), '[]'::jsonb) from credit_notes cn where cn.invoice_id = i.id),
      'paid', (select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0) from payments where order_id = o.id))
    into v from invoices i join orders o on o.id = i.order_id where i.id = p_id;
  if v is null then raise exception 'Invoice not found'; end if;
  return v;
end; $$;

create or replace function list_invoices(p_from date default null, p_to date default null, p_search text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_role('manager', 'accountant');
  return (select coalesce(jsonb_agg(x order by x->>'code' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', i.id, 'code', i.code, 'invoice_date', i.invoice_date, 'order_code', o.code,
      'customer', i.buyer->>'name', 'supply_type', i.supply_type, 'taxable_value', i.taxable_value,
      'tax', i.cgst + i.sgst + i.igst, 'total', i.total,
      'credited', (select coalesce(sum(total), 0) from credit_notes where invoice_id = i.id)) x
    from invoices i join orders o on o.id = i.order_id
    where (p_from is null or i.invoice_date >= p_from) and (p_to is null or i.invoice_date <= p_to)
      and (p_search is null or p_search = '' or i.code ilike '%' || p_search || '%' or o.code ilike '%' || p_search || '%'
           or i.buyer->>'name' ilike '%' || p_search || '%')
    limit 500) t);
end; $$;

create or replace function invoice_for_order(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  perform require_staff();
  select id into v from invoices where order_id = p_order_id;
  return case when v is null then null else get_invoice(v) end;
end; $$;
