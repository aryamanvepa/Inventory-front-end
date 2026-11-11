import { useState } from 'react';
import { useAction, useApp, useRpc } from '../lib/app';
import { friendlyError, newKey } from '../lib/backend';
import { Scanner, feedback } from '../components/Scanner';
import { Card, date, Field, Loading, Page, Segmented, ymd } from '../components/ui';

type Step = 'product' | 'batch' | 'qty' | 'done';

export function Receive() {
  const { backend, toast, go } = useApp();
  const ref = useRpc<any>('get_reference_data');
  const skus = useRpc<any[]>('list_skus');
  const { run, busy } = useAction();

  const [step, setStep] = useState<Step>('product');
  const [sku, setSku] = useState<any>(null);
  const [batches, setBatches] = useState<any[]>([]);
  const [batch, setBatch] = useState<any>(null);
  const [newBatch, setNewBatch] = useState(false);
  const [mfg, setMfg] = useState(ymd());
  const [exp, setExp] = useState('');
  const [maker, setMaker] = useState('');
  const [lot, setLot] = useState('');
  const [cost, setCost] = useState('');
  const [n, setN] = useState('');
  const [loc, setLoc] = useState('');
  const [source, setSource] = useState<'production' | 'contract_manufacturer' | 'purchase'>('production');
  const [key, setKey] = useState(() => newKey('grn'));
  const [result, setResult] = useState<any>(null);

  const manufacturers = (ref.data?.partners ?? []).filter((p: any) => p.roles.some((r: any) => r.role === 'manufacturer'));
  const locations = ref.data?.locations ?? [];

  const pickSku = async (s: any) => {
    setSku(s);
    try {
      const st = await backend.rpc<any>('get_sku_stock', { p_sku_id: s.id });
      setBatches(st.batches.filter((b: any) => !b.expired));
    } catch (e) { toast(friendlyError(e), 'error'); }
    setStep(s.is_batch_tracked ? 'batch' : 'qty');
  };

  const onScan = async (code: string) => {
    try {
      const r = await backend.rpc<any>('resolve_scan', { p_code: code });
      if (r.kind === 'unknown') { feedback(false); toast(`Unknown code ${code}`, 'error'); return; }
      feedback(true);
      const s = skus.data?.find((x) => x.id === r.sku.id);
      await pickSku(s ?? r.sku);
      if (r.batch) { setBatch(r.batch); setStep('qty'); }
    } catch (e) { toast(friendlyError(e), 'error'); }
  };

  const reset = () => {
    setStep('product'); setSku(null); setBatch(null); setNewBatch(false); setN(''); setLot(''); setCost(''); setExp('');
    setResult(null); setKey(newKey('grn'));
  };

  if (!ref.data || !skus.data) return <Page title="Receive stock" back="home"><Loading /></Page>;
  const locId = loc || locations.find((l: any) => l.is_default)?.id || locations[0]?.id;

  return (
    <Page title="Receive stock" back="home">
      <ol className="steps">
        {(['product', 'batch', 'qty'] as Step[]).map((s, i) => (
          <li key={s} className={step === s ? 'on' : (['product', 'batch', 'qty', 'done'].indexOf(step) > i ? 'done' : '')}>
            {['Product', 'Batch', 'Quantity'][i]}
          </li>
        ))}
      </ol>

      {step === 'product' && (
        <>
          <Scanner onScan={onScan} placeholder="Scan product or batch label" />
          <p className="muted small">…or choose:</p>
          <div className="list">
            {skus.data.map((s) => (
              <Card key={s.id} onClick={() => pickSku(s)}>
                <strong>{s.name}</strong><div className="muted small"><span className="mono">{s.code}</span> · {s.brand}</div>
              </Card>
            ))}
          </div>
        </>
      )}

      {step === 'batch' && sku && (
        <>
          <Card><strong>{sku.name}</strong><div className="muted small mono">{sku.code}</div></Card>
          {!newBatch && (
            <>
              <h2 className="section">Which batch?</h2>
              <div className="list">
                {batches.map((b) => (
                  <Card key={b.id} onClick={() => { setBatch(b); setStep('qty'); }}>
                    <strong className="mono">{b.code}</strong>
                    <div className="muted small">Made {date(b.manufactured_on)} · Expires {date(b.expires_on)} · {b.manufacturer}</div>
                  </Card>
                ))}
              </div>
              <button type="button" className="btn btn-primary btn-big" onClick={() => setNewBatch(true)}>+ New batch</button>
            </>
          )}
          {newBatch && (
            <Card>
              <h2>New batch</h2>
              <Field label="Made by">
                <select value={maker} onChange={(e) => { setMaker(e.target.value); setSource(e.target.value ? 'contract_manufacturer' : 'production'); }}>
                  <option value="">Our own facility</option>
                  {manufacturers.map((m: any) => <option key={m.id} value={m.id}>{m.name} (contract)</option>)}
                </select>
              </Field>
              {maker && <Field label="Manufacturer's lot number"><input value={lot} onChange={(e) => setLot(e.target.value)} /></Field>}
              <Field label="Manufacture date"><input type="date" value={mfg} onChange={(e) => setMfg(e.target.value)} /></Field>
              <Field label="Expiry date" hint={sku.shelf_life_days ? `Leave blank to use shelf life (${sku.shelf_life_days} days)` : 'Required'}>
                <input type="date" value={exp} onChange={(e) => setExp(e.target.value)} />
              </Field>
              <Field label="Cost per unit ₹ (optional, for margin reports)"><input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
              <div className="row-gap">
                <button type="button" className="btn" onClick={() => setNewBatch(false)}>Back</button>
                <button type="button" className="btn btn-primary grow" disabled={busy} onClick={async () => {
                  const r = await run<any>('create_batch', { p: { sku_id: sku.id, manufactured_on: mfg, expires_on: exp || null,
                    manufacturer_partner_id: maker || null, external_lot_no: lot || null, unit_cost: cost || null } }, 'Batch created');
                  if (r) { setBatch({ id: r.batch_id, code: r.batch_code, expires_on: r.expires_on }); setNewBatch(false); setStep('qty'); }
                }}>Create batch</button>
              </div>
            </Card>
          )}
          <button type="button" className="btn btn-ghost" onClick={reset}>Start again</button>
        </>
      )}

      {step === 'qty' && sku && (
        <>
          <Card>
            <strong>{sku.name}</strong>
            {batch && <div className="muted small">Batch <span className="mono">{batch.code}</span> · expires {date(batch.expires_on)}</div>}
          </Card>
          <Field label="How many packs?"><input className="input-big" inputMode="numeric" autoFocus value={n} onChange={(e) => setN(e.target.value.replace(/[^\d]/g, ''))} /></Field>
          <Field label="Into location">
            <select value={locId} onChange={(e) => setLoc(e.target.value)}>
              {locations.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Source">
            <Segmented value={source} onChange={setSource} options={[
              { value: 'production', label: 'Our production' }, { value: 'contract_manufacturer', label: 'Contract mfr' }, { value: 'purchase', label: 'Purchase' }]} />
          </Field>
          <button type="button" className="btn btn-primary btn-big" disabled={busy || !n || Number(n) <= 0} onClick={async () => {
            const r = await run<any>('receive_stock', { p_sku_id: sku.id, p_batch_id: batch?.id ?? null, p_location_id: locId,
              p_qty: Number(n), p_source: source, p_idempotency_key: key });
            if (r) { setResult(r); setStep('done'); feedback(true); }
          }}>Confirm receipt of {n || 0}</button>
          <button type="button" className="btn btn-ghost" onClick={reset}>Start again</button>
        </>
      )}

      {step === 'done' && result && (
        <div className="stack">
          <div className="scan-result ok">Received {n} × {sku.name}{batch ? ` (batch ${batch.code})` : ''}. Record {result.transaction_code}.</div>
          <div className="muted">Now free to sell: {result.atp}</div>
          {result.orders_unblocked?.length > 0 && <div className="notice">Stock reserved for waiting orders: {result.orders_unblocked.join(', ')} — they are now in the packing queue.</div>}
          {batch && <a className="btn btn-big" href={`#/labels`} onClick={() => sessionStorage.setItem('tl-label', JSON.stringify({ kind: 'batch', code: batch.code, name: sku.name, expires_on: batch.expires_on, copies: Number(n) }))}>Print {n} batch labels</a>}
          <button type="button" className="btn btn-primary btn-big" onClick={reset}>Receive more</button>
          <button type="button" className="btn btn-ghost" onClick={() => go('stock/' + sku.id)}>View stock</button>
        </div>
      )}
    </Page>
  );
}
