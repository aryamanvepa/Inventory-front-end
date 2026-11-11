// One interface for the app; two implementations:
//  * Supabase (production): authenticated calls to the database functions
//  * Demo: the same SQL migrations running in the browser (PGlite),
//    so the founder and staff can try every screen before Supabase is set up.
export type Role = 'admin' | 'manager' | 'warehouse' | 'packer' | 'viewer';

export interface Profile {
  user_id: string | null;
  full_name?: string;
  role: Role | null;
  active?: boolean;
  admin_exists?: boolean;
}

export interface DemoUser {
  id: string;
  label: string;
  role: Role;
}

export interface Backend {
  mode: 'demo' | 'supabase';
  rpc<T = any>(fn: string, args?: Record<string, unknown>): Promise<T>;
  currentUser(): Promise<{ id: string; email?: string } | null>;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<string>;
  signOut(): Promise<void>;
  demoUsers?: DemoUser[];
  signInDemo?(id: string): Promise<void>;
  resetDemo?(): Promise<void>;
}

let backendPromise: Promise<Backend> | null = null;

export function getBackend(): Promise<Backend> {
  if (!backendPromise) {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    backendPromise = url && key
      ? import('./supabaseBackend').then((m) => m.createSupabaseBackend(url, key))
      : import('./demoBackend').then((m) => m.createDemoBackend());
  }
  return backendPromise;
}

// Turn database errors into plain sentences for staff.
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'No connection. Check the internet and try again.';
  if (/JWT expired|invalid JWT/i.test(msg)) return 'Your session has expired. Please sign in again.';
  if (/stock_cannot_go_negative|Insufficient stock/i.test(msg)) return 'Not enough stock for that.';
  return msg.replace(/^ERROR:\s*/, '').replace(/\s*\(SQLSTATE.*\)$/, '');
}

export function newKey(prefix: string): string {
  const rnd = (globalThis.crypto && 'randomUUID' in globalThis.crypto)
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${rnd}`;
}
