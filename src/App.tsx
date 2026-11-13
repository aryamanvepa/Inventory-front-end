import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { friendlyError, getBackend, type Backend, type Profile } from './lib/backend';
import { AppProvider, useApp } from './lib/app';
import { ErrorBox, Loading } from './components/ui';
import { Login, NoAccess } from './screens/Login';
import { Home } from './screens/Home';
import { PackList, PackOrder } from './screens/Pack';
import { Dispatch } from './screens/Dispatch';
import { StockList, SkuDetail } from './screens/Stock';
import { Receive } from './screens/Receive';
import { Transfer } from './screens/Transfer';
import { OrderDetail, Orders } from './screens/Orders';
import { Dashboard } from './screens/Dashboard';
import { Admin } from './screens/Admin';
import { Labels } from './screens/Labels';
import { More } from './screens/More';
import { Accounts, InvoiceView } from './screens/Accounts';
import { Purchasing } from './screens/Purchasing';
import { Production } from './screens/Production';
import { Inventory } from './screens/Inventory';
import { MakeBoard, MakeForStock, OrderBoard, ProcessOrder } from './screens/Process';
import { useUpdateAvailable } from './lib/update';
import { StockAlerts } from './screens/StockAlerts';
import { DbDock } from './components/DbDock';
import { useT } from './lib/i18n';

export function App() {
  const [backend, setBackend] = useState<Backend | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (b: Backend) => {
    const user = await b.currentUser();
    // load the role before deciding what to show, so a slow start never flashes "Waiting for access"
    const prof = user ? await b.rpc<Profile>('get_my_profile') : null;
    setProfile(prof);
    setSignedIn(!!user);
  }, []);

  useEffect(() => {
    getBackend()
      .then(async (b) => { setBackend(b); await refresh(b); })
      .catch((e) => setError(friendlyError(e)));
  }, [refresh]);

  if (error) return <div className="boot"><ErrorBox text={error} onRetry={() => window.location.reload()} /></div>;
  if (!backend || signedIn === null) {
    return <div className="boot"><Brand /><Loading text="Starting up… (first start in demo mode takes a few seconds)" /></div>;
  }
  if (!signedIn) return <Login backend={backend} onSignedIn={() => refresh(backend)} />;
  if (!profile?.role || profile.active === false) {
    return <NoAccess backend={backend} profile={profile} onChange={() => refresh(backend)} />;
  }

  return (
    <AppProvider backend={backend} profile={profile} refreshProfile={() => refresh(backend)}>
      <Shell />
    </AppProvider>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width="40" height="40" />
      <div><strong>Torte Living</strong><span>Operations</span></div>
    </div>
  );
}

function Shell() {
  const { route, backend } = useApp();
  const [a, b, c] = route;
  const updateReady = useUpdateAvailable();
  const { t } = useT();
  const { can } = useApp();
  // Live database view for admins: stays open across screens (remembered on this device)
  const [dock, setDockState] = useState(() => { try { return localStorage.getItem('tl-dbdock') === '1'; } catch { return false; } });
  const setDock = (v: boolean) => { setDockState(v); try { localStorage.setItem('tl-dbdock', v ? '1' : '0'); } catch { /* ignore */ } };
  const showDock = dock && can('admin');

  let screen: ReactNode;
  switch (a) {
    case 'pack': screen = b ? <PackOrder orderId={b} /> : <PackList />; break;
    case 'dispatch': screen = <Dispatch />; break;
    case 'stock': screen = b ? <SkuDetail skuId={b} /> : <StockList />; break;
    case 'receive': screen = <Receive />; break;
    case 'transfer': screen = <Transfer />; break;
    case 'orders': screen = b ? <OrderDetail orderId={b} /> : <Orders />; break;
    case 'dashboard': screen = <Dashboard />; break;
    case 'admin': screen = <Admin section={b} />; break;
    case 'labels': screen = <Labels key={route.join('/')} section={b} id={c} />; break;
    case 'inventory': screen = <Inventory route={route.slice(1)} />; break;
    case 'more': screen = <More />; break;
    case 'home': screen = <Home />; break;
    case 'alerts': screen = <StockAlerts />; break;
    case 'work': screen = b ? <ProcessOrder key={b} orderId={b} /> : <OrderBoard />; break;
    case 'make': screen = b ? <MakeForStock key={b} skuId={b} /> : <MakeBoard />; break;
    case 'accounts': screen = <Accounts section={b} />; break;
    case 'invoice': screen = <InvoiceView id={b} />; break;
    case 'purchasing': screen = <Purchasing section={b} />; break;
    case 'production': screen = <Production section={b} id={c} />; break;
    default: screen = <OrderBoard />;
  }

  // The three main buttons follow the floor's flow: Orders → Process (make / repack) → Inventory
  const tabs = [
    { id: 'work', label: t('orders'), icon: 'M6 4h12v16H6zM9 8h6M9 12h6M9 16h4', show: true, also: ['', 'work', 'pack', 'dispatch', 'orders'] },
    { id: 'make', label: t('tab_process'), icon: 'M7 14h10v6H7zM6.5 14A4 4 0 017 6.1a5 5 0 019.9.1A4 4 0 0117.5 14', show: true, also: ['make', 'production'] },
    { id: 'inventory', label: t('tab_inventory'), icon: 'M4 5h16v4H4zM5 9v10h14V9M10 13h4', show: true, also: ['inventory', 'stock', 'labels', 'receive', 'transfer'] },
    { id: 'more', label: t('tab_more'), icon: 'M5 12h.01M12 12h.01M19 12h.01', show: true, also: ['more', 'alerts', 'admin', 'accounts', 'invoice', 'purchasing', 'dashboard', 'home'] },
  ].filter((t) => t.show);

  return (
    <div className={`shell ${showDock ? 'has-dock' : ''}`}>
      {backend.mode === 'demo' && <div className="demo-banner">Demo mode · sample data in this browser only</div>}
      {updateReady && <button type="button" className="update-banner" onClick={() => window.location.reload()}>A new version of the app is ready — tap here to update</button>}
      {screen}
      {can('admin') && !showDock && (
        <button type="button" className="dbdock-fab" onClick={() => setDock(true)} aria-label="Open the live database view">
          <span className="dot on" aria-hidden="true" /> Live DB
        </button>
      )}
      {showDock && <DbDock onClose={() => setDock(false)} />}
      <nav className="tabbar" aria-label="Main">
        <div className="tabbar-brand"><Brand /></div>
        {tabs.map((t) => {
          const on = t.also.includes(a ?? '');
          return (
          <a key={t.id} href={`#/${t.id}`} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <path d={t.icon} fill="none" stroke="currentColor" strokeWidth={t.id === 'more' ? 3.5 : 1.8} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{t.label}</span>
          </a>
          );
        })}
      </nav>
    </div>
  );
}
