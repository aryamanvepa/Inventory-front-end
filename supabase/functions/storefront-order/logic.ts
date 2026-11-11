// Pure logic for the storefront-order Edge Function: request validation,
// the shipping rule, and the canonical ingest_order payload.
// No Deno/Node APIs here, so it is unit-tested with Node (tests/storefront-order.test.mjs).

// ---------------------------------------------------------------------
// PLACEHOLDER BUSINESS RULES — confirm with Torte Living before go-live.
// ---------------------------------------------------------------------
export const SHIPPING_FLAT = 60;            // ₹ per order
export const FREE_SHIPPING_ABOVE = 999;     // ₹ — subtotal strictly above this ships free
export const MAX_LINES = 10;
export const MAX_QTY = 20;                  // keep in step with storefront_max_line_qty() in SQL
export const MAX_ORDERS_PER_PHONE_PER_DAY = 5;

// Pilot: pay on delivery only. To add Razorpay later, add a 'razorpay' mode that creates
// the order as payment.status 'unpaid' (→ pending_payment) and confirm it from the
// gateway webhook with ingest_payment (gateway_ref = Razorpay payment id).
export type PaymentMode = 'cod';
export const PAYMENT_MODE: PaymentMode = 'cod';

export const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal',
];

export interface Line { sku_code: string; qty: number }
export interface PlaceRequest {
  idempotency_key: string;
  lines: Line[];
  customer: { name: string; phone: string; email: string; marketing_consent: boolean };
  address: { address1: string; address2: string; city: string; state: string; pincode: string };
  notes: string;
  expected_total: number;
}
export interface Quote {
  already_placed: boolean;
  lines: { sku_code: string; name: string; qty: number; unit_price: number; line_total: number }[];
  subtotal: number;
  problems: { sku_code: string; name?: string; reason: string; available: number }[];
  recent_orders_for_phone: number;
}

type Result<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SKU = /^[A-Z]{2,4}-\d{6}$/;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const PINCODE = /^[1-9]\d{5}$/;
// Control characters are never legitimate in names or addresses.
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const str = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

/** Indian mobile number → "+91XXXXXXXXXX", or null. Accepts +91 / 91 / 0 prefixes and spaces/dashes. */
export function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let d = raw.replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(d)) return null;
  d = d.replace(/^\+/, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}

export function validateLines(raw: unknown): Result<Line[]> {
  const errors: Record<string, string> = {};
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, errors: { lines: 'Your bag is empty' } };
  if (raw.length > MAX_LINES) return { ok: false, errors: { lines: `At most ${MAX_LINES} different items per order` } };
  const seen = new Set<string>();
  const lines: Line[] = [];
  raw.forEach((l, i) => {
    const code = typeof l?.sku_code === 'string' ? l.sku_code.trim().toUpperCase() : '';
    const qty = l?.qty;
    if (!SKU.test(code)) errors[`lines.${i}.sku_code`] = 'Unknown product';
    else if (seen.has(code)) errors[`lines.${i}.sku_code`] = 'Product listed twice';
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) errors[`lines.${i}.qty`] = `Quantity must be 1–${MAX_QTY}`;
    seen.add(code);
    lines.push({ sku_code: code, qty });
  });
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: lines };
}

export function validatePlaceRequest(body: unknown): Result<PlaceRequest> {
  const b = (body ?? {}) as Record<string, any>;
  const errors: Record<string, string> = {};

  // Honeypot: a hidden "website" field real shoppers never see or fill.
  if (str(b.website) !== '') return { ok: false, errors: { form: 'Request rejected' } };

  if (typeof b.idempotency_key !== 'string' || !UUID.test(b.idempotency_key)) errors.idempotency_key = 'Missing request id';

  const lines = validateLines(b.lines);
  if (!lines.ok) Object.assign(errors, lines.errors);

  const c = b.customer ?? {};
  const a = b.address ?? {};
  const name = str(c.name), email = str(c.email).toLowerCase();
  const phone = normalisePhone(c.phone);
  const address1 = str(a.address1), address2 = str(a.address2), city = str(a.city);
  const state = INDIAN_STATES.find((s) => s.toLowerCase() === str(a.state).toLowerCase());
  const pincode = str(a.pincode).replace(/\s/g, '');
  const notes = str(b.notes);

  if (name.length < 2 || name.length > 80 || CONTROL.test(name)) errors['customer.name'] = 'Please enter your full name';
  if (!phone) errors['customer.phone'] = 'Enter a 10-digit Indian mobile number';
  if (!EMAIL.test(email) || email.length > 120) errors['customer.email'] = 'Enter a valid email address';
  if (c.marketing_consent !== undefined && typeof c.marketing_consent !== 'boolean') errors['customer.marketing_consent'] = 'Invalid';
  if (address1.length < 5 || address1.length > 200 || CONTROL.test(address1)) errors['address.address1'] = 'Enter your house/flat and street';
  if (address2.length > 200 || CONTROL.test(address2)) errors['address.address2'] = 'Too long';
  if (city.length < 2 || city.length > 60 || CONTROL.test(city)) errors['address.city'] = 'Enter your city';
  if (!state) errors['address.state'] = 'Choose your state';
  if (!PINCODE.test(pincode)) errors['address.pincode'] = 'Enter a 6-digit PIN code';
  if (notes.length > 300) errors.notes = 'Keep delivery notes under 300 characters';
  if (typeof b.expected_total !== 'number' || !Number.isFinite(b.expected_total) || b.expected_total <= 0) {
    errors.expected_total = 'Missing order total';
  }

  if (Object.keys(errors).length || !lines.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      idempotency_key: b.idempotency_key.toLowerCase(),
      lines: lines.value,
      customer: { name, phone: phone!, email, marketing_consent: c.marketing_consent === true },
      address: { address1, address2, city, state: state!, pincode },
      notes,
      expected_total: b.expected_total,
    },
  };
}

export const shippingFor = (subtotal: number) => (subtotal > FREE_SHIPPING_ABOVE ? 0 : SHIPPING_FLAT);

/** Deterministic: the same client request id always maps to the same storefront order id. */
export const externalOrderIdFor = (idempotencyKey: string) =>
  'SF-' + idempotencyKey.replace(/-/g, '').slice(0, 12).toUpperCase();

export function totalsFor(quote: Pick<Quote, 'subtotal'>) {
  const subtotal = Number(quote.subtotal);
  const shipping = shippingFor(subtotal);
  return { subtotal, shipping, discount: 0, total: Math.round((subtotal + shipping) * 100) / 100 };
}

/** Canonical payload for ingest_order. No unit_price: the database applies the WEB price list. */
export function buildIngestPayload(req: PlaceRequest, quote: Pick<Quote, 'subtotal'>) {
  const t = totalsFor(quote);
  return {
    external_order_id: externalOrderIdFor(req.idempotency_key),
    channel: 'WEB',
    customer: {
      name: req.customer.name, phone: req.customer.phone, email: req.customer.email,
      city: req.address.city, state: req.address.state, pincode: req.address.pincode,
      marketing_consent: req.customer.marketing_consent,
    },
    ship_to: {
      name: req.customer.name, phone: req.customer.phone,
      address1: req.address.address1, address2: req.address.address2,
      city: req.address.city, state: req.address.state, pincode: req.address.pincode,
    },
    lines: req.lines.map((l) => ({ sku_code: l.sku_code, qty: l.qty })),
    shipping_amount: t.shipping,
    discount_amount: t.discount,
    total_amount: t.total,
    payment: { status: 'cod', method: 'cod' },
    notes: req.notes || undefined,
  };
}
