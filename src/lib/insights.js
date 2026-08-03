/* Analysis over the transaction history.
 *
 * All of this runs on `raw_name` via the deterministic group key, so it works
 * offline and without any enrichment having happened. The AI pass makes
 * the grouping better (it merges spelling variants), it is not a prerequisite.
 *
 * Pure functions on purpose: they take rows and return data, so they can be
 * checked against the real export in scripts/verify.mjs.
 */

import { groupKey, displayName, isRide } from '../capture/normalize.js';
import { median } from '../capture/predict.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function groupRows(rows, { onlyOut = true } = {}) {
  const groups = new Map();
  for (const r of rows) {
    if (onlyOut && r.direction !== 'out') continue;
    if (r.deleted) continue;
    const key = groupKey(r.raw_name);
    if (key === 'item:') continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, rows: [], names: new Map() };
      groups.set(key, g);
    }
    g.rows.push(r);
    g.names.set(r.raw_name, (g.names.get(r.raw_name) || 0) + 1);
  }
  for (const g of groups.values()) {
    g.rows.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1));
    g.label = displayName([...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }
  return groups;
}

/**
 * Typical fare per route, and the rides that ran well above it.
 * Worth doing: rides are ~30% of all entries, and the same route in the export
 * ranges from 170 to 350 PKR.
 */
export function rideSurge(rows, { minSamples = 3, threshold = 1.4 } = {}) {
  const out = [];
  for (const g of groupRows(rows).values()) {
    if (!isRide(g.rows[0].raw_name)) continue;
    if (g.rows.length < minSamples) continue;

    const amounts = g.rows.map((r) => r.amount_minor);
    const med = median(amounts);
    const over = g.rows.filter((r) => r.amount_minor > med * threshold);

    out.push({
      key: g.key,
      label: g.label,
      medianMinor: med,
      minMinor: Math.min(...amounts),
      maxMinor: Math.max(...amounts),
      count: g.rows.length,
      overpaidCount: over.length,
      overpaidMinor: over.reduce((a, r) => a + (r.amount_minor - med), 0),
    });
  }
  return out.sort((a, b) => b.overpaidMinor - a.overpaidMinor || b.count - a.count);
}

/** Is this amount unusually high for this route, given past fares? */
export function surgeCheck(rows, rawName, amountMinor, { minSamples = 3, threshold = 1.4 } = {}) {
  if (!isRide(rawName) || !amountMinor) return null;
  const key = groupKey(rawName);
  const amounts = rows
    .filter((r) => !r.deleted && r.direction === 'out' && groupKey(r.raw_name) === key)
    .map((r) => r.amount_minor);
  if (amounts.length < minSamples) return null;
  const med = median(amounts);
  if (amountMinor <= med * threshold) return null;
  return { medianMinor: med, overBy: Math.round((amountMinor / med - 1) * 100) };
}

/**
 * Per-item price movement: median of the earliest third of purchases against
 * the median of the most recent third. Only items bought often enough, over a
 * long enough span, to say anything at all.
 */
export function priceIndex(rows, { minSamples = 4, minSpanDays = 30 } = {}) {
  const out = [];
  for (const g of groupRows(rows).values()) {
    if (isRide(g.rows[0].raw_name)) continue;
    if (g.rows.length < minSamples) continue;

    const spanDays =
      (new Date(g.rows.at(-1).occurred_at) - new Date(g.rows[0].occurred_at)) / DAY_MS;
    if (spanDays < minSpanDays) continue;

    const third = Math.max(1, Math.floor(g.rows.length / 3));
    const early = median(g.rows.slice(0, third).map((r) => r.amount_minor));
    const late = median(g.rows.slice(-third).map((r) => r.amount_minor));
    if (!early) continue;

    out.push({
      key: g.key,
      label: g.label,
      count: g.rows.length,
      earlyMinor: early,
      lateMinor: late,
      changePct: Math.round((late / early - 1) * 100),
      spanDays: Math.round(spanDays),
    });
  }
  return out.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
}

/* Real billing cycles are not all monthly. In the export, Spotify bills every
 * 15 days despite being named "Monthly subscription", while Netflix (31d) and
 * Claude Pro (29d) have only two charges each so far. Detecting only "roughly
 * 30 days, at least 3 times" misses all three. */
const CADENCES = [
  { name: 'weekly', min: 6, max: 8 },
  { name: 'fortnightly', min: 13, max: 17 },
  { name: 'monthly', min: 26, max: 35 },
  { name: 'quarterly', min: 85, max: 95 },
];

function cadenceFor(days) {
  return CADENCES.find((c) => days >= c.min && days <= c.max) ?? null;
}

/**
 * Recurring charges on any regular cycle.
 *
 * Two charges are enough to qualify, but only when the amounts nearly match —
 * that is what separates a real subscription from two coincidental purchases a
 * month apart. With three or more, most of the gaps have to agree on a cycle,
 * so an irregular series (a remittance sent whenever) is correctly excluded.
 */
export function subscriptions(rows, { minSamples = 2, now = new Date(), amountTolerance = 0.15 } = {}) {
  const out = [];

  for (const g of groupRows(rows).values()) {
    if (g.rows.length < Math.max(2, minSamples)) continue;

    const gaps = [];
    for (let i = 1; i < g.rows.length; i++) {
      gaps.push(
        Math.round((new Date(g.rows[i].occurred_at) - new Date(g.rows[i - 1].occurred_at)) / DAY_MS)
      );
    }

    const typical = median(gaps);
    const cadence = cadenceFor(typical);
    if (!cadence) continue;

    const first = g.rows[0];
    const last = g.rows.at(-1);

    if (gaps.length === 1) {
      // A single interval is weak evidence, so lean on the amounts instead.
      const ratio = Math.min(first.amount_minor, last.amount_minor) /
        Math.max(first.amount_minor, last.amount_minor);
      if (1 - ratio > amountTolerance) continue;
    } else {
      // Tolerate one skipped or early cycle, not a generally irregular series.
      const consistent = gaps.filter((d) => cadenceFor(d)?.name === cadence.name).length;
      if (consistent / gaps.length < 0.6) continue;
    }

    const daysSince = Math.round((now - new Date(last.occurred_at)) / DAY_MS);
    const amounts = g.rows.map((r) => r.amount_minor);
    const lowest = Math.min(...amounts);
    const highest = Math.max(...amounts);

    out.push({
      key: g.key,
      label: g.label,
      count: g.rows.length,
      cadence: cadence.name,
      everyDays: typical,
      lastMinor: last.amount_minor,
      firstMinor: first.amount_minor,
      minMinor: lowest,
      maxMinor: highest,
      // Any variation across the run, not just first vs last: Spotify starts
      // and ends at 520 in the export but dips to 440 in between, which a
      // first/last comparison would report as a flat price.
      priceChanged: lowest !== highest,
      lastSeen: last.occurred_at,
      daysSince,
      // Two cycles late means it has probably stopped — cancelled, or a card
      // that silently failed.
      lapsed: daysSince > typical * 2,
      nextDue: new Date(new Date(last.occurred_at).getTime() + typical * DAY_MS).toISOString(),
    });
  }

  return out.sort((a, b) => b.lastMinor - a.lastMinor);
}

/** Total spend per month, oldest first. */
export function monthlyTotals(rows) {
  const months = new Map();
  for (const r of rows) {
    if (r.deleted || r.direction !== 'out') continue;
    const key = r.occurred_at.slice(0, 7);
    months.set(key, (months.get(key) || 0) + r.amount_minor);
  }
  return [...months.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, totalMinor]) => ({ month, totalMinor }));
}
