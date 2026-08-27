/* IndexedDB layer.
 *
 * Two stores that must stay in step:
 *   events       append-only log, one record per mutation, never rewritten
 *   transactions projection built from that log, for fast reads
 *
 * Every mutation writes to both inside a single IDB transaction, so the
 * projection can always be rebuilt from the log if it is ever suspect.
 * `raw_name` is written once at capture and never touched again — everything
 * the enrichment pass derives lives in separate, nullable columns.
 */

import { personKey } from '../capture/split.js';

/* Dev-only escape hatch for the visual harness in tools/preview.html, which
 * renders a real view against a real export without standing up IndexedDB —
 * headless Chrome starves it under virtual time. Gated on import.meta.env.DEV
 * so the production build drops the branch entirely; the app itself never sets
 * `window.__rows`. Two CSS collisions that only show up on screen were caught
 * this way. */
/* Evaluated per call, not once at import: the harness sets window.__rows in its
 * own module body, which runs after every import has already been evaluated. As
 * a const this was always false, and the preview screen rendered empty. */
const PREVIEW = () => import.meta.env?.DEV && typeof window !== 'undefined' && !!window.__rows;

const DB_NAME = 'hisaab';
const DB_VERSION = 2;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('events')) {
        const events = db.createObjectStore('events', { keyPath: 'seq', autoIncrement: true });
        events.createIndex('event_id', 'event_id', { unique: true });
        events.createIndex('created_at', 'created_at');
      }

      if (!db.objectStoreNames.contains('transactions')) {
        const txns = db.createObjectStore('transactions', { keyPath: 'id' });
        txns.createIndex('occurred_at', 'occurred_at');
        txns.createIndex('synced', 'synced');
        txns.createIndex('enriched', 'enriched');
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }

      // Captures waiting to be resolved: a payment notification, or a due
      // recurring entry, that carries an amount but not yet a meaning. Kept
      // apart from `transactions` because it is not spending until the user says
      // what it was — and deliberately device-local, never synced, so a half-
      // resolved inbox on one phone does not fan out to another.
      if (!db.objectStoreNames.contains('pending')) {
        const pending = db.createObjectStore('pending', { keyPath: 'id' });
        pending.createIndex('created_at', 'created_at');
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

function tx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
  });
  return { t, done };
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure contexts (plain http on a LAN address).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function uuidFromBytes(bytes) {
  const b = bytes.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5 — name-based
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A primary key derived from the import key, so the same CSV row imported on two
 * devices lands on the same id.
 *
 * Without this each device coins a random id for the same underlying row. Both
 * push; the second one keeps its own id, misses the `onConflict: 'id'` target,
 * and trips the (user_id, client_event_id) unique index on the server. That
 * raises 23505, which aborts the whole sync loop instead of de-duplicating —
 * so a second device importing the same export would permanently break sync.
 * Deriving the id makes the collision an ordinary last-write-wins upsert.
 */
export async function stableId(key) {
  const text = new TextEncoder().encode(String(key));
  if (globalThis.crypto?.subtle) {
    return uuidFromBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', text)));
  }
  // Non-secure context (plain http on a LAN address): FNV-1a over four offset
  // seeds. Weaker than SHA-256, but it only has to be deterministic.
  const bytes = new Uint8Array(16);
  for (let s = 0; s < 4; s++) {
    let h = 0x811c9dc5 ^ s;
    for (const byte of text) {
      h ^= byte;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    bytes.set([h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255], s * 4);
  }
  return uuidFromBytes(bytes);
}

/** Shape a transaction record. Callers pass only what capture knows. */
function makeTransaction({
  id,
  raw_name,
  amount_minor,
  direction = 'out',
  currency = 'PKR',
  occurred_at,
  source = 'manual',
  // Set at capture only when the user named it outright — a shared expense or a
  // reimbursement. Enrichment fills these in for everything else, and never
  // overwrites them when they are already here.
  category = null,
  counterparty_name = null,
  ledger_effect = null,
  split_group_id = null,
  split_size = null,
  source_text = null,
  // A deterministic capture rule (or a manual correction) can set the category
  // outright and mark the row done, so the model never overrides it.
  enriched_at = null,
  enriched = 0,
}) {
  const now = new Date().toISOString();
  return {
    id: id || newId(),
    raw_name: String(raw_name || '').trim(),
    amount_minor: Math.abs(Math.trunc(amount_minor)),
    direction: direction === 'in' ? 'in' : 'out',
    currency,
    occurred_at: occurred_at || now,
    source,

    // The one line the user actually typed, when this row is one of several
    // derived from it. Nothing about the original capture is lost.
    source_text,
    split_group_id,
    split_size,
    counterparty_name,
    ledger_effect,
    ledger_settled: 0,

    // Everything below is filled in later by the enrichment pass.
    category,
    display_name: null,
    item_id: null,
    route_id: null,
    counterparty_id: null,
    enriched_at,
    enrichment_version: 0,

    created_at: now,
    updated_at: now,
    deleted: 0,
    synced: 0,
    enriched: enriched_at ? 1 : enriched,
  };
}

/** Add one transaction. Returns the stored record. */
export async function addTransaction(input) {
  const db = await openDB();
  const rec = makeTransaction(input);
  const { t, done } = tx(db, ['events', 'transactions'], 'readwrite');
  t.objectStore('transactions').put(rec);
  t.objectStore('events').put({
    event_id: newId(),
    type: 'txn.created',
    txn_id: rec.id,
    payload: rec,
    created_at: rec.created_at,
  });
  await done;
  return rec;
}

/**
 * Add several transactions as one unit — a shared expense split across people.
 * They share a `split_group_id` and go in a single IDB transaction, so the
 * group can never end up half-written.
 */
export async function addTransactions(inputs, { source_text = null } = {}) {
  if (!inputs.length) return [];
  const db = await openDB();
  const groupId = inputs.length > 1 ? newId() : null;
  const occurredAt = new Date().toISOString();

  const records = inputs.map((input) =>
    makeTransaction({
      ...input,
      occurred_at: input.occurred_at || occurredAt,
      split_group_id: groupId,
      split_size: inputs.length > 1 ? inputs.length : null,
      source_text,
    })
  );

  const { t, done } = tx(db, ['events', 'transactions'], 'readwrite');
  const txns = t.objectStore('transactions');
  const evts = t.objectStore('events');
  for (const rec of records) {
    txns.put(rec);
    evts.put({
      event_id: newId(),
      type: 'txn.created',
      txn_id: rec.id,
      payload: rec,
      created_at: rec.created_at,
    });
  }
  await done;
  return records;
}

/** Patch a transaction. Unknown ids are a no-op. */
export async function updateTransaction(id, patch) {
  const db = await openDB();
  const { t, done } = tx(db, ['events', 'transactions'], 'readwrite');
  const store = t.objectStore('transactions');
  const existing = await req(store.get(id));
  if (!existing) {
    await done;
    return null;
  }
  const next = { ...existing, ...patch, updated_at: new Date().toISOString(), synced: 0 };
  store.put(next);
  t.objectStore('events').put({
    event_id: newId(),
    type: 'txn.updated',
    txn_id: id,
    payload: patch,
    created_at: next.updated_at,
  });
  await done;
  return next;
}

/** Soft delete — the row stays so the deletion can sync. */
export async function deleteTransaction(id) {
  return updateTransaction(id, { deleted: 1 });
}

/**
 * Call a person's balance square without inventing a payment.
 *
 * Marking the rows settled is honest in a way a synthetic "repaid" row is not:
 * the spend still shows in history at the amount it really was, and the ledger
 * simply stops counting it. That is what actually happened when a shared treat
 * turns out to have been a gift.
 */
/**
 * Write off a single entry rather than a whole person.
 *
 * Buying four things for someone and meaning one of them as a gift is ordinary,
 * and settling the person wholesale would erase the three that are still owed.
 */
export async function settleTransaction(id, { settled = 1 } = {}) {
  const db = await openDB();
  const { t, done } = tx(db, ['events', 'transactions'], 'readwrite');
  const store = t.objectStore('transactions');
  const row = await req(store.get(id));
  if (!row) {
    await done;
    return null;
  }
  const now = new Date().toISOString();
  const next = { ...row, ledger_settled: settled ? 1 : 0, updated_at: now, synced: 0 };
  store.put(next);
  // The same event type settleCounterparty writes, so a replay of the log does
  // not have to know whether the user tapped one row or a whole person.
  t.objectStore('events').put({
    event_id: newId(),
    type: settled ? 'ledger.settled' : 'ledger.reopened',
    txn_id: id,
    payload: { ledger_settled: settled ? 1 : 0 },
    created_at: now,
  });
  await done;
  return next;
}

export async function settleCounterparty(key, { settled = 1 } = {}) {
  const db = await openDB();
  const { t, done } = tx(db, ['events', 'transactions'], 'readwrite');
  const store = t.objectStore('transactions');
  const all = await req(store.getAll());
  const now = new Date().toISOString();
  let touched = 0;

  for (const row of all) {
    if (row.deleted || !row.ledger_effect || !row.counterparty_name) continue;
    if (personKey(row.counterparty_name) !== key) continue;
    if (Boolean(row.ledger_settled) === Boolean(settled)) continue;
    store.put({ ...row, ledger_settled: settled ? 1 : 0, updated_at: now, synced: 0 });
    t.objectStore('events').put({
      event_id: newId(),
      type: settled ? 'ledger.settled' : 'ledger.reopened',
      txn_id: row.id,
      payload: { ledger_settled: settled ? 1 : 0 },
      created_at: now,
    });
    touched++;
  }

  await done;
  return touched;
}

/**
 * Bulk insert, used by the CSV importer. One IDB transaction for the whole
 * batch so importing hundreds of rows stays fast.
 * `client_event_id` de-duplicates re-imports of the same file.
 */
export async function bulkAdd(inputs) {
  const db = await openDB();
  const existingKeys = new Set(await listImportKeys());
  const fresh = [];

  for (const input of inputs) {
    if (input.client_event_id && existingKeys.has(input.client_event_id)) continue;
    // Derived, not random, so a second device importing the same file converges
    // on one row instead of colliding on the server's uniqueness constraint.
    const id = input.id || (input.client_event_id ? await stableId(input.client_event_id) : undefined);
    const rec = makeTransaction({ ...input, id });
    rec.client_event_id = input.client_event_id || null;
    fresh.push(rec);
  }

  if (!fresh.length) return { added: 0, skipped: inputs.length };

  const { t, done } = tx(db, ['events', 'transactions'], 'readwrite');
  const txns = t.objectStore('transactions');
  const evts = t.objectStore('events');
  for (const rec of fresh) {
    txns.put(rec);
    evts.put({
      event_id: newId(),
      type: 'txn.created',
      txn_id: rec.id,
      payload: rec,
      created_at: rec.created_at,
    });
  }
  await done;
  return { added: fresh.length, skipped: inputs.length - fresh.length };
}

/** Every client_event_id already stored, so imports stay idempotent. */
export async function listImportKeys() {
  const db = await openDB();
  const { t } = tx(db, ['transactions'], 'readonly');
  const all = await req(t.objectStore('transactions').getAll());
  return all.map((r) => r.client_event_id).filter(Boolean);
}

/** Most recent first. */
export async function listTransactions({ limit = 200, includeDeleted = false } = {}) {
  const db = await openDB();
  const { t } = tx(db, ['transactions'], 'readonly');
  const idx = t.objectStore('transactions').index('occurred_at');
  const out = [];

  await new Promise((resolve, reject) => {
    const cursorReq = idx.openCursor(null, 'prev');
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result;
      if (!cur || out.length >= limit) return resolve();
      if (includeDeleted || !cur.value.deleted) out.push(cur.value);
      cur.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });

  return out;
}

export async function allTransactions() {
  if (PREVIEW()) return window.__rows;
  const db = await openDB();
  const { t } = tx(db, ['transactions'], 'readonly');
  const all = await req(t.objectStore('transactions').getAll());
  return all.filter((r) => !r.deleted);
}

export async function countTransactions() {
  const db = await openDB();
  const { t } = tx(db, ['transactions'], 'readonly');
  return req(t.objectStore('transactions').count());
}

export async function countEvents() {
  const db = await openDB();
  const { t } = tx(db, ['events'], 'readonly');
  return req(t.objectStore('events').count());
}

/** Rows the sync worker still owes the server. */
export async function unsynced() {
  const db = await openDB();
  const { t } = tx(db, ['transactions'], 'readonly');
  return req(t.objectStore('transactions').index('synced').getAll(0));
}

/** Mark rows as pushed. Skips any row touched again since the push started. */
export async function markSynced(ids, pushedAt) {
  if (!ids.length) return;
  const db = await openDB();
  const { t, done } = tx(db, ['transactions'], 'readwrite');
  const store = t.objectStore('transactions');
  for (const id of ids) {
    const row = await req(store.get(id));
    if (!row) continue;
    if (pushedAt && row.updated_at > pushedAt) continue;
    store.put({ ...row, synced: 1 });
  }
  await done;
}

/**
 * Apply rows pulled from the server. Last-write-wins on `updated_at`, so a
 * local edit made while offline is not clobbered by an older server copy.
 * No event is logged: these are not local mutations.
 */
export async function upsertFromServer(rows) {
  if (!rows.length) return { applied: 0 };
  const db = await openDB();
  const { t, done } = tx(db, ['transactions'], 'readwrite');
  const store = t.objectStore('transactions');
  let applied = 0;

  for (const row of rows) {
    const existing = await req(store.get(row.id));
    if (existing && existing.updated_at > row.updated_at) continue;
    store.put({ ...existing, ...row, synced: 1 });
    applied++;
  }

  await done;
  return { applied };
}

export async function getMeta(key, fallback = null) {
  if (PREVIEW()) return window.__meta?.[key] ?? fallback;
  const db = await openDB();
  const { t } = tx(db, ['meta'], 'readonly');
  const row = await req(t.objectStore('meta').get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  if (PREVIEW()) {
    window.__meta = { ...(window.__meta || {}), [key]: value };
    return;
  }
  const db = await openDB();
  const { t, done } = tx(db, ['meta'], 'readwrite');
  t.objectStore('meta').put({ key, value });
  await done;
}

/* ------------------------------------------------------------ pending inbox */

/**
 * Add a capture waiting to be resolved. `source_key` de-duplicates: a
 * notification forwarded twice, or a recurring entry surfaced on two opens,
 * lands once. Returns the stored record, or the existing one on a duplicate.
 */
export async function addPending(input) {
  const db = await openDB();
  const now = new Date().toISOString();
  const rec = {
    id: input.id || newId(),
    amountMinor: Math.abs(Math.trunc(input.amountMinor || 0)),
    direction: input.direction === 'in' ? 'in' : 'out',
    counterparty: input.counterparty ?? null,
    category: input.category ?? null,
    source: input.source ?? null,
    ref: input.ref ?? null,
    occurred_at: input.occurred_at || input.occurredAt || now,
    raw: input.raw ?? null,
    kind: input.kind || 'notification', // 'notification' | 'recurring'
    source_key: input.source_key ?? null,
    created_at: now,
  };

  const { t, done } = tx(db, ['pending'], 'readwrite');
  const store = t.objectStore('pending');
  if (rec.source_key) {
    const all = await req(store.getAll());
    const dupe = all.find((p) => p.source_key === rec.source_key);
    if (dupe) {
      await done;
      return dupe;
    }
  }
  store.put(rec);
  await done;
  return rec;
}

export async function listPending() {
  if (PREVIEW()) return window.__pending ?? [];
  const db = await openDB();
  const { t } = tx(db, ['pending'], 'readonly');
  const all = await req(t.objectStore('pending').getAll());
  // Oldest first: the top of the inbox is the thing that has waited longest.
  return all.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

export async function countPending() {
  const db = await openDB();
  const { t } = tx(db, ['pending'], 'readonly');
  return req(t.objectStore('pending').count());
}

export async function deletePending(id) {
  const db = await openDB();
  const { t, done } = tx(db, ['pending'], 'readwrite');
  t.objectStore('pending').delete(id);
  await done;
}

/** Wipe everything. Settings screen only, behind a confirm. */
export async function resetAll() {
  const db = await openDB();
  const stores = ['events', 'transactions', 'meta', 'pending'];
  const { t, done } = tx(db, stores, 'readwrite');
  for (const s of stores) t.objectStore(s).clear();
  await done;
}
