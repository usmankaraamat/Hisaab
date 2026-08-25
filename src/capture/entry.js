/* The capture screen. This is the whole product for Phase 1.
 *
 * Constraints it has to hold to:
 *   - never touch the network (writes go straight to IndexedDB)
 *   - open focused, save on Enter, clear, stay focused
 *   - show exactly how the input was split, so a bad parse is visible
 */

import { parseEntry } from './parse.js';
import { planEntry, parseReimbursement, parseFromClause } from './split.js';
import { frequentAmounts, knownNames, suggestChips, invalidate } from './predict.js';
import {
  addTransaction,
  addTransactions,
  deleteTransaction,
  allTransactions,
  getMeta,
} from '../db/local.js';
import { formatMinor } from '../lib/money.js';
import { surgeCheck } from '../lib/insights.js';
import { budgetSummary, categoryTotals, calendarPeriod } from '../lib/budget.js';
import { sparkPoints } from '../lib/chart.js';
import { findDuplicate } from '../lib/dupes.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function renderAdd(root) {
  root.innerHTML = `
    <section class="capture">
      <form id="entry-form" autocomplete="off">
        <div class="field">
          <input
            id="entry-input"
            type="text"
            name="entry"
            placeholder="chicken 900"
            list="known-names"
            enterkeyhint="done"
            autocapitalize="sentences"
            spellcheck="false"
            aria-label="What did you spend on, and how much" />
          <datalist id="known-names"></datalist>
        </div>

        <div class="preview" id="preview" aria-live="polite">
          <span class="preview-name">&nbsp;</span>
        </div>

        <div class="split" id="split" role="status" hidden></div>

        <p class="surge" id="surge" role="status" hidden></p>
        <p class="dupe" id="dupe" role="status" hidden></p>

        <div class="direction" role="group" aria-label="Direction">
          <button type="button" data-dir="out" class="active">Spent</button>
          <button type="button" data-dir="in">Received</button>
        </div>

        <div class="suggestions" id="suggestions" aria-label="Suggestions for right now"></div>

        <div class="chips" id="amount-chips"></div>

        <button type="submit" id="save" class="save" disabled>Save</button>
      </form>

      <div class="toast" id="toast" hidden></div>

      <p class="allowance" id="allowance" hidden></p>

      <h2 class="recent-head">Spending so far</h2>
      <div class="spend-tiles" id="spend-tiles"></div>
    </section>
  `;

  const form = root.querySelector('#entry-form');
  const input = root.querySelector('#entry-input');
  const preview = root.querySelector('#preview');
  const saveBtn = root.querySelector('#save');
  const chips = root.querySelector('#amount-chips');
  const suggestions = root.querySelector('#suggestions');
  const dirButtons = [...root.querySelectorAll('.direction button')];
  const toast = root.querySelector('#toast');
  const spendTiles = root.querySelector('#spend-tiles');
  const datalist = root.querySelector('#known-names');
  const warning = root.querySelector('#surge');
  const splitBox = root.querySelector('#split');
  const dupeBox = root.querySelector('#dupe');
  const allowance = root.querySelector('#allowance');

  let direction = 'out';
  let toastTimer = null;
  // Kept in memory so the surge check on every keystroke never touches IndexedDB.
  let history = [];
  // Every counterparty seen before. This is what tells "pizza for sister" (Sister
  // is a person we know) apart from "charger for laptop", without a word list.
  let people = [];
  // The split shown in the preview, and whether the user has overridden it.
  let plan = null;
  let splitOverride = null;

  function currentParse() {
    const parsed = parseEntry(input.value);
    // "reimbursement from tom" is money arriving, whatever the toggle says. It
    // gets the same override an explicit "+" does, so the preview cannot show a
    // minus on a row that will be saved as income.
    if (parseReimbursement(parsed.name)) {
      return { ...parsed, direction: 'in', explicitDirection: true };
    }
    // "Loan from Khuzaima" is cash arriving. "Chicken piece from Harry" is not —
    // Harry paid, so it is still an expense, just one someone else funded.
    if (parseFromClause(parsed.name)?.cashLoan) {
      return { ...parsed, direction: 'in', explicitDirection: true };
    }
    // An explicit +/- in the text wins over the toggle.
    return { ...parsed, direction: parsed.explicitDirection ? parsed.direction : direction };
  }

  /** True when the entry should be committed as several rows. */
  function splitting() {
    if (!plan) return false;
    return splitOverride === null ? plan.auto : splitOverride;
  }

  /**
   * Show what a multi-row commit will actually write, before it is written.
   *
   * A single unfamiliar name is offered rather than applied: the first "cake for
   * tom" needs one tap, and every later entry naming Tom splits on its own.
   */
  function refreshSplit() {
    splitBox.hidden = !plan;
    if (!plan) return;

    const on = splitting();
    const rows = plan.rows
      .map(
        (r) =>
          `<li><span>${escapeHtml(r.raw_name)}</span>
             <span class="s-share">${formatMinor(r.amount_minor)}</span></li>`
      )
      .join('');

    const who = escapeHtml(plan.people.join(', '));
    let heading;
    if (plan.kind === 'reimbursement') heading = `Cancels what ${who} owed you`;
    else if (plan.kind === 'borrowed') {
      heading = on
        ? `${who} paid — you owe them${plan.cashLoan ? '' : ', nothing left your wallet'}`
        : `Did ${who} pay for this?`;
    } else {
      heading = on
        ? `Split ${plan.rows.length} ways${plan.includesMe ? ', including your share' : ' — all owed back to you'}`
        : `Split between ${who}?`;
    }

    // Both guesses are offered rather than applied when the name is new, so a
    // vendor ("chicken from Metro") never silently becomes a person.
    const askable = plan.kind === 'split' || plan.kind === 'borrowed';
    const toggleLabel =
      plan.kind === 'borrowed' ? (on ? 'No, I paid' : 'Yes, they paid') : on ? 'Keep as one' : 'Split it';

    splitBox.innerHTML = `
      <div class="split-head">
        <span>${heading}</span>
        ${askable ? `<button type="button" id="split-toggle" class="link">${toggleLabel}</button>` : ''}
      </div>
      ${on && plan.kind !== 'borrowed' ? `<ul class="split-rows">${rows}</ul>` : ''}`;

    splitBox.querySelector('#split-toggle')?.addEventListener('click', () => {
      splitOverride = !on;
      refreshSplit();
      input.focus();
    });
  }

  function refreshPreview() {
    const { name, amountMinor, direction: dir } = currentParse();
    const valid = Boolean(name) && amountMinor !== null && amountMinor > 0;
    saveBtn.disabled = !valid;

    if (!input.value.trim()) {
      preview.innerHTML = '<span class="preview-name">&nbsp;</span>';
      return;
    }

    const amountText =
      amountMinor === null
        ? '<span class="preview-missing">amount?</span>'
        : `<span class="preview-amount ${dir}">${formatMinor(amountMinor, {
            sign: dir === 'in' ? '+' : '−',
          })}</span>`;

    preview.innerHTML =
      `<span class="preview-name">${escapeHtml(name) || '<em>name?</em>'}</span>` + amountText;

    // A shared expense or a reimbursement becomes several rows. Recomputed on
    // every keystroke so the breakdown is never stale, and the override is
    // dropped as soon as the entry stops being the one it was chosen for.
    const identity = (p) => p && `${p.kind}:${p.item ?? ''}:${p.people.join('|')}:${p.includesMe}`;
    const before = identity(plan);
    plan = amountMinor === null ? null : planEntry(name, amountMinor, dir, { knownPeople: people });
    if (before !== identity(plan)) splitOverride = null;
    refreshSplit();

    // Already entered? The live data has a 2,200 cake logged twice, thirty-five
    // minutes apart. A split is compared at its total, because no single share
    // of it matches the lump-sum row that duplicates it.
    const commit = splitting() ? plan : null;
    const dupe =
      amountMinor === null
        ? null
        : findDuplicate(history, {
            name: commit?.kind === 'split' ? commit.item : name,
            amountMinor,
            direction: dir,
          });
    dupeBox.hidden = !dupe;
    if (dupe) {
      dupeBox.innerHTML = `Already logged <b>${escapeHtml(dupe.label)}</b> for
        ${formatMinor(dupe.amountMinor)} ${dupe.minutesAgo < 60 ? `${dupe.minutesAgo} min` : `${Math.round(dupe.minutesAgo / 60)} h`} ago.
        Save again only if this is a second one.`;
    }

    // Flag a fare well above what this route normally costs, before it is
    // saved rather than in a monthly report.
    const surge = amountMinor === null ? null : surgeCheck(history, name, amountMinor);
    warning.hidden = !surge;
    if (surge) {
      warning.textContent = `${surge.overBy}% above the usual ${formatMinor(surge.medianMinor)} for this route.`;
    }

    // Keep the toggle honest when the text carries an explicit sign.
    if (currentParse().explicitDirection) setDirection(dir, { silent: true });
  }

  function setDirection(next, { silent = false } = {}) {
    direction = next;
    for (const b of dirButtons) b.classList.toggle('active', b.dataset.dir === next);
    if (!silent) refreshPreview();
  }

  function showToast(message, action) {
    clearTimeout(toastTimer);
    toast.hidden = false;
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.addEventListener('click', async () => {
        await action.run();
        toast.hidden = true;
      });
      toast.append(btn);
    }
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 6000);
  }

  /**
   * Whole-entry chips for the current time of day. Tapping one fills the input
   * with the name and its median amount and leaves the cursor there, so the
   * predicted price is confirmed rather than silently committed — Save is one
   * tap away and already enabled.
   */
  async function refreshSuggestions() {
    const picks = await suggestChips({ limit: 5 });
    suggestions.innerHTML = '';
    if (!picks.length) return;

    for (const pick of picks) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'suggestion';
      b.innerHTML = `<span class="s-name">${escapeHtml(pick.label)}</span>
        <span class="s-amt">${formatMinor(pick.amountMinor)}</span>`;
      b.addEventListener('click', () => {
        const rupees =
          pick.amountMinor % 100 === 0
            ? pick.amountMinor / 100
            : (pick.amountMinor / 100).toFixed(2);
        input.value = `${pick.text} ${rupees}`;
        setDirection('out', { silent: true });
        refreshPreview();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
      suggestions.append(b);
    }
  }

  async function refreshChips() {
    const amounts = await frequentAmounts(8);
    chips.innerHTML = '';
    for (const { amountMinor } of amounts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = formatMinor(amountMinor);
      b.addEventListener('click', () => {
        const { name } = currentParse();
        const rupees = amountMinor % 100 === 0 ? amountMinor / 100 : (amountMinor / 100).toFixed(2);
        input.value = `${name} ${rupees}`.trim();
        refreshPreview();
        input.focus();
      });
      chips.append(b);
    }
  }

  /**
   * Spending at a glance, on the screen where money gets spent. The full list
   * lives in History; here the useful thing is not another list but the shape of
   * a habit — today, this week, this month, each as a running total with a
   * sparkline of the recent comparable windows and a read on whether you are
   * above or below your usual pace.
   *
   * "Spending" is exactly what the Spending tab counts (via `categoryTotals`):
   * consumption plus what you wrote off on others. Savings, transfers, money
   * still owed and reconciliation corrections are all left out, so a tile and
   * that screen can never disagree.
   *
   * The delta is pace-fair: a partial current window is compared against the
   * same fraction of a typical complete one, so "this month" does not read as
   * "down 80%" on the 3rd.
   */
  function spendBetween(from, to) {
    return categoryTotals(history, {
      from: from.toISOString(),
      to: new Date(to.getTime() - 1).toISOString(),
    }).reduce((a, c) => a + c.totalMinor, 0);
  }

  function tileStat(label, ranges, now) {
    // ranges: [{start, end}] oldest→newest, last is the current (maybe partial).
    const values = ranges.map((r) => spendBetween(r.start, r.end));
    const cur = ranges.at(-1);
    const current = values.at(-1);
    const priors = values.slice(0, -1);

    const span = cur.end.getTime() - cur.start.getTime();
    const elapsed = Math.min(1, Math.max(0, (now.getTime() - cur.start.getTime()) / span));
    const typical = priors.length ? priors.reduce((a, v) => a + v, 0) / priors.length : 0;
    const typicalSoFar = typical * elapsed;
    const deltaPct =
      typicalSoFar > 0 ? Math.round(((current - typicalSoFar) / typicalSoFar) * 100) : null;

    const pts = sparkPoints(values);
    const last = pts.at(-1);
    const spark =
      values.some((v) => v > 0) && values.length > 1
        ? `<svg class="spark" width="76" height="24" viewBox="0 0 76 24" aria-hidden="true">
             <polyline class="spark-line" points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" />
             <circle class="spark-dot" cx="${last.x}" cy="${last.y}" r="2" />
           </svg>`
        : '';

    const delta =
      deltaPct === null || deltaPct === 0
        ? ''
        : `<span class="st-delta ${deltaPct > 0 ? 'st-up' : 'st-down'}">${
            deltaPct > 0 ? '▲' : '▼'
          } ${Math.abs(deltaPct)}% vs usual</span>`;

    return `<div class="spend-tile">
      <span class="st-label">${label}</span>
      <span class="st-amt">${formatMinor(current)}</span>
      ${spark}
      ${delta}
    </div>`;
  }

  function refreshSpendTiles() {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Last 7 days, today last.
    const dayRanges = [];
    for (let k = 6; k >= 0; k--) {
      const start = new Date(startOfToday);
      start.setDate(startOfToday.getDate() - k);
      dayRanges.push({ start, end: new Date(start.getTime() + DAY_MS) });
    }

    // Last 6 Monday-start weeks, this week last. Monday matches the
    // payday-weekend fallback used for the month boundary.
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfToday.getDate() - ((startOfToday.getDay() + 6) % 7));
    const weekRanges = [];
    for (let k = 5; k >= 0; k--) {
      const start = new Date(startOfWeek);
      start.setDate(startOfWeek.getDate() - k * 7);
      weekRanges.push({ start, end: new Date(start.getTime() + 7 * DAY_MS) });
    }

    // Last 6 periods, this one last. A timestamp just before a period's start
    // lands in the previous period, so calendarPeriod walks itself backwards.
    const monthRanges = [];
    let probe = now;
    for (let k = 0; k < 6; k++) {
      const p = calendarPeriod(probe);
      monthRanges.unshift({ start: new Date(p.periodStart), end: new Date(p.periodEnd) });
      probe = new Date(new Date(p.periodStart).getTime() - 1);
    }

    spendTiles.innerHTML = [
      tileStat('Today', dayRanges, now),
      tileStat('This week', weekRanges, now),
      tileStat('This month', monthRanges, now),
    ].join('');
  }

  /**
   * What is left, on the screen where money gets spent.
   *
   * A balance buried two taps away in a report is a balance nobody reads. The
   * daily figure sits under the input because that is the only place it can
   * change a decision — the moment before an entry is typed.
   */
  async function refreshAllowance() {
    const [opening, target] = await Promise.all([
      getMeta('budget.opening', null),
      getMeta('budget.savingsTarget', 0),
    ]);
    const b = budgetSummary(history, { opening, savingsTargetMinor: Number(target) || 0 });

    if (b.anchoredTo === 'none' || b.dailyMinor === null) {
      allowance.hidden = true;
      return;
    }

    const over = b.safeToSpendMinor < 0;
    allowance.hidden = false;
    allowance.className = `allowance${over ? ' over' : ''}`;
    allowance.innerHTML = over
      ? `<b>${formatMinor(-b.safeToSpendMinor)} over</b> with ${b.daysLeft} day${
          b.daysLeft === 1 ? '' : 's'
        } to go`
      : `<b>${formatMinor(b.safeToSpendMinor)}</b> left · ${formatMinor(b.dailyMinor)} a day for ${
          b.daysLeft
        } day${b.daysLeft === 1 ? '' : 's'}`;
  }

  async function refreshNames() {
    const names = await knownNames(300);
    datalist.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
  }

  async function refreshAll() {
    history = await allTransactions();
    people = [...new Set(history.map((r) => r.counterparty_name).filter(Boolean))];
    refreshSpendTiles();
    await Promise.all([
      refreshChips(),
      refreshNames(),
      refreshSuggestions(),
      refreshAllowance(),
    ]);
  }

  input.addEventListener('input', refreshPreview);
  for (const b of dirButtons) {
    b.addEventListener('click', () => setDirection(b.dataset.dir));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { name, amountMinor, direction: dir } = currentParse();
    if (!name || amountMinor === null || amountMinor <= 0) return;

    // Capture the decision before clearing the field, which recomputes the plan.
    const commit = splitting() ? plan : null;

    const written = commit
      ? await addTransactions(commit.rows, { source_text: name })
      : [await addTransaction({ raw_name: name, amount_minor: amountMinor, direction: dir })];

    input.value = '';
    setDirection('out', { silent: true });
    refreshPreview();
    input.focus();

    invalidate();
    const summary =
      written.length > 1
        ? `Saved ${formatMinor(amountMinor)} across ${written.length} entries`
        : `Saved ${formatMinor(amountMinor)} · ${name}`;
    showToast(summary, {
      label: 'Undo',
      run: async () => {
        for (const rec of written) await deleteTransaction(rec.id);
        invalidate();
        await refreshAll();
      },
    });

    await refreshAll();
  });

  await refreshAll();
  refreshPreview();
  input.focus();
}

export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
