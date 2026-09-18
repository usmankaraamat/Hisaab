import { allTransactions, getMeta, newId, setMeta, updateTransaction } from '../db/local.js';
import { parseRoute } from '../capture/normalize.js';
import { CATEGORIES } from '../lib/categories.js';
import { SCHEMA, SYSTEM, buildPrompt } from '../../supabase/functions/enrich/prompt.js';
import { callGemini } from '../../supabase/functions/enrich/gemini.js';

const META_KEY = 'enrichment.localProposals';
const MODEL = 'gemini-3.5-flash-lite';
const MAX_BATCH = 300;
const CHUNK = 80;
const LEDGER_EFFECTS = new Set(['lent', 'borrowed', 'repaid_by', 'repaid_to']);

function cleanProposal(result, transaction) {
  if (!result || result.id !== transaction.id || !CATEGORIES.includes(result.category)) return null;
  const route = result.route && typeof result.route === 'object'
    && result.route.provider && result.route.from && result.route.to
    ? {
        provider: String(result.route.provider).trim(),
        from: String(result.route.from).trim(),
        to: String(result.route.to).trim(),
      }
    : null;
  const settled = transaction.counterparty_name
    ? { counterparty: transaction.counterparty_name, ledger_effect: transaction.ledger_effect }
    : null;
  const confidence = Number(result.confidence);
  return {
    category: result.category,
    display_name: String(result.display_name || transaction.raw_name).trim(),
    canonical_item: String(result.canonical_item || '').trim() || null,
    route,
    counterparty: settled?.counterparty || (String(result.counterparty || '').trim() || null),
    ledger_effect: settled?.ledger_effect
      || (LEDGER_EFFECTS.has(result.ledger_effect) ? result.ledger_effect : null),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
  };
}

async function stored() {
  const value = await getMeta(META_KEY, []);
  return Array.isArray(value) ? value : [];
}

export async function localProposals() {
  const [proposals, rows] = await Promise.all([stored(), allTransactions()]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const live = proposals
    .filter((proposal) => {
      const row = byId.get(proposal.transaction_id);
      return row && !row.deleted && !row.enriched_at;
    })
    .map((proposal) => ({
      ...proposal,
      local: true,
      transactions: byId.get(proposal.transaction_id),
    }));
  if (live.length !== proposals.length) {
    await setMeta(META_KEY, live.map(({ transactions, ...proposal }) => proposal));
  }
  return live;
}

export async function countLocalProposals() {
  return (await localProposals()).length;
}

export async function countLocalPending() {
  const rows = await allTransactions();
  return rows.filter((row) => !row.deleted && !row.enriched_at).length;
}

export async function generateLocalProposals(apiKey, { limit = MAX_BATCH } = {}) {
  if (!apiKey) throw new Error('Add your Gemini key in Settings first.');
  const [rows, existing] = await Promise.all([allTransactions(), stored()]);
  const proposedIds = new Set(existing.map((proposal) => proposal.transaction_id));
  const pending = rows
    .filter((row) => !row.deleted && !row.enriched_at && !proposedIds.has(row.id))
    .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)))
    .slice(0, Math.min(Number(limit) || MAX_BATCH, MAX_BATCH));
  if (!pending.length) return { enriched: 0, message: existing.length ? 'Everything pending already has a suggestion.' : 'Nothing pending.' };

  const itemNames = new Set();
  const routes = new Set();
  const people = new Set();
  for (const row of rows) {
    if (row.display_name || row.category) itemNames.add(row.display_name || row.raw_name);
    const route = parseRoute(row.display_name || row.raw_name);
    if (route) routes.add(`${route.provider}: ${route.from} -> ${route.to}`);
    if (row.counterparty_name) people.add(row.counterparty_name);
  }
  const known = { items: [...itemNames], routes: [...routes], people: [...people] };
  const payload = pending.map((row) => ({
    id: row.id,
    text: row.raw_name,
    amount_pkr: row.amount_minor / 100,
    direction: row.direction,
    at: row.occurred_at,
    ...(row.counterparty_name
      ? { settled: { counterparty: row.counterparty_name, ledger_effect: row.ledger_effect } }
      : {}),
  }));
  const byId = new Map(pending.map((row) => [row.id, row]));
  const results = new Map();

  for (let i = 0; i < payload.length; i += CHUNK) {
    const out = await callGemini({
      apiKey,
      model: MODEL,
      system: SYSTEM,
      prompt: buildPrompt(known, payload.slice(i, i + CHUNK)),
      schema: SCHEMA,
      maxOutputTokens: 65536,
    });
    for (const result of out.data?.results ?? []) {
      const transaction = byId.get(result.id);
      if (!transaction) continue;
      const proposed = cleanProposal(result, transaction);
      if (!proposed) continue;
      results.set(transaction.id, {
        id: newId(),
        transaction_id: transaction.id,
        proposed: {
          category: proposed.category,
          display_name: proposed.display_name,
          canonical_item: proposed.canonical_item,
          route: proposed.route,
          counterparty: proposed.counterparty,
          ledger_effect: proposed.ledger_effect,
        },
        confidence: proposed.confidence,
        model: MODEL,
        created_at: new Date().toISOString(),
        local: true,
      });
    }
  }

  const generated = [...results.values()];
  if (!generated.length) throw new Error('Gemini returned no usable suggestions.');
  await setMeta(META_KEY, [...existing, ...generated]);
  return { enriched: generated.length, personal: true };
}

export async function resolveLocalProposal(id, { accept }) {
  const proposals = await stored();
  const proposal = proposals.find((item) => item.id === id);
  if (!proposal) return false;
  const now = new Date().toISOString();
  const proposed = proposal.proposed || {};
  const patch = accept
    ? {
        category: proposed.category || null,
        display_name: proposed.display_name || null,
        counterparty_name: proposed.counterparty || null,
        ledger_effect: proposed.ledger_effect || null,
        enriched_at: now,
        enriched: 1,
        enrichment_version: 1,
      }
    : { enriched_at: now, enriched: 1 };
  await updateTransaction(proposal.transaction_id, patch);
  await setMeta(META_KEY, proposals.filter((item) => item.id !== id));
  return true;
}

export async function acceptLocalConfident(minConfidence = 0.7) {
  const proposals = await stored();
  const ids = proposals
    .filter((proposal) => (proposal.confidence ?? 0) >= minConfidence)
    .map((proposal) => proposal.id);
  for (const id of ids) await resolveLocalProposal(id, { accept: true });
  return ids.length;
}
