/* Time series over the transaction history: months, weeks within a month, days
 * within a week — the three grains the Overview drills through.
 *
 * Two rules shape everything here.
 *
 * Provenance. Rows imported from the old app are reference only: that period
 * was lived with flatmates covering each other's expenses, with real gaps in
 * the logging, so its totals are not comparable with anything tracked here.
 * They are kept, and shown, and never mixed into a figure that is supposed to
 * mean something. `isTracked` is the line.
 *
 * Calendar, not payday. Everywhere else in the app a period runs from one
 * income to the next, because that is what a spending limit has to be measured
 * against. Overview is history rather than budget: "August" has to mean August
 * or month-over-month comparison is meaningless. The two therefore disagree by
 * a few days, on purpose.
 *
 * Pure functions over rows, so they run offline and are checked in verify.mjs.
 */

import { isWrittenOffShare, isOutstandingLoan, NON_SPEND, RECONCILE } from './budget.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Spending you cannot move this month, however much you want to. */
export const FIXED = new Set(['Utilities', 'Rent', 'Subscriptions']);

/* Where a row came from. Anything not logged in this app is history the user
 * has explicitly said is unreliable — kept for reference, never for a trend. */
export const REFERENCE_SOURCES = new Set(['bluecoins']);

export function isTracked(row) {
  return !REFERENCE_SOURCES.has(row?.source);
}

/** Money consumed: your own, plus what you spent on others and wrote off. */
export function isSpend(row) {
  if (row.direction !== 'out') return false;
  if (NON_SPEND.has(row.category)) return false;
  // A reconciliation correction is neither earned nor bought; see budget.js.
  if (row.category === RECONCILE) return false;
  if (row.ledger_effect === 'borrowed') return false;
  if (isOutstandingLoan(row)) return false;
  return true;
}

const MONTH_LABEL = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' });
const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar parts of an ISO instant, so a bucket matches the day it felt like. */
function parts(iso) {
  const d = new Date(iso);
  return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), at: d };
}

/**
 * Weeks inside a month, counted from the 1st rather than by ISO week.
 *
 * An ISO week straddles the month boundary, which would put the same days in
 * two different months and make the weeks fail to add up to the month above
 * them. Blocks of seven from the 1st always nest exactly, at the cost of a
 * short final week — which is the honest shape of a calendar month anyway.
 */
export function weeksIn(year, month) {
  const days = new Date(year, month + 1, 0).getDate();
  const out = [];
  for (let start = 1; start <= days; start += 7) {
    const end = Math.min(start + 6, days);
    out.push({
      key: `${year}-${pad(month + 1)}-w${out.length + 1}`,
      start,
      end,
      label: `${start}–${end} ${MONTH_LABEL.format(new Date(year, month, 1)).split(' ')[0]}`,
    });
  }
  return out;
}

const TOTALS = () => ({
  spendMinor: 0,
  fixedMinor: 0,
  flexibleMinor: 0,
  onOthersMinor: 0,
  savedMinor: 0,
  incomeMinor: 0,
  count: 0,
});

function empty(key, label, extra = {}) {
  // Two sets, resolved by `settle`. The export overlaps the first days of the
  // month the app started, so a bucket has to be able to hold both and then
  // choose — flagging the whole of August as unreliable because three imported
  // rows landed in it would grey out the only month actually measured.
  return { key, label, ...TOTALS(), reference: false, mixed: false, _t: TOTALS(), _r: TOTALS(), ...extra };
}

function into(t, row) {
  t.count++;

  if (row.direction === 'in') {
    // Redeeming savings is not income; it undoes a deposit.
    if (row.category === 'Savings') t.savedMinor -= row.amount_minor;
    // A reconciliation credit is a correction to the balance, not income.
    else if (row.category === RECONCILE) return;
    else if (!row.ledger_effect) t.incomeMinor += row.amount_minor;
    return;
  }

  if (row.category === 'Savings') {
    t.savedMinor += row.amount_minor;
    return;
  }
  if (!isSpend(row)) return;

  t.spendMinor += row.amount_minor;
  if (isWrittenOffShare(row)) t.onOthersMinor += row.amount_minor;
  if (FIXED.has(row.category)) t.fixedMinor += row.amount_minor;
  else t.flexibleMinor += row.amount_minor;
}

function add(bucket, row) {
  into(isTracked(row) ? bucket._t : bucket._r, row);
}

/**
 * Decide what the bucket reports.
 *
 * Tracked rows win outright wherever there are any: a month this app measured
 * is described by what this app measured, and the handful of imported rows that
 * overlap its first days are duplicates of entries the user re-typed anyway.
 * Only a bucket with nothing tracked in it falls back to imported totals, and
 * says so.
 */
function settle(bucket) {
  const hasTracked = bucket._t.count > 0;
  Object.assign(bucket, hasTracked ? bucket._t : bucket._r);
  bucket.reference = !hasTracked && bucket._r.count > 0;
  bucket.mixed = hasTracked && bucket._r.count > 0;
  delete bucket._t;
  delete bucket._r;
  return bucket;
}

/**
 * One bucket per calendar month, oldest first.
 *
 * `reference` marks a month that contains imported rows, so the chart can grey
 * it out rather than inviting a comparison the data cannot support.
 */
export function monthlySeries(rows) {
  const months = new Map();
  for (const r of rows) {
    if (r.deleted) continue;
    const { y, m } = parts(r.occurred_at);
    const key = `${y}-${pad(m + 1)}`;
    if (!months.has(key)) {
      months.set(key, empty(key, MONTH_LABEL.format(new Date(y, m, 1)), { year: y, month: m }));
    }
    add(months.get(key), r);
  }
  return [...months.values()].map(settle).sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** One bucket per seven-day block inside a month, oldest first. */
export function weeklySeries(rows, year, month) {
  const weeks = weeksIn(year, month).map((w) => empty(w.key, w.label, { ...w, year, month }));
  for (const r of rows) {
    if (r.deleted) continue;
    const { y, m, d } = parts(r.occurred_at);
    if (y !== year || m !== month) continue;
    const bucket = weeks.find((w) => d >= w.start && d <= w.end);
    if (bucket) add(bucket, r);
  }
  return weeks.map(settle);
}

/** One bucket per day inside a week, oldest first. */
export function dailySeries(rows, year, month, from, to) {
  const days = [];
  for (let d = from; d <= to; d++) {
    const at = new Date(year, month, d);
    days.push(
      empty(`${year}-${pad(month + 1)}-${pad(d)}`, `${WEEKDAY.format(at)} ${d}`, {
        year,
        month,
        day: d,
        date: DAY_LABEL.format(at),
      })
    );
  }
  for (const r of rows) {
    if (r.deleted) continue;
    const { y, m, d } = parts(r.occurred_at);
    if (y !== year || m !== month || d < from || d > to) continue;
    add(days[d - from], r);
  }
  return days.map(settle);
}

/**
 * The savings pot: every deposit you logged, less every withdrawal, for all time.
 *
 * This is a running balance and it must never reset. The per-period figure has
 * its uses — a monthly target has to be measured against a month — but as *the*
 * savings number it was wrong: a salary landing on the 3rd would drop "saved"
 * back to zero and wipe out months of visible progress, which is exactly the
 * thing that makes people stop looking. What you have set aside is a fact about
 * your money, not about the current pay cycle.
 *
 * Driven only by what was logged as Savings — never inferred from income minus
 * spending, which would move on its own every time anything else changed.
 */
export function savingsPot(rows) {
  let minor = 0;
  let deposits = 0;
  let withdrawals = 0;
  let lastAt = null;

  for (const r of rows) {
    if (r.deleted || !isTracked(r) || r.category !== 'Savings') continue;
    if (r.direction === 'out') {
      minor += r.amount_minor;
      deposits++;
    } else {
      minor -= r.amount_minor;
      withdrawals++;
    }
    if (!lastAt || r.occurred_at > lastAt) lastAt = r.occurred_at;
  }

  return { minor, deposits, withdrawals, lastAt };
}

/**
 * How much of what came in stayed.
 *
 * The number the whole app exists to move, and it was nowhere on screen. Null
 * rather than zero when no income landed in the month: a savings rate against
 * no income is not 0%, it is undefined, and plotting it as zero would draw a
 * cliff every time a salary arrives a day late.
 */
export function savingsRate(bucket) {
  if (!bucket.incomeMinor) return null;
  return bucket.savedMinor / bucket.incomeMinor;
}

/**
 * Where the month lands if the rest of it looks like the part already lived.
 *
 * Only for a month still running; a finished month has an actual, and dressing
 * that up as a forecast would be theatre.
 */
export function projectMonth(bucket, now = new Date()) {
  if (!bucket || bucket.year !== now.getFullYear() || bucket.month !== now.getMonth()) return null;
  const days = new Date(bucket.year, bucket.month + 1, 0).getDate();
  const elapsed = now.getDate();
  if (elapsed >= days) return null;
  return {
    elapsed,
    days,
    spendMinor: Math.round((bucket.spendMinor / elapsed) * days),
    flexibleMinor: Math.round((bucket.flexibleMinor / elapsed) * days),
  };
}

/**
 * Per-category change between two months, biggest mover first.
 *
 * Absolute change leads rather than percentage: a category that went from 100
 * to 300 is up 200%, and irrelevant next to one that went from 8,000 to 10,000.
 */
export function categoryDelta(rows, current, previous) {
  const totals = (bucket) => {
    const map = new Map();
    if (!bucket) return map;
    for (const r of rows) {
      // Imported rows are excluded here even though monthlySeries keeps them:
      // a bar may be drawn as reference, but a *comparison* against unreliable
      // history is exactly the false conclusion the provenance rule exists to
      // prevent. See the guard in views/overview.js, which also declines to
      // offer the comparison at all when the earlier month is imported.
      if (r.deleted || !isTracked(r) || !isSpend(r)) continue;
      const { y, m } = parts(r.occurred_at);
      if (y !== bucket.year || m !== bucket.month) continue;
      const key = isWrittenOffShare(r) ? 'On other people' : r.category || 'Uncategorised';
      map.set(key, (map.get(key) || 0) + r.amount_minor);
    }
    return map;
  };

  const now = totals(current);
  const before = totals(previous);
  const names = new Set([...now.keys(), ...before.keys()]);

  return [...names]
    .map((category) => {
      const nowMinor = now.get(category) || 0;
      const wasMinor = before.get(category) || 0;
      return {
        category,
        nowMinor,
        wasMinor,
        changeMinor: nowMinor - wasMinor,
        changePct: wasMinor ? Math.round(((nowMinor - wasMinor) / wasMinor) * 100) : null,
      };
    })
    .filter((d) => d.changeMinor !== 0)
    .sort((a, b) => Math.abs(b.changeMinor) - Math.abs(a.changeMinor));
}

/**
 * One category's tracked spend across the given month buckets, oldest first —
 * for a sparkline that answers whether a mover is a spike or the new normal.
 * Keyed the same way as `categoryDelta`, so "On other people" lines up.
 */
export function categorySeries(rows, category, months) {
  const idx = new Map(months.map((m, i) => [`${m.year}-${pad(m.month + 1)}`, i]));
  const out = new Array(months.length).fill(0);
  for (const r of rows) {
    if (r.deleted || !isTracked(r) || !isSpend(r)) continue;
    const key = isWrittenOffShare(r) ? 'On other people' : r.category || 'Uncategorised';
    if (key !== category) continue;
    const { y, m } = parts(r.occurred_at);
    const i = idx.get(`${y}-${pad(m + 1)}`);
    if (i !== undefined) out[i] += r.amount_minor;
  }
  return out;
}

/**
 * A savings target you have already proved you can hit.
 *
 * The floor of your tracked months, not the average: a target set at the mean
 * is one you miss half the time, and a target missed half the time stops being
 * a target. Needs two complete months before it will say anything at all.
 */
export function suggestedTarget(months, { now = new Date() } = {}) {
  const complete = months.filter(
    (m) =>
      !m.reference &&
      m.incomeMinor > 0 &&
      !(m.year === now.getFullYear() && m.month === now.getMonth())
  );
  if (complete.length < 2) return null;

  const leftovers = complete.map((m) => m.incomeMinor - m.spendMinor);
  return {
    months: complete.length,
    minMinor: Math.min(...leftovers),
    // The worst month you have had is what you can commit to every month.
    targetMinor: Math.max(0, Math.min(...leftovers)),
  };
}

/**
 * Progress towards a named goal, and when it arrives at the current rate.
 *
 * @param goal `{ name, targetMinor, byIso }`
 */
export function goalProgress(goal, months, { now = new Date(), potMinor = null } = {}) {
  if (!goal?.targetMinor) return null;

  const tracked = months.filter((m) => !m.reference);
  // The pot when it is known, because that is the balance the user watches.
  const savedMinor =
    potMinor === null ? tracked.reduce((a, m) => a + m.savedMinor, 0) : potMinor;
  const remainingMinor = Math.max(0, goal.targetMinor - savedMinor);

  // Rate from complete months only — a month three days old would flatter it.
  const complete = tracked.filter(
    (m) => !(m.year === now.getFullYear() && m.month === now.getMonth())
  );
  const perMonth = complete.length
    ? complete.reduce((a, m) => a + m.savedMinor, 0) / complete.length
    : 0;

  const monthsLeft = remainingMinor === 0 ? 0 : perMonth > 0 ? remainingMinor / perMonth : null;
  const arrivesAt =
    monthsLeft === null
      ? null
      : new Date(now.getFullYear(), now.getMonth() + Math.ceil(monthsLeft), 1);

  const dueAt = goal.byIso ? new Date(goal.byIso) : null;

  return {
    name: goal.name,
    targetMinor: goal.targetMinor,
    savedMinor,
    remainingMinor,
    pct: Math.min(100, Math.round((savedMinor / goal.targetMinor) * 100)),
    perMonthMinor: Math.round(perMonth),
    monthsLeft,
    arrivesAt: arrivesAt ? arrivesAt.toISOString() : null,
    dueAt: dueAt ? dueAt.toISOString() : null,
    // Only meaningful once both dates exist; otherwise the goal is open-ended.
    onTrack: dueAt && arrivesAt ? arrivesAt <= dueAt : null,
    daysLeft: dueAt ? Math.ceil((dueAt - now) / DAY_MS) : null,
  };
}
