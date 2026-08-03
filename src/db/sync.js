/* Two-way sync between IndexedDB and Supabase.
 *
 * Local is authoritative for writes; the server is the durable, multi-device
 * copy. Nothing here is on the capture path — if sync is broken, offline, or
 * signed out, entry still works exactly the same.
 *
 * Conflicts resolve last-write-wins on `updated_at`. For a single-user app
 * whose only real conflict is "phone and laptop both edited the same row",
 * anything cleverer would be cost without benefit.
 */

import { supabase, currentUser, isConfigured } from './supabase.js';
import { unsynced, markSynced, upsertFromServer, getMeta, setMeta } from './local.js';

const CURSOR = 'sync.cursor';
const PAGE = 500;

/** Local record -> server row. Drops the local-only index helpers. */
function toRow(rec, userId) {
  return {
    id: rec.id,
    user_id: userId,
    occurred_at: rec.occurred_at,
    amount_minor: rec.amount_minor,
    currency: rec.currency || 'PKR',
    direction: rec.direction,
    raw_name: rec.raw_name,
    source: rec.source || 'manual',
    item_id: rec.item_id ?? null,
    route_id: rec.route_id ?? null,
    category: rec.category ?? null,
    counterparty_id: rec.counterparty_id ?? null,
    counterparty_name: rec.counterparty_name ?? null,
    ledger_effect: rec.ledger_effect ?? null,
    ledger_settled: Boolean(rec.ledger_settled),
    split_group_id: rec.split_group_id ?? null,
    split_size: rec.split_size ?? null,
    source_text: rec.source_text ?? null,
    enriched_at: rec.enriched_at ?? null,
    enrichment_version: rec.enrichment_version ?? 0,
    client_event_id: rec.client_event_id ?? null,
    deleted: Boolean(rec.deleted),
    created_at: rec.created_at,
    updated_at: rec.updated_at,
  };
}

/** Server row -> local record. Booleans become 0/1 so they stay indexable. */
function fromRow(row) {
  return {
    id: row.id,
    occurred_at: row.occurred_at,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    direction: row.direction,
    raw_name: row.raw_name,
    source: row.source,
    item_id: row.item_id,
    route_id: row.route_id,
    category: row.category,
    counterparty_id: row.counterparty_id,
    counterparty_name: row.counterparty_name ?? null,
    ledger_effect: row.ledger_effect,
    ledger_settled: row.ledger_settled ? 1 : 0,
    split_group_id: row.split_group_id ?? null,
    split_size: row.split_size ?? null,
    source_text: row.source_text ?? null,
    enriched_at: row.enriched_at,
    enrichment_version: row.enrichment_version ?? 0,
    client_event_id: row.client_event_id,
    deleted: row.deleted ? 1 : 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    synced: 1,
    enriched: row.enriched_at ? 1 : 0,
  };
}

export async function push() {
  const sb = await supabase();
  const user = await currentUser();
  if (!sb || !user) return { pushed: 0 };

  const pending = await unsynced();
  if (!pending.length) return { pushed: 0 };

  const startedAt = new Date().toISOString();
  let pushed = 0;

  for (let i = 0; i < pending.length; i += PAGE) {
    const batch = pending.slice(i, i + PAGE);
    const { error } = await sb
      .from('transactions')
      .upsert(batch.map((r) => toRow(r, user.id)), { onConflict: 'id' });
    if (error) throw error;

    await markSynced(batch.map((r) => r.id), startedAt);
    pushed += batch.length;
  }

  return { pushed };
}

export async function pull() {
  const sb = await supabase();
  const user = await currentUser();
  if (!sb || !user) return { pulled: 0 };

  // Epoch on first run, so an empty device gets the full history.
  let cursor = await getMeta(CURSOR, '1970-01-01T00:00:00.000Z');
  let pulled = 0;

  for (;;) {
    const { data, error } = await sb
      .from('transactions')
      .select('*')
      .gt('updated_at', cursor)
      .order('updated_at', { ascending: true })
      .limit(PAGE);
    if (error) throw error;
    if (!data?.length) break;

    await upsertFromServer(data.map(fromRow));
    pulled += data.length;

    const last = data[data.length - 1].updated_at;
    // Guard against a page whose rows all share one timestamp, which would
    // otherwise loop forever on the same cursor.
    if (last === cursor) break;
    cursor = last;
    await setMeta(CURSOR, cursor);

    if (data.length < PAGE) break;
  }

  return { pulled };
}

let inFlight = null;

/** Push then pull. Concurrent calls share the one run. */
export function syncNow() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!isConfigured() || !navigator.onLine) return { pushed: 0, pulled: 0, skipped: true };
    const { pushed } = await push();
    const { pulled } = await pull();
    return { pushed, pulled, skipped: false };
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Sync opportunistically: on reconnect, when the tab is shown, and once at
 * startup — but the startup run is deferred to idle so pulling in the Supabase
 * chunk never delays the capture screen becoming interactive.
 */
export function startAutoSync(onResult = () => {}) {
  const run = () => syncNow().then(onResult).catch((err) => onResult({ error: err }));

  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });

  const defer = window.requestIdleCallback || ((fn) => setTimeout(fn, 800));
  defer(run, { timeout: 3000 });

  return run;
}
