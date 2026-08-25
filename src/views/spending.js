/* Spending: what is left, where it went, and what is coming.
 *
 * This replaces the old Insights tab rather than sitting beside it. Insights
 * answered questions nobody had asked yet — price drift, fare outliers — while
 * the question that actually motivated tracking ("how much do I have left?")
 * had no answer anywhere in the app. So the balance leads, the analysis it used
 * to show follows underneath, and the tab count stays where it was.
 *
 * The old Insights also carried a second, server-side people ledger. That is
 * now the Ledger tab's job, and it is gone from here: two screens computing the
 * same balance by different routes is a bug waiting to be reported — and one
 * that was in fact reported, when a sister read 4,050 on one screen and 4,600 on
 * the other. So the division is now absolute. Anything still owed, either way,
 * belongs to the Ledger and appears in no figure here. Anything written off has
 * stopped being a balance and become an expense, and appears here under one
 * heading.
 *
 * Everything on this screen reads IndexedDB, so it works offline.
 */

import { allTransactions, getMeta } from '../db/local.js';
import { budgetSummary, categoryTotals, ON_OTHERS } from '../lib/budget.js';
import { savingsPot } from '../lib/trends.js';
import { rideSurge, priceIndex } from '../lib/insights.js';
import { formatMinor } from '../lib/money.js';
import { escapeHtml } from '../capture/entry.js';
import { go } from '../nav.js';

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export async function renderSpending(root) {
  root.innerHTML = '<section class="spending"><h2>Spending</h2><div id="spend-body"></div></section>';
  const host = root.querySelector('#spend-body');

  const [rows, opening, target] = await Promise.all([
    allTransactions(),
    getMeta('budget.opening', null),
    getMeta('budget.savingsTarget', 0),
  ]);

  if (!rows.length) {
    host.innerHTML = '<p class="empty">Nothing to analyse yet.</p>';
    return;
  }

  const now = new Date();
  const budget = budgetSummary(rows, { opening, savingsTargetMinor: Number(target) || 0, now });
  // The pot is a running balance, not a per-period figure. See lib/trends.js.
  budget.potMinor = savingsPot(rows).minor;

  host.innerHTML = [
    leftCard(budget),
    '<div class="card" id="breakdown-card"></div>',
    committedCard(budget),
    faresCard(rows),
    pricesCard(rows),
  ].join('');

  // The breakdown carries its own date range, defaulting to this period, so the
  // same screen answers "where did it go this month" and "where did it go in
  // March". It repaints in place as the range changes; the other cards are
  // period-fixed and rendered once.
  const breakdownHost = host.querySelector('#breakdown-card');
  const range = { from: toDateInput(budget.since), to: '' };
  paintBreakdown(breakdownHost, rows, budget, range);
}

/** ISO instant -> the "YYYY-MM-DD" a date input expects, in local time. */
function toDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const startOfDay = (s) => (s ? new Date(`${s}T00:00:00`).toISOString() : null);
const endOfDay = (s) => (s ? new Date(`${s}T23:59:59.999`).toISOString() : null);

/**
 * A pointer, not a second opinion.
 *
 * What is outstanding in either direction lives on the Ledger and nowhere else —
 * two screens netting the same debts by slightly different rules is what made
 * one person read as 4,050 here and 4,600 there. Only the figure that enters
 * this card's arithmetic is repeated: money you owe reduces what is safe to
 * spend, while money owed to you deliberately does not increase it, so it has
 * no business on this screen at all.
 */
function ledgerLine(b) {
  if (!b.owedToMeMinor && !b.iOweMinor) return '';
  const parts = [
    b.owedToMeMinor ? `${formatMinor(b.owedToMeMinor)} is owed back to you` : '',
    b.iOweMinor ? `you owe ${formatMinor(b.iOweMinor)}` : '',
  ].filter(Boolean);
  return `<p class="hint people-line">${parts.join(' and ')} — see the Ledger.</p>`;
}

function card(title, inner, hint = '') {
  return `<div class="card">
    <h3>${title}</h3>
    ${hint ? `<p class="hint">${hint}</p>` : ''}
    ${inner}
  </div>`;
}

function row(label, value, cls = '') {
  return `<div class="row"><span>${label}</span><span class="num ${cls}">${value}</span></div>`;
}

/**
 * The headline. `safeToSpend` is deliberately the big number rather than cash:
 * cash includes rent that has not been charged yet and a savings target not yet
 * met, and a figure that quietly includes money you have already promised away
 * is exactly the figure that leads to overspending.
 */
function leftCard(b) {
  if (b.anchoredTo === 'none') {
    return card(
      'Money left',
      `<p class="hint">Add your salary as an incoming entry, or set an opening balance in
       Settings, and this becomes a running balance with a daily allowance.</p>`
    );
  }

  const since = b.since ? DATE.format(new Date(b.since)) : null;
  const until = b.nextIncomeAt ? DATE.format(new Date(b.nextIncomeAt)) : null;
  const short = b.safeToSpendMinor < 0;

  const period =
    b.anchoredTo === 'opening'
      ? `Since your opening balance on ${since}`
      : `This month, from ${since}`;

  return card(
    'Money left',
    `<div class="big ${short ? 'down' : ''}">${formatMinor(b.safeToSpendMinor)}</div>
     <p class="big-sub">${
       b.dailyMinor === null
         ? 'safe to spend'
         : short
           ? `over budget with ${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'} to go`
           : `safe to spend · <b>${formatMinor(b.dailyMinor)} a day</b> for ${b.daysLeft} more day${
               b.daysLeft === 1 ? '' : 's'
             }`
     }</p>
     ${row('In the wallet', formatMinor(b.cashMinor))}
     ${b.committedMinor ? row('Bills still due', `− ${formatMinor(b.committedMinor)}`, 'up') : ''}
     ${
       b.savingsTargetMinor
         ? row(
             b.savingsRemainingMinor
               ? `Still to set aside this period${b.savedMinor < 0 ? ' (some redeemed)' : ''}`
               : `Set aside this period (target ${formatMinor(b.savingsTargetMinor)})`,
             b.savingsRemainingMinor
               ? `− ${formatMinor(b.savingsRemainingMinor)}`
               : `${formatMinor(b.savedMinor)} ✓`,
             b.savingsRemainingMinor ? '' : 'down'
           )
         : ''
     }
     ${b.potMinor ? row('Saved in total', formatMinor(b.potMinor), 'down') : ''}
     ${
       b.iOweMinor
         ? row('Owed to other people', `− ${formatMinor(b.iOweMinor)}`, 'up')
         : ''
     }
     ${ledgerLine(b)}`,
    `${period}${until ? `, next expected ${until}` : ''}.`
  );
}

/**
 * Where it went. Money that left the wallet without being consumed is listed
 * apart from spending — putting a 50,000 investment at the top of a spending
 * chart buries the twenty entries that are actually the habit.
 *
 * Everything bought for other people sits in one row rather than spread through
 * Groceries, Health and Shopping, and only once it is written off: until then it
 * is a debt, and debts are the Ledger's, not this screen's.
 *
 * The card owns a date range, defaulting to this period. A bar used to count
 * every matching row for all time, so tapping "5,000 on Eating Out" opened
 * 20,000 of entries, 15,000 of it from earlier months — the totals and the
 * drill-down disagreed. Now both are scoped to the same window, and the range
 * carries through to History so the two always show the same set. The aside
 * (money that moved without being spent) stays tied to the period, so it is
 * shown only while the range is the default one it describes.
 */
function paintBreakdown(hostEl, rows, b, range) {
  const isDefault = range.from === toDateInput(b.since) && !range.to;
  const from = startOfDay(range.from);
  const to = endOfDay(range.to);
  const spend = categoryTotals(rows, { from, to });
  const total = spend.reduce((a, c) => a + c.totalMinor, 0);

  const controls = `<div class="date-range">
    <label class="stack">From
      <input type="date" id="bk-from" value="${range.from}" />
    </label>
    <label class="stack">To
      <input type="date" id="bk-to" value="${range.to}" />
    </label>
  </div>`;

  const bars = spend
    .map((c) => {
      const pct = total ? Math.round((c.totalMinor / total) * 100) : 0;
      return `<button type="button" class="cat" data-cat="${escapeHtml(c.category)}">
        <span class="cat-head">
          <span class="cat-name">${escapeHtml(c.category)}</span>
          <span class="num">${formatMinor(c.totalMinor)}</span>
        </span>
        <span class="cat-bar"><span style="width:${pct}%"></span></span>
        <span class="cat-sub">${c.count} entr${c.count === 1 ? 'y' : 'ies'} · ${pct}%${
          c.category === ON_OTHERS ? ' · written off, not coming back' : ''
        }</span>
      </button>`;
    })
    .join('');

  const aside = isDefault
    ? [
        b.savedMinor > 0 ? row('Saved or invested', formatMinor(b.savedMinor)) : '',
        // Net of redemptions, so this flips rather than showing a negative "saved".
        b.savedMinor < 0 ? row('Taken back out of savings', formatMinor(-b.savedMinor), 'up') : '',
        b.transferMinor ? row('Transferred or lent', formatMinor(b.transferMinor)) : '',
      ].join('')
    : '';

  const body = spend.length
    ? `<div class="cats">${bars}</div>${aside ? `<div class="aside">${aside}</div>` : ''}`
    : '<p class="empty">Nothing spent in this range.</p>';

  hostEl.innerHTML = `
    <h3>Where it went</h3>
    <p class="hint">${formatMinor(total)} spent. Tap a category to see the entries.${
      aside ? ' Below the line is money that moved without being spent.' : ''
    }</p>
    ${controls}
    ${body}`;

  // Each bar links into a History filtered to the same category *and* range, so
  // the drill-down can never show more than the bar counted.
  for (const el of hostEl.querySelectorAll('[data-cat]')) {
    el.addEventListener('click', () => {
      const params = { cat: el.dataset.cat };
      if (range.from) params.from = range.from;
      if (range.to) params.to = range.to;
      go('history', params);
    });
  }

  const repaint = () => {
    range.from = hostEl.querySelector('#bk-from').value;
    range.to = hostEl.querySelector('#bk-to').value;
    paintBreakdown(hostEl, rows, b, range);
  };
  hostEl.querySelector('#bk-from').addEventListener('change', repaint);
  hostEl.querySelector('#bk-to').addEventListener('change', repaint);
}

function committedCard(b) {
  const subs = b.committed;
  return card(
    'Still to come',
    subs.length
      ? subs
          .map((s) =>
            row(
              `${escapeHtml(s.label)}<small>${s.cadence} · due ${DATE.format(new Date(s.nextDue))}</small>`,
              formatMinor(s.lastMinor)
            )
          )
          .join('')
      : '<p class="empty">No recurring charges due before your next income.</p>',
    'Recurring charges already subtracted from what is safe to spend.'
  );
}

function faresCard(rows) {
  const surge = rideSurge(rows).filter((r) => r.overpaidCount > 0);
  if (!surge.length) return '';
  return card(
    'Ride fares',
    surge
      .map((r) =>
        row(
          `${escapeHtml(r.label)}<small>${r.count} rides · usually ${formatMinor(r.medianMinor)}</small>`,
          `+${formatMinor(r.overpaidMinor)}<small>over ${r.overpaidCount} ride${
            r.overpaidCount === 1 ? '' : 's'
          }</small>`
        )
      )
      .join(''),
    'What you paid above the usual fare for each route.'
  );
}

function pricesCard(rows) {
  const prices = priceIndex(rows).filter((p) => Math.abs(p.changePct) >= 15);
  if (!prices.length) return '';
  return card(
    'Price changes',
    prices
      .map((p) =>
        row(
          `${escapeHtml(p.label)}<small>${p.count} purchases over ${p.spanDays} days</small>`,
          `${p.changePct > 0 ? '+' : ''}${p.changePct}%<small>${formatMinor(p.earlyMinor)} → ${formatMinor(
            p.lateMinor
          )}</small>`,
          p.changePct > 0 ? 'up' : 'down'
        )
      )
      .join(''),
    'Median of your earliest purchases against your most recent.'
  );
}
