import { useApp } from '../lib/app';
import { Page } from '../components/ui';

export function More() {
  const { can, profile, backend, refreshProfile } = useApp();
  const items = [
    { href: 'inventory', label: 'Stock (simple)', sub: 'Stock in, stock out, count, find — big buttons, English / हिंदी', show: true },
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
