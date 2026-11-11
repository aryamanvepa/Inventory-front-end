import { useApp, useRpc } from '../lib/app';
import { Card, ErrorBox, inr, Loading, Page, Stat, ago } from '../components/ui';

export function Home() {
  const { profile, can, go } = useApp();
  const q = useRpc<any>('get_work_queue');
  const showMis = can('manager', 'viewer');
  const dash = useRpc<any>(showMis ? 'get_dashboard' : null, { p_days: 30 });
  const first = (profile.full_name ?? '').split(/[ (]/)[0];

  return (
    <Page title={`Hello${first ? ', ' + first : ''}`}>
      {q.error && <ErrorBox text={q.error} onRetry={q.reload} />}
      {q.loading && !q.data && <Loading />}
      {q.data && (
        <div className="tiles">
          <Card className="tile tile-primary" onClick={() => go('pack')}>
            <div className="tile-num">{q.data.to_pack}</div>
            <div className="tile-label">Orders to pack</div>
            {q.data.oldest_to_pack && <div className="tile-sub">oldest {ago(q.data.oldest_to_pack)}</div>}
          </Card>
          <Card className="tile" onClick={() => go('dispatch')}>
            <div className="tile-num">{q.data.to_dispatch}</div>
            <div className="tile-label">Orders to dispatch</div>
          </Card>
          <Card className="tile" onClick={() => go('dispatch')}>
            <div className="tile-num">{q.data.out_for_delivery}</div>
            <div className="tile-label">Out for delivery</div>
          </Card>
          <Card className={`tile ${q.data.attention ? 'tile-alert' : ''}`} onClick={() => go(can('manager') ? 'orders' : 'pack')}>
            <div className="tile-num">{q.data.attention}</div>
            <div className="tile-label">Need attention</div>
          </Card>
        </div>
      )}

      {showMis && dash.data && (
        <>
          <h2 className="section">Today</h2>
          <div className="stats">
            <Stat label="Sales today" value={inr(dash.data.kpis.sales_today)} />
            <Stat label="Orders today" value={dash.data.kpis.orders_today} />
            <Stat label="Outstanding payments" value={inr(dash.data.kpis.outstanding_payments)} tone={dash.data.kpis.outstanding_payments > 0 ? 'warn' : undefined} />
            <Stat label="Low-stock products" value={dash.data.kpis.low_stock_count} tone={dash.data.kpis.low_stock_count > 0 ? 'bad' : undefined} />
          </div>
          {dash.data.alerts.length > 0 && (
            <>
              <h2 className="section">Needs your attention <span className="count">{dash.data.alerts.length}</span></h2>
              <ul className="alerts">
                {dash.data.alerts.slice(0, 4).map((a: any, i: number) => (
                  <li key={i} className={`alert sev-${a.severity}`}><strong>{a.title}</strong><span>{a.detail}</span></li>
                ))}
              </ul>
              {dash.data.alerts.length > 4 && <a className="link" href="#/dashboard">See all {dash.data.alerts.length} alerts →</a>}
            </>
          )}
        </>
      )}

      <h2 className="section">Quick actions</h2>
      <div className="actions-grid">
        {can('warehouse', 'manager') && <a className="action" href="#/receive">Receive stock</a>}
        <a className="action" href="#/stock">Look up stock</a>
        {can('warehouse', 'manager') && <a className="action" href="#/transfer">Transfer stock</a>}
        {can('manager', 'viewer') && <a className="action" href="#/dashboard">Business dashboard</a>}
        {can('manager') && <a className="action" href="#/orders">All orders</a>}
        {can('warehouse', 'manager') && <a className="action" href="#/labels">Print labels</a>}
        {can('warehouse', 'manager') && <a className="action" href="#/production">Production</a>}
        {can('warehouse', 'manager', 'accountant') && <a className="action" href="#/purchasing">Purchasing</a>}
        {can('manager', 'accountant', 'viewer') && <a className="action" href="#/accounts">Accounts &amp; MIS</a>}
      </div>
    </Page>
  );
}
