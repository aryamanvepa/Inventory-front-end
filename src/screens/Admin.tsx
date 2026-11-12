import { useEffect, useState } from 'react';
import { useAction, useApp, useRpc } from '../lib/app';
import { Badge, Card, dateTime, ErrorBox, Field, inr, Loading, Page, Segmented, Sheet } from '../components/ui';

type Section = 'website' | 'products' | 'partners' | 'staff';

export function Admin({ section }: { section?: string }) {
  const { go, can } = useApp();
  const s = (section as Section) || 'website';
  const opts: { value: Section; label: string }[] = [
    { value: 'website', label: 'Website orders' }, { value: 'products', label: 'Products' }, { value: 'partners', label: 'Partners' },
  ];
  if (can('admin')) opts.push({ value: 'staff', label: 'Staff' });
  return (
    <Page title="Admin" back="more">
      <Segmented value={s} onChange={(v) => go(`admin/${v}`)} options={opts} />
      {s === 'website' && <Website />}
      {s === 'products' && <Products />}
      {s === 'partners' && <Partners />}
      {s === 'staff' && <Staff />}
    </Page>
  );
}

// Simulates the website webhook so the full chain can be tested before the
// storefront platform is chosen. Uses the same intake function.
function Website() {
  const { can, backend } = useApp();
  const skus = useRpc<any[]>('list_skus');
  const log = useRpc<any[]>('list_integration_events', { p_limit: 30 });
  const { run, busy } = useAction();
  const [lines, setLines] = useState<Record<string, string>>({});
  const [name, setName] = useState('Priya Menon');
  const [phone, setPhone] = useState('9000012345');
  const [city, setCity] = useState('Hyderabad');
  const [pay, setPay] = useState<'paid' | 'cod' | 'unpaid'>('paid');
  const [lastEvent, setLastEvent] = useState<{ id: string; payload: any } | null>(null);
  const [result, setResult] = useState<any>(null);

  const send = async (eventId: string, payload: any) => {
    const r = await run<any>('ingest_order', { p_source: 'website-sim', p_event_id: eventId, p_payload: payload });
    if (r) { setResult(r); log.reload(); skus.reload(); }
  };

  const chosen = Object.entries(lines).filter(([, q]) => Number(q) > 0);

  return (
    <>
      <p className="muted small">
        Until the storefront (WooCommerce / Hostinger / Shopify) is chosen, use this to place test orders exactly as a website
        webhook would. “Send again” re-delivers the same event to prove retries don't create duplicates.
        {backend.mode === 'supabase' && ' Real website orders arrive through the order-webhook Edge Function.'}
      </p>
      {can('admin') && skus.data && (
        <Card>
          <h2>Simulate a website order</h2>
          {skus.data.map((s) => (
            <div key={s.id} className="row-between line-pick">
              <span>{s.name}<span className="muted small"> · {inr(s.web_price ?? s.mrp)} · {s.atp} free</span></span>
              <input aria-label={`Quantity of ${s.name}`} className="qty-input" inputMode="numeric" value={lines[s.code] ?? ''} placeholder="0"
                onChange={(e) => setLines({ ...lines, [s.code]: e.target.value.replace(/\D/g, '') })} />
            </div>
          ))}
          <Field label="Customer name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Phone"><input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="City"><input value={city} onChange={(e) => setCity(e.target.value)} /></Field>
          <Field label="Payment"><Segmented value={pay} onChange={setPay} options={[{ value: 'paid', label: 'Paid' }, { value: 'cod', label: 'COD' }, { value: 'unpaid', label: 'Unpaid' }]} /></Field>
          <div className="row-gap">
            <button type="button" className="btn btn-primary grow" disabled={busy || chosen.length === 0} onClick={() => {
              const ext = String(Date.now()).slice(-6);
              const payload = {
                external_order_id: `SIM-${ext}`, channel: 'WEB',
                customer: { external_id: `sim-${phone}`, name, phone, city },
                ship_to: { name, phone, address1: 'Test address', city, pincode: '500001' },
                lines: chosen.map(([code, q]) => ({ sku_code: code, qty: Number(q) })),
                shipping_amount: 50,
                payment: pay === 'paid' ? { status: 'paid', method: 'upi', gateway: 'sim', gateway_ref: `sim_${ext}` } : { status: pay },
              };
              const id = `sim-evt-${ext}`;
              setLastEvent({ id, payload });
              send(id, payload);
            }}>Place test order</button>
            {lastEvent && <button type="button" className="btn" disabled={busy} onClick={() => send(lastEvent.id, lastEvent.payload)}>Send again</button>}
          </div>
          {result && (
            <div className={`scan-result ${result.ok && (result.duplicate || result.stock_reserved) ? 'ok' : 'bad'}`}>
              {result.ok
                ? `${result.duplicate ? 'Duplicate ignored — still' : 'Created'} ${result.order_code}${result.duplicate ? '' : ` · ${result.status} · ${result.stock_reserved ? 'stock reserved' : 'NOT enough stock'}`}`
                : `Failed: ${result.error}`}
            </div>
          )}
        </Card>
      )}
      <h2 className="section">Integration log</h2>
      {log.error && <ErrorBox text={log.error} />}
      <ul className="log">
        {log.data?.map((e) => (
          <li key={e.id}>
            <div className="row-between"><span><span className="mono">{e.event_id}</span> · {e.source}</span><Badge status={e.status} /></div>
            <div className="small muted">{dateTime(e.received_at)} · attempts {e.attempts}{e.order_code ? ` · ${e.order_code}` : ''}{e.external_order_id ? ` · web #${e.external_order_id}` : ''}</div>
            {e.error && <div className="small bad">{e.error}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}

function Products() {
  const ref = useRpc<any>('get_reference_data');
  const skus = useRpc<any[]>('list_skus');
  const { run, busy } = useAction();
  const { can } = useApp();
  const [f, setF] = useState<Record<string, string>>({ pack_unit: 'g', is_batch_tracked: 'true' });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const [price, setPrice] = useState<{ sku: any; value: string } | null>(null);
  const [edit, setEdit] = useState<string | null>(null);

  if (!ref.data || !skus.data) return <Loading />;
  const existing = f.product_id && f.product_id !== 'new';

  return (
    <>
      <h2 className="section">Catalogue</h2>
      <p className="muted small">Tap a product to edit it: shelf life, GST, category, reorder level, and the label information the website shows.</p>
      {edit && <ProductEditor productId={edit} refData={ref.data} onClose={() => setEdit(null)} onSaved={() => skus.reload()} />}
      <table className="tbl">
        <thead><tr><th>SKU</th><th className="num">MRP</th><th className="num">Web</th><th className="num">Free</th></tr></thead>
        <tbody>
          {skus.data.map((s) => (
            <tr key={s.id}>
              <td><button type="button" className="link" onClick={() => setEdit(s.product_id)}><span className="mono">{s.code}</span> {s.name}</button>
                <div className="muted small">{s.brand} · {s.hsn ? `HSN ${s.hsn} · ${s.gst_rate}%` : 'no tax rate'}{s.shelf_life_days ? ` · ${s.shelf_life_days} d shelf life` : ' · no shelf life'}{s.gtins.length ? ` · GTIN ${s.gtins.join(', ')}` : ''}</div></td>
              <td className="num">{inr(s.mrp)}</td>
              <td className="num">{can('admin') ? <button type="button" className="link" onClick={() => setPrice({ sku: s, value: String(s.web_price ?? '') })}>{s.web_price != null ? inr(s.web_price) : 'set'}</button> : inr(s.web_price)}</td>
              <td className="num">{s.atp}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {price && (
        <Card>
          <strong>Website price for {price.sku.name}</strong>
          <p className="muted small">Takes effect today. Past orders keep the price they were sold at.</p>
          <div className="row-gap">
            <input inputMode="decimal" value={price.value} onChange={(e) => setPrice({ ...price, value: e.target.value.replace(/[^\d.]/g, '') })} />
            <button type="button" className="btn btn-primary" disabled={busy || !price.value} onClick={async () => {
              if (await run('set_price', { p_sku_id: price.sku.id, p_price_list_code: 'WEB', p_price: Number(price.value) }, 'Price updated')) { setPrice(null); skus.reload(); }
            }}>Save</button>
            <button type="button" className="btn" onClick={() => setPrice(null)}>Cancel</button>
          </div>
        </Card>
      )}

      <h2 className="section">Add a product / pack size</h2>
      <Card>
        <Field label="Product">
          <select value={f.product_id ?? 'new'} onChange={set('product_id')}>
            <option value="new">+ New product</option>
            {ref.data.products.map((p: any) => <option key={p.id} value={p.id}>{p.brand} · {p.name}</option>)}
          </select>
        </Field>
        {!existing && (
          <>
            <Field label="Brand"><select value={f.brand_id ?? ''} onChange={set('brand_id')}><option value="">— choose —</option>{ref.data.brands.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            <Field label="Product name"><input value={f.product_name ?? ''} onChange={set('product_name')} placeholder="e.g. Jowar Atta" /></Field>
            <Field label="Category"><select value={f.category_id ?? ''} onChange={set('category_id')}><option value="">—</option>{ref.data.categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="HSN / GST" hint="Confirm with your CA"><select value={f.tax_rate_id ?? ''} onChange={set('tax_rate_id')}><option value="">—</option>{ref.data.tax_rates.map((t: any) => <option key={t.id} value={t.id}>{t.hsn_code} · {t.gst_rate}% · {t.description}</option>)}</select></Field>
            <Field label="Shelf life (days)"><input inputMode="numeric" value={f.shelf_life_days ?? ''} onChange={set('shelf_life_days')} /></Field>
          </>
        )}
        <Field label="Pack name"><input value={f.sku_name ?? ''} onChange={set('sku_name')} placeholder="e.g. Jowar Atta 1 kg" /></Field>
        <div className="row-gap">
          <Field label="Pack size"><input inputMode="decimal" value={f.pack_size ?? ''} onChange={set('pack_size')} /></Field>
          <Field label="Unit"><select value={f.pack_unit} onChange={set('pack_unit')}>{['g', 'kg', 'ml', 'l', 'pcs'].map((u) => <option key={u}>{u}</option>)}</select></Field>
        </div>
        <div className="row-gap">
          <Field label="MRP ₹"><input inputMode="decimal" value={f.mrp ?? ''} onChange={set('mrp')} /></Field>
          <Field label="Website price ₹"><input inputMode="decimal" value={f.website_price ?? ''} onChange={set('website_price')} /></Field>
        </div>
        <Field label="Reorder level (packs)"><input inputMode="numeric" value={f.reorder_level ?? ''} onChange={set('reorder_level')} /></Field>
        <Field label="GS1 GTIN / EAN-13 (optional)" hint="Only numbers issued by GS1 India — never invent one"><input inputMode="numeric" value={f.gtin ?? ''} onChange={set('gtin')} /></Field>
        <button type="button" className="btn btn-primary btn-big" disabled={busy || !f.sku_name || !f.pack_size || (!existing && (!f.brand_id || !f.product_name))} onClick={async () => {
          const r = await run<any>('create_product_sku', { p: { ...f, product_id: existing ? f.product_id : null } });
          if (r) { setF({ pack_unit: 'g', is_batch_tracked: 'true' }); skus.reload(); ref.reload(); alert(`Created SKU ${r.sku_code}`); }
        }}>Create SKU</button>
      </Card>
    </>
  );
}

function Partners() {
  const ref = useRpc<any>('get_reference_data');
  const { run, busy } = useAction();
  const [f, setF] = useState<Record<string, string>>({ role: 'distributor' });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  if (!ref.data) return <Loading />;
  const locType: Record<string, string> = { distributor: 'distributor', sub_distributor: 'distributor', retailer: 'retailer', manufacturer: 'contract_manufacturer' };

  return (
    <>
      <h2 className="section">Partners</h2>
      <ul className="plain">
        {ref.data.partners.map((p: any) => <li key={p.id}><strong>{p.name}</strong> <span className="muted small">{p.code} · {p.roles.map((r: any) => `${r.role} ${r.code}`).join(', ')}</span></li>)}
      </ul>
      <h2 className="section">Locations</h2>
      <ul className="plain">
        {ref.data.locations.map((l: any) => <li key={l.id}><strong>{l.name}</strong> <span className="muted small">{l.code} · {l.type}{l.is_default ? ' · default for website orders' : ''}</span></li>)}
      </ul>
      <h2 className="section">Add a partner</h2>
      <Card>
        <Field label="Legal name"><input value={f.legal_name ?? ''} onChange={set('legal_name')} /></Field>
        <Field label="Short name"><input value={f.display_name ?? ''} onChange={set('display_name')} /></Field>
        <Field label="Role">
          <select value={f.role} onChange={set('role')}>
            {['distributor', 'sub_distributor', 'retailer', 'wholesaler', 'manufacturer', 'supplier', 'institutional'].map((r) => <option key={r} value={r}>{r.replace('_', '-')}</option>)}
          </select>
        </Field>
        <Field label="GSTIN"><input value={f.gstin ?? ''} onChange={set('gstin')} autoCapitalize="characters" /></Field>
        <div className="row-gap">
          <Field label="City"><input value={f.city ?? ''} onChange={set('city')} /></Field>
          <Field label="State"><input value={f.state ?? ''} onChange={set('state')} /></Field>
        </div>
        <Field label="Phone"><input value={f.phone ?? ''} onChange={set('phone')} /></Field>
        {locType[f.role] && <p className="muted small">A stock location will be created for this partner so you can send stock there (consignment or outright).</p>}
        <button type="button" className="btn btn-primary btn-big" disabled={busy || !f.legal_name} onClick={async () => {
          const r = await run<any>('create_partner', { p: { ...f, roles: [f.role], location_type: locType[f.role] ?? null } }, 'Partner added');
          if (r) { setF({ role: 'distributor' }); ref.reload(); }
        }}>Add partner</button>
      </Card>
    </>
  );
}

function Staff() {
  const { backend } = useApp();
  const staff = useRpc<any[]>('list_staff');
  const { run, busy } = useAction();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('packer');
  return (
    <>
      <h2 className="section">Staff</h2>
      {staff.error && <ErrorBox text={staff.error} />}
      <table className="tbl">
        <thead><tr><th>Name</th><th>Role</th></tr></thead>
        <tbody>{staff.data?.map((s) => <tr key={s.user_id}><td>{s.full_name}<div className="muted small">{s.email}</div></td><td>{s.role}{s.active ? '' : ' (disabled)'}</td></tr>)}</tbody>
      </table>
      <h2 className="section">Give someone access</h2>
      <Card>
        <p className="muted small">They first create a login on the sign-in screen with their email. Then add them here.
          Roles: <b>packer</b> packs & dispatches · <b>warehouse</b> also receives & transfers stock · <b>manager</b> also adjusts stock, cancels and refunds · <b>accountant</b> invoices, bills, payments, journals and reports · <b>viewer</b> sees the dashboard and accounts · <b>admin</b> everything incl. prices, GST settings and staff.</p>
        {backend.mode === 'demo' && <p className="notice small">Demo mode has fixed demo users; this works once connected to Supabase.</p>}
        <Field label="Their login email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Role"><select value={role} onChange={(e) => setRole(e.target.value)}>{['packer', 'warehouse', 'manager', 'accountant', 'viewer', 'admin'].map((r) => <option key={r}>{r}</option>)}</select></Field>
        <div className="row-gap">
          <button type="button" className="btn btn-primary grow" disabled={busy || !email || !name} onClick={async () => {
            if (await run('set_staff', { p_email: email, p_full_name: name, p_role: role, p_active: true }, 'Access saved')) { setEmail(''); setName(''); staff.reload(); }
          }}>Save access</button>
          <button type="button" className="btn" disabled={busy || !email} onClick={async () => {
            if (await run('set_staff', { p_email: email, p_full_name: name || email, p_role: 'viewer', p_active: false }, 'Access removed')) staff.reload();
          }}>Remove access</button>
        </div>
      </Card>
    </>
  );
}

const NUTRIENTS: [string, string][] = [['energy_kcal', 'Energy (kcal)'], ['protein_g', 'Protein (g)'], ['carbohydrate_g', 'Carbohydrate (g)'],
  ['total_sugars_g', 'Total sugars (g)'], ['added_sugars_g', 'Added sugars (g)'], ['fat_g', 'Total fat (g)'], ['saturated_fat_g', 'Saturated fat (g)'],
  ['trans_fat_g', 'Trans fat (g)'], ['fibre_g', 'Dietary fibre (g)'], ['sodium_mg', 'Sodium (mg)'], ['cholesterol_mg', 'Cholesterol (mg)']];

// Edit a product and its packs, including the label information shown on the website
function ProductEditor({ productId, refData, onClose, onSaved }: { productId: string; refData: any; onClose(): void; onSaved(): void }) {
  const { backend, can, toast } = useApp();
  const { run, busy } = useAction();
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<Record<string, any>>({});
  const [packs, setPacks] = useState<Record<string, any>>({});
  useEffect(() => {
    backend.rpc<any>('get_product_details', { p_product_id: productId }).then((x) => {
      setD(x);
      setF({ name: x.name, brand_id: x.brand_id ?? '', category_id: x.category_id ?? '', tax_rate_id: x.tax_rate_id ?? '',
        shelf_life_days: x.shelf_life_days ?? '', active: x.active, description: x.description ?? '', ingredients: x.ingredients ?? '',
        allergens: x.allergens ?? '', diet: x.diet ?? '', storage: x.storage ?? '', nutrition: x.nutrition ?? {} });
      setPacks(Object.fromEntries(x.skus.map((s: any) => [s.id, { name: s.name, reorder_level: s.reorder_level, weight_grams: s.weight_grams ?? '', active: s.active, mrp: s.mrp ?? '' }])));
    }).catch((e) => toast(String(e.message ?? e), 'error'));
  }, [productId, backend, toast]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const save = async (confirm?: boolean) => {
    const p: Record<string, unknown> = { ...f, shelf_life_days: f.shelf_life_days === '' ? null : Number(f.shelf_life_days) };
    if (d.item_type !== 'finished' || d.has_history) delete p.brand_id;
    if (confirm !== undefined) p.content_confirmed = confirm;
    const r = await run<any>('update_product', { p_product_id: productId, p }, confirm ? 'Label information confirmed' : 'Product saved');
    if (!r) return;
    for (const s of d.skus) {
      const pk = packs[s.id];
      const changed: Record<string, unknown> = {};
      for (const k of ['name', 'reorder_level', 'weight_grams', 'active']) if (String(pk[k]) !== String(s[k] ?? '')) changed[k] = pk[k];
      if (can('admin') && String(pk.mrp) !== String(s.mrp ?? '')) changed.mrp = pk.mrp;
      if (Object.keys(changed).length && !(await run('update_sku', { p_sku_id: s.id, p: changed }))) return;
    }
    setD(await backend.rpc<any>('get_product_details', { p_product_id: productId }));
    onSaved();
  };

  return (
    <Sheet title={d ? d.name : 'Product'} onClose={onClose}>
      {!d ? <Loading /> : (
        <div className="stack">
          <div className="row-gap small">
            {d.content_confirmed ? <Badge status="available">Label info confirmed {dateTime(d.content_confirmed_at)}</Badge> : <Badge status="pending">Label info not confirmed — website shows it as a draft</Badge>}
          </div>
          <Field label="Product name"><input value={f.name} onChange={set('name')} /></Field>
          {d.item_type === 'finished' && (
            <Field label="Brand" hint={d.has_history ? 'Fixed: this product already has orders or stock' : undefined}>
              <select value={f.brand_id} onChange={set('brand_id')} disabled={d.has_history}>{refData.brands.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            </Field>
          )}
          <div className="row-gap">
            <Field label="Category"><select value={f.category_id} onChange={set('category_id')}><option value="">—</option>{refData.categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Shelf life (days)"><input inputMode="numeric" value={f.shelf_life_days} onChange={(e) => setF({ ...f, shelf_life_days: e.target.value.replace(/\D/g, '') })} /></Field>
          </div>
          <Field label="HSN / GST" hint="Confirm with your CA"><select value={f.tax_rate_id} onChange={set('tax_rate_id')}><option value="">—</option>{refData.tax_rates.map((t: any) => <option key={t.id} value={t.id}>{t.hsn_code} · {t.gst_rate}% · {t.description}</option>)}</select></Field>
          <label className="row-gap"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} style={{ width: 'auto', minHeight: 0 }} /> Active (off = hidden from the website and stock screens)</label>

          <h3 className="group-title">Label information (shown on the website)</h3>
          <Field label="Description"><textarea rows={3} value={f.description} onChange={set('description')} /></Field>
          <Field label="Ingredients" hint="As printed on the pack, in descending order"><textarea rows={3} value={f.ingredients} onChange={set('ingredients')} /></Field>
          <Field label="Allergens" hint="e.g. Contains nuts, gluten. May contain sesame."><input value={f.allergens} onChange={set('allergens')} /></Field>
          <div className="row-gap">
            <Field label="Veg mark"><select value={f.diet} onChange={set('diet')}><option value="">—</option><option value="veg">Veg</option><option value="vegan">Vegan</option><option value="egg">Contains egg</option><option value="non_veg">Non-veg</option></select></Field>
            <Field label="Storage"><input value={f.storage} onChange={set('storage')} placeholder="Store in a cool, dry place" /></Field>
          </div>
          <Field label="Nutrition per 100 g" hint="Leave blank what you don't have">
            <div className="nutri-grid">
              {NUTRIENTS.map(([k, label]) => (
                <label key={k} className="small">{label}
                  <input inputMode="decimal" value={f.nutrition?.[k] ?? ''} onChange={(e) => setF({ ...f, nutrition: { ...f.nutrition, [k]: e.target.value.replace(/[^\d.]/g, '') } })} />
                </label>
              ))}
            </div>
          </Field>

          <h3 className="group-title">Packs</h3>
          {d.skus.map((s: any) => (
            <Card key={s.id}>
              <div className="row-between small"><span className="mono">{s.code}</span><span className="muted">Web {s.web_price != null ? inr(s.web_price) : '—'}{s.strategic_price != null ? ` · strategic ${inr(s.strategic_price)}` : ''}</span></div>
              <Field label="Pack name"><input value={packs[s.id].name} onChange={(e) => setPacks({ ...packs, [s.id]: { ...packs[s.id], name: e.target.value } })} /></Field>
              <div className="row-gap">
                <Field label="Reorder level"><input inputMode="numeric" value={packs[s.id].reorder_level} onChange={(e) => setPacks({ ...packs, [s.id]: { ...packs[s.id], reorder_level: e.target.value.replace(/\D/g, '') } })} /></Field>
                <Field label="MRP ₹" hint={can('admin') ? undefined : 'Admin only'}><input inputMode="decimal" disabled={!can('admin')} value={packs[s.id].mrp} onChange={(e) => setPacks({ ...packs, [s.id]: { ...packs[s.id], mrp: e.target.value.replace(/[^\d.]/g, '') } })} /></Field>
              </div>
              <label className="row-gap small"><input type="checkbox" checked={packs[s.id].active} onChange={(e) => setPacks({ ...packs, [s.id]: { ...packs[s.id], active: e.target.checked } })} style={{ width: 'auto', minHeight: 0 }} /> Active</label>
            </Card>
          ))}

          <button type="button" className="btn btn-primary btn-big" disabled={busy} onClick={() => save()}>Save</button>
          {d.item_type === 'finished' && (d.content_confirmed
            ? <button type="button" className="btn" disabled={busy} onClick={() => save(false)}>Mark label info as not confirmed</button>
            : <button type="button" className="btn" disabled={busy} onClick={() => save(true)}>Save and confirm label information</button>)}
        </div>
      )}
    </Sheet>
  );
}
