import { useState } from 'react';
import { useAction, useApp, useRpc } from '../lib/app';
import { friendlyError, newKey } from '../lib/backend';
import { Scanner } from '../components/Scanner';
import { Badge, Card, date, dateTime, Empty, ErrorBox, Field, inr, label, Loading, Page, qty, Segmented, Sheet, Stat } from '../components/ui';

export function StockList() {
  const { backend, go, toast } = useApp();
  const [search, setSearch] = useState('');
  const list = useRpc<any[]>('list_skus', { p_search: search || null }, []);

  return (
    <Page title="Stock (detailed)" back="inventory">
      <Scanner placeholder="Scan or search a product" autoFocus={false} onScan={async (code) => {
        try {
          const r = await backend.rpc<any>('resolve_scan', { p_code: code });
          if (r.kind === 'sku' || r.kind === 'batch') go(`stock/${r.sku.id}`);
          else setSearch(code);
        } catch (e) { toast(friendlyError(e), 'error'); }
      }} />
      {search && <button type="button" className="btn btn-ghost btn-small" onClick={() => setSearch('')}>Clear search “{search}”</button>}
      {list.error && <ErrorBox text={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <Loading />}
      {list.data?.length === 0 && <Empty>No products found.</Empty>}
      <div className="list">
        {list.data?.map((s) => (
          <Card key={s.id} onClick={() => go(`stock/${s.id}`)}>
            <div className="row-between">
              <div>
                <strong>{s.name}</strong>
                <div className="muted small"><span className="mono">{s.code}</span> · {s.brand}</div>
              </div>
              <div className="right">
                <div className={`big-num ${s.low_stock ? 'bad' : ''}`}>{qty(s.atp)}</div>
                <div className="muted small">free to sell</div>
              </div>
            </div>
            <div className="muted small">{qty(s.sellable)} on shelf · {qty(s.reserved)} reserved · {qty(s.packed)} packed{s.low_stock ? ' · ' : ''}{s.low_stock && <span className="bad">below reorder level {s.reorder_level}</span>}</div>
          </Card>
        ))}
      </div>
    </Page>
  );
}

export function SkuDetail({ skuId }: { skuId: string }) {
  const { can } = useApp();
  const st = useRpc<any>('get_sku_stock', { p_sku_id: skuId });
  const ref = useRpc<any>('get_reference_data');
  const [sheet, setSheet] = useState<null | 'adjust' | 'status' | { qa: any }>(null);
  const d = st.data;

  if (st.error) return <Page title="Product" back="stock"><ErrorBox text={st.error} onRetry={st.reload} /></Page>;
  if (!d) return <Page title="Product" back="stock"><Loading /></Page>;
  const s = d.sku;

  const byLocation: Record<string, any[]> = {};
  for (const b of d.balances) (byLocation[b.location] ??= []).push(b);

  return (
    <Page title={s.name} back="stock">
      <div className="muted small"><span className="mono">{s.code}</span> · {s.brand} · {s.category ?? 'Uncategorised'} · MRP {inr(s.mrp)}{s.web_price != null ? ` · Web ${inr(s.web_price)}` : ''}
        {s.hsn ? ` · HSN ${s.hsn} (${s.gst_rate}% GST)` : ''}</div>
      <div className="stats">
        <Stat label="Free to sell" value={qty(s.atp)} tone={s.low_stock ? 'bad' : 'ok'} />
        <Stat label="On shelf" value={qty(s.sellable)} />
        <Stat label="Reserved for orders" value={qty(s.reserved)} />
        <Stat label="Packed, not sent" value={qty(s.packed)} />
      </div>
      {s.low_stock && <div className="notice">Below reorder level ({s.reorder_level}).</div>}

      {can('manager') && (
        <div className="row-gap wrap">
          <button type="button" className="btn" onClick={() => setSheet('adjust')}>Adjust count</button>
          <button type="button" className="btn" onClick={() => setSheet('status')}>Mark damaged / expired</button>
          <a className="btn" href={`#/labels/item/${s.id}`}>Barcode stickers</a>
        </div>
      )}

      <h2 className="section">Where it is</h2>
      {Object.keys(byLocation).length === 0 && <Empty>No stock anywhere.</Empty>}
      {Object.entries(byLocation).map(([loc, rows]) => (
        <Card key={loc}>
          <strong>{loc}</strong>
          <table className="tbl">
            <thead><tr><th>Batch</th><th>Status</th><th>Owner</th><th className="num">Qty</th></tr></thead>
            <tbody>
              {rows.map((b, i) => (
                <tr key={i}>
                  <td><span className="mono">{b.batch_code ?? '—'}</span>{b.expires_on && <div className="muted small">exp {date(b.expires_on)}</div>}</td>
                  <td><Badge status={b.status} />{b.qa_status && b.qa_status !== 'released' && <Badge status={b.qa_status} />}</td>
                  <td><Badge status={b.holding} /><div className="muted small">{b.owner}</div></td>
                  <td className="num">{qty(b.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}

      <h2 className="section">Batches</h2>
      <div className="list">
        {d.batches.map((b: any) => (
          <Card key={b.id}>
            <div className="row-between">
              <strong className="mono">{b.code}</strong>
              <span>{b.expired ? <Badge status="expired" /> : <Badge status={b.qa_status} />}</span>
            </div>
            <div className="muted small">Made {date(b.manufactured_on)} · Expires {date(b.expires_on)} · {b.manufacturer}{b.external_lot_no ? ` (lot ${b.external_lot_no})` : ''} · {qty(b.on_hand)} in stock</div>
            {b.qa_notes && <div className="small pre">{b.qa_notes}</div>}
            {can('manager') && !b.expired && (
              <button type="button" className="btn btn-small" onClick={() => setSheet({ qa: b })}>
                {b.qa_status === 'released' ? 'Put on quality hold' : 'Quality decision'}
              </button>
            )}
          </Card>
        ))}
      </div>

      {d.reservations.length > 0 && (
        <>
          <h2 className="section">Reserved for</h2>
          <ul className="plain">
            {d.reservations.map((r: any, i: number) => <li key={i}><a href={`#/orders/${r.order_id}`} className="mono">{r.order_code}</a> · {qty(r.qty)}</li>)}
          </ul>
        </>
      )}

      <h2 className="section">Recent movements</h2>
      <ul className="log">
        {d.movements.map((m: any, i: number) => (
          <li key={i}>
            <div className="row-between"><span><span className="mono">{m.txn_code}</span> · {label(m.type)}</span><strong className={Number(m.qty) < 0 ? 'bad' : 'ok'}>{Number(m.qty) > 0 ? '+' : ''}{qty(m.qty)}</strong></div>
            <div className="small muted">{dateTime(m.at)} · {m.location} · {label(m.status)}{m.batch_code ? ` · ${m.batch_code}` : ''}{m.by ? ` · ${m.by}` : ''}</div>
            {m.reason && <div className="small">{m.reason}</div>}
          </li>
        ))}
      </ul>

      {sheet === 'adjust' && <AdjustSheet sku={s} batches={d.batches} locations={ref.data?.locations ?? []} onClose={() => setSheet(null)} onDone={() => { setSheet(null); st.reload(); }} />}
      {sheet === 'status' && <StatusSheet sku={s} batches={d.batches} locations={ref.data?.locations ?? []} onClose={() => setSheet(null)} onDone={() => { setSheet(null); st.reload(); }} />}
      {sheet && typeof sheet === 'object' && <QaSheet batch={sheet.qa} onClose={() => setSheet(null)} onDone={() => { setSheet(null); st.reload(); }} />}
    </Page>
  );
}

function BatchLocationFields({ batches, locations, batch, setBatch, loc, setLoc }: any) {
  return (
    <>
      <Field label="Batch">
        <select value={batch} onChange={(e) => setBatch(e.target.value)}>
          <option value="">— choose —</option>
          {batches.map((b: any) => <option key={b.id} value={b.id}>{b.code} (exp {date(b.expires_on)})</option>)}
        </select>
      </Field>
      <Field label="Location">
        <select value={loc} onChange={(e) => setLoc(e.target.value)}>
          {locations.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
    </>
  );
}

function AdjustSheet({ sku, batches, locations, onClose, onDone }: any) {
  const [batch, setBatch] = useState('');
  const [loc, setLoc] = useState(locations[0]?.id ?? '');
  const [dir, setDir] = useState<'add' | 'remove'>('remove');
  const [n, setN] = useState('');
  const [reason, setReason] = useState('');
  const [key] = useState(() => newKey('adj'));
  const { run, busy } = useAction();
  return (
    <Sheet title={`Adjust ${sku.name}`} onClose={onClose}>
      <p className="muted small">Use this when a physical count differs from the system. Who, when and why is recorded permanently.</p>
      <BatchLocationFields {...{ batches, locations, batch, setBatch, loc, setLoc }} />
      <Segmented value={dir} onChange={setDir} options={[{ value: 'remove', label: 'Remove' }, { value: 'add', label: 'Add' }]} />
      <Field label="Quantity"><input inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      <Field label="Reason (required)"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Monthly count found 2 fewer" /></Field>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !n || !reason.trim() || (sku.is_batch_tracked && !batch)} onClick={async () => {
        const r = await run('adjust_stock', { p_sku_id: sku.id, p_batch_id: batch || null, p_location_id: loc,
          p_qty_delta: dir === 'add' ? Number(n) : -Number(n), p_reason: reason.trim(), p_idempotency_key: key }, 'Adjustment recorded');
        if (r) onDone();
      }}>Record adjustment</button>
    </Sheet>
  );
}

function StatusSheet({ sku, batches, locations, onClose, onDone }: any) {
  const [batch, setBatch] = useState('');
  const [loc, setLoc] = useState(locations[0]?.id ?? '');
  const [to, setTo] = useState<'damaged' | 'expired' | 'quarantine'>('damaged');
  const [n, setN] = useState('');
  const [reason, setReason] = useState('');
  const { run, busy } = useAction();
  return (
    <Sheet title="Take stock out of sale" onClose={onClose}>
      <BatchLocationFields {...{ batches, locations, batch, setBatch, loc, setLoc }} />
      <Field label="Mark as">
        <Segmented value={to} onChange={setTo} options={[{ value: 'damaged', label: 'Damaged' }, { value: 'expired', label: 'Expired' }, { value: 'quarantine', label: 'Quarantine' }]} />
      </Field>
      <Field label="Quantity"><input inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      <Field label="Reason (required)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !n || !reason.trim() || (sku.is_batch_tracked && !batch)} onClick={async () => {
        const r = await run('change_stock_status', { p_sku_id: sku.id, p_batch_id: batch || null, p_location_id: loc,
          p_from: 'available', p_to: to, p_qty: Number(n), p_reason: reason.trim(), p_idempotency_key: newKey('status') }, 'Stock status updated');
        if (r) onDone();
      }}>Confirm</button>
    </Sheet>
  );
}

function QaSheet({ batch, onClose, onDone }: any) {
  const [status, setStatus] = useState<string>(batch.qa_status === 'released' ? 'quarantined' : 'released');
  const [notes, setNotes] = useState('');
  const { run, busy } = useAction();
  return (
    <Sheet title={`Quality: ${batch.code}`} onClose={onClose}>
      <Segmented value={status} onChange={setStatus} options={[
        { value: 'released', label: 'Release for sale' }, { value: 'quarantined', label: 'Hold' }, { value: 'rejected', label: 'Reject' }]} />
      <Field label="Reason / test result (required)"><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <p className="muted small">Held or rejected batches cannot be packed. Only managers can release them.</p>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !notes.trim()} onClick={async () => {
        if (await run('set_batch_qa', { p_batch_id: batch.id, p_status: status, p_notes: notes.trim() }, 'Quality status saved')) onDone();
      }}>Save</button>
    </Sheet>
  );
}
