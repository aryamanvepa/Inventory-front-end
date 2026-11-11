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

export function App() {
  const [backend, setBackend] = useState<Backend | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (b: Backend) => {
    const user = await b.currentUser();
    setSignedIn(!!user);
    if (user) setProfile(await b.rpc<Profile>('get_my_profile'));
    else setProfile(null);
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
  const { route, can, backend } = useApp();
  const [a, b, c] = route;

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
    case 'accounts': screen = <Accounts section={b} />; break;
    case 'invoice': screen = <InvoiceView id={b} />; break;
    case 'purchasing': screen = <Purchasing section={b} />; break;
    case 'production': screen = <Production section={b} id={c} />; break;
    default: screen = <Home />;
  }

  const tabs = [
    { id: 'home', label: 'Home', icon: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z', show: true },
    { id: 'pack', label: 'Pack', icon: 'M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8', show: can('packer', 'warehouse', 'manager') },
    { id: 'dispatch', label: 'Dispatch', icon: 'M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19a2 2 0 100-4 2 2 0 000 4zM17 19a2 2 0 100-4 2 2 0 000 4z', show: can('packer', 'warehouse', 'manager') },
    { id: 'inventory', label: 'Stock', icon: 'M4 5h16v4H4zM5 9v10h14V9M10 13h4', show: true },
    { id: 'more', label: 'More', icon: 'M5 12h.01M12 12h.01M19 12h.01', show: true },
  ].filter((t) => t.show);

  return (
    <div className="shell">
      {backend.mode === 'demo' && <div className="demo-banner">Demo mode · sample data in this browser only</div>}
      {screen}
      <nav className="tabbar" aria-label="Main">
        {tabs.map((t) => {
          const on = t.id === 'inventory' ? ['inventory', 'stock', 'labels'].includes(a ?? '') : (a ?? 'home') === t.id;
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
