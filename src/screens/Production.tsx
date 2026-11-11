import { useState } from 'react';
import { useAction, useApp, useRpc } from '../lib/app';
import { newKey } from '../lib/backend';
import { Badge, Card, date, dateTime, Empty, ErrorBox, Field, inr, Loading, Page, qty, Segmented, Sheet, ymd } from '../components/ui';

type Section = 'runs' | 'recipes' | 'materials';
const inr2 = (v: unknown) => inr(v, 2);
const num = (s: string) => s.replace(/[^\d.]/g, '');

export function Production({ section, id }: { section?: string; id?: string }) {
  const { go } = useApp();
  const s = (section as Section) || 'runs';
  if (s === 'runs' && id) return <RunDetail id={id} />;
  return (
    <Page title="Production" back="more">
      <Segmented value={s} onChange={(v) => go(`production/${v}`)} options={[
        { value: 'runs', label: 'Production runs' }, { value: 'recipes', label: 'Recipes' }, { value: 'materials', label: 'Materials' }]} />
      {s === 'runs' && <Runs />}
      {s === 'recipes' && <Recipes />}
      {s === 'materials' && <Materials />}
    </Page>
  );
}

// ---------------------------------------------------------------- Materials
function Materials() {
  const { can } = useApp();
  const list = useRpc<any[]>('list_materials');
  const [add, setAdd] = useState(false);
  return (
    <>
      {can('manager', 'accountant') && <button type="button" className="btn btn-primary" onClick={() => setAdd(true)}>Add ingredient or packaging</button>}
      {list.error && <ErrorBox text={list.error} />}
      {list.data?.length === 0 && <Empty>No materials yet. Add your ingredients and packaging, then buy them with a purchase order.</Empty>}
      <div className="list">
        {list.data?.map((m) => (
          <Card key={m.id}>
            <div className="row-between">
              <div><strong>{m.name}</strong><div className="muted small"><span className="mono">{m.code}</span> · {m.item_type === 'packaging' ? 'Packaging' : 'Raw material'}</div></div>
              <div className="right"><div className={`big-num ${m.low ? 'bad' : ''}`}>{qty(m.on_hand)}</div><div className="muted small">{m.unit} in stock</div></div>
            </div>
            <div className="muted small">
              {m.by_location.map((l: any) => `${l.location}: ${qty(l.qty)}`).join(' · ') || 'None in stock'}
              {' · '}value {inr(m.value)}{m.last_cost != null ? ` · last cost ${inr2(m.last_cost)}/${m.unit}` : ''}
              {m.low ? <span className="bad"> · below reorder level {m.reorder_level}</span> : null}
            </div>
          </Card>
        ))}
      </div>
      {add && <MaterialSheet onClose={() => setAdd(false)} onDone={() => { setAdd(false); list.reload(); }} />}
    </>
  );
}

function MaterialSheet({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const [f, setF] = useState({ name: '', item_type: 'raw_material', unit: 'kg', reorder_level: '', shelf_life_days: '' });
  const { run, busy } = useAction();
  return (
    <Sheet title="Add a material" onClose={onClose}>
      <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Dark chocolate 54%" /></Field>
      <Segmented value={f.item_type} onChange={(v) => setF({ ...f, item_type: v, unit: v === 'packaging' ? 'pcs' : f.unit })}
        options={[{ value: 'raw_material', label: 'Ingredient' }, { value: 'packaging', label: 'Packaging' }]} />
      <div className="row-gap">
        <Field label="Unit">
          <select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{['kg', 'g', 'l', 'ml', 'pcs'].map((u) => <option key={u}>{u}</option>)}</select>
        </Field>
        <Field label="Reorder level"><input inputMode="decimal" value={f.reorder_level} onChange={(e) => setF({ ...f, reorder_level: num(e.target.value) })} /></Field>
        <Field label="Shelf life (days)"><input inputMode="numeric" value={f.shelf_life_days} onChange={(e) => setF({ ...f, shelf_life_days: num(e.target.value) })} /></Field>
      </div>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !f.name.trim()} onClick={async () => {
        const r = await run<any>('create_material', { p: f });
        if (r) onDone();
      }}>Add material</button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Recipes
function Recipes() {
  const { can } = useApp();
  const skus = useRpc<any[]>('list_skus');
  const recipes = useRpc<any[]>('list_recipes');
  const [edit, setEdit] = useState<any>(null);
  if (!skus.data || !recipes.data) return skus.error || recipes.error ? <ErrorBox text={(skus.error || recipes.error)!} /> : <Loading />;
  const bySku = new Map(recipes.data.map((r) => [r.sku.id, r]));
  return (
    <>
      <p className="muted small">A recipe lists the ingredients and packaging used to make one batch run, and how many packs it yields.
        Saving changes creates a new version; past production keeps the version it used.</p>
      <div className="list">
        {skus.data.map((s) => {
          const r = bySku.get(s.id);
          return (
            <Card key={s.id}>
              <div className="row-between">
                <div><strong>{s.name}</strong><div className="muted small mono">{s.code}</div></div>
                {r ? <div className="right"><strong>{inr2(r.standard_cost_per_unit)}</strong><div className="muted small">standard cost / pack</div></div>
                   : <span className="muted small">No recipe</span>}
              </div>
              {r && (
                <>
                  <div className="small">Version {r.version} · makes {qty(r.output_qty)} packs per run</div>
                  <table className="tbl">
                    <tbody>{r.lines.map((l: any) => <tr key={l.material_sku_id}><td>{l.name}{Number(l.wastage_pct) ? <span className="muted small"> +{Number(l.wastage_pct)}% wastage</span> : null}</td>
                      <td className="num">{qty(l.qty)} {l.unit}</td><td className="num">{l.unit_cost != null ? inr2(l.cost) : <span className="bad">no cost yet</span>}</td></tr>)}</tbody>
                  </table>
                </>
              )}
              {can('manager') && <button type="button" className="btn btn-small" onClick={() => setEdit({ sku: s, recipe: r })}>{r ? 'Edit recipe' : 'Add recipe'}</button>}
            </Card>
          );
        })}
      </div>
      {edit && <RecipeSheet {...edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); recipes.reload(); }} />}
    </>
  );
}

function RecipeSheet({ sku, recipe, onClose, onDone }: { sku: any; recipe: any; onClose(): void; onDone(): void }) {
  const mats = useRpc<any[]>('list_materials');
  const [out, setOut] = useState(String(recipe?.output_qty ?? ''));
  const [lines, setLines] = useState<{ material_sku_id: string; qty: string; wastage_pct: string }[]>(
    recipe?.lines.map((l: any) => ({ material_sku_id: l.material_sku_id, qty: String(Number(l.qty)), wastage_pct: String(Number(l.wastage_pct)) }))
      ?? [{ material_sku_id: '', qty: '', wastage_pct: '' }]);
  const [notes, setNotes] = useState(recipe?.notes ?? '');
  const { run, busy } = useAction();
  const set = (i: number, k: string, v: string) => setLines(lines.map((l, n) => (n === i ? { ...l, [k]: v } : l)));
  const valid = Number(out) > 0 && lines.length > 0 && lines.every((l) => l.material_sku_id && Number(l.qty) > 0);
  return (
    <Sheet title={`Recipe: ${sku.name}`} onClose={onClose}>
      <Field label="Packs produced per run"><input inputMode="decimal" value={out} onChange={(e) => setOut(num(e.target.value))} /></Field>
      {lines.map((l, i) => {
        const m = mats.data?.find((x) => x.id === l.material_sku_id);
        return (
          <div className="row-gap" key={i}>
            <select value={l.material_sku_id} onChange={(e) => set(i, 'material_sku_id', e.target.value)} aria-label="Material" style={{ flex: 3 }}>
              <option value="">Material…</option>
              {mats.data?.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.unit})</option>)}
            </select>
            <input inputMode="decimal" placeholder={`Qty${m ? ` (${m.unit})` : ''}`} value={l.qty} onChange={(e) => set(i, 'qty', num(e.target.value))} aria-label="Quantity" style={{ flex: 1 }} />
            <input inputMode="decimal" placeholder="Waste %" value={l.wastage_pct} onChange={(e) => set(i, 'wastage_pct', num(e.target.value))} aria-label="Wastage percent" style={{ flex: 1 }} />
            <button type="button" className="icon-btn" aria-label="Remove line" onClick={() => setLines(lines.filter((_, n) => n !== i))}>✕</button>
          </div>
        );
      })}
      <button type="button" className="btn btn-small" onClick={() => setLines([...lines, { material_sku_id: '', qty: '', wastage_pct: '' }])}>+ Material</button>
      <Field label="Method notes (optional)"><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !valid} onClick={async () => {
        const r = await run<any>('save_recipe', { p: { sku_id: sku.id, output_qty: Number(out), notes,
          lines: lines.map((l) => ({ material_sku_id: l.material_sku_id, qty: Number(l.qty), wastage_pct: Number(l.wastage_pct) || 0 })) } },
          recipe ? 'Saved as a new version' : 'Recipe saved');
        if (r) onDone();
      }}>Save recipe</button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Runs
function Runs() {
  const { go, can } = useApp();
  const [filter, setFilter] = useState('planned');
  const list = useRpc<any[]>('list_production_orders', { p_status: filter === 'all' ? null : filter }, [filter]);
  const [plan, setPlan] = useState(false);
  return (
    <>
      {can('manager', 'warehouse') && <button type="button" className="btn btn-primary" onClick={() => setPlan(true)}>Plan a production run</button>}
      <Segmented value={filter} onChange={setFilter} options={[{ value: 'planned', label: 'Planned' }, { value: 'completed', label: 'Completed' }, { value: 'all', label: 'All' }]} />
      {list.error && <ErrorBox text={list.error} />}
      {list.data?.length === 0 && <Empty>No production runs here.</Empty>}
      <div className="list">
        {list.data?.map((r) => (
          <Card key={r.id} onClick={() => go(`production/runs/${r.id}`)}>
            <div className="row-between"><strong className="mono">{r.code}</strong><Badge status={r.status === 'completed' ? 'delivered' : r.status === 'cancelled' ? 'cancelled' : 'confirmed'}>{r.status}</Badge></div>
            <div>{r.sku_name}</div>
            <div className="muted small">{r.status === 'completed' ? `${qty(r.output_qty)} of ${qty(r.planned_qty)} packs · yield ${r.yield_pct}% · ${inr2(r.unit_cost)}/pack`
              : `${qty(r.planned_qty)} packs planned for ${date(r.planned_date)}`} · {r.location}</div>
          </Card>
        ))}
      </div>
      {plan && <PlanSheet onClose={() => setPlan(false)} onDone={(id) => { setPlan(false); go(`production/runs/${id}`); }} />}
    </>
  );
}

function PlanSheet({ onClose, onDone }: { onClose(): void; onDone(id: string): void }) {
  const recipes = useRpc<any[]>('list_recipes');
  const ref = useRpc<any>('get_reference_data');
  const [sku, setSku] = useState('');
  const [n, setN] = useState('');
  const [loc, setLoc] = useState('');
  const [when, setWhen] = useState(ymd());
  const { run, busy } = useAction();
  const places = (ref.data?.locations ?? []).filter((l: any) => ['warehouse', 'factory', 'contract_manufacturer'].includes(l.type));
  return (
    <Sheet title="Plan a production run" onClose={onClose}>
      {recipes.data?.length === 0 && <p className="notice small">Add a recipe first (Production → Recipes).</p>}
      <Field label="Product">
        <select value={sku} onChange={(e) => setSku(e.target.value)}>
          <option value="">— choose —</option>
          {recipes.data?.map((r) => <option key={r.sku.id} value={r.sku.id}>{r.sku.name}</option>)}
        </select>
      </Field>
      <Field label="Packs to make"><input inputMode="decimal" value={n} onChange={(e) => setN(num(e.target.value))} /></Field>
      <Field label="Where" hint="Materials are taken from stock at this location (a contract manufacturer's location for their runs)">
        <select value={loc} onChange={(e) => setLoc(e.target.value)}>
          <option value="">Main warehouse (default)</option>
          {places.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
      <Field label="Date"><input type="date" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !sku || !Number(n)} onClick={async () => {
        const r = await run<any>('create_production_order', { p: { sku_id: sku, planned_qty: Number(n), location_id: loc || null, planned_date: when } });
        if (r) onDone(r.production_order_id);
      }}>Plan run</button>
    </Sheet>
  );
}

function RunDetail({ id }: { id: string }) {
  const { can } = useApp();
  const q = useRpc<any>('get_production_order', { p_id: id }, [id]);
  const [complete, setComplete] = useState(false);
  const { run, busy } = useAction();
  if (q.error) return <Page title="Production run" back="production/runs"><ErrorBox text={q.error} /></Page>;
  if (!q.data) return <Page title="Production run" back="production/runs"><Loading /></Page>;
  const o = q.data;
  const short = o.requirements.some((r: any) => Number(r.short) > 0);
  return (
    <Page title={o.code} back="production/runs" actions={<Badge status={o.status === 'completed' ? 'delivered' : o.status === 'cancelled' ? 'cancelled' : 'confirmed'}>{o.status}</Badge>}>
      <Card>
        <strong>{o.sku.name}</strong>
        <div className="small">{o.status === 'completed' ? `Made ${qty(o.output_qty)} of ${qty(o.planned_qty)} planned (yield ${o.yield_pct}%)` : `${qty(o.planned_qty)} packs planned for ${date(o.planned_date)}`}</div>
        <div className="muted small">{o.location.name} · recipe version {o.recipe_version}{o.notes ? ` · ${o.notes}` : ''}</div>
      </Card>
      {o.status === 'planned' && (
        <>
          <h2 className="section">Materials needed</h2>
          <table className="tbl">
            <thead><tr><th>Material</th><th className="num">Needed</th><th className="num">Available here</th></tr></thead>
            <tbody>{o.requirements.map((r: any) => <tr key={r.material_sku_id}><td>{r.name}<div className="muted small mono">{r.code}</div></td>
              <td className="num">{qty(r.required)} {r.unit}</td>
              <td className={`num ${Number(r.short) > 0 ? 'bad' : 'ok'}`}>{qty(r.available)}{Number(r.short) > 0 ? ` (short ${qty(r.short)})` : ''}</td></tr>)}</tbody>
          </table>
          {short && <p className="notice small">Some materials are short at this location. Receive a purchase order or transfer stock here first.</p>}
          {can('manager', 'warehouse') && (
            <div className="row-gap">
              <button type="button" className="btn btn-primary" onClick={() => setComplete(true)}>Record production</button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={async () => {
                const reason = window.prompt('Why cancel this run?');
                if (reason && await run('cancel_production_order', { p_id: o.id, p_reason: reason }, 'Run cancelled')) q.reload();
              }}>Cancel run</button>
            </div>
          )}
        </>
      )}
      {o.status === 'completed' && (
        <>
          <div className="stats">
            <div className="stat"><div className="stat-value">{inr2(o.unit_cost)}</div><div className="stat-label">Cost per pack</div></div>
            <div className="stat"><div className="stat-value">{inr(o.material_cost)}</div><div className="stat-label">Materials</div></div>
            <div className="stat"><div className="stat-value">{inr(o.conversion_cost)}</div><div className="stat-label">Labour &amp; overheads</div></div>
          </div>
          {o.output_batch && <Card><div>Batch <strong className="mono">{o.output_batch.code}</strong> · expires {date(o.output_batch.expires_on)} · <Badge status={o.output_batch.qa_status} /></div>
            <a className="btn btn-small" href="#/labels" onClick={() => sessionStorage.setItem('tl-label', JSON.stringify({ kind: 'batch', code: o.output_batch.code, name: o.sku.name, expires_on: o.output_batch.expires_on, copies: Math.min(Number(o.output_qty), 60) }))}>Print batch labels</a></Card>}
          <h2 className="section">Materials used</h2>
          <table className="tbl">
            <thead><tr><th>Material · batch</th><th className="num">Used</th><th className="num">Standard</th><th className="num">Cost</th></tr></thead>
            <tbody>{o.consumptions.map((c: any, n: number) => <tr key={n}><td>{c.name}<div className="muted small mono">{c.batch}</div></td>
              <td className="num">{qty(c.qty)} {c.unit}</td><td className="num">{qty(c.standard_qty)}</td><td className="num">{inr2(Number(c.qty) * Number(c.unit_cost ?? 0))}</td></tr>)}</tbody>
          </table>
          <p className="muted small">Completed {dateTime(o.completed_at)}</p>
        </>
      )}
      {complete && <CompleteSheet order={o} onClose={() => setComplete(false)} onDone={() => { setComplete(false); q.reload(); }} />}
    </Page>
  );
}

function CompleteSheet({ order, onClose, onDone }: { order: any; onClose(): void; onDone(): void }) {
  const [out, setOut] = useState(String(Number(order.planned_qty)));
  const [mfg, setMfg] = useState(ymd());
  const [exp, setExp] = useState('');
  const [conv, setConv] = useState('');
  const [hold, setHold] = useState(false);
  const [actual, setActual] = useState<Record<string, string>>({});
  const [key] = useState(() => newKey('prd'));
  const { run, busy } = useAction();
  const scale = Number(out) / Number(order.planned_qty) || 0;
  return (
    <Sheet title={`Record production: ${order.code}`} onClose={onClose}>
      <Field label="Packs actually produced"><input className="input-big" inputMode="decimal" value={out} onChange={(e) => setOut(num(e.target.value))} /></Field>
      <div className="row-gap">
        <Field label="Made on"><input type="date" value={mfg} onChange={(e) => setMfg(e.target.value)} /></Field>
        <Field label="Expiry" hint="Blank = shelf life"><input type="date" value={exp} onChange={(e) => setExp(e.target.value)} /></Field>
      </div>
      <Field label="Labour and overheads for this run ₹" hint="Gas, power, wages — added to the batch cost"><input inputMode="decimal" value={conv} onChange={(e) => setConv(num(e.target.value))} /></Field>
      <h2 className="section">Materials actually used</h2>
      <p className="muted small">Pre-filled with the recipe standard for {out || 0} packs. Change any that differed. Stock is taken oldest expiry first.</p>
      {order.requirements.map((r: any) => (
        <Field key={r.material_sku_id} label={`${r.name} (${r.unit})`}>
          <input inputMode="decimal" placeholder={String(Math.round(Number(r.required) * scale * 1000) / 1000)}
            value={actual[r.material_sku_id] ?? ''} onChange={(e) => setActual({ ...actual, [r.material_sku_id]: num(e.target.value) })} />
        </Field>
      ))}
      <label className="row-gap small"><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} style={{ width: 'auto', minHeight: 0 }} /> Hold the batch for a quality check (can't be packed until released)</label>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !Number(out)} onClick={async () => {
        const r = await run<any>('complete_production', { p: { production_order_id: order.id, output_qty: Number(out), manufactured_on: mfg,
          expires_on: exp || null, conversion_cost: Number(conv) || 0, hold_for_qa: hold, idempotency_key: key,
          consumptions: Object.entries(actual).filter(([, v]) => v !== '').map(([k, v]) => ({ material_sku_id: k, qty: Number(v) })) } },
          'Production recorded');
        if (r) onDone();
      }}>Record production</button>
    </Sheet>
  );
}
