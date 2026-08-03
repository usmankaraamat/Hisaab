/* Full-scale coverage check: the whole 397-row export, chunked.
 *
 * The graded benchmark uses 66 rows. The failure this catches is different and
 * only appears at size — a batch large enough to run the response into the
 * output-token ceiling, which truncates JSON and silently loses transactions.
 *
 *   node scripts/eval/scale.mjs [model] [chunkSize]
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SCHEMA, SYSTEM, buildPrompt } from '../../supabase/functions/enrich/prompt.js';
import { callGemini } from '../../supabase/functions/enrich/gemini.js';
import { KNOWN } from './cases.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('Set GEMINI_API_KEY first.'); process.exit(1); }

const MODEL = process.argv[2] || 'gemini-3.5-flash-lite';
const CHUNK = Number(process.argv[3] || 120);

const csvPath = join(root, 'TransactionsLatest.csv');
if (!existsSync(csvPath)) {
  console.error('TransactionsLatest.csv is not in the repo — drop your own export in the root.');
  process.exit(1);
}
const lines = readFileSync(csvPath, 'utf8').replace(/^﻿/, '').split('\n');
const rows = lines.slice(1).filter(Boolean).map((l) => {
  const f = l.match(/"([^"]*)"/g).map((s) => s.slice(1, -1));
  return { name: f[3], amount: Number(f[4]), at: f[1] };
});

const payload = rows.map((r, i) => ({
  id: `t${String(i + 1).padStart(3, '0')}`,
  text: r.name,
  amount_pkr: Math.abs(r.amount),
  direction: r.amount < 0 ? 'out' : 'in',
  at: r.at,
}));

console.log(`${payload.length} rows, chunks of ${CHUNK}, model ${MODEL}\n`);

const seen = new Map();
let inTok = 0, outTok = 0, ms = 0;

for (let i = 0; i < payload.length; i += CHUNK) {
  const slice = payload.slice(i, i + CHUNK);
  const out = await callGemini({
    apiKey: KEY, model: MODEL, system: SYSTEM,
    prompt: buildPrompt(KNOWN, slice), schema: SCHEMA,
    maxOutputTokens: 65536,
  });
  inTok += out.usage.promptTokenCount ?? 0;
  outTok += (out.usage.candidatesTokenCount ?? 0) + (out.usage.thoughtsTokenCount ?? 0);
  ms += out.ms;

  const got = out.data?.results ?? [];
  for (const r of got) if (typeof r?.id === 'string') seen.set(r.id, r);
  const ids = new Set(slice.map((s) => s.id));
  const missing = slice.filter((s) => !got.some((r) => r.id === s.id));
  const alien = got.filter((r) => !ids.has(r.id));
  console.log(
    `  chunk ${String(i / CHUNK + 1).padStart(2)}: ${slice.length} sent, ${got.length} back, ` +
      `${missing.length} missing, ${alien.length} out-of-batch, ${(out.ms / 1000).toFixed(1)}s, ` +
      `${out.usage.candidatesTokenCount} out-tokens`
  );
  if (missing.length) console.log('    missing: ' + missing.map((m) => m.text).join(', '));
}

const missed = payload.filter((p) => !seen.has(p.id));
const cost = (inTok / 1e6) * 0.1 + (outTok / 1e6) * 0.4;

console.log(`\ncoverage ${seen.size}/${payload.length}` + (missed.length ? ` — MISSING ${missed.length}` : ' ✓'));
for (const m of missed.slice(0, 20)) console.log(`  ${m.text}`);

// How many distinct canonical entities came out of the whole export? Runaway
// near-duplicates are the failure that makes the item list useless over time.
const items = new Set(), routes = new Set(), people = new Set();
for (const r of seen.values()) {
  if (r.canonical_item) items.add(String(r.canonical_item).toLowerCase());
  if (r.route) routes.add(`${r.route.provider}|${r.route.from}|${r.route.to}`.toLowerCase());
  if (r.counterparty) people.add(String(r.counterparty).toLowerCase());
}
console.log(`\n${items.size} canonical items (from ${new Set(rows.map((r) => r.name)).size} distinct raw names)`);
console.log(`${routes.size} routes, ${people.size} people`);
console.log([...people].sort().join(', '));
console.log(`\n${(ms / 1000).toFixed(1)}s total · ${inTok} in / ${outTok} out · $${cost.toFixed(4)} for the whole backfill`);
