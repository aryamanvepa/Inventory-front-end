import { useState } from 'react';
import { friendlyError, type Backend, type Profile } from '../lib/backend';
import { Brand } from '../App';
import { ErrorBox, Field } from '../components/ui';

export function Login({ backend, onSignedIn }: { backend: Backend; onSignedIn(): void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (backend.mode === 'demo') {
    return (
      <div className="login">
        <Brand />
        <h1>Try the pilot</h1>
        <p className="muted">
          This is demo mode: a complete copy of the system runs inside this browser with sample products and ten test
          orders. Pick who you want to be.
        </p>
        <div className="stack">
          {backend.demoUsers!.map((u) => (
            <button key={u.id} type="button" className="btn btn-big"
              onClick={async () => { await backend.signInDemo!(u.id); onSignedIn(); }}>
              {u.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={async () => {
          setBusy(true); await backend.resetDemo!(); setBusy(false); setMsg('Demo data reset to the original sample.');
        }}>{busy ? 'Resetting…' : 'Reset demo data'}</button>
        {msg && <p className="muted">{msg}</p>}
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null); setMsg(null);
    try {
      if (mode === 'in') { await backend.signIn(email.trim(), password); onSignedIn(); }
      else {
        const m = await backend.signUp(email.trim(), password);
        if (await backend.currentUser()) onSignedIn();   // no email confirmation required
        else { setMsg(m); setMode('in'); }
      }
    } catch (e2) { setErr(friendlyError(e2)); }
    finally { setBusy(false); }
  };

  return (
    <form className="login" onSubmit={submit}>
      <Brand />
      <h1>{mode === 'in' ? 'Sign in' : 'Create your login'}</h1>
      <Field label="Email"><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Password"><input type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required minLength={8}
        value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      {err && <ErrorBox text={err} />}
      {msg && <p className="notice">{msg}</p>}
      <button type="submit" className="btn btn-primary btn-big" disabled={busy}>{busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : 'Create login'}</button>
      <button type="button" className="btn btn-ghost" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(null); }}>
        {mode === 'in' ? 'New staff member? Create a login' : 'Already have a login? Sign in'}
      </button>
    </form>
  );
}

export function NoAccess({ backend, profile, onChange }: { backend: Backend; profile: Profile | null; onChange(): void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const firstAdmin = profile && profile.admin_exists === false;
  return (
    <div className="login">
      <Brand />
      {firstAdmin ? (
        <>
          <h1>Set up the system</h1>
          <p className="muted">No administrator exists yet. As the first person to sign in, you can become the administrator.</p>
          <Field label="Your name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {err && <ErrorBox text={err} />}
          <button type="button" className="btn btn-primary btn-big" disabled={!name.trim()} onClick={async () => {
            try { await backend.rpc('claim_first_admin', { p_full_name: name.trim() }); onChange(); }
            catch (e) { setErr(friendlyError(e)); }
          }}>Become administrator</button>
        </>
      ) : (
        <>
          <h1>Waiting for access</h1>
          <p className="muted">You're signed in, but an administrator hasn't given you a role yet. Ask them to add you under More → Admin → Staff.</p>
          <button type="button" className="btn" onClick={onChange}>Check again</button>
        </>
      )}
      <button type="button" className="btn btn-ghost" onClick={async () => { await backend.signOut(); onChange(); }}>Sign out</button>
    </div>
  );
}
