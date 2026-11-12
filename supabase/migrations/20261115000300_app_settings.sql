-- =====================================================================
-- Business-wide app settings. First one: testing mode — while it is on,
-- every scan box has "Scan override" and every order has a scan bypass,
-- so all the workflows can be tried without labels or scanners.
-- On by default while the business is setting up; an admin turns it off
-- before go-live. The dashboard reminds managers while it is on.
-- =====================================================================
create table app_settings (
  key        text primary key check (key in ('testing_mode')),
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table app_settings enable row level security;
create trigger audit after insert or update or delete on app_settings for each row execute function trg_audit();
insert into app_settings (key, value) values ('testing_mode', 'true'::jsonb);

create or replace function get_app_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return coalesce((select jsonb_object_agg(key, value) from app_settings), '{}'::jsonb);
end; $$;

create or replace function set_app_setting(p_key text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := require_role('admin');
begin
  if p_key = 'testing_mode' and jsonb_typeof(p_value) <> 'boolean' then raise exception 'testing_mode is on or off'; end if;
  insert into app_settings (key, value, updated_at, updated_by) values (p_key, p_value, now(), v_uid)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = v_uid;
  return get_app_settings();
end; $$;

-- Dashboard: remind managers while testing mode is on
create or replace function get_dashboard(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d jsonb := get_dashboard_core(p_days); v_extra jsonb := '[]'::jsonb; v_counts int; v_loc uuid := default_location_id();
begin
  if coalesce((select value = 'true'::jsonb from app_settings where key = 'testing_mode'), false) then
    v_extra := v_extra || jsonb_build_object('severity', 'medium', 'type', 'testing_mode',
      'title', 'Testing mode is on', 'detail', 'Every scan screen has Scan override and every order has a scan bypass. An admin turns it off before go-live (More → Testing tools).', 'ref', null);
  end if;
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

revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on function storefront_catalogue(), storefront_order_status(text, text) to anon, authenticated, service_role;
grant execute on function storefront_notify_me(text, text, boolean, text) to anon, authenticated, service_role;
grant execute on function get_app_settings(), set_app_setting(text, jsonb), get_dashboard(int) to authenticated;
