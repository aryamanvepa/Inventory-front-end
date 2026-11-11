-- =====================================================================
-- Migration 0004 — Orders, reservations, payments, packing scans,
-- shipments and the integration event log.
-- =====================================================================

create table orders (
  id                uuid primary key default gen_random_uuid(),
  code              text unique,                      -- ORD-2026-000001 (consumer) / SO-2026-000001 (B2B)
  kind              order_kind not null default 'consumer',
  legal_entity_id   uuid not null references legal_entities(id),
  channel_id        uuid not null references sales_channels(id),
  customer_id       uuid references customers(id),
  partner_id        uuid references business_partners(id),
  fulfilment_location_id uuid not null references locations(id),
  status            order_status not null default 'pending_payment',
  payment_status    payment_status not null default 'unpaid',
  stock_shortfall   boolean not null default false,  -- could not reserve all lines
  ship_to           jsonb not null default '{}'::jsonb,
  subtotal          numeric(12,2) not null default 0,
  discount_amount   numeric(12,2) not null default 0,
  shipping_amount   numeric(12,2) not null default 0,
  tax_amount        numeric(12,2) not null default 0,
  total_amount      numeric(12,2) not null default 0,
  external_total    numeric(12,2),                   -- total as charged by the storefront (cross-check)
  external_source   text,
  external_order_id text,
  notes             text,
  cancel_reason     text,
  placed_at         timestamptz not null default now(),
  packed_at         timestamptz,
  dispatched_at     timestamptz,
  delivered_at      timestamptz,
  cancelled_at      timestamptz,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  unique (external_source, external_order_id),
  check (customer_id is not null or partner_id is not null)
);

create or replace function trg_assign_order_code()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.code is null then
    new.code := next_code(case when new.kind = 'b2b' then 'SO' else 'ORD' end, true);
  end if;
  return new;
end; $$;
create trigger assign_code before insert on orders for each row execute function trg_assign_order_code();
create trigger audit after insert or update or delete on orders for each row execute function trg_audit();
create trigger no_delete before delete on orders for each row execute function trg_no_delete();
create index orders_status on orders (status);
create index orders_placed_at on orders (placed_at);

create table order_lines (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id),
  line_no       int not null,
  sku_id        uuid not null references skus(id),
  qty           numeric(14,3) not null check (qty > 0),
  unit_price    numeric(12,2) not null check (unit_price >= 0),  -- tax-inclusive price charged
  discount_amount numeric(12,2) not null default 0,
  tax_rate      numeric(5,2) not null default 0,
  tax_amount    numeric(12,2) not null default 0,
  line_total    numeric(12,2) not null,
  price_list_id uuid references price_lists(id),
  unique (order_id, line_no)
);
create trigger no_delete before delete on order_lines for each row execute function trg_no_delete();

-- Reservations: SKU-level holds against available-to-promise stock.
create table stock_reservations (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id),
  order_line_id uuid not null references order_lines(id),
  sku_id        uuid not null references skus(id),
  location_id   uuid not null references locations(id),
  qty           numeric(14,3) not null check (qty > 0),
  status        text not null default 'active' check (status in ('active', 'consumed', 'released')),
  created_at    timestamptz not null default now(),
  closed_at     timestamptz
);
create index stock_reservations_active on stock_reservations (sku_id, location_id) where status = 'active';
create trigger no_delete before delete on stock_reservations for each row execute function trg_no_delete();

-- Payments and refunds (append-only)
create table payments (
  id            uuid primary key default gen_random_uuid(),
  code          text unique,                    -- PAY-2026-000001
  order_id      uuid not null references orders(id),
  kind          payment_kind not null,
  amount        numeric(12,2) not null check (amount > 0),
  method        text,                           -- upi, card, cod, bank_transfer, gateway …
  gateway       text,
  gateway_ref   text,
  idempotency_key text unique,
  notes         text,
  received_at   timestamptz not null default now(),
  created_by    uuid,
  unique (gateway, gateway_ref, kind)
);
create trigger assign_code before insert on payments for each row execute function trg_assign_code('PAY', 'yearly');
create trigger immutable before update or delete on payments for each row execute function trg_immutable();

-- Every scan during packing, accepted or rejected (append-only).
-- Accepted scans carry qty > 0; an "undo" posts a reversing row (qty < 0).
create table pack_scans (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id),
  order_line_id   uuid references order_lines(id),
  sku_id          uuid references skus(id),
  batch_id        uuid references batches(id),
  scanned_code    text not null,
  result          scan_result not null,
  qty             numeric(14,3) not null default 0,
  manual_batch    boolean not null default false,  -- batch picked from list rather than scanned
  reverses_scan_id uuid references pack_scans(id),
  message         text,
  idempotency_key text unique,
  scanned_by      uuid,
  scanned_at      timestamptz not null default now()
);
create index pack_scans_order on pack_scans (order_id);
create trigger immutable before update or delete on pack_scans for each row execute function trg_immutable();

create table shipments (
  id            uuid primary key default gen_random_uuid(),
  code          text unique,                    -- SHP-2026-000001
  order_id      uuid not null references orders(id),
  provider_id   uuid not null references delivery_providers(id),
  booking_ref   text,
  tracking_url  text,
  freight_cost  numeric(12,2),
  status        shipment_status not null default 'dispatched',
  failure_reason text,
  dispatched_at timestamptz not null default now(),
  delivered_at  timestamptz,
  dispatched_by uuid,
  idempotency_key text unique
);
create trigger assign_code before insert on shipments for each row execute function trg_assign_code('SHP', 'yearly');
create trigger audit after insert or update or delete on shipments for each row execute function trg_audit();
create trigger no_delete before delete on shipments for each row execute function trg_no_delete();

-- Inbound integration events (website webhooks etc.).
-- (source, event_id) is unique: a retried webhook is recognised and
-- never creates a second order or a second stock movement.
create table integration_events (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,
  event_id     text not null,
  event_type   text not null,
  payload      jsonb not null,
  status       integration_status not null default 'received',
  attempts     int not null default 1,
  error        text,
  order_id     uuid references orders(id),
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  unique (source, event_id)
);
