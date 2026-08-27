/* What you buy from whom.
 *
 * A payment notification names the payee, and the resolve form used to put that
 * name in the "what was it for?" box. It is the wrong word almost every time:
 * you are not buying *Awais Iqbal*, you are buying chicken from him, so the
 * first action was always to clear a field the app had helpfully filled — a
 * prefill that costs more than the blank it replaced.
 *
 * The payee is still the best clue available, just not as the answer. One
 * person sells you chicken; another sells eggs, bread and drinks. So what gets
 * remembered is the pairing, and what gets offered next time is what you
 * actually bought last time.
 *
 * Two behaviours, because those two shops are different problems:
 *   - a payee who only ever sells one thing is filled in
 *   - a payee who sells several is offered them as chips, and nothing is filled
 *
 * Filling in a guess that is right two thirds of the time is worse than filling
 * in nothing: the wrong guess costs a clear, the right one saves a word.
 *
 * Pure functions over a plain object, so verify.mjs pins the behaviour and the
 * store is just a value in `meta` — no schema, no sync, nothing to migrate.
 */

/** Payees are matched loosely: case, punctuation and account masks all vary. */
export function payeeKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[*]{2,}\d*/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** How many times a name must lead before it is filled in rather than offered. */
const CONFIDENT_COUNT = 2;
const CONFIDENT_SHARE = 0.6;

/**
 * Record what one payment turned out to be.
 *
 * @param memory  the store; treated as immutable, a new one is returned
 * @param payee   the counterparty from the notification (may be null)
 * @param names   the item names the payment was resolved into
 */
export function learnPayee(memory, payee, names, at = new Date().toISOString()) {
  const key = payeeKey(payee);
  const clean = (Array.isArray(names) ? names : [names])
    .map((n) => String(n ?? '').trim())
    .filter(Boolean);
  if (!key || !clean.length) return memory || {};

  const next = { ...(memory || {}) };
  const entry = next[key] ? { ...next[key], items: { ...next[key].items } } : { name: String(payee), items: {} };
  for (const name of clean) {
    const prev = entry.items[name.toLowerCase()];
    entry.items[name.toLowerCase()] = {
      name,
      count: (prev?.count || 0) + 1,
      lastAt: at,
    };
  }
  entry.name = String(payee);
  next[key] = entry;
  return next;
}

/**
 * What this payee has sold you before.
 *
 * @returns {{fill: string|null, items: {name, count, lastAt}[]}} — `fill` is set
 *   only when one name dominates; `items` is every name, most recent first
 *   among equals, so the chips read as "the usual, then the others".
 */
export function recallPayee(memory, payee, { limit = 4 } = {}) {
  const entry = (memory || {})[payeeKey(payee)];
  if (!entry) return { fill: null, items: [] };

  const items = Object.values(entry.items).sort(
    (a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1)
  );
  if (!items.length) return { fill: null, items: [] };

  const total = items.reduce((a, i) => a + i.count, 0);
  const top = items[0];
  const confident = top.count >= CONFIDENT_COUNT && top.count / total >= CONFIDENT_SHARE;
  return { fill: confident ? top.name : null, items: items.slice(0, limit) };
}

/** Forget one payee entirely — the escape hatch for a name learnt by mistake. */
export function forgetPayee(memory, payee) {
  const key = payeeKey(payee);
  if (!memory || !(key in memory)) return memory || {};
  const next = { ...memory };
  delete next[key];
  return next;
}
