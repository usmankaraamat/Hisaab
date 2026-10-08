/* The monthly plan, and how fast it is being spent.
 *
 * The allowance under the input answers "what is safe today". It cannot answer
 * the question that matters three days after a salary lands: is this month
 * going at a speed it can survive? A remittance and a few subscriptions are
 * most of the money and leave on their own schedule, so a burn rate that
 * counts them reads as a disaster on the day they go out and as fine every day
 * after. They are planned for up front instead and kept out of the rate.
 *
 *   plan      income − fixed − buffer. What day-to-day spending may use.
 *   buffer    held back from the plan, so a bad week has somewhere to land
 *             before it becomes a bad month.
 *   pace      where spending should be by the end of today on an even burn.
 *
 * "Days used" is the headline because it is the one figure that reads the same
 * on day 3 and day 25: spending 13 days of plan in 3 days says exactly how far
 * ahead you are, where a rupee gap means nothing without the daily figure next
 * to it.
 *
 * Pure functions over rows, checked in scripts/verify.mjs.
 */

import { countsAsSpend } from './budget.js';
import { isFundingTransfer } from './transfers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const REFERENCE = new Set(['bluecoins']);

/** A stored plan with every field checked, or null when nothing usable is set. */
export function normalisePlan(value) {
  if (!value || typeof value !== 'object') return null;
  const incomeMinor = Math.trunc(Number(value.incomeMinor) || 0);
  if (incomeMinor <= 0) return null;
  const payday = Math.min(31, Math.max(1, Math.trunc(Number(value.payday) || 1)));
  const bufferMinor = Math.max(0, Math.trunc(Number(value.bufferMinor) || 0));
  const fixed = (Array.isArray(value.fixed) ? value.fixed : [])
    .filter((f) => f && String(f.name || '').trim() && Number(f.amountMinor) > 0)
    .map((f) => ({ id: f.id, name: String(f.name).trim(), amountMinor: Math.trunc(Number(f.amountMinor)) }));
  return { incomeMinor, payday, bufferMinor, fixed };
}

/** The day the plan is anchored to, clamped so a 31st payday still lands in February. */
function paydayIn(year, month, payday) {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(payday, last));
}

/** The pay period `now` falls in: from the last payday to the next, local midnight. */
export function planPeriod(now = new Date(), payday = 1) {
  let start = paydayIn(now.getFullYear(), now.getMonth(), payday);
  if (now.getTime() < start.getTime()) start = paydayIn(now.getFullYear(), now.getMonth() - 1, payday);
  const end = paydayIn(start.getFullYear(), start.getMonth() + 1, payday);
  return { start, end };
}

const words = (text) => ` ${String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `;

/** The phrases one fixed expense answers to: its name, or each comma-separated alternative. */
export function fixedTerms(item) {
  return String(item?.name || '')
    .split(',')
    .map((t) => words(t).trim())
    .filter(Boolean);
}

/** The fixed expense a row pays, matched as whole words on what was typed or its cleaned-up name. */
export function matchFixed(row, fixed) {
  const text = `${words(row.raw_name)}${words(row.display_name)}`;
  return (fixed || []).find((f) => fixedTerms(f).some((t) => text.includes(` ${t} `))) || null;
}

/**
 * How the period is going against the plan.
 *
 * @param rows  every local transaction
 * @param plan  `{ incomeMinor, payday, bufferMinor, fixed: [{ id, name, amountMinor }] }`
 * @returns null when no usable plan is set
 */
export function planPace(rows, plan, now = new Date()) {
  const p = normalisePlan(plan);
  if (!p) return null;

  const fixedMinor = p.fixed.reduce((a, f) => a + f.amountMinor, 0);
  const budgetMinor = p.incomeMinor - fixedMinor - p.bufferMinor;
  const { start, end } = planPeriod(now, p.payday);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const nowMs = now.getTime();

  // Calendar days, not 24-hour blocks: a period that crosses a clock change is
  // still the number of days on the calendar.
  const totalDays = Math.max(1, Math.round((endMs - startMs) / DAY_MS));
  // Today counts as a day already in use — on payday morning the plan for the
  // whole of today is already available to spend.
  const dayNumber = Math.min(totalDays, Math.max(1, Math.floor((nowMs - startMs) / DAY_MS) + 1));
  const daysLeft = totalDays - dayNumber + 1;

  let spentMinor = 0;
  const paid = new Map(p.fixed.map((f) => [f.id ?? f.name, 0]));
  for (const r of rows || []) {
    if (!r || r.deleted || REFERENCE.has(r.source) || r.direction !== 'out') continue;
    if (isFundingTransfer(r)) continue;
    const t = new Date(r.occurred_at).getTime();
    if (!(t >= startMs && t < endMs && t <= nowMs)) continue;
    const item = matchFixed(r, p.fixed);
    if (item) {
      // A fixed expense is paid whatever category it was filed under, so it is
      // counted here before the spend filter rather than after it.
      if (r.ledger_effect !== 'borrowed') paid.set(item.id ?? item.name, paid.get(item.id ?? item.name) + r.amount_minor);
      continue;
    }
    if (countsAsSpend(r)) spentMinor += r.amount_minor;
  }

  const fixedStatus = p.fixed.map((f) => {
    const paidMinor = paid.get(f.id ?? f.name) || 0;
    return { ...f, paidMinor, done: paidMinor >= f.amountMinor };
  });

  const result = {
    ...p,
    fixedMinor,
    budgetMinor,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    totalDays,
    dayNumber,
    daysLeft,
    spentMinor,
    fixed: fixedStatus,
    fixedPaidMinor: fixedStatus.reduce((a, f) => a + Math.min(f.paidMinor, f.amountMinor), 0),
  };
  if (budgetMinor <= 0) return { ...result, status: 'unfunded' };

  const perDayMinor = budgetMinor / totalDays;
  const paceMinor = Math.round(perDayMinor * dayNumber);
  const daysUsed = spentMinor / perDayMinor;
  const remainingMinor = budgetMinor - spentMinor;
  const rateMinor = spentMinor / dayNumber;

  // Run-out dates only exist when spending is quicker than the plan allows;
  // on or under pace the money lasts the period by construction.
  const runOutAt = (limitMinor) =>
    rateMinor > perDayMinor && limitMinor > spentMinor
      ? new Date(startMs + (limitMinor / rateMinor) * DAY_MS).toISOString()
      : null;

  let status;
  if (spentMinor > budgetMinor + p.bufferMinor) status = 'broke';
  else if (spentMinor > budgetMinor) status = 'buffer';
  // A day's grace, so one grocery run on day 1 does not read as an alarm.
  else if (daysUsed > dayNumber + 1) status = 'fast';
  else status = 'ok';

  return {
    ...result,
    status,
    paceMinor,
    aheadMinor: spentMinor - paceMinor,
    daysUsed,
    remainingMinor,
    // Rounded down to the rupee, like the allowance: a daily figure to the paisa
    // is false precision.
    leftPerDayMinor: remainingMinor > 0 ? Math.floor(remainingMinor / daysLeft / 100) * 100 : 0,
    bufferLeftMinor: Math.max(0, Math.min(p.bufferMinor, budgetMinor + p.bufferMinor - spentMinor)),
    runOutAt: runOutAt(budgetMinor),
    bufferRunOutAt: runOutAt(budgetMinor + p.bufferMinor),
  };
}
