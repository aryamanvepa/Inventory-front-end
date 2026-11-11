// Supabase Edge Function: receives website order webhooks and records them
// in the database through ingest_order / ingest_payment.
//
//   POST /functions/v1/order-webhook?source=woocommerce   (WooCommerce webhook)
//   POST /functions/v1/order-webhook?source=<name>        (generic signed JSON)
//
// Secrets (supabase secrets set …):
//   WOO_WEBHOOK_SECRET   – the "Secret" entered on the WooCommerce webhook
//   TL_WEBHOOK_SECRET    – HMAC secret for the generic format (header x-tl-signature, base64 HMAC-SHA256 of the body)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
//
// Deploy with JWT verification off (the HMAC signature is the authentication):
//   supabase functions deploy order-webhook --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';
import { fromGeneric, fromWooCommerce, safeEqual, type Action } from './map.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const source = new URL(req.url).searchParams.get('source') ?? 'generic';
  if (!/^[a-z0-9_-]{2,40}$/.test(source)) return json(400, { error: 'bad source' });
  const raw = await req.text();

  let actions: Action[];
  if (source === 'woocommerce') {
    // WooCommerce sends a ping with form data when the webhook is first saved.
    if (!raw.trim().startsWith('{')) return json(200, { ok: true, ping: true });
    const secret = Deno.env.get('WOO_WEBHOOK_SECRET');
    const given = req.headers.get('x-wc-webhook-signature') ?? '';
    if (!secret || !safeEqual(await hmacBase64(secret, raw), given)) return json(401, { error: 'bad signature' });
    actions = fromWooCommerce(JSON.parse(raw), req.headers.get('x-wc-webhook-topic') ?? 'order.created');
  } else {
    const secret = Deno.env.get('TL_WEBHOOK_SECRET');
    const given = req.headers.get('x-tl-signature') ?? '';
    if (!secret || !safeEqual(await hmacBase64(secret, raw), given)) return json(401, { error: 'bad signature' });
    actions = fromGeneric(JSON.parse(raw));
  }

  const results: unknown[] = [];
  for (const a of actions) {
    if (a.kind === 'ignore') { results.push({ ignored: a.reason }); continue; }
    const { data, error } = a.kind === 'order'
      ? await db.rpc('ingest_order', { p_source: source, p_event_id: a.eventId, p_payload: a.order })
      : await db.rpc('ingest_payment', { p_source: source, p_event_id: a.eventId, p_external_order_id: a.externalOrderId, p_payment: a.payment });
    // A database/network error -> 500 so the storefront retries (safe: ingest is idempotent).
    if (error) return json(500, { error: error.message });
    results.push(data);
  }
  // Business-rule failures (e.g. unknown SKU) are logged in integration_events and shown
  // to the founder as alerts; we still answer 200 so the storefront doesn't retry forever.
  return json(200, { ok: true, results });
});
