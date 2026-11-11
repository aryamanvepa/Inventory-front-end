import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { friendlyError, type Backend, type Profile, type Role } from './backend';

type ToastKind = 'ok' | 'error' | 'info';
interface Toast { id: number; text: string; kind: ToastKind }

interface AppCtx {
  backend: Backend;
  profile: Profile;
  refreshProfile(): Promise<void>;
  route: string[];
  go(path: string): void;
  toast(text: string, kind?: ToastKind): void;
  can(...roles: Role[]): boolean;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside provider');
  return c;
}

function parseHash(): string[] {
  const h = window.location.hash.replace(/^#\/?/, '');
  return h ? h.split('/').map(decodeURIComponent) : ['home'];
}

export function AppProvider(props: {
  backend: Backend; profile: Profile; refreshProfile(): Promise<void>; children: ReactNode;
}) {
  const [route, setRoute] = useState<string[]>(parseHash);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const on = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const toast = useCallback((text: string, kind: ToastKind = 'ok') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);

  const role = props.profile.role;
  const value: AppCtx = {
    backend: props.backend,
    profile: props.profile,
    refreshProfile: props.refreshProfile,
    route,
    go: (path) => { window.location.hash = '#/' + path.replace(/^\//, ''); },
    toast,
    can: (...roles) => role === 'admin' || (!!role && roles.includes(role)),
  };

  return (
    <Ctx.Provider value={value}>
      {props.children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>)}
      </div>
    </Ctx.Provider>
  );
}

// Load data from a database function, with reload.
export function useRpc<T = any>(fn: string | null, args: Record<string, unknown> = {}, deps: unknown[] = []) {
  const { backend } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!fn);
  const argsKey = JSON.stringify(args);

  const load = useCallback(async () => {
    if (!fn) return;
    setLoading(true);
    try {
      setData(await backend.rpc<T>(fn, JSON.parse(argsKey)));
      setError(null);
    } catch (e) {
      setData(null);
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, fn, argsKey, ...deps]);

  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

// Run a mutating database function with toast feedback.
export function useAction() {
  const { backend, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T = any>(fn: string, args: Record<string, unknown>, okText?: string): Promise<T | null> => {
    setBusy(true);
    try {
      const r = await backend.rpc<T>(fn, args);
      if (okText) toast(okText, 'ok');
      return r;
    } catch (e) {
      toast(friendlyError(e), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }, [backend, toast]);
  return { run, busy };
}
