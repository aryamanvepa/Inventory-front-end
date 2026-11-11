// Supabase Edge Function: the storefront's only write path.
//
//   POST /functions/v1/storefront-order  {"action":"quote", "lines":[{sku_code, qty}]}
//        → current prices, delivery charge and total, plus any lines that are short of stock
//   POST /functions/v1/storefront-order  {"action":"place", idempotency_key, lines, customer, address,
//                                          notes, expected_total, website (honeypot, must be empty)}
//        → { ok, order_code, status, stock_reserved, total } or { ok:false, error, … }
//
// Prices, stock and order codes come from the database (storefront_quote / ingest_order);
// this function only validates, applies the shipping rule and forwards with the service role.
// A retried "place" with the same idempotency_key returns the same order (never a duplicate).
//
// Deploy (shoppers aren't signed in, so JWT verification is off; CORS limits browsers to our origins):
//   npx supabase@2 functions deploy storefront-order --no-verify-jwt
// Optional secret: STOREFRONT_ORIGINS="https://aryamanvepa.github.io,http://localhost:5173"
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  FREE_SHIPPING_ABOVE, MAX_ORDERS_PER_PHONE_PER_DAY, PAYMENT_MODE, SHIPPING_FLAT,
  buildIngestPayload, totalsFor, validateLines, validatePlaceRequest, type Quote,
} from './logic.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const ORIGINS = (Deno.env.get('STOREFRONT_ORIGINS') ??
  'https://aryamanvepa.github.io,http://localhost:5173,http://localhost:4173')
  .split(',').map((s) => s.trim()).filter(Boolean);

const SHIPPING_RULE = { flat: SHIPPING_FLAT, free_above: FREE_SHIPPING_ABOVE };

function cors(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' };
  if (origin && ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'content-type, apikey, authorization, x-client-info';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

async function quote(lines: unknown, eventId: string | null, phone: string | null): Promise<Quote> {
  const { data, error } = await db.rpc('storefront_quote', { p_lines: lines, p_event_id: eventId, p_phone: phone });
  if (error) throw new Error(error.message);
  return data as Quote;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const headers = cors(origin);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response(null, { status: origin && ORIGINS.includes(origin) ? 204 : 403, headers });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  // Browsers always send Origin on cross-site POSTs; refuse other websites.
  if (origin && !ORIGINS.includes(origin)) return json(403, { ok: false, error: 'origin_not_allowed' });

  const raw = await req.text();
  if (raw.length > 10_000) return json(413, { ok: false, error: 'too_large' });
  let body: any;
  try { body = JSON.parse(raw); } catch { return json(400, { ok: false, error: 'invalid_json' }); }

  try {
    // ---------------------------------------------------------------- quote
    if (body?.action === 'quote') {
      const lines = validateLines(body.lines);
      if (!lines.ok) return json(400, { ok: false, error: 'invalid', fields: lines.errors });
      const q = await quote(lines.value, null, null);
      return json(200, { ok: true, lines: q.lines, problems: q.problems, ...totalsFor(q),
        shipping_rule: SHIPPING_RULE, payment_mode: PAYMENT_MODE });
    }

    // ---------------------------------------------------------------- place
    if (body?.action !== 'place') return json(400, { ok: false, error: 'unknown_action' });
    const v = validatePlaceRequest(body);
    if (!v.ok) return json(400, { ok: false, error: 'invalid', fields: v.errors });
    const order = v.value;

    const q = await quote(order.lines, order.idempotency_key, order.customer.phone);
    if (!q.already_placed) {
      if (q.problems.length) return json(409, { ok: false, error: 'sold_out', problems: q.problems });
      if (q.recent_orders_for_phone >= MAX_ORDERS_PER_PHONE_PER_DAY) {
        return json(429, { ok: false, error: 'too_many_orders' });
      }
      const t = totalsFor(q);
      // The shopper must have seen the price we are about to charge.
      if (Math.abs(t.total - order.expected_total) > 0.005) {
        return json(409, { ok: false, error: 'price_changed', lines: q.lines, ...t, shipping_rule: SHIPPING_RULE });
      }
    }

    // already_placed: ingest_order recognises the event id and returns the existing order untouched.
    const payload = buildIngestPayload(order, q.already_placed ? { subtotal: 0 } : q);
    const { data, error } = await db.rpc('ingest_order', {
      p_source: 'storefront', p_event_id: order.idempotency_key, p_payload: payload,
    });
    if (error) throw new Error(error.message);
    if (!data?.ok) {
      console.error('ingest_order failed', data);
      return json(422, { ok: false, error: 'not_accepted', message: 'We could not place this order. Please try again or contact us.' });
    }

    if (data.duplicate) {
      const { data: s } = await db.rpc('storefront_order_status', { p_order_code: data.order_code, p_phone: order.customer.phone });
      return json(200, { ok: true, duplicate: true, order_code: data.order_code, status: s?.status ?? null });
    }
    return json(200, {
      ok: true, duplicate: false, order_code: data.order_code, status: data.status,
      stock_reserved: data.stock_reserved, total: Number(data.total_amount), payment_mode: PAYMENT_MODE,
    });
  } catch (e) {
    console.error(e);
    // Safe for the browser to retry with the same idempotency_key.
    return json(500, { ok: false, error: 'server', message: 'Something went wrong on our side. Please try again.' });
  }
});
