-- =====================================================================
-- "Notify me when available" (back-in-stock alerts)
--   * the website (publishable key) can only ADD a request, with consent;
--     it can never read the list back
--   * managers see who is waiting per product, mark them notified, and
--     erase an email on request
--   * the dashboard flags products that are back in stock with people waiting
-- Personal data: email (+ optional first name) and the consent time; used only
-- for this alert. Notified/cancelled requests are erased after 180 days.
-- Sending the emails is done by staff for now (no email service is connected).
-- =====================================================================
create table stock_alert_requests (
  id          uuid primary key default gen_random_uuid(),
  sku_id      uuid not null references skus(id),
  email       text not null check (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name        text check (name is null or length(name) <= 80),
  consent_at  timestamptz not null,
  source      text not null default 'website' check (source in ('website', 'staff')),
  status      text not null default 'waiting' check (status in ('waiting', 'notified', 'cancelled')),
  created_at  timestamptz not null default now(),
  notified_at timestamptz,
  notified_by uuid
);
create unique index stock_alerts_one_waiting on stock_alert_requests (sku_id, email) where status = 'waiting';
create index stock_alerts_waiting on stock_alert_requests (sku_id) where status = 'waiting';
create index stock_alerts_created on stock_alert_requests (created_at);
alter table stock_alert_requests enable row level security;

-- ---------------------------------------------------------------------
-- Website: add a request. Always answers the same way whether or not the
-- email was already on the list (so the list can't be probed).
-- ---------------------------------------------------------------------
create or replace function storefront_notify_me(p_sku_code text, p_email text, p_consent boolean, p_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name  text := nullif(left(trim(coalesce(p_name, '')), 80), '');
  v_sku   uuid;
begin
  if coalesce(p_consent, false) is not true then
    return jsonb_build_object('ok', false, 'error', 'consent_required');
  end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_email');
  end if;
  select s.id into v_sku from skus s join products p on p.id = s.product_id
   where upper(s.code) = upper(trim(coalesce(p_sku_code, ''))) and s.active and p.active and p.item_type = 'finished'
     and get_price(s.id, 'WEB') is not null;
  if v_sku is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_product');
  end if;
  -- abuse limits: the endpoint is public
  if (select count(*) from stock_alert_requests where email = v_email and status = 'waiting') >= 30
     or (select count(*) from stock_alert_requests where created_at > now() - interval '1 hour') >= 500 then
    return jsonb_build_object('ok', false, 'error', 'try_later');
  end if;
  insert into stock_alert_requests (sku_id, email, name, consent_at)
  values (v_sku, v_email, v_name, now())
  on conflict (sku_id, email) where status = 'waiting' do nothing;
  return jsonb_build_object('ok', true);
end; $$;

-- ---------------------------------------------------------------------
-- Staff (manager / admin): who is waiting, per product
-- ---------------------------------------------------------------------
create or replace function list_stock_alerts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_loc uuid := default_location_id();
begin
  perform require_role('manager');
  return (select coalesce(jsonb_agg(x order by (x->>'in_stock')::boolean desc, (x->>'waiting')::int desc, x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object('sku_id', s.id, 'code', s.code, 'name', s.name, 'brand', b.name,
      'waiting', count(*), 'free', atp_qty(s.id, v_loc), 'in_stock', atp_qty(s.id, v_loc) > 0,
      'oldest', min(r.created_at),
      'people', jsonb_agg(jsonb_build_object('id', r.id, 'email', r.email, 'name', r.name, 'since', r.created_at) order by r.created_at)) x
    from stock_alert_requests r join skus s on s.id = r.sku_id join products p on p.id = s.product_id
    left join brands b on b.id = p.brand_id
    where r.status = 'waiting'
    group by s.id, s.code, s.name, b.name) t);
end; $$;

-- After emailing them: mark everyone waiting for a product as notified
create or replace function mark_stock_alerts_notified(p_sku_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := require_role('manager'); v_n int;
begin
  update stock_alert_requests set status = 'notified', notified_at = now(), notified_by = v_uid
   where sku_id = p_sku_id and status = 'waiting';
  get diagnostics v_n = row_count;
  -- retention: erase handled requests after 180 days
  delete from stock_alert_requests where status <> 'waiting' and coalesce(notified_at, created_at) < now() - interval '180 days';
  return jsonb_build_object('notified', v_n);
end; $$;

-- Erase someone's email from every alert (unsubscribe / data-erasure request)
create or replace function erase_stock_alert_email(p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform require_role('manager');
  delete from stock_alert_requests where email = lower(trim(coalesce(p_email, '')));
  get diagnostics v_n = row_count;
  return jsonb_build_object('erased', v_n);
end; $$;

-- ---------------------------------------------------------------------
-- Dashboard: back in stock with people waiting
-- ---------------------------------------------------------------------
create or replace function get_dashboard(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d jsonb := get_dashboard_core(p_days); v_extra jsonb := '[]'::jsonb; v_counts int; v_loc uuid := default_location_id();
begin
  if (select state_code is null from legal_entities order by created_at limit 1) then
    v_extra := v_extra || jsonb_build_object('severity', 'high', 'type', 'company_gst',
      'title', 'Company GSTIN and state not set', 'detail', 'GST invoices can''t be issued until this is set (Accounts → Company)', 'ref', null);
  end if;
  v_extra := v_extra || coalesce((select jsonb_agg(jsonb_build_object('severity', 'medium', 'type', 'stock_alert',
      'title', x.name || ' is back in stock — ' || x.n || ' customer' || case when x.n = 1 then '' else 's' end || ' waiting',
      'detail', 'Email them, then mark them notified (More → Back-in-stock alerts)', 'ref', x.sku_id) order by x.n desc)
    from (select r.sku_id, s.name, count(*) n from stock_alert_requests r join skus s on s.id = r.sku_id
           where r.status = 'waiting' and atp_qty(r.sku_id, v_loc) > 0 group by r.sku_id, s.name) x), '[]'::jsonb);
  select count(*) into v_counts from stock_counts where status = 'pending';
  if v_counts > 0 then
    v_extra := v_extra || jsonb_build_object('severity', 'medium', 'type', 'stock_count',
      'title', v_counts || ' stock count' || case when v_counts = 1 then '' else 's' end || ' waiting for your OK',
      'detail', 'Staff counted a different number than the system shows (Stock → Counts to check)', 'ref', null);
  end if;
  v_extra := v_extra || coalesce((select jsonb_agg(jsonb_build_object('severity', case when kind in ('invoice_failed', 'posting_failed') then 'high' else 'medium' end,
      'type', 'accounting', 'title', case kind when 'invoice_failed' then 'Invoice not issued' when 'posting_failed' then 'Accounting entry failed'
                                               when 'uncosted_stock' then 'Stock without a cost' else 'Accounts check' end,
      'detail', message, 'ref', id) order by created_at desc)
    from (select * from accounting_exceptions where resolved_at is null order by created_at desc limit 20) e), '[]'::jsonb);
  return jsonb_set(d, '{alerts}', v_extra || (d->'alerts'));
end; $$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on function storefront_catalogue(), storefront_order_status(text, text) to anon;
grant execute on function storefront_notify_me(text, text, boolean, text) to anon, authenticated, service_role;
grant execute on function list_stock_alerts(), mark_stock_alerts_notified(uuid), erase_stock_alert_email(text), get_dashboard(int) to authenticated;
