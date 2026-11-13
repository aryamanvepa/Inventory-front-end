import { useState } from 'react';
import { useApp } from '../lib/app';
import { Page } from '../components/ui';

export function More() {
  const { can, profile, backend, refreshProfile } = useApp();
  const items = [
    { href: 'home', label: 'Overview', sub: 'Work queue, today\'s sales and alerts', show: true },
    { href: 'pack', label: 'Pack (list view)', sub: 'The packing queue on its own', show: can('packer', 'warehouse', 'manager') },
    { href: 'dispatch', label: 'Dispatch & deliveries', sub: 'Ready to send, out for delivery, delivered / failed', show: can('packer', 'warehouse', 'manager') },
    { href: 'receive', label: 'Receive stock (detailed)', sub: 'Choose batch, manufacturer, location yourself', show: can('warehouse', 'manager') },
    { href: 'transfer', label: 'Transfer stock', sub: 'Between locations, consignment or outright', show: can('warehouse', 'manager') },
    { href: 'labels', label: 'Barcode stickers', sub: 'Product and batch stickers, barcode book', show: can('warehouse', 'manager') },
    { href: 'promos', label: 'Promo codes', sub: 'Discount codes shoppers enter at checkout', show: can('manager') },
    { href: 'alerts', label: 'Back-in-stock alerts', sub: 'Shoppers waiting for a product (“Notify me” on the website)', show: can('manager') },
    { href: 'inventory/counts', label: 'Stock counts', sub: 'Approve counts that differ from the system', show: can('manager') },
    { href: 'production', label: 'Production', sub: 'Recipes, production runs, ingredients & packaging', show: can('manager', 'warehouse', 'accountant') },
    { href: 'purchasing', label: 'Purchasing', sub: 'Purchase orders, receiving, supplier bills & payments', show: can('manager', 'warehouse', 'accountant') },
    { href: 'accounts', label: 'Accounts', sub: 'MIS, P&L, balance sheet, GST, invoices, journals', show: can('manager', 'accountant', 'viewer') },
    { href: 'orders', label: 'All orders', sub: 'Payments, cancellations, refunds', show: can('manager') },
    { href: 'dashboard', label: 'Business dashboard', sub: 'Sales, margins, alerts, stock position', show: can('manager', 'viewer') },
    { href: 'admin', label: 'Admin', sub: 'Products, partners, staff, website orders', show: can('manager') },
  ].filter((i) => i.show);
  return (
    <Page title="More">
      <ul className="menu">
        {items.map((i) => <li key={i.href}><a href={`#/${i.href}`}><strong>{i.label}</strong><span>{i.sub}</span></a></li>)}
      </ul>
      {can('manager') && <TestingTools />}
      <div className="card">
        <div><strong>{profile.full_name}</strong></div>
        <div className="muted small">Role: {profile.role}{backend.mode === 'demo' ? ' · demo mode' : ''}</div>
        <button type="button" className="btn" onClick={async () => { await backend.signOut(); await refreshProfile(); }}>
          {backend.mode === 'demo' ? 'Switch demo user' : 'Sign out'}
        </button>
      </div>
    </Page>
  );
}

// Testing tools: one switch for the whole business (admin only)
function TestingTools() {
  const { settings, reloadSettings, can, backend, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const on = settings.testing_mode === true;
  return (
    <div className={`card ${on ? 'testing-on' : ''}`}>
      <strong>Testing tools {on ? <span className="test-tag">ON</span> : <span className="muted small">(off)</span>}</strong>
      <span className="small">While testing mode is on, every scan screen has a <strong>Scan override</strong> button and every order has a
        <strong> scan bypass</strong> (scan all packs / tick all ingredients in one tap), for everyone on every device.</span>
      <span className="muted small">It lets anyone skip real scanning, so an admin must turn it off before the business goes live.</span>
      {can('admin') ? (
        <button type="button" className={`btn ${on ? '' : 'btn-primary'}`} disabled={busy} onClick={async () => {
          setBusy(true);
          try { await backend.rpc('set_app_setting', { p_key: 'testing_mode', p_value: !on }); await reloadSettings(); toast(on ? 'Testing mode off' : 'Testing mode on'); }
          catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
          finally { setBusy(false); }
        }}>{on ? 'Turn testing mode off' : 'Turn testing mode on'}</button>
      ) : <span className="muted small">Only an admin can switch it.</span>}
    </div>
  );
}
