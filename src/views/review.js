/* The nightly review.
 *
 * This is where enrichment becomes a 10-second passive habit instead of
 * per-entry friction. Confident proposals accept in one tap as a block; only
 * the uncertain ones ask for attention individually.
 */

import { supabase, currentUser, isConfigured } from '../db/supabase.js';
import { escapeHtml } from '../capture/entry.js';
import { formatMinor } from '../lib/money.js';
import { syncNow } from '../db/sync.js';
import { invalidate } from '../capture/predict.js';

const CONFIDENT = 0.7;

export async function renderReview(root) {
  root.innerHTML = `
    <section class="review">
      <h2>Review</h2>
      <div id="review-body"><p class="empty">Loading…</p></div>
    </section>`;
  await paint(root.querySelector('#review-body'));
}

async function paint(body) {
  if (!isConfigured()) {
    body.innerHTML =
      '<p class="hint">Sync is not configured, so there is nothing to review yet. Enrichment runs server-side.</p>';
    return;
  }

  const sb = await supabase();
  const user = await currentUser();
  if (!user) {
    body.innerHTML = '<p class="hint">Sign in on the Settings tab to run enrichment.</p>';
    return;
  }

  const [{ count: pendingTxns }, { data: proposals, error }] = await Promise.all([
    sb
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .is('enriched_at', null)
      .eq('deleted', false),
    sb
      .from('enrichment_proposals')
      .select('id, transaction_id, proposed, confidence, transactions(raw_name, amount_minor, direction, occurred_at)')
      .eq('status', 'pending')
      .order('confidence', { ascending: true }),
  ]);

  if (error) {
    body.innerHTML = `<p class="warn">${escapeHtml(error.message)}</p>`;
    return;
  }

  const waiting = proposals ?? [];
  const confident = waiting.filter((p) => (p.confidence ?? 0) >= CONFIDENT);
  const uncertain = waiting.filter((p) => (p.confidence ?? 0) < CONFIDENT);

  body.innerHTML = `
    <div class="card">
      <dl>
        <dt>Not yet categorised</dt><dd>${pendingTxns ?? 0}</dd>
        <dt>Waiting on you</dt><dd>${waiting.length}</dd>
      </dl>
      <p id="run-msg" class="hint"></p>
      <button type="button" id="run">Categorise now</button>
      ${confident.length ? `<button type="button" id="accept-all">Accept ${confident.length} confident</button>` : ''}
    </div>
    <div id="list"></div>`;

  const msg = body.querySelector('#run-msg');

  body.querySelector('#run').addEventListener('click', async () => {
    msg.className = 'hint';
    msg.textContent = 'Categorising…';
    try {
      const { data, error: fnError } = await sb.functions.invoke('enrich', { body: { limit: 300 } });
      if (fnError) throw fnError;
      if (data?.error) throw new Error(data.error);
      msg.className = 'ok';
      msg.textContent = data?.enriched
        ? `${data.enriched} proposal(s) ready.`
        : (data?.message ?? 'Nothing to do.');
      await paint(body);
    } catch (err) {
      msg.className = 'warn';
      msg.textContent = err.message;
    }
  });

  body.querySelector('#accept-all')?.addEventListener('click', async () => {
    msg.className = 'hint';
    msg.textContent = 'Applying…';
    const { data, error: rpcError } = await sb.rpc('accept_pending', { min_confidence: CONFIDENT });
    if (rpcError) {
      msg.className = 'warn';
      msg.textContent = rpcError.message;
      return;
    }
    msg.className = 'ok';
    msg.textContent = `Applied ${data} proposal(s).`;
    await syncNow().catch(() => {});
    invalidate();
    await paint(body);
  });

  const list = body.querySelector('#list');
  if (!waiting.length) {
    list.innerHTML = '<p class="empty">Nothing waiting. Tap “Categorise now” if rows are pending.</p>';
    return;
  }

  if (uncertain.length) {
    list.insertAdjacentHTML(
      'beforeend',
      `<h3 class="group-head">Needs a look (${uncertain.length})</h3>`
    );
  }
  for (const p of uncertain) list.append(card(p, body));

  if (confident.length) {
    list.insertAdjacentHTML(
      'beforeend',
      `<h3 class="group-head">Confident (${confident.length})</h3>`
    );
  }
  for (const p of confident) list.append(card(p, body));
}

function card(p, body) {
  const t = p.transactions || {};
  const prop = p.proposed || {};
  const bits = [
    prop.category,
    prop.canonical_item && prop.canonical_item !== prop.category ? prop.canonical_item : null,
    prop.route ? `${prop.route.from} → ${prop.route.to}` : null,
    prop.counterparty ? `${prop.counterparty}${prop.ledger_effect ? ` (${prop.ledger_effect.replace('_', ' ')})` : ''}` : null,
  ].filter(Boolean);

  const el = document.createElement('div');
  el.className = 'proposal';
  el.innerHTML = `
    <div class="p-head">
      <span class="p-raw">${escapeHtml(t.raw_name ?? '')}</span>
      <span class="p-amt">${t.amount_minor != null ? formatMinor(t.amount_minor) : ''}</span>
    </div>
    <div class="p-tags">${bits.map((b) => `<span class="tag">${escapeHtml(b)}</span>`).join('')}</div>
    <div class="p-actions">
      <span class="p-conf">${p.confidence != null ? `${Math.round(p.confidence * 100)}%` : '—'}</span>
      <button type="button" data-act="reject">Reject</button>
      <button type="button" data-act="accept">Accept</button>
    </div>`;

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const sb = await supabase();
    const fn = btn.dataset.act === 'accept' ? 'accept_proposal' : 'reject_proposal';
    btn.disabled = true;
    const { error } = await sb.rpc(fn, { p_id: p.id });
    if (error) {
      btn.disabled = false;
      return;
    }
    await syncNow().catch(() => {});
    invalidate();
    await paint(body);
  });

  return el;
}
