// Simple stock screens for floor staff.
// Every task is the same four steps: scan (or pick) the item → choose →
// how many → "Yes". Big buttons, few words, English or Hindi, and the
// system picks the batch, location and accounting route.
import { useEffect, useState, type ReactNode } from 'react';
import { useApp, useRpc } from '../lib/app';
import { friendlyError, newKey } from '../lib/backend';
import { Scanner, feedback } from '../components/Scanner';
import { dateTime, date, Empty, ErrorBox, Field, inr, Loading, Page, qty, Segmented, Sheet } from '../components/ui';
import { LANGS, useT, type Lang, type T } from '../lib/i18n';

export type Item = {
  id: string; code: string; name: string; item_type: 'finished' | 'raw_material' | 'packaging'; brand: string | null;
  unit: string; pack_size: number; mrp: number | null; barcode: string; gtin: string | null;
  on_shelf: number; free: number; reorder_level: number; low: boolean; is_batch_tracked: boolean; shelf_life_days: number | null;
};
export type Batch = { id: string; code: string; qty: number; expires_on: string | null; days_left: number | null; expired: boolean; on_hold: boolean };
export type Detail = Item & {
  location: string; reserved: number; batches: Batch[]; pending_counts: number;
  incoming: { po_line_id: string; po_code: string; supplier: string; remaining: number; expected_date: string | null }[];
  kitchen: null | { planned: { code: string; planned_qty: number } | null; has_recipe: boolean; can_make: boolean };
};
type Action = 'in' | 'out' | 'count' | 'find';

// ---------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------
export const ICONS = {
  in: 'M12 3v11M7 9.5l5 5 5-5M4 16v4h16v-4',
  out: 'M12 14V3M7 7.5l5-5 5 5M4 16v4h16v-4',
  count: 'M9 3h6v3H9zM7 4.5H5V21h14V4.5h-2M8.5 11.5l2 2 4-4M8.5 17h7',
  find: 'M10.5 4a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM20 20l-4.8-4.8',
  stickers: 'M4 5v14M7 5v14M10 5v14M13.5 5v14M16 5v14M20 5v14',
  kitchen: 'M7 14h10v6H7zM6.5 14A4 4 0 017 6.1a5 5 0 019.9.1A4 4 0 0117.5 14',
  truck: 'M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19a2 2 0 100-4 2 2 0 000 4zM17 19a2 2 0 100-4 2 2 0 000 4z',
  damaged: 'M4 7.5l8-4 8 4v9l-8 4-8-4zM12 3.5l-1.5 6 3 2.5-2 8.5',
  expired: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5.5l3.5 2',
  sample: 'M4 10h16v10H4zM3 7h18v3H3zM12 7v13M12 7C10 3 6 3.5 7 6.5M12 7c2-4 6-3.5 5-.5',
  book: 'M5 4.5h11a3 3 0 013 3V20H8a3 3 0 01-3-3zM5 17a3 3 0 013-3h11',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  wait: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5h4',
};

export function Icon({ d, size = 28 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const unitWord = (t: T, item: { item_type: string; unit: string }) =>
  item.item_type === 'finished' ? t('packs') : t(item.unit as 'kg');
const decimalUnit = (item: Item) => item.item_type !== 'finished' && ['kg', 'l'].includes(item.unit);
const initials = (name: string) => name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const touchDevice = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

export function Avatar({ item }: { item: Pick<Item, 'name' | 'item_type'> }) {
  return <span className={`avatar av-${item.item_type}`} aria-hidden="true">{initials(item.name)}</span>;
}

export function LangButton({ lang, setLang }: { lang: Lang; setLang(l: Lang): void }) {
  const other: Lang = lang === 'en' ? 'hi' : 'en';
  return <button type="button" className="btn btn-small lang-btn" onClick={() => setLang(other)} lang={other}>{LANGS[other].name}</button>;
}

export function ItemHead({ item, t, batch, showStock = true, onChange }: {
  item: Item; t: T; batch?: { code: string } | null; showStock?: boolean; onChange?: () => void;
}) {
  return (
    <div className="item-head">
      <Avatar item={item} />
      <div className="grow">
        <div className="item-name">{item.name}</div>
        <div className="muted small">
          {showStock ? `${qty(item.on_shelf)} ${unitWord(t, item)} ${t('on_shelf')}` : <span className="mono">{item.code}</span>}
          {batch && <> · <span className="chip">{t('this_batch', { code: batch.code })}</span></>}
        </div>
      </div>
      {onChange && <button type="button" className="btn btn-small" onClick={onChange}>{t('change')}</button>}
    </div>
  );
}

export function Choice({ icon, title, hint, tone = '', onClick, selected }: {
  icon: string; title: ReactNode; hint?: ReactNode; tone?: string; onClick(): void; selected?: boolean;
}) {
  return (
    <button type="button" className={`choice ${tone ? 'ch-' + tone : ''} ${selected ? 'on' : ''}`} onClick={onClick} aria-pressed={selected}>
      <span className="choice-icon"><Icon d={icon} size={30} /></span>
      <span className="choice-text"><strong>{title}</strong>{hint && <span>{hint}</span>}</span>
    </button>
  );
}

export function QtyPad({ value, onChange, item, t, max, label, unitLabel }: {
  value: string; onChange(v: string): void; item: Item; t: T; max?: number; label: string; unitLabel?: string;
}) {
  const uw = unitLabel ?? unitWord(t, item);
  const dec = decimalUnit(item);
  const v = Number(value || 0);
  const bump = (d: number) => {
    const next = Math.round((v + d) * 1000) / 1000;
    onChange(String(Math.max(0, max != null ? Math.min(max, next) : next)));
  };
  const chips = dec ? [0.5, 1, 5, 10] : [5, 10, 20, 50];
  return (
    <div className="qtypad">
      <div className="qty-label">{label}</div>
      <div className="qty-row">
        <button type="button" className="qty-btn" onClick={() => bump(dec ? -0.5 : -1)} disabled={v <= 0} aria-label="Less">−</button>
        <input className="qty-input" inputMode={dec ? 'decimal' : 'numeric'} value={value} placeholder="0" aria-label={label}
          onChange={(e) => onChange(e.target.value.replace(dec ? /[^\d.]/g : /\D/g, ''))} />
        <button type="button" className="qty-btn" onClick={() => bump(dec ? 0.5 : 1)} aria-label="More">+</button>
      </div>
      <div className="qty-unit">{uw}</div>
      <div className="qty-chips">
        {chips.map((c) => <button type="button" key={c} className="btn" onClick={() => bump(c)}>+{c}</button>)}
        {v > 0 && <button type="button" className="btn btn-ghost" onClick={() => onChange('')}>{t('clear')}</button>}
      </div>
      {max != null && <div className="muted small center">{t('max', { n: `${qty(max)} ${uw}` })}</div>}
    </div>
  );
}

// Scan, or choose from a list
export function ItemPicker({ t, onPick, hideStock = false, filter }: {
  t: T; onPick(skuId: string, batch?: { id: string; code: string } | null): void; hideStock?: boolean; filter?: (i: Item) => boolean;
}) {
  const { backend } = useApp();
  const [list, setList] = useState(false);
  const [search, setSearch] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const items = useRpc<Item[]>(list ? 'inv_items' : null, {}, [list]);
  const touch = touchDevice();

  const onScan = async (code: string) => {
    setErr(null);
    try {
      const r = await backend.rpc<any>('resolve_scan', { p_code: code });
      if (r.kind === 'unknown') { feedback(false); setErr(t('unknown', { code })); return; }
      if (r.kind === 'mismatch') { feedback(false); setErr(r.message); return; }
      feedback(true);
      onPick(r.sku.id, r.batch ? { id: r.batch.id, code: r.batch.code } : null);
    } catch (e) { feedback(false); setErr(friendlyError(e)); }
  };

  const q = search.trim().toLowerCase();
  const shown = (items.data ?? []).filter((i) => (!filter || filter(i)) && (!q || i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q)));
  const groups = (['finished', 'raw_material', 'packaging'] as const).map((g) => [g, shown.filter((i) => i.item_type === g)] as const).filter(([, l]) => l.length);

  return (
    <div className="stack">
      <h2 className="flow-title">{t('scan_title')}</h2>
      <p className="muted flow-hint">{t('scan_hint')}</p>
      <Scanner onScan={onScan} placeholder={t('scan_title')} cameraDefault={touch} autoFocus={!touch} />
      {err && <div className="scan-result bad" role="alert">{err}</div>}
      {!list && <button type="button" className="btn btn-big" onClick={() => setList(true)}>{t('no_barcode')}</button>}
      {list && (
        <>
          <input className="search" type="search" placeholder={t('search')} value={search} onChange={(e) => setSearch(e.target.value)} />
          {items.error && <ErrorBox text={items.error} onRetry={items.reload} />}
          {!items.data && !items.error && <Loading text={t('loading')} />}
          {groups.map(([g, l]) => (
            <div key={g} className="stack">
              <h3 className="group-title">{t(g)}</h3>
              <div className="pick-grid">
                {l.map((i) => (
                  <button type="button" key={i.id} className="pick" onClick={() => onPick(i.id, null)}>
                    <Avatar item={i} />
                    <span className="pick-name">{i.name}</span>
                    {!hideStock && <span className="muted small">{qty(i.on_shelf)} {unitWord(t, i)}</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------
export function Inventory({ route }: { route: string[] }) {
  const [section, id, extra] = route;
  if (section === 'in' || section === 'out' || section === 'count' || section === 'find') {
    return <Flow key={section + (id ?? '')} action={section} presetId={id} presetReason={extra} />;
  }
  if (section === 'counts') return <CountsReview />;
  if (section === 'all') return <AllStock />;
  return <Hub />;
}

function Hub() {
  const { can } = useApp();
  const { t, lang, setLang } = useT();
  const pending = useRpc<any[]>(can('manager') ? 'inv_list_counts' : null, { p_status: 'pending' });
  const tiles = [
    { id: 'in' as const, href: '#/inventory/in', show: can('warehouse', 'manager') },
    { id: 'out' as const, href: '#/inventory/out', show: can('warehouse', 'manager') },
    { id: 'count' as const, href: '#/inventory/count', show: can('warehouse', 'packer', 'manager') },
    { id: 'find' as const, href: '#/inventory/find', show: true },
    { id: 'stickers' as const, href: '#/labels', show: can('warehouse', 'manager') },
  ].filter((x) => x.show);
  const n = pending.data?.length ?? 0;

  return (
    <Page title={t('stock')} actions={<LangButton lang={lang} setLang={setLang} />}>
      {n > 0 && <a className="notice notice-link" href="#/inventory/counts"><Icon d={ICONS.count} size={22} /> {t('counts_to_check')} · <strong>{n}</strong></a>}
      <div className="big-tiles">
        {tiles.map((x) => (
          <a key={x.id} className={`big-tile bt-${x.id}`} href={x.href}>
            <Icon d={ICONS[x.id]} size={40} />
            <span className="bt-word">{t(x.id)}</span>
            <span className="bt-hint">{t(`${x.id}_hint`)}</span>
          </a>
        ))}
      </div>
      <a className="big-tile bt-all" href="#/inventory/all">
        <Icon d={ICONS.book} size={32} />
        <span className="bt-word">{t('all_stock')}</span>
        <span className="bt-hint">{t('all_stock_hint')}</span>
      </a>
      {can('manager', 'viewer') && (
        <div className="stack">
          <a className="link" href="#/stock">{t('detailed')}</a>
          <a className="link" href="#/labels/book">{t('barcode_book')}</a>
        </div>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------
// One flow for Stock in / Stock out / Count / Find
// ---------------------------------------------------------------------
type Stage = 'pick' | 'choose' | 'qty' | 'confirm' | 'done' | 'show';
type Source = { kind: 'kitchen' } | { kind: 'po'; po_line_id: string; po_code: string; supplier: string; remaining: number };
const REASONS = [
  { id: 'damaged', icon: ICONS.damaged, tone: 'out' },
  { id: 'expired', icon: ICONS.expired, tone: 'warn' },
  { id: 'sample', icon: ICONS.sample, tone: 'count' },
] as const;
type Reason = typeof REASONS[number]['id'];

function Flow({ action, presetId, presetReason }: { action: Action; presetId?: string; presetReason?: string }) {
  const { backend, go, can } = useApp();
  const { t, lang, setLang } = useT();
  const [stage, setStage] = useState<Stage>('pick');
  const [item, setItem] = useState<Detail | null>(null);
  const [batch, setBatch] = useState<{ id: string; code: string } | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [reason, setReason] = useState<Reason | null>(REASONS.some((r) => r.id === presetReason) ? presetReason as Reason : null);
  const [n, setN] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [key, setKey] = useState(() => newKey('inv-' + action));

  const sourcesOf = (d: Detail): Source[] => [
    ...(d.kitchen?.can_make ? [{ kind: 'kitchen' as const }] : []),
    ...d.incoming.map((p) => ({ kind: 'po' as const, ...p })),
  ];

  const load = async (skuId: string, b: { id: string; code: string } | null = null) => {
    setErr(null);
    try {
      const d = await backend.rpc<Detail>('inv_item', { p_sku_id: skuId });
      setItem(d); setBatch(action === 'in' ? null : b);
      // "Take expired off": pre-fill with everything that has expired
      const expiredQty = d.batches.filter((x) => x.expired).reduce((a, x) => a + Number(x.qty), 0);
      setN(action === 'out' && reason === 'expired' && !b && expiredQty > 0 ? String(expiredQty) : '');
      if (action === 'find') setStage('show');
      else if (action === 'count') setStage('qty');
      else if (action === 'out') setStage(reason ? 'qty' : 'choose');
      else {
        const s = sourcesOf(d);
        if (s.length === 1) { setSource(s[0]); setStage('qty'); } else { setSource(null); setStage('choose'); }
      }
    } catch (e) { setErr(friendlyError(e)); }
  };

  useEffect(() => { if (presetId) load(presetId); }, [presetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const restart = () => {
    setStage('pick'); setItem(null); setBatch(null); setSource(null); setN(''); setErr(null); setResult(null);
    setReason(REASONS.some((r) => r.id === presetReason) ? presetReason as Reason : null);
    setKey(newKey('inv-' + action));
  };

  const submit = async () => {
    if (!item) return;
    setBusy(true); setErr(null);
    try {
      let r: any;
      if (action === 'in') {
        r = await backend.rpc('inv_stock_in', { p: { sku_id: item.id, qty: Number(n), source: source!.kind,
          po_line_id: source!.kind === 'po' ? source!.po_line_id : null, idempotency_key: key } });
      } else if (action === 'out') {
        r = await backend.rpc('inv_stock_out', { p: { sku_id: item.id, batch_id: batch?.id ?? null, qty: Number(n), reason, idempotency_key: key } });
      } else {
        r = await backend.rpc('inv_submit_count', { p: { sku_id: item.id, batch_id: batch?.id ?? null, counted: Number(n), idempotency_key: key } });
      }
      setResult(r); setStage('done'); feedback(true);
    } catch (e) {
      feedback(false); setErr(friendlyError(e));
    } finally { setBusy(false); }
  };

  const title = t(action);
  const unit = item ? unitWord(t, item) : '';
  const maxQty = action === 'in' && source?.kind === 'po' ? Number(source.remaining)
    : action === 'out' && item ? Number(batch ? item.batches.find((x) => x.id === batch.id)?.qty ?? 0 : item.on_shelf) : undefined;

  return (
    <Page title={title} back="inventory" actions={<LangButton lang={lang} setLang={setLang} />}>
      {stage !== 'pick' && stage !== 'done' && item && (
        <ItemHead item={item} t={t} batch={batch} showStock={action !== 'count'} onChange={presetId ? undefined : restart} />
      )}

      {stage === 'pick' && presetId && !err && <Loading text={t('loading')} />}
      {stage === 'pick' && !presetId && <ItemPicker t={t} onPick={load} hideStock={action === 'count'} />}

      {stage === 'choose' && item && action === 'in' && (
        <div className="stack">
          <h2 className="flow-title">{t('where_from')}</h2>
          {sourcesOf(item).map((s) => s.kind === 'kitchen'
            ? <Choice key="k" icon={ICONS.kitchen} tone="in" title={t('from_kitchen')}
                hint={[item.kitchen?.planned ? t('from_kitchen_plan', { code: item.kitchen.planned.code }) : '', item.kitchen?.has_recipe ? t('from_kitchen_recipe') : ''].filter(Boolean).join(' · ') || undefined}
                onClick={() => { setSource(s); setStage('qty'); }} />
            : <Choice key={s.po_line_id} icon={ICONS.truck} tone="find" title={t('delivery_from', { supplier: s.supplier })}
                hint={t('still_to_come', { n: `${qty(s.remaining)} ${unit}`, po: s.po_code })}
                onClick={() => { setSource(s); setStage('qty'); }} />)}
          {sourcesOf(item).length === 0 && (
            <div className="blocked"><Icon d={ICONS.wait} size={36} /><p>{item.item_type === 'finished' ? t('cant_make') : t('no_po')}</p></div>
          )}
        </div>
      )}

      {stage === 'choose' && item && action === 'out' && (
        <div className="stack">
          <h2 className="flow-title">{t('why_out')}</h2>
          {REASONS.map((r) => <Choice key={r.id} icon={r.icon} tone={r.tone} title={t(r.id)} onClick={() => { setReason(r.id); setStage('qty'); }} />)}
        </div>
      )}

      {stage === 'qty' && item && (
        <div className="stack">
          {action === 'count' && (
            <div className="notice"><strong>{t('count_instr')}</strong><br />{t('count_dont')}</div>
          )}
          {action === 'in' && source && <div className="muted">{source.kind === 'kitchen' ? t('from_kitchen') : t('delivery_from', { supplier: source.supplier })}</div>}
          {action === 'out' && reason && <div className="muted">{t(reason)}</div>}
          <QtyPad value={n} onChange={setN} item={item} t={t} max={maxQty}
            label={action === 'in' ? t('how_many_in') : action === 'out' ? t('how_many_out') : t('how_many_count')} />
          <button type="button" className={`btn btn-big btn-go go-${action}`}
            disabled={n === '' || (action !== 'count' && !(Number(n) > 0)) || (maxQty != null && Number(n) > maxQty)}
            onClick={() => { setErr(null); setStage('confirm'); }}>OK →</button>
          {action !== 'count' && <button type="button" className="btn btn-ghost" onClick={() => setStage(sourcesOf(item).length === 1 && action === 'in' ? 'pick' : 'choose')}>{t('go_back')}</button>}
        </div>
      )}

      {stage === 'confirm' && item && (
        <div className="stack">
          <p className="confirm-text">
            {action === 'in' ? t('confirm_in', { n: qty(n), unit, name: item.name })
              : action === 'out' ? t('confirm_out', { n: qty(n), unit, name: item.name })
              : t('confirm_count', { n: qty(n), unit })}
          </p>
          {err && <div className="scan-result bad" role="alert">{err}</div>}
          <button type="button" className={`btn btn-big btn-go go-${action}`} disabled={busy} onClick={submit}>
            {busy ? t('loading') : action === 'in' ? t('yes_add') : action === 'out' ? t('yes_remove') : t('yes_send')}
          </button>
          <button type="button" className="btn btn-big" disabled={busy} onClick={() => setStage('qty')}>{t('go_back')}</button>
        </div>
      )}

      {stage === 'done' && item && result && <Done action={action} item={item} result={result} n={n} t={t}
        onNext={presetId ? () => go(`inventory/${action}`) : restart} onPrint={result.batch ? () => {
          try {
            sessionStorage.setItem('tl-label', JSON.stringify({ kind: 'batch', sku_id: item.id, code: result.batch.code,
              name: item.name, expires_on: result.batch.expires_on, copies: stickerCopies(item, n), back: `inventory/${action}` }));
          } catch { /* ignore */ }
          go('labels');
        } : undefined} />}

      {stage === 'show' && item && <FindView item={item} t={t} can={can} />}
      {stage === 'pick' && err && <div className="scan-result bad" role="alert">{err}</div>}
    </Page>
  );
}

// One sticker per pack for finished goods and counted pieces; one per delivery for loose kg / litres
const stickerCopies = (item: Item, n: string) =>
  item.item_type === 'finished' || ['pcs'].includes(item.unit) ? Math.min(Math.ceil(Number(n)), 500) : 1;

function Done({ action, item, result, n, t, onNext, onPrint }: {
  action: Action; item: Item; result: any; n: string; t: T; onNext(): void; onPrint?: () => void;
}) {
  const unit = unitWord(t, item);
  const pending = action === 'count' && result.status === 'pending';
  const shelf = result.item?.on_shelf;
  return (
    <div className="stack">
      <div className={`done-hero ${pending ? 'wait' : 'ok'}`}>
        <span className="done-circle"><Icon d={pending ? ICONS.wait : ICONS.check} size={56} /></span>
        <strong>
          {action === 'in' ? t('added', { n: qty(n), unit })
            : action === 'out' ? t('removed', { n: qty(n), unit })
            : result.status === 'matched' ? t('count_ok')
            : pending ? t('count_pending') : t('count_applied')}
        </strong>
        <span>{item.name}</span>
        {pending && <span>{t('count_diff', { sys: `${qty(result.system_qty)} ${unit}`, n: `${qty(result.counted_qty)} ${unit}` })}</span>}
        {!pending && shelf != null && <span>{t('now_on_shelf', { n: `${qty(shelf)} ${unit}` })}</span>}
        {result.batch && <span className="small">{t('batch')} <span className="mono">{result.batch.code}</span> · {t('best_before')} {date(result.batch.expires_on)}</span>}
      </div>
      {/* after anything comes in, printing its barcode stickers is the next step */}
      {onPrint && <button type="button" className="btn btn-big btn-go go-stickers" onClick={onPrint}><Icon d={ICONS.stickers} size={22} /> {t('print_n', { n: stickerCopies(item, n) })}</button>}
      <button type="button" className={`btn btn-big ${onPrint ? '' : `btn-go go-${action}`}`} onClick={onNext}>{t('next')} →</button>
      <a className="btn btn-ghost" href="#/inventory">{t('back_home')}</a>
    </div>
  );
}

function FindView({ item, t, can }: { item: Detail; t: T; can: (...r: any[]) => boolean }) {
  const unit = unitWord(t, item);
  const finished = item.item_type === 'finished';
  const firstGood = item.batches.find((b) => !b.expired && !b.on_hold);
  const hasExpired = item.batches.some((b) => b.expired);
  return (
    <div className="stack">
      <div className={`find-hero ${item.low ? 'low' : ''}`}>
        <span className="find-num">{qty(finished ? item.free : item.on_shelf)}</span>
        <span>{unit} {finished ? t('free_to_sell') : t('on_shelf')}</span>
        {finished && <span className="small">{qty(item.on_shelf)} {t('on_shelf')} · {qty(item.reserved)} {t('promised')}</span>}
      </div>
      {item.batches.length === 0 && <Empty>{t('no_stock')}</Empty>}
      <ul className="batch-list">
        {item.batches.map((b) => (
          <li key={b.id ?? b.code} className={b.expired ? 'expired' : b.on_hold ? 'hold' : ''}>
            <div className="grow">
              <span className="mono small">{b.code}</span>
              <div className="small">
                {b.expires_on ? <>{t('best_before')} {date(b.expires_on)}{!b.expired && b.days_left != null ? ` · ${t('days_left', { n: b.days_left })}` : ''}</> : null}
              </div>
              {b.expired && <span className="tag tag-bad">{t('expired_tag')}</span>}
              {!b.expired && b.on_hold && <span className="tag tag-warn">{t('on_hold')}</span>}
              {firstGood && b.id === firstGood.id && <span className="tag tag-ok">{t('use_first')}</span>}
            </div>
            <strong className="batch-qty">{qty(b.qty)}</strong>
          </li>
        ))}
      </ul>
      {hasExpired && can('warehouse', 'manager') && <a className="btn btn-big go-out btn-go" href={`#/inventory/out/${item.id}/expired`}><Icon d={ICONS.expired} size={22} /> {t('remove_expired')}</a>}
      <div className="mini-tiles">
        {can('warehouse', 'manager') && <a className="mini-tile bt-in" href={`#/inventory/in/${item.id}`}><Icon d={ICONS.in} />{t('in')}</a>}
        {can('warehouse', 'manager') && <a className="mini-tile bt-out" href={`#/inventory/out/${item.id}`}><Icon d={ICONS.out} />{t('out')}</a>}
        {can('warehouse', 'packer', 'manager') && <a className="mini-tile bt-count" href={`#/inventory/count/${item.id}`}><Icon d={ICONS.count} />{t('count')}</a>}
        {can('warehouse', 'manager') && <a className="mini-tile bt-stickers" href={`#/labels/item/${item.id}`}><Icon d={ICONS.stickers} />{t('stickers')}</a>}
      </div>
      <div className="muted small">{item.location} · <span className="mono">{item.code}</span> · {item.gtin || item.barcode}</div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Manager: counts that differ from the system
// ---------------------------------------------------------------------
function CountsReview() {
  const { backend, toast } = useApp();
  const { t } = useT();
  const [view, setView] = useState<'pending' | 'recent'>('pending');
  const list = useRpc<any[]>('inv_list_counts', { p_status: view }, [view]);
  const [rejecting, setRejecting] = useState<any>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const review = async (c: any, approve: boolean, why?: string) => {
    setBusy(true);
    try {
      await backend.rpc('inv_review_count', { p_id: c.id, p_approve: approve, p_note: why ?? null });
      toast(approve ? `${c.code} applied — stock corrected` : `${c.code} rejected`);
      setRejecting(null); setNote(''); list.reload();
    } catch (e) { toast(friendlyError(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <Page title={t('counts_to_check')} back="inventory">
      <Segmented value={view} onChange={setView} options={[{ value: 'pending', label: 'Waiting' }, { value: 'recent', label: 'All recent' }]} />
      {list.error && <ErrorBox text={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Loading />}
      {list.data?.length === 0 && <Empty>{view === 'pending' ? 'Nothing waiting. Counts that match the system close themselves.' : 'No counts yet.'}</Empty>}
      <div className="list">
        {list.data?.map((c) => {
          const unit = unitWord(t, c);
          const diff = Number(c.difference);
          return (
            <div key={c.id} className="card">
              <div className="row-between"><strong>{c.sku_name}</strong><span className="mono small">{c.code}</span></div>
              {c.batch_code && <div className="muted small">Batch <span className="mono">{c.batch_code}</span> only</div>}
              <div className="count-line">
                <span>System {qty(c.system_qty)}</span><span aria-hidden="true">→</span><span>Counted <strong>{qty(c.counted_qty)}</strong> {unit}</span>
                <span className={diff < 0 ? 'bad' : diff > 0 ? 'ok' : ''}><strong>{diff > 0 ? '+' : ''}{qty(diff)}</strong>{Number(c.value) ? ` (${inr(c.value)})` : ''}</span>
              </div>
              <div className="muted small">By {c.counted_by ?? '—'} · {dateTime(c.counted_at)}
                {c.status !== 'pending' && <> · {c.status}{c.reviewed_by ? ` by ${c.reviewed_by}` : ''}{c.review_note ? `: ${c.review_note}` : ''}{c.transaction_code ? ` · ${c.transaction_code}` : ''}</>}</div>
              {c.status === 'pending' && (
                <div className="row-gap">
                  <button type="button" className="btn btn-primary grow" disabled={busy} onClick={() => review(c, true)}>Accept count</button>
                  <button type="button" className="btn grow" disabled={busy} onClick={() => setRejecting(c)}>Reject</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="muted small">Accepting posts the difference against what the system showed when the count was taken. Ask for a recount if unsure — a new count replaces this one.</p>
      {rejecting && (
        <Sheet title={`Reject ${rejecting.code}`} onClose={() => setRejecting(null)}>
          <Field label="Why? (required)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Recount — stock was in the cold room" /></Field>
          <button type="button" className="btn btn-primary btn-big" disabled={busy || !note.trim()} onClick={() => review(rejecting, false, note.trim())}>Reject count</button>
        </Sheet>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------
// All stock: every item in one list
// ---------------------------------------------------------------------
type StockRow = Item & {
  brand_code: string | null; category: string | null; web_price: number | null; is_test: boolean; reserved: number;
  expired: number; on_hold: number; packed: number; elsewhere: number; written_off: number; value: number;
  last_cost: number | null; next_expiry: string | null;
};
type TypeFilter = 'all' | 'finished' | 'raw_material' | 'packaging';

function AllStock() {
  const { can, go } = useApp();
  const { t, lang, setLang } = useT();
  const list = useRpc<StockRow[]>('inv_stock_list');
  const [type, setType] = useState<TypeFilter>('all');
  const [brand, setBrand] = useState('');
  const [low, setLow] = useState(false);
  const [tests, setTests] = useState(false);
  const [q, setQ] = useState('');
  const showValue = can('manager', 'viewer', 'accountant');

  const rows = (list.data ?? []).filter((r) => (type === 'all' || r.item_type === type) && (!brand || r.brand_code === brand)
    && (!low || r.low) && (tests || !r.is_test)
    && (!q.trim() || [r.name, r.code, r.category ?? '', r.barcode].some((x) => x.toLowerCase().includes(q.trim().toLowerCase()))));
  const brands = [...new Map((list.data ?? []).filter((r) => r.brand_code).map((r) => [r.brand_code!, r.brand!])).entries()];
  const total = rows.reduce((a, r) => a + Number(r.value), 0);

  const csv = () => {
    const head = ['Code', 'Name', 'Type', 'Brand', 'Category', 'Unit', 'On shelf', 'Kept for orders', 'Free', 'Packed', 'Other locations',
      'Expired', 'On hold', 'Written off', 'Next expiry', 'Value at cost', 'MRP', 'Website price', 'Barcode'];
    const esc = (v: unknown) => { const x = v == null ? '' : String(v); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    const body = rows.map((r) => [r.code, r.name, r.item_type, r.brand, r.category, r.item_type === 'finished' ? 'packs' : r.unit, r.on_shelf, r.reserved,
      r.free, r.packed, r.elsewhere, r.expired, r.on_hold, r.written_off, r.next_expiry, showValue ? r.value : '', r.mrp, r.web_price, r.barcode].map(esc).join(','));
    const blob = new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stock-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Page title={t('all_stock_title')} back="inventory" actions={<LangButton lang={lang} setLang={setLang} />}>
      <input className="search" type="search" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <Segmented value={type} onChange={setType} options={[{ value: 'all', label: t('f_all') }, { value: 'finished', label: t('finished') },
        { value: 'raw_material', label: t('raw_material') }, { value: 'packaging', label: t('packaging') }]} />
      <div className="chip-row">
        {brands.map(([code, name]) => (
          <button type="button" key={code} className={`chip-btn ${brand === code ? 'on' : ''}`} aria-pressed={brand === code}
            onClick={() => setBrand(brand === code ? '' : code)}>{name}</button>
        ))}
        <button type="button" className={`chip-btn ${low ? 'on' : ''}`} aria-pressed={low} onClick={() => setLow(!low)}>{t('low_only')}</button>
        <button type="button" className={`chip-btn ${tests ? 'on' : ''}`} aria-pressed={tests} onClick={() => setTests(!tests)}>{t('show_test')}</button>
      </div>
      {list.error && <ErrorBox text={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Loading text={t('loading')} />}
      {list.data && (
        <div className="row-between small">
          <span className="muted">{t('items_n', { n: rows.length })}</span>
          {showValue && <span>{t('value_at_cost')}: <strong>{inr(total)}</strong></span>}
        </div>
      )}
      {list.data && rows.length === 0 && <Empty>{t('nothing_found')}</Empty>}
      <div className="list">
        {rows.map((r) => {
          const unit = unitWord(t, r);
          const finished = r.item_type === 'finished';
          const main = finished ? r.free : r.on_shelf;
          return (
            <button type="button" key={r.id} className={`stock-row ${r.low ? 'low' : ''}`} onClick={() => go(`inventory/find/${r.id}`)}>
              <Avatar item={r} />
              <span className="grow">
                <span className="stock-name">{r.is_test && <span className="test-tag">{t('test_item')}</span>} {r.name}</span>
                <span className="muted small"><span className="mono">{r.code}</span>{r.brand ? ` · ${r.brand}` : ''}{r.category ? ` · ${r.category}` : ''}</span>
                <span className="stock-chips small">
                  {finished && <span>{qty(r.on_shelf)} {t('on_shelf')}</span>}
                  {Number(r.reserved) > 0 && <span>{qty(r.reserved)} {t('promised')}</span>}
                  {Number(r.packed) > 0 && <span>{qty(r.packed)} {t('packed_word')}</span>}
                  {Number(r.elsewhere) > 0 && <span>{qty(r.elsewhere)} {t('elsewhere')}</span>}
                  {Number(r.expired) > 0 && <span className="bad">{t('expired_n', { n: qty(r.expired) })}</span>}
                  {Number(r.on_hold) > 0 && <span className="warn-text">{t('on_hold_n', { n: qty(r.on_hold) })}</span>}
                  {Number(r.written_off) > 0 && <span className="muted">{qty(r.written_off)} {t('written_off')}</span>}
                  {r.next_expiry && <span className="muted">{t('next_expiry', { date: date(r.next_expiry) })}</span>}
                </span>
              </span>
              <span className="right">
                <span className={`big-num ${r.low ? 'bad' : ''}`}>{qty(main)}</span>
                <span className="muted small block">{unit} {finished ? t('free_to_sell') : t('on_shelf')}</span>
                {showValue && Number(r.value) > 0 && <span className="small block">{inr(r.value)}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {showValue && list.data && <button type="button" className="btn" onClick={csv}>{t('download_csv')}</button>}
    </Page>
  );
}
