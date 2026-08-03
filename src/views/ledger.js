/* Who owes what.
 *
 * Everything here is derived from transactions that carry a counterparty and a
 * ledger effect — there is no separate debt store to drift out of step. Reads
 * come from IndexedDB, so the ledger is correct offline and updates the instant
 * a split is captured, without waiting for a sync or an enrichment pass.
 */

import { allTransactions, settleCounterparty } from '../db/local.js';
import { balances, ledgerTotals } from '../lib/ledger.js';
import { formatMinor } from '../lib/money.js';
import { escapeHtml } from '../capture/entry.js';
import { syncNow } from '../db/sync.js';

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

const EFFECT = {
  lent: 'you paid',
  repaid_by: 'they paid you back',
  borrowed: 'they paid',
  repaid_to: 'you paid them back',
};

export async function renderLedger(root) {
  root.innerHTML = `
    <section class="ledger">
      <h2>Ledger</h2>
      <div id="ledger-body"><p class="empty">Loading…</p></div>
    </section>`;
  await paint(root.querySelector('#ledger-body'));
}

async function paint(body) {
  const rows = await allTransactions();
  const people = balances(rows);
  const open = people.filter((p) => p.netMinor !== 0);
  const square = people.filter((p) => p.netMinor === 0);

  if (!people.length) {
    body.innerHTML = `
      <p class="empty">Nothing owed either way.</p>
      <p class="hint">Type <code>cake for tom, dick, harry 2500</code> to split a shared
      expense, then <code>reimbursement from tom 500</code> when they pay you back.</p>`;
    return;
  }

  const totals = ledgerTotals(open);
  body.innerHTML = `
    <div class="card ledger-totals">
      <dl>
        <dt>Owed to you</dt><dd class="in">${formatMinor(totals.owedToMeMinor)}</dd>
        <dt>You owe</dt><dd class="out">${formatMinor(totals.iOweMinor)}</dd>
      </dl>
    </div>
    <div id="people"></div>`;

  const list = body.querySelector('#people');
  for (const person of open) list.append(card(person, body));

  if (square.length) {
    list.insertAdjacentHTML('beforeend', `<h3 class="group-head">Settled (${square.length})</h3>`);
    for (const person of square) list.append(card(person, body));
  }
}

function card(person, body) {
  const owed = person.netMinor > 0;
  const el = document.createElement('details');
  el.className = 'person';

  const entries = person.rows
    .map(
      (r) => `
      <li class="${r.ledger_settled ? 'settled' : ''}">
        <span class="l-name">${escapeHtml(r.raw_name)}</span>
        <span class="l-meta">${DAY.format(new Date(r.occurred_at))} · ${EFFECT[r.ledger_effect] ?? r.ledger_effect}${
          r.ledger_settled ? ' · written off' : ''
        }</span>
        <span class="l-amt ${r.direction}">${formatMinor(r.amount_minor)}</span>
      </li>`
    )
    .join('');

  el.innerHTML = `
    <summary>
      <span class="p-name">${escapeHtml(person.name)}</span>
      <span class="p-net ${person.netMinor === 0 ? '' : owed ? 'in' : 'out'}">
        ${
          person.netMinor === 0
            ? 'square'
            : `${owed ? 'owes you' : 'you owe'} ${formatMinor(Math.abs(person.netMinor))}`
        }
      </span>
    </summary>
    <ul class="ledger-rows">${entries}</ul>
    <div class="p-actions">
      <button type="button" data-act="${person.settledCount && !person.openCount ? 'reopen' : 'settle'}">
        ${person.settledCount && !person.openCount ? 'Reopen' : 'Call it square'}
      </button>
    </div>`;

  el.querySelector('button[data-act]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    await settleCounterparty(person.key, { settled: btn.dataset.act === 'settle' ? 1 : 0 });
    syncNow().catch(() => {});
    await paint(body);
  });

  return el;
}
