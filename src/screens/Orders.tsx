import { useState } from 'react';
import { useAction, useApp, useRpc } from '../lib/app';
import { newKey } from '../lib/backend';
import { ago, Badge, Card, dateTime, Empty, ErrorBox, Field, inr, Loading, Page, qty, Segmented, Sheet } from '../components/ui';

const FILTERS = [
  { value: 'open', label: 'Open' }, { value: 'awaiting_payment', label: 'Unpaid' },
  { value: 'attention', label: 'Attention' }, { value: 'all', label: 'All' },
];

export function Orders() {
  const { go } = useApp();
  const [filter, setFilter] = useState('open');
  const [search, setSearch] = useState('');
  const list = useRpc<any[]>('list_orders', { p_filter: filter, p_search: search || null }, [filter, search]);

  return (
    <Page title="Orders" back="more">
      <input className="search" type="search" placeholder="Search order no., customer or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
      <Segmented value={filter} onChange={setFilter} options={FILTERS} />
      {list.error && <ErrorBox text={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <Loading />}
      {list.data?.length === 0 && <Empty>No orders.</Empty>}
      <div className="list">
        {list.data?.map((o) => (
          <Card key={o.id} onClick={() => go(`orders/${o.id}`)}>
            <div className="row-between"><strong className="mono">{o.code}</strong><strong>{inr(o.total_amount)}</strong></div>
            <div className="row-between"><span>{o.customer_name}{o.city ? ` · ${o.city}` : ''}</span><span className="muted small">{ago(o.placed_at)}</span></div>
            <div className="row-gap"><Badge status={o.status} /><Badge status={o.payment_status} />{o.stock_shortfall && <Badge status="failed">Waiting for stock</Badge>}<span className="muted small">{o.channel}</span></div>
          </Card>
        ))}
      </div>
    </Page>
  );
}

export function OrderDetail({ orderId }: { orderId: string }) {
  const { can, go } = useApp();
  const ord = useRpc<any>('get_order', { p_order_id: orderId });
  const { run, busy } = useAction();
  const [sheet, setSheet] = useState<null | 'cancel' | 'refund' | 'payment'>(null);
  const o = ord.data;
  if (ord.error) return <Page title="Order" back="orders"><ErrorBox text={ord.error} onRetry={ord.reload} /></Page>;
  if (!o) return <Page title="Order" back="orders"><Loading /></Page>;
  const held = Number(o.amount_paid);
  const canCancel = !['dispatched', 'delivered', 'delivery_failed', 'cancelled'].includes(o.status);

  return (
    <Page title={o.code} back="orders" actions={<Badge status={o.status} />}>
      <Card>
        <div className="row-between"><strong>{o.customer?.name}</strong><span className="mono small">{o.customer?.code}</span></div>
        <div className="muted small">{o.customer?.phone} {o.customer?.email ? `· ${o.customer.email}` : ''}</div>
        <div className="small">{[o.ship_to?.address1, o.ship_to?.address2, o.ship_to?.city, o.ship_to?.state, o.ship_to?.pincode].filter(Boolean).join(', ')}</div>
        <div className="muted small">{o.channel}{o.external_order_id ? ` · website order #${o.external_order_id}` : ''} · placed {dateTime(o.placed_at)}</div>
      </Card>
      {o.stock_shortfall && o.status !== 'cancelled' && (
        <div className="errorbox">Not enough stock to reserve this order.
          {can('warehouse', 'manager') && <button type="button" className="btn btn-small" disabled={busy} onClick={async () => {
            const r = await run<any>('retry_order_reservation', { p_order_id: orderId });
            if (r) { ord.reload(); }
          }}>Retry reservation</button>}
        </div>
      )}

      <table className="tbl">
        <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {o.lines.map((l: any) => (
            <tr key={l.id}><td>{l.sku_name}<div className="muted small">{inr(l.unit_price, 2)} · GST {Number(l.tax_rate)}% incl.{l.batches.length ? ' · ' + l.batches.map((b: any) => b.code).join(', ') : ''}</div></td>
              <td className="num">{qty(l.qty)}</td><td className="num">{inr(l.line_total, 2)}</td></tr>
          ))}
          <tr><td>Delivery</td><td /><td className="num">{inr(o.shipping_amount, 2)}</td></tr>
          {Number(o.discount_amount) > 0 && <tr><td>Discount</td><td /><td className="num">−{inr(o.discount_amount, 2)}</td></tr>}
          <tr className="total"><td>Total <span className="muted small">(incl. GST {inr(o.tax_amount, 2)})</span></td><td /><td className="num">{inr(o.total_amount, 2)}</td></tr>
        </tbody>
      </table>

      <h2 className="section">Payment <Badge status={o.payment_status} /></h2>
      <ul className="plain">
        {o.payments.map((p: any) => <li key={p.code}><span className="mono">{p.code}</span> · {p.kind === 'refund' ? 'Refund' : 'Payment'} {inr(p.amount, 2)} · {p.method ?? ''} {p.gateway_ref ?? ''} · {dateTime(p.received_at)}{p.notes ? ` · ${p.notes}` : ''}</li>)}
        {o.payments.length === 0 && <li className="muted">No payments recorded.</li>}
      </ul>

      {o.shipments.length > 0 && (
        <>
          <h2 className="section">Delivery</h2>
          <ul className="plain">
            {o.shipments.map((s: any) => <li key={s.code}><span className="mono">{s.code}</span> · {s.provider} {s.booking_ref ?? ''} · <Badge status={s.status === 'dispatched' ? 'dispatched' : s.status} />{s.tracking_url && <> · <a href={s.tracking_url} target="_blank" rel="noreferrer">track</a></>}{s.failure_reason ? ` · ${s.failure_reason}` : ''}</li>)}
          </ul>
        </>
      )}

      <div className="row-gap wrap">
        {o.packable && can('packer', 'warehouse', 'manager') && <button type="button" className="btn btn-primary" onClick={() => go(`pack/${o.id}`)}>Pack</button>}
        {can('manager') && ['unpaid', 'cod_pending'].includes(o.payment_status) && o.status !== 'cancelled' && <button type="button" className="btn" onClick={() => setSheet('payment')}>Record payment</button>}
        {can('manager') && canCancel && <button type="button" className="btn" onClick={() => setSheet('cancel')}>Cancel order</button>}
        {can('manager') && held > 0 && <button type="button" className="btn" onClick={() => setSheet('refund')}>Refund</button>}
      </div>
      {o.cancel_reason && <p className="muted">Cancelled {dateTime(o.cancelled_at)}: {o.cancel_reason}</p>}

      {sheet === 'cancel' && <ReasonSheet title={`Cancel ${o.code}`} button="Cancel order" note={held > 0 ? `After cancelling, refund ${inr(held, 2)} to the customer.` : undefined}
        onClose={() => setSheet(null)} onSubmit={async (reason) => {
          if (await run('cancel_order', { p_order_id: orderId, p_reason: reason }, 'Order cancelled; stock released')) { setSheet(null); ord.reload(); }
        }} />}
      {sheet === 'refund' && <AmountSheet title="Record refund" max={held} withReason onClose={() => setSheet(null)} onSubmit={async (amount, ref, reason) => {
        if (await run('record_refund', { p_order_id: orderId, p_amount: amount, p_reference: ref, p_reason: reason, p_idempotency_key: newKey('refund') }, 'Refund recorded')) { setSheet(null); ord.reload(); }
      }} />}
      {sheet === 'payment' && <AmountSheet title="Record payment" max={Number(o.total_amount) - held} onClose={() => setSheet(null)} onSubmit={async (amount, ref) => {
        if (await run('record_payment', { p_order_id: orderId, p_amount: amount, p_method: 'manual', p_reference: ref, p_idempotency_key: newKey('pay') }, 'Payment recorded')) { setSheet(null); ord.reload(); }
      }} />}
    </Page>
  );
}

function ReasonSheet({ title, button, note, onClose, onSubmit }: { title: string; button: string; note?: string; onClose(): void; onSubmit(r: string): void }) {
  const [reason, setReason] = useState('');
  return (
    <Sheet title={title} onClose={onClose}>
      <Field label="Reason (required)"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {note && <p className="notice small">{note}</p>}
      <button type="button" className="btn btn-primary btn-big" disabled={!reason.trim()} onClick={() => onSubmit(reason.trim())}>{button}</button>
    </Sheet>
  );
}

function AmountSheet({ title, max, withReason, onClose, onSubmit }: {
  title: string; max: number; withReason?: boolean; onClose(): void; onSubmit(a: number, ref: string, reason: string): void;
}) {
  const [amount, setAmount] = useState(String(max > 0 ? max : ''));
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Sheet title={title} onClose={onClose}>
      <Field label="Amount ₹" hint={`Up to ${inr(max, 2)}`}><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      <Field label="Reference (UPI / gateway / receipt no.)"><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      {withReason && <Field label="Reason (required)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      <button type="button" className="btn btn-primary btn-big" disabled={!Number(amount) || (withReason && !reason.trim())}
        onClick={() => onSubmit(Number(amount), ref.trim(), reason.trim())}>Save</button>
    </Sheet>
  );
}
