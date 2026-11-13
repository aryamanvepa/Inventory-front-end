// Supabase Edge Function: the storefront's only write path.
//
//   POST /functions/v1/storefront-order  {"action":"quote", "lines":[{sku_code, qty}], pincode?, promo_code?, test?}
//        → current prices, delivery charge, promo discount and total, PIN-code delivery estimate,
//          plus any lines that are short of stock
//   POST /functions/v1/storefront-order  {"action":"place", idempotency_key, lines, customer, address,
//                                          notes, expected_total, promo_code?, test?, website (honeypot, must be empty)}
//        → { ok, order_code, status, stock_reserved, total, test? } or { ok:false, error, … }
//   test:true is accepted only while the business-wide testing mode is on (orders are marked WEB-TEST).
//   Failures are logged to integration_events (source storefront-error) for the ops dashboard.
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
  FREE_SHIPPING_ABOVE, PAYMENT_MODE, SHIPPING_FLAT,
  decidePlace, totalsFor, validateLines, validatePlaceRequest, type Quote,
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

async function quote(lines: unknown, eventId: string | null, phone: string | null,
  pincode: string | null = null, promo: string | null = null, test = false): Promise<Quote> {
  const { data, error } = await db.rpc('storefront_quote', {
    p_lines: lines, p_event_id: eventId, p_phone: phone, p_pincode: pincode, p_promo_code: promo, p_test: test,
  });
  if (error) throw new Error(error.message);
  return data as Quote;
}

// Never let logging break checkout.
async function logFailure(key: string | null, stage: string, error: unknown, detail: Record<string, unknown> = {}) {
  try {
    await db.rpc('storefront_log_failure', { p_key: key ?? 'no-key', p_stage: stage,
      p_error: error instanceof Error ? error.message : String(error), p_detail: detail });
  } catch (e) { console.error('could not log failure', e); }
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

  let key: string | null = typeof body?.idempotency_key === 'string' ? body.idempotency_key : null;
  try {
    // ---------------------------------------------------------------- quote
    if (body?.action === 'quote') {
      const lines = validateLines(body.lines);
      if (!lines.ok) return json(400, { ok: false, error: 'invalid', fields: lines.errors });
      const pin = typeof body.pincode === 'string' ? body.pincode.replace(/\s/g, '').slice(0, 6) : null;
      const promo = typeof body.promo_code === 'string' && body.promo_code.trim() ? body.promo_code.trim().toUpperCase().slice(0, 20) : null;
      const test = body.test === true;
      const q = await quote(lines.value, null, null, pin, promo, test);
      if (test && !q.testing_mode) return json(403, { ok: false, error: 'test_mode_off' });
      return json(200, { ok: true, lines: q.lines, problems: q.problems, ...totalsFor(q),
        promo: q.promo ?? null, delivery: q.delivery ?? null, test,
        shipping_rule: SHIPPING_RULE, payment_mode: PAYMENT_MODE });
    }

    // ---------------------------------------------------------------- place
    if (body?.action !== 'place') return json(400, { ok: false, error: 'unknown_action' });
    const v = validatePlaceRequest(body);
    if (!v.ok) return json(400, { ok: false, error: 'invalid', fields: v.errors });
    const order = v.value;
    key = order.idempotency_key;

    const q = await quote(order.lines, order.idempotency_key, order.customer.phone, order.address.pincode, order.promo_code, order.test);
    const d = decidePlace(order, q);
    if (d.kind === 'reject') return json(d.http, d.body);

    // One atomic step: an order that can't hold its stock is undone and reported as sold out.
    const { data, error } = await db.rpc('storefront_place_order', {
      p_source: d.source, p_event_id: order.idempotency_key, p_payload: d.payload, p_require_stock: !order.test,
    });
    if (error) throw new Error(error.message);
    if (data?.error === 'sold_out') return json(409, { ok: false, error: 'sold_out', problems: data.problems ?? [] });
    if (!data?.ok) {
      console.error('ingest_order failed', data);
      await logFailure(key, 'ingest_order', data?.error ?? 'not accepted', { source: d.source });
      return json(422, { ok: false, error: 'not_accepted', message: 'We could not place this order. Please try again or contact us.' });
    }

    if (data.duplicate) {
      const { data: s } = await db.rpc('storefront_order_status', { p_order_code: data.order_code, p_phone: order.customer.phone });
      return json(200, { ok: true, duplicate: true, order_code: data.order_code, status: s?.status ?? null, ...(order.test ? { test: true } : {}) });
    }
    if (d.redeemPromo) {
      const { error: pe } = await db.rpc('storefront_redeem_promo', { p_code: d.redeemPromo });
      if (pe) await logFailure(key, 'redeem_promo', pe.message, { promo: d.redeemPromo, order: data.order_code });
    }
    return json(200, {
      ok: true, duplicate: false, order_code: data.order_code, status: data.status,
      stock_reserved: data.stock_reserved, total: Number(data.total_amount), payment_mode: PAYMENT_MODE,
      ...(order.test ? { test: true } : {}),
    });
  } catch (e) {
    console.error(e);
    await logFailure(key, body?.action ?? 'unknown', e);
    // Safe for the browser to retry with the same idempotency_key.
    return json(500, { ok: false, error: 'server', message: 'Something went wrong on our side. Please try again.' });
  }
});
