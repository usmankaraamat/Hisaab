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
  categorySeries,
  suggestedTarget,
  goalProgress,
} from '../lib/trends.js';
import { barLayout, gridLines, sparkPoints, ceilNice, shortMinor, FRAME } from '../lib/chart.js';
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
    level === 'month' ? cashflowCard(months) : '',
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
     ${note ? `<p class="hint ov-foot">${note}</p>` : ''}
     <details class="ov-detail">
       <summary>Exact values and chart notes</summary>
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
       <div class="ov-rows">${list}</div>
     </details>`
  );
}

function shortLabel(b, level) {
  if (level === 'month') return b.label.split(' ')[0];
  if (level === 'week') return String(b.start);
  return String(b.day);
}

/* --------------------------------------------------------------- cashflow */

/**
 * Money in against money out, per month, as paired bars on one shared rupee
 * scale. The main chart answers "where did it go"; this answers the question a
 * spend total alone cannot — did the month end ahead or behind. When the green
 * bar clears the blue one you lived within your means; when it does not, you did
 * not. Two series, so a legend is always present and each bar is nameable in the
 * caption; savings *rate* is a percentage and stays its own figure in the month
 * detail rather than a forbidden second axis here.
 */
const CF = { w: 340, h: 150, top: 12, right: 6, bottom: 22, left: 30 };

function cashflowCard(months) {
  const data = months.slice(-12);
  if (!data.some((m) => m.incomeMinor > 0)) return '';

  const plotW = CF.w - CF.left - CF.right;
  const plotH = CF.h - CF.top - CF.bottom;
  const base = CF.top + plotH;
  const max = ceilNice(Math.max(1, ...data.flatMap((m) => [m.incomeMinor, m.spendMinor])));
  const y = (v) => base - (Math.max(0, v) / max) * plotH;
  const band = plotW / Math.max(1, data.length);
  const bw = Math.min(11, Math.max(3, band / 2 - 2));

  const grid = gridLines(max)
    .map(
      (g) => `<line class="ov-grid" x1="${CF.left}" y1="${g.y}" x2="${CF.w - CF.right}" y2="${g.y}" />
        <text class="ov-tick" x="${CF.left - 4}" y="${g.y + 3}" text-anchor="end">${g.label}</text>`
    )
    .join('');

  const bars = data
    .map((m, i) => {
      const cx = CF.left + band * i + band / 2;
      const inY = y(m.incomeMinor);
      const outY = y(m.spendMinor);
      const ref = m.reference ? ' ref' : '';
      return `<g class="cf-band${ref}">
        <rect class="cf-bar in" x="${cx - bw - 1}" y="${inY}" width="${bw}" height="${base - inY}" rx="2" />
        <rect class="cf-bar out" x="${cx + 1}" y="${outY}" width="${bw}" height="${base - outY}" rx="2" />
        <text class="ov-xlabel" x="${cx}" y="${CF.h - 6}" text-anchor="middle">${escapeHtml(
          m.label.split(' ')[0]
        )}</text>
      </g>`;
    })
    .join('');

  const last = data.at(-1);
  const net = last.incomeMinor - last.spendMinor - last.savedMinor;
  const netNote = last.incomeMinor
    ? ` ${last.label.split(' ')[0]}: ${
        net >= 0 ? `${formatMinor(net)} left over` : `${formatMinor(-net)} short`
      } after spending and saving.`
    : '';

  return card(
    'Money in and out',
    `<svg class="ov-chart" viewBox="0 0 ${CF.w} ${CF.h}" role="img"
       aria-label="Income against spending by month">
       ${grid}${bars}
     </svg>
     <div class="ov-legend">
       <span><i class="sw cf-in"></i>In</span>
       <span><i class="sw cf-out"></i>Out</span>
       ${data.some((m) => m.reference) ? '<span><i class="sw ref"></i>Imported</span>' : ''}
     </div>`,
    `Income against spending, per month.${netNote}`
  );
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
          ? moverBars(rows, deltas, months)
          : '<p class="empty">No category moved.</p>',
        'Bars run right for more, left for less — length is the change in rupees. The trailing line is that category over recent months.'
      )
    : '';

  return split + change;
}

/**
 * Category movers as diverging bars: right for more than last month, left for
 * less. The side and the signed number carry the direction, so the reading does
 * not depend on the red/green (which a colour-vision check will not separate on
 * hue alone). Each row also carries a sparkline of that category over recent
 * months, so a jump reads as a spike or a new level rather than a bare delta.
 */
function moverBars(rows, deltas, months) {
  const max = Math.max(1, ...deltas.map((d) => Math.abs(d.changeMinor)));
  const recent = months.slice(-6);
  return `<div class="mv-list">${deltas
    .map((d) => {
      const pct = Math.round((Math.abs(d.changeMinor) / max) * 50); // half-track
      const up = d.changeMinor > 0;
      const series = categorySeries(rows, d.category, recent);
      const pts = sparkPoints(series, { w: 60, h: 18 });
      const spark = series.some((v) => v > 0)
        ? `<svg class="spark mv-spark" width="60" height="18" viewBox="0 0 60 18" aria-hidden="true">
             <polyline class="spark-line" points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" />
           </svg>`
        : '';
      return `<div class="mv-row">
        <div class="mv-head">
          <span class="mv-name">${escapeHtml(d.category)}</span>
          <span class="mv-num ${up ? 'up' : 'down'}">${up ? '+' : '−'}${formatMinor(
            Math.abs(d.changeMinor)
          )}${d.changePct === null ? '' : ` · ${d.changePct > 0 ? '+' : ''}${d.changePct}%`}</span>
        </div>
        <div class="mv-track">
          <span class="mv-mid"></span>
          <span class="mv-fill ${up ? 'neg' : 'pos'}" style="${
            up ? 'left:50%' : `right:50%`
          };width:${pct}%"></span>
        </div>
        <div class="mv-foot">${spark}<small>${formatMinor(d.wasMinor)} → ${formatMinor(
          d.nowMinor
        )}</small></div>
      </div>`;
    })
    .join('')}</div>`;
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
