/* What is actually left, and what is safe to spend today.
 *
 * The reason this is not one number: in the live data, 83,300 of 121,676 rupees
 * "spent" was an investment, a remittance and a loan. A balance that treats
 * those as consumption is wrong on day one, and a number you have caught lying
 * once is a number you stop reading. So four are computed and each says a
 * different true thing:
 *
 *   cash        everything that left or entered the wallet. The honest total.
 *   spend       consumption only — savings, transfers and money lent out and
 *               still owed are all excluded. Savings is netted, so redeeming
 *               some of it reopens the gap to the target rather than being
 *               quietly ignored.
 *   committed   recurring charges already known to be due before the next
 *               income. Spoken for, even though it has not left yet.
 *   safe        cash − committed − the savings target not yet met.
 *
 * `safe / daysLeft` is the one figure that belongs under the capture input,
 * because it is the only one that can change a decision at the moment of
 * spending.
 *
 * Savings is deducted before the allowance, not left over after it. That
 * inversion is the whole point: the app exists because saving what is left at
 * the end of the month does not work.
 *
 * Pure functions over rows, so they run offline and are checked in verify.mjs.
 */

import { subscriptions } from './insights.js';
import { balances, ledgerTotals } from './ledger.js';
import { personKey } from '../capture/split.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/* Money out that was not consumed. Kept out of `spend` so the burn rate means
 * what it looks like it means. See CATEGORIES in the enrichment prompt. */
export const NON_SPEND = new Set(['Savings', 'Transfers & Loans']);

/* A cash-count correction, not consumption. When the tracked balance drifts
 * from the notes in your pocket, reconciling writes a single row of this
 * category for the difference — so `cash` matches what you actually hold — and
 * that row is deliberately absent from `spend` and the breakdown, because a
 * correction is not a thing you bought. */
export const RECONCILE = 'Reconcile';

/* Deleted rows are gone; imported rows are reference only.
 *
 * The Bluecoins export covers a period lived with flatmates covering each
 * other's expenses, with real gaps in the logging. Those totals cannot be
 * compared with anything tracked here, so nothing on the Spending screen, the
 * Ledger or the allowance may touch them. Overview shows them, greyed, because
 * seeing them is the one thing they are good for. */
const REFERENCE = new Set(['bluecoins']);
const live = (rows) => rows.filter((r) => !r.deleted && !REFERENCE.has(r.source));

/** Money out you expect back: lent, not yet written off, not yet repaid. */
export function isOutstandingLoan(row) {
  return row.direction === 'out' && row.ledger_effect === 'lent' && !row.ledger_settled;
}

/**
 * Money that left your wallet to buy something for someone else.
 *
 * This is the line between "what do I spend on myself" and "what do I spend on
 * other people", and it has to be drawn on the counterparty rather than on the
 * ledger effect. A treat that was written off as a gift still was not groceries
 * for you, and neither was a farewell present the model tagged with a person but
 * no debt. Filing either under Groceries or Shopping buries the habit you are
 * actually trying to see — in the live data it is 23% of the breakdown, spread
 * across six categories.
 *
 * Two exclusions. `borrowed` is something they bought for you: your money never
 * moved. `repaid_to` settles a debt rather than buying anything, so counting it
 * would charge you twice for the same thing — once when it was bought, once when
 * you paid them back.
 */
export function isSharedSpend(row) {
  return (
    row.direction === 'out' &&
    Boolean(row.counterparty_name) &&
    row.ledger_effect !== 'borrowed' &&
    row.ledger_effect !== 'repaid_to'
  );
}

/* The single heading everything spent on other people lands under, once it is
 * clear it is not coming back. */
export const ON_OTHERS = 'On other people';

/**
 * Money spent on someone else that you are never getting back: written off in
 * the ledger, or tagged with a person but never recorded as a debt.
 *
 * The split between this and `isOutstandingLoan` is the whole shape of the app
 * now. Anything still owed — in either direction — is the Ledger's business and
 * appears nowhere in Spending; it is an asset, not an expense. Anything written
 * off has stopped being a balance and become an expense, so it appears here and
 * nowhere else.
 *
 * The earlier design tried to show both on both screens, netted differently on
 * each, and the two figures disagreed by whatever the person had bought *for*
 * you. One number, one home, is worth more than two views of it.
 */
export function isWrittenOffShare(row) {
  return isSharedSpend(row) && !isOutstandingLoan(row);
}

/**
 * Consumption, for the breakdown and everything that has to agree with it: out,
 * not saved or transferred, not something someone else paid for, not still owed,
 * and not a reconciliation correction. One predicate shared by the Spending
 * screen, the home tiles and the burn-down, so those three can never disagree.
 */
export function countsAsSpend(row) {
  return (
    row.direction === 'out' &&
    !NON_SPEND.has(row.category) &&
    row.ledger_effect !== 'borrowed' &&
    !isOutstandingLoan(row) &&
    row.category !== RECONCILE
  );
}

/**
 * When the money last arrived, and when it is next expected.
 *
 * Anchoring to income rather than the calendar is deliberate: a salary landing
 * on the 3rd makes "this month" the wrong window, and every allowance computed
 * from it wrong for the first three days.
 */
export function incomePeriod(rows, now = new Date()) {
  const at = now.getTime();
  const incomes = live(rows)
    .filter((r) => r.direction === 'in' && r.category === 'Income')
    .map((r) => new Date(r.occurred_at).getTime())
    .filter((t) => t <= at)
    .sort((a, b) => a - b);

  if (!incomes.length) return { lastIncomeAt: null, nextIncomeAt: null, everyDays: null };

  const last = incomes.at(-1);

  // Two or more payments give a real cycle. One gives a monthly assumption,
  // which is right for a salary and harmless for anything else.
  let everyDays = 30;
  if (incomes.length >= 2) {
    const gaps = [];
    for (let i = 1; i < incomes.length; i++) gaps.push(Math.round((incomes[i] - incomes[i - 1]) / DAY_MS));
    gaps.sort((a, b) => a - b);
    const mid = gaps[Math.floor(gaps.length / 2)];
    if (mid >= 6) everyDays = mid;
  }

  // Same day next month beats "+30 days", which drifts a salary date backwards.
  let next = new Date(last);
  if (everyDays >= 26 && everyDays <= 35) next.setMonth(next.getMonth() + 1);
  else next = new Date(last + everyDays * DAY_MS);

  return { lastIncomeAt: new Date(last).toISOString(), nextIncomeAt: next.toISOString(), everyDays };
}

/**
 * The spending period, hardcoded to the calendar month rather than the last
 * income entry.
 *
 * Anchoring to the income entry was the cause of a real bug: reconciling
 * mid-month re-stamped the start of the period, which dropped the salary out of
 * it and left the balance reading negative. Salary lands on the 1st, so the
 * month is the right window regardless. The period runs from the first weekday
 * of the month to the first weekday of the next — the 1st, unless it falls on a
 * weekend, in which case the following Monday, because a payment dated the 1st
 * only clears once the bank reopens.
 */
function firstWeekdayOfMonth(year, month) {
  const d = new Date(year, month, 1);
  const dow = d.getDay(); // 0 Sun … 6 Sat
  if (dow === 0) d.setDate(2); // Sunday   -> Monday the 2nd
  else if (dow === 6) d.setDate(3); // Saturday -> Monday the 3rd
  return d;
}

export function calendarPeriod(now = new Date()) {
  let start = firstWeekdayOfMonth(now.getFullYear(), now.getMonth());
  // Early in a month whose 1st is a weekend, `now` can precede this month's
  // start weekday — the period you are actually in began last month.
  if (now.getTime() < start.getTime()) {
    start = firstWeekdayOfMonth(now.getFullYear(), now.getMonth() - 1);
  }
  const end = firstWeekdayOfMonth(start.getFullYear(), start.getMonth() + 1);
  return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

/**
 * @param rows      every local transaction
 * @param opening   `{ amountMinor, at }` — what the wallet held at that instant.
 *                  Overrides the income anchor when it is the later of the two,
 *                  so a correction made today is not undone by last month's pay.
 */
export function budgetSummary(
  rows,
  { opening = null, savingsTargetMinor = 0, now = new Date() } = {}
) {
  const all = live(rows);
  const period = calendarPeriod(now);
  const periodStartMs = new Date(period.periodStart).getTime();
  const periodEndMs = new Date(period.periodEnd).getTime();

  const openingAt = opening?.at ? new Date(opening.at).getTime() : null;
  const hasIncome = all.some((r) => r.direction === 'in' && r.category === 'Income');

  let sinceMs;
  let baseMinor;
  let anchoredTo;
  if (openingAt !== null && openingAt >= periodStartMs) {
    // A cash count or opening balance stated inside the period is the most
    // recent thing you know for certain, so it wins over the month anchor.
    sinceMs = openingAt;
    baseMinor = opening.amountMinor;
    anchoredTo = 'opening';
  } else if (hasIncome || openingAt !== null) {
    sinceMs = periodStartMs;
    baseMinor = 0;
    anchoredTo = 'calendar';
  } else {
    // Nothing to count forward from yet — no income logged and no balance set.
    sinceMs = periodStartMs;
    baseMinor = 0;
    anchoredTo = 'none';
  }

  const inPeriod = all.filter((r) => new Date(r.occurred_at).getTime() >= sinceMs);

  let inMinor = 0;
  let outMinor = 0;
  let incomeMinor = 0;
  let personalMinor = 0;
  let onOthersMinor = 0;
  let savedMinor = 0;
  let transferMinor = 0;
  let lentOutMinor = 0;
  let fundedByOthersMinor = 0;

  for (const r of inPeriod) {
    if (r.direction === 'in') {
      inMinor += r.amount_minor;

      /* Savings is the one category where money comes back out. Counting only
       * the deposits reported 50,000 saved after 10,000 had been redeemed —
       * a figure that can only ever grow, which makes a target meaningless.
       * It is not income either: taking your own money back does not make the
       * month richer, it undoes a decision made earlier in it. */
      if (r.category === 'Savings') {
        savedMinor -= r.amount_minor;
        continue;
      }

      // A reconciliation credit is a correction to what the wallet held, not
      // money earned — it belongs in cash but not in income.
      if (r.category === RECONCILE) continue;

      // A repayment is money returning, not money earned. Counting it as income
      // would make a month look richer every time a friend settled up.
      if (!r.ledger_effect) incomeMinor += r.amount_minor;
      continue;
    }

    // "chicken piece from Harry 500" — Harry paid. Nothing left the wallet, so
    // it reduces neither cash nor spend; it raises a debt instead. When the
    // repayment is logged it is an ordinary outgoing, and that is what costs.
    if (r.ledger_effect === 'borrowed') {
      fundedByOthersMinor += r.amount_minor;
      continue;
    }

    outMinor += r.amount_minor;
    if (r.category === 'Savings') savedMinor += r.amount_minor;
    else if (r.category === 'Transfers & Loans') transferMinor += r.amount_minor;
    // A reconciliation charge reduces cash to what you counted, but it is a
    // correction rather than something consumed, so it enters no spend bucket.
    else if (r.category === RECONCILE) continue;
    // Still owed: an asset, not an expense. It belongs to the Ledger and is
    // deliberately absent from every figure on the Spending screen.
    else if (isOutstandingLoan(r)) lentOutMinor += r.amount_minor;
    else if (isSharedSpend(r)) onOthersMinor += r.amount_minor;
    else personalMinor += r.amount_minor;
  }

  const cashMinor = baseMinor + inMinor - outMinor;

  const nextIncomeMs = periodEndMs;
  const daysLeft = Math.max(1, Math.ceil((nextIncomeMs - now.getTime()) / DAY_MS));

  // Recurring charges already due inside this period. `subscriptions` reads the
  // whole history on purpose — a cycle cannot be detected from one period.
  const horizon = nextIncomeMs ?? now.getTime() + 30 * DAY_MS;
  const committed = subscriptions(all, { now })
    .filter((s) => !s.lapsed)
    .filter((s) => {
      const due = new Date(s.nextDue).getTime();
      return due > now.getTime() && due <= horizon;
    });
  const committedMinor = committed.reduce((a, s) => a + s.lastMinor, 0);

  /* Debts, netted per person and read from the whole history.
   *
   * Two bugs lived in the period-scoped sums this replaces. They ignored
   * repayments entirely, so a friend who had paid you back in full still
   * appeared under "owed back to you" at the full amount. And they reported
   * each direction gross, so a sister you had lent 6,570, borrowed 550 from and
   * been repaid 1,400 by appeared on *both* lines at once instead of on one at
   * 4,620 — which is not two facts about your money, it is one fact stated
   * confusingly.
   *
   * `balances` is the same function the Ledger tab renders, so the two screens
   * can no longer disagree. All-time rather than in-period on purpose: a debt
   * does not lapse because a salary landed. */
  const book = balances(all);
  const owed = ledgerTotals(book);


  const savingsRemainingMinor = Math.max(0, savingsTargetMinor - savedMinor);
  // Money owed to other people is as spoken for as a bill that has not arrived
  // yet. Money owed *to* you is not added back — it may never come, and a
  // spending limit should never be inflated by an optimistic assumption.
  const safeToSpendMinor =
    cashMinor - committedMinor - savingsRemainingMinor - owed.iOweMinor;

  return {
    since: new Date(sinceMs).toISOString(),
    anchoredTo,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    // Kept under the old name so the Spending card's "next expected" line and
    // anything else reading it need no change: the period end is the next time
    // money is expected to land.
    nextIncomeAt: period.periodEnd,
    daysLeft,

    baseMinor,
    inMinor,
    outMinor,
    cashMinor,

    incomeMinor,
    // What the period actually cost: your own consumption plus whatever you
    // spent on other people and are not getting back.
    spendMinor: personalMinor + onOthersMinor,
    personalMinor,
    onOthersMinor,
    savedMinor,
    transferMinor,
    // Gross outflow on other people's behalf this period — an answer to "where
    // did the money go", which is a different question from what is still owed.
    // Outstanding, and therefore not spending. Reported so the Spending screen
    // can point at the Ledger rather than quietly omitting the money.
    lentOutMinor,
    fundedByOthersMinor,
    // Net per person, all time. What is actually outstanding.
    owedToMeMinor: owed.owedToMeMinor,
    iOweMinor: owed.iOweMinor,
    people: book,

    committed,
    committedMinor,
    savingsTargetMinor,
    savingsRemainingMinor,
    safeToSpendMinor,
    // Rounded to the rupee: a daily allowance quoted to the paisa is false
    // precision, and it changes every time the page repaints.
    dailyMinor: daysLeft ? Math.floor(safeToSpendMinor / daysLeft / 100) * 100 : null,
  };
}

/**
 * Consumption per category over a window, biggest first.
 *
 * Uncategorised rows are reported under their own heading rather than dropped —
 * a breakdown that silently omits rows the model has not reached yet does not
 * add up to what the History tab shows, and that is worse than an ugly bucket.
 *
 * Everything spent on other people collapses into one `On other people` row
 * rather than being spread through Groceries, Health and Shopping, where it
 * buried the habit worth seeing — a quarter of the live breakdown across six
 * categories. Only what is written off appears at all: money still owed is an
 * asset the Ledger tracks, not an expense this screen should be counting.
 *
 * Totals here reconcile exactly with `spendMinor`.
 */
export function categoryTotals(rows, { from = null, to = null, includeNonSpend = false } = {}) {
  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs = to ? new Date(to).getTime() : Infinity;
  const totals = new Map();

  for (const r of live(rows)) {
    if (r.direction !== 'out') continue;
    // A reconciliation charge is a correction, never a purchase — it stays out
    // of the breakdown whatever else is included, so the bars keep meaning
    // "what you bought".
    if (r.category === RECONCILE) continue;
    if (!includeNonSpend) {
      if (NON_SPEND.has(r.category)) continue;
      if (r.ledger_effect === 'borrowed') continue;
      if (isOutstandingLoan(r)) continue;
    }
    const at = new Date(r.occurred_at).getTime();
    if (at < fromMs || at > toMs) continue;

    const key = isWrittenOffShare(r) ? ON_OTHERS : r.category || 'Uncategorised';
    const t = totals.get(key) || { category: key, totalMinor: 0, count: 0 };
    t.totalMinor += r.amount_minor;
    t.count++;
    totals.set(key, t);
  }

  return [...totals.values()].sort((a, b) => b.totalMinor - a.totalMinor);
}

/**
 * The burn-down: cumulative spend across the days of a period, against an even
 * "ideal" burn of the whole spendable envelope. It answers a question the daily
 * allowance only lets you infer — am I ahead of pace or behind?
 *
 * Pure over rows and dates. Cumulative is indexed by day from the period start
 * so both lines can be drawn against one day-based x-axis.
 *
 * @param budgetMinor  the period's spendable envelope — what has been spent so
 *                     far plus what is still safe to spend. The ideal line runs
 *                     from 0 at the start to this at the end.
 */
export function spendPace(rows, { start, end, now = new Date(), budgetMinor = 0 } = {}) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const nowMs = Math.min(now.getTime(), endMs);
  const totalDays = Math.max(1, Math.round((endMs - startMs) / DAY_MS));
  const elapsed = Math.max(0, Math.min(totalDays, Math.ceil((nowMs - startMs) / DAY_MS)));

  const perDay = new Array(totalDays + 1).fill(0);
  for (const r of live(rows)) {
    if (!countsAsSpend(r)) continue;
    const t = new Date(r.occurred_at).getTime();
    if (t < startMs || t >= endMs) continue;
    const day = Math.floor((t - startMs) / DAY_MS);
    if (day >= 0 && day <= totalDays) perDay[day] += r.amount_minor;
  }

  const cumulative = [0];
  let run = 0;
  for (let d = 0; d < elapsed; d++) {
    run += perDay[d];
    cumulative.push(run);
  }

  const idealAtNowMinor = Math.round((budgetMinor * elapsed) / totalDays);
  return {
    totalDays,
    elapsed,
    cumulative,
    spentMinor: run,
    budgetMinor,
    idealAtNowMinor,
    // Positive means spending faster than an even burn would — ahead of pace.
    overMinor: run - idealAtNowMinor,
  };
}
