/* Who owes what.
 *
 * Everything here is derived from transactions that carry a counterparty and a
 * ledger effect — there is no separate debt store to drift out of step. Reads
 * come from IndexedDB, so the ledger is correct offline and updates the instant
 * a split is captured, without waiting for a sync or an enrichment pass.
 */

import { allTransactions, settleCounterparty, settleTransaction } from '../db/local.js';
import { balances, ledgerTotals } from '../lib/ledger.js';
import { divergingLayout } from '../lib/chart.js';
import { formatMinor } from '../lib/money.js';
import { escapeHtml } from '../capture/entry.js';
import { ledgerLabel } from '../lib/label.js';
import { syncNow } from '../db/sync.js';

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

const EFFECT = {
  lent: 'you paid',
  repaid_by: 'they paid you back',
  borrowed: 'they paid',
  repaid_to: 'you paid them back',
};

/* Whose money it was, which is the thing a shared screenshot has to convey at a
 * glance. Red is every row that moves the balance towards them — what they paid
 * for you, and what they have already paid back — so the black column is what
 * you are still owed and the red column is what has come off it. This tracks
 * the ledger sign, not the direction: "chicken from sister" is an outgoing row
 * that she funded, and it belongs with the reimbursements. */
const THEIRS = new Set(['borrowed', 'repaid_by']);

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
      expense, then <code>reimbursement from tom 500</code> when they pay you back.
      The other way round works too: <code>chicken piece from harry 500</code> records
      that Harry paid and you owe him.</p>`;
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
    ${open.length >= 2 ? balancesChart(open) : ''}
    <div id="people"></div>`;

  const list = body.querySelector('#people');
  for (const person of open) list.append(card(person, body));

  if (square.length) {
    list.insertAdjacentHTML('beforeend', `<h3 class="group-head">Settled (${square.length})</h3>`);
    for (const person of square) list.append(card(person, body));
  }
}

/**
 * Everyone with an open balance, as diverging bars off a centre line: right and
 * green means they owe you, left and red means you owe them, and the length is
 * how much. It turns a scroll of names into one picture of where the exposure
 * is and which way it points. The side and the signed value carry the direction
 * — red/green alone would not survive a colour-vision check — and the numbers
 * still live in the list below, so this is the map, not the record.
 */
const DVW = 340;

function balancesChart(open) {
  const items = open.slice(0, 8); // balances() is already sorted by |net| desc.
  const lay = divergingLayout(items, {
    width: DVW,
    rowH: 22,
    gap: 8,
    labelW: 84,
    padRight: 64,
    value: (p) => p.netMinor,
  });
  const rows = lay.rows
    .map((r) => {
      const mid = r.y + r.h / 2 + 3;
      const sign = r.positive ? '+' : '−';
      return `
        <text class="dv-label" x="0" y="${mid}">${escapeHtml(r.item.name)}</text>
        <rect class="dv-bar ${r.positive ? 'pos' : 'neg'}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="2" />
        <text class="dv-value" x="${DVW - 4}" y="${mid}" text-anchor="end">${sign}${formatMinor(
          Math.abs(r.value)
        )}</text>`;
    })
    .join('');

  return `<div class="card">
    <h3>Where it stands</h3>
    <svg class="dv-chart" viewBox="0 0 ${DVW} ${lay.height}" role="img"
      aria-label="Net balance for each person">
      <line class="dv-mid" x1="${lay.cx}" y1="0" x2="${lay.cx}" y2="${lay.height}" />
      ${rows}
    </svg>
    <p class="hint">Right of the line they owe you; left, you owe them.${
      open.length > items.length ? ` Top ${items.length} shown.` : ''
    }</p>
  </div>`;
}

function card(person, body) {
  const owed = person.netMinor > 0;
  const el = document.createElement('details');
  el.className = 'person';
  el.dataset.key = person.key;

  // Each entry can be written off on its own. Buying someone four things and
  // meaning one as a gift is ordinary, and settling the whole person would
  // erase the three that are still owed.
  const entries = person.rows
    .map(
      (r) => `
      <li class="${r.ledger_settled ? 'settled' : ''}">
        <span class="l-name">${escapeHtml(ledgerLabel(r))}</span>
        <span class="l-meta">${DAY.format(new Date(r.occurred_at))} · ${EFFECT[r.ledger_effect] ?? r.ledger_effect}${
          r.ledger_settled ? ' · written off' : ''
        }</span>
        <span class="l-amt ${THEIRS.has(r.ledger_effect) ? 'theirs' : 'mine'}">${
          THEIRS.has(r.ledger_effect) ? '−' : ''
        }${formatMinor(r.amount_minor)}</span>
        <button type="button" class="l-settle link" data-row="${r.id}" data-settled="${r.ledger_settled ? 1 : 0}"
          aria-label="${r.ledger_settled ? 'Count' : 'Do not count'} ${escapeHtml(ledgerLabel(r))} in the balance">
          ${r.ledger_settled ? 'Count it' : 'Write off'}
        </button>
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

  for (const btn of el.querySelectorAll('.l-settle')) {
    btn.addEventListener('click', async (e) => {
      // The row sits inside <details>; without this the panel snaps shut.
      e.preventDefault();
      btn.disabled = true;
      await settleTransaction(btn.dataset.row, { settled: btn.dataset.settled === '1' ? 0 : 1 });
      syncNow().catch(() => {});
      await paint(body);
      // Keep the person the user was working in open across the repaint.
      body.querySelector(`.person[data-key="${CSS.escape(person.key)}"]`)?.setAttribute('open', '');
    });
  }

  return el;
}
