/* Batched enrichment.
 *
 * Runs on Supabase Edge Functions so the Gemini key stays server-side — it is
 * never shipped to the browser, and the client never talks to
 * generativelanguage.googleapis.com directly.
 *
 * The function is called with the signed-in user's JWT and builds its Supabase
 * client from that token, so every query is scoped by RLS to the caller's own
 * rows. No service-role key is needed anywhere in this path.
 *
 * Nothing is written onto a transaction here. Results land in
 * `enrichment_proposals` with status 'pending'; the review screen is what
 * promotes them. A bad pass costs one tap to reject, never a corrupted ledger.
 *
 * Model choice is measured, not assumed — see scripts/eval/. gemini-3.5-flash-lite
 * scored 100% on categories, routes, counterparties and ledger effects across a
 * 66-case benchmark of the hardest real entries, matching gemini-3.5-flash at a
 * fifth of the cost and half the latency.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SCHEMA, SYSTEM, buildPrompt } from './prompt.js';
import { callGemini, GeminiError } from './gemini.js';

const MODEL = 'gemini-3.5-flash-lite';
const MAX_BATCH = 400;
// 120 rows costs ~9.5k output tokens, comfortably inside the ceiling. Measured
// at full scale in scripts/eval/scale.mjs: 397/397 rows returned, none dropped.
const CHUNK = 120;

interface Known { items: string[]; routes: string[]; people: string[] }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
    },
  });
}

/** One chunk, with a single retry on the transient 429/503 the free tier throws. */
async function enrichChunk(apiKey: string, known: Known, slice: unknown[]) {
  const args = {
    apiKey,
    model: MODEL,
    system: SYSTEM,
    prompt: buildPrompt(known, slice),
    schema: SCHEMA,
    maxOutputTokens: 65536,
  };
  try {
    return await callGemini(args);
  } catch (err) {
    if (err instanceof GeminiError && err.retryable) {
      await new Promise((r) => setTimeout(r, 2000));
      return await callGemini(args);
    }
    throw err;
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'POST, OPTIONS',
      },
    });
  }

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Missing Authorization header.' }, 401);

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) return json({ error: 'GEMINI_API_KEY is not set on the function.' }, 500);

  // Built from the caller's JWT, so RLS scopes every query below to them.
  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authorization } } }
  );

  const { data: auth } = await db.auth.getUser();
  const user = auth?.user;
  if (!user) return json({ error: 'Not signed in.' }, 401);

  const body = await request.json().catch(() => ({}));
  const limit = Math.min(Number(body.limit) || MAX_BATCH, MAX_BATCH);

  const [{ data: pending, error: pendingError }, { data: items }, { data: routes }, { data: people }] =
    await Promise.all([
      db
        .from('transactions')
        .select('id, raw_name, amount_minor, direction, occurred_at')
        .is('enriched_at', null)
        .eq('deleted', false)
        .order('occurred_at', { ascending: true })
        .limit(limit),
      db.from('items').select('canonical_name, category'),
      db.from('routes').select('provider, from_place, to_place'),
      db.from('people').select('display_name'),
    ]);

  if (pendingError) return json({ error: pendingError.message }, 500);
  if (!pending?.length) return json({ enriched: 0, message: 'Nothing pending.' });

  // Drop rows that already have an open proposal, so a re-run is cheap.
  const { data: open } = await db
    .from('enrichment_proposals')
    .select('transaction_id')
    .eq('status', 'pending');
  const alreadyProposed = new Set((open ?? []).map((p) => p.transaction_id));
  const batch = pending.filter((t) => !alreadyProposed.has(t.id));
  if (!batch.length) return json({ enriched: 0, message: 'All pending rows already have proposals.' });

  const known: Known = {
    items: (items ?? []).map((i) => i.canonical_name),
    routes: (routes ?? []).map((r) => `${r.provider}: ${r.from_place} -> ${r.to_place}`),
    people: (people ?? []).map((p) => p.display_name),
  };

  const payload = batch.map((t) => ({
    id: t.id,
    text: t.raw_name,
    amount_pkr: t.amount_minor / 100,
    direction: t.direction,
    at: t.occurred_at,
  }));

  const validIds = new Set(batch.map((t) => t.id));
  const results: Array<Record<string, unknown>> = [];
  let inTokens = 0;
  let outTokens = 0;

  for (let i = 0; i < payload.length; i += CHUNK) {
    let out;
    try {
      out = await enrichChunk(geminiKey, known, payload.slice(i, i + CHUNK));
    } catch (err) {
      // Keep whatever earlier chunks produced rather than losing the whole pass.
      if (!results.length) return json({ error: `Gemini call failed: ${(err as Error).message}` }, 502);
      break;
    }

    inTokens += out.usage.promptTokenCount ?? 0;
    outTokens += (out.usage.candidatesTokenCount ?? 0) + (out.usage.thoughtsTokenCount ?? 0);

    const chunk = ((out.data as { results?: Array<Record<string, unknown>> })?.results ?? [])
      .filter((r) => typeof r.id === 'string' && validIds.has(r.id as string));
    results.push(...chunk);

    // Entities this chunk invented become canonical for the next one. Without
    // this each chunk starts cold and coins its own near-duplicates.
    for (const r of chunk) {
      const item = r.canonical_item as string | undefined;
      if (item && !known.items.includes(item)) known.items.push(item);
      const route = r.route as { provider: string; from: string; to: string } | null | undefined;
      if (route?.provider) {
        const line = `${route.provider}: ${route.from} -> ${route.to}`;
        if (!known.routes.includes(line)) known.routes.push(line);
      }
      const person = r.counterparty as string | undefined;
      if (person && !known.people.includes(person)) known.people.push(person);
    }
  }

  // Last write wins if the model somehow repeats an id across chunks.
  const byId = new Map(results.map((r) => [r.id as string, r]));
  const proposals = [...byId.values()].map((r) => ({
    user_id: user.id,
    transaction_id: r.id as string,
    proposed: {
      category: r.category,
      canonical_item: r.canonical_item,
      route: r.route,
      counterparty: r.counterparty,
      ledger_effect: r.ledger_effect,
    },
    confidence: typeof r.confidence === 'number' ? r.confidence : null,
    model: MODEL,
    status: 'pending',
  }));

  if (!proposals.length) return json({ error: 'Model returned no usable results.' }, 502);

  const { error: writeError } = await db.from('enrichment_proposals').insert(proposals);
  if (writeError) return json({ error: writeError.message }, 500);

  return json({
    enriched: proposals.length,
    requested: batch.length,
    missing: batch.length - proposals.length,
    model: MODEL,
    tokens: { input: inTokens, output: outTokens },
  });
});
