/* Insights and the people ledger.
 *
 * The insights half runs entirely on local data via the deterministic group
 * key, so it works offline and before any enrichment has run. The ledger half
 * needs enrichment, because working out that "Loan from Khuzaima" and "Loan
 * return to Khuzaima" are opposite sides of one balance is exactly the
 * judgement the model is there for.
 */

import { allTransactions } from '../db/local.js';
import { rideSurge, priceIndex, subscriptions, monthlyTotals } from '../lib/insights.js';
import { formatMinor } from '../lib/money.js';
import { escapeHtml } from '../capture/entry.js';
import { supabase, currentUser, isConfigured } from '../db/supabase.js';

const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export async function renderInsights(root) {
  root.innerHTML = `
    <section class="insights">
      <h2>Insights</h2>
      <div id="ledger"></div>
      <div id="local"></div>
    </section>`;

  await Promise.all([
    paintLocal(root.querySelector('#local')),
    paintLedger(root.querySelector('#ledger')),
  ]);
}

async function paintLocal(host) {
  const rows = await allTransactions();
  if (!rows.length) {
    host.innerHTML = '<p class="empty">Nothing to analyse yet.</p>';
    return;
  }

  const months = monthlyTotals(rows);
  const subs = subscriptions(rows);
  const surge = rideSurge(rows).filter((r) => r.overpaidCount > 0);
  const prices = priceIndex(rows).filter((p) => Math.abs(p.changePct) >= 15);

  host.innerHTML = `
    ${section(
      'Monthly spend',
      months.length
        ? months
            .slice()
            .reverse()
            .map(
              (m) => `<div class="row"><span>${MONTH.format(new Date(`${m.month}-01T12:00:00`))}</span>
                      <span class="num">${formatMinor(m.totalMinor)}</span></div>`
            )
            .join('')
        : '<p class="empty">No spending recorded.</p>'
    )}

    ${section(
      'Recurring charges',
      subs.length
        ? subs
            .map(
              (s) => `<div class="row">
                <span>${escapeHtml(s.label)}
                  <small>${s.cadence} · next ${DATE.format(new Date(s.nextDue))}${
                    s.lapsed ? ' · <b class="warn-text">stopped?</b>' : ''
                  }</small>
                </span>
                <span class="num">${formatMinor(s.lastMinor)}${
                  s.priceChanged
                    ? `<small>was ${formatMinor(s.minMinor)}–${formatMinor(s.maxMinor)}</small>`
                    : ''
                }</span>
              </div>`
            )
            .join('')
        : '<p class="empty">No regular charges detected yet.</p>'
    )}

    ${section(
      'Ride fares',
      surge.length
        ? surge
            .map(
              (r) => `<div class="row">
                <span>${escapeHtml(r.label)}
                  <small>${r.count} rides · usually ${formatMinor(r.medianMinor)}</small>
                </span>
                <span class="num">+${formatMinor(r.overpaidMinor)}<small>over ${r.overpaidCount} ride${
                  r.overpaidCount === 1 ? '' : 's'
                }</small></span>
              </div>`
            )
            .join('')
        : '<p class="empty">No unusual fares.</p>',
      'What you paid above the usual fare for each route.'
    )}

    ${section(
      'Price changes',
      prices.length
        ? prices
            .map(
              (p) => `<div class="row">
                <span>${escapeHtml(p.label)}<small>${p.count} purchases over ${p.spanDays} days</small></span>
                <span class="num ${p.changePct > 0 ? 'up' : 'down'}">${p.changePct > 0 ? '+' : ''}${p.changePct}%
                  <small>${formatMinor(p.earlyMinor)} → ${formatMinor(p.lateMinor)}</small>
                </span>
              </div>`
            )
            .join('')
        : '<p class="empty">Not enough repeat purchases yet.</p>',
      'Median of your earliest purchases against your most recent.'
    )}`;
}

function section(title, inner, hint = '') {
  return `<div class="card">
    <h3>${title}</h3>
    ${hint ? `<p class="hint">${hint}</p>` : ''}
    ${inner}
  </div>`;
}

/** Positive means they owe you; negative means you owe them. */
const EFFECT = { lent: 1, borrowed: -1, repaid_by: -1, repaid_to: 1 };

async function paintLedger(host) {
  if (!isConfigured()) {
    host.innerHTML = '';
    return;
  }

  const user = await currentUser();
  if (!user) {
    host.innerHTML = section(
      'People',
      '<p class="hint">Sign in and run a categorise pass to build the ledger from your loan and reimbursement entries.</p>'
    );
    return;
  }

  const sb = await supabase();
  const { data, error } = await sb
    .from('transactions')
    .select('amount_minor, ledger_effect, occurred_at, raw_name, people:counterparty_id (display_name)')
    .not('counterparty_id', 'is', null)
    .not('ledger_effect', 'is', null)
    .eq('deleted', false)
    .order('occurred_at', { ascending: false });

  if (error) {
    host.innerHTML = section('People', `<p class="warn">${escapeHtml(error.message)}</p>`);
    return;
  }

  if (!data?.length) {
    host.innerHTML = section(
      'People',
      '<p class="hint">Nothing yet. Run a categorise pass on the Review tab — loans and reimbursements get picked out of what you typed.</p>'
    );
    return;
  }

  const balances = new Map();
  for (const row of data) {
    const name = row.people?.display_name;
    const sign = EFFECT[row.ledger_effect];
    if (!name || !sign) continue;
    const b = balances.get(name) || { name, net: 0, entries: [] };
    b.net += sign * row.amount_minor;
    b.entries.push(row);
    balances.set(name, b);
  }

  const people = [...balances.values()]
    .filter((b) => b.net !== 0 || b.entries.length)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  host.innerHTML = section(
    'People',
    people
      .map(
        (b) => `<div class="row">
          <span>${escapeHtml(b.name)}<small>${b.entries.length} entr${
            b.entries.length === 1 ? 'y' : 'ies'
          } · last ${DATE.format(new Date(b.entries[0].occurred_at))}</small></span>
          <span class="num ${b.net > 0 ? 'up' : b.net < 0 ? 'down' : ''}">${
            b.net === 0 ? 'settled' : formatMinor(Math.abs(b.net))
          }<small>${b.net > 0 ? 'owes you' : b.net < 0 ? 'you owe' : ''}</small></span>
        </div>`
      )
      .join(''),
    'Built from your loan and reimbursement entries.'
  );
}
