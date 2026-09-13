/* A balance move is one ledger row, never a matching debit and credit. That
 * makes saving, deleting, undoing and syncing atomic while fundingSummary can
 * still move the amount between the two pots. */

export const FUNDING_TRANSFER = 'funding_transfer';

export function isFundingTransfer(row) {
  return row?.source === FUNDING_TRANSFER;
}

export function transferDestination(from) {
  return from === 'other' ? 'essential' : 'other';
}

export function transferLabel(from) {
  return from === 'other' ? 'Other bank → Essential' : 'Essential → Other bank';
}

export function makeFundingTransfer({ from = 'other', amountMinor, occurredAt = new Date().toISOString() }) {
  const funding_source = from === 'essential' ? 'essential' : 'other';
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Enter an amount above zero.');
  return {
    raw_name: funding_source === 'other' ? 'Move to Essential' : 'Move to Other bank',
    amount_minor: amountMinor,
    direction: 'out',
    category: 'Transfers & Loans',
    occurred_at: occurredAt,
    source: FUNDING_TRANSFER,
    funding_source,
    enriched: 1,
    enriched_at: occurredAt,
  };
}
