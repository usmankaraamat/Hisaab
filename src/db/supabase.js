/* Supabase client and auth.
 *
 * Only the publishable key is used here. Every table has RLS enabled and
 * scoped to auth.uid(), so this key can only ever reach the signed-in user's
 * own rows. The service-role key and the Gemini key live as Edge Function
 * secrets and never enter the bundle.
 */

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

let clientPromise = null;

/** Cheap synchronous check — safe to call on the capture path. */
export function isConfigured() {
  return Boolean(URL && KEY);
}

/**
 * The SDK is ~60 kB gzipped, which is more than the rest of the app combined.
 * Importing it dynamically puts it in its own chunk that only loads when sync
 * or auth actually runs, so the capture screen is interactive without it.
 */
export function supabase() {
  if (!isConfigured()) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js').then(({ createClient }) =>
      createClient(URL, KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    );
  }
  return clientPromise;
}

export async function currentUser() {
  const sb = await supabase();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  return data?.user ?? null;
}

/** Email magic link. Redirects back to wherever the app is currently served. */
export async function signIn(email) {
  const sb = await supabase();
  if (!sb) throw new Error('Supabase is not configured.');
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split('#')[0] },
  });
  if (error) throw error;
}

export async function signOut() {
  const sb = await supabase();
  if (sb) await sb.auth.signOut();
}

export async function onAuthChange(handler) {
  const sb = await supabase();
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange((_event, session) => handler(session?.user ?? null));
  return () => data.subscription.unsubscribe();
}
