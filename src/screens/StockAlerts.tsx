// Back-in-stock alerts: shoppers who asked the website to tell them when a
// product is available. Managers email them (from their own mail app — no
// email service is connected yet), then mark them notified.
import { useState } from 'react';
import { useAction, useApp, useRpc } from '../lib/app';
import { Badge, dateTime, Empty, ErrorBox, Field, Loading, Page, qty } from '../components/ui';

export function StockAlerts() {
  const { toast } = useApp();
  const list = useRpc<any[]>('list_stock_alerts');
  const { run, busy } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [erase, setErase] = useState('');

  const mailto = (a: any) => {
    const subject = encodeURIComponent(`${a.name} is back in stock`);
    const body = encodeURIComponent(`Hello,\n\nGood news: ${a.name} is available again on our website.\n\nYou asked us to let you know. Order while stock lasts.\n\n— Torte Living\n\n(You're getting this one-time email because you asked to be notified. Reply "remove" and we'll delete your email.)`);
    return `mailto:?bcc=${encodeURIComponent(a.people.map((p: any) => p.email).join(','))}&subject=${subject}&body=${body}`;
  };

  return (
    <Page title="Back-in-stock alerts" back="more">
      <p className="muted small">Shoppers who pressed “Notify me” on the website. When a product is back, email them (BCC, so they don't see
        each other), then mark them notified. Their email is used only for this.</p>
      {list.error && <ErrorBox text={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Loading />}
      {list.data?.length === 0 && <Empty>No one is waiting.</Empty>}
      <div className="list">
        {list.data?.map((a) => (
          <div key={a.sku_id} className={`order-card ${a.in_stock ? 'k-ready' : 'k-unpaid'}`}>
            <div className="row-between"><strong>{a.name}</strong><span className="mono small">{a.code}</span></div>
            <div className="row-gap small">
              <span><strong>{a.waiting}</strong> waiting · since {dateTime(a.oldest)}</span>
              {a.in_stock ? <Badge status="available">In stock · {qty(a.free)}</Badge> : <Badge status="cancelled">Not in stock yet</Badge>}
            </div>
            <div className="row-gap wrap">
              <a className={`btn ${a.in_stock ? 'btn-primary' : ''}`} href={mailto(a)}>Email them</a>
              <button type="button" className="btn" onClick={async () => {
                try { await navigator.clipboard.writeText(a.people.map((p: any) => p.email).join(', ')); toast('Emails copied'); }
                catch { setOpen(a.sku_id); }
              }}>Copy emails</button>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(open === a.sku_id ? null : a.sku_id)}>{open === a.sku_id ? 'Hide' : 'Show'} list</button>
            </div>
            {open === a.sku_id && (
              <ul className="plain small">
                {a.people.map((p: any) => <li key={p.id}><span className="mono">{p.email}</span>{p.name ? ` · ${p.name}` : ''} · {dateTime(p.since)}</li>)}
              </ul>
            )}
            <button type="button" className="btn btn-small" disabled={busy} onClick={async () => {
              if (!window.confirm(`Mark all ${a.waiting} people waiting for ${a.name} as notified? Do this after emailing them.`)) return;
              if (await run('mark_stock_alerts_notified', { p_sku_id: a.sku_id }, 'Marked as notified')) list.reload();
            }}>Mark as notified</button>
          </div>
        ))}
      </div>

      <h2 className="section">Remove someone</h2>
      <p className="muted small">If someone asks to be removed (or to have their data deleted), erase their email from every alert.</p>
      <div className="row-gap">
        <Field label="Email"><input type="email" value={erase} onChange={(e) => setErase(e.target.value)} placeholder="name@example.com" /></Field>
        <button type="button" className="btn" disabled={busy || !erase.includes('@')} onClick={async () => {
          const r = await run<any>('erase_stock_alert_email', { p_email: erase });
          if (r) { toast(r.erased ? `Erased ${r.erased} request(s)` : 'That email was not on any list'); setErase(''); list.reload(); }
        }}>Erase</button>
      </div>
    </Page>
  );
}
