/* Catching the same expense entered twice, before it is saved.
 *
 * This is not hypothetical. In the live data, "Cake 2200" was entered at 18:17
 * and the same cake was re-entered thirty-five minutes later as a five-way
 * split of 440 — 2,200 counted twice, and nothing noticed. It is the natural
 * failure mode of an app whose whole design encourages logging in three
 * seconds and moving on: re-entering is cheaper than checking.
 *
 * Two decisions keep it from becoming noise:
 *
 *   Split groups are compared as one unit, at their total. Otherwise the case
 *   above cannot be seen at all — no individual 440 row matches a 2200 row.
 *
 *   A match needs the same group key *and* the same amount inside the window.
 *   Buying a Diet Coke twice in an afternoon is ordinary and must not be
 *   flagged; buying one for exactly 2,200 twice is not.
 *
 * A warning, never a block. The user is the one who knows.
 */

import { groupKey } from '../capture/normalize.js';
import { parseForClause } from '../capture/split.js';

const HOUR_MS = 60 * 60 * 1000;

/** The key a captured line should be compared under, split or not. */
export function unitKey(name) {
  const forClause = parseForClause(name);
  return groupKey(forClause ? forClause.item : name);
}

/**
 * Collapse rows into comparable units: one per split group, one per plain row.
 * A group's amount is the sum of its parts, which is what the user actually
 * spent on the thing.
 */
export function spendUnits(rows) {
  const groups = new Map();
  const units = [];

  for (const r of rows) {
    if (r.deleted) continue;

    if (!r.split_group_id) {
      units.push({
        key: unitKey(r.raw_name),
        label: r.raw_name,
        amountMinor: r.amount_minor,
        direction: r.direction,
        at: r.occurred_at,
        ids: [r.id],
      });
      continue;
    }

    let g = groups.get(r.split_group_id);
    if (!g) {
      g = {
        key: unitKey(r.source_text || r.raw_name),
        label: r.source_text || r.raw_name,
        amountMinor: 0,
        direction: r.direction,
        at: r.occurred_at,
        ids: [],
      };
      groups.set(r.split_group_id, g);
      units.push(g);
    }
    g.amountMinor += r.amount_minor;
    g.ids.push(r.id);
    if (r.occurred_at > g.at) g.at = r.occurred_at;
  }

  return units;
}

/**
 * The most recent unit that looks like the one about to be saved.
 *
 * @param rows      every local transaction
 * @param candidate `{ name, amountMinor, direction, at }` — for a split, the
 *                  base item name and the *total*, not one share.
 * @returns `{ label, amountMinor, at, minutesAgo, ids }` or null.
 */
export function findDuplicate(
  rows,
  { name, amountMinor, direction = 'out', at = new Date(), windowHours = 12, exclude = [] } = {}
) {
  if (!name || !Number.isFinite(amountMinor) || amountMinor <= 0) return null;

  const key = unitKey(name);
  const atMs = new Date(at).getTime();
  const skip = new Set(exclude);

  const hits = spendUnits(rows)
    .filter((u) => !u.ids.some((id) => skip.has(id)))
    .filter((u) => u.direction === direction)
    .filter((u) => u.key === key && u.amountMinor === amountMinor)
    .filter((u) => {
      const gap = atMs - new Date(u.at).getTime();
      return gap >= 0 && gap <= windowHours * HOUR_MS;
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));

  const hit = hits[0];
  if (!hit) return null;

  return {
    label: hit.label,
    amountMinor: hit.amountMinor,
    at: hit.at,
    minutesAgo: Math.max(0, Math.round((atMs - new Date(hit.at).getTime()) / 60000)),
    ids: hit.ids,
  };
}
