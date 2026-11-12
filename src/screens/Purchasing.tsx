import { useEffect, useMemo, useState } from 'react';
import { useAction, useApp, useRpc } from '../lib/app';
import { newKey } from '../lib/backend';
import { Badge, Card, date, Empty, ErrorBox, Field, inr, Loading, Page, qty, Segmented, Sheet, ymd } from '../components/ui';

type Section = 'orders' | 'bills' | 'pay';
const inr2 = (v: unknown) => inr(v, 2);
const num = (s: string) => s.replace(/[^\d.]/g, '');

function useSuppliers() {
  const ref = useRpc<any>('get_reference_data');
  const suppliers = (ref.data?.partners ?? []).filter((p: any) => p.roles.some((r: any) => ['supplier', 'manufacturer'].includes(r.role)));
  return { ref, suppliers };
}

export function Purchasing({ section }: { section?: string }) {
  const { go, can } = useApp();
  const s = (section as Section) || 'orders';
  const opts: { value: Section; label: string }[] = [{ value: 'orders', label: 'Purchase orders' }];
  if (can('accountant', 'manager')) opts.push({ value: 'bills', label: 'Supplier bills' }, { value: 'pay', label: 'Pay suppliers' });
  return (
    <Page title="Purchasing" back="more">
      <Segmented value={s} onChange={(v) => go(`purchasing/${v}`)} options={opts} />
      {s === 'orders' && <Orders />}
      {s === 'bills' && <Bills />}
      {s === 'pay' && <Pay />}
    </Page>
  );
}

function Orders() {
  const { can } = useApp();
  const [filter, setFilter] = useState('open_any');
  const list = useRpc<any[]>('list_purchase_orders', { p_status: filter === 'all' ? null : filter }, [filter]);
  const [receive, setReceive] = useState<{ po: any; line: any } | null>(null);
  const [prefill] = useState<{ sku_id: string; qty: number }[] | null>(() => {
    try {
      const raw = sessionStorage.getItem('tl-po-prefill');
      return raw ? JSON.parse(raw).lines : null;
    } catch { return null; }
  });
  useEffect(() => { try { sessionStorage.removeItem('tl-po-prefill'); } catch { /* ignore */ } }, []);
  const [create, setCreate] = useState(!!prefill && can('manager', 'accountant'));
  return (
    <>
      {can('manager', 'accountant') && <button type="button" className="btn btn-primary" onClick={() => setCreate(true)}>New purchase order</button>}
      <Segmented value={filter} onChange={setFilter} options={[{ value: 'open_any', label: 'Open' }, { value: 'received', label: 'Received' }, { value: 'all', label: 'All' }]} />
      {list.error && <ErrorBox text={list.error} />}
      {!list.data && !list.error && <Loading />}
      {list.data?.length === 0 && <Empty>No purchase orders here.</Empty>}
      <div className="list">
        {list.data?.map((po) => (
          <Card key={po.id}>
            <div className="row-between"><strong className="mono">{po.code}</strong><Badge status={po.status === 'received' ? 'delivered' : po.status === 'open' ? 'confirmed' : 'packing'}>{po.status.replace('_', ' ')}</Badge></div>
            <div className="small">{po.supplier} → {po.location} · {inr2(po.value)} ex-GST{po.expected_date ? ` · expected ${date(po.expected_date)}` : ''}</div>
            <table className="tbl">
              <thead><tr><th>Item</th><th className="num">Ordered</th><th className="num">Received</th><th /></tr></thead>
              <tbody>
                {po.lines.map((l: any) => (
                  <tr key={l.id}>
                    <td>{l.name}<div className="muted small"><span className="mono">{l.sku_code}</span> · {inr2(l.unit_price)}/{l.unit} · GST {Number(l.gst_rate)}%</div></td>
                    <td className="num">{qty(l.qty)} {l.unit}</td>
                    <td className="num">{qty(l.received_qty)}</td>
                    <td className="num">{can('warehouse', 'manager') && Number(l.received_qty) < Number(l.qty) && !['cancelled', 'closed'].includes(po.status) &&
                      <button type="button" className="btn btn-small" onClick={() => setReceive({ po, line: l })}>Receive</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}
      </div>
      {receive && <ReceiveSheet {...receive} onClose={() => setReceive(null)} onDone={() => { setReceive(null); list.reload(); }} />}
      {create && <NewPoSheet prefill={prefill} onClose={() => setCreate(false)} onDone={() => { setCreate(false); list.reload(); }} />}
    </>
  );
}

function ReceiveSheet({ po, line, onClose, onDone }: { po: any; line: any; onClose(): void; onDone(): void }) {
  const left = Number(line.qty) - Number(line.received_qty);
  const [n, setN] = useState(String(left));
  const [lot, setLot] = useState('');
  const [exp, setExp] = useState('');
  const [hold, setHold] = useState(false);
  const [key] = useState(() => newKey('grn'));
  const { run, busy } = useAction();
  const [done, setDone] = useState<any>(null);
  return (
    <Sheet title={`Receive ${line.name}`} onClose={onClose}>
      {done ? (
        <div className="stack">
          <div className="scan-result ok">Received {n} {line.unit} into batch {done.batch_code}. Stock and the books are updated.</div>
          <a className="btn btn-big btn-go go-stickers" href="#/labels" onClick={() => sessionStorage.setItem('tl-label', JSON.stringify({ kind: 'batch', sku_id: line.sku_id, code: done.batch_code, name: line.name, expires_on: exp || undefined,
            copies: line.unit === 'pcs' ? Math.min(Math.ceil(Number(n)), 500) : 1, back: 'purchasing/orders' }))}>Print barcode stickers for this delivery</a>
          <button type="button" className="btn btn-primary btn-big" onClick={onDone}>Done</button>
        </div>
      ) : (
        <>
          <div className="muted small">{po.code} from {po.supplier} · {qty(left)} {line.unit} still to come</div>
          <Field label={`Quantity received (${line.unit})`}><input className="input-big" inputMode="decimal" value={n} onChange={(e) => setN(num(e.target.value))} /></Field>
          <Field label="Supplier's lot / batch number"><input value={lot} onChange={(e) => setLot(e.target.value)} /></Field>
          <Field label="Expiry / best before" hint="Leave blank to use the material's shelf life"><input type="date" value={exp} onChange={(e) => setExp(e.target.value)} /></Field>
          <label className="row-gap small"><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} style={{ width: 'auto', minHeight: 0 }} /> Hold for quality check before use</label>
          <button type="button" className="btn btn-primary btn-big" disabled={busy || !Number(n) || Number(n) > left} onClick={async () => {
            const r = await run<any>('receive_purchase', { p_po_line_id: line.id, p_qty: Number(n),
              p_lot: { supplier_lot_no: lot || null, expires_on: exp || null, qa_status: hold ? 'pending' : null }, p_idempotency_key: key });
            if (r) setDone(r);
          }}>Confirm receipt</button>
        </>
      )}
    </Sheet>
  );
}

function NewPoSheet({ prefill, onClose, onDone }: { prefill?: { sku_id: string; qty: number }[] | null; onClose(): void; onDone(): void }) {
  const { ref, suppliers } = useSuppliers();
  const mats = useRpc<any[]>('list_materials');
  const skus = useRpc<any[]>('list_skus');
  const [supplier, setSupplier] = useState('');
  const [loc, setLoc] = useState('');
  const [expected, setExpected] = useState('');
  const [lines, setLines] = useState(prefill?.length
    ? prefill.map((p) => ({ sku_id: p.sku_id, qty: String(p.qty), unit_price: '', gst_rate: '' }))
    : [{ sku_id: '', qty: '', unit_price: '', gst_rate: '' }]);
  const { run, busy } = useAction();
  const items = useMemo(() => [
    ...(mats.data ?? []).map((m) => ({ id: m.id, label: `${m.name} (${m.code}, ${m.unit})` })),
    ...(skus.data ?? []).map((s) => ({ id: s.id, label: `${s.name} (${s.code}) — finished goods` })),
  ], [mats.data, skus.data]);
  const set = (i: number, k: string, v: string) => setLines(lines.map((l, n) => (n === i ? { ...l, [k]: v } : l)));
  const valid = supplier && lines.every((l) => l.sku_id && Number(l.qty) > 0 && l.unit_price !== '');
  const total = lines.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
  return (
    <Sheet title="New purchase order" onClose={onClose}>
      {suppliers.length === 0 && <p className="notice small">Add a supplier first under More → Admin → Partners (role: supplier).</p>}
      <Field label="Supplier">
        <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
          <option value="">— choose —</option>
          {suppliers.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <div className="row-gap">
        <Field label="Deliver to">
          <select value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">Main warehouse (default)</option>
            {(ref.data?.locations ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
        <Field label="Expected"><input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
      </div>
      {lines.map((l, i) => (
        <Card key={i}>
          <select value={l.sku_id} onChange={(e) => set(i, 'sku_id', e.target.value)} aria-label="Item">
            <option value="">Item…</option>
            {items.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
          <div className="row-gap">
            <input inputMode="decimal" placeholder="Qty" value={l.qty} onChange={(e) => set(i, 'qty', num(e.target.value))} aria-label="Quantity" style={{ flex: 1 }} />
            <input inputMode="decimal" placeholder="Price ex-GST" value={l.unit_price} onChange={(e) => set(i, 'unit_price', num(e.target.value))} aria-label="Unit price" style={{ flex: 1 }} />
            <input inputMode="decimal" placeholder="GST %" value={l.gst_rate} onChange={(e) => set(i, 'gst_rate', num(e.target.value))} aria-label="GST rate" style={{ flex: 1 }} />
          </div>
        </Card>
      ))}
      <button type="button" className="btn btn-small" onClick={() => setLines([...lines, { sku_id: '', qty: '', unit_price: '', gst_rate: '' }])}>+ Line</button>
      <div className="muted">Total ex-GST {inr2(total)}</div>
      <p className="muted small">Need a new ingredient or packaging item? Add it under Production → Materials.</p>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !valid} onClick={async () => {
        const r = await run<any>('create_purchase_order', { p: { supplier_id: supplier, deliver_to_location_id: loc || null, expected_date: expected || null,
          lines: lines.map((l) => ({ sku_id: l.sku_id, qty: Number(l.qty), unit_price: Number(l.unit_price), gst_rate: Number(l.gst_rate) || 0 })) } });
        if (r) onDone();
      }}>Create purchase order</button>
    </Sheet>
  );
}

function Bills() {
  const list = useRpc<any[]>('list_bills', {});
  const [create, setCreate] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setCreate(true)}>Record a supplier bill</button>
      {list.error && <ErrorBox text={list.error} />}
      {list.data?.length === 0 && <Empty>No supplier bills yet.</Empty>}
      <div className="list">
        {list.data?.map((b) => (
          <Card key={b.id}>
            <div className="row-between"><strong>{b.supplier}</strong><strong>{inr2(b.total)}</strong></div>
            <div className="small">Invoice {b.supplier_invoice_no} · {date(b.bill_date)}{b.due_date ? ` · due ${date(b.due_date)}` : ''} · <span className="mono">{b.code}</span></div>
            <div className="muted small">Taxable {inr2(b.taxable_value)} · GST {inr2(b.tax)} · {Number(b.outstanding) > 0 ? <span className="bad">{inr2(b.outstanding)} unpaid</span> : 'paid'}</div>
          </Card>
        ))}
      </div>
      {create && <BillSheet onClose={() => setCreate(false)} onDone={() => { setCreate(false); list.reload(); }} />}
    </>
  );
}

function BillSheet({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const { suppliers } = useSuppliers();
  const pos = useRpc<any[]>('list_purchase_orders', { p_status: 'to_bill' });
  const accounts = useRpc<any[]>('list_accounts');
  const [supplier, setSupplier] = useState('');
  const [inv, setInv] = useState('');
  const [billDate, setBillDate] = useState(ymd());
  const [due, setDue] = useState('');
  const [mode, setMode] = useState<'goods' | 'expense'>('goods');
  const [poLines, setPoLines] = useState<Record<string, { qty: string; price: string }>>({});
  const [exp, setExp] = useState({ account: 'other_expenses', description: '', amount: '', gst: '' });
  const [key] = useState(() => newKey('bill'));
  const { run, busy } = useAction();
  const supplierPos = (pos.data ?? []).filter((p) => p.supplier_id === supplier);
  const expenseAccounts = (accounts.data ?? []).filter((a) => a.type === 'expense' || a.system_key === 'fixed_assets' || a.system_key === 'advances');

  const lines = mode === 'goods'
    ? Object.entries(poLines).filter(([, v]) => Number(v.qty) > 0).map(([id, v]) => ({ po_line_id: id, qty: Number(v.qty), unit_price: v.price === '' ? undefined : Number(v.price) }))
    : [{ expense_account: exp.account, description: exp.description, amount: Number(exp.amount), gst_rate: Number(exp.gst) || 0 }];
  const ok = supplier && inv.trim() && (mode === 'goods' ? lines.length > 0 : Number(exp.amount) > 0);

  return (
    <Sheet title="Record a supplier bill" onClose={onClose}>
      <Field label="Supplier">
        <select value={supplier} onChange={(e) => { setSupplier(e.target.value); setPoLines({}); }}>
          <option value="">— choose —</option>
          {suppliers.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Supplier's invoice number"><input value={inv} onChange={(e) => setInv(e.target.value)} /></Field>
      <div className="row-gap">
        <Field label="Bill date"><input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} /></Field>
        <Field label="Due date"><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
      <Segmented value={mode} onChange={setMode} options={[{ value: 'goods', label: 'For goods received' }, { value: 'expense', label: 'Expense (rent, gas…)' }]} />
      {mode === 'goods' && (
        supplier && supplierPos.length === 0 ? <p className="muted small">Nothing received from this supplier is waiting to be billed.</p> :
        supplierPos.map((po) => (
          <Card key={po.id}>
            <strong className="mono">{po.code}</strong>
            {po.lines.filter((l: any) => Number(l.received_qty) > Number(l.billed_qty)).map((l: any) => {
              const max = Number(l.received_qty) - Number(l.billed_qty);
              const v = poLines[l.id] ?? { qty: '', price: '' };
              return (
                <div key={l.id} className="stack">
                  <div className="small">{l.name} · {qty(max)} {l.unit} to bill · PO price {inr2(l.unit_price)} · GST {Number(l.gst_rate)}%</div>
                  <div className="row-gap">
                    <input inputMode="decimal" placeholder={`Qty (max ${max})`} value={v.qty} aria-label="Quantity billed"
                      onChange={(e) => setPoLines({ ...poLines, [l.id]: { ...v, qty: num(e.target.value) } })} style={{ flex: 1 }} />
                    <input inputMode="decimal" placeholder="Billed price (if different)" value={v.price} aria-label="Billed unit price"
                      onChange={(e) => setPoLines({ ...poLines, [l.id]: { ...v, price: num(e.target.value) } })} style={{ flex: 1 }} />
                  </div>
                </div>
              );
            })}
          </Card>
        ))
      )}
      {mode === 'expense' && (
        <>
          <Field label="Expense type">
            <select value={exp.account} onChange={(e) => setExp({ ...exp, account: e.target.value })}>
              {expenseAccounts.map((a) => <option key={a.code} value={a.system_key ?? a.code}>{a.code} {a.name}</option>)}
            </select>
          </Field>
          <Field label="Description"><input value={exp.description} onChange={(e) => setExp({ ...exp, description: e.target.value })} /></Field>
          <div className="row-gap">
            <Field label="Amount before GST ₹"><input inputMode="decimal" value={exp.amount} onChange={(e) => setExp({ ...exp, amount: num(e.target.value) })} /></Field>
            <Field label="GST %"><input inputMode="decimal" value={exp.gst} onChange={(e) => setExp({ ...exp, gst: num(e.target.value) })} /></Field>
          </div>
        </>
      )}
      <p className="muted small">GST is split into CGST+SGST or IGST automatically from the supplier's state.</p>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !ok} onClick={async () => {
        const r = await run<any>('record_purchase_bill', { p: { supplier_id: supplier, supplier_invoice_no: inv.trim(), bill_date: billDate,
          due_date: due || null, idempotency_key: key, lines } }, 'Bill recorded');
        if (r) onDone();
      }}>Record bill</button>
    </Sheet>
  );
}

function Pay() {
  const { suppliers } = useSuppliers();
  const bills = useRpc<any[]>('list_bills', {});
  const ap = useRpc<any>('payables_ageing');
  const [supplier, setSupplier] = useState('');
  const [bill, setBill] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [refNo, setRefNo] = useState('');
  const [key, setKey] = useState(() => newKey('spay'));
  const { run, busy } = useAction();
  const open = (bills.data ?? []).filter((b) => b.supplier_id === supplier && Number(b.outstanding) > 0);
  return (
    <>
      {ap.data && (
        <Card>
          <strong>Owed to suppliers: {inr2(ap.data.total_due)}</strong>
          {Number(ap.data.overdue) > 0 && <div className="bad small">Overdue: {inr2(ap.data.overdue)}</div>}
          <ul className="plain small">{ap.data.open_bills.map((b: any) => <li key={b.code} className={b.overdue ? 'bad' : ''}>{b.supplier} · {b.supplier_invoice_no} · {inr2(b.due)} · due {date(b.due_date)}</li>)}</ul>
        </Card>
      )}
      <Card>
        <strong>Record a payment to a supplier</strong>
        <Field label="Supplier">
          <select value={supplier} onChange={(e) => { setSupplier(e.target.value); setBill(''); }}>
            <option value="">— choose —</option>
            {suppliers.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Against bill (optional)">
          <select value={bill} onChange={(e) => { setBill(e.target.value); const b = open.find((x) => x.id === e.target.value); if (b) setAmount(String(b.outstanding)); }}>
            <option value="">On account / advance</option>
            {open.map((b) => <option key={b.id} value={b.id}>{b.supplier_invoice_no} · {inr2(b.outstanding)} due</option>)}
          </select>
        </Field>
        <div className="row-gap">
          <Field label="Amount ₹"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(num(e.target.value))} /></Field>
          <Field label="Paid by">
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="bank_transfer">Bank transfer</option><option value="upi">UPI</option><option value="cheque">Cheque</option><option value="cash">Cash</option>
            </select>
          </Field>
        </div>
        <Field label="Reference (UTR / cheque no.)"><input value={refNo} onChange={(e) => setRefNo(e.target.value)} /></Field>
        <button type="button" className="btn btn-primary btn-big" disabled={busy || !supplier || !Number(amount)} onClick={async () => {
          const r = await run<any>('record_supplier_payment', { p_supplier_id: supplier, p_amount: Number(amount), p_method: method,
            p_reference: refNo || null, p_bill_id: bill || null, p_idempotency_key: key }, 'Payment recorded');
          if (r) { setAmount(''); setRefNo(''); setBill(''); setKey(newKey('spay')); bills.reload(); ap.reload(); }
        }}>Record payment</button>
      </Card>
    </>
  );
}
