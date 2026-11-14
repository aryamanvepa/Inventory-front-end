# Torte Living Business Operating System — Pilot

The first working slice of the Mia Torte & Nutri Sampoorn operating system, built to the
requirements document. It has two parts:

1. **Supabase database** (`supabase/`): the single source of truth. It holds products, stock, orders and the
   business rules. All the rules live in the database, not the app.
2. **Operations app** (`src/`): a phone-first web app (PWA) for staff and the founder. Staff can add it to
   their home screen. It scans with the phone camera or a Bluetooth/USB barcode scanner.

Until Supabase is connected, the app runs in **demo mode**. The same database code runs inside the
browser, with sample products and ten test orders, so you can try every screen today.

```bash
npm install
npm run dev        # open http://localhost:5173 and pick a demo user
npm test           # 24 automated acceptance tests against the real SQL
```

---

## What is built (pilot scope from the spec)

| Spec item | Where |
|---|---|
| Torte Living Pvt Ltd as the legal entity, with Mia Torte and Nutri Sampoorn as brands | `legal_entities`, `brands` |
| Internal UUIDs plus database-generated codes (MT-000001, NS-000001, CUS-, BAT-2026-, ORD-2026-, SO-, SHP-, PAY-, TRF-, GRN-, ADJ-, DST-, RTL-, SUP-, MFR-, LOC-) | `next_code()` + triggers |
| Product / SKU / GTIN / category / HSN-GST / price lists with effective dates (no single price on the SKU) | migration 0002 |
| Customers deduplicated by website ID, email or phone. Marketing consent stored separately | `customers`, `customer_consents` |
| Business partners with multiple roles (distributor + retailer etc.) | `business_partners`, `partner_roles` |
| Multiple locations: warehouse, factory, contract manufacturer, distributor, retailer | `locations` |
| **Stock ledger**: SKU · batch · location · **owner** · status · qty. Physical movement is kept separate from ownership (consignment vs outright sale) | `stock_movements`, `stock_balances`, `transfer_stock()` |
| Batches: own facility or contract manufacturer, external lot number, expiry, QA hold/release, unit cost | `batches`, `set_batch_qa()` |
| Website order intake: idempotent, retry-safe, failures logged for reconciliation, storefront total cross-checked | `ingest_order()`, `integration_events`, Edge Function `order-webhook` |
| Reservations, so two customers can't buy the last packet. Waiting orders are reserved automatically when stock arrives | `reserve_order_stock()`, `reserve_waiting_orders()` |
| Scan-to-pack: wrong product, excess, expired, quarantined and no-stock scans are rejected. Every scan is logged with user, order, SKU and batch | `pack_scan()` |
| Dispatch via Rapido / iCarry / own delivery with booking ref, tracking, freight cost. Delivered / failed | `dispatch_order()` |
| Cancel (releases stock), refund (can't exceed amount paid), COD collection | `cancel_order()`, `record_refund()`, `record_payment()` |
| Founder dashboard (exception-driven): today's sales, orders, outstanding payments, low stock, alerts, revenue and margin by brand, channels, top products, repeat-purchase rate, where stock is (own / consignment / sold to partner), inventory ageing | `get_dashboard()` |
| Controls: individual logins, roles (admin / manager / warehouse / packer / viewer), row-level security, ledgers that can't be edited or deleted, a reason required for adjustments, an audit log, no secrets in the browser | migration 0007, `audit_log` |
| QR batch and product labels (A4, 3 across) | Labels screen |

**App screens:** Home / work queue · Pack orders · Dispatch · Stock (lookup, adjust, damage/expiry, QA) ·
Receive stock · Transfer stock · All orders (payments, cancel, refund) · Business dashboard · Admin
(simulate website orders + integration log, products and prices, partners and locations, staff) · Print labels.

### Tested

- `npm run test:db`: 20 acceptance tests from the spec. They cover product creation, website order, reservation,
  scan validation, packing, dispatch, cancel, refund, retry without duplicates, the last-unit race,
  immutability, permissions, consignment vs outright transfer, GS1 parsing, price history and the dashboard.
- `npm run test:webhook`: WooCommerce mapping, plus the payment webhook arriving twice.
- I clicked through the app at phone size in demo mode: login, pack, dispatch, stock, receive, dashboard, labels,
  and packer permissions.

**Not yet verified:** camera scanning on a real phone (the test browser had no camera), the Edge Function
running on Supabase, and true simultaneous connections. The tests' "last packet" race runs on a
single connection. The protection itself is a per-SKU database lock that real Postgres enforces.

### Deliberately left for later phases (designed for, not built)

Production orders with bill of materials, distributor sales orders / invoices / credit limits / territories,
returns after dispatch, accounting sync (Tally / Zoho), retailer POS sell-through, CRM campaigns. The ledger,
ownership model, partner roles and price lists are already shaped so these add on without redesign.

---

## Hosted demo (GitHub Pages)

Every push to `main` runs the tests, builds the app and publishes it via `.github/workflows/deploy-pages.yml`
to **https://aryamanvepa.github.io/Inventory-front-end/**. With no Supabase settings it runs in demo mode:
each visitor gets their own private sample database in their browser (nothing is shared or sent anywhere).
To point the hosted app at the real database later, add repository variables `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` and re-run the workflow.

## Going live: setup steps

### 1. Supabase (≈15 minutes)
1. Create a project at supabase.com **under Torte Living's own account**. Region: Mumbai (`ap-south-1`).
2. Install the CLI (`brew install supabase/tap/supabase`), then in this folder:
   ```bash
   supabase init            # creates supabase/config.toml; keeps the migrations
   supabase link --project-ref <your-project-ref>
   supabase db push         # creates all tables, rules and security
   ```
   For a **test** project you can also load the sample data with `supabase db push --include-seed`.
   Don't do that on the real one.
3. Supabase → Authentication → Providers: keep Email enabled. Turn off "Allow new users to sign up" once all
   staff have created logins.

### 2. The app
1. Copy `.env.example` to `.env.local` and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
   (Project Settings → API). The anon key is safe in the browser: every table is locked by RLS, and anonymous
   users can't call any function. **Never** put the `service_role` key in the app.
2. `npm run build` and host the `dist/` folder on any HTTPS static host (Vercel, Netlify, Cloudflare Pages, or
   Hostinger static hosting). HTTPS is required for the camera.
3. Open it, choose **Create a login**, sign in. The first person becomes administrator. Staff then create their own
   logins, and the admin assigns roles under More → Admin → Staff.

### 3. Website orders (after the storefront is chosen)
```bash
supabase secrets set WOO_WEBHOOK_SECRET=<long random string>
supabase functions deploy order-webhook --no-verify-jwt
```
**WooCommerce:** Settings → Advanced → Webhooks. Add "Order created" and "Order updated" pointing at
`https://<project>.supabase.co/functions/v1/order-webhook?source=woocommerce`, using the same secret.
Each WooCommerce product's **SKU field must equal our SKU code** (e.g. `NS-000001`).
**Other platforms** (Hostinger, Shopify, WhatsApp tools): post the canonical JSON documented in `ingest_order()`
to `?source=<name>` with an `x-tl-signature` HMAC header (`TL_WEBHOOK_SECRET`).

### Adding later database changes
Add new numbered files to `supabase/migrations/`; never edit ones already pushed. New functions are not callable
by `anon`. Grant them to `authenticated` only if staff should call them directly.

---

## Project layout
```
supabase/migrations/   0001 foundation · 0002 master data · 0003 inventory ledger · 0004 orders
                       0005 operations · 0006 reads & dashboard · 0007 security & reference data
supabase/seed.sql      pilot sample data (test projects / demo only)
supabase/functions/order-webhook/   website → database integration (Edge Function)
supabase/local-shim.sql, demo-users.sql   demo & tests only, never run on Supabase
src/                   React app (screens in src/screens)
tests/                 acceptance tests (run on an in-process PostgreSQL)
```
