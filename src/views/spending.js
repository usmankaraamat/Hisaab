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
import { budgetSummary, categoryTotals, categoryBudgets, spendPace, ON_OTHERS } from '../lib/budget.js';
import { savingsPot } from '../lib/trends.js';
import { answerQuery } from '../lib/query.js';
import { rideSurge, priceIndex } from '../lib/insights.js';
import { bridgeLayout, linePoints, gridLines, ceilNice, FRAME } from '../lib/chart.js';
import { formatMinor } from '../lib/money.js';
import { escapeHtml } from '../capture/entry.js';
import { go } from '../nav.js';

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export async function renderSpending(root) {
  root.innerHTML = '<section class="spending"><h2>Spending</h2><div id="spend-body"></div></section>';
  const host = root.querySelector('#spend-body');

  const [rows, opening, target, budgets] = await Promise.all([
    allTransactions(),
    getMeta('budget.opening', null),
    getMeta('budget.savingsTarget', 0),
    getMeta('budget.categories', {}),
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
    askCard(),
    bridgeCard(budget),
    paceCard(rows, budget, now),
    categoryBudgetsCard(rows, budget, budgets),
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

  wireAsk(host, rows, now);
}

/**
 * A one-line question box over the local ledger — offline, private, no model.
 * It answers the handful of things people actually ask ("how much on eating out
 * last month", "who owes me the most") and, when the answer is a filtered total,
 * offers to open exactly those entries.
 */
function askCard() {
  return `<div class="card ask" id="ask-card">
    <h3>Ask</h3>
    <form id="ask-form" autocomplete="off">
      <input id="ask-q" type="text" placeholder="how much on eating out last month?"
        spellcheck="false" aria-label="Ask about your spending" />
      <button type="submit">Ask</button>
    </form>
    <p class="ask-a" id="ask-a" hidden></p>
  </div>`;
}

function wireAsk(host, rows, now) {
  const form = host.querySelector('#ask-form');
  const input = host.querySelector('#ask-q');
  const out = host.querySelector('#ask-a');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const a = answerQuery(input.value, rows, { now });
    out.hidden = false;
    out.textContent = a.text;
    if (a.category || a.person || a.from || a.query) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'link ask-link';
      link.textContent = a.person ? 'See the ledger' : 'See the entries';
      link.addEventListener('click', () => {
        if (a.person) return go('ledger');
        const params = {};
        // An item answer hands History the same words it counted, so the list
        // that opens adds up to the figure that was just read out.
        if (a.query) params.q = a.query;
        if (a.category) params.cat = a.category;
        if (a.from) params.from = toDateInput(a.from);
        if (a.to) params.to = toDateInput(a.to);
        go('history', params);
      });
      out.append(' ');
      out.append(link);
    }
  });
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
 * The same subtraction as the card above, drawn as a bridge so the arithmetic is
 * visible rather than asserted: the wallet, less the bills and the savings and
 * what you owe, is what is safe. Each chip steps down from where the last left
 * off; the final bar is the answer, green when there is room and red when the
 * period is already over budget. Skipped entirely when nothing is deducted —
 * there is no story to draw when cash and safe are the same number.
 */
const WF = { w: 340, h: 172, top: 24, right: 8, bottom: 30, left: 8 };

function bridgeCard(b) {
  if (b.anchoredTo === 'none') return '';
  const steps = [];
  if (b.committedMinor) steps.push({ label: 'Bills', minor: -b.committedMinor });
  if (b.savingsRemainingMinor) steps.push({ label: 'To save', minor: -b.savingsRemainingMinor });
  if (b.iOweMinor) steps.push({ label: 'You owe', minor: -b.iOweMinor });
  if (!steps.length) return '';

  const { y, bars, levels } = bridgeLayout({ startMinor: b.cashMinor, steps }, { frame: WF });
  const labelFor = (bar, i) =>
    i === 0 ? 'Wallet' : i === bars.length - 1 ? 'Safe' : bar.label;

  const connectors = bars
    .slice(0, -1)
    .map((bar, i) => {
      const ly = y(levels[i]);
      return `<line class="wf-link" x1="${bar.x + bar.w}" y1="${ly}" x2="${bars[i + 1].x}" y2="${ly}" />`;
    })
    .join('');

  const rects = bars
    .map((bar, i) => {
      const total = bar.kind === 'total';
      const cls =
        i === bars.length - 1
          ? bar.valueMinor < 0
            ? 'wf-bar end neg'
            : 'wf-bar end pos'
          : total
            ? 'wf-bar start'
            : 'wf-bar step';
      const valueText =
        bar.kind === 'total'
          ? formatMinor(bar.valueMinor)
          : `−${formatMinor(Math.abs(bar.valueMinor))}`;
      return `
        <rect class="${cls}" x="${bar.x}" y="${bar.y}" width="${bar.w}" height="${bar.h}" rx="3" />
        <text class="wf-val" x="${bar.cx}" y="${bar.y - 6}" text-anchor="middle">${valueText}</text>
        <text class="wf-lab" x="${bar.cx}" y="${WF.h - 8}" text-anchor="middle">${escapeHtml(
          labelFor(bar, i)
        )}</text>`;
    })
    .join('');

  return card(
    'How “safe” is worked out',
    `<svg class="wf-chart" viewBox="0 0 ${WF.w} ${WF.h}" role="img"
       aria-label="Waterfall from wallet balance to what is safe to spend">
       <line class="wf-base" x1="${WF.left}" y1="${y(0)}" x2="${WF.w - WF.right}" y2="${y(0)}" />
       ${connectors}${rects}
     </svg>`,
    'Your cash, less what is already spoken for, is what is safe to spend.'
  );
}

/**
 * Per-category budgets for this period. A single safe-to-spend number cannot say
 * "you set aside 8,000 for Eating Out and you are already at 9,200"; this can.
 * Over-budget rows are the reserved critical colour with an explicit "over by"
 * label, so the alert never rests on colour alone.
 */
function categoryBudgetsCard(rows, b, budgets) {
  if (b.anchoredTo === 'none') return '';
  const list = categoryBudgets(rows, budgets, { from: b.since });
  if (!list.length) return '';

  const bars = list
    .map((c) => {
      const width = Math.min(100, c.pct);
      const state = c.over ? 'over' : c.pct >= 80 ? 'near' : '';
      const note = c.over
        ? `over by ${formatMinor(-c.remainingMinor)}`
        : `${formatMinor(c.remainingMinor)} left`;
      return `<div class="bud" data-cat="${escapeHtml(c.category)}">
        <div class="bud-head">
          <span class="bud-name">${escapeHtml(c.category)}</span>
          <span class="num">${formatMinor(c.spentMinor)} <span class="bud-cap">/ ${formatMinor(
            c.budgetMinor
          )}</span></span>
        </div>
        <span class="bud-bar ${state}"><span style="width:${width}%"></span></span>
        <span class="bud-sub ${c.over ? 'over' : ''}">${c.pct}% · ${note}</span>
      </div>`;
    })
    .join('');

  const over = list.filter((c) => c.over).length;
  return card(
    'Budgets this period',
    `<div class="buds">${bars}</div>`,
    over
      ? `${over} categor${over === 1 ? 'y is' : 'ies are'} over budget. Tap to see the entries.`
      : 'Tap a category to see the entries.'
  );
}

/**
 * Am I ahead or behind? The daily allowance is a rate; this is the position.
 * Cumulative spend this period against an even burn of the whole spendable
 * envelope — under the dashed line is on track, over it is spending too fast.
 * The actual line is green while under pace and red once over, but the reading
 * is the gap between the two lines, not the colour.
 */
function paceCard(rows, b, now) {
  if (b.anchoredTo === 'none') return '';
  const budgetMinor = b.spendMinor + Math.max(0, b.safeToSpendMinor);
  if (budgetMinor <= 0) return '';

  const pace = spendPace(rows, {
    start: b.since,
    end: b.nextIncomeAt,
    now,
    budgetMinor,
  });
  const maxMinor = ceilNice(Math.max(1, pace.budgetMinor, pace.spentMinor));
  const lay = linePoints(pace.cumulative, { slots: pace.totalDays + 1, maxMinor });

  const grid = gridLines(maxMinor)
    .map(
      (g) => `<line class="ov-grid" x1="${FRAME.left}" y1="${g.y}" x2="${FRAME.w - FRAME.right}" y2="${g.y}" />
        <text class="ov-tick" x="${FRAME.left - 4}" y="${g.y + 3}" text-anchor="end">${g.label}</text>`
    )
    .join('');

  const ideal = `<line class="pace-ideal" x1="${lay.x(0)}" y1="${lay.y(0)}"
    x2="${lay.x(pace.totalDays)}" y2="${lay.y(pace.budgetMinor)}" />`;

  const over = pace.overMinor > 0;
  const actual = lay.points.map((p) => `${p.x},${p.y}`).join(' ');
  const last = lay.points.at(-1);
  const dot = last
    ? `<circle class="pace-dot ${over ? 'neg' : 'pos'}" cx="${last.x}" cy="${last.y}" r="3.5" />`
    : '';

  const foot =
    pace.overMinor === 0
      ? `${formatMinor(pace.spentMinor)} spent — exactly on pace.`
      : over
        ? `${formatMinor(pace.spentMinor)} spent — ${formatMinor(pace.overMinor)} ahead of an even pace.`
        : `${formatMinor(pace.spentMinor)} spent — ${formatMinor(-pace.overMinor)} below an even pace.`;

  return card(
    'Spending pace',
    `<svg class="ov-chart" viewBox="0 0 ${FRAME.w} ${FRAME.h}" role="img"
       aria-label="Cumulative spending against an even pace">
       ${grid}${ideal}
       <polyline class="pace-line ${over ? 'neg' : 'pos'}" points="${actual}" />
       ${dot}
     </svg>
     <div class="ov-legend">
       <span><i class="sw pace-sw-ideal"></i>Even pace</span>
       <span><i class="sw ${over ? 'pace-sw-neg' : 'pace-sw-pos'}"></i>You, so far</span>
     </div>
     <p class="hint ov-foot">${foot} Day ${pace.elapsed} of ${pace.totalDays}.</p>`,
    'Under the dashed line is on track; over it is spending faster than the month allows.'
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
