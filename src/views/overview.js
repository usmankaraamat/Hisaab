/* Overview: spending and saving over time, drilled month → week → day.
 *
 * The chart is inline SVG rather than a library. It is two series of at most
 * twelve bars — the whole renderer is under a hundred lines — and a charting
 * dependency would cost more in bundle than the entire app currently weighs.
 *
 * Design decisions worth keeping:
 *
 *   One axis. Spend and saved are both rupees, so they share a scale and can be
 *   read against each other honestly. Anything on a different scale (a savings
 *   *rate*, a count) gets its own figure, never a second y-axis.
 *
 *   The list under the chart is the table view, not decoration. It carries the
 *   exact numbers the bars only approximate, and it is what you tap to drill —
 *   so the chart never has to be a hit target small enough to miss.
 *
 *   Imported months are drawn hatched and labelled "reference". That history was
 *   logged while sharing costs with flatmates and has real gaps; showing it
 *   without marking it would invite a comparison the data cannot support.
 *
 * Series colours are validated for contrast and colour-vision deficiency
 * against both surfaces — see scripts/palette.md in the dataviz notes. Identity
 * is never colour alone: there is a legend, the bars are labelled in the list,
 * and reference bars carry a hatch as well as a lighter fill.
 */

import { allTransactions, getMeta } from '../db/local.js';
import {
  monthlySeries,
  weeklySeries,
  dailySeries,
  savingsPot,
  savingsRate,
  projectMonth,
  categoryDelta,
  suggestedTarget,
  goalProgress,
} from '../lib/trends.js';
import { barLayout, gridLines, FRAME } from '../lib/chart.js';
import { formatMinor } from '../lib/money.js';
import { escapeHtml } from '../capture/entry.js';
import { go } from '../nav.js';

const MONTH_LONG = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
const MONTH_SHORT = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' });

export async function renderOverview(root, params) {
  const [rows, goal] = await Promise.all([allTransactions(), getMeta('savings.goal', null)]);

  root.innerHTML = '<section class="overview"><h2>Overview</h2><div id="ov-body"></div></section>';
  const host = root.querySelector('#ov-body');

  if (!rows.length) {
    host.innerHTML = '<p class="empty">Nothing to chart yet.</p>';
    return;
  }

  const now = new Date();
  const months = monthlySeries(rows);
  const pot = savingsPot(rows);

  // "#overview?m=2026-08&w=2" — a real address, so the back button unwinds the
  // drill-down instead of leaving the tab.
  const monthKey = params?.get('m') || null;
  const weekNo = Number(params?.get('w')) || null;
  const month = monthKey ? months.find((m) => m.key === monthKey) : null;

  let level = 'month';
  let buckets = months;
  let crumbs = [{ label: 'All months', params: null }];

  if (month) {
    const weeks = weeklySeries(rows, month.year, month.month);
    crumbs.push({ label: MONTH_SHORT.format(new Date(month.year, month.month, 1)), params: { m: month.key } });
    if (weekNo && weeks[weekNo - 1]) {
      const w = weeks[weekNo - 1];
      level = 'day';
      buckets = dailySeries(rows, month.year, month.month, w.start, w.end);
      crumbs.push({ label: w.label, params: { m: month.key, w: String(weekNo) } });
    } else {
      level = 'week';
      buckets = weeks;
    }
  }

  host.innerHTML = [
    potCard(pot, goal, months, now),
    chartCard(buckets, level, crumbs, month, now),
    level === 'month' ? '' : monthDetail(rows, months, month, now),
    level === 'month' ? targetCard(months, now) : '',
  ].join('');

  for (const el of host.querySelectorAll('[data-go]')) {
    el.addEventListener('click', () => {
      const q = el.dataset.go ? JSON.parse(el.dataset.go) : undefined;
      go('overview', q);
    });
  }
}

function card(title, inner, hint = '') {
  return `<div class="card">
    ${title ? `<h3>${title}</h3>` : ''}
    ${hint ? `<p class="hint">${hint}</p>` : ''}
    ${inner}
  </div>`;
}

function row(label, value, cls = '') {
  return `<div class="row"><span>${label}</span><span class="num ${cls}">${value}</span></div>`;
}

/* ------------------------------------------------------------------ chart */

function chartCard(buckets, level, crumbs, month, now) {
  const { max, bars: marks, y } = barLayout(buckets);
  const projection = level === 'month' ? projectMonth(buckets.at(-1), now) : null;

  const grid = gridLines(max)
    .map(
      (g) => `<line class="ov-grid" x1="${FRAME.left}" y1="${g.y}" x2="${FRAME.w - FRAME.right}" y2="${g.y}" />
        <text class="ov-tick" x="${FRAME.left - 4}" y="${g.y + 3}" text-anchor="end">${g.label}</text>`
    )
    .join('');

  const bars = buckets
    .map((b, i) => {
      const m = marks[i];
      const ghost =
        projection && i === buckets.length - 1 && projection.spendMinor > b.spendMinor
          ? `<rect class="ov-ghost" x="${m.x}" y="${y(projection.spendMinor)}"
               width="${m.w}" height="${Math.max(0, m.y - y(projection.spendMinor))}" rx="3" />`
          : '';
      return `
        <g class="ov-band${b.reference ? ' ref' : ''}" data-i="${i}">
          ${ghost}
          <rect class="ov-bar spend" x="${m.x}" y="${m.y}"
                width="${m.w}" height="${m.h}" rx="3" />
          ${
            b.reference
              ? `<rect class="ov-hatch-fill" x="${m.x}" y="${m.y}"
                   width="${m.w}" height="${m.h}" rx="3" fill="url(#ov-hatch)" />`
              : ''
          }
          <text class="ov-xlabel" x="${m.cx}" y="${FRAME.h - 6}" text-anchor="middle">${escapeHtml(
            shortLabel(b, level)
          )}</text>
        </g>`;
    })
    .join('');

  const anyRef = buckets.some((b) => b.reference);
  const anyMixed = buckets.some((b) => b.mixed);

  const note = projection
    ? `Day ${projection.elapsed} of ${projection.days}. At this pace the month ends near ${formatMinor(
        projection.spendMinor
      )}.`
    : level === 'month'
      ? 'Tap a month to see its weeks, then a week to see its days.'
      : level === 'week'
        ? 'Tap a week to see its days.'
        : '';

  const trail = crumbs
    .map((c, i) =>
      i === crumbs.length - 1
        ? `<span aria-current="page">${escapeHtml(c.label)}</span>`
        : `<button type="button" class="link" data-go='${JSON.stringify(c.params ?? {})}'>${escapeHtml(
            c.label
          )}</button>`
    )
    .join('<span class="ov-sep">›</span>');

  const list = buckets
    .map((b, i) => {
      const target = drillTarget(b, level, month, i);
      const tag = target ? `data-go='${JSON.stringify(target)}'` : '';
      return `<button type="button" class="ov-row${target ? '' : ' flat'}" ${tag} ${
        target ? '' : 'disabled'
      }>
        <span class="ov-row-name">${escapeHtml(b.label)}${
          b.reference
            ? '<em class="ov-ref">reference</em>'
            : b.mixed
              ? '<em class="ov-ref">tracked only</em>'
              : ''
        }</span>
        <span class="ov-row-nums">
          <span class="num spend">${formatMinor(b.spendMinor)}</span>
        </span>
        ${
          b.savedMinor
            ? `<small class="ov-saved">${formatMinor(b.savedMinor)} into savings</small>`
            : ''
        }
      </button>`;
    })
    .join('');

  return card(
    '',
    `<nav class="ov-crumbs">${trail}</nav>
     <p class="ov-cap">Spent per ${level}</p>
     <svg class="ov-chart" viewBox="0 0 ${FRAME.w} ${FRAME.h}" role="img"
          aria-label="Spending and saving by ${level}">
       <defs>
         <pattern id="ov-hatch" width="4" height="4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
           <line x1="0" y1="0" x2="0" y2="4" />
         </pattern>
       </defs>
       ${grid}${bars}
     </svg>
     ${
       projection || anyRef || anyMixed
         ? `<div class="ov-legend">
             ${projection ? '<span><i class="sw ghost"></i>Projected</span>' : ''}
             ${anyRef ? '<span><i class="sw ref"></i>Imported, reference only</span>' : ''}
             ${
               anyMixed
                 ? '<span class="ov-note">Months marked “tracked only” also hold imported rows, left out of their totals.</span>'
                 : ''
             }
           </div>`
         : ''
     }
     ${note ? `<p class="hint ov-foot">${note}</p>` : ''}
     <div class="ov-rows">${list}</div>`
  );
}

function shortLabel(b, level) {
  if (level === 'month') return b.label.split(' ')[0];
  if (level === 'week') return String(b.start);
  return String(b.day);
}

function drillTarget(b, level, month, i) {
  if (level === 'month') return { m: b.key };
  if (level === 'week') return { m: month.key, w: String(i + 1) };
  return null;
}

/* ----------------------------------------------------------- savings pot */

/**
 * The pot leads, because it is the number that never goes backwards for a
 * reason that has nothing to do with saving. Everything else on this screen is
 * a rate or a window; this is a balance.
 */
function potCard(pot, goal, months, now) {
  const progress = goalProgress(goal, months, { now, potMinor: pot.minor });

  const goalBlock = progress
    ? `<div class="ov-goal">
         <div class="ov-goal-head">
           <span>${escapeHtml(progress.name || 'Goal')}</span>
           <span class="num">${formatMinor(progress.savedMinor)} / ${formatMinor(progress.targetMinor)}</span>
         </div>
         <span class="cat-bar"><span style="width:${progress.pct}%"></span></span>
         <p class="hint">${goalNote(progress)}</p>
       </div>`
    : `<p class="hint">Name what you are saving for in Settings and this becomes a
       progress bar with an arrival date.</p>`;

  return card(
    'Saved so far',
    `<div class="big">${formatMinor(pot.minor)}</div>
     <p class="big-sub">${pot.deposits} deposit${pot.deposits === 1 ? '' : 's'}${
       pot.withdrawals ? `, ${pot.withdrawals} withdrawal${pot.withdrawals === 1 ? '' : 's'}` : ''
     } · does not reset when you are paid</p>
     ${goalBlock}`
  );
}

function goalNote(p) {
  if (p.remainingMinor === 0) return 'Reached.';
  const rate = p.perMonthMinor > 0 ? `Saving ${formatMinor(p.perMonthMinor)} a month. ` : '';
  if (p.monthsLeft === null) return `${rate}${formatMinor(p.remainingMinor)} to go.`;
  const arrives = MONTH_LONG.format(new Date(p.arrivesAt));
  if (p.onTrack === null) return `${rate}At this rate you get there in ${arrives}.`;
  return p.onTrack
    ? `${rate}On track — you get there in ${arrives}.`
    : `${rate}Behind: at this rate ${arrives}, not ${MONTH_LONG.format(new Date(p.dueAt))}.`;
}

/* -------------------------------------------------------- month detail */

/** Everything that only makes sense once a single month is in view. */
function monthDetail(rows, months, month, now) {
  if (!month) return '';
  const i = months.findIndex((m) => m.key === month.key);
  // Never compare against imported history: those totals were logged while
  // sharing costs with flatmates and have gaps, so a delta against them would
  // read as a real change when it is an artefact of the source.
  const earlier = i > 0 ? months[i - 1] : null;
  const previous = earlier && !earlier.reference ? earlier : null;
  const rate = savingsRate(month);

  const deltas = categoryDelta(rows, month, previous).slice(0, 6);

  const split = card(
    MONTH_LONG.format(new Date(month.year, month.month, 1)),
    `${row('Income', month.incomeMinor ? formatMinor(month.incomeMinor) : '—')}
     ${row('Spent', formatMinor(month.spendMinor))}
     ${row('Saved', formatMinor(month.savedMinor), month.savedMinor > 0 ? 'down' : '')}
     ${
       rate === null
         ? ''
         : row('Savings rate', `${Math.round(rate * 100)}%`, rate >= 0.2 ? 'down' : 'up')
     }
     <div class="aside">
       ${row('Fixed — bills and subscriptions', formatMinor(month.fixedMinor))}
       ${row('Flexible — everything you choose', formatMinor(month.flexibleMinor), 'up')}
     </div>`,
    month.flexibleMinor
      ? `All of your room to save is in the flexible half — ${formatMinor(
          month.flexibleMinor
        )} of ${formatMinor(month.spendMinor)}.`
      : ''
  );

  const change = previous
    ? card(
        `Against ${MONTH_SHORT.format(new Date(previous.year, previous.month, 1))}`,
        deltas.length
          ? deltas
              .map((d) =>
                row(
                  `${escapeHtml(d.category)}<small>${formatMinor(d.wasMinor)} → ${formatMinor(
                    d.nowMinor
                  )}</small>`,
                  `${d.changeMinor > 0 ? '+' : '−'}${formatMinor(Math.abs(d.changeMinor))}${
                    d.changePct === null ? '' : `<small>${d.changePct > 0 ? '+' : ''}${d.changePct}%</small>`
                  }`,
                  d.changeMinor > 0 ? 'up' : 'down'
                )
              )
              .join('')
          : '<p class="empty">No category moved.</p>',
        'Biggest movers first, by amount rather than percentage.'
      )
    : '';

  return split + change;
}

/* ------------------------------------------------------ suggested target */

function targetCard(months, now) {
  const suggestion = suggestedTarget(months, { now });
  if (!suggestion) return '';
  return card(
    'What you could commit to',
    `<div class="big">${formatMinor(suggestion.targetMinor)}</div>
     <p class="big-sub">a month, on the evidence of ${suggestion.months} complete months</p>`,
    'Your worst month, not your average — a target you only hit half the time stops being a target.'
  );
}
