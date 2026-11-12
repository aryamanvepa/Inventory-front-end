// Barcode stickers.
//  * Product sticker: the item's barcode (EAN-13 — our own 200… number, or
//    the GS1 GTIN once the company has one) with name and MRP.
//  * Batch sticker: Code 128 of the batch code with the best-before date —
//    one scan tells packing which product AND which batch.
//  * Barcode book: every item on one printable page, to scan when a pack
//    has no sticker.
// Other screens open this with a preset in sessionStorage('tl-label').
import { useEffect, useState } from 'react';
import { useApp, useRpc } from '../lib/app';
import { friendlyError } from '../lib/backend';
import { Barcode, itemBarcode } from '../lib/barcode';
import { useT } from '../lib/i18n';
import { date, ErrorBox, inr, Loading, Page } from '../components/ui';
import { Choice, ICONS, ItemHead, ItemPicker, LangButton, QtyPad, type Detail, type Item } from './Inventory';

type Size = 'a4-24' | 'a4-40' | 'roll';
const SIZES: { id: Size; page: string; cols: number; w: number; h: number }[] = [
  { id: 'a4-24', page: 'size: A4; margin: 13mm 7mm', cols: 3, w: 63.5, h: 33.9 },
  { id: 'a4-40', page: 'size: A4; margin: 10mm 8mm', cols: 4, w: 48.5, h: 25.4 },
  { id: 'roll', page: 'size: 50mm 25mm; margin: 0', cols: 1, w: 50, h: 25 },
];
type Preset = { kind?: 'batch' | 'sku'; sku_id?: string; code?: string; name?: string; expires_on?: string; copies?: number; back?: string };

function readPreset(): Preset | null {
  try {
    const raw = sessionStorage.getItem('tl-label');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function savedSize(): Size {
  try { const s = localStorage.getItem('tl-sticker-size'); return SIZES.some((x) => x.id === s) ? s as Size : 'a4-24'; } catch { return 'a4-24'; }
}

// Sets the printer page size while this screen is open
function PrintPage({ css }: { css: string }) {
  useEffect(() => {
    const el = document.createElement('style');
    el.textContent = `@media print { @page { ${css} } }`;
    document.head.appendChild(el);
    return () => el.remove();
  }, [css]);
  return null;
}

export function Sticker({ item, batch, size }: { item: Pick<Item, 'name' | 'mrp' | 'item_type' | 'barcode' | 'gtin'>; batch?: { code: string; expires_on?: string | null } | null; size: Size }) {
  const s = SIZES.find((x) => x.id === size)!;
  return (
    <div className={`sticker st-${size}`} style={{ width: `${s.w}mm`, height: `${s.h}mm` }}>
      <div className="st-name">{item.name}</div>
      <Barcode value={batch ? batch.code : itemBarcode(item)} height={size === 'a4-24' ? 46 : 40} />
      <div className="st-meta">
        {batch?.expires_on && <span>Best before {date(batch.expires_on)}</span>}
        {item.item_type === 'finished' && item.mrp != null && <span>MRP {inr(item.mrp, 2)}</span>}
      </div>
    </div>
  );
}

export function Labels({ section, id }: { section?: string; id?: string }) {
  if (section === 'book') return <BarcodeBook />;
  return <StickerMaker skuId={section === 'item' ? id : undefined} />;
}

function StickerMaker({ skuId }: { skuId?: string }) {
  const { backend } = useApp();
  const { t, lang, setLang } = useT();
  const [preset] = useState(readPreset);
  const [item, setItem] = useState<Detail | null>(null);
  const [kind, setKind] = useState<'product' | 'batch'>(preset?.kind === 'batch' ? 'batch' : 'product');
  const [batch, setBatch] = useState<{ code: string; expires_on?: string | null } | null>(
    preset?.kind === 'batch' && preset.code ? { code: preset.code, expires_on: preset.expires_on } : null);
  const [n, setN] = useState(String(Math.max(1, Math.min(preset?.copies ?? 24, 500))));
  const [size, setSizeState] = useState<Size>(savedSize);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!(skuId || preset));

  const setSize = (s: Size) => { setSizeState(s); try { localStorage.setItem('tl-sticker-size', s); } catch { /* ignore */ } };
  const load = async (id: string, b?: { id: string; code: string } | null) => {
    setErr(null);
    try {
      const d = await backend.rpc<Detail>('inv_item', { p_sku_id: id });
      setItem(d);
      if (b) { const full = d.batches.find((x) => x.id === b.id); setKind('batch'); setBatch({ code: b.code, expires_on: full?.expires_on }); }
    } catch (e) { setErr(friendlyError(e)); } finally { setLoading(false); }
  };

  useEffect(() => {
    try { sessionStorage.removeItem('tl-label'); } catch { /* ignore */ }
    if (skuId) {
      // also accepts a product code or barcode: #/labels/item/MT-000001
      if (/^[0-9a-f-]{36}$/i.test(skuId)) load(skuId);
      else backend.rpc<any>('resolve_scan', { p_code: skuId }).then((r) => (r.sku ? load(r.sku.id) : (setErr(t('unknown', { code: skuId })), setLoading(false)))).catch((e) => { setErr(friendlyError(e)); setLoading(false); });
      return;
    }
    if (preset?.sku_id) { load(preset.sku_id); return; }
    if (preset?.code) {
      backend.rpc<any>('resolve_scan', { p_code: preset.code })
        .then((r) => (r.sku ? load(r.sku.id) : setLoading(false)))
        .catch((e) => { setErr(friendlyError(e)); setLoading(false); });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const s = SIZES.find((x) => x.id === size)!;
  const count = Math.max(0, Math.min(500, Math.floor(Number(n) || 0)));
  const batches = item ? item.batches.filter((b) => !b.expired && b.id) : [];
  const batchList = batch && !batches.some((b) => b.code === batch.code) ? [{ code: batch.code, expires_on: batch.expires_on ?? null, qty: null as number | null }, ...batches] : batches;
  const ready = item && (kind === 'product' || batch) && count > 0;

  return (
    <Page narrow title={t('stickers')} back={preset?.back ?? 'inventory'} actions={<LangButton lang={lang} setLang={setLang} />}>
      <PrintPage css={s.page} />
      <div className="no-print stack">
        {loading && <Loading text={t('loading')} />}
        {err && <ErrorBox text={err} />}
        {!item && !loading && (
          <>
            <ItemPicker t={t} onPick={(id, b) => load(id, b)} />
            <a className="btn btn-big" href="#/labels/book"><span>📖</span> {t('barcode_book')}</a>
          </>
        )}
        {item && (
          <>
            <ItemHead item={item} t={t} onChange={skuId ? undefined : () => { setItem(null); setBatch(null); }} />
            <div className="choice-row">
              <Choice icon={ICONS.stickers} title={t('product_sticker')} hint={t('product_sticker_hint')} selected={kind === 'product'} onClick={() => setKind('product')} />
              {item.is_batch_tracked && <Choice icon={ICONS.expired} title={t('batch_sticker')} hint={t('batch_sticker_hint')} selected={kind === 'batch'} onClick={() => setKind('batch')} />}
            </div>
            {kind === 'batch' && (
              <div className="stack">
                <h2 className="flow-title small-title">{t('which_batch')}</h2>
                {batchList.length === 0 && <p className="muted">{t('no_stock')}</p>}
                <div className="choice-row">
                  {batchList.map((b) => (
                    <button type="button" key={b.code} className={`choice ${batch?.code === b.code ? 'on' : ''}`} onClick={() => setBatch(b)} aria-pressed={batch?.code === b.code}>
                      <span className="choice-text"><strong className="mono">{b.code}</strong>
                        <span>{t('best_before')} {date(b.expires_on)}{b.qty != null ? ` · ${b.qty}` : ''}</span></span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <QtyPad value={n} onChange={setN} item={{ ...item, item_type: 'packaging', unit: 'pcs' }} t={t} max={500} label={t('how_many_stickers')} unitLabel={t('stickers_unit')} />
            <h2 className="flow-title small-title">{t('sticker_size')}</h2>
            <div className="choice-row">
              {SIZES.map((x) => (
                <button type="button" key={x.id} className={`choice ${size === x.id ? 'on' : ''}`} onClick={() => setSize(x.id)} aria-pressed={size === x.id}>
                  <span className={`paper paper-${x.id}`} aria-hidden="true" />
                  <span className="choice-text"><strong>{t(x.id === 'a4-24' ? 'a4_24' : x.id === 'a4-40' ? 'a4_40' : 'roll')}</strong></span>
                </button>
              ))}
            </div>
            {ready && <div className="sticker-preview"><Sticker item={item} batch={kind === 'batch' ? batch : null} size={size} /></div>}
            <button type="button" className="btn btn-primary btn-big" disabled={!ready} onClick={() => window.print()}>
              🖨 {t('print')} {count > 0 ? `· ${count}` : ''}
            </button>
            {preset?.back && <a className="btn btn-big btn-go go-in" href={`#/${preset.back}`}>{t('continue')} →</a>}
            <p className="muted small">
              {item.gtin ? 'Printing the GS1 barcode (GTIN).' : 'Our own barcode (starts with 200) — works with every scanner in our shop and warehouse. For selling through other retailers or marketplaces, get GS1 India barcodes and add them to the product; stickers then print those instead.'}
              {' '}Try one sheet on plain paper first to check alignment.
            </p>
          </>
        )}
      </div>
      {ready && (
        <div className="sticker-sheet print-only" style={{ gridTemplateColumns: `repeat(${s.cols}, ${s.w}mm)` }}>
          {Array.from({ length: count }).map((_, i) => <Sticker key={i} item={item!} batch={kind === 'batch' ? batch : null} size={size} />)}
        </div>
      )}
    </Page>
  );
}

function BarcodeBook() {
  const { t, lang, setLang } = useT();
  const items = useRpc<Item[]>('inv_items');
  const groups = (['finished', 'raw_material', 'packaging'] as const)
    .map((g) => [g, (items.data ?? []).filter((i) => i.item_type === g)] as const).filter(([, l]) => l.length);
  return (
    <Page title={t('barcode_book')} back="labels" actions={<LangButton lang={lang} setLang={setLang} />}>
      <PrintPage css="size: A4; margin: 10mm" />
      <div className="no-print stack">
        <p className="muted">{t('barcode_book_hint')}</p>
        <button type="button" className="btn btn-primary btn-big" disabled={!items.data} onClick={() => window.print()}>🖨 {t('print')}</button>
      </div>
      {items.error && <ErrorBox text={items.error} onRetry={items.reload} />}
      {!items.data && !items.error && <Loading />}
      <div className="book">
        <h1 className="print-only book-title">Torte Living · Barcode book · {date(new Date().toISOString())}</h1>
        {groups.map(([g, l]) => (
          <section key={g}>
            <h2 className="book-group">{t(g)}</h2>
            <div className="book-grid">
              {l.map((i) => (
                <div key={i.id} className="book-item">
                  <div className="book-name">{i.name}</div>
                  <Barcode value={itemBarcode(i)} height={44} />
                  <div className="book-code">{i.code}</div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Page>
  );
}
