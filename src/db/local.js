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

const DB_NAME = 'hisaab';
const DB_VERSION = 1;

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

/** Shape a transaction record. Callers pass only what capture knows. */
function makeTransaction({
  id,
  raw_name,
  amount_minor,
  direction = 'out',
  currency = 'PKR',
  occurred_at,
  source = 'manual',
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

    // Everything below is filled in later by the enrichment pass.
    category: null,
    item_id: null,
    route_id: null,
    counterparty_id: null,
    ledger_effect: null,
    enriched_at: null,
    enrichment_version: 0,

    created_at: now,
    updated_at: now,
    deleted: 0,
    synced: 0,
    enriched: 0,
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
    const rec = makeTransaction(input);
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
  const db = await openDB();
  const { t } = tx(db, ['meta'], 'readonly');
  const row = await req(t.objectStore('meta').get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await openDB();
  const { t, done } = tx(db, ['meta'], 'readwrite');
  t.objectStore('meta').put({ key, value });
  await done;
}

/** Wipe everything. Settings screen only, behind a confirm. */
export async function resetAll() {
  const db = await openDB();
  const { t, done } = tx(db, ['events', 'transactions', 'meta'], 'readwrite');
  t.objectStore('events').clear();
  t.objectStore('transactions').clear();
  t.objectStore('meta').clear();
  await done;
}
