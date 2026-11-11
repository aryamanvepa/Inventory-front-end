// Pure mapping from storefront payloads to Torte Living's canonical order.
// No Deno/Node APIs here, so it is unit-tested with Node (tests/webhook-mapper.test.mjs).

export interface CanonicalOrder {
  external_order_id: string;
  channel: string;
  placed_at?: string;
  customer: Record<string, unknown>;
  ship_to: Record<string, unknown>;
  lines: { sku_code?: string; gtin?: string; qty: number; unit_price?: number }[];
  shipping_amount: number;
  discount_amount: number;
  total_amount?: number;
  payment: { status: 'paid' | 'unpaid' | 'cod'; amount?: number; method?: string; gateway?: string; gateway_ref?: string };
  notes?: string;
}

export type Action =
  | { kind: 'order'; eventId: string; order: CanonicalOrder }
  | { kind: 'payment'; eventId: string; externalOrderId: string; payment: Record<string, unknown> }
  | { kind: 'ignore'; reason: string };

const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const join = (...p: unknown[]) => p.filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();

// WooCommerce REST v3 order (webhook topics order.created / order.updated).
// Product SKU in WooCommerce must equal the Torte Living SKU code (e.g. NS-000001).
export function fromWooCommerce(order: any, topic: string): Action[] {
  if (!order || typeof order !== 'object' || !order.id) return [{ kind: 'ignore', reason: 'not an order payload' }];
  const paidStatuses = ['processing', 'completed'];
  const isCod = order.payment_method === 'cod';
  const paid = paidStatuses.includes(order.status) && !isCod;
  const b = order.billing ?? {};
  const s = order.shipping ?? {};

  if (['cancelled', 'refunded', 'failed', 'trash', 'checkout-draft'].includes(order.status)) {
    return [{ kind: 'ignore', reason: `status ${order.status} needs a manager in the ops app` }];
  }
  const missingSku = (order.line_items ?? []).filter((l: any) => !l.sku);
  if (missingSku.length) {
    // Still sent through: the database rejects it and logs it for the reconciliation report.
  }

  const canonical: CanonicalOrder = {
    external_order_id: String(order.id),
    channel: 'WEB',
    placed_at: order.date_created_gmt ? `${order.date_created_gmt}Z` : undefined,
    customer: {
      external_id: order.customer_id ? String(order.customer_id) : undefined,
      name: join(b.first_name, b.last_name) || join(s.first_name, s.last_name),
      email: b.email || undefined,
      phone: b.phone || s.phone || undefined,
      city: b.city || s.city, state: b.state || s.state, pincode: b.postcode || s.postcode,
    },
    ship_to: {
      name: join(s.first_name, s.last_name) || join(b.first_name, b.last_name),
      phone: s.phone || b.phone,
      address1: s.address_1 || b.address_1, address2: s.address_2 || b.address_2,
      city: s.city || b.city, state: s.state || b.state, pincode: s.postcode || b.postcode,
    },
    lines: (order.line_items ?? []).map((l: any) => ({
      sku_code: l.sku || `WOO-PRODUCT-${l.product_id}`,
      qty: num(l.quantity),
      // Charged price per unit including GST
      unit_price: num(l.quantity) ? Math.round(((num(l.total) + num(l.total_tax)) / num(l.quantity)) * 100) / 100 : undefined,
    })),
    shipping_amount: num(order.shipping_total) + num(order.shipping_tax),
    discount_amount: 0, // already reflected in line totals
    total_amount: num(order.total),
    payment: isCod
      ? { status: 'cod' }
      : paid
        ? { status: 'paid', amount: num(order.total), method: order.payment_method_title || order.payment_method,
            gateway: order.payment_method || 'woocommerce', gateway_ref: order.transaction_id || `woo-${order.id}` }
        : { status: 'unpaid' },
    notes: order.customer_note || undefined,
  };

  const actions: Action[] = [{ kind: 'order', eventId: `woo:order:${order.id}`, order: canonical }];
  // order.updated after payment: record the payment against the existing order (idempotent).
  if (topic === 'order.updated' && paid) {
    actions.push({ kind: 'payment', eventId: `woo:paid:${order.id}`, externalOrderId: String(order.id),
      payment: { amount: num(order.total), method: order.payment_method, gateway: order.payment_method || 'woocommerce',
                 gateway_ref: order.transaction_id || `woo-${order.id}` } });
  }
  return actions;
}

// Generic signed format for any other storefront, WhatsApp tool or Zapier:
// { "event_id": "...", "type": "order.created", "order": <CanonicalOrder> }
export function fromGeneric(body: any): Action[] {
  if (!body?.event_id || !body?.order) return [{ kind: 'ignore', reason: 'event_id and order are required' }];
  if (body.type === 'payment') {
    return [{ kind: 'payment', eventId: String(body.event_id), externalOrderId: String(body.order.external_order_id), payment: body.payment ?? {} }];
  }
  return [{ kind: 'order', eventId: String(body.event_id), order: body.order }];
}

// Constant-time comparison of two strings
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
