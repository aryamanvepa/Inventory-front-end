-- =====================================================================
-- Migration 0010 — General ledger (double-entry) core
--
--   * Chart of accounts with stable "system keys" used by automatic postings.
--   * Journal entries + lines; every entry must balance (checked at commit).
--   * Brand / channel / customer / partner dimensions on every line, so
--     brand-level P&L comes from one set of books (one legal entity).
--   * Posted journals are permanent: corrections are reversing entries.
--   * Month-level period locking.
--   * Automatic postings never block operations: if one fails, it is
--     recorded in accounting_exceptions and shown to the founder.
--   * GST state codes + company GST details.
--
-- Indian financial year: April–March. Document numbers use it, e.g.
--   JV/26-27/000001, INV/26-27/000001, CN/26-27/000001.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Financial-year helpers and numbering
-- ---------------------------------------------------------------------
create or replace function fy_start_year(p_date date)
returns int language sql immutable as $$
  select case when extract(month from p_date) >= 4 then extract(year from p_date)::int
              else extract(year from p_date)::int - 1 end
$$;

create or replace function fy_label(p_date date)
returns text language sql immutable as $$
  select lpad((fy_start_year(p_date) % 100)::text, 2, '0') || '-' || lpad(((fy_start_year(p_date) + 1) % 100)::text, 2, '0')
$$;

-- next_fy_code('INV', date) -> INV/26-27/000001 (sequence restarts each FY; GST-compliant length)
create or replace function next_fy_code(p_prefix text, p_date date default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_d date := coalesce(p_date, today_ist()); v_val bigint;
begin
  insert into code_sequences as s (prefix, year, last_value)
  values ('FY:' || p_prefix, fy_start_year(v_d), 1)
  on conflict (prefix, year) do update set last_value = s.last_value + 1
  returning last_value into v_val;
  return p_prefix || '/' || fy_label(v_d) || '/' || lpad(v_val::text, 6, '0');
end; $$;

-- ---------------------------------------------------------------------
-- GST state codes (place of supply) and company GST details
-- ---------------------------------------------------------------------
create table gst_states (
  code    text primary key,          -- '36'
  name    text not null unique,      -- 'Telangana'
  aliases text[] not null default '{}'
);

insert into gst_states (code, name, aliases) values
  ('01','Jammu and Kashmir','{JK,"J&K","Jammu & Kashmir"}'), ('02','Himachal Pradesh','{HP}'), ('03','Punjab','{PB}'),
  ('04','Chandigarh','{CH}'), ('05','Uttarakhand','{UK,UT,Uttaranchal}'), ('06','Haryana','{HR}'), ('07','Delhi','{DL,"New Delhi","NCT of Delhi"}'),
  ('08','Rajasthan','{RJ}'), ('09','Uttar Pradesh','{UP}'), ('10','Bihar','{BR}'), ('11','Sikkim','{SK}'),
  ('12','Arunachal Pradesh','{AR}'), ('13','Nagaland','{NL}'), ('14','Manipur','{MN}'), ('15','Mizoram','{MZ}'),
  ('16','Tripura','{TR}'), ('17','Meghalaya','{ML}'), ('18','Assam','{AS}'), ('19','West Bengal','{WB}'),
  ('20','Jharkhand','{JH}'), ('21','Odisha','{OR,OD,Orissa}'), ('22','Chhattisgarh','{CG,CT}'), ('23','Madhya Pradesh','{MP}'),
  ('24','Gujarat','{GJ}'), ('26','Dadra and Nagar Haveli and Daman and Diu','{DH,DN,DD}'), ('27','Maharashtra','{MH}'),
  ('29','Karnataka','{KA}'), ('30','Goa','{GA}'), ('31','Lakshadweep','{LD}'), ('32','Kerala','{KL}'),
  ('33','Tamil Nadu','{TN}'), ('34','Puducherry','{PY,Pondicherry}'), ('35','Andaman and Nicobar Islands','{AN}'),
  ('36','Telangana','{TG,TS}'), ('37','Andhra Pradesh','{AP}'), ('38','Ladakh','{LA}'), ('97','Other Territory','{OT}');

-- Resolve free-text state ('Telangana', 'TG', 'telangana ', '36') to a GST state code
create or replace function gst_state_code(p_state text)
returns text language sql stable security definer set search_path = public as $$
  select code from gst_states
   where lower(trim(p_state)) = lower(name) or code = trim(p_state)
      or lower(trim(p_state)) = any (select lower(a) from unnest(aliases) a)
   limit 1
$$;

-- GSTIN: 2-digit state + PAN (10) + entity no + 'Z' + checksum char
create or replace function is_valid_gstin(p text)
returns boolean language sql immutable as $$
  select p ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
$$;

create or replace function set_company_details(p_gstin text, p_state_code text, p_registered_address text, p_pan text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_gstin text := nullif(upper(trim(p_gstin)), ''); v_state text := gst_state_code(p_state_code);
begin
  perform require_role('admin');
  if v_state is null then raise exception 'Choose the state of the registered office'; end if;
  if v_gstin is not null and not is_valid_gstin(v_gstin) then raise exception 'That GSTIN is not in the valid 15-character format'; end if;
  if v_gstin is not null and left(v_gstin, 2) <> v_state then
    raise exception 'GSTIN starts with % but the state code is %', left(v_gstin, 2), v_state;
  end if;
  update legal_entities set gstin = v_gstin, state_code = v_state,
         registered_address = nullif(trim(p_registered_address), ''),
         pan = coalesce(nullif(upper(trim(p_pan)), ''), case when v_gstin is not null then substr(v_gstin, 3, 10) end)
   where id = (select id from legal_entities order by created_at limit 1);
  return jsonb_build_object('ok', true, 'state_code', v_state);
end; $$;

-- ---------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------
create type account_type as enum ('asset', 'liability', 'equity', 'income', 'expense');

create table accounts (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  type        account_type not null,
  system_key  text unique,                -- used by automatic postings; never change
  group_name  text not null,              -- report grouping
  description text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create trigger audit after insert or update or delete on accounts for each row execute function trg_audit();
create trigger no_delete before delete on accounts for each row execute function trg_no_delete();

insert into accounts (code, name, type, system_key, group_name, description) values
  ('1110', 'Cash on hand',                         'asset',     'cash',               'Cash & bank', 'Cash including cash-on-delivery collections'),
  ('1120', 'Bank account',                         'asset',     'bank',               'Cash & bank', null),
  ('1130', 'Payment gateway clearing',             'asset',     'gateway_clearing',   'Cash & bank', 'Online payments not yet settled to the bank'),
  ('1200', 'Trade receivables — customers',        'asset',     'receivables',        'Receivables', 'Negative balance = customer advances'),
  ('1310', 'Inventory — finished goods',           'asset',     'inv_finished',       'Inventory', null),
  ('1320', 'Inventory — raw materials',            'asset',     'inv_raw',            'Inventory', null),
  ('1330', 'Inventory — packaging materials',      'asset',     'inv_packaging',      'Inventory', null),
  ('1410', 'Input CGST',                           'asset',     'input_cgst',         'GST input credit', null),
  ('1420', 'Input SGST',                           'asset',     'input_sgst',         'GST input credit', null),
  ('1430', 'Input IGST',                           'asset',     'input_igst',         'GST input credit', null),
  ('1500', 'Advances & deposits',                  'asset',     'advances',           'Other assets', null),
  ('1600', 'Fixed assets',                         'asset',     'fixed_assets',       'Fixed assets', 'Equipment, ovens, vehicles (depreciation via journals)'),
  ('2100', 'Trade payables — suppliers',           'liability', 'payables',           'Payables', 'Negative balance = advances to suppliers'),
  ('2150', 'Goods received not invoiced',          'liability', 'grni',               'Payables', 'Cleared when the supplier bill is recorded'),
  ('2210', 'Output CGST',                          'liability', 'output_cgst',        'GST payable', null),
  ('2220', 'Output SGST',                          'liability', 'output_sgst',        'GST payable', null),
  ('2230', 'Output IGST',                          'liability', 'output_igst',        'GST payable', null),
  ('2300', 'Other current liabilities',            'liability', 'other_liabilities',  'Other liabilities', null),
  ('2400', 'Loans',                                'liability', 'loans',              'Loans', null),
  ('3000', 'Share capital',                        'equity',    'capital',            'Equity', null),
  ('3100', 'Opening balances & unmatched stock receipts', 'equity', 'opening',        'Equity', 'Opening stock and stock received without a purchase order: review and reclassify'),
  ('3900', 'Retained earnings',                    'equity',    'retained',           'Equity', null),
  ('4100', 'Sales — goods',                        'income',    'sales',              'Revenue', null),
  ('4150', 'Sales returns & credit notes',         'income',    'sales_returns',      'Revenue', 'Contra-revenue (debit balance)'),
  ('4200', 'Delivery charges recovered',           'income',    'delivery_income',    'Revenue', null),
  ('4900', 'Other income',                         'income',    'other_income',       'Other income', null),
  ('5100', 'Cost of goods sold',                   'expense',   'cogs',               'Cost of sales', null),
  ('5250', 'Production overheads absorbed',        'expense',   'overhead_absorbed',  'Cost of sales', 'Credit: conversion cost capitalised into batches'),
  ('5300', 'Inventory write-offs & adjustments',   'expense',   'inventory_adj',      'Cost of sales', 'Damage, expiry and count differences'),
  ('5400', 'Purchase price variance',              'expense',   'ppv',                'Cost of sales', 'Supplier bill price vs purchase-order price'),
  ('6100', 'Delivery & freight',                   'expense',   'freight',            'Operating expenses', null),
  ('6200', 'Payment gateway fees',                 'expense',   'gateway_fees',       'Operating expenses', null),
  ('6300', 'Rent',                                 'expense',   'rent',               'Operating expenses', null),
  ('6400', 'Salaries & wages',                     'expense',   'salaries',           'Operating expenses', null),
  ('6500', 'Utilities',                            'expense',   'utilities',          'Operating expenses', null),
  ('6600', 'Marketing',                            'expense',   'marketing',          'Operating expenses', null),
  ('6700', 'Production overheads (actual)',        'expense',   'production_overheads','Cost of sales', 'Gas, power, kitchen labour. Nets against overheads absorbed into batch costs'),
  ('6800', 'Professional fees',                    'expense',   'professional_fees',  'Operating expenses', null),
  ('6900', 'Other expenses',                       'expense',   'other_expenses',     'Operating expenses', null),
  ('7100', 'Rounding off',                         'expense',   'round_off',          'Operating expenses', null);

create or replace function acct(p_key text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from accounts where system_key = p_key or code = p_key;
  if v is null then raise exception 'Unknown account %', p_key; end if;
  return v;
end; $$;

-- ---------------------------------------------------------------------
-- Journals
-- ---------------------------------------------------------------------
create table journal_entries (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,           -- JV/26-27/000001
  entry_date        date not null,
  source_type       text,                           -- 'invoice','payment','stock_txn','manual' …
  source_id         uuid,
  purpose           text not null default 'main',
  narration         text not null,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  unique (source_type, source_id, purpose)
);
create index journal_entries_date on journal_entries (entry_date);

create table journal_lines (
  id          bigint generated always as identity primary key,
  entry_id    uuid not null references journal_entries(id),
  account_id  uuid not null references accounts(id),
  debit       numeric(14,2) not null default 0 check (debit >= 0),
  credit      numeric(14,2) not null default 0 check (credit >= 0),
  brand_id    uuid references brands(id),
  channel_id  uuid references sales_channels(id),
  customer_id uuid references customers(id),
  partner_id  uuid references business_partners(id),
  memo        text,
  check ((debit = 0) <> (credit = 0))
);
create index journal_lines_entry on journal_lines (entry_id);
create index journal_lines_account on journal_lines (account_id);

create trigger immutable before update or delete on journal_entries for each row execute function trg_immutable();
create trigger immutable before update or delete on journal_lines for each row execute function trg_immutable();

-- Every entry balances (checked at commit, after all its lines exist)
create or replace function trg_journal_balanced()
returns trigger language plpgsql as $$
declare v_dr numeric; v_cr numeric; v_n int;
begin
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) into v_dr, v_cr, v_n
    from journal_lines where entry_id = new.id;
  if v_n < 2 or v_dr <> v_cr then
    raise exception 'Journal % does not balance (debits %, credits %, % lines)', new.code, v_dr, v_cr, v_n;
  end if;
  return null;
end; $$;
create constraint trigger balanced after insert on journal_entries
  deferrable initially deferred for each row execute function trg_journal_balanced();

-- Month locks: nothing can be posted into a locked month
create table accounting_periods (
  period_start date primary key check (extract(day from period_start) = 1),
  locked       boolean not null default false,
  locked_by    uuid,
  locked_at    timestamptz
);

create table accounting_exceptions (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,       -- 'posting_failed','uncosted_stock','invoice_failed' …
  ref_type    text,
  ref_id      uuid,
  message     text not null,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);
create index accounting_exceptions_open on accounting_exceptions (created_at) where resolved_at is null;

create or replace function log_accounting_exception(p_kind text, p_ref_type text, p_ref_id uuid, p_message text)
returns void language sql security definer set search_path = public as $$
  insert into accounting_exceptions (kind, ref_type, ref_id, message)
  select p_kind, p_ref_type, p_ref_id, p_message
   where not exists (select 1 from accounting_exceptions
                      where kind = p_kind and ref_id is not distinct from p_ref_id and resolved_at is null
                        and message = p_message)
$$;

-- ---------------------------------------------------------------------
-- post_journal: the only way entries are written.
-- p_lines: [{account: system_key|code, debit?, credit?, amount? (+ = debit, - = credit),
--            brand_id?, channel_id?, customer_id?, partner_id?, memo?}]
-- Idempotent on (source_type, source_id, purpose). Zero lines are dropped;
-- an entry with nothing left is not created (returns null).
-- ---------------------------------------------------------------------
create or replace function post_journal(p_date date, p_source_type text, p_source_id uuid, p_purpose text,
                                        p_narration text, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; l jsonb; v_dr numeric; v_cr numeric; v_amt numeric; v_tdr numeric := 0; v_tcr numeric := 0; v_n int := 0;
  v_purpose text := coalesce(p_purpose, 'main');
begin
  if p_source_type is not null and p_source_id is not null then
    select id into v_id from journal_entries
     where source_type = p_source_type and source_id = p_source_id and purpose = v_purpose;
    if v_id is not null then return v_id; end if;
  end if;
  if exists (select 1 from accounting_periods where period_start = date_trunc('month', p_date)::date and locked) then
    raise exception 'The books for % are locked', to_char(p_date, 'Mon YYYY');
  end if;

  -- totals first (skip empty entries)
  for l in select * from jsonb_array_elements(p_lines) loop
    v_amt := round(coalesce((l->>'debit')::numeric, 0) - coalesce((l->>'credit')::numeric, 0) + coalesce((l->>'amount')::numeric, 0), 2);
    if v_amt > 0 then v_tdr := v_tdr + v_amt; elsif v_amt < 0 then v_tcr := v_tcr - v_amt; end if;
    if v_amt <> 0 then v_n := v_n + 1; end if;
  end loop;
  if v_n = 0 then return null; end if;
  if v_tdr <> v_tcr then
    raise exception 'Journal does not balance: debits % vs credits % (%)', v_tdr, v_tcr, p_narration;
  end if;

  insert into journal_entries (code, entry_date, source_type, source_id, purpose, narration, created_by)
  values (next_fy_code('JV', p_date), p_date, p_source_type, p_source_id, v_purpose, p_narration, auth.uid())
  returning id into v_id;

  for l in select * from jsonb_array_elements(p_lines) loop
    v_amt := round(coalesce((l->>'debit')::numeric, 0) - coalesce((l->>'credit')::numeric, 0) + coalesce((l->>'amount')::numeric, 0), 2);
    continue when v_amt = 0;
    v_dr := greatest(v_amt, 0); v_cr := greatest(-v_amt, 0);
    insert into journal_lines (entry_id, account_id, debit, credit, brand_id, channel_id, customer_id, partner_id, memo)
    values (v_id, acct(l->>'account'), v_dr, v_cr, nullif(l->>'brand_id', '')::uuid, nullif(l->>'channel_id', '')::uuid,
            nullif(l->>'customer_id', '')::uuid, nullif(l->>'partner_id', '')::uuid, l->>'memo');
  end loop;
  return v_id;
end; $$;

-- Manual journal (opening balances, depreciation, accruals, reclassifications)
create or replace function post_manual_journal(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_key text := nullif(p->>'idempotency_key', '');
begin
  perform require_role('accountant', 'manager');
  if coalesce(trim(p->>'narration'), '') = '' then raise exception 'Add a narration explaining the entry'; end if;
  if v_key is not null then
    select id into v_id from journal_entries where source_type = 'manual' and purpose = v_key;
    if v_id is not null then return jsonb_build_object('entry_id', v_id, 'duplicate', true); end if;
  end if;
  v_id := post_journal(coalesce(nullif(p->>'entry_date', '')::date, today_ist()), 'manual',
                       case when v_key is null then null else gen_random_uuid() end,
                       coalesce(v_key, 'main'), p->>'narration', p->'lines');
  if v_id is null then raise exception 'Enter at least one debit and one credit'; end if;
  return jsonb_build_object('entry_id', v_id, 'code', (select code from journal_entries where id = v_id));
end; $$;

-- Reversal (the only way to "undo" a journal)
create or replace function reverse_journal(p_entry_id uuid, p_reason text, p_date date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e journal_entries%rowtype; v_id uuid; v_lines jsonb;
begin
  perform require_role('accountant', 'manager');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into e from journal_entries where id = p_entry_id;
  if e.id is null then raise exception 'Journal not found'; end if;
  if e.source_type = 'reversal' then raise exception 'A reversal cannot itself be reversed; post a new entry'; end if;
  if journal_is_reversed(p_entry_id) then raise exception 'Already reversed'; end if;
  select jsonb_agg(jsonb_build_object('account', a.code, 'debit', jl.credit, 'credit', jl.debit,
           'brand_id', jl.brand_id, 'channel_id', jl.channel_id, 'customer_id', jl.customer_id, 'partner_id', jl.partner_id,
           'memo', jl.memo))
    into v_lines from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = p_entry_id;
  v_id := post_journal(coalesce(p_date, today_ist()), 'reversal', p_entry_id, 'main', 'Reversal of ' || e.code || ': ' || p_reason, v_lines);
  return jsonb_build_object('entry_id', v_id, 'code', (select code from journal_entries where id = v_id));
end; $$;

-- A reversal is a journal whose source is the original entry
create or replace function journal_is_reversed(p_entry uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from journal_entries where source_type = 'reversal' and source_id = p_entry)
$$;

create or replace function lock_period(p_month date, p_locked boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_start date := date_trunc('month', p_month)::date;
begin
  perform require_role('admin');
  insert into accounting_periods (period_start, locked, locked_by, locked_at)
  values (v_start, p_locked, auth.uid(), now())
  on conflict (period_start) do update set locked = p_locked, locked_by = auth.uid(), locked_at = now();
  return jsonb_build_object('period', v_start, 'locked', p_locked);
end; $$;

create or replace function resolve_accounting_exception(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform require_role('accountant', 'manager');
  update accounting_exceptions set resolved_at = now(), resolved_by = auth.uid() where id = p_id and resolved_at is null;
  return jsonb_build_object('ok', true);
end; $$;

-- Dimension helpers used by automatic postings
create or replace function sku_brand(p_sku uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select p.brand_id from skus s join products p on p.id = s.product_id where s.id = p_sku
$$;
