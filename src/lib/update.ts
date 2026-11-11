// Notices when a newer version of the app has been deployed, so staff never
// keep working in an old copy (e.g. a tab left open on the warehouse phone).
import { useEffect, useState } from 'react';

const BUNDLE = /assets\/index-[\w-]+\.js/;
const current = () =>
  [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((s) => s.src.match(BUNDLE)?.[0]).find(Boolean);

async function latest(): Promise<string | undefined> {
  const res = await fetch(`${import.meta.env.BASE_URL}index.html`, { cache: 'no-store' });
  return (await res.text()).match(BUNDLE)?.[0];
}

// Pages with nothing typed in, where reloading loses nothing
const SAFE = new Set(['', 'home', 'inventory', 'more', 'stock', 'pack', 'dispatch', 'orders', 'dashboard', 'accounts']);
const safeToReload = () => {
  const parts = window.location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  return parts.length === 1 && SAFE.has(parts[0]);
};

export function useUpdateAvailable(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const mine = current();
    if (!mine) return;
    let stopped = false;
    let lastCheck = 0;
    let known = false;                                  // a newer version is already known to exist
    const reloadIfSafe = () => {
      if (document.visibilityState === 'visible' && safeToReload()) { window.location.reload(); return true; }
      return false;
    };
    const check = async () => {
      if (known) { reloadIfSafe(); return; }
      if (Date.now() - lastCheck < 60_000) return;      // ask the server at most once a minute
      lastCheck = Date.now();
      try {
        const next = await latest();
        if (stopped || !next || next === mine) return;
        known = true;
        if (!reloadIfSafe()) setReady(true);
      } catch { /* offline: try later */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('hashchange', check);
    const timer = window.setInterval(check, 10 * 60 * 1000);
    check();
    return () => { stopped = true; document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('hashchange', check); clearInterval(timer); };
  }, []);
  return ready;
}
