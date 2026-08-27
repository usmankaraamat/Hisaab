/* A little natural-language answerer over the local ledger.
 *
 * Copilot's "money assistant" answers questions like "how much on eating out
 * last month?" by sending your data to a model. This does the common cases
 * without any of that — it stays on the device, works offline, and never leaves
 * a trace, which is the whole posture of this app. It is deliberately not a
 * chatbot: it recognises time windows, categories, people and the things in
 * your own entries, and answers the questions people actually ask their expense
 * tracker.
 *
 * Categories alone were not enough, and were the wrong half. The category totals
 * are already drawn as bars directly beneath this box, so answering "chicken"
 * with the month's total was both wrong and redundant — while the item question
 * is the one with no other home in the app, short of searching History by
 * keyword and adding the numbers up by hand.
 *
 * Pure over rows, so verify.mjs pins the answers.
 */

import { categoryTotals, calendarPeriod } from './budget.js';
import { balances } from './ledger.js';
import { CATEGORIES } from './categories.js';
import { formatMinor } from './money.js';
import { personKey } from '../capture/split.js';
import { questionTerms, itemTotal, topItems } from './items.js';

/* Everyday words that mean a category. Kept small and honest — a wrong guess is
 * worse than "I could not tell which category". */
const SYNONYMS = {
  food: 'Eating Out', restaurant: 'Eating Out', dining: 'Eating Out', 'eating out': 'Eating Out',
  grocery: 'Groceries', groceries: 'Groceries',
  ride: 'Rides', rides: 'Rides', uber: 'Rides', indrive: 'Rides', careem: 'Rides', yango: 'Rides',
  petrol: 'Fuel', fuel: 'Fuel', gas: 'Fuel',
  rent: 'Rent',
  bill: 'Utilities', bills: 'Utilities', utility: 'Utilities', utilities: 'Utilities',
  subscription: 'Subscriptions', subscriptions: 'Subscriptions',
  shopping: 'Shopping', clothes: 'Shopping',
  health: 'Health', medicine: 'Health', medical: 'Health',
  charity: 'Charity', travel: 'Travel', education: 'Education', fees: 'Education',
  drinks: 'Drinks', coffee: 'Drinks', entertainment: 'Entertainment', gifts: 'Gifts & Treats',
};

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const iso = (d) => d.toISOString();

/** Resolve the time window named in the question; default is this period. */
function windowFor(q, now) {
  const today = startOfDay(now);
  if (/\byesterday\b/.test(q)) {
    const y = new Date(today);
    y.setDate(today.getDate() - 1);
    return { from: iso(y), to: iso(today), label: 'yesterday' };
  }
  if (/\btoday\b/.test(q)) return { from: iso(today), to: null, label: 'today' };
  if (/\b(this )?week\b/.test(q)) {
    const w = new Date(today);
    w.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    return { from: iso(w), to: null, label: 'this week' };
  }
  if (/\b(last|previous|prev)\s+month\b/.test(q)) {
    const cur = calendarPeriod(now);
    const prev = calendarPeriod(new Date(new Date(cur.periodStart).getTime() - 1));
    return { from: prev.periodStart, to: prev.periodEnd, label: 'last month' };
  }
  if (/\b(this )?year\b/.test(q)) {
    return { from: iso(new Date(now.getFullYear(), 0, 1)), to: null, label: 'this year' };
  }
  if (/\b(all time|ever|overall|total|in total)\b/.test(q)) {
    return { from: null, to: null, label: 'all time' };
  }
  const p = calendarPeriod(now);
  return { from: p.periodStart, to: null, label: 'this month' };
}

/** The category named in the question, by exact name or a common synonym. */
function categoryIn(q) {
  for (const c of CATEGORIES) if (q.includes(c.toLowerCase())) return c;
  for (const [word, cat] of Object.entries(SYNONYMS)) {
    if (new RegExp(`\\b${word}\\b`).test(q)) return cat;
  }
  return null;
}

function personAnswer(q, rows) {
  const book = balances(rows).filter((p) => p.netMinor !== 0);
  if (!book.length) return { text: 'Nobody owes anything either way right now.' };

  // "how much does Sara owe" / "how much do I owe Ali"
  const named = /(?:does|do|is)\s+([\p{L} '.-]+?)\s+owe|owe\s+([\p{L} '.-]+?)[\s?]*$/u.exec(q);
  const who = (named && (named[1] || named[2]) || '').trim();
  if (who && !/^(me|i|you)$/i.test(who)) {
    const person = book.find((p) => personKey(p.name) === personKey(who));
    if (!person) return { text: `You are square with ${who}.` };
    return person.netMinor > 0
      ? { text: `${person.name} owes you ${formatMinor(person.netMinor)}.`, person: person.name }
      : { text: `You owe ${person.name} ${formatMinor(-person.netMinor)}.`, person: person.name };
  }

  const iOwe = /\bi\s+owe\b|do i owe/.test(q);
  const pool = book.filter((p) => (iOwe ? p.netMinor < 0 : p.netMinor > 0));
  if (!pool.length) return { text: iOwe ? 'You do not owe anyone.' : 'Nobody owes you right now.' };
  const top = pool.sort((a, b) => Math.abs(b.netMinor) - Math.abs(a.netMinor))[0];
  return iOwe
    ? { text: `You owe ${top.name} the most: ${formatMinor(-top.netMinor)}.`, person: top.name }
    : { text: `${top.name} owes you the most: ${formatMinor(top.netMinor)}.`, person: top.name };
}

/**
 * @returns {{text: string, amountMinor?, category?, query?, person?, from?, to?}}
 * — a one-line answer, plus the filter that produced it so the UI can offer
 * "see the entries" and land on exactly the rows that were counted.
 */
export function answerQuery(question, rows, { now = new Date() } = {}) {
  const q = String(question ?? '').toLowerCase().trim();
  if (!q) return { text: 'Ask about a category, a month, or who owes what.' };

  if (/\bowe|owes|owed\b/.test(q)) return personAnswer(q, rows);

  const win = windowFor(q, now);
  const totals = categoryTotals(rows, { from: win.from, to: win.to });
  const cat = categoryIn(q);

  if (cat) {
    const row = totals.find((c) => c.category === cat);
    const amountMinor = row ? row.totalMinor : 0;
    return {
      text: `You spent ${formatMinor(amountMinor)} on ${cat} ${win.label}.`,
      amountMinor, category: cat, from: win.from, to: win.to,
    };
  }

  if (/\b(biggest|top|most|largest|highest)\b/.test(q) && totals.length) {
    // "What do I buy the most" is a different question from "what is my biggest
    // category", and the honest answer to it is a thing, not a bucket.
    if (/\b(item|items|thing|things|buy|bought|purchase|product)\b/.test(q)) {
      const [first] = topItems(rows, { from: win.from, to: win.to, limit: 1 });
      if (first) {
        return {
          text: `Your biggest single thing ${win.label} was ${first.label}: ${formatMinor(
            first.totalMinor
          )} over ${first.count} ${first.count === 1 ? 'entry' : 'entries'}.`,
          amountMinor: first.totalMinor, query: first.label, from: win.from, to: win.to,
        };
      }
    }
    const top = totals[0];
    return {
      text: `Your biggest spend ${win.label} was ${top.category}: ${formatMinor(top.totalMinor)}.`,
      amountMinor: top.totalMinor, category: top.category, from: win.from, to: win.to,
    };
  }

  /* A thing, rather than a category. Tried after categories so that a word
   * which means both — "drinks" — keeps answering as the bucket it draws a bar
   * for, and before the fall-through so that a word which means neither stops
   * being answered with a number that ignores it. */
  const terms = questionTerms(q);
  if (terms.length) {
    const item = itemTotal(rows, terms, { from: win.from, to: win.to });
    if (item) {
      const what = item.match === 'any' && item.terms.length > 1
        ? `${item.terms.join(' or ')}`
        : item.label;
      const spread =
        item.count > 1
          ? ` across ${item.count} entries, usually ${formatMinor(item.unitMinor)} each`
          : '';
      return {
        text: `You spent ${formatMinor(item.totalMinor)} on ${what} ${win.label}${spread}.`,
        amountMinor: item.totalMinor,
        query: item.terms.join(' '),
        count: item.count,
        from: win.from, to: win.to,
      };
    }
  }

  const total = totals.reduce((a, c) => a + c.totalMinor, 0);
  // Say plainly that the subject was not recognised, rather than answering a
  // question that was not asked with a number that looks like an answer.
  if (terms.length) {
    return {
      text: `Nothing matching “${terms.join(' ')}” ${win.label}. You spent ${formatMinor(
        total
      )} in all.`,
      amountMinor: total, from: win.from, to: win.to,
    };
  }
  return {
    text: `You spent ${formatMinor(total)} ${win.label}.`,
    amountMinor: total, from: win.from, to: win.to,
  };
}
