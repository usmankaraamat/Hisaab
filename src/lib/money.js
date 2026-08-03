/* Money is stored as integer minor units (paisa) everywhere.
 * Nothing in this app should ever hold a rupee value in a float. */

/** "1,200.50" | "9k" | 1200.5 -> 120050 */
export function toMinor(value) {
  if (typeof value === 'number') return Math.round(value * 100);

  let s = String(value).trim().replace(/,/g, '');
  let multiplier = 1;
  if (/[kK]$/.test(s)) {
    multiplier = 1000;
    s = s.slice(0, -1);
  }
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * multiplier * 100);
}

/** 120050 -> 1200.5 */
export function fromMinor(minor) {
  return minor / 100;
}

/**
 * 120050 -> "Rs 1,200.50"   55000 -> "Rs 550"
 * Whole amounts drop the decimals — nearly every entry in the data is whole
 * rupees, and ".00" on every row is just noise.
 */
export function formatMinor(minor, { currency = 'PKR', sign = '' } = {}) {
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100);
  const paisa = abs % 100;
  const grouped = whole.toLocaleString('en-US');
  const symbol = currency === 'PKR' ? 'Rs' : currency;
  const body = paisa === 0 ? grouped : `${grouped}.${String(paisa).padStart(2, '0')}`;
  return `${sign}${symbol} ${body}`;
}

/** Signed display for a transaction record. */
export function formatTxnAmount(txn) {
  return formatMinor(txn.amount_minor, {
    currency: txn.currency,
    sign: txn.direction === 'in' ? '+' : '−',
  });
}
