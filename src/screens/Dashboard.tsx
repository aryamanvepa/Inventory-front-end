import { useState } from 'react';
import { useApp, useRpc } from '../lib/app';
import { MisView } from './Accounts';
import { ErrorBox, inr, label, Loading, Page, qty, Segmented, Stat, ymd } from '../components/ui';

export function Dashboard() {
  const [days, setDays] = useState('30');
  const d = useRpc<any>('get_dashboard', { p_days: Number(days) }, [days]);
  const data = d.data;
  const { can } = useApp();
  const showFinance = can('manager', 'viewer', 'accountant');

  return (
    <Page title="Business dashboard" back="more">
      <Segmented value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
      {d.error && <ErrorBox text={d.error} onRetry={d.reload} />}
      {!data && <Loading />}
      {data && (
        <>
          <div className="stats">
            <Stat label="Sales today" value={inr(data.kpis.sales_today)} />
            <Stat label="Orders today" value={data.kpis.orders_today} />
            <Stat label="Outstanding payments" value={inr(data.kpis.outstanding_payments)} tone={data.kpis.outstanding_payments > 0 ? 'warn' : undefined} />
            <Stat label="Low-stock products" value={data.kpis.low_stock_count} tone={data.kpis.low_stock_count > 0 ? 'bad' : undefined} />
          </div>

          <h2 className="section">Needs attention <span className="count">{data.alerts.length}</span></h2>
          {data.alerts.length === 0 ? <p className="muted">Nothing needs you right now.</p> : (
            <ul className="alerts">
              {data.alerts.map((a: any, i: number) => (
                <li key={i} className={`alert sev-${a.severity}`}>
                  <span className="sev-label">{a.severity === 'high' ? '● Urgent' : '▲ Check'}</span>
                  <strong>{a.title}</strong><span>{a.detail}</span>
                </li>
              ))}
            </ul>
          )}

          <h2 className="section">Sales, last {days} days · {inr(data.kpis.sales_period)} from {data.kpis.orders_period} orders</h2>
          <DailyBars rows={data.daily_sales} />

          <h2 className="section">Revenue and gross margin by brand</h2>
          <HBars rows={data.sales_by_brand.map((b: any) => ({ name: b.brand, value: Number(b.revenue),
            note: b.gross_margin_pct != null ? `${b.gross_margin_pct}% gross margin` : 'margin: add batch costs' }))} />

          <h2 className="section">By channel</h2>
          <HBars rows={data.sales_by_channel.map((c: any) => ({ name: c.channel, value: Number(c.revenue), note: `${c.orders} orders` }))} />

          <h2 className="section">Top products</h2>
          <table className="tbl">
            <thead><tr><th>Product</th><th className="num">Units</th><th className="num">Revenue</th></tr></thead>
            <tbody>{data.top_products.map((p: any) => <tr key={p.sku}><td>{p.sku}<div className="muted small">{p.brand}</div></td><td className="num">{qty(p.units)}</td><td className="num">{inr(p.revenue)}</td></tr>)}</tbody>
          </table>

          <div className="stats">
            <Stat label="Repeat-purchase rate" value={data.repeat_purchase_rate != null ? `${data.repeat_purchase_rate}%` : '—'} />
          </div>

          <h2 className="section">Where our stock is</h2>
          <table className="tbl">
            <thead><tr><th>Holding</th><th className="num">Units</th></tr></thead>
            <tbody>{data.stock_chain.map((c: any) => <tr key={c.holding}><td>{label(c.holding)}</td><td className="num">{qty(c.units)}</td></tr>)}</tbody>
          </table>
          <p className="muted small">“Sold to partner” stock belongs to distributors; it is shown for visibility but is not our inventory. Consignment stock is at a partner but still ours.</p>

          <h2 className="section">Inventory ageing (our available stock)</h2>
          <HBars rows={data.inventory_ageing.map((a: any) => ({ name: a.bucket, value: Number(a.units) }))} format={(v) => `${qty(v)} units`} />
          {showFinance && (
            <>
              <h2 className="section" style={{ marginTop: 24 }}>Finance (from the books) · <a className="link" href="#/accounts">open Accounts</a></h2>
              <MisView from={ymd(new Date(Date.now() - (Number(days) - 1) * 86400000))} to={ymd()} />
            </>
          )}
        </>
      )}
    </Page>
  );
}

function DailyBars({ rows }: { rows: { day: string; revenue: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...rows.map((r) => Number(r.revenue)));
  const h = hover != null ? rows[hover] : null;
  return (
    <div className="chart">
      <div className="chart-readout" aria-live="polite">
        {h ? <><strong>{inr(h.revenue)}</strong> on {new Date(h.day).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</>
          : <span className="muted small">Hover or tap a bar for the day's sales</span>}
      </div>
      <div className="daily" role="img" aria-label="Daily sales bar chart">
        {rows.map((r, i) => (
          <button type="button" key={r.day} className={`daily-col ${hover === i ? 'on' : ''}`}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => setHover(i)} onMouseLeave={() => setHover(null)}
            aria-label={`${r.day}: ${inr(r.revenue)}`}>
            <span className="daily-bar" style={{ height: `${(100 * Number(r.revenue)) / max}%` }} />
          </button>
        ))}
      </div>
      <div className="daily-axis muted small"><span>{rows[0] && new Date(rows[0].day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span><span>Today</span></div>
    </div>
  );
}

function HBars({ rows, format = (v: number) => inr(v) }: { rows: { name: string; value: number; note?: string }[]; format?: (v: number) => string }) {
  if (!rows.length) return <p className="muted">No data for this period.</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="hbars">
      {rows.map((r) => (
        <li key={r.name} title={`${r.name}: ${format(r.value)}`}>
          <div className="row-between small"><span>{r.name}</span><span><strong>{format(r.value)}</strong>{r.note ? <span className="muted"> · {r.note}</span> : null}</span></div>
          <div className="hbar"><span style={{ width: `${(100 * r.value) / max}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}
