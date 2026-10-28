import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { supabase, isConfigured } from './supabase';

type AppUser = { id: string; email: string; fullName: string; firstName: string; name: string };
type AuthState = { session: Session | null; user: AppUser | null; loading: boolean; error: string };
const AuthContext = createContext<AuthState>({ session: null, user: null, loading: true, error: '' });

export async function restoreAuthSession(auth: Pick<SupabaseClient['auth'], 'initialize' | 'getSession'>, callbackUrl?: string) {
  const url = callbackUrl ? new URL(callbackUrl) : null;
  const fragment = new URLSearchParams(url?.hash.slice(1));
  const hasCallback = !!url && (url.searchParams.has('code') || url.searchParams.has('error') || fragment.has('access_token') || fragment.has('error'));
  // getSession waits for initialization, but does not return a rejected callback's error.
  const initialized = await auth.initialize();
  const current = await auth.getSession();
  return {
    session: current.data.session,
    error: initialized.error || hasCallback && !current.data.session
      ? 'This sign-in or password-reset link is invalid or has expired. Request a new link or sign in again. 登录或重置链接无效或已过期，请重新申请或登录。'
      : current.error ? 'Your session could not be restored. Please sign in again.' : '',
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(isConfigured);
  const [error, setError] = useState('');
  const [profileReady, setProfileReady] = useState('');
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    restoreAuthSession(supabase.auth, window.location.href).then(restored => {
      if (!active) return;
      setSession(restored.session); setError(restored.error); setLoading(false);
    }).catch(() => { if (active) { setError('Your session could not be restored. Please sign in again.'); setLoading(false); } });
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      if (!active) return;
      setSession(next);
      if (event !== 'INITIAL_SESSION') { setLoading(false); setError(''); }
      if (event === 'PASSWORD_RECOVERY' && window.location.pathname !== '/reset-password') window.location.replace('/reset-password' + window.location.hash);
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);
  const raw = session?.user;
  const name = typeof raw?.user_metadata?.name === 'string' ? raw.user_metadata.name : raw?.email?.split('@')[0] ?? '';
  useEffect(() => {
    if (!supabase || !raw) { setProfileReady(''); return; }
    let active = true;
    const id = raw.id;
    (async () => {
      const current = await supabase.from('profiles').select('id').eq('id', id).maybeSingle();
      if (current.error) throw current.error;
      if (!current.data) {
        const saved = await supabase.from('profiles').insert({ id, name });
        if (saved.error && saved.error.code !== '23505') throw saved.error;
      }
      if (active) setProfileReady(id);
    })().catch(() => { if (active) { setError('Your account profile could not be prepared. Refresh to try again.'); setProfileReady(id); } });
    return () => { active = false; };
  }, [raw?.id]);
  const user = raw ? { id: raw.id, email: raw.email ?? '', fullName: name, firstName: name.split(/\s+/)[0], name } : null;
  return <AuthContext.Provider value={{ session, user, loading: loading || !!raw && profileReady !== raw.id, error }}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
export const useCurrentUser = () => useAuth().user;
