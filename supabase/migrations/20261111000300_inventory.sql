-- =====================================================================
-- Migration 0003 — Batches and the inventory ledger
--
-- Every stock balance is identified by:
--   SKU · batch · physical location · owner · stock status · quantity
--
-- Stock is never edited directly. Each receipt, transfer, ownership
-- change, packing, sale, return or adjustment posts a stock transaction
-- with signed movement lines. Balances are maintained from those lines
-- and can never go negative.
--
-- Physical movement and ownership movement are separate:
--   consignment dispatch  -> location changes, owner unchanged
--   outright sale         -> location and owner both change
-- =====================================================================

create table batches (
  id                 uuid primary key default gen_random_uuid(),
  code               text unique,                    -- BAT-2026-000001
  sku_id             uuid not null references skus(id),
  manufacturer_partner_id uuid references business_partners(id),  -- null = own facility
  external_lot_no    text,                           -- contract manufacturer's own lot number
  manufactured_on    date not null,
  packed_on          date,
  expires_on         date not null,
  quantity_produced  numeric(14,3),
  unit_cost          numeric(12,4),                  -- for margin / COGS later
  qa_status          qa_status not null default 'released',
  qa_notes           text,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  check (expires_on >= manufactured_on)
);
create trigger assign_code before insert on batches
  for each row execute function trg_assign_code('BAT', 'yearly');
create trigger audit after insert or update or delete on batches for each row execute function trg_audit();
create trigger no_delete before delete on batches for each row execute function trg_no_delete();

-- Stock transaction header (one business event)
create table stock_transactions (
  id                uuid primary key default gen_random_uuid(),
  code              text unique,                     -- GRN-/TRF-/ADJ-/MOV-2026-000001
  txn_type          stock_txn_type not null,
  changes_location  boolean not null default false,
  changes_ownership boolean not null default false,
  reason            text,
  reference_type    text,                            -- 'order', 'shipment', 'production' …
  reference_id      uuid,
  idempotency_key   text unique,
  created_by        uuid,
  created_at        timestamptz not null default now()
);

create or replace function trg_assign_stock_txn_code()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.code is null then
    new.code := next_code(case new.txn_type
      when 'goods_receipt' then 'GRN' when 'production_receipt' then 'PRN'
      when 'transfer' then 'TRF' when 'ownership_transfer' then 'TRF'
      when 'adjustment' then 'ADJ' when 'return_receipt' then 'RET'
      else 'MOV' end, true);
  end if;
  return new;
end; $$;
create trigger assign_code before insert on stock_transactions
  for each row execute function trg_assign_stock_txn_code();

-- Movement lines (the ledger). Append-only.
create table stock_movements (
  id             bigint generated always as identity primary key,
  transaction_id uuid not null references stock_transactions(id),
  sku_id         uuid not null references skus(id),
  batch_id       uuid references batches(id),
  location_id    uuid not null references locations(id),
  owner_id       uuid not null references stock_owners(id),
  status         stock_status not null,
  qty            numeric(14,3) not null check (qty <> 0),
  created_at     timestamptz not null default now()
);
create index stock_movements_sku on stock_movements (sku_id, location_id);
create index stock_movements_txn on stock_movements (transaction_id);

-- Current balances, maintained by trigger from the ledger.
create table stock_balances (
  sku_id      uuid not null references skus(id),
  batch_id    uuid references batches(id),
  location_id uuid not null references locations(id),
  owner_id    uuid not null references stock_owners(id),
  status      stock_status not null,
  qty         numeric(14,3) not null default 0,
  updated_at  timestamptz not null default now(),
  constraint stock_cannot_go_negative check (qty >= 0)
);
create unique index stock_balances_key on stock_balances
  (sku_id, coalesce(batch_id, '00000000-0000-0000-0000-000000000000'::uuid), location_id, owner_id, status);

create or replace function trg_apply_movement()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update stock_balances
     set qty = qty + new.qty, updated_at = now()
   where sku_id = new.sku_id
     and batch_id is not distinct from new.batch_id
     and location_id = new.location_id
     and owner_id = new.owner_id
     and status = new.status;
  if not found then
    if new.qty < 0 then
      raise exception 'Insufficient stock: no % stock of this SKU/batch at this location', new.status
        using errcode = '23514';
    end if;
    insert into stock_balances (sku_id, batch_id, location_id, owner_id, status, qty)
    values (new.sku_id, new.batch_id, new.location_id, new.owner_id, new.status, new.qty);
  end if;
  return new;
exception
  when check_violation then
    raise exception 'Insufficient stock: this would take % stock below zero', new.status
      using errcode = '23514';
end; $$;
create trigger apply_movement after insert on stock_movements
  for each row execute function trg_apply_movement();

-- Ledger rows are permanent
create trigger immutable before update or delete on stock_movements
  for each row execute function trg_immutable();
create trigger immutable before update or delete on stock_transactions
  for each row execute function trg_immutable();

-- Balances may only change through the ledger trigger
create or replace function trg_balances_guard()
returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() < 2 then
    raise exception 'Stock balances are calculated from stock movements and cannot be edited directly'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end; $$;
create trigger guard before insert or update or delete on stock_balances
  for each row execute function trg_balances_guard();

-- ---------------------------------------------------------------------
-- Internal helper: post a stock transaction with movement lines.
-- p_lines: [{sku_id, batch_id, location_id, owner_id, status, qty}, …]
-- Idempotent on p_idempotency_key: a retried request returns the
-- original transaction and posts nothing.
-- ---------------------------------------------------------------------
create or replace function post_stock_txn(
  p_type stock_txn_type,
  p_lines jsonb,
  p_reason text default null,
  p_reference_type text default null,
  p_reference_id uuid default null,
  p_idempotency_key text default null,
  p_changes_location boolean default false,
  p_changes_ownership boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_txn uuid;
  l jsonb;
begin
  if p_idempotency_key is not null then
    select id into v_txn from stock_transactions where idempotency_key = p_idempotency_key;
    if v_txn is not null then return v_txn; end if;
  end if;

  insert into stock_transactions (txn_type, reason, reference_type, reference_id, idempotency_key,
                                  changes_location, changes_ownership, created_by)
  values (p_type, p_reason, p_reference_type, p_reference_id, p_idempotency_key,
          p_changes_location, p_changes_ownership, auth.uid())
  returning id into v_txn;

  for l in select * from jsonb_array_elements(p_lines) loop
    insert into stock_movements (transaction_id, sku_id, batch_id, location_id, owner_id, status, qty)
    values (v_txn, (l->>'sku_id')::uuid, nullif(l->>'batch_id', '')::uuid, (l->>'location_id')::uuid,
            (l->>'owner_id')::uuid, (l->>'status')::stock_status, (l->>'qty')::numeric);
  end loop;
  return v_txn;
end; $$;
revoke all on function post_stock_txn(stock_txn_type, jsonb, text, text, uuid, text, boolean, boolean) from public;

-- Serialises stock decisions for one SKU at one location
-- (prevents two orders taking the last unit).
create or replace function lock_sku_location(p_sku uuid, p_location uuid)
returns void language sql as $$
  select pg_advisory_xact_lock(hashtext(p_sku::text || ':' || p_location::text)::bigint)
$$;
