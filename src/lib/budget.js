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

const live = (rows) => rows.filter((r) => !r.deleted);

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
  const period = incomePeriod(all, now);

  const openingAt = opening?.at ? new Date(opening.at).getTime() : null;
  const incomeAt = period.lastIncomeAt ? new Date(period.lastIncomeAt).getTime() : null;

  let sinceMs;
  let baseMinor;
  if (openingAt !== null && (incomeAt === null || openingAt >= incomeAt)) {
    sinceMs = openingAt;
    baseMinor = opening.amountMinor;
  } else if (incomeAt !== null) {
    sinceMs = incomeAt;
    baseMinor = 0;
  } else {
    sinceMs = -Infinity;
    baseMinor = opening?.amountMinor ?? 0;
  }

  const inPeriod = all.filter((r) => new Date(r.occurred_at).getTime() >= sinceMs);

  let inMinor = 0;
  let outMinor = 0;
  let incomeMinor = 0;
  let spendMinor = 0;
  let savedMinor = 0;
  let transferMinor = 0;
  let lentOutMinor = 0;
  let giftedMinor = 0;
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
    else if (isSharedSpend(r)) {
      // The netted total comes from peopleSpend below; this only separates the
      // part that can still come back from the part that never will.
      if (isOutstandingLoan(r)) lentOutMinor += r.amount_minor;
      else giftedMinor += r.amount_minor;
    } else spendMinor += r.amount_minor;
  }

  const cashMinor = baseMinor + inMinor - outMinor;

  const nextIncomeMs = period.nextIncomeAt ? new Date(period.nextIncomeAt).getTime() : null;
  const daysLeft =
    nextIncomeMs === null ? null : Math.max(1, Math.ceil((nextIncomeMs - now.getTime()) / DAY_MS));

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

  // Netted per person: 1,500 spent on a sister who handed 500 back cost 1,000.
  const shared = peopleSpend(all, { from: sinceMs === -Infinity ? null : new Date(sinceMs) });
  const sharedMinor = shared.reduce((a, p) => a + p.totalMinor, 0);

  const savingsRemainingMinor = Math.max(0, savingsTargetMinor - savedMinor);
  // Money owed to other people is as spoken for as a bill that has not arrived
  // yet. Money owed *to* you is not added back — it may never come, and a
  // spending limit should never be inflated by an optimistic assumption.
  const safeToSpendMinor =
    cashMinor - committedMinor - savingsRemainingMinor - owed.iOweMinor;

  return {
    since: sinceMs === -Infinity ? null : new Date(sinceMs).toISOString(),
    anchoredTo: sinceMs === openingAt ? 'opening' : incomeAt !== null ? 'income' : 'none',
    ...period,
    daysLeft,

    baseMinor,
    inMinor,
    outMinor,
    cashMinor,

    incomeMinor,
    spendMinor,
    savedMinor,
    transferMinor,
    // Gross outflow on other people's behalf this period — an answer to "where
    // did the money go", which is a different question from what is still owed.
    lentOutMinor,
    giftedMinor,
    sharedMinor,
    shared,
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
 * Totals here reconcile with `spendMinor` above, which is why the same
 * exclusions apply: savings and transfers were not consumed, anything bought for
 * someone else belongs on its own list rather than inside your categories, and a
 * purchase someone else paid for never left your wallet at all.
 *
 * `scope: 'shared'` inverts the person test to get the other half.
 */
export function categoryTotals(
  rows,
  { from = null, to = null, includeNonSpend = false, scope = 'personal' } = {}
) {
  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs = to ? new Date(to).getTime() : Infinity;
  const totals = new Map();

  for (const r of live(rows)) {
    if (r.direction !== 'out') continue;
    if (!includeNonSpend && NON_SPEND.has(r.category)) continue;
    if (!includeNonSpend && r.ledger_effect === 'borrowed') continue;
    if (scope !== 'all' && isSharedSpend(r) !== (scope === 'shared')) continue;
    const at = new Date(r.occurred_at).getTime();
    if (at < fromMs || at > toMs) continue;

    const key = r.category || 'Uncategorised';
    const t = totals.get(key) || { category: key, totalMinor: 0, count: 0 };
    t.totalMinor += r.amount_minor;
    t.count++;
    totals.set(key, t);
  }

  return [...totals.values()].sort((a, b) => b.totalMinor - a.totalMinor);
}

/**
 * What each person actually cost you over a window, biggest first.
 *
 * Net of what they handed back: spending 1,500 on a sister who reimburses 500
 * cost 1,000, and reporting 1,500 would overstate the outflow every time a
 * shared expense worked as intended. That netting is the whole point of the
 * card — it shows where money is genuinely leaving rather than circulating.
 *
 * Still not the same number as their ledger balance, and deliberately so. This
 * is bounded by the period and counts only money that moved out of your wallet;
 * a balance carries over from before and also counts what they bought for you.
 * Both are true, and the card says which one it is showing.
 */
export function peopleSpend(rows, { from = null, to = null } = {}) {
  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs = to ? new Date(to).getTime() : Infinity;
  const people = new Map();

  const entry = (name) => {
    const key = personKey(name);
    if (!key) return null;
    if (!people.has(key)) {
      people.set(key, {
        key,
        name: String(name).trim(),
        totalMinor: 0,
        spentMinor: 0,
        repaidMinor: 0,
        owedMinor: 0,
        count: 0,
      });
    }
    return people.get(key);
  };

  for (const r of live(rows)) {
    const at = new Date(r.occurred_at).getTime();
    if (at < fromMs || at > toMs) continue;

    if (isSharedSpend(r)) {
      const p = entry(r.counterparty_name);
      if (!p) continue;
      p.spentMinor += r.amount_minor;
      if (isOutstandingLoan(r)) p.owedMinor += r.amount_minor;
      p.count++;
      continue;
    }

    // Money they handed back. Subtracted rather than listed, because what the
    // user asked of this card is the cost, not the gross traffic.
    if (r.direction === 'in' && r.ledger_effect === 'repaid_by' && r.counterparty_name) {
      const p = entry(r.counterparty_name);
      if (p) p.repaidMinor += r.amount_minor;
    }
  }

  for (const p of people.values()) {
    /* Floored at zero. Somebody can repay more than they cost you this period —
     * they are settling something bought before it started — and "Sister −500"
     * under the heading "spent on other people" is not an amount that went into
     * anyone's expenses. The surplus is already visible where it belongs, in
     * cash and on the Ledger. */
    p.totalMinor = Math.max(0, p.spentMinor - p.repaidMinor);
    // What is still recoverable, after what has already come back. The Ledger is
    // the authority on the balance; this is the in-period view of it.
    p.owedMinor = Math.max(0, p.owedMinor - p.repaidMinor);
  }

  // Someone who only paid you back this period is not a spending row at all.
  return [...people.values()]
    .filter((p) => p.spentMinor > 0)
    .sort((a, b) => b.totalMinor - a.totalMinor || a.name.localeCompare(b.name));
}
