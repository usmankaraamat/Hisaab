/* Pull forwarded payment notifications from the server inbox into the local
 * pending store. This is the client half of the auto-capture path (see
 * supabase/functions/ingest and migration 0005).
 *
 * Gated behind `ingest.enabled`, off by default, so a device that has not set
 * up forwarding never polls a table that may not exist yet — no error noise in
 * production. Every failure is swallowed: auto-capture is a convenience layered
 * on top of manual paste and the share target, never something the app depends
 * on. */

import { supabase, isConfigured, currentUser } from './supabase.js';
import { getMeta, setMeta, addPending } from './local.js';
import { parseNotification } from '../capture/notif.js';

/**
 * Make sure the token this device hands to its macros is the one the server
 * knows about, and repair it if it is not.
 *
 * The token is generated on the device and registered separately, so the two
 * halves can drift apart: generate it while signed out, or with no signal, and
 * the phone is left holding a token the endpoint has never heard of. Every
 * forwarded notification then comes back `401 unknown token` — from the macro's
 * side indistinguishable from a misconfigured header, and there was nothing in
 * the app that would ever try again.
 *
 * So registration is re-asserted rather than done once. `ingest.registered`
 * remembers what has been confirmed for whom, which keeps this to a single
 * upsert the first time and nothing at all afterwards; a failure leaves the
 * marker unset, so the next launch retries.
 *
 * @returns {{state: 'ok'|'signed-out'|'no-token'|'failed', detail?: string}}
 */
export async function ensureIngestToken() {
  if (!isConfigured()) return { state: 'signed-out' };
  const token = await getMeta('ingest.token', null);
  if (!token) return { state: 'no-token' };

  const sb = await supabase();
  if (!sb) return { state: 'signed-out' };
  const user = await currentUser();
  if (!user) return { state: 'signed-out' };

  if ((await getMeta('ingest.registered', null)) === `${user.id}:${token}`) return { state: 'ok' };

  try {
    // Anything else registered for this account is a token no macro should be
    // using any more — the same rule the Settings button applies when it
    // regenerates, so a stale token cannot outlive the device it was made on.
    await sb.from('ingest_tokens').delete().eq('user_id', user.id).neq('token', token);
    const { error } = await sb
      .from('ingest_tokens')
      .upsert({ token, user_id: user.id, label: 'device' });
    if (error) return { state: 'failed', detail: error.message };
    await setMeta('ingest.registered', `${user.id}:${token}`);
    return { state: 'ok' };
  } catch (err) {
    // Carried out rather than swallowed. Every failure here looks the same from
    // the phone — a 401 in the macro's log — so the one place that knows what
    // actually went wrong is the only place worth saying it.
    return { state: 'failed', detail: err?.message || String(err) };
  }
}

export async function pullInbox() {
  if (!isConfigured()) return { pulled: 0 };
  if (!(await getMeta('ingest.enabled', false))) return { pulled: 0 };

  const sb = await supabase();
  if (!sb) return { pulled: 0 };
  const user = await currentUser();
  if (!user) return { pulled: 0 };

  // Cheap after the first success, and the only thing that heals a token that
  // was generated while signed out.
  await ensureIngestToken();

  try {
    const { data, error } = await sb
      .from('payment_inbox')
      .select('id, app, body, created_at')
      .order('created_at', { ascending: true })
      .limit(50);
    if (error || !data?.length) return { pulled: 0 };

    let added = 0;
    for (const row of data) {
      const parsed = parseNotification(row.body, { appName: row.app });
      if (parsed) {
        await addPending({
          ...parsed,
          occurred_at: parsed.occurredAt,
          // The server row id keeps a re-pull from double-adding.
          source_key: `inbox:${row.id}`,
        });
        added++;
      }
    }

    // Clear what we consumed, parsed or not — an unparseable message would
    // otherwise be re-fetched forever.
    await sb.from('payment_inbox').delete().in('id', data.map((r) => r.id));
    return { pulled: added };
  } catch {
    return { pulled: 0 };
  }
}
