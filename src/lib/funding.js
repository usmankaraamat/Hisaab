/* Balances for the two pots a person actually uses day-to-day.
 *
 * A funding snapshot is a counted truth at one instant.  Transactions strictly
 * later than that instant are then folded into the selected pot.  We use `>`
 * rather than `>=`: a transaction timestamped at exactly `at` is already part
 * of the count used to make the snapshot.
 */

import { isFundingTransfer } from './transfers.js';

const REFERENCE = new Set(['bluecoins']);

export const ESSENTIAL = 'essential';
export const OTHER = 'other';

export function fundingSource(row) {
  return row?.funding_source === OTHER ? OTHER : ESSENTIAL;
}

export function isFundingSnapshot(value) {
  const at = typeof value?.at === 'string' ? new Date(value.at).getTime() : NaN;
  return Boolean(
    value &&
    Number.isSafeInteger(value.essentialMinor) &&
    Number.isSafeInteger(value.otherMinor) &&
    Number.isFinite(at)
  );
}

/**
 * Fold actual wallet movements after a funding snapshot.
 * Imported Bluecoins rows are reference data, deleted and future rows are not
 * real current movements, and a borrowed purchase never left the user's cash.
 */
export function fundingSummary(rows, opening, now = new Date()) {
  if (!isFundingSnapshot(opening)) return null;

  const at = new Date(opening.at).getTime();
  const until = new Date(now).getTime();
  let essentialMinor = Math.trunc(Number(opening.essentialMinor));
  let otherMinor = Math.trunc(Number(opening.otherMinor));

  for (const row of rows || []) {
    if (!row || row.deleted || REFERENCE.has(row.source)) continue;
    const occurredAt = new Date(row.occurred_at).getTime();
    if (!Number.isFinite(occurredAt) || occurredAt <= at || occurredAt > until) continue;
    if (row.direction === 'out' && row.ledger_effect === 'borrowed') continue;

    const amount = Math.abs(Math.trunc(Number(row.amount_minor) || 0));
    if (isFundingTransfer(row)) {
      if (fundingSource(row) === OTHER) {
        otherMinor -= amount;
        essentialMinor += amount;
      } else {
        essentialMinor -= amount;
        otherMinor += amount;
      }
      continue;
    }
    const delta = row.direction === 'in' ? amount : -amount;
    if (fundingSource(row) === OTHER) otherMinor += delta;
    else essentialMinor += delta;
  }

  return {
    at: new Date(at).toISOString(),
    essentialMinor,
    otherMinor,
    totalMinor: essentialMinor + otherMinor,
  };
}
