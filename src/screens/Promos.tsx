// Promo codes for the website (managers): create, change, stop and restart.
// The website checks a code at checkout; the discount is on the goods
// (delivery is charged as usual) and appears on the GST invoice.
import { useState } from 'react';
import { useAction, useRpc } from '../lib/app';
import { Badge, dateTime, Empty, ErrorBox, Field, inr, Loading, Page, Segmented, Sheet } from '../components/ui';

type Promo = { code: string; kind: 'percent' | 'flat'; value: number; min_subtotal: number; max_discount: number | null;
  starts_at: string | null; ends_at: string | null; usage_limit: number | null; used_count: number; active: boolean;
  description: string | null; live: boolean };

const blank = { code: '', kind: 'percent' as 'percent' | 'flat', value: '', min_subtotal: '', max_discount: '', starts_at: '', ends_at: '', usage_limit: '', description: '' };
const local = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

export function Promos() {
  const list = useRpc<Promo[]>('list_promo_codes');
  const { run, busy } = useAction();
  const [form, setForm] = useState<typeof blank | null>(null);
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form!, [k]: e.target.value });

  const save = async () => {
    const f = form!;
    const r = await run('save_promo_code', { p: {
      code: f.code, kind: f.kind, value: f.value, min_subtotal: f.min_subtotal || 0, max_discount: f.max_discount || null,
      starts_at: f.starts_at ? new Date(f.starts_at).toISOString() : null, ends_at: f.ends_at ? new Date(f.ends_at).toISOString() : null,
      usage_limit: f.usage_limit || null, description: f.description, active: true,
    } }, 'Promo code saved');
    if (r) { setForm(null); list.reload(); }
  };

  return (
    <Page title="Promo codes" back="more" actions={<button type="button" className="btn btn-primary btn-small" onClick={() => setForm({ ...blank })}>+ New code</button>}>
      <p className="muted small">Shoppers type these at checkout. The discount comes off the goods (not delivery) and shows on the GST invoice.</p>
      {list.error && <ErrorBox text={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Loading />}
      {list.data?.length === 0 && <Empty>No promo codes yet.</Empty>}
      <div className="list">
        {list.data?.map((c) => (
          <div key={c.code} className={`order-card ${c.live ? 'k-ready' : 'k-unpaid'}`}>
            <div className="row-between"><strong className="mono">{c.code}</strong>{c.live ? <Badge status="available">Live</Badge> : <Badge status="cancelled">{c.active ? 'Not live' : 'Stopped'}</Badge>}</div>
            <div><strong>{c.kind === 'percent' ? `${Number(c.value)}% off` : `${inr(c.value)} off`}</strong>
              {c.max_discount ? ` · up to ${inr(c.max_discount)}` : ''}{Number(c.min_subtotal) > 0 ? ` · orders over ${inr(c.min_subtotal)}` : ''}</div>
            {c.description && <div className="muted small">{c.description}</div>}
            <div className="muted small">Used {c.used_count}{c.usage_limit ? ` of ${c.usage_limit}` : ''} times
              {c.starts_at ? ` · from ${dateTime(c.starts_at)}` : ''}{c.ends_at ? ` · until ${dateTime(c.ends_at)}` : ''}</div>
            <div className="row-gap">
              <button type="button" className="btn btn-small" disabled={busy} onClick={async () => {
                if (await run('set_promo_active', { p_code: c.code, p_active: !c.active }, c.active ? 'Code stopped' : 'Code restarted')) list.reload();
              }}>{c.active ? 'Stop' : 'Restart'}</button>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setForm({ code: c.code, kind: c.kind, value: String(c.value),
                min_subtotal: String(c.min_subtotal ?? ''), max_discount: c.max_discount ? String(c.max_discount) : '', starts_at: local(c.starts_at),
                ends_at: local(c.ends_at), usage_limit: c.usage_limit ? String(c.usage_limit) : '', description: c.description ?? '' })}>Edit</button>
            </div>
          </div>
        ))}
      </div>

      {form && (
        <Sheet title={form.code && list.data?.some((c) => c.code === form.code.toUpperCase()) ? `Edit ${form.code}` : 'New promo code'} onClose={() => setForm(null)}>
          <Field label="Code" hint="Letters and numbers, e.g. WELCOME10"><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} maxLength={20} /></Field>
          <Segmented value={form.kind} onChange={(kind) => setForm({ ...form, kind })} options={[{ value: 'percent', label: '% off' }, { value: 'flat', label: '₹ off' }]} />
          <div className="row-gap">
            <Field label={form.kind === 'percent' ? 'Percent off' : 'Rupees off'}><input inputMode="decimal" value={form.value} onChange={set('value')} /></Field>
            {form.kind === 'percent' && <Field label="Most it can take off ₹" hint="Optional"><input inputMode="decimal" value={form.max_discount} onChange={set('max_discount')} /></Field>}
          </div>
          <div className="row-gap">
            <Field label="Minimum order ₹" hint="Optional"><input inputMode="decimal" value={form.min_subtotal} onChange={set('min_subtotal')} /></Field>
            <Field label="Times it can be used" hint="Optional, in total"><input inputMode="numeric" value={form.usage_limit} onChange={set('usage_limit')} /></Field>
          </div>
          <div className="row-gap">
            <Field label="Starts" hint="Optional"><input type="datetime-local" value={form.starts_at} onChange={set('starts_at')} /></Field>
            <Field label="Ends" hint="Optional"><input type="datetime-local" value={form.ends_at} onChange={set('ends_at')} /></Field>
          </div>
          <Field label="Note shown to shoppers" hint="Optional, e.g. Diwali offer"><input value={form.description} onChange={set('description')} maxLength={60} /></Field>
          <button type="button" className="btn btn-primary btn-big" disabled={busy || form.code.length < 3 || !(Number(form.value) > 0)} onClick={save}>Save</button>
        </Sheet>
      )}
    </Page>
  );
}
