/* Benchmark the enrichment pass across models.
 *
 *   node scripts/eval/run.mjs [model ...]
 *
 * Grades one batched call per model against scripts/eval/cases.mjs and prints a
 * scorecard plus every miss, so a model is chosen on measured accuracy rather
 * than on a glance at some output.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SCHEMA, SYSTEM, buildPrompt } from '../../supabase/functions/enrich/prompt.js';
import { callGemini } from '../../supabase/functions/enrich/gemini.js';
import { CASES, COLLAPSE, DISTINCT, KNOWN } from './cases.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('Set GEMINI_API_KEY first.');
  process.exit(1);
}

// THINKING=high spends more reasoning per row; the point of measuring it is to
// see whether calibration on ambiguous entries improves enough to pay for.
const THINKING = process.env.THINKING || 'low';

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['gemini-3.5-flash-lite', 'gemini-3.5-flash'];

// Per-million-token list prices, for a cost-per-pass estimate. Unknown models
// are reported as tokens only rather than guessed at.
const PRICES = {
  'gemini-3.5-flash-lite': [0.1, 0.4],
  'gemini-3.5-flash': [0.3, 2.5],
  'gemini-3.6-flash': [0.3, 2.5],
  'gemini-3.1-flash-lite': [0.1, 0.4],
  'gemini-3-flash-preview': [0.3, 2.5],
  'gemini-3.1-pro-preview': [2, 12],
  'gemini-3-pro-preview': [2, 12],
};

// ---------- build the batch from the real export ----------

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) =>
    Object.fromEntries(head.map((h, i) => [h, r[i]]))
  );
}

const csvPath = join(root, 'TransactionsLatest.csv');
if (!existsSync(csvPath)) {
  console.error(
    'TransactionsLatest.csv is not in the repo — it is personal data.\n' +
      'Drop your own Bluecoins export in the repo root to run the benchmark.'
  );
  process.exit(1);
}
const csv = parseCsv(readFileSync(csvPath, 'utf8').replace(/^﻿/, ''));
const byName = new Map();
for (const r of csv) if (!byName.has(r.Name)) byName.set(r.Name, r);

/* Cases are pinned to the real export by default, so amounts and directions
 * cannot drift into something convenient. A case may instead carry its own
 * `amount` — that is for entries typed into Hisaab itself, which postdate the
 * Bluecoins export and are the only evidence for behaviour the export never
 * exercised (a purchase someone else paid for, a category that did not exist).
 * They are still real entries, just from a newer source. */
const FALLBACK_AT = '2026-08-05 12:00:00.000';

const payload = CASES.map((c, i) => {
  const src = byName.get(c.name);
  if (!src && c.amount === undefined) {
    throw new Error(`Case not in the CSV and has no amount of its own: ${c.name}`);
  }
  const amount = src ? Number(src.Amount) : (c.dir === 'in' ? c.amount : -c.amount);
  return {
    id: `t${String(i + 1).padStart(3, '0')}`,
    text: c.name,
    amount_pkr: Math.abs(amount),
    direction: amount < 0 ? 'out' : 'in',
    at: src ? src.Date : FALLBACK_AT,
  };
});
const caseById = new Map(payload.map((p, i) => [p.id, CASES[i]]));
const idByName = new Map(payload.map((p) => [p.text, p.id]));

// Sanity: the fixture's assumed direction must match the real export.
for (let i = 0; i < CASES.length; i++) {
  const want = CASES[i].dir;
  if (want && want !== payload[i].direction) {
    throw new Error(`Fixture says ${CASES[i].name} is ${want}, CSV says ${payload[i].direction}`);
  }
}

// ---------- grading ----------

const norm = (s) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function nameMatches(expected, got) {
  const a = norm(expected), b = norm(got);
  if (!a || !b) return false;
  if (a === b) return true;
  // "Sister" vs "sis", "Mutahhar Bhai" vs "Mutahhar".
  return a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a);
}

function grade(results) {
  const byId = new Map();
  for (const r of results ?? []) if (typeof r?.id === 'string') byId.set(r.id, r);

  const score = {
    coverage: [0, payload.length],
    category: [0, 0],
    route: [0, 0],
    counterparty: [0, 0],
    ledger: [0, 0],
    display: [0, 0],
    calibration: [0, 0],
    collapse: [0, 0],
    distinct: [0, 0],
    overconfident: 0,
  };
  const misses = [];
  const note = (name, field, want, got) =>
    misses.push(`${field.padEnd(13)} ${name}  want ${JSON.stringify(want)}  got ${JSON.stringify(got)}`);

  for (const p of payload) {
    const c = caseById.get(p.id);
    const r = byId.get(p.id);
    if (!r) { misses.push(`missing       ${p.text}`); continue; }
    score.coverage[0]++;
    let wrong = false;

    if (Array.isArray(c.cat)) {
      score.category[1]++;
      if (c.cat.includes(r.category)) score.category[0]++;
      else { note(p.text, 'category', c.cat, r.category); wrong = true; }
    }

    if (c.route !== undefined && c.route !== 'any') {
      score.route[1]++;
      if (c.route === null) {
        if (r.route == null) score.route[0]++;
        else { note(p.text, 'route', null, r.route); wrong = true; }
      } else if (
        r.route &&
        norm(r.route.provider) === norm(c.route.provider) &&
        norm(r.route.from) === norm(c.route.from) &&
        norm(r.route.to) === norm(c.route.to)
      ) score.route[0]++;
      else { note(p.text, 'route', c.route, r.route); wrong = true; }
    }

    if (c.party !== undefined && c.party !== 'any') {
      score.counterparty[1]++;
      if (c.party === null) {
        if (r.counterparty == null) score.counterparty[0]++;
        else { note(p.text, 'counterparty', null, r.counterparty); wrong = true; }
      } else if (nameMatches(c.party, r.counterparty)) score.counterparty[0]++;
      else { note(p.text, 'counterparty', c.party, r.counterparty); wrong = true; }
    }

    if (c.ledger !== undefined && c.ledger !== 'any') {
      score.ledger[1]++;
      if ((c.ledger ?? null) === (r.ledger_effect ?? null)) score.ledger[0]++;
      else { note(p.text, 'ledger', c.ledger, r.ledger_effect); wrong = true; }
    }

    /* The tidy name shown in place of the raw text. Graded on every row for
     * presence — an empty one puts the user back to reading their own typos —
     * and against an exact expectation where the rewrite is the point of the
     * case. Whitespace and arrow style are normalised; wording is not. */
    score.display[1]++;
    const shown = typeof r.display_name === 'string' ? r.display_name.trim() : '';
    if (!shown) { note(p.text, 'display', 'non-empty', r.display_name); wrong = true; }
    else if (c.display && norm(shown).replace(/[→>-]+/g, '>') !== norm(c.display).replace(/[→>-]+/g, '>')) {
      note(p.text, 'display', c.display, shown);
      wrong = true;
    } else score.display[0]++;

    if (c.ambiguous) {
      score.calibration[1]++;
      if (typeof r.confidence === 'number' && r.confidence < 0.7) score.calibration[0]++;
      else note(p.text, 'confidence', '<0.7', r.confidence);
    }
    if (wrong && typeof r.confidence === 'number' && r.confidence >= 0.7) score.overconfident++;
  }

  const item = (name) => norm(byId.get(idByName.get(name))?.canonical_item);
  for (const group of COLLAPSE) {
    score.collapse[1]++;
    const seen = new Set(group.map(item));
    if (seen.size === 1) score.collapse[0]++;
    else misses.push(`collapse      ${group.join(' / ')}  ->  ${[...seen].join(' | ')}`);
  }
  for (const [a, b] of DISTINCT) {
    score.distinct[1]++;
    if (item(a) !== item(b)) score.distinct[0]++;
    else misses.push(`distinct      ${a} vs ${b}  both -> ${item(a)}`);
  }

  return { score, misses };
}

// ---------- run ----------

// COLD=1 empties the canonical lists — the state of the very first pass, where
// the model has nothing to reuse and must coin consistent names itself.
const known = process.env.COLD ? { items: [], routes: [], people: [] } : KNOWN;
const prompt = buildPrompt(known, payload);
const rows = [];

for (const model of MODELS) {
  process.stdout.write(`\n=== ${model} (thinking: ${THINKING}) `.padEnd(70, '=') + '\n');
  let out;
  try {
    out = await callGemini({
      apiKey: KEY, model, system: SYSTEM, prompt, schema: SCHEMA, thinkingLevel: THINKING,
    });
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    continue;
  }

  const { score, misses } = grade(out.data?.results);
  const inTok = out.usage.promptTokenCount ?? 0;
  const outTok = (out.usage.candidatesTokenCount ?? 0) + (out.usage.thoughtsTokenCount ?? 0);
  const price = PRICES[model];
  const cost = price ? (inTok / 1e6) * price[0] + (outTok / 1e6) * price[1] : null;

  const pct = ([got, total]) => (total ? `${got}/${total} ${Math.round((got / total) * 100)}%` : '—');
  const graded = ['category', 'route', 'counterparty', 'ledger', 'display', 'collapse', 'distinct'];
  const totals = graded.reduce(
    (acc, k) => [acc[0] + score[k][0], acc[1] + score[k][1]],
    [0, 0]
  );

  console.log(`  coverage      ${pct(score.coverage)}`);
  for (const k of graded) console.log(`  ${k.padEnd(13)} ${pct(score[k])}`);
  console.log(`  calibration   ${pct(score.calibration)}  (ambiguous rows correctly marked <0.7)`);
  console.log(`  overconfident ${score.overconfident} wrong answers at confidence >= 0.7`);
  console.log(`  OVERALL       ${pct(totals)}`);
  console.log(
    `  ${(out.ms / 1000).toFixed(1)}s · ${inTok} in / ${outTok} out tokens` +
      (cost === null ? '' : ` · $${cost.toFixed(5)} per pass of ${payload.length}`)
  );

  if (misses.length) {
    console.log(`\n  --- ${misses.length} misses ---`);
    for (const m of misses) console.log(`  ${m}`);
  }

  rows.push({
    model,
    overall: totals[1] ? Math.round((totals[0] / totals[1]) * 100) : 0,
    ...Object.fromEntries(graded.map((k) => [k, score[k][1] ? Math.round((score[k][0] / score[k][1]) * 100) : null])),
    calib: score.calibration[1] ? Math.round((score.calibration[0] / score.calibration[1]) * 100) : null,
    overconf: score.overconfident,
    seconds: Number((out.ms / 1000).toFixed(1)),
    cost: cost === null ? null : Number(cost.toFixed(5)),
  });
}

if (rows.length > 1) {
  console.log('\n\n=== summary '.padEnd(70, '=') + '\n');
  console.table(rows);
}
