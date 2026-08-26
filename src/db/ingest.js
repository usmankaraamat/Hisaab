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
import { getMeta, addPending } from './local.js';
import { parseNotification } from '../capture/notif.js';

export async function pullInbox() {
  if (!isConfigured()) return { pulled: 0 };
  if (!(await getMeta('ingest.enabled', false))) return { pulled: 0 };

  const sb = supabase();
  if (!sb) return { pulled: 0 };
  const user = await currentUser();
  if (!user) return { pulled: 0 };

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
