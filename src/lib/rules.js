/* Deterministic capture rules: "anything containing <text> is <category>".
 *
 * The enrichment model is good, but it re-decides every time and it costs a
 * round trip. A rule is the user saying, once, that they already know — so the
 * category is set at capture, offline, and the row is marked done so the model
 * never second-guesses it. Copilot's most-liked feature is that it learns from
 * your corrections; this is the same idea, made explicit and kept on the device.
 *
 * A rule sets the category and nothing else. It deliberately never sets a
 * counterparty: a counterparty on an ordinary expense would file it under
 * "spent on other people" and pull it out of its category — a surprising, wrong
 * side effect for what reads like a tidy-up. People stay the ledger's business.
 *
 * Pure and side-effect free; the store is a plain array in meta.
 */

const norm = (s) => String(s ?? '').toLowerCase().trim();

/** The first rule whose match text appears in the raw name, or null. */
export function matchRule(rules, rawName) {
  const hay = norm(rawName);
  if (!hay) return null;
  for (const rule of rules || []) {
    const needle = norm(rule.match);
    if (needle && hay.includes(needle)) return rule;
  }
  return null;
}

/** The transaction fields a rule dictates — category only. */
export function ruleFields(rule) {
  return rule && rule.category ? { category: rule.category } : null;
}

/**
 * A sensible default match string offered when turning a correction into a
 * rule: the first meaningful word of the raw text, lowercased. "Indrive
 * Home-Office" → "indrive", which generalises to every ride, rather than the
 * whole unique string, which would match nothing else.
 */
export function suggestMatch(rawName) {
  const first = norm(rawName).split(/[^\p{L}\p{N}]+/u).filter(Boolean)[0];
  return first || norm(rawName);
}
