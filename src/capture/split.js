/* Shared expenses and reimbursements, resolved at capture time.
 *
 * Buying something for other people is a debt, not a purchase: "cake for tom,
 * dick, harry 2500" means 2500 left the wallet and three people each owe a
 * share of it. One transaction cannot express that, so this module turns the
 * line into one row per person, each carrying a counterparty and a ledger
 * effect. "reimbursement from tom 500" is the other half — it lands as incoming
 * money against Tom, and the ledger nets the two.
 *
 * Why this is done here rather than in the enrichment pass, which already
 * derives counterparties: the split is not an inference. The user named the
 * people explicitly, and they expect the entries to exist immediately — the
 * ledger has to be right on a phone with no signal, hours before any model
 * runs. Enrichment still sees these rows and still assigns the category; it
 * just cannot overwrite what capture already knows (see accept_proposal).
 *
 * The shares always sum back to the amount typed. Integer division would leak
 * paisa on 2500/3, so the remainder is handed out one unit at a time.
 */

import { parseRoute } from './normalize.js';

/** Words that mean "and my own share too". */
const ME = new Set(['me', 'myself', 'i', 'self', 'mine', 'my share']);

// Only commas, "&" and the word "and" separate names. "+" is deliberately not a
// separator: real entries like "Anser Farewell + Oil Spray Bottle" use it to
// join two *things*, and treating it as a name separator invents people.
const SEPARATOR = /\s*(?:,|&|\band\b)\s*/i;

// A person's name: letters, and the punctuation that shows up in real ones
// ("Anser's", "Mutahhar Bhai", "Abdur-Rehman"). Digits disqualify it outright,
// which keeps place names like "F10" and "26 Number" out.
const NAME = /^[\p{L}][\p{L}\p{M}'’.\-]*(?: [\p{L}][\p{L}\p{M}'’.\-]*){0,2}$/u;

const REIMBURSEMENT =
  /^(?:re-?imbursements?|re-?imbursed|repayments?|repaid|payback|paid\s+back|refunds?|refunded)\s+(?:from|by)\s+(.+)$/i;

// "Slanty(for sis)" and "Internet Bundle(Uzair)" are both real. The "for" is
// optional inside brackets — the bracket alone already marks the aside.
const BRACKETED = /^(.*?[^\s(])\s*\((?:for\s+)?([^)]+)\)\s*$/i;
const FOR_CLAUSE = /^(.+?)\s+for\s+(.+)$/i;

// The mirror of "for": "chicken piece from Harry 500" means Harry paid and the
// debt runs the other way. Checked after REIMBURSEMENT, which is also a "from"
// and means the opposite.
const FROM_CLAUSE = /^(.+?)\s+from\s+(.+)$/i;

// "Loan from Khuzaima" is cash arriving; "chicken piece from Harry" is not — a
// colleague bought lunch, no money reached the wallet. Both are debts, but only
// the first one changes what is in your pocket, so they cannot share a
// direction. See budgetSummary, which is where that distinction is spent.
const CASH_LOAN = /^(?:a\s+)?(?:loans?|cash|money|advances?|borrow(?:ed|ing)?|udhaar|qarz)$/i;

/** Case-and-punctuation-insensitive identity for a person. */
export function personKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** "tom" -> "Tom", but "Mutahhar Bhai" and "DSM" keep the case they were given. */
function displayPerson(name) {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => (/[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Split `total` n ways with no paisa lost. The first shares absorb the remainder. */
export function shares(total, n) {
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** Parse "tom, dick and harry" into names, or null if any part is not name-shaped. */
function parsePeople(text) {
  const parts = String(text).split(SEPARATOR).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (!parts.every((p) => NAME.test(p))) return null;
  return parts;
}

/**
 * Read the "for <people>" clause off an entry name.
 * @returns {{item: string, people: string[], includesMe: boolean}|null}
 */
export function parseForClause(name) {
  const text = String(name ?? '').trim();
  if (!text) return null;

  // A ride is "provider from-to"; its place names are not people, and "Indrive
  // Home - Office for Work" should never become a debt.
  if (parseRoute(text)) return null;

  const match = BRACKETED.exec(text) || FOR_CLAUSE.exec(text);
  if (!match) return null;

  const item = match[1].trim();
  const names = parsePeople(match[2]);
  if (!item || !names) return null;

  const people = [];
  let includesMe = false;
  for (const raw of names) {
    if (ME.has(personKey(raw))) {
      includesMe = true;
      continue;
    }
    people.push(displayPerson(raw));
  }
  if (!people.length) return null;

  return { item, people, includesMe };
}

/**
 * Read the "from <person>" clause: someone else paid for this.
 *
 * Only one person, deliberately. "Cake from Tom and Dick" would mean two people
 * each covered part of one purchase, which is rare enough that guessing the
 * split is worse than leaving it alone — whereas buying *for* several people at
 * once is the common case the "for" clause exists to handle.
 *
 * @returns {{item: string, person: string, cashLoan: boolean}|null}
 */
export function parseFromClause(name) {
  const text = String(name ?? '').trim();
  if (!text) return null;
  if (parseRoute(text)) return null;
  // A reimbursement is also a "from" and means the opposite. It wins.
  if (REIMBURSEMENT.test(text)) return null;

  const match = FROM_CLAUSE.exec(text);
  if (!match) return null;

  const item = match[1].trim();
  const names = parsePeople(match[2]);
  if (!item || !names || names.length !== 1) return null;
  if (ME.has(personKey(names[0]))) return null;

  return { item, person: displayPerson(names[0]), cashLoan: CASH_LOAN.test(item) };
}

/** Read "reimbursement from <people>", the entry that cancels a share. */
export function parseReimbursement(name) {
  const match = REIMBURSEMENT.exec(String(name ?? '').trim());
  if (!match) return null;
  const names = parsePeople(match[1]);
  if (!names) return null;
  const people = names.filter((n) => !ME.has(personKey(n))).map(displayPerson);
  return people.length ? { people } : null;
}

/**
 * Turn one captured line into the rows it actually means.
 *
 * Returns null for an ordinary entry — the overwhelmingly common case, and the
 * one that must stay a single row.
 *
 * `knownPeople` is every counterparty this user has already accumulated. It is
 * what keeps "charger for laptop" from inventing a person called Laptop: a
 * single unfamiliar name is reported with `auto: false`, so the UI offers the
 * split rather than performing it. Two or more names, a name already known, or
 * an explicit "me" is evidence enough to split without asking.
 *
 * @returns {{kind: 'split'|'reimbursement'|'borrowed', auto: boolean,
 *            item?: string, cashLoan?: boolean, people: string[],
 *            includesMe: boolean, rows: object[]}|null}
 */
export function planEntry(name, amountMinor, direction = 'out', { knownPeople = [] } = {}) {
  if (!name || !Number.isFinite(amountMinor) || amountMinor <= 0) return null;

  const known = new Set([...knownPeople].map(personKey));

  const refund = parseReimbursement(name);
  if (refund) {
    const cut = shares(amountMinor, refund.people.length);
    return {
      kind: 'reimbursement',
      auto: true,
      people: refund.people,
      includesMe: false,
      rows: refund.people.map((person, i) => ({
        raw_name: refund.people.length === 1 ? name : `Reimbursement from ${person}`,
        amount_minor: cut[i],
        direction: 'in',
        counterparty_name: person,
        ledger_effect: 'repaid_by',
        category: 'Reimbursement',
      })),
    };
  }

  // Someone else paid. One row, and the debt points the other way.
  const from = parseFromClause(name);
  if (from) {
    return {
      kind: 'borrowed',
      // A cash loan says outright what it is; a purchase does not, so an
      // unfamiliar name is offered rather than applied. "Chicken from Metro"
      // must not mint a person called Metro.
      auto: from.cashLoan || known.has(personKey(from.person)),
      item: from.item,
      cashLoan: from.cashLoan,
      people: [from.person],
      includesMe: false,
      rows: [
        {
          raw_name: name,
          amount_minor: amountMinor,
          // Cash arriving vs a purchase someone else funded. Only the first one
          // changes what is in the wallet.
          direction: from.cashLoan ? 'in' : 'out',
          counterparty_name: from.person,
          ledger_effect: 'borrowed',
          category: from.cashLoan ? 'Transfers & Loans' : null,
        },
      ],
    };
  }

  // Money coming in is never a purchase made on someone's behalf.
  if (direction !== 'out') return null;

  const forClause = parseForClause(name);
  if (!forClause) return null;

  const { item, people, includesMe } = forClause;
  const auto = includesMe || people.length > 1 || people.some((p) => known.has(personKey(p)));

  // My own share only exists if I said so. Otherwise the whole amount is owed
  // back to me, which is the point the user made: buying for three people is
  // not a third of a purchase.
  const cut = shares(amountMinor, people.length + (includesMe ? 1 : 0));

  const rows = people.map((person, i) => ({
    raw_name: `${item} for ${person}`,
    amount_minor: cut[i],
    direction: 'out',
    counterparty_name: person,
    ledger_effect: 'lent',
    category: null,
  }));

  if (includesMe) {
    rows.push({
      raw_name: item,
      amount_minor: cut[cut.length - 1],
      direction: 'out',
      counterparty_name: null,
      ledger_effect: null,
      category: null,
    });
  }

  return { kind: 'split', auto, item, people, includesMe, rows };
}
