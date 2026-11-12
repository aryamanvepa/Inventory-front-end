import { useState } from 'react';
import { useApp } from '../lib/app';
import { scanOverrideSetting, setScanOverride } from '../components/Scanner';
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
      {can('manager') && <TestingTools demo={backend.mode === 'demo'} />}
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

// Testing tools: only on this device, only for admins and managers to switch
function TestingTools({ demo }: { demo: boolean }) {
  const [on, setOn] = useState(() => scanOverrideSetting() ?? demo);
  return (
    <div className="card">
      <strong>Testing tools</strong>
      <label className="row-gap">
        <input type="checkbox" checked={on} style={{ width: 'auto', minHeight: 0 }}
          onChange={(e) => { setOn(e.target.checked); setScanOverride(e.target.checked); }} />
        <span>Show the <strong>Scan override</strong> button on scan screens</span>
      </label>
      <span className="muted small">For trying the workflows without stickers, a camera or a scanner gun. It lets anyone "scan" any item,
        so turn it off on phones used for real work. This setting is for this device only.</span>
    </div>
  );
}
