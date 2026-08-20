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
 * same balance by different routes is a bug waiting to be reported.
 *
 * Everything on this screen reads IndexedDB, so it works offline.
 */

import { allTransactions, getMeta } from '../db/local.js';
import { budgetSummary, categoryTotals } from '../lib/budget.js';
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

  host.innerHTML = [
    leftCard(budget),
    breakdownCard(rows, budget),
    peopleCard(budget),
    committedCard(budget),
    faresCard(rows),
    pricesCard(rows),
  ].join('');

  // Every category row is a link into a filtered History, which is the whole
  // point of having categories at all.
  for (const el of host.querySelectorAll('[data-cat]')) {
    el.addEventListener('click', () => go('history', { cat: el.dataset.cat }));
  }
  for (const el of host.querySelectorAll('[data-person]')) {
    el.addEventListener('click', () => go('history', { person: el.dataset.person }));
  }
}

/**
 * Who the outstanding balances are with.
 *
 * The totals above are netted per person, so "owed back to you 4,620" can be one
 * person or six. Naming them is what stops the figure reading as an abstraction
 * — and it is one tap from here to the Ledger, where it gets settled.
 */
function peopleLine(b) {
  const open = (b.people ?? []).filter((p) => p.netMinor !== 0);
  if (!open.length) return '';
  const names = open
    .slice(0, 3)
    .map((p) => escapeHtml(p.name))
    .join(', ');
  const more = open.length > 3 ? ` and ${open.length - 3} more` : '';
  return `<p class="hint people-line">With ${names}${more}.</p>`;
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
      : `Since you were paid on ${since}`;

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
               ? `Still to save${b.savedMinor < 0 ? ' (some redeemed)' : ''}`
               : `Saved (target ${formatMinor(b.savingsTargetMinor)})`,
             b.savingsRemainingMinor
               ? `− ${formatMinor(b.savingsRemainingMinor)}`
               : `${formatMinor(b.savedMinor)} ✓`,
             b.savingsRemainingMinor ? '' : 'down'
           )
         : ''
     }
     ${b.iOweMinor ? row('You owe people', `− ${formatMinor(b.iOweMinor)}`, 'up') : ''}
     ${b.owedToMeMinor ? row('Owed back to you', formatMinor(b.owedToMeMinor), 'down') : ''}
     ${peopleLine(b)}`,
    `${period}${until ? `, next expected ${until}` : ''}.`
  );
}

/**
 * Where it went. Money that left the wallet without being consumed is listed
 * apart from spending — putting a 50,000 investment at the top of a spending
 * chart buries the twenty entries that are actually the habit.
 */
function breakdownCard(rows, b) {
  const spend = categoryTotals(rows, { from: b.since });
  const total = spend.reduce((a, c) => a + c.totalMinor, 0);

  if (!spend.length && !b.savedMinor && !b.transferMinor) {
    return card('Where it went', '<p class="empty">Nothing spent this period.</p>');
  }

  const bars = spend
    .map((c) => {
      const pct = total ? Math.round((c.totalMinor / total) * 100) : 0;
      return `<button type="button" class="cat" data-cat="${escapeHtml(c.category)}">
        <span class="cat-head">
          <span class="cat-name">${escapeHtml(c.category)}</span>
          <span class="num">${formatMinor(c.totalMinor)}</span>
        </span>
        <span class="cat-bar"><span style="width:${pct}%"></span></span>
        <span class="cat-sub">${c.count} entr${c.count === 1 ? 'y' : 'ies'} · ${pct}%</span>
      </button>`;
    })
    .join('');

  const aside = [
    b.savedMinor > 0 ? row('Saved or invested', formatMinor(b.savedMinor)) : '',
    // Net of redemptions, so this flips rather than showing a negative "saved".
    b.savedMinor < 0 ? row('Taken back out of savings', formatMinor(-b.savedMinor), 'up') : '',
    b.transferMinor ? row('Transferred or lent', formatMinor(b.transferMinor)) : '',
    b.sharedMinor ? row('Spent on other people', formatMinor(b.sharedMinor)) : '',
    b.fundedByOthersMinor ? row('Paid for by other people', formatMinor(b.fundedByOthersMinor)) : '',
  ].join('');

  return card(
    'Where it went',
    `<div class="cats">${bars}</div>
     ${aside ? `<div class="aside">${aside}</div>` : ''}`,
    `${formatMinor(total)} on yourself. Tap a category to see the entries.${
      aside ? ' Everything below the line is money that was set aside, moved, or spent on someone else.' : ''
    }`
  );
}

/**
 * What went on other people, kept out of the categories above.
 *
 * Groceries for a sister are not your groceries. Mixed into the same bars they
 * bury the habit you are trying to see — a quarter of the live breakdown, spread
 * across six categories — and no amount of staring at "Groceries 12,885"
 * separates the two. Splitting them is also the honest read: one of those totals
 * you can decide to change, and the other you mostly cannot.
 *
 * The per-person figure is what each person cost you after what they handed
 * back — 1,500 spent on a sister who reimburses 500 reads as 1,000 — because
 * the question this card answers is where money is actually leaving, not how
 * much traffic went through. The running balance stays on the Ledger, which
 * also counts what they bought for you and does not reset with the period.
 */
function peopleCard(b) {
  if (!b.shared.length) return '';

  const bars = b.shared
    .map((p) => {
      const pct = b.sharedMinor > 0
        ? Math.max(0, Math.round((p.totalMinor / b.sharedMinor) * 100))
        : 0;
      return `<button type="button" class="cat" data-person="${escapeHtml(p.name)}">
        <span class="cat-head">
          <span class="cat-name">${escapeHtml(p.name)}</span>
          <span class="num">${formatMinor(p.totalMinor)}</span>
        </span>
        <span class="cat-bar"><span style="width:${pct}%"></span></span>
        <span class="cat-sub">${p.count} entr${p.count === 1 ? 'y' : 'ies'}${
          p.totalMinor === 0 && p.repaidMinor
            ? ' · paid back in full'
            : p.repaidMinor
              ? ` · ${formatMinor(p.spentMinor)} less ${formatMinor(p.repaidMinor)} back`
              : ''
        }${p.owedMinor ? ` · ${formatMinor(p.owedMinor)} still owed` : ''}</span>
      </button>`;
    })
    .join('');

  const split = [
    b.giftedMinor ? row('Gifts and write-offs', formatMinor(b.giftedMinor)) : '',
  ].join('');

  return card(
    'Spent on other people',
    `<div class="cats">${bars}</div>
     ${split ? `<div class="aside">${split}</div>` : ''}`,
    `${formatMinor(b.sharedMinor)} this period after what came back, kept out of your
     own categories. Tap a name for the entries; the running balance is on the Ledger.`
  );
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
