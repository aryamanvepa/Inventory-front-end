import { useState } from 'react';
import { useAction, useRpc } from '../lib/app';
import { newKey } from '../lib/backend';
import { ago, Card, Empty, ErrorBox, Field, inr, Loading, Page, Segmented, Sheet } from '../components/ui';
import type { T } from '../lib/i18n';

export function Dispatch() {
  const [tab, setTab] = useState<'ready' | 'out'>('ready');
  const list = useRpc<any[]>('list_orders', { p_filter: tab === 'ready' ? 'to_dispatch' : 'out_for_delivery' }, [tab]);
  const ref = useRpc<any>('get_reference_data');
  const [sel, setSel] = useState<any | null>(null);
  const [failFor, setFailFor] = useState<any | null>(null);
  const { run, busy } = useAction();

  return (
    <Page title="Dispatch">
      <Segmented value={tab} onChange={setTab} options={[{ value: 'ready', label: 'Ready to send' }, { value: 'out', label: 'Out for delivery' }]} />
      {list.error && <ErrorBox text={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <Loading />}
      {list.data?.length === 0 && <Empty>{tab === 'ready' ? 'No packed orders waiting.' : 'Nothing out for delivery.'}</Empty>}
      <div className="list">
        {list.data?.map((o) => (
          <Card key={o.id}>
            <div className="row-between"><strong className="mono">{o.code}</strong><span className="muted small">{ago(o.placed_at)}</span></div>
            <div>{o.customer_name}{o.city ? ` · ${o.city}` : ''}</div>
            <div className="muted small">{o.items}</div>
            {o.payment_status === 'cod_pending' && <div className="notice small">Cash on delivery: collect {inr(o.total_amount)}</div>}
            {tab === 'ready' ? (
              <button type="button" className="btn btn-primary" onClick={() => setSel(o)}>Dispatch…</button>
            ) : (
              <>
                {o.shipment && <div className="small">{o.shipment.provider}{o.shipment.booking_ref ? ` · ${o.shipment.booking_ref}` : ''}
                  {o.shipment.tracking_url && <> · <a href={o.shipment.tracking_url} target="_blank" rel="noreferrer">track</a></>}</div>}
                <div className="row-gap">
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => {
                    if (await run('mark_delivered', { p_order_id: o.id }, `${o.code} delivered`)) list.reload();
                  }}>Delivered</button>
                  <button type="button" className="btn" onClick={() => setFailFor(o)}>Delivery failed</button>
                </div>
              </>
            )}
          </Card>
        ))}
      </div>

      {sel && <DispatchSheet order={sel} providers={ref.data?.providers ?? []} onClose={() => setSel(null)} onDone={() => { setSel(null); list.reload(); }} />}
      {failFor && <FailSheet order={failFor} onClose={() => setFailFor(null)} onDone={() => { setFailFor(null); list.reload(); }} />}
    </Page>
  );
}

function DispatchSheet({ order, providers, onClose, onDone }: { order: any; providers: any[]; onClose(): void; onDone(): void }) {
  return (
    <Sheet title={`Dispatch ${order.code}`} onClose={onClose}>
      <DispatchForm order={order} providers={providers} onDone={onDone} />
    </Sheet>
  );
}

export function DispatchForm({ order, providers, onDone, t }: { order: any; providers: any[]; onDone(r: any): void; t?: T }) {
  const tr = (k: Parameters<T>[0], en: string) => (t ? t(k) : en);
  const [provider, setProvider] = useState(providers[0]?.code ?? 'RAPIDO');
  const [ref, setRef] = useState('');
  const [url, setUrl] = useState('');
  const [cost, setCost] = useState('');
  const [key] = useState(() => newKey('dispatch'));
  const { run, busy } = useAction();
  const needsRef = provider !== 'OWN';

  return (
    <div className="stack">
      <Field label={tr('delivery_by', 'Delivery by')}>
        <Segmented value={provider} onChange={setProvider} options={providers.map((p) => ({ value: p.code, label: p.name }))} />
      </Field>
      <Field label={needsRef ? tr('booking_ref', 'Booking reference') : tr('booking_ref_opt', 'Reference (optional)')} hint={needsRef ? 'From the Rapido / iCarry booking' : 'e.g. delivery person name'}>
        <input value={ref} onChange={(e) => setRef(e.target.value)} autoCapitalize="characters" />
      </Field>
      <Field label={tr('tracking_link', 'Tracking link (optional)')}><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></Field>
      <Field label={tr('delivery_cost', 'Delivery cost ₹ (optional)')}><input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || (needsRef && !ref.trim())} onClick={async () => {
        const r = await run<any>('dispatch_order', {
          p_order_id: order.id, p_provider_code: provider, p_booking_ref: ref.trim() || null,
          p_tracking_url: url.trim() || null, p_freight_cost: cost ? Number(cost) : null, p_idempotency_key: key,
        }, `${order.code} dispatched`);
        if (r) onDone(r);
      }}>{tr('confirm_dispatch', 'Confirm dispatch')}</button>
    </div>
  );
}

function FailSheet({ order, onClose, onDone }: { order: any; onClose(): void; onDone(): void }) {
  const [reason, setReason] = useState('');
  const { run, busy } = useAction();
  return (
    <Sheet title={`Delivery failed: ${order.code}`} onClose={onClose}>
      <Field label="What happened?"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer not available, wrong address…" /></Field>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !reason.trim()} onClick={async () => {
        if (await run('mark_delivery_failed', { p_order_id: order.id, p_reason: reason.trim() }, 'Recorded')) onDone();
      }}>Record failed delivery</button>
    </Sheet>
  );
}
