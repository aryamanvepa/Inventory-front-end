// Orders, organised the way the floor works:
//   Orders board → Process → (Make / Repack) → Pack → Dispatch → Invoice
// Each order card says in one word what has to happen next. "Process" walks
// the operator through only the steps that order needs, with a step bar at
// the bottom of the screen showing where they are.
//
// Mia Torte products are MADE from raw materials (recipe); Nutri Sampoorna
// products are REPACKED from bulk material (a one-line "recipe", e.g.
// 1 kg pouch = 1 kg bulk atta + 1 pouch). Both use the same production run.
import { useCallback, useEffect, useState } from 'react';
import { useApp, useRpc } from '../lib/app';
import { friendlyError, newKey } from '../lib/backend';
import { Scanner, feedback, useTestingMode } from '../components/Scanner';
import { ago, date, Empty, ErrorBox, inr, Loading, Page, qty, Segmented, ymd } from '../components/ui';
import { useT, type T } from '../lib/i18n';
import { Avatar, ICONS, Icon, LangButton, QtyPad, type Batch, type Detail, type Item } from './Inventory';
import { OrderCustomer, PackPanel } from './Pack';
import { DispatchForm } from './Dispatch';

const REPACK_BRANDS = ['NS'];                 // white-label lines: bulk material is repacked, not cooked

type Ctx = { items: Map<string, Item>; recipes: Map<string, any>; skus: Map<string, any> };

async function loadCtx(backend: { rpc<X>(fn: string, a?: Record<string, unknown>): Promise<X> }): Promise<Ctx> {
  const [items, recipes, skus] = await Promise.all([
    backend.rpc<Item[]>('inv_items'), backend.rpc<any[]>('list_recipes'), backend.rpc<any[]>('list_skus'),
  ]);
  return {
    items: new Map(items.map((i) => [i.id, i])),
    recipes: new Map(recipes.filter(Boolean).map((r) => [r.sku.id, r])),
    skus: new Map(skus.map((s) => [s.id, s])),
  };
}

type Need = { material_sku_id: string; name: string; unit: string; need: number; free: number; short: number };
type ShortLine = { sku_id: string; name: string; short: number; recipe: any | null; repack: boolean; makeQty: number; needs: Need[] };
type Kind = 'ready' | 'make' | 'rm_short' | 'no_recipe' | 'unpaid' | 'packed' | 'sent' | 'failed';
type Assessment = { kind: Kind; brands: { code: string; name: string }[]; repack: boolean; shortLines: ShortLine[] };

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// Material needed for a quantity of output (same formula as the database's production requirements)
function needsFor(recipe: any, makeQty: number, items: Map<string, Item>): Need[] {
  return recipe.lines.map((l: any) => {
    const need = r3((Number(l.qty) * (1 + Number(l.wastage_pct) / 100) * makeQty) / Number(recipe.output_qty));
    const free = Math.max(0, Number(items.get(l.material_sku_id)?.free ?? 0));
    return { material_sku_id: l.material_sku_id, name: l.name, unit: l.unit, need, free, short: r3(Math.max(0, need - free)) };
  });
}

// What has to happen next for this order
function assess(o: any, ctx: Ctx): Assessment {
  const seen = new Map<string, string>();
  for (const l of o.lines) seen.set(ctx.skus.get(l.sku_id)?.brand_code ?? l.brand, l.brand);
  const base = { brands: [...seen].map(([code, name]) => ({ code, name })), repack: false, shortLines: [] as ShortLine[] };
  if (o.status === 'pending_payment') return { ...base, kind: 'unpaid' };
  if (o.status === 'delivery_failed') return { ...base, kind: 'failed' };
  if (['dispatched', 'delivered'].includes(o.status)) return { ...base, kind: 'sent' };
  if (o.status === 'packed') return { ...base, kind: 'packed' };
  if (!o.stock_shortfall) return { ...base, kind: 'ready' };

  const bySku = new Map<string, { name: string; qty: number }>();
  for (const l of o.lines) bySku.set(l.sku_id, { name: l.sku_name, qty: (bySku.get(l.sku_id)?.qty ?? 0) + Number(l.qty) });
  const shortLines: ShortLine[] = [];
  for (const [sku_id, v] of bySku) {
    const short = r3(v.qty - Math.max(0, Number(ctx.items.get(sku_id)?.free ?? 0)));
    if (short <= 0) continue;
    const recipe = ctx.recipes.get(sku_id) ?? null;
    const repack = REPACK_BRANDS.includes(ctx.skus.get(sku_id)?.brand_code);
    let makeQty = short;
    let needs: Need[] = [];
    if (recipe) {
      // suggest a full recipe batch when there is material for it; otherwise just what the order needs
      const full = Math.ceil(short / Number(recipe.output_qty)) * Number(recipe.output_qty);
      const fullNeeds = needsFor(recipe, full, ctx.items);
      if (fullNeeds.every((n) => n.short === 0)) { makeQty = full; needs = fullNeeds; } else needs = needsFor(recipe, short, ctx.items);
    }
    shortLines.push({ sku_id, name: v.name, short, recipe, repack, makeQty, needs });
  }
  if (shortLines.length === 0) return { ...base, kind: 'ready' };
  const repack = shortLines.every((s) => s.repack);
  if (shortLines.some((s) => !s.recipe)) return { ...base, repack, shortLines, kind: 'no_recipe' };
  const total = new Map<string, { need: number; free: number }>();
  for (const s of shortLines) for (const n of s.needs) {
    const t = total.get(n.material_sku_id) ?? { need: 0, free: n.free };
    t.need += n.need; total.set(n.material_sku_id, t);
  }
  const rmShort = [...total.values()].some((x) => x.need > x.free + 1e-9);
  return { ...base, repack, shortLines, kind: rmShort ? 'rm_short' : 'make' };
}

function BrandTags({ brands }: { brands: { code: string; name: string }[] }) {
  return <span className="brand-tags">{brands.map((b) => <span key={b.code} className={`brand-tag brand-${b.code}`}>{b.name}</span>)}</span>;
}

// ---------------------------------------------------------------------
// Orders board
// ---------------------------------------------------------------------
type Row = { o: any; a: Assessment };
const ORDER: Kind[] = ['ready', 'make', 'rm_short', 'no_recipe', 'packed', 'failed', 'unpaid', 'sent'];

export function OrderBoard() {
  const { backend, go, can, toast } = useApp();
  const { t, lang, setLang } = useT();
  const [view, setView] = useState<'todo' | 'sent'>('todo');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, ctx] = await Promise.all([backend.rpc<any[]>('list_orders', { p_filter: 'open' }), loadCtx(backend)]);
      const details = await Promise.all(list.map((o) => backend.rpc<any>('get_order', { p_order_id: o.id })));
      setRows(details.map((o) => ({ o, a: assess(o, ctx) })));
      setErr(null);
    } catch (e) { setErr(friendlyError(e)); }
  }, [backend]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const todo = (rows ?? []).filter((r) => r.a.kind !== 'sent')
    .sort((x, y) => ORDER.indexOf(x.a.kind) - ORDER.indexOf(y.a.kind) || x.o.placed_at.localeCompare(y.o.placed_at));
  const sent = (rows ?? []).filter((r) => r.a.kind === 'sent').sort((x, y) => (y.o.dispatched_at ?? '').localeCompare(x.o.dispatched_at ?? ''));
  const shown = view === 'todo' ? todo : sent;

  return (
    <Page title={t('orders')} actions={<LangButton lang={lang} setLang={setLang} />}>
      {can('manager', 'viewer') && <a className="link small" href="#/dashboard">{t('dashboard_link')}</a>}
      <Scanner placeholder={t('scan_order')} autoFocus={false}
        hints={todo.map(({ o }) => ({ code: o.code, label: `${o.customer?.name ?? o.ship_to?.name ?? ''}` }))} onScan={async (code) => {
        try {
          const o = await backend.rpc<any>('find_order', { p_code: code });
          if (o) go(`work/${o.id}`); else toast(t('no_order', { code }), 'error');
        } catch (e) { toast(friendlyError(e), 'error'); }
      }} />
      <Segmented value={view} onChange={setView} options={[
        { value: 'todo', label: `${t('to_do')} (${todo.length})` }, { value: 'sent', label: `${t('sent')} (${sent.length})` }]} />
      {err && <ErrorBox text={err} onRetry={load} />}
      {!rows && !err && <Loading text={t('loading')} />}
      {rows && shown.length === 0 && <Empty>{view === 'todo' ? t('nothing_to_do') : t('nothing_sent')}</Empty>}
      <div className="list">
        {shown.map(({ o, a }) => <OrderCard key={o.id} o={o} a={a} t={t} />)}
      </div>
    </Page>
  );
}

function kindLabel(a: Assessment, t: T) {
  switch (a.kind) {
    case 'ready': return t('k_ready');
    case 'make': return a.repack ? t('k_repack') : t('k_make');
    case 'rm_short': return t('k_rm_short');
    case 'no_recipe': return t('k_no_recipe');
    case 'packed': return t('k_packed');
    case 'sent': return t('k_sent');
    case 'unpaid': return t('k_unpaid');
    default: return t('k_failed');
  }
}

function OrderCard({ o, a, t }: { o: any; a: Assessment; t: T }) {
  const { can } = useApp();
  const process = `#/work/${o.id}`;
  const action = (() => {
    switch (a.kind) {
      case 'ready': case 'make': return { href: process, label: t('process') + ' →', primary: true };
      case 'rm_short': case 'no_recipe': return { href: process, label: t('see_short'), primary: false };
      case 'packed': return { href: process, label: t('dispatch') + ' →', primary: true };
      case 'sent': return { href: process, label: t('invoice'), primary: false };
      default: return can('manager') ? { href: `#/orders/${o.id}`, label: t('open_order'), primary: false } : null;
    }
  })();
  return (
    <div className={`order-card k-${a.kind}`}>
      <div className="row-between"><strong className="mono">{o.code}</strong><span className="muted small">{ago(o.placed_at)}</span></div>
      <BrandTags brands={a.brands} />
      <div>{o.customer?.name ?? o.ship_to?.name}{o.ship_to?.city ? ` · ${o.ship_to.city}` : ''}</div>
      <div className="muted small">{o.lines.map((l: any) => `${l.sku_name} × ${qty(l.qty)}`).join(', ')}</div>
      <div className="order-foot">
        <span className={`kind kind-${a.kind}`}>{kindLabel(a, t)}</span>
        {action && <a className={`btn ${action.primary ? 'btn-go go-in' : ''}`} href={action.href}>{action.label}</a>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Process one order
// ---------------------------------------------------------------------
type Step = 'make' | 'pack' | 'dispatch' | 'done';

export function ProcessOrder({ orderId }: { orderId: string }) {
  const { backend, can, go } = useApp();
  const { t, lang, setLang } = useT();
  const [o, setO] = useState<any>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // remember that this order went through Make/Repack, so the step bar keeps showing it (✓)
  const madeKey = `tl-made-${orderId}`;
  const [made, setMadeState] = useState(() => { try { return sessionStorage.getItem(madeKey) === '1'; } catch { return false; } });
  const setMade = (v: boolean) => { setMadeState(v); try { sessionStorage.setItem(madeKey, v ? '1' : '0'); } catch { /* ignore */ } };
  const ref = useRpc<any>('get_reference_data');

  const reload = useCallback(async () => {
    try {
      const [ord, c] = await Promise.all([backend.rpc<any>('get_order', { p_order_id: orderId }), loadCtx(backend)]);
      setO(ord); setCtx(c); setErr(null);
    } catch (e) { setErr(friendlyError(e)); }
  }, [backend, orderId]);
  useEffect(() => { reload(); }, [reload]);

  const a = o && ctx ? assess(o, ctx) : null;
  // stock is there but the order isn't holding it yet (e.g. just made): reserve it now
  useEffect(() => {
    if (a?.kind === 'ready' && o.stock_shortfall && can('warehouse', 'manager')) {
      backend.rpc('retry_order_reservation', { p_order_id: o.id }).then(reload).catch(() => { /* shown in the pack step */ });
    }
  }, [a?.kind, o?.stock_shortfall]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <Page title={t('orders')} back="work"><ErrorBox text={err} onRetry={reload} /></Page>;
  if (!o || !a || !ctx) return <Page title={t('orders')} back="work"><Loading text={t('loading')} /></Page>;

  const makeKinds: Kind[] = ['make', 'rm_short', 'no_recipe'];
  const current: Step | null = makeKinds.includes(a.kind) ? 'make'
    : a.kind === 'ready' ? 'pack' : a.kind === 'packed' ? 'dispatch' : a.kind === 'sent' ? 'done' : null;
  const steps: Step[] = [...(made || makeKinds.includes(a.kind) ? ['make' as Step] : []), 'pack', 'dispatch', 'done'];

  return (
    <Page narrow title={o.code} back="work" actions={<LangButton lang={lang} setLang={setLang} />}>
      {current && <StepBar steps={steps} current={current} t={t} repack={a.repack} />}
      <BrandTags brands={a.brands} />
      <OrderCustomer o={o} />

      {a.kind === 'unpaid' && <div className="blocked"><Icon d={ICONS.wait} size={36} /><p>{t('not_paid')}</p>
        {can('manager') && <a className="btn" href={`#/orders/${o.id}`}>{t('open_order')}</a>}</div>}
      {a.kind === 'failed' && <div className="blocked"><Icon d={ICONS.wait} size={36} /><p>{t('k_failed')}</p>
        {can('manager') && <a className="btn" href={`#/orders/${o.id}`}>{t('open_order')}</a>}</div>}

      {current === 'make' && (
        <MakeStep key={a.shortLines[0].sku_id} line={a.shortLines[0]} more={a.shortLines.length - 1} ctx={ctx} t={t} back={`work/${o.id}`}
          onMade={() => setMade(true)} onContinue={reload} />
      )}

      {current === 'pack' && (
        <>
          <h2 className="flow-title">{t('step_pack')}</h2>
          <PackPanel order={o} setOrder={setO} t={t} onPacked={reload} />
        </>
      )}

      {current === 'dispatch' && (
        <>
          <h2 className="flow-title">{t('step_dispatch')}</h2>
          {o.payment_status === 'cod_pending' && <div className="notice">{t('collect_cod', { amount: inr(o.total_amount) })}</div>}
          {ref.data ? <DispatchForm order={o} providers={ref.data.providers} t={t} onDone={reload} /> : <Loading />}
        </>
      )}

      {current === 'done' && <DoneStep o={o} t={t} />}

      {current === 'done' && <button type="button" className="btn btn-ghost" onClick={() => go('work')}>{t('back_orders')}</button>}
    </Page>
  );
}

function StepBar({ steps, current, t, repack }: { steps: Step[]; current: Step; t: T; repack: boolean }) {
  const at = steps.indexOf(current);
  return (
    <nav className="stepbar" aria-label={t('steps')}>
      {steps.map((s, i) => (
        <span key={s} className={i === at ? 'on' : i < at ? 'done' : ''} aria-current={i === at ? 'step' : undefined}>
          <b>{i < at ? '✓' : i + 1}</b>{s === 'make' && repack ? t('step_repack') : t(`step_${s}`)}
        </span>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------
// Make (Mia Torte) / Repack (Nutri Sampoorna)
// ---------------------------------------------------------------------
function MakeStep({ line, more, ctx, t, back, onMade, onContinue, forOrder = true }: {
  line: ShortLine; more: number; ctx: Ctx; t: T; back: string; onMade(): void; onContinue(): void; forOrder?: boolean;
}) {
  const { backend, can, go } = useApp();
  const [makeQty, setMakeQty] = useState(String(line.makeQty));
  const [mats, setMats] = useState<Record<string, Detail>>({});
  const [ticked, setTicked] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [stage, setStage] = useState<'list' | 'confirm' | 'made'>('list');
  const [actual, setActual] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [key, setKey] = useState(() => newKey('make'));
  const sku = ctx.skus.get(line.sku_id);
  const item = ctx.items.get(line.sku_id);
  const testing = useTestingMode();

  useEffect(() => {
    if (!line.recipe) return;
    Promise.all(line.recipe.lines.map((l: any) => backend.rpc<Detail>('inv_item', { p_sku_id: l.material_sku_id })))
      .then((ds) => setMats(Object.fromEntries(ds.map((d) => [d.id, d])))).catch(() => { /* list still works without batch hints */ });
  }, [line.sku_id, backend]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = line.repack ? t('repack_title', { name: line.name }) : t('make_title', { name: line.name });

  if (!line.recipe) {
    return (
      <div className="stack">
        <h2 className="flow-title">{title}</h2>
        <div className="blocked"><Icon d={ICONS.wait} size={36} /><p>{t('no_recipe_msg')}</p></div>
        {can('manager') && <a className="btn btn-big" href="#/production/recipes">{t('add_recipe')}</a>}
      </div>
    );
  }

  const mq = Number(makeQty) || 0;
  const needs = needsFor(line.recipe, mq, ctx.items);
  const short = needs.filter((n) => n.short > 0);
  const suggested = (id: string): Batch | undefined => mats[id]?.batches.find((b) => !b.expired && !b.on_hold && Number(b.qty) > 0);
  const allTicked = needs.every((n) => ticked[n.material_sku_id]);
  const canMake = can('warehouse', 'manager');

  const onScan = async (code: string) => {
    try {
      const r = await backend.rpc<any>('resolve_scan', { p_code: code });
      if (r.kind === 'unknown') { feedback(false); setMsg({ ok: false, text: t('unknown', { code }) }); return; }
      const n = needs.find((x) => x.material_sku_id === r.sku?.id);
      if (!n) { feedback(false); setMsg({ ok: false, text: t('not_in_recipe', { name: r.sku?.name ?? code }) }); return; }
      if (r.batch) {
        const s = suggested(n.material_sku_id);
        if (r.batch.expires_on && r.batch.expires_on < ymd()) {
          feedback(false); setMsg({ ok: false, text: t('batch_expired', { code: r.batch.code }) }); return;
        }
        if (s && s.id !== r.batch.id && s.expires_on && r.batch.expires_on > s.expires_on) {
          feedback(false); setMsg({ ok: false, text: t('fifo_warn', { code: s.code, date: date(s.expires_on) }) }); return;
        }
      }
      feedback(true);
      setTicked((x) => ({ ...x, [n.material_sku_id]: r.batch?.code ?? '✓' }));
      setMsg({ ok: true, text: `✓ ${n.name}` });
    } catch (e) { feedback(false); setMsg({ ok: false, text: friendlyError(e) }); }
  };

  const make = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await backend.rpc<any>('inv_stock_in', { p: { sku_id: line.sku_id, qty: Number(actual), source: 'kitchen', idempotency_key: key } });
      feedback(true); setResult(r); setStage('made'); onMade();
    } catch (e) { feedback(false); setMsg({ ok: false, text: friendlyError(e) }); } finally { setBusy(false); }
  };

  // ----- after making -----
  if (stage === 'made' && result) {
    const copies = Math.min(Math.ceil(Number(actual)), 500);
    return (
      <div className="stack">
        <div className="done-hero ok">
          <span className="done-circle"><Icon d={ICONS.check} size={56} /></span>
          <strong>{line.repack ? t('repacked_n', { n: qty(actual) }) : t('made_n', { n: qty(actual) })}</strong>
          <span>{line.name}</span>
          {result.batch && <span className="small">{t('batch')} <span className="mono">{result.batch.code}</span> · {t('best_before')} {date(result.batch.expires_on)}</span>}
        </div>
        {result.batch && (
          <button type="button" className="btn btn-big btn-go go-stickers" onClick={() => {
            try {
              sessionStorage.setItem('tl-label', JSON.stringify({ kind: 'batch', sku_id: line.sku_id, code: result.batch.code, name: line.name,
                expires_on: result.batch.expires_on, copies, back }));
            } catch { /* ignore */ }
            go('labels');
          }}><Icon d={ICONS.stickers} size={22} /> {t('print_n', { n: copies })}</button>
        )}
        <button type="button" className="btn btn-big btn-go go-in" onClick={() => { setStage('list'); setTicked({}); setKey(newKey('make')); onContinue(); }}>
          {t('continue')} →
        </button>
      </div>
    );
  }

  // ----- confirm -----
  if (stage === 'confirm') {
    return (
      <div className="stack">
        <h2 className="flow-title">{title}</h2>
        <QtyPad value={actual} onChange={setActual} item={item ?? ({ item_type: 'finished', unit: 'pcs' } as Item)} t={t}
          label={line.repack ? t('how_many_repacked') : t('how_many_made')} />
        <p className="muted small">{t('materials_auto')}</p>
        {msg && <div className={`scan-result ${msg.ok ? 'ok' : 'bad'}`} role="alert">{msg.text}</div>}
        <button type="button" className="btn btn-big btn-go go-in" disabled={busy || !(Number(actual) > 0)} onClick={make}>
          {busy ? t('loading') : t('yes_made', { n: qty(actual || 0) })}
        </button>
        <button type="button" className="btn btn-big" disabled={busy} onClick={() => setStage('list')}>{t('go_back')}</button>
      </div>
    );
  }

  // ----- checklist -----
  const price = sku?.web_price != null ? Number(sku.web_price) : null;
  const priceEx = price != null ? price / (1 + Number(sku?.gst_rate ?? 0) / 100) : null;
  const cpu = line.recipe.standard_cost_per_unit != null ? Number(line.recipe.standard_cost_per_unit) : null;
  const margin = priceEx && cpu != null ? Math.round((1000 * (priceEx - cpu)) / priceEx) / 10 : null;

  return (
    <div className="stack">
      <h2 className="flow-title">{title}</h2>
      <p className="muted">{forOrder || line.short > 0 ? t(forOrder ? 'order_needs' : 'orders_need', { n: qty(line.short), per: qty(line.recipe.output_qty) }) : t('per_batch', { per: qty(line.recipe.output_qty) })}{more > 0 ? ` · ${t('more_products', { n: more })}` : ''}</p>
      {short.length > 0 && (
        <div className="rm-short" role="alert">
          <h3>{t('rm_out_title')}</h3>
          <table className="tbl">
            <thead><tr><th>{t('material')}</th><th className="num">{t('need')}</th><th className="num">{t('have')}</th><th className="num">{t('short')}</th></tr></thead>
            <tbody>{short.map((n) => (
              <tr key={n.material_sku_id}><td>{n.name}</td><td className="num">{qty(n.need)} {n.unit}</td><td className="num">{qty(n.free)}</td>
                <td className="num bad"><strong>{qty(n.short)}</strong></td></tr>))}</tbody>
          </table>
          {can('manager', 'accountant') ? (
            <button type="button" className="btn btn-big btn-go go-out" onClick={() => {
              try { sessionStorage.setItem('tl-po-prefill', JSON.stringify({ lines: short.map((n) => ({ sku_id: n.material_sku_id, qty: Math.ceil(n.short) })) })); } catch { /* ignore */ }
              go('purchasing/orders');
            }}>{t('order_rm')}</button>
          ) : <p className="small"><strong>{t('show_manager')}</strong></p>}
        </div>
      )}
      <QtyPad value={makeQty} onChange={(v) => { setMakeQty(v); setTicked({}); }} item={item ?? ({ item_type: 'finished', unit: 'pcs' } as Item)} t={t}
        label={line.repack ? t('how_many_to_repack') : t('how_many_to_make')} />
      {forOrder && mq > 0 && mq < line.short && <div className="notice small">{t('less_than_order', { n: qty(line.short) })}</div>}

      {short.length === 0 && (
        <>
          <h3 className="group-title">{line.repack ? t('scan_bulk') : t('scan_each_rm')}</h3>
          <ul className="rm-list">
            {needs.map((n) => {
              const s = suggested(n.material_sku_id);
              const done = ticked[n.material_sku_id];
              return (
                <li key={n.material_sku_id} className={done ? 'done' : ''}>
                  <span className="check" aria-hidden="true">{done ? '✓' : ''}</span>
                  <div className="grow">
                    <strong>{n.name}</strong> <span className="rm-qty">{qty(n.need)} {t(n.unit as 'kg')}</span>
                    <div className="small muted">
                      {done ? (done === '✓' ? t('ticked') : `${t('batch')} ${done}`)
                        : s ? t('take_from', { code: s.code, date: date(s.expires_on) }) : `${qty(n.free)} ${t(n.unit as 'kg')} ${t('on_shelf')}`}
                    </div>
                    {!done && <button type="button" className="link small tick-link" onClick={() => setTicked((x) => ({ ...x, [n.material_sku_id]: '✓' }))}>{t('tick_by_hand')}</button>}
                  </div>
                </li>
              );
            })}
          </ul>
          {testing && canMake && !allTicked && (
            <button type="button" className="btn scan-override bypass-btn" onClick={() => {
              setTicked(Object.fromEntries(needs.map((n) => [n.material_sku_id, suggested(n.material_sku_id)?.code ?? '✓'])));
              setMsg({ ok: true, text: t('bypass_done') });
            }}><span className="test-tag">TEST</span> {t('bypass_tick')}</button>
          )}
          {canMake && <Scanner onScan={onScan} placeholder={t('scan_title')} autoFocus={false}
            hints={needs.flatMap((n) => (mats[n.material_sku_id]?.batches ?? []).filter((b) => b.id && !b.expired)
              .map((b) => ({ code: b.code, label: `${n.name} · ${t('best_before')} ${date(b.expires_on)}` })))} />}
          {msg && <div className={`scan-result ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</div>}
        </>
      )}

      <div className="mis-box">
        <div className="mis-title">{t('mis_title')}</div>
        <div className="mis-grid">
          <span>{t('cost_batch')}</span><strong>{cpu != null ? inr(cpu * mq) : '—'}</strong>
          <span>{t('cost_pack')}</span><strong>{cpu != null ? inr(cpu, 2) : '—'}</strong>
          <span>{t('sells_at')}</span><strong>{price != null ? inr(price) : '—'}</strong>
          <span>{t('margin')}</span><strong className={margin != null && margin < 30 ? 'bad' : ''}>{margin != null ? `${margin}%` : '—'}</strong>
        </div>
        {Number(line.recipe.missing_costs) > 0 && <div className="small warn-text">{t('missing_costs')}</div>}
      </div>

      {canMake ? (
        <button type="button" className="btn btn-big btn-go go-in" disabled={short.length > 0 || !allTicked || !(mq > 0)}
          onClick={() => { setActual(String(mq)); setMsg(null); setStage('confirm'); }}>
          {short.length > 0 ? t('cant_make_short') : allTicked ? (line.repack ? t('repack_now') : t('make_now')) + ' →' : t('tick_all_first')}
        </button>
      ) : <div className="notice">{t('ask_warehouse')}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------
// Sent: invoice
// ---------------------------------------------------------------------
function DoneStep({ o, t }: { o: any; t: T }) {
  const inv = useRpc<any>('invoice_for_order', { p_order_id: o.id });
  const sh = o.shipments?.[0];
  return (
    <div className="stack">
      <div className="done-hero ok">
        <span className="done-circle"><Icon d={ICONS.check} size={56} /></span>
        <strong>{o.status === 'delivered' ? t('delivered') : t('k_sent')}</strong>
        {sh && <span>{sh.provider}{sh.booking_ref ? ` · ${sh.booking_ref}` : ''}</span>}
      </div>
      {inv.data ? (
        <a className="btn btn-big btn-go go-find" href={`#/invoice/${inv.data.id}`}>{t('open_invoice', { code: inv.data.code })}</a>
      ) : inv.loading ? <Loading /> : <div className="notice">{t('invoice_pending')}</div>}
      {sh?.tracking_url && <a className="btn" href={sh.tracking_url} target="_blank" rel="noreferrer">{t('track')}</a>}
    </div>
  );
}

// ---------------------------------------------------------------------
// Process tab: everything waiting to be made / repacked, and making for stock
// ---------------------------------------------------------------------
type Demand = { sku_id: string; name: string; short: number; orders: string[]; kind: Kind; repack: boolean };

function demandByProduct(rows: Row[]): Demand[] {
  const m = new Map<string, Demand>();
  for (const { o, a } of rows) {
    for (const s of a.shortLines) {
      const d = m.get(s.sku_id) ?? { sku_id: s.sku_id, name: s.name, short: 0, orders: [], kind: a.kind, repack: s.repack };
      d.short = r3(d.short + s.short); d.orders.push(o.code);
      if (!s.recipe) d.kind = 'no_recipe'; else if (s.needs.some((n) => n.short > 0) && d.kind !== 'no_recipe') d.kind = 'rm_short';
      m.set(s.sku_id, d);
    }
  }
  return [...m.values()];
}

async function loadRows(backend: { rpc<X>(fn: string, a?: Record<string, unknown>): Promise<X> }, ctx: Ctx): Promise<Row[]> {
  const list = await backend.rpc<any[]>('list_orders', { p_filter: 'open' });
  const short = list.filter((o) => o.stock_shortfall && ['confirmed', 'packing'].includes(o.status));
  const details = await Promise.all(short.map((o) => backend.rpc<any>('get_order', { p_order_id: o.id })));
  return details.map((o) => ({ o, a: assess(o, ctx) }));
}

export function MakeBoard() {
  const { backend } = useApp();
  const { t, lang, setLang } = useT();
  const [data, setData] = useState<{ ctx: Ctx; demand: Demand[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const ctx = await loadCtx(backend);
      setData({ ctx, demand: demandByProduct(await loadRows(backend, ctx)) }); setErr(null);
    } catch (e) { setErr(friendlyError(e)); }
  }, [backend]);
  useEffect(() => { load(); }, [load]);

  const products = data ? [...data.ctx.recipes.values()].map((r) => data.ctx.items.get(r.sku.id)).filter(Boolean) as Item[] : [];
  return (
    <Page title={t('process')} actions={<LangButton lang={lang} setLang={setLang} />}>
      {err && <ErrorBox text={err} onRetry={load} />}
      {!data && !err && <Loading text={t('loading')} />}
      {data && (
        <>
          <h2 className="section">{t('for_orders')} <span className="count">{data.demand.length}</span></h2>
          {data.demand.length === 0 && <Empty>{t('nothing_to_make')}</Empty>}
          <div className="list">
            {data.demand.map((d) => (
              <a key={d.sku_id} className={`order-card k-${d.kind}`} href={`#/make/${d.sku_id}`}>
                <div className="row-between"><strong>{d.name}</strong>
                  <span className={`kind kind-${d.kind}`}>{d.kind === 'make' ? (d.repack ? t('k_repack') : t('k_make')) : d.kind === 'rm_short' ? t('k_rm_short') : t('k_no_recipe')}</span></div>
                <div className="small">{t('short_for_orders', { n: qty(d.short), orders: d.orders.join(', ') })}</div>
              </a>
            ))}
          </div>
          <h2 className="section">{t('for_stock')}</h2>
          {products.length === 0 && <Empty>{t('no_recipes_yet')}</Empty>}
          <div className="pick-grid">
            {products.map((i) => {
              const repack = REPACK_BRANDS.includes(data.ctx.skus.get(i.id)?.brand_code);
              return (
                <a key={i.id} className="pick" href={`#/make/${i.id}`}>
                  <Avatar item={i} />
                  <span className="pick-name">{i.name}</span>
                  <span className={`small ${i.low ? 'bad' : 'muted'}`}>{qty(i.free)} {t('packs')} · {repack ? t('step_repack') : t('step_make')}</span>
                </a>
              );
            })}
          </div>
        </>
      )}
    </Page>
  );
}

export function MakeForStock({ skuId }: { skuId: string }) {
  const { backend, go } = useApp();
  const { t, lang, setLang } = useT();
  const [state, setState] = useState<{ ctx: Ctx; line: ShortLine } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const ctx = await loadCtx(backend);
      const demand = demandByProduct(await loadRows(backend, ctx)).find((d) => d.sku_id === skuId);
      const recipe = ctx.recipes.get(skuId) ?? null;
      const name = ctx.items.get(skuId)?.name ?? '';
      const short = demand?.short ?? 0;
      const out = recipe ? Number(recipe.output_qty) : 1;
      const makeQty = Math.max(out, Math.ceil(short / out) * out);
      setState({ ctx, line: { sku_id: skuId, name, short, recipe, repack: REPACK_BRANDS.includes(ctx.skus.get(skuId)?.brand_code),
        makeQty, needs: recipe ? needsFor(recipe, makeQty, ctx.items) : [] } });
      setErr(null);
    } catch (e) { setErr(friendlyError(e)); }
  }, [backend, skuId]);
  useEffect(() => { load(); }, [load]);
  return (
    <Page narrow title={t('process')} back="make" actions={<LangButton lang={lang} setLang={setLang} />}>
      {err && <ErrorBox text={err} onRetry={load} />}
      {!state && !err && <Loading text={t('loading')} />}
      {state && <MakeStep line={state.line} more={0} ctx={state.ctx} t={t} back={`make/${skuId}`} forOrder={false}
        onMade={() => { /* stock is reserved for waiting orders automatically */ }} onContinue={() => go('make')} />}
    </Page>
  );
}
