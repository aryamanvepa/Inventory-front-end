import { useEffect, useRef, useState } from 'react';
import { useAction, useApp, useRpc } from '../lib/app';
import { friendlyError, newKey } from '../lib/backend';
import { Scanner, feedback } from '../components/Scanner';
import { ago, Badge, Card, date, Empty, ErrorBox, Loading, Page, qty, Sheet, dateTime } from '../components/ui';
import { useT, type T } from '../lib/i18n';
import type { Batch } from './Inventory';

export function PackList() {
  const { go, backend, toast } = useApp();
  const list = useRpc<any[]>('list_orders', { p_filter: 'to_pack' });
  const orders = (list.data ?? []).slice().sort((a, b) => a.placed_at.localeCompare(b.placed_at));

  return (
    <Page title="Pack orders">
      <Scanner placeholder="Scan or type an order number" autoFocus={false} onScan={async (code) => {
        try {
          const o = await backend.rpc<any>('find_order', { p_code: code });
          if (o) go(`pack/${o.id}`); else toast(`No order ${code}`, 'error');
        } catch (e) { toast(friendlyError(e), 'error'); }
      }} />
      {list.error && <ErrorBox text={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <Loading />}
      {list.data && orders.length === 0 && <Empty>Nothing to pack. 🎉</Empty>}
      <div className="list">
        {orders.map((o) => (
          <Card key={o.id} onClick={() => go(`pack/${o.id}`)}>
            <div className="row-between">
              <strong className="mono">{o.code}</strong>
              <span className="muted small">{ago(o.placed_at)}</span>
            </div>
            <div>{o.customer_name}{o.city ? ` · ${o.city}` : ''}</div>
            <div className="muted small">{o.items}</div>
            <div className="row-gap">
              <Badge status={o.status} />
              {o.payment_status === 'cod_pending' && <Badge status="cod_pending" />}
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}

type ScanResult = { result: string; message: string; sku?: any; eligible_batches?: any[]; order?: any; scan_id?: string };

export function PackOrder({ orderId }: { orderId: string }) {
  const { go } = useApp();
  const { t } = useT();
  const ord = useRpc<any>('get_order', { p_order_id: orderId });
  const o = ord.data;
  if (ord.error) return <Page title="Pack order" back="pack"><ErrorBox text={ord.error} onRetry={ord.reload} /></Page>;
  if (!o) return <Page title="Pack order" back="pack"><Loading /></Page>;
  return (
    <Page title={o.code} back="pack" actions={<Badge status={o.status} />}>
      <OrderCustomer o={o} />
      <PackPanel order={o} setOrder={ord.setData} t={t} onPacked={() => go('dispatch')} />
    </Page>
  );
}

export function OrderCustomer({ o }: { o: any }) {
  return (
    <Card>
      <div className="row-between"><strong>{o.ship_to?.name ?? o.customer?.name}</strong><span className="muted small">{dateTime(o.placed_at)}</span></div>
      <div className="muted small">{[o.ship_to?.address1, o.ship_to?.city, o.ship_to?.pincode].filter(Boolean).join(', ')}</div>
      {o.notes && <div className="notice small">Note: {o.notes}</div>}
      {o.payment_status === 'cod_pending' && <div className="notice small">Cash on delivery — collect ₹{o.total_amount}</div>}
    </Card>
  );
}

type Suggest = { code: string; expires_on: string | null; left: number };

// Oldest-first batch to take for each product, allowing for what this order
// has already scanned (stock only moves when packing is completed).
function suggestions(order: any, shelf: Record<string, Batch[]>): Record<string, Suggest | null> {
  const out: Record<string, Suggest | null> = {};
  for (const l of order.lines) {
    const scannedFrom: Record<string, number> = {};
    for (const x of order.lines.filter((y: any) => y.sku_id === l.sku_id)) for (const b of x.batches) scannedFrom[b.code] = (scannedFrom[b.code] ?? 0) + Number(b.qty);
    const good = (shelf[l.sku_id] ?? []).filter((b) => !b.expired && !b.on_hold);
    const next = good.map((b) => ({ code: b.code, expires_on: b.expires_on, left: Number(b.qty) - (scannedFrom[b.code] ?? 0) })).find((b) => b.left > 0);
    out[l.sku_id] = next ?? null;
  }
  return out;
}

export function PackPanel({ order: o, setOrder, t, onPacked }: { order: any; setOrder(o: any): void; t: T; onPacked(): void }) {
  const { backend, toast } = useApp();
  const { run, busy: acting } = useAction();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ ok: boolean; text: string } | null>(null);
  const [needBatch, setNeedBatch] = useState<{ code: string; sku: any; batches: any[] } | null>(null);
  const [fifoWarn, setFifoWarn] = useState<{ code: string; batchCode?: string; manual: boolean; text: string } | null>(null);
  const [shelf, setShelf] = useState<Record<string, Batch[]>>({});
  const [showLog, setShowLog] = useState(false);
  const orderId = o.id;
  const skuIds = [...new Set<string>(o.lines.map((l: any) => l.sku_id))];

  useEffect(() => {
    Promise.all(skuIds.map((id) => backend.rpc<any>('inv_item', { p_sku_id: id }).then((d) => [id, d.batches] as const)))
      .then((pairs) => setShelf(Object.fromEntries(pairs))).catch(() => { /* suggestions are a convenience */ });
  }, [orderId, backend]); // eslint-disable-line react-hooks/exhaustive-deps
  const sug = suggestions(o, shelf);
  const sugRef = useRef(sug);
  sugRef.current = sug;

  // Scans are queued and processed one at a time, so a fast handheld scanner
  // never loses a scan while the previous one is being saved.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const needBatchRef = useRef(needBatch);
  needBatchRef.current = needBatch;
  const scan = (code: string, batchCode?: string, manual = false, override = false) => {
    queue.current = queue.current.then(() => doScan(code, batchCode, manual, override));
  };
  const doScan = async (code: string, batchCode?: string, manual = false, override = false) => {
    setBusy(true);
    const pending = needBatchRef.current;
    try {
      const product = pending && !batchCode ? pending.code : code;
      const batch = pending && !batchCode ? code : batchCode;
      // first in, first out: warn before a newer batch goes out while an older one is on the shelf
      if (!override) {
        const r = await backend.rpc<any>('resolve_scan', { p_code: batch ?? product });
        const s = r.kind === 'batch' ? sugRef.current[r.sku.id] : null;
        if (s && r.batch.code !== s.code && s.expires_on && r.batch.expires_on > s.expires_on) {
          feedback(false);
          setFifoWarn({ code, batchCode, manual, text: t('fifo_warn', { code: s.code, date: date(s.expires_on) }) });
          return;
        }
      }
      setFifoWarn(null);
      const r = await backend.rpc<ScanResult>('pack_scan', {
        p_order_id: orderId, p_code: product, p_batch_code: batch ?? null, p_manual_batch: manual,
        p_idempotency_key: newKey('scan'),
      });
      if (r.result === 'batch_required') {
        feedback(true);
        needBatchRef.current = { code: product, sku: r.sku, batches: r.eligible_batches ?? [] };
        setNeedBatch(needBatchRef.current);
        setLast({ ok: true, text: r.message });
        return;
      }
      needBatchRef.current = null;
      setNeedBatch(null);
      const ok = r.result === 'accepted';
      feedback(ok);
      setLast({ ok, text: r.message });
      if (r.order) setOrder(r.order);
    } catch (e) {
      feedback(false);
      setLast({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  };

  const total = o.lines.reduce((n: number, l: any) => n + Number(l.qty), 0);
  const done = o.lines.reduce((n: number, l: any) => n + Number(l.scanned), 0);
  const complete = done === total;
  const packed = ['packed', 'dispatched', 'delivered'].includes(o.status);

  return (
    <>
      {!o.packable && !packed && (
        <ErrorBox text={o.stock_shortfall ? t('wait_stock') : o.status === 'pending_payment' ? t('not_paid') : `Order is ${o.status}.`} />
      )}

      <div className="progress-head">
        <span>{t('scanned_of', { n: qty(done), total: qty(total) })}</span>
        <div className="bar"><div style={{ width: `${total ? (100 * done) / total : 0}%` }} /></div>
      </div>

      <ul className="pack-lines">
        {o.lines.map((l: any) => {
          const full = Number(l.scanned) >= Number(l.qty);
          const s = sug[l.sku_id];
          return (
            <li key={l.id} className={full ? 'done' : ''}>
              <div className="check" aria-hidden="true">{full ? '✓' : ''}</div>
              <div className="grow">
                <div><strong>{l.sku_name}</strong></div>
                <div className="muted small mono">{l.sku_code}{l.batches.length > 0 && ' · ' + l.batches.map((b: any) => `${b.code}×${qty(b.qty)}`).join(', ')}</div>
                {!full && !packed && s && <div className="take-hint">{t('take_from', { code: s.code, date: date(s.expires_on) })}</div>}
              </div>
              <div className="count-pill">{qty(l.scanned)}/{qty(l.qty)}</div>
            </li>
          );
        })}
      </ul>

      {o.packable && !packed && (
        <>
          {fifoWarn && (
            <div className="notice notice-strong fifo-warn" role="alert">
              <strong>{fifoWarn.text}</strong>
              <div className="row-gap">
                <button type="button" className="btn btn-small" onClick={() => setFifoWarn(null)}>{t('ok_take_older')}</button>
                <button type="button" className="btn btn-ghost btn-small" onClick={() => scan(fifoWarn.code, fifoWarn.batchCode, fifoWarn.manual, true)}>{t('use_anyway')}</button>
              </div>
            </div>
          )}
          {needBatch ? (
            <div className="notice notice-strong">
              <strong>{t('scan_batch_label', { name: needBatch.sku?.name ?? '' })}</strong>
              {needBatch.batches.length > 0 && (
                <div className="batch-pick">
                  <span className="small muted">{t('no_label_pick')}</span>
                  {needBatch.batches.map((b) => (
                    <button key={b.id} type="button" className="btn btn-small" disabled={busy}
                      onClick={() => scan(needBatch.code, b.code, true)}>
                      {b.code} · {date(b.expires_on)}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" className="btn btn-ghost btn-small" onClick={() => { setNeedBatch(null); setLast(null); }}>{t('go_back')}</button>
            </div>
          ) : null}
          <Scanner onScan={(c) => scan(c)} busy={busy} placeholder={needBatch ? t('scan_batch_short') : t('scan_pack')} />
          {last && <div className={`scan-result ${last.ok ? 'ok' : 'bad'}`} role="status">{last.text}</div>}
          <button type="button" className="btn btn-primary btn-big" disabled={!complete || acting}
            onClick={async () => {
              const r = await run<any>('complete_packing', { p_order_id: orderId, p_idempotency_key: `pack:${orderId}` }, `${o.code} packed`);
              if (r) { setOrder(r.order); onPacked(); }
            }}>
            {complete ? t('mark_packed') : t('scan_more', { n: qty(total - done) })}
          </button>
        </>
      )}

      {packed && (
        <div className="stack">
          <div className="scan-result ok">{t('packed_at', { when: o.packed_at ? dateTime(o.packed_at) : '' })}</div>
          {o.status === 'packed' && <button type="button" className="btn btn-primary btn-big" onClick={onPacked}>{t('next')} →</button>}
        </div>
      )}

      <button type="button" className="btn btn-ghost" onClick={() => setShowLog(true)}>Scan history ({o.scans.length})</button>
      {showLog && (
        <Sheet title="Scan history" onClose={() => setShowLog(false)}>
          <ul className="log">
            {o.scans.map((s: any) => (
              <li key={s.id} className={s.result === 'accepted' ? (s.is_reversal ? 'muted' : 'ok') : 'bad'}>
                <div className="row-between">
                  <span>{s.is_reversal ? 'Undo' : s.message}</span>
                  {s.result === 'accepted' && !s.is_reversal && !s.undone && !packed && (
                    <button type="button" className="btn btn-small" onClick={async () => {
                      try { const r = await backend.rpc<any>('undo_pack_scan', { p_scan_id: s.id }); setOrder(r.order); toast('Scan undone'); }
                      catch (e) { toast(friendlyError(e), 'error'); }
                    }}>Undo</button>
                  )}
                </div>
                <div className="small muted">{dateTime(s.scanned_at)} · {s.by ?? '—'} · {s.scanned_code}{s.manual_batch ? ' · batch picked manually' : ''}{s.undone ? ' · undone' : ''}</div>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
    </>
  );
}
