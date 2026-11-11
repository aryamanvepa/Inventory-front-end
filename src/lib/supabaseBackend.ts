import { createClient } from '@supabase/supabase-js';
import type { Backend } from './backend';

export function createSupabaseBackend(url: string, anonKey: string): Backend {
  const client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  return {
    mode: 'supabase',
    async rpc(fn, args = {}) {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data as any;
    },
    async currentUser() {
      const { data } = await client.auth.getSession();
      const u = data.session?.user;
      return u ? { id: u.id, email: u.email } : null;
    },
    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
    },
    async signUp(email, password) {
      // Confirmation email links back to this app (add its URL under Supabase → Auth → URL Configuration).
      const { data, error } = await client.auth.signUp({
        email, password, options: { emailRedirectTo: window.location.href.split('#')[0] },
      });
      if (error) throw new Error(error.message);
      return data.session
        ? 'Login created. Ask the administrator to give you access.'
        : 'Check your email to confirm your login, then sign in.';
    },
    async signOut() {
      await client.auth.signOut();
    },
  };
}
