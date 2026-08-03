/* One-line entry parser.  "chicken 900" -> { name: "chicken", amountMinor: 90000 }
 *
 * The rule is deliberately positional rather than a greedy number scan: the
 * amount is only taken from the FIRST or LAST whitespace-separated token, and
 * only when that whole token is a number. Real entries in the data include
 * "Indrive F10-26 Number" and "26 Number - Anser's Home", where a scan-anywhere
 * regex would happily pull a digit out of the middle of the name. Requiring a
 * standalone leading or trailing token makes the split predictable enough that
 * the live preview in the UI is never surprising.
 */

import { toMinor } from '../lib/money.js';

const AMOUNT = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?[kK]?$/;

function isAmount(token) {
  return AMOUNT.test(token);
}

/**
 * @param {string} input
 * @returns {{name: string, amountMinor: number|null, direction: 'in'|'out', explicitDirection: boolean}}
 */
export function parseEntry(input) {
  const text = String(input || '').trim().replace(/\s+/g, ' ');
  const empty = { name: '', amountMinor: null, direction: 'out', explicitDirection: false };
  if (!text) return empty;

  const tokens = text.split(' ');
  let amountToken = null;
  let nameTokens = tokens;

  if (tokens.length === 1) {
    if (isAmount(tokens[0])) {
      amountToken = tokens[0];
      nameTokens = [];
    }
  } else if (isAmount(tokens[tokens.length - 1])) {
    amountToken = tokens[tokens.length - 1];
    nameTokens = tokens.slice(0, -1);
  } else if (isAmount(tokens[0])) {
    amountToken = tokens[0];
    nameTokens = tokens.slice(1);
  }

  if (amountToken === null) {
    return { ...empty, name: text };
  }

  const explicitDirection = amountToken.startsWith('+') || amountToken.startsWith('-');
  const direction = amountToken.startsWith('+') ? 'in' : 'out';
  const minor = toMinor(amountToken.replace(/^[+-]/, ''));

  return {
    name: nameTokens.join(' '),
    amountMinor: minor === null ? null : Math.abs(minor),
    direction,
    explicitDirection,
  };
}
