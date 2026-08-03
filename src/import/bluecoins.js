/* One-time import of the Bluecoins CSV export.
 *
 * Export shape (note the UTF-8 BOM on the header, and that expense amounts
 * are negative):
 *   "Type","Date","Set Time","Name","Amount","Currency","Exchange Rate",
 *   "Category Group","Category","Account","Notes","Labels","Status"
 *   "Expense","2026-08-03 20:51:39.478","20:51","Eat Out","-550.00","PKR",...
 *
 * Category/Account/Notes/Labels are read but discarded: in the real export
 * they are 100% "Others"/"Wallet"/empty, which is the whole reason this app
 * exists. Only `Name` carries information, and it is preserved verbatim as
 * `raw_name` for the enrichment pass to work on later.
 */

import { toMinor } from '../lib/money.js';
import { bulkAdd } from '../db/local.js';

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF or LF. */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
  }

  return rows;
}

/**
 * Bluecoins writes local wall-clock time with no zone. Parsing it as local
 * (rather than letting Date guess UTC) keeps the hour-of-day buckets that the
 * Phase 2 prediction chips depend on correct.
 */
function toIso(dateField) {
  const m = String(dateField)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const dt = new Date(+y, +mo - 1, +d, +h, +mi, +s, ms ? +ms.padEnd(3, '0') : 0);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** Parse the file into transaction inputs plus a reconciliation summary. */
export function parseBluecoins(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { inputs: [], summary: null, errors: ['File is empty.'] };

  const header = rows[0].map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  const iType = col('Type');
  const iDate = col('Date');
  const iName = col('Name');
  const iAmount = col('Amount');
  const iCurrency = col('Currency');

  if ([iType, iDate, iName, iAmount].some((i) => i === -1)) {
    return {
      inputs: [],
      summary: null,
      errors: [`Unexpected header. Got: ${header.join(', ')}`],
    };
  }

  const inputs = [];
  const errors = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rawDate = row[iDate];
    const rawAmount = row[iAmount];
    const name = (row[iName] || '').trim();

    const occurred_at = toIso(rawDate);
    const minor = toMinor(rawAmount);

    if (occurred_at === null || minor === null) {
      errors.push(`Row ${r + 1}: could not read date "${rawDate}" or amount "${rawAmount}".`);
      continue;
    }

    const type = (row[iType] || '').trim().toLowerCase();
    // Trust the sign on the amount; fall back to Type when it is zero.
    const direction = minor > 0 || (minor === 0 && type === 'income') ? 'in' : 'out';

    inputs.push({
      raw_name: name,
      amount_minor: Math.abs(minor),
      direction,
      currency: (row[iCurrency] || 'PKR').trim() || 'PKR',
      occurred_at,
      source: 'bluecoins',
      // Deterministic, so importing the same file twice is a no-op.
      client_event_id: `bluecoins:${rawDate}|${name}|${rawAmount}`,
    });
  }

  return { inputs, summary: summarise(inputs), errors };
}

export function summarise(inputs) {
  if (!inputs.length) return null;
  let spent = 0;
  let received = 0;
  let min = inputs[0].occurred_at;
  let max = inputs[0].occurred_at;

  for (const t of inputs) {
    if (t.direction === 'in') received += t.amount_minor;
    else spent += t.amount_minor;
    if (t.occurred_at < min) min = t.occurred_at;
    if (t.occurred_at > max) max = t.occurred_at;
  }

  const days = new Set(inputs.map((t) => t.occurred_at.slice(0, 10))).size;
  return { count: inputs.length, spentMinor: spent, receivedMinor: received, min, max, days };
}

/** Parse + write. Idempotent on `client_event_id`. */
export async function importBluecoins(text) {
  const { inputs, summary, errors } = parseBluecoins(text);
  if (!inputs.length) return { added: 0, skipped: 0, summary, errors };
  const { added, skipped } = await bulkAdd(inputs);
  return { added, skipped, summary, errors };
}
