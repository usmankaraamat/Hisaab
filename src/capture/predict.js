/* Suggestions derived from the user's own history.
 *
 * Phase 1 covers frequent amounts. Phase 2 adds the time-of-day route chips
 * (`suggestChips`), which is where the real win is: ~30% of all entries in the
 * import are ride-hailing across ~8 repeated routes, and those cluster hard by
 * hour of day (08:00-11:00 commute out, 20:00-22:00 gym/dinner return).
 */

import { allTransactions } from '../db/local.js';
import { groupKey, displayName, templateText } from './normalize.js';

let cache = null;

export function invalidate() {
  cache = null;
}

async function load() {
  if (!cache) cache = await allTransactions();
  return cache;
}

/**
 * The amounts this user actually types, most frequent first.
 * Beats a generic numpad: entries cluster tightly (median 280 PKR, half of all
 * expenses under 300).
 */
export async function frequentAmounts(limit = 8) {
  const rows = await load();
  const counts = new Map();

  for (const r of rows) {
    if (r.direction !== 'out') continue;
    counts.set(r.amount_minor, (counts.get(r.amount_minor) || 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([minor, count]) => ({ amountMinor: minor, count }));
}

/** Median of a numeric array. */
export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Circular distance between two clock hours, 0-12. */
function hourDistance(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 24 - d);
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whole-entry suggestions for the current time of day.
 *
 * Scoring is a coarse kernel over the clock rather than a hard hour bucket:
 * an entry logged at 20:40 should still count at 21:10. Recent entries get a
 * mild boost so the chips track a changing routine instead of being anchored
 * to whatever was common three months ago.
 *
 * Returns groups with a median amount, so the chip can show "Gym → Home ~310"
 * before it is tapped — the price is visible up front, not a surprise.
 */
export async function suggestChips({ now = new Date(), limit = 5 } = {}) {
  return rankSuggestions(await load(), { now, limit });
}

/** Pure core of `suggestChips`, split out so it can be tested against the CSV. */
export function rankSuggestions(rows, { now = new Date(), limit = 5 } = {}) {
  const hour = now.getHours();
  const nowMs = now.getTime();
  const groups = new Map();

  for (const r of rows) {
    if (r.direction !== 'out') continue;
    const key = groupKey(r.raw_name);
    if (key === 'item:') continue;

    let g = groups.get(key);
    if (!g) {
      g = { key, amounts: [], score: 0, count: 0, names: new Map(), lastSeen: r.occurred_at };
      groups.set(key, g);
    }

    const at = new Date(r.occurred_at);
    const d = hourDistance(hour, at.getHours());
    const proximity = d <= 1 ? 3 : d <= 2 ? 2 : d <= 3 ? 1 : 0;
    const recency = nowMs - at.getTime() <= THIRTY_DAYS_MS ? 1.5 : 1;

    g.amounts.push(r.amount_minor);
    g.count += 1;
    g.score += proximity * recency;
    g.names.set(r.raw_name, (g.names.get(r.raw_name) || 0) + 1);
    if (r.occurred_at > g.lastSeen) g.lastSeen = r.occurred_at;
  }

  const candidates = [...groups.values()]
    .filter((g) => g.count >= 2)
    .map((g) => {
      // Most-used original spelling represents the group.
      const representative = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return {
        key: g.key,
        label: displayName(representative),
        text: templateText(representative),
        amountMinor: median(g.amounts),
        count: g.count,
        score: g.score,
      };
    });

  const timely = candidates
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.count - a.count);

  // Early hours can have nothing nearby on the clock; fall back to overall
  // favourites rather than showing an empty row.
  if (timely.length >= limit) return timely.slice(0, limit);

  const seen = new Set(timely.map((c) => c.key));
  const filler = candidates
    .filter((c) => !seen.has(c.key))
    .sort((a, b) => b.count - a.count);

  return [...timely, ...filler].slice(0, limit);
}

/** Distinct names the user has typed before, for the datalist autocomplete. */
export async function knownNames(limit = 300) {
  const rows = await load();
  const counts = new Map();
  for (const r of rows) {
    const name = (r.raw_name || '').trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}
