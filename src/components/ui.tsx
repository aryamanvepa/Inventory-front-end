import type { ReactNode } from 'react';

// Local calendar date as YYYY-MM-DD (never via UTC — India is UTC+5:30)
export const ymd = (d: Date = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const inr = (v: unknown, digits = 0) =>
  '₹' + Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const qty = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isInteger(n) ? n.toLocaleString('en-IN') : n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
};

export function ago(ts?: string | null): string {
  if (!ts) return '';
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export const date = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export const dateTime = (d?: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';

const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Awaiting payment', confirmed: 'To pack', packing: 'Packing', packed: 'Packed',
  dispatched: 'Out for delivery', delivered: 'Delivered', delivery_failed: 'Delivery failed', cancelled: 'Cancelled',
  unpaid: 'Unpaid', paid: 'Paid', partially_refunded: 'Part refunded', refunded: 'Refunded', cod_pending: 'Cash on delivery',
  released: 'Released', quarantined: 'Quarantined', pending: 'QA pending', rejected: 'Rejected',
  processed: 'Imported', duplicate: 'Duplicate', failed: 'Failed', received: 'Received',
  available: 'Available', quarantine: 'Quarantine', damaged: 'Damaged', expired: 'Expired', returned: 'Returned', in_transit: 'In transit',
  own_location: 'Own stock', consignment: 'Consignment (ours)', partner_owned: 'Sold to partner',
  at_contract_manufacturer: 'At contract manufacturer',
};
const STATUS_TONE: Record<string, string> = {
  pending_payment: 'warn', confirmed: 'info', packing: 'info', packed: 'accent', dispatched: 'accent', delivered: 'ok',
  delivery_failed: 'bad', cancelled: 'muted', paid: 'ok', unpaid: 'warn', cod_pending: 'warn', refunded: 'muted',
  partially_refunded: 'warn', released: 'ok', quarantined: 'bad', rejected: 'bad', pending: 'warn', processed: 'ok',
  duplicate: 'muted', failed: 'bad', expired: 'bad', damaged: 'bad', quarantine: 'warn', consignment: 'accent',
  partner_owned: 'muted', available: 'ok',
};
export const label = (s?: string | null) => (s ? STATUS_LABEL[s] ?? s.replace(/_/g, ' ') : '');

export function Badge({ status, children }: { status?: string; children?: ReactNode }) {
  return <span className={`badge tone-${STATUS_TONE[status ?? ''] ?? 'muted'}`}>{children ?? label(status)}</span>;
}

export function Card({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return onClick
    ? <button type="button" className={`card card-button ${className}`} onClick={onClick}>{children}</button>
    : <div className={`card ${className}`}>{children}</div>;
}

// `narrow` keeps single-task screens (scan, count, make…) at a comfortable reading width on big screens
export function Page({ title, back, actions, children, narrow = false }: { title: string; back?: string; actions?: ReactNode; children: ReactNode; narrow?: boolean }) {
  return (
    <main className={`page ${narrow ? 'page-narrow' : ''}`}>
      <header className="page-head">
        {back !== undefined && (
          <a className="back" href={`#/${back}`} aria-label="Back">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </a>
        )}
        <h1>{title}</h1>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
      {children}
    </main>
  );
}

export function Field({ label: l, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{l}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return <div className="loading"><span className="spinner" aria-hidden="true" />{text}</div>;
}

export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="errorbox" role="alert">
      <span>{text}</span>
      {onRetry && <button type="button" className="btn btn-small" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: NoInfer<T>; label: string }[]; onChange: (v: NoInfer<T>) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button type="button" key={o.value} role="radio" aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Stat({ label: l, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className={`stat ${tone ? 'tone-' + tone : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{l}</div>
    </div>
  );
}
