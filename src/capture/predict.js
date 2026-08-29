/* Suggestions derived from the user's own history.
 *
 * The screen offers three whole-entry rows for *this* two-hour slot of the day,
 * drawn only from days that resemble today. The clock is cut into 12 fixed
 * slots (12am-2am, 2am-4am, …) rather than scored with a kernel around the
 * current hour: a slot is a routine — the commute out, the evening meal — and a
 * routine is what the user is about to type.
 *
 * The comparison window is the other half of the argument. A Tuesday looks like
 * the last five weekdays, not like the weekend that fell in the middle of them;
 * a Sunday looks like the last two weekends. Mixing the two is what made the
 * old chips generic — the office commute leaking into a Saturday morning.
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

/** Median of a numeric array. */
export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export const SLOT_HOURS = 2;
export const SLOT_COUNT = 24 / SLOT_HOURS;

/** Which of the 12 two-hour slots a moment falls in, 0 = 12am-2am. */
export function slotOf(date) {
  return Math.floor(date.getHours() / SLOT_HOURS);
}

function clockLabel(hour24) {
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h}${hour24 < 12 || hour24 === 24 ? 'am' : 'pm'}`;
}

/** "8pm–10pm", for the heading above the suggestions. */
export function slotLabel(slot) {
  const from = slot * SLOT_HOURS;
  return `${clockLabel(from)}–${clockLabel(from + SLOT_HOURS)}`;
}

function isWeekend(date) {
  const d = date.getDay();
  return d === 0 || d === 6;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

/**
 * The days today is allowed to learn from: the last 5 weekdays on a weekday,
 * the last 2 weekends on a Saturday or Sunday. Today counts as one of them.
 *
 * A weekend is a Saturday and the Sunday after it, so "the last 2 weekends"
 * asked on a Saturday means today plus the whole of the previous weekend —
 * not today plus a Sunday that belongs to the weekend before.
 */
export function referenceDays(now = new Date()) {
  const weekend = isWeekend(now);
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = new Set();

  if (!weekend) {
    while (days.size < 5) {
      if (!isWeekend(cursor)) days.add(dayKey(cursor));
      cursor.setDate(cursor.getDate() - 1);
    }
    return days;
  }

  // Group weekend days by the Saturday that opens their weekend, and stop once
  // two of those groups have been seen.
  const weekends = new Set();
  while (weekends.size < 2 || isWeekend(cursor)) {
    if (isWeekend(cursor)) {
      const sat = new Date(cursor);
      if (sat.getDay() === 0) sat.setDate(sat.getDate() - 1);
      const id = dayKey(sat);
      if (weekends.size === 2 && !weekends.has(id)) break;
      weekends.add(id);
      days.add(dayKey(cursor));
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return days;
}

/**
 * Whole-entry suggestions for the slot the user is in right now.
 *
 * Returns groups with a median amount, so the row can show "Gym → Home ~310"
 * before it is tapped — the price is visible up front, not a surprise.
 */
export async function suggestChips({ now = new Date(), limit = 3 } = {}) {
  return rankSuggestions(await load(), { now, limit });
}

/** Collapse rows into ranked, named groups. */
function rank(rows) {
  const groups = new Map();

  for (const r of rows) {
    const key = groupKey(r.raw_name);
    let g = groups.get(key);
    if (!g) {
      g = { key, amounts: [], count: 0, names: new Map(), lastSeen: r.occurred_at };
      groups.set(key, g);
    }
    g.amounts.push(r.amount_minor);
    g.count += 1;
    g.names.set(r.raw_name, (g.names.get(r.raw_name) || 0) + 1);
    if (r.occurred_at > g.lastSeen) g.lastSeen = r.occurred_at;
  }

  return [...groups.values()]
    .sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1))
    .map((g) => {
      // Most-used original spelling represents the group.
      const representative = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return {
        key: g.key,
        label: displayName(representative),
        text: templateText(representative),
        amountMinor: median(g.amounts),
        count: g.count,
        lastSeen: g.lastSeen,
      };
    });
}

/** Pure core of `suggestChips`, split out so it can be tested against the CSV. */
export function rankSuggestions(rows, { now = new Date(), limit = 3 } = {}) {
  const slot = slotOf(now);
  const days = referenceDays(now);

  const spends = rows.filter((r) => r.direction === 'out' && groupKey(r.raw_name) !== 'item:');
  // Timestamps are stored as UTC ISO, so both the slot and the day have to be
  // read back through the local clock — a 1am entry in PKT is the previous
  // UTC day, and slicing the string would file it under the wrong one.
  const inSlot = spends.filter((r) => slotOf(new Date(r.occurred_at)) === slot);
  const matching = inSlot.filter((r) => days.has(dayKey(new Date(r.occurred_at))));

  const picks = [];
  const seen = new Set();
  // Days like today, in this slot, first. Then the same slot from any day —
  // early hours can have a near-empty window — and only then whatever is used
  // most overall, so the row is never blank.
  for (const tier of [rank(matching), rank(inSlot), rank(spends)]) {
    for (const c of tier) {
      if (picks.length >= limit) return picks;
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      picks.push(c);
    }
  }
  return picks.slice(0, limit);
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
