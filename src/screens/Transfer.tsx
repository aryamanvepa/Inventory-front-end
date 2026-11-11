import { useEffect, useState } from 'react';
import { useAction, useApp, useRpc } from '../lib/app';
import { friendlyError, newKey } from '../lib/backend';
import { date, Field, Loading, Page, qty, Segmented } from '../components/ui';

export function Transfer() {
  const { backend, toast } = useApp();
  const ref = useRpc<any>('get_reference_data');
  const skus = useRpc<any[]>('list_skus');
  const { run, busy } = useAction();
  const [skuId, setSkuId] = useState('');
  const [stock, setStock] = useState<any>(null);
  const [batch, setBatch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [n, setN] = useState('');
  const [ownership, setOwnership] = useState<'keep' | 'to_partner'>('keep');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(() => newKey('trf'));
  const [done, setDone] = useState<any>(null);

  useEffect(() => {
    setStock(null); setBatch('');
    if (!skuId) return;
    backend.rpc<any>('get_sku_stock', { p_sku_id: skuId }).then(setStock).catch((e) => toast(friendlyError(e), 'error'));
  }, [skuId, backend, toast]);

  if (!ref.data || !skus.data) return <Page title="Transfer stock" back="home"><Loading /></Page>;
  const locations = ref.data.locations;
  const fromId = from || locations.find((l: any) => l.is_default)?.id;
  const toLoc = locations.find((l: any) => l.id === to);
  const partnerDest = !!toLoc?.partner_id;
  const companyOwner = ref.data.company_owner_id;
  const available = stock?.balances.filter((b: any) => b.location_id === fromId && b.status === 'available' && b.owner_id === companyOwner) ?? [];
  const sel = skus.data.find((s) => s.id === skuId);

  return (
    <Page title="Transfer stock" back="home">
      <p className="muted small">Moves stock between locations. Choose whether ownership stays with Torte Living (e.g. consignment
        to a distributor, or stock sent to a contract manufacturer) or passes to the partner (outright sale).</p>
      <Field label="Product">
        <select value={skuId} onChange={(e) => setSkuId(e.target.value)}>
          <option value="">— choose —</option>
          {skus.data.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
        </select>
      </Field>
      <Field label="From">
        <select value={fromId} onChange={(e) => setFrom(e.target.value)}>
          {locations.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
      {sel && (
        <Field label="Batch" hint={stock ? `${available.length ? '' : 'No stock of ours here. '}Free to transfer at the main warehouse: ${qty(sel.atp)}` : 'Loading…'}>
          <select value={batch} onChange={(e) => setBatch(e.target.value)}>
            <option value="">— choose —</option>
            {available.map((b: any) => <option key={b.batch_id ?? 'none'} value={b.batch_id ?? ''}>{b.batch_code ?? 'No batch'} · {qty(b.qty)} available{b.expires_on ? ` · exp ${date(b.expires_on)}` : ''}</option>)}
          </select>
        </Field>
      )}
      <Field label="To">
        <select value={to} onChange={(e) => { setTo(e.target.value); setOwnership('keep'); }}>
          <option value="">— choose —</option>
          {locations.filter((l: any) => l.id !== fromId).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
      {partnerDest && (
        <Field label="Ownership after the move">
          <Segmented value={ownership} onChange={setOwnership} options={[
            { value: 'keep', label: 'Still ours (consignment)' }, { value: 'to_partner', label: 'Sold to partner' }]} />
        </Field>
      )}
      <Field label="Quantity"><input inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/[^\d]/g, ''))} /></Field>
      <Field label="Note"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Consignment for Diwali orders" /></Field>
      {ownership === 'to_partner' && <p className="notice small">Recording an outright sale moves ownership in the stock ledger. The distributor sales order and GST invoice come with the Phase 3 distribution module.</p>}
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !skuId || !to || !n || (sel?.is_batch_tracked && !batch)} onClick={async () => {
        const r = await run<any>('transfer_stock', { p_sku_id: skuId, p_batch_id: batch || null, p_from_location: fromId, p_to_location: to,
          p_qty: Number(n), p_ownership: ownership, p_reason: reason || null, p_idempotency_key: key });
        if (r) { setDone(r); setKey(newKey('trf')); setN(''); backend.rpc<any>('get_sku_stock', { p_sku_id: skuId }).then(setStock); }
      }}>Transfer</button>
      {done && <div className="scan-result ok">Transfer {done.transaction_code} recorded{done.ownership_changed ? ' — ownership passed to the partner' : ' — still owned by Torte Living'}.</div>}
    </Page>
  );
}
