// Live database view (admins): docked beside whatever screen is open, so you
// can click through the app and watch what each click writes.
//   Live   – every change as it happens, grouped by click
//   Tables – what every table holds, and how much it changed since you opened this
//   Map    – what runs on this laptop and what runs in the cloud
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../lib/app';
import { friendlyError } from '../lib/backend';

type Item = { at: string; seq: string; kind: string; table: string; action: string; title: string; detail: any; who: string | null };
const KIND: Record<string, string> = { record: 'Record', stock: 'Stock', ledger: 'Accounts', payment: 'Payment', scan: 'Scan', invoice: 'Invoice', website: 'Website' };
const time = (s: string) => new Date(s).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const val = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function DbDock({ onClose }: { onClose(): void }) {
  const { backend } = useApp();
  const [tab, setTab] = useState<'live' | 'tables' | 'map'>('live');
  const [feed, setFeed] = useState<Item[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tables, setTables] = useState<any>(null);
  const baseline = useRef<Record<string, number> | null>(null);
  const last = useRef<string | null>(null);
  const seen = useRef(new Set<string>());

  const pollFeed = useCallback(async () => {
    try {
      const items = await backend.rpc<Item[]>('inspect_activity', { p_since: last.current, p_limit: 200 });
      const nu = items.filter((i) => !seen.current.has(i.kind + i.seq));
      if (nu.length) {
        nu.forEach((i) => seen.current.add(i.kind + i.seq));
        last.current = nu.reduce((m, i) => (i.at > m ? i.at : m), last.current ?? nu[0].at);
        setFeed((f) => [...nu, ...f].slice(0, 400));
        if (seen.current.size > nu.length) {           // not the first load: highlight what just arrived
          setFresh(new Set(nu.map((i) => i.kind + i.seq)));
          window.setTimeout(() => setFresh(new Set()), 2500);
        }
      }
      setErr(null);
    } catch (e) { setErr(friendlyError(e)); }
  }, [backend]);

  const pollTables = useCallback(async () => {
    try {
      const t = await backend.rpc<any>('inspect_tables');
      if (!baseline.current) baseline.current = Object.fromEntries(t.tables.map((x: any) => [x.table, Number(x.rows)]));
      setTables(t);
    } catch (e) { setErr(friendlyError(e)); }
  }, [backend]);

  useEffect(() => {
    pollFeed(); pollTables();
    if (paused) return;
    const a = window.setInterval(pollFeed, 2000);
    const b = window.setInterval(pollTables, 5000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [pollFeed, pollTables, paused]);

  // group items that happened together (one click = one burst of writes)
  const groups: Item[][] = [];
  for (const i of feed) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(new Date(g[g.length - 1].at).getTime() - new Date(i.at).getTime()) < 1500) g.push(i); else groups.push([i]);
  }
  const changed = tables && baseline.current ? tables.tables.filter((x: any) => Number(x.rows) !== baseline.current![x.table]) : [];

  return (
    <aside className="dbdock" aria-label="Live database view">
      <div className="dbdock-head">
        <strong>Live database</strong>
        <span className={`dot ${paused ? '' : 'on'}`} aria-hidden="true" />
        <span className="muted small">{backend.mode === 'demo' ? 'demo · in this browser' : 'Supabase · live'}</span>
        <span className="grow" />
        <button type="button" className="btn btn-small" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close live database view">✕</button>
      </div>
      <div className="dbdock-tabs" role="tablist">
        {(['live', 'tables', 'map'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {k === 'live' ? `Live (${feed.length})` : k === 'tables' ? `Tables${changed.length ? ` · ${changed.length} changed` : ''}` : 'Map'}
          </button>
        ))}
      </div>
      {err && <div className="dbdock-err small">{err}</div>}

      <div className="dbdock-body">
        {tab === 'live' && (
          <>
            <p className="muted small">Click anything in the app — each burst below is what one action wrote. Tap a line for details. Showing the last 15 minutes and everything from now on.</p>
            {feed.length === 0 && <p className="muted small">Nothing yet. Try a stock-in or pack a test order.</p>}
            {groups.map((g) => (
              <div key={g[0].kind + g[0].seq} className="dbgroup">
                <div className="dbgroup-head small"><span className="mono">{time(g[g.length - 1].at)}</span>{g[0].who ? ` · ${g[0].who}` : ''} · {g.length} write{g.length === 1 ? '' : 's'}</div>
                {g.slice().reverse().map((i) => {
                  const id = i.kind + i.seq;
                  return (
                    <div key={id} className={`dbitem k-${i.kind} ${fresh.has(id) ? 'fresh' : ''}`}>
                      <button type="button" className="dbitem-line" onClick={() => setOpen(open === id ? null : id)} aria-expanded={open === id}>
                        <span className={`dbkind dbk-${i.kind}`}>{KIND[i.kind] ?? i.kind}</span>
                        <span className="grow"><span className="dbtitle">{i.title}</span>
                          <span className="dbtable mono">{i.action === 'INSERT' ? '+ ' : i.action === 'UPDATE' ? '~ ' : i.action === 'DELETE' ? '− ' : ''}{i.table}</span></span>
                      </button>
                      {open === id && <Detail i={i} />}
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}

        {tab === 'tables' && tables && (
          <>
            <div className="dbstats small">
              <span><strong>{tables.tables.length}</strong> tables</span>
              <span><strong>{tables.tables.reduce((a: number, x: any) => a + Number(x.rows), 0).toLocaleString('en-IN')}</strong> rows</span>
              <span><strong>{tables.auth_users}</strong> logins</span>
              <span>{tables.database_size}</span>
            </div>
            {['Orders & customers', 'Stock', 'Catalogue', 'Purchasing & production', 'Accounts & GST', 'System'].map((area) => (
              <div key={area} className="dbarea">
                <div className="dbarea-head small">{area}</div>
                {tables.tables.filter((x: any) => x.area === area).map((x: any) => {
                  const d = Number(x.rows) - (baseline.current?.[x.table] ?? Number(x.rows));
                  return (
                    <div key={x.table} className={`dbrow ${d ? 'changed' : ''}`}>
                      <span className="mono">{x.table}</span>
                      <span className="grow" />
                      {d !== 0 && <span className="dbdelta">{d > 0 ? '+' : ''}{d}</span>}
                      <span className="mono">{Number(x.rows).toLocaleString('en-IN')}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}

        {tab === 'map' && <ArchitectureMap mode={backend.mode} tables={tables} />}
      </div>
    </aside>
  );
}

function Detail({ i }: { i: Item }) {
  const d = i.detail ?? {};
  if (i.kind === 'stock' && Array.isArray(d.lines)) {
    return (
      <table className="dbtbl small"><thead><tr><th>Item</th><th>Batch</th><th>Where / status</th><th className="num">Qty</th></tr></thead>
        <tbody>{d.lines.map((l: any, n: number) => (
          <tr key={n}><td>{l.sku}<div className="muted">{l.item}</div></td><td className="mono">{l.batch ?? '—'}</td><td>{l.location}<div className="muted">{l.status}</div></td>
            <td className={`num ${Number(l.qty) < 0 ? 'bad' : 'ok'}`}>{Number(l.qty) > 0 ? '+' : ''}{l.qty}</td></tr>))}</tbody></table>
    );
  }
  if (i.kind === 'ledger' && Array.isArray(d.lines)) {
    return (
      <table className="dbtbl small"><thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
        <tbody>{d.lines.map((l: any, n: number) => <tr key={n}><td>{l.account}</td><td className="num">{l.debit ?? ''}</td><td className="num">{l.credit ?? ''}</td></tr>)}</tbody></table>
    );
  }
  if (i.kind === 'record' && i.action === 'UPDATE') {
    const keys = Object.keys(d);
    return keys.length === 0 ? <p className="muted small">No field changed.</p> : (
      <table className="dbtbl small"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
        <tbody>{keys.map((k) => <tr key={k}><td className="mono">{k}</td><td className="muted">{val(d[k].from).slice(0, 60)}</td><td>{val(d[k].to).slice(0, 60)}</td></tr>)}</tbody></table>
    );
  }
  const entries = Object.entries(d).filter(([, v]) => v !== null && v !== undefined).slice(0, 18);
  return (
    <table className="dbtbl small"><tbody>{entries.map(([k, v]) => <tr key={k}><td className="mono">{k}</td><td>{val(v).slice(0, 80)}</td></tr>)}</tbody></table>
  );
}

function ArchitectureMap({ mode, tables }: { mode: 'demo' | 'supabase'; tables: any }) {
  const local = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const n = tables?.tables.length ?? '…';
  return (
    <div className="dbmap small">
      <div className="dbbox laptop">
        <div className="dbbox-title">💻 Your laptop</div>
        <div className="dbnode on">Browser — this app{local ? ' (served by the Vite dev server on localhost)' : ' (loaded from GitHub Pages)'}</div>
        {mode === 'demo'
          ? <div className="dbnode on">Demo database — PostgreSQL compiled to WebAssembly (PGlite), running inside this browser tab and saved in the browser's storage. Same {n} tables and rules as live; nothing leaves the laptop.</div>
          : <div className="dbnode">No database runs locally in live mode — every read and write goes to Supabase over HTTPS, signed in as you.</div>}
        <div className="dbnode">Tests — <span className="mono">npm test</span> runs every migration in PGlite inside Node (85+ checks). Optional: <span className="mono">supabase start</span> (needs Docker) would run a full local copy; not set up.</div>
      </div>
      <div className="dbarrow">⇅ HTTPS · publishable key + your login</div>
      <div className="dbbox cloud">
        <div className="dbbox-title">☁️ Supabase (cloud)</div>
        <div className={`dbnode ${mode === 'supabase' ? 'on' : ''}`}>PostgreSQL database — {n} tables{tables ? `, ${tables.database_size}` : ''}. Every table has row-level security; staff work only through checked database functions.</div>
        <div className="dbnode">Auth — {tables?.auth_users ?? '…'} logins (email + password, first user = admin)</div>
        <div className="dbnode">Edge Function <span className="mono">storefront-order</span> — the shop's checkout (live)</div>
        <div className="dbnode off">Edge Function <span className="mono">order-webhook</span> — for an external website (e.g. WooCommerce); not deployed, not needed by our own shop</div>
      </div>
      <div className="dbarrow">⇅ the shop uses the same database through 4 public functions only</div>
      <div className="dbbox web">
        <div className="dbbox-title">🌐 GitHub Pages</div>
        <div className="dbnode">Ops app — aryamanvepa.github.io/Inventory-front-end</div>
        <div className="dbnode">Shop — aryamanvepa.github.io/frontend_mia_torte (catalogue, checkout, order tracking, notify me)</div>
      </div>
    </div>
  );
}
