import { useMemo, useState } from 'react';
import { useAction, useApp, useRpc } from '../lib/app';
import { newKey } from '../lib/backend';
import { Card, date, dateTime, Empty, ErrorBox, Field, inr, label, Loading, Page, qty, Segmented, Sheet, Stat, ymd } from '../components/ui';

type Section = 'overview' | 'reports' | 'journals' | 'invoices' | 'company';

const today = () => ymd();
const monthStart = (d = new Date()) => ymd(new Date(d.getFullYear(), d.getMonth(), 1));
const fyStart = () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-04-01`; };
const inr2 = (v: unknown) => inr(v, 2);

function useRange(initial: 'month' | 'fy' = 'month') {
  const [preset, setPreset] = useState<'month' | 'last' | 'fy' | 'custom'>(initial);
  const [from, setFrom] = useState(initial === 'fy' ? fyStart() : monthStart());
  const [to, setTo] = useState(today());
  const pick = (p: typeof preset) => {
    setPreset(p);
    if (p === 'month') { setFrom(monthStart()); setTo(today()); }
    if (p === 'last') {
      const d = new Date(); const s = new Date(d.getFullYear(), d.getMonth() - 1, 1); const e = new Date(d.getFullYear(), d.getMonth(), 0);
      setFrom(ymd(s)); setTo(ymd(e));
    }
    if (p === 'fy') { setFrom(fyStart()); setTo(today()); }
  };
  const ui = (
    <div className="stack">
      <Segmented value={preset} onChange={pick} options={[{ value: 'month', label: 'This month' }, { value: 'last', label: 'Last month' },
        { value: 'fy', label: 'Year to date' }, { value: 'custom', label: 'Custom' }]} />
      {preset === 'custom' && (
        <div className="row-gap">
          <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      )}
    </div>
  );
  return { from, to, ui };
}

export function Accounts({ section }: { section?: string }) {
  const { go } = useApp();
  const s = (section as Section) || 'overview';
  return (
    <Page title="Accounts" back="more">
      <Segmented value={s} onChange={(v) => go(`accounts/${v}`)} options={[
        { value: 'overview', label: 'Overview' }, { value: 'reports', label: 'Reports' }, { value: 'invoices', label: 'Invoices' },
        { value: 'journals', label: 'Journals' }, { value: 'company', label: 'Setup' }]} />
      {s === 'overview' && <Overview />}
      {s === 'reports' && <Reports />}
      {s === 'invoices' && <Invoices />}
      {s === 'journals' && <Journals />}
      {s === 'company' && <Company />}
    </Page>
  );
}

// ---------------------------------------------------------------- Overview (MIS)
export function MisView({ from, to }: { from: string; to: string }) {
  const m = useRpc<any>('get_mis', { p_from: from, p_to: to }, [from, to]);
  if (m.error) return <ErrorBox text={m.error} onRetry={m.reload} />;
  if (!m.data) return <Loading />;
  const d = m.data; const p = d.pnl;
  const gm = Number(p.revenue) ? Math.round((1000 * Number(p.gross_profit)) / Number(p.revenue)) / 10 : null;
  const gst = d.gst_payable ?? {};
  return (
    <>
      {!d.company_gst_set && <div className="errorbox">Company GSTIN and state are not set, so GST invoices can't be issued. <a href="#/accounts/company">Set them</a></div>}
      {d.exceptions > 0 && <a className="alert sev-high" href="#/accounts/company"><strong>{d.exceptions} accounting item{d.exceptions > 1 ? 's' : ''} need attention</strong><span>Open Setup → Exceptions</span></a>}
      <h2 className="section">Profit and loss</h2>
      <div className="stats">
        <Stat label="Net revenue (ex-GST)" value={inr(p.revenue)} />
        <Stat label={`Gross profit${gm !== null ? ` · ${gm}%` : ''}`} value={inr(p.gross_profit)} tone={Number(p.gross_profit) < 0 ? 'bad' : undefined} />
        <Stat label="Operating expenses" value={inr(p.operating_expenses)} />
        <Stat label="Net profit" value={inr(p.net_profit)} tone={Number(p.net_profit) < 0 ? 'bad' : 'ok'} />
      </div>
      {d.by_brand?.length > 0 && (
        <table className="tbl">
          <thead><tr><th>Brand</th><th className="num">Revenue</th><th className="num">Cost of goods</th><th className="num">Margin</th></tr></thead>
          <tbody>{d.by_brand.map((b: any) => <tr key={b.brand}><td>{b.brand}</td><td className="num">{inr(b.revenue)}</td><td className="num">{inr(b.cogs)}</td>
            <td className="num">{b.gross_margin_pct != null ? `${b.gross_margin_pct}%` : '—'}</td></tr>)}</tbody>
        </table>
      )}
      <h2 className="section">Cash, receivables and payables (today)</h2>
      <div className="stats">
        <Stat label="Bank" value={inr(d.cash?.bank)} />
        <Stat label="Cash on hand" value={inr(d.cash?.cash)} />
        <Stat label="Gateway (not yet settled)" value={inr(d.cash?.gateway_clearing)} />
        <Stat label="Customers owe" value={inr(Math.max(Number(d.receivables ?? 0), 0))} />
        <Stat label="We owe suppliers" value={inr(d.payables)} tone={Number(d.payables_overdue) > 0 ? 'warn' : undefined} />
        <Stat label="Supplier bills overdue" value={inr(d.payables_overdue)} tone={Number(d.payables_overdue) > 0 ? 'bad' : undefined} />
      </div>
      <h2 className="section">GST for the period</h2>
      <div className="stats">
        <Stat label="CGST payable" value={inr2(gst.cgst)} />
        <Stat label="SGST payable" value={inr2(gst.sgst)} />
        <Stat label="IGST payable" value={inr2(gst.igst)} />
      </div>
      <p className="muted small">Negative = more input credit than output tax (carried forward).</p>
      <h2 className="section">Inventory at cost</h2>
      <table className="tbl">
        <thead><tr><th>Type</th><th className="num">Stock at cost</th><th className="num">Books</th><th className="num">Difference</th></tr></thead>
        <tbody>{(d.inventory ?? []).map((r: any) => (
          <tr key={r.account}><td>{({ inv_finished: 'Finished goods', inv_raw: 'Raw materials', inv_packaging: 'Packaging' } as any)[r.account]}</td>
            <td className="num">{inr(r.stock_value)}</td><td className="num">{inr(r.ledger_value)}</td>
            <td className={`num ${Number(r.difference) !== 0 ? 'bad' : ''}`}>{inr(r.difference)}</td></tr>))}</tbody>
      </table>
      {Number(d.overheads?.absorbed) > Number(d.overheads?.actual) + 1 && (
        <div className="notice small">
          {inr(d.overheads.absorbed)} of labour and overheads was added to batch costs this period, but only {inr(d.overheads.actual)} of actual
          production overheads has been recorded. Record those bills (expense type “Production overheads”) — until then, profit is overstated
          by {inr(Number(d.overheads.absorbed) - Number(d.overheads.actual))}.
        </div>
      )}
      <h2 className="section">Production</h2>
      <div className="stats">
        <Stat label="Runs completed" value={d.production?.runs ?? 0} />
        <Stat label="Packs produced" value={qty(d.production?.units)} />
        <Stat label="Average yield" value={d.production?.avg_yield_pct != null ? `${d.production.avg_yield_pct}%` : '—'} />
        <Stat label="Material over/(under) use" value={inr(d.production?.material_variance)} tone={Number(d.production?.material_variance) > 0 ? 'warn' : undefined} />
      </div>
      {d.unit_costs?.length > 0 && (
        <>
          <h2 className="section">Unit cost and margin (latest batch, website price)</h2>
          <table className="tbl">
            <thead><tr><th>Product</th><th className="num">Unit cost</th><th className="num">Web price</th><th className="num">Margin</th></tr></thead>
            <tbody>{d.unit_costs.map((u: any) => <tr key={u.code}><td>{u.sku}<div className="muted small mono">{u.code}</div></td>
              <td className="num">{inr2(u.unit_cost)}</td><td className="num">{inr(u.web_price)}</td>
              <td className="num">{u.margin_pct != null ? `${u.margin_pct}%` : '—'}</td></tr>)}</tbody>
          </table>
        </>
      )}
      {d.purchases_by_supplier?.length > 0 && (
        <>
          <h2 className="section">Purchases by supplier (ex-GST)</h2>
          <ul className="plain">{d.purchases_by_supplier.map((x: any) => <li key={x.supplier}>{x.supplier}: {inr(x.amount)}</li>)}</ul>
        </>
      )}
      <p className="muted small">Open purchase orders not yet received: {inr(d.open_purchase_orders)}</p>
    </>
  );
}

function Overview() {
  const r = useRange('month');
  return <>{r.ui}<MisView from={r.from} to={r.to} /></>;
}

// ---------------------------------------------------------------- Reports
function Reports() {
  const [kind, setKind] = useState<'pnl' | 'bs' | 'tb' | 'gst'>('pnl');
  const r = useRange('fy');
  const [asOf, setAsOf] = useState(today());
  return (
    <>
      <Segmented value={kind} onChange={setKind} options={[{ value: 'pnl', label: 'Profit & loss' }, { value: 'bs', label: 'Balance sheet' },
        { value: 'tb', label: 'Trial balance' }, { value: 'gst', label: 'GST' }]} />
      {kind !== 'bs' && kind !== 'tb' ? r.ui : <Field label="As of"><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>}
      <div className="no-print"><button type="button" className="btn btn-small" onClick={() => window.print()}>Print</button></div>
      {kind === 'pnl' && <PnL from={r.from} to={r.to} />}
      {kind === 'bs' && <BalanceSheet asOf={asOf} />}
      {kind === 'tb' && <TrialBalance asOf={asOf} />}
      {kind === 'gst' && <Gst from={r.from} to={r.to} />}
    </>
  );
}

function PnL({ from, to }: { from: string; to: string }) {
  const q = useRpc<any>('profit_and_loss', { p_from: from, p_to: to }, [from, to]);
  if (q.error) return <ErrorBox text={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <Card>
      <strong>Profit and loss · {date(from)} – {date(to)}</strong>
      {(d.sections ?? []).map((s: any) => (
        <table className="tbl" key={s.group}>
          <thead><tr><th>{s.group}</th><th className="num">₹</th></tr></thead>
          <tbody>
            {s.rows.map((r: any) => <tr key={r.code}><td><span className="mono small">{r.code}</span> {r.name}</td><td className="num">{inr2(r.amount)}</td></tr>)}
            <tr className="total"><td>Total {s.group.toLowerCase()}</td><td className="num">{inr2(s.total)}</td></tr>
          </tbody>
        </table>
      ))}
      <table className="tbl"><tbody>
        <tr className="total"><td>Gross profit{d.gross_margin_pct != null ? ` (${d.gross_margin_pct}%)` : ''}</td><td className="num">{inr2(d.gross_profit)}</td></tr>
        <tr className="total"><td>Net profit</td><td className={`num ${Number(d.net_profit) < 0 ? 'bad' : ''}`}>{inr2(d.net_profit)}</td></tr>
      </tbody></table>
      {d.by_brand?.length > 0 && (
        <table className="tbl">
          <thead><tr><th>By brand</th><th className="num">Revenue</th><th className="num">Cost</th><th className="num">GP %</th></tr></thead>
          <tbody>{d.by_brand.map((b: any) => <tr key={b.brand}><td>{b.brand}</td><td className="num">{inr2(b.revenue)}</td><td className="num">{inr2(b.cogs)}</td><td className="num">{b.gross_margin_pct ?? '—'}</td></tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}

function BalanceSheet({ asOf }: { asOf: string }) {
  const q = useRpc<any>('balance_sheet', { p_as_of: asOf }, [asOf]);
  if (q.error) return <ErrorBox text={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  const block = (t: string) => (d.sections ?? []).filter((s: any) => s.type === t);
  return (
    <Card>
      <strong>Balance sheet as of {date(asOf)}</strong> {d.balanced ? <span className="badge tone-ok">Balanced</span> : <span className="badge tone-bad">Out of balance</span>}
      {(['asset', 'liability', 'equity'] as const).map((t) => (
        <table className="tbl" key={t}>
          <thead><tr><th>{t === 'asset' ? 'Assets' : t === 'liability' ? 'Liabilities' : 'Equity'}</th><th className="num">₹</th></tr></thead>
          <tbody>
            {block(t).flatMap((s: any) => s.rows.map((r: any) => <tr key={r.code}><td><span className="mono small">{r.code}</span> {r.name}</td><td className="num">{inr2(r.amount)}</td></tr>))}
            {t === 'equity' && <tr><td>Profit to date (not yet closed)</td><td className="num">{inr2(d.current_earnings)}</td></tr>}
          </tbody>
        </table>
      ))}
      <table className="tbl"><tbody>
        <tr className="total"><td>Total assets</td><td className="num">{inr2(d.total_assets)}</td></tr>
        <tr className="total"><td>Total liabilities and equity</td><td className="num">{inr2(d.total_liabilities_equity)}</td></tr>
      </tbody></table>
    </Card>
  );
}

function TrialBalance({ asOf }: { asOf: string }) {
  const q = useRpc<any>('trial_balance', { p_as_of: asOf }, [asOf]);
  if (q.error) return <ErrorBox text={q.error} />;
  if (!q.data) return <Loading />;
  return (
    <Card>
      <strong>Trial balance as of {date(asOf)}</strong>
      <table className="tbl">
        <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
        <tbody>
          {q.data.rows.map((r: any) => (
            <tr key={r.code}><td><a className="mono small" href={`#/accounts/journals?account=${r.code}`}>{r.code}</a> {r.name}</td>
              <td className="num">{Number(r.debit) ? inr2(r.debit) : ''}</td><td className="num">{Number(r.credit) ? inr2(r.credit) : ''}</td></tr>))}
          <tr className="total"><td>Total</td><td className="num">{inr2(q.data.total_debit)}</td><td className="num">{inr2(q.data.total_credit)}</td></tr>
        </tbody>
      </table>
    </Card>
  );
}

function Gst({ from, to }: { from: string; to: string }) {
  const q = useRpc<any>('gst_summary', { p_from: from, p_to: to }, [from, to]);
  if (q.error) return <ErrorBox text={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <Card>
      <strong>GST summary · {date(from)} – {date(to)}</strong>
      <table className="tbl">
        <thead><tr><th>Outward supplies by rate</th><th className="num">Taxable</th><th className="num">CGST</th><th className="num">SGST</th><th className="num">IGST</th></tr></thead>
        <tbody>{d.outward_by_rate.map((r: any) => <tr key={r.rate}><td>{Number(r.rate)}%</td><td className="num">{inr2(r.taxable)}</td>
          <td className="num">{inr2(r.cgst)}</td><td className="num">{inr2(r.sgst)}</td><td className="num">{inr2(r.igst)}</td></tr>)}</tbody>
      </table>
      <table className="tbl">
        <thead><tr><th>HSN summary</th><th className="num">Qty</th><th className="num">Taxable</th><th className="num">Tax</th></tr></thead>
        <tbody>{d.hsn_summary.map((r: any) => <tr key={r.hsn}><td className="mono">{r.hsn}</td><td className="num">{qty(r.qty)}</td><td className="num">{inr2(r.taxable)}</td><td className="num">{inr2(r.tax)}</td></tr>)}</tbody>
      </table>
      <table className="tbl">
        <thead><tr><th>Place of supply</th><th className="num">Taxable</th><th className="num">Tax</th></tr></thead>
        <tbody>{d.by_place_of_supply.map((r: any) => <tr key={r.code + r.supply_type}><td>{r.code} {r.state} <span className="muted small">({r.supply_type === 'intra' ? 'CGST+SGST' : 'IGST'})</span></td>
          <td className="num">{inr2(r.taxable)}</td><td className="num">{inr2(r.tax)}</td></tr>)}</tbody>
      </table>
      <table className="tbl"><tbody>
        <tr><td>Input credit from {d.inward.bills} supplier bill(s)</td><td className="num">CGST {inr2(d.inward.cgst)} · SGST {inr2(d.inward.sgst)} · IGST {inr2(d.inward.igst)}</td></tr>
        <tr className="total"><td>Net payable</td><td className="num">CGST {inr2(d.net_payable?.cgst)} · SGST {inr2(d.net_payable?.sgst)} · IGST {inr2(d.net_payable?.igst)}</td></tr>
      </tbody></table>
      <p className="muted small">{d.note}</p>
    </Card>
  );
}

// ---------------------------------------------------------------- Invoices
function Invoices() {
  const { go } = useApp();
  const [search, setSearch] = useState('');
  const list = useRpc<any[]>('list_invoices', { p_search: search || null }, [search]);
  return (
    <>
      <input className="search" type="search" placeholder="Search invoice, order or customer" value={search} onChange={(e) => setSearch(e.target.value)} />
      {list.error && <ErrorBox text={list.error} />}
      {list.data?.length === 0 && <Empty>No invoices yet. They are issued automatically when orders are dispatched.</Empty>}
      <div className="list">
        {list.data?.map((i) => (
          <Card key={i.id} onClick={() => go(`invoice/${i.id}`)}>
            <div className="row-between"><strong className="mono">{i.code}</strong><strong>{inr2(i.total)}</strong></div>
            <div className="row-between small"><span>{i.customer} · {i.order_code}</span><span className="muted">{date(i.invoice_date)}</span></div>
            <div className="muted small">Taxable {inr2(i.taxable_value)} · GST {inr2(i.tax)} · {i.supply_type === 'intra' ? 'CGST+SGST' : 'IGST'}
              {Number(i.credited) > 0 ? ` · credited ${inr2(i.credited)}` : ''}</div>
          </Card>
        ))}
      </div>
    </>
  );
}

export function InvoiceView({ id }: { id: string }) {
  const { can } = useApp();
  const q = useRpc<any>('get_invoice', { p_id: id }, [id]);
  const [cn, setCn] = useState(false);
  if (q.error) return <Page title="Invoice" back="accounts/invoices"><ErrorBox text={q.error} /></Page>;
  if (!q.data) return <Page title="Invoice" back="accounts/invoices"><Loading /></Page>;
  const i = q.data;
  const intra = i.supply_type === 'intra';
  return (
    <Page title={i.code} back="accounts/invoices" actions={<button type="button" className="btn btn-small no-print" onClick={() => window.print()}>Print</button>}>
      <div className="invoice">
        <div className="inv-head">
          <div>
            <h2>Tax invoice</h2>
            <strong>{i.seller.name}</strong>
            <div className="small">{i.seller.address ?? 'Registered address not set'}</div>
            <div className="small">GSTIN {i.seller.gstin ?? '—'} · State {i.seller.state} ({i.seller.state_code})</div>
          </div>
          <div className="right small">
            <div><strong className="mono">{i.code}</strong></div>
            <div>Date {date(i.invoice_date)}</div>
            <div>Order {i.order_code}</div>
            <div>Place of supply: {i.place_of_supply_name} ({i.place_of_supply})</div>
          </div>
        </div>
        <div className="small"><strong>Bill / ship to:</strong> {i.buyer.name}{i.buyer.phone ? ` · ${i.buyer.phone}` : ''}<br />{i.buyer.address}</div>
        <table className="tbl">
          <thead><tr><th>#</th><th>Description</th><th>HSN</th><th className="num">Qty</th><th className="num">Taxable</th><th className="num">Rate</th>
            {intra ? <><th className="num">CGST</th><th className="num">SGST</th></> : <th className="num">IGST</th>}<th className="num">Total</th></tr></thead>
          <tbody>
            {i.lines.map((l: any) => (
              <tr key={l.line_no}><td>{l.line_no}</td><td>{l.description}</td><td className="mono small">{l.hsn ?? ''}</td><td className="num">{qty(l.qty)}</td>
                <td className="num">{inr2(l.taxable)}</td><td className="num">{Number(l.rate)}%</td>
                {intra ? <><td className="num">{inr2(l.cgst)}</td><td className="num">{inr2(l.sgst)}</td></> : <td className="num">{inr2(l.igst)}</td>}
                <td className="num">{inr2(l.gross)}</td></tr>))}
            <tr className="total"><td colSpan={4}>Total</td><td className="num">{inr2(i.taxable_value)}</td><td />
              {intra ? <><td className="num">{inr2(i.cgst)}</td><td className="num">{inr2(i.sgst)}</td></> : <td className="num">{inr2(i.igst)}</td>}
              <td className="num">{inr2(i.total)}</td></tr>
          </tbody>
        </table>
        <div className="small muted">Prices include GST. This is a computer-generated invoice.</div>
      </div>
      {i.credit_notes.length > 0 && (
        <Card>
          <strong>Credit notes</strong>
          <ul className="plain">{i.credit_notes.map((c: any) => <li key={c.id}><span className="mono">{c.code}</span> · {date(c.date)} · {inr2(c.total)} · {c.reason}</li>)}</ul>
        </Card>
      )}
      {can('accountant', 'manager') && <button type="button" className="btn no-print" onClick={() => setCn(true)}>Issue credit note…</button>}
      {cn && <CreditNoteSheet invoice={i} onClose={() => setCn(false)} onDone={() => { setCn(false); q.reload(); }} />}
    </Page>
  );
}

function CreditNoteSheet({ invoice, onClose, onDone }: { invoice: any; onClose(): void; onDone(): void }) {
  const credited = invoice.credit_notes.reduce((t: number, c: any) => t + Number(c.total), 0);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const { run, busy } = useAction();
  return (
    <Sheet title={`Credit note on ${invoice.code}`} onClose={onClose}>
      <p className="muted small">Refunds recorded on the order create credit notes automatically. Use this for a price adjustment without a refund
        through the system. GST is reversed pro-rata across the invoice lines.</p>
      <Field label="Amount incl. GST ₹" hint={`Up to ${inr2(Number(invoice.total) - credited)}`}><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !Number(amount) || !reason.trim()} onClick={async () => {
        if (await run('issue_credit_note', { p_invoice_id: invoice.id, p_amount: Number(amount), p_reason: reason.trim() }, 'Credit note issued')) onDone();
      }}>Issue credit note</button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Journals
function Journals() {
  const { can } = useApp();
  const accountFilter = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('account');
  const [open, setOpen] = useState<string | null>(null);
  const [newJ, setNewJ] = useState(false);
  const list = useRpc<any[]>('list_journals', { p_limit: 150 });
  const stmt = useRpc<any>(accountFilter ? 'account_statement' : null, { p_account: accountFilter, p_from: fyStart(), p_to: today() }, [accountFilter]);
  const { run } = useAction();

  if (accountFilter) {
    return (
      <>
        <a className="link" href="#/accounts/journals">← All journals</a>
        {stmt.error && <ErrorBox text={stmt.error} />}
        {stmt.data && (
          <Card>
            <strong>{stmt.data.account.code} {stmt.data.account.name}</strong>
            <div className="muted small">Year to date · opening {inr2(stmt.data.opening)} · closing {inr2(stmt.data.closing)}</div>
            <table className="tbl">
              <thead><tr><th>Date</th><th>Entry</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
              <tbody>{stmt.data.lines.map((l: any, n: number) => <tr key={n}><td className="small">{date(l.date)}</td><td><span className="mono small">{l.code}</span><div className="small muted">{l.narration}</div></td>
                <td className="num">{Number(l.debit) ? inr2(l.debit) : ''}</td><td className="num">{Number(l.credit) ? inr2(l.credit) : ''}</td><td className="num">{inr2(l.running)}</td></tr>)}</tbody>
            </table>
          </Card>
        )}
      </>
    );
  }
  return (
    <>
      {can('accountant', 'manager') && <button type="button" className="btn btn-primary" onClick={() => setNewJ(true)}>New journal entry</button>}
      {list.error && <ErrorBox text={list.error} />}
      {!list.data && !list.error && <Loading />}
      <ul className="log">
        {list.data?.map((j) => (
          <li key={j.id}>
            <button type="button" className="link" onClick={() => setOpen(open === j.id ? null : j.id)}>
              <span className="mono">{j.code}</span>
            </button> · {date(j.date)} · {label(j.source_type ?? 'manual')}{j.reversed ? ' · reversed' : ''}
            <div className="small">{j.narration}</div>
            {open === j.id && (
              <>
                <table className="tbl">
                  <tbody>{j.lines.map((l: any, n: number) => <tr key={n}><td><span className="mono small">{l.code}</span> {l.account}{l.brand ? <span className="muted small"> · {l.brand}</span> : ''}</td>
                    <td className="num">{Number(l.debit) ? inr2(l.debit) : ''}</td><td className="num">{Number(l.credit) ? inr2(l.credit) : ''}</td></tr>)}</tbody>
                </table>
                <div className="small muted">{dateTime(j.created_at)}{j.by ? ` · ${j.by}` : ''}</div>
                {can('accountant', 'manager') && !j.reversed && j.source_type !== 'reversal' && (
                  <button type="button" className="btn btn-small" onClick={async () => {
                    const reason = window.prompt('Why reverse this entry?');
                    if (reason && await run('reverse_journal', { p_entry_id: j.id, p_reason: reason }, 'Reversal posted')) list.reload();
                  }}>Reverse</button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {newJ && <JournalSheet onClose={() => setNewJ(false)} onDone={() => { setNewJ(false); list.reload(); }} />}
    </>
  );
}

function JournalSheet({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const accounts = useRpc<any[]>('list_accounts');
  const [d, setD] = useState(today());
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState([{ account: '', debit: '', credit: '' }, { account: '', debit: '', credit: '' }]);
  const [key] = useState(() => newKey('jv'));
  const { run, busy } = useAction();
  const tot = useMemo(() => lines.reduce((t, l) => ({ dr: t.dr + (Number(l.debit) || 0), cr: t.cr + (Number(l.credit) || 0) }), { dr: 0, cr: 0 }), [lines]);
  const set = (i: number, k: string, v: string) => setLines(lines.map((l, n) => (n === i ? { ...l, [k]: v } : l)));
  const balanced = tot.dr > 0 && Math.abs(tot.dr - tot.cr) < 0.005;
  return (
    <Sheet title="New journal entry" onClose={onClose}>
      <p className="muted small">For opening balances, depreciation, accruals and corrections. Debits must equal credits.</p>
      <Field label="Date"><input type="date" value={d} onChange={(e) => setD(e.target.value)} /></Field>
      <Field label="Narration"><input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="e.g. Capital introduced by founder" /></Field>
      {lines.map((l, i) => (
        <div className="row-gap" key={i}>
          <select value={l.account} onChange={(e) => set(i, 'account', e.target.value)} aria-label="Account" style={{ flex: 2 }}>
            <option value="">Account…</option>
            {accounts.data?.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
          </select>
          <input inputMode="decimal" placeholder="Debit" value={l.debit} onChange={(e) => set(i, 'debit', e.target.value.replace(/[^\d.]/g, ''))} style={{ flex: 1 }} aria-label="Debit" />
          <input inputMode="decimal" placeholder="Credit" value={l.credit} onChange={(e) => set(i, 'credit', e.target.value.replace(/[^\d.]/g, ''))} style={{ flex: 1 }} aria-label="Credit" />
        </div>
      ))}
      <button type="button" className="btn btn-small" onClick={() => setLines([...lines, { account: '', debit: '', credit: '' }])}>+ Line</button>
      <div className={balanced ? 'ok' : 'bad'}>Debits {inr2(tot.dr)} · Credits {inr2(tot.cr)}{balanced ? ' · balanced' : ''}</div>
      <button type="button" className="btn btn-primary btn-big" disabled={busy || !balanced || !narration.trim() || lines.some((l) => (l.debit || l.credit) && !l.account)} onClick={async () => {
        const r = await run<any>('post_manual_journal', { p: { entry_date: d, narration: narration.trim(), idempotency_key: key,
          lines: lines.filter((l) => l.account && (Number(l.debit) || Number(l.credit))).map((l) => ({ account: l.account, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })) } });
        if (r) onDone();
      }}>Post entry</button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Setup
function Company() {
  const { can } = useApp();
  const c = useRpc<any>('get_company');
  const ex = useRpc<any[]>('list_accounting_exceptions');
  const { run, busy } = useAction();
  const [gstin, setGstin] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [addr, setAddr] = useState<string | null>(null);
  const [month, setMonth] = useState(ymd(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)).slice(0, 7));
  const [settle, setSettle] = useState({ gross: '', fees: '', gst: '', ref: '' });
  if (!c.data) return c.error ? <ErrorBox text={c.error} /> : <Loading />;
  const g = gstin ?? c.data.gstin ?? ''; const st = state ?? c.data.state_code ?? ''; const ad = addr ?? c.data.registered_address ?? '';

  return (
    <>
      <h2 className="section">Exceptions <span className="count">{ex.data?.length ?? 0}</span></h2>
      {ex.data?.length === 0 && <p className="muted">Nothing needs attention.</p>}
      <ul className="alerts">
        {ex.data?.map((e) => (
          <li key={e.id} className={`alert ${e.kind.endsWith('failed') ? 'sev-high' : ''}`}>
            <strong>{label(e.kind)}</strong><span>{e.message}</span><span>{dateTime(e.created_at)}</span>
            {can('accountant', 'manager') && <button type="button" className="btn btn-small" onClick={async () => {
              if (await run('resolve_accounting_exception', { p_id: e.id }, 'Marked as resolved')) ex.reload();
            }}>Mark resolved</button>}
          </li>
        ))}
      </ul>

      <h2 className="section">Company GST details</h2>
      <Card>
        <div className="muted small">{c.data.name}</div>
        <Field label="GSTIN" hint="15 characters; the first two digits are the state code"><input value={g} disabled={!can('admin')} autoCapitalize="characters" onChange={(e) => setGstin(e.target.value.toUpperCase())} /></Field>
        <Field label="State of registration">
          <select value={st} disabled={!can('admin')} onChange={(e) => setState(e.target.value)}>
            <option value="">— choose —</option>
            {c.data.states.map((s: any) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}
          </select>
        </Field>
        <Field label="Registered address"><textarea rows={2} value={ad} disabled={!can('admin')} onChange={(e) => setAddr(e.target.value)} /></Field>
        {can('admin') && <button type="button" className="btn btn-primary" disabled={busy || !st} onClick={async () => {
          if (await run('set_company_details', { p_gstin: g || null, p_state_code: st, p_registered_address: ad }, 'Company details saved')) c.reload();
        }}>Save</button>}
      </Card>

      {can('admin') && (
        <>
          <h2 className="section">Lock a month</h2>
          <Card>
            <p className="muted small">Once a month is filed or reviewed, lock it so nothing can be posted into it.</p>
            <div className="row-gap">
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
              <button type="button" className="btn" disabled={busy} onClick={() => run('lock_period', { p_month: `${month}-01`, p_locked: true }, 'Month locked')}>Lock</button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => run('lock_period', { p_month: `${month}-01`, p_locked: false }, 'Month unlocked')}>Unlock</button>
            </div>
          </Card>
        </>
      )}

      {can('accountant', 'manager') && (
        <>
          <h2 className="section">Payment gateway settlement</h2>
          <Card>
            <p className="muted small">When the gateway pays out to the bank, record the gross amount and its fees.</p>
            <div className="row-gap">
              <Field label="Gross ₹"><input inputMode="decimal" value={settle.gross} onChange={(e) => setSettle({ ...settle, gross: e.target.value })} /></Field>
              <Field label="Fees ₹"><input inputMode="decimal" value={settle.fees} onChange={(e) => setSettle({ ...settle, fees: e.target.value })} /></Field>
              <Field label="GST on fees ₹"><input inputMode="decimal" value={settle.gst} onChange={(e) => setSettle({ ...settle, gst: e.target.value })} /></Field>
            </div>
            <Field label="Settlement reference"><input value={settle.ref} onChange={(e) => setSettle({ ...settle, ref: e.target.value })} /></Field>
            <button type="button" className="btn btn-primary" disabled={busy || !Number(settle.gross)} onClick={async () => {
              const r = await run<any>('record_gateway_settlement', { p_gross: Number(settle.gross), p_fees: Number(settle.fees) || 0,
                p_gst_on_fees: Number(settle.gst) || 0, p_reference: settle.ref || null });
              if (r) setSettle({ gross: '', fees: '', gst: '', ref: '' });
            }}>Record settlement</button>
          </Card>
        </>
      )}
    </>
  );
}
