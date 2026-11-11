// Printable QR labels. A batch label's QR holds the batch code, which
// identifies both the SKU and the batch — one scan at packing time.
// (Retail GS1 barcodes come later from GS1 India; these are internal labels.)
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useApp, useRpc } from '../lib/app';
import { date, Field, Loading, Page, Segmented } from '../components/ui';

type Label = { kind: 'batch' | 'sku'; code: string; name: string; expires_on?: string; copies: number };

function initial(): Label | null {
  try {
    const raw = sessionStorage.getItem('tl-label');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function Labels() {
  const { backend } = useApp();
  const skus = useRpc<any[]>('list_skus');
  const [preset] = useState(initial);
  const [kind, setKind] = useState<'batch' | 'sku'>(preset?.kind ?? 'batch');
  const [skuId, setSkuId] = useState('');
  const [batches, setBatches] = useState<any[]>([]);
  const [batchCode, setBatchCode] = useState(preset?.kind === 'batch' ? preset.code : '');
  const [copies, setCopies] = useState(String(Math.min(preset?.copies ?? 12, 200)));
  const [label, setLabel] = useState<Label | null>(preset);
  const [qr, setQr] = useState('');

  useEffect(() => { try { sessionStorage.removeItem('tl-label'); } catch { /* ignore */ } }, []);

  useEffect(() => {
    if (!skuId) return;
    backend.rpc<any>('get_sku_stock', { p_sku_id: skuId }).then((s) => setBatches(s.batches.filter((b: any) => !b.expired)));
  }, [skuId, backend]);

  useEffect(() => {
    const s = skus.data?.find((x) => x.id === skuId);
    if (kind === 'sku' && s) setLabel({ kind, code: s.code, name: s.name, copies: Number(copies) || 1 });
    if (kind === 'batch' && s && batchCode) {
      const b = batches.find((x) => x.code === batchCode);
      if (b) setLabel({ kind, code: b.code, name: s.name, expires_on: b.expires_on, copies: Number(copies) || 1 });
    }
  }, [kind, skuId, batchCode, batches, copies, skus.data]);

  useEffect(() => {
    if (!label) { setQr(''); return; }
    QRCode.toDataURL(label.code, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).then(setQr);
  }, [label?.code]);

  if (!skus.data) return <Page title="Print labels" back="more"><Loading /></Page>;
  const n = Math.max(1, Math.min(200, Number(copies) || 1));

  return (
    <Page title="Print labels" back="more">
      <div className="no-print stack">
        <Segmented value={kind} onChange={(v) => { setKind(v); setLabel(null); }} options={[{ value: 'batch', label: 'Batch labels' }, { value: 'sku', label: 'Product labels' }]} />
        <Field label="Product">
          <select value={skuId} onChange={(e) => { setSkuId(e.target.value); setBatchCode(''); setLabel(null); }}>
            <option value="">{preset && !skuId ? `${preset.name}` : '— choose —'}</option>
            {skus.data.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
          </select>
        </Field>
        {kind === 'batch' && skuId && (
          <Field label="Batch">
            <select value={batchCode} onChange={(e) => setBatchCode(e.target.value)}>
              <option value="">— choose —</option>
              {batches.map((b) => <option key={b.id} value={b.code}>{b.code} (exp {date(b.expires_on)})</option>)}
            </select>
          </Field>
        )}
        <Field label="Number of labels"><input inputMode="numeric" value={copies} onChange={(e) => setCopies(e.target.value.replace(/\D/g, ''))} /></Field>
        <button type="button" className="btn btn-primary btn-big" disabled={!label || !qr} onClick={() => window.print()}>Print</button>
        <p className="muted small">Labels print 3 across on A4 (about 63 × 38 mm). Stick a batch label on each pack or on the shelf tray.</p>
      </div>
      {label && qr && (
        <div className="label-sheet">
          {Array.from({ length: n }).map((_, i) => (
            <div className="label" key={i}>
              <img src={qr} alt={label.code} />
              <div>
                <div className="label-name">{label.name}</div>
                <div className="label-code">{label.code}</div>
                {label.expires_on && <div className="label-exp">Best before {date(label.expires_on)}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}
