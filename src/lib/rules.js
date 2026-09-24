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

import { groupKey } from '../capture/normalize.js';

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

/* How many recent entries of a kind must agree before their category is
 * assumed. Three is enough to rule out a one-off and few enough that a new
 * habit is picked up within the week. */
const LEARN_MIN = 3;

/* Rides group by provider rather than route, so a route taken for the first
 * time is still a ride. */
function learnKey(rawName) {
  const key = groupKey(rawName);
  return key.startsWith('ride:') ? key.split('|')[0] : key;
}

/**
 * The category your own history has settled on for this kind of entry, or null.
 *
 * An explicit rule is the user saying it once; this is the app noticing it.
 * Six InDrive rides in a row sat uncategorised until "Categorise now" was
 * tapped, after thirty identical ones had all been filed under Rides. Only the
 * most recent entries vote, and they must all agree, so a re-categorisation is
 * followed rather than outvoted by the past. Imported reference rows and
 * reconciliation corrections never vote.
 */
export function learnedCategory(history, rawName, direction = 'out') {
  const key = learnKey(rawName);
  const votes = (history || [])
    .filter((r) => r && !r.deleted && r.source !== 'bluecoins' && r.category && r.category !== 'Reconcile')
    .filter((r) => r.direction === direction && learnKey(r.raw_name) === key)
    .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
    .slice(0, LEARN_MIN)
    .map((r) => r.category);
  return votes.length === LEARN_MIN && votes.every((c) => c === votes[0]) ? votes[0] : null;
}
