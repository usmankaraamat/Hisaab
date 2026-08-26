/* Read a bank or wallet transaction notification into a capture.
 *
 * The whole point of Hisaab is that logging never blocks on a decision. A
 * payment notification already carries the hardest part — the amount, and which
 * way the money went — so this turns one into a *pending* capture the user only
 * has to say what it was for. Nothing here guesses a category; it extracts the
 * facts the notification states and leaves the meaning to the person.
 *
 * These are the formats seen in the wild in Pakistan, from the apps this user
 * actually uses:
 *
 *   easypaisa  "Trx ID 539… You have Received Rs. 50.00 from , Bank BAF in your
 *               Easypaisa Account. Fee for this transaction is Rs. 0.00."
 *   easypaisa  "Dear NAME, An amount of Rs. 675.0 has been successfully sent to
 *               AWAIS IQBAL in *******3787 via Raast Payment … on 2026-08-09 at
 *               14:18:28…"
 *   nayapay    "Off it goes 💸  Rs. 10 sent to Usman Karamat. Your wallet's seen
 *               better days."
 *   HBL (SMS)  "PKR 10.00 received from MALIK USMAN KARAMAT IBAN in your HBL A/C
 *               via your Raast ID on 09/08/2026 14:24:13 TXN ID SM09…"
 *   Alfa       "PKR 50.00 sent to MALIK USMAN KARAMAT TMB from your BAF A/C
 *               **9388 on 10-Aug-26 14:23:57 via FT Tx ID FT26…"
 *
 * Pure and side-effect free, so verify.mjs asserts it against the real strings.
 */

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/* Provider tokens → the name shown on the pending card. Order matters: the
 * first hit wins, so specific wallet names sit above the bank they route to. */
const PROVIDERS = [
  [/easypaisa/i, 'easypaisa'],
  [/nayapay|naya pay/i, 'NayaPay'],
  [/jazz\s?cash/i, 'JazzCash'],
  [/sadapay/i, 'SadaPay'],
  [/\bHBL\b|habib bank/i, 'HBL'],
  [/alfa|alfalah|\bBAF\b/i, 'Bank Alfalah'],
  [/meezan/i, 'Meezan'],
  [/\bUBL\b/i, 'UBL'],
  [/\bMCB\b/i, 'MCB'],
  [/allied|\bABL\b/i, 'Allied'],
  [/standard chartered|\bSCB\b/i, 'Standard Chartered'],
  [/\bNBP\b/i, 'NBP'],
];

/** Rupees like "675.0", "1,250.00", "50" → integer minor units. */
function toMinorFromString(s) {
  const n = Number(String(s).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

const AMOUNT = String.raw`(?:Rs\.?|PKR|PKR\.|RS)\s*([\d,]+(?:\.\d+)?)`;

/**
 * The amount, taken from the clause that states the movement rather than the
 * first rupee figure in the string — a fee line ("Fee … is Rs. 0.00") would
 * otherwise win and log every transfer as zero.
 */
function readAmount(text) {
  const patterns = [
    new RegExp(String.raw`(?:you have\s+)?(?:received|credited(?:\s+with)?|debited(?:\s+with)?|sent|paid|transferred|withdrawn)\s+${AMOUNT}`, 'i'),
    new RegExp(String.raw`amount of\s+${AMOUNT}`, 'i'),
    new RegExp(String.raw`${AMOUNT}\s+(?:has been|was|is|sent|received|paid|credited|debited|transferred)`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return toMinorFromString(m[1]);
  }
  // Fall back to the first figure, but never a zero fee: drop fee clauses first.
  const cleaned = text.replace(/fee[^.]*?(?:Rs\.?|PKR)\s*[\d,.]+/gi, '');
  const m = new RegExp(AMOUNT, 'i').exec(cleaned);
  return m ? toMinorFromString(m[1]) : null;
}

/** Which way the money went, read off the verb that sits next to the amount. */
function readDirection(text) {
  if (/\b(?:sent|debited|withdrawn|paid to|transferred to|purchase|spent|deducted)\b/i.test(text)) {
    return 'out';
  }
  if (/\b(?:received|credited|deposit(?:ed)?|added|refunded|cash ?back)\b/i.test(text)) {
    return 'in';
  }
  return null;
}

/* Bank/account qualifiers that trail a person's name in these messages and are
 * not part of it. Stripped from the tail of the captured counterparty. */
const TRAILING = /\s+(?:IBAN|TMB|A\/C|ACC(?:OUNT)?|BANK|VIA|IN|FROM|ON|AT)\b.*$/i;

function cleanName(raw) {
  if (!raw) return null;
  let s = String(raw)
    .replace(/[*]{2,}\d+/g, ' ') // masked account tails
    .replace(TRAILING, ' ')
    .replace(/^[\s,.-]+|[\s,.-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // A bare account mask or empty leftover is no name at all.
  if (!s || /^[\d*x/-]+$/i.test(s)) return null;
  return s;
}

function readCounterparty(text, direction) {
  const res =
    direction === 'out'
      ? [/sent to\s+(.+?)(?:\s+(?:from|in|via|on|through|—|-)\b|[,.]|$)/i, /paid to\s+(.+?)(?:[,.]|$)/i, /to\s+(.+?)(?:\s+(?:from|in|via|on)\b|[,.]|$)/i]
      : [
          // The payer sometimes sits behind a stray comma ("from , Bank BAF").
          /received from\s*,?\s*(.+?)(?:\s+(?:in|via|on|through|IBAN)\b|[,.]|$)/i,
          /from\s*,?\s*(.+?)(?:\s+(?:in|via|on|through|IBAN)\b|[,.]|$)/i,
        ];
  for (const re of res) {
    const m = re.exec(text);
    const name = m && cleanName(m[1]);
    if (name) return name;
  }
  return null;
}

function readRef(text) {
  const m = /(?:Trx|Tx|TXN|Transaction|FT Tx|Ref(?:erence)?)\s*(?:ID|No\.?|#)?\s*[:#]?\s*([A-Z0-9]{6,})/i.exec(text);
  return m ? m[1] : null;
}

/** Parse the date/time these messages carry, in a handful of local formats. */
function readOccurredAt(text) {
  let m;
  // 2026-08-09 at 14:18:28(.frac)?
  if ((m = /(\d{4})-(\d{2})-(\d{2})(?:\s+at)?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text))) {
    return iso(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  }
  // 09/08/2026 14:24:13  (day-first, the local convention)
  if ((m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text))) {
    return iso(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
  }
  // 10-Aug-26 14:23:57
  if ((m = /(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text))) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon !== undefined) {
      const yr = +m[3] < 100 ? 2000 + +m[3] : +m[3];
      return iso(yr, mon, +m[1], +m[4], +m[5], +(m[6] || 0));
    }
  }
  return null;
}

function iso(y, mon, d, h, mi, s) {
  const dt = new Date(y, mon, d, h, mi, s);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function readSource(text, appName) {
  // A named app ("easypaisa") is authoritative; a numeric SMS shortcode
  // ("14250") is not, so a provider named in the body beats it.
  if (appName) for (const [re, name] of PROVIDERS) if (re.test(appName)) return name;
  for (const [re, name] of PROVIDERS) if (re.test(text)) return name;
  const trimmed = String(appName ?? '').trim();
  return trimmed && !/^\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * @param text     the notification / SMS body (a title may be prepended; it is
 *                 harmless — the verbs it looks for live in the body).
 * @param appName  the posting app's name, when known (share source, or the
 *                 notification's app label). Used only to name the source.
 * @returns {{amountMinor, direction, counterparty, source, ref, occurredAt,
 *            raw}|null} — null when there is no amount to log.
 */
export function parseNotification(text, { appName = null } = {}) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return null;

  const amountMinor = readAmount(body);
  if (amountMinor === null || amountMinor <= 0) return null;

  const direction = readDirection(body) ?? 'out';
  return {
    amountMinor,
    direction,
    counterparty: readCounterparty(body, direction),
    source: readSource(body, appName),
    ref: readRef(body),
    occurredAt: readOccurredAt(body),
    raw: body,
  };
}
