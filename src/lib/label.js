/* What a transaction should be called on screen.
 *
 * `raw_name` is immutable — it is the evidence a bad enrichment pass gets
 * recomputed against — so the tidy version lives in its own nullable column,
 * written by the model. Until that column is filled, the deterministic
 * normaliser still fixes rides offline, which is the 30% of entries whose
 * spelling drifts most. Everything else falls back to what was typed.
 */

import { displayName } from '../capture/normalize.js';
import { personKey } from '../capture/split.js';

export function txnLabel(row) {
  const tidy = String(row?.display_name ?? '').trim();
  if (tidy) return tidy;
  return displayName(row?.raw_name ?? '');
}

/** True when the tidy name is different enough to be worth showing the original. */
export function hasRewrite(row) {
  const raw = String(row?.raw_name ?? '').trim();
  return Boolean(raw) && txnLabel(row) !== raw;
}

/* Attribution the surrounding context already supplies: "<item> for <person>",
 * "<item> from <person>", "<item> to <person>", "<item>(<person>)". */
const ATTRIBUTION = /^(.*?\S)\s*(?:\(\s*(?:for\s+)?([^()]+?)\s*\)|\b(?:for|from|to)\s+(.+))$/i;

/**
 * The label for a row listed under a person in the ledger.
 *
 * Under a "Sister" heading, every line reading "Milk for Sister" says her name
 * twice and the item once. Stripping the clause is what makes the panel
 * shareable — which is the point of a ledger you settle with someone.
 *
 * Only stripped when the name in the clause is actually the person the row is
 * filed under, so "Gift for Eid" keeps its meaning and a route or a place is
 * never mistaken for the counterparty. The prefix test covers the short forms
 * people really type — "sis" under Sister.
 */
export function ledgerLabel(row) {
  const label = txnLabel(row);
  const party = String(row?.counterparty_name ?? '').trim();
  if (!party) return label;

  const match = ATTRIBUTION.exec(label);
  if (!match) return label;

  const item = match[1].trim();
  const named = (match[2] ?? match[3] ?? '').trim();
  if (!item || !named) return label;

  const a = personKey(named);
  const b = personKey(party);
  if (!a || !b) return label;
  if (a !== b && !a.startsWith(b) && !b.startsWith(a)) return label;

  return item;
}
