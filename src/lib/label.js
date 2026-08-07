/* What a transaction should be called on screen.
 *
 * `raw_name` is immutable — it is the evidence a bad enrichment pass gets
 * recomputed against — so the tidy version lives in its own nullable column,
 * written by the model. Until that column is filled, the deterministic
 * normaliser still fixes rides offline, which is the 30% of entries whose
 * spelling drifts most. Everything else falls back to what was typed.
 */

import { displayName } from '../capture/normalize.js';

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
