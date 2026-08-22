/* Per-person balances, derived from ledger effects on ordinary transactions.
 *
 * There is no separate debts table. A debt is just a transaction that names a
 * counterparty and says what it did to the balance, which means the ledger can
 * never disagree with the spending history — they are the same rows read two
 * ways.
 *
 * Sign convention: positive means they owe me.
 *
 *   lent       I paid, on their behalf            +  (their share of a split)
 *   repaid_by  they paid me back                  -
 *   borrowed   they paid, I owe them              -
 *   repaid_to  I paid them back                   +
 *
 * `ledger_settled` exists because not every "for someone" entry is a real debt.
 * Buying a sibling lunch is often a gift, and the app cannot tell — so instead
 * of guessing, it tracks the balance and offers one tap to call it square.
 */

import { personKey } from '../capture/split.js';

const SIGN = { lent: 1, repaid_to: 1, repaid_by: -1, borrowed: -1 };

/** Does this row move a balance? */
export function isLedgerRow(row) {
  return Boolean(
    !row.deleted &&
      // Imported history is reference only. It predates this app's shared-expense
      // handling entirely, so its counterparties would open balances that were
      // settled in cash years ago.
      row.source !== 'bluecoins' &&
      row.ledger_effect &&
      SIGN[row.ledger_effect] &&
      counterpartyOf(row)
  );
}

/** The display name for a row's counterparty, whether set at capture or by enrichment. */
export function counterpartyOf(row) {
  const name = row.counterparty_name;
  return name ? String(name).trim() : null;
}

/**
 * Fold transactions into one entry per person, largest outstanding first.
 *
 * @returns {Array<{key, name, netMinor, owedToMeMinor, iOweMinor, openCount,
 *                  settledCount, rows}>}
 */
export function balances(transactions) {
  const people = new Map();

  for (const row of transactions) {
    if (!isLedgerRow(row)) continue;
    const name = counterpartyOf(row);
    const key = personKey(name);
    if (!key) continue;

    if (!people.has(key)) {
      people.set(key, {
        key,
        name,
        netMinor: 0,
        owedToMeMinor: 0,
        iOweMinor: 0,
        openCount: 0,
        settledCount: 0,
        rows: [],
      });
    }
    const person = people.get(key);
    person.rows.push(row);

    if (row.ledger_settled) {
      person.settledCount++;
      continue;
    }

    const delta = SIGN[row.ledger_effect] * row.amount_minor;
    person.netMinor += delta;
    if (delta > 0) person.owedToMeMinor += delta;
    else person.iOweMinor -= delta;
    person.openCount++;
  }

  for (const person of people.values()) {
    person.rows.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
  }

  return [...people.values()].sort(
    (a, b) => Math.abs(b.netMinor) - Math.abs(a.netMinor) || a.name.localeCompare(b.name)
  );
}

/** Totals across everyone, for the header line. */
export function ledgerTotals(list) {
  return list.reduce(
    (acc, p) => {
      if (p.netMinor > 0) acc.owedToMeMinor += p.netMinor;
      else acc.iOweMinor -= p.netMinor;
      return acc;
    },
    { owedToMeMinor: 0, iOweMinor: 0 }
  );
}
