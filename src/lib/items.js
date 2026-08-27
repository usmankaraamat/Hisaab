/* Answering about a *thing*, not a category.
 *
 * "How much did I spend on chicken this month" is the question this app was
 * started to answer, and the one it could not: Ask knew twenty categories and
 * nothing else, so it fell through to the month's total and looked like it had
 * ignored the word. The categories are already on the screen underneath it —
 * repeating them was the least useful thing it could have said.
 *
 * The item vocabulary is not a fixed list, and it should not be: it is whatever
 * is in your own entries. So the question is matched against the labels of the
 * rows themselves, which means it works on the day you first buy something, and
 * it keeps working when you call it something new.
 *
 * Pure over rows, like the rest of lib/. The window and the definition of
 * "spend" both come from budget.js, so an item total can never count a row the
 * breakdown above it left out.
 */

import { isSpendRow } from './budget.js';
import { txnLabel } from './label.js';

/* Words that carry no subject. Anything left after these is what was asked
 * about — which is why the list holds the question frame and the time words,
 * not a dictionary. */
const STOP = new Set([
  'how', 'much', 'many', 'what', 'whats', 'was', 'were', 'is', 'are', 'did', 'do', 'does',
  'have', 'has', 'had', 'i', 'ive', 'im', 'me', 'my', 'mine', 'we', 'our', 'you', 'your',
  'spend', 'spent', 'spending', 'spends', 'cost', 'costs', 'costed', 'paid', 'pay', 'pays',
  'buy', 'buys', 'bought', 'buying', 'price', 'prices', 'worth', 'money', 'amount',
  'on', 'for', 'of', 'in', 'at', 'to', 'from', 'the', 'a', 'an', 'and', 'or', 'plus',
  'total', 'totals', 'all', 'about', 'so', 'far', 'up', 'till', 'until', 'sum',
  'rs', 'rupees', 'pkr', 'rupee',
  'this', 'that', 'these', 'those', 'last', 'past', 'previous', 'prev', 'current',
  'today', 'yesterday', 'week', 'weeks', 'month', 'months', 'year', 'years', 'day', 'days',
  'ever', 'overall', 'time', 'times', 'date', 'now', 'per',
]);

/** Singular/plural tolerance, without pretending to be a stemmer. */
function stem(word) {
  if (/ss$/.test(word)) return word;
  const base = word.replace(/(?:ies|es|s)$/, (m) => (m === 'ies' ? 'y' : ''));
  return base.length >= 3 ? base : word;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A matcher for one word, tolerant of the plural on either side. */
function wordRe(term) {
  const base = stem(term.toLowerCase());
  return new RegExp(`\\b${escapeRe(base)}(?:e?s|es)?\\b`, 'i');
}

/**
 * The subject of a question, as a list of words.
 * "how much did I spend on chicken this month" -> ['chicken']
 */
export function questionTerms(question) {
  return String(question ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function inWindow(row, fromMs, toMs) {
  const at = new Date(row.occurred_at).getTime();
  return at >= fromMs && at <= toMs;
}

/**
 * Every spend row whose label matches the terms, tried from most specific to
 * least: the whole phrase, then every word, then any word. A phrase that only
 * matches loosely is still an answer — just a broader one — and the caller is
 * told which reading it got so it can say so.
 *
 * @returns {{terms, match: 'phrase'|'all'|'any', rows}|null}
 */
export function matchItems(rows, terms, { from = null, to = null } = {}) {
  const words = (Array.isArray(terms) ? terms : questionTerms(terms)).filter(Boolean);
  if (!words.length) return null;

  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs = to ? new Date(to).getTime() : Infinity;
  const pool = rows.filter((r) => isSpendRow(r) && inWindow(r, fromMs, toMs));
  if (!pool.length) return null;

  const labelled = pool.map((r) => ({ row: r, label: txnLabel(r) }));
  const res = words.map(wordRe);
  const phrase = words.length > 1 ? new RegExp(`\\b${words.map(escapeRe).join('\\s+')}\\w*`, 'i') : null;

  const tries = [
    phrase && ['phrase', labelled.filter((x) => phrase.test(x.label))],
    ['all', labelled.filter((x) => res.every((re) => re.test(x.label)))],
    ['any', labelled.filter((x) => res.some((re) => re.test(x.label)))],
  ].filter(Boolean);

  for (const [match, hits] of tries) {
    if (hits.length) return { terms: words, match, rows: hits.map((h) => h.row) };
  }
  return null;
}

/**
 * What one thing has cost you over a window.
 *
 * `unitMinor` is the median rather than the mean, because a single bulk buy
 * would otherwise redefine what a chicken costs. `lastMinor` is what it cost
 * most recently, which is the figure worth comparing against at the counter.
 */
export function itemTotal(rows, terms, { from = null, to = null } = {}) {
  const hit = matchItems(rows, terms, { from, to });
  if (!hit) return null;

  const sorted = [...hit.rows].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1));
  const amounts = [...hit.rows].map((r) => r.amount_minor).sort((a, b) => a - b);
  const mid = Math.floor(amounts.length / 2);
  const last = sorted.at(-1);

  return {
    terms: hit.terms,
    match: hit.match,
    label: hit.terms.join(' '),
    totalMinor: hit.rows.reduce((a, r) => a + r.amount_minor, 0),
    count: hit.rows.length,
    unitMinor: amounts.length % 2 ? amounts[mid] : Math.round((amounts[mid - 1] + amounts[mid]) / 2),
    lastMinor: last.amount_minor,
    lastAt: last.occurred_at,
  };
}

/**
 * The things you spend the most on, by label rather than by category — the
 * answer to "what am I actually buying", which no category bar can give.
 */
export function topItems(rows, { from = null, to = null, limit = 5 } = {}) {
  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs = to ? new Date(to).getTime() : Infinity;
  const byKey = new Map();

  for (const r of rows) {
    if (!isSpendRow(r) || !inWindow(r, fromMs, toMs)) continue;
    const label = txnLabel(r);
    // Grouped on the stemmed words, so "Chicken", "chickens" and "2 Chicken"
    // are one thing rather than three rows that each look small.
    const key = questionTerms(label).map(stem).join(' ') || label.toLowerCase();
    const t = byKey.get(key) || { label, totalMinor: 0, count: 0, lastAt: r.occurred_at, forms: new Map() };
    t.totalMinor += r.amount_minor;
    t.count++;
    const form = t.forms.get(label) || { count: 0, lastAt: r.occurred_at };
    form.count++;
    if (r.occurred_at > form.lastAt) form.lastAt = r.occurred_at;
    t.forms.set(label, form);
    if (r.occurred_at > t.lastAt) t.lastAt = r.occurred_at;
    byKey.set(key, t);
  }

  /* Named by the spelling used most often, and the most recent of those when
   * they are level. Reporting whichever way it happened to be typed last would
   * let one hurried "chickens" rename a thing bought twenty times. */
  for (const t of byKey.values()) {
    t.label = [...t.forms.entries()].sort(
      (a, b) => b[1].count - a[1].count || (a[1].lastAt < b[1].lastAt ? 1 : -1)
    )[0][0];
    delete t.forms;
  }

  return [...byKey.values()].sort((a, b) => b.totalMinor - a.totalMinor).slice(0, limit);
}
