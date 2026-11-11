import { useRef, useState } from 'react';
import { useAction, useApp, useRpc } from '../lib/app';
import { friendlyError, newKey } from '../lib/backend';
import { Scanner, feedback } from '../components/Scanner';
import { ago, Badge, Card, date, Empty, ErrorBox, Loading, Page, qty, Sheet, dateTime } from '../components/ui';

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
  const { backend, go, toast } = useApp();
  const ord = useRpc<any>('get_order', { p_order_id: orderId });
  const { run, busy: acting } = useAction();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ ok: boolean; text: string } | null>(null);
  const [needBatch, setNeedBatch] = useState<{ code: string; sku: any; batches: any[] } | null>(null);
  const [showLog, setShowLog] = useState(false);
  const o = ord.data;

  // Scans are queued and processed one at a time, so a fast handheld scanner
  // never loses a scan while the previous one is being saved.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const needBatchRef = useRef(needBatch);
  needBatchRef.current = needBatch;
  const scan = (code: string, batchCode?: string, manual = false) => {
    queue.current = queue.current.then(() => doScan(code, batchCode, manual));
  };
  const doScan = async (code: string, batchCode?: string, manual = false) => {
    setBusy(true);
    const pending = needBatchRef.current;
    try {
      const product = pending && !batchCode ? pending.code : code;
      const batch = pending && !batchCode ? code : batchCode;
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
      if (r.order) ord.setData(r.order);
    } catch (e) {
      feedback(false);
      setLast({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  };

  if (ord.error) return <Page title="Pack order" back="pack"><ErrorBox text={ord.error} onRetry={ord.reload} /></Page>;
  if (!o) return <Page title="Pack order" back="pack"><Loading /></Page>;

  const total = o.lines.reduce((t: number, l: any) => t + Number(l.qty), 0);
  const done = o.lines.reduce((t: number, l: any) => t + Number(l.scanned), 0);
  const complete = done === total;
  const packed = ['packed', 'dispatched', 'delivered'].includes(o.status);

  return (
    <Page title={o.code} back="pack" actions={<Badge status={o.status} />}>
      <Card>
        <div className="row-between"><strong>{o.ship_to?.name ?? o.customer?.name}</strong><span className="muted small">{dateTime(o.placed_at)}</span></div>
        <div className="muted small">{[o.ship_to?.address1, o.ship_to?.city, o.ship_to?.pincode].filter(Boolean).join(', ')}</div>
        {o.notes && <div className="notice small">Note: {o.notes}</div>}
        {o.payment_status === 'cod_pending' && <div className="notice small">Cash on delivery — collect ₹{o.total_amount}</div>}
      </Card>

      {!o.packable && !packed && (
        <ErrorBox text={o.stock_shortfall ? 'This order is waiting for stock — do not pack.' : o.status === 'pending_payment' ? 'Not paid yet — do not pack.' : `Order is ${o.status}.`} />
      )}

      <div className="progress-head">
        <span><strong>{qty(done)}</strong> of {qty(total)} items scanned</span>
        <div className="bar"><div style={{ width: `${total ? (100 * done) / total : 0}%` }} /></div>
      </div>

      <ul className="pack-lines">
        {o.lines.map((l: any) => {
          const full = Number(l.scanned) >= Number(l.qty);
          return (
            <li key={l.id} className={full ? 'done' : ''}>
              <div className="check" aria-hidden="true">{full ? '✓' : ''}</div>
              <div className="grow">
                <div><strong>{l.sku_name}</strong></div>
                <div className="muted small mono">{l.sku_code}{l.batches.length > 0 && ' · ' + l.batches.map((b: any) => `${b.code}×${qty(b.qty)}`).join(', ')}</div>
              </div>
              <div className="count-pill">{qty(l.scanned)}/{qty(l.qty)}</div>
            </li>
          );
        })}
      </ul>

      {o.packable && !packed && (
        <>
          {needBatch ? (
            <div className="notice notice-strong">
              <strong>Now scan the batch label</strong> for {needBatch.sku?.name}
              {needBatch.batches.length > 0 && (
                <div className="batch-pick">
                  <span className="small muted">No label? Pick the batch printed on the pack:</span>
                  {needBatch.batches.map((b) => (
                    <button key={b.id} type="button" className="btn btn-small" disabled={busy}
                      onClick={() => scan(needBatch.code, b.code, true)}>
                      {b.code} · exp {date(b.expires_on)}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" className="btn btn-ghost btn-small" onClick={() => { setNeedBatch(null); setLast(null); }}>Cancel</button>
            </div>
          ) : null}
          <Scanner onScan={(c) => scan(c)} busy={busy} placeholder={needBatch ? 'Scan batch label' : 'Scan product or batch label'} />
          {last && <div className={`scan-result ${last.ok ? 'ok' : 'bad'}`} role="status">{last.text}</div>}
          <button type="button" className="btn btn-primary btn-big" disabled={!complete || acting}
            onClick={async () => {
              const r = await run<any>('complete_packing', { p_order_id: orderId, p_idempotency_key: `pack:${orderId}` }, `${o.code} packed`);
              if (r) ord.setData(r.order);
            }}>
            {complete ? 'Mark as packed' : `Scan ${qty(total - done)} more item${total - done === 1 ? '' : 's'}`}
          </button>
        </>
      )}

      {packed && (
        <div className="stack">
          <div className="scan-result ok">Packed {o.packed_at ? dateTime(o.packed_at) : ''}</div>
          {o.status === 'packed' && <button type="button" className="btn btn-primary btn-big" onClick={() => go('dispatch')}>Go to dispatch</button>}
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
                      try { const r = await backend.rpc<any>('undo_pack_scan', { p_scan_id: s.id }); ord.setData(r.order); toast('Scan undone'); }
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
    </Page>
  );
}
