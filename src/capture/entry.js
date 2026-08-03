/* The capture screen. This is the whole product for Phase 1.
 *
 * Constraints it has to hold to:
 *   - never touch the network (writes go straight to IndexedDB)
 *   - open focused, save on Enter, clear, stay focused
 *   - show exactly how the input was split, so a bad parse is visible
 */

import { parseEntry } from './parse.js';
import { planEntry, parseReimbursement } from './split.js';
import { frequentAmounts, knownNames, suggestChips, invalidate } from './predict.js';
import {
  addTransaction,
  addTransactions,
  deleteTransaction,
  listTransactions,
  allTransactions,
} from '../db/local.js';
import { formatMinor, formatTxnAmount } from '../lib/money.js';
import { surgeCheck } from '../lib/insights.js';

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (Math.abs(mins) < 60) return RELATIVE.format(-mins, 'minute');
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(-hours, 'hour');
  return RELATIVE.format(-Math.round(hours / 24), 'day');
}

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

        <div class="direction" role="group" aria-label="Direction">
          <button type="button" data-dir="out" class="active">Spent</button>
          <button type="button" data-dir="in">Received</button>
        </div>

        <div class="suggestions" id="suggestions" aria-label="Suggestions for right now"></div>

        <div class="chips" id="amount-chips"></div>

        <button type="submit" id="save" class="save" disabled>Save</button>
      </form>

      <div class="toast" id="toast" hidden></div>

      <h2 class="recent-head">Recent</h2>
      <ul class="recent" id="recent"></ul>
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
  const recentList = root.querySelector('#recent');
  const datalist = root.querySelector('#known-names');
  const warning = root.querySelector('#surge');
  const splitBox = root.querySelector('#split');

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

    const heading =
      plan.kind === 'reimbursement'
        ? `Cancels what ${escapeHtml(plan.people.join(', '))} owed you`
        : on
          ? `Split ${plan.rows.length} ways${plan.includesMe ? ', including your share' : ' — all owed back to you'}`
          : `Split between ${escapeHtml(plan.people.join(', '))}?`;

    splitBox.innerHTML = `
      <div class="split-head">
        <span>${heading}</span>
        ${
          plan.kind === 'split'
            ? `<button type="button" id="split-toggle" class="link">${on ? 'Keep as one' : 'Split it'}</button>`
            : ''
        }
      </div>
      ${on || plan.kind === 'reimbursement' ? `<ul class="split-rows">${rows}</ul>` : ''}`;

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
    const before = plan && `${plan.kind}:${plan.people.join('|')}:${plan.includesMe}`;
    plan = amountMinor === null ? null : planEntry(name, amountMinor, dir, { knownPeople: people });
    const after = plan && `${plan.kind}:${plan.people.join('|')}:${plan.includesMe}`;
    if (before !== after) splitOverride = null;
    refreshSplit();

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

  async function refreshRecent() {
    const rows = await listTransactions({ limit: 6 });
    recentList.innerHTML = '';
    if (!rows.length) {
      recentList.innerHTML = '<li class="empty">Nothing yet. Type an expense above.</li>';
      return;
    }
    for (const r of rows) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="r-name">${escapeHtml(r.raw_name)}</span>
        <span class="r-meta">${timeAgo(r.occurred_at)}</span>
        <span class="r-amt ${r.direction}">${formatTxnAmount(r)}</span>`;
      recentList.append(li);
    }
  }

  async function refreshNames() {
    const names = await knownNames(300);
    datalist.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
  }

  async function refreshAll() {
    history = await allTransactions();
    people = [...new Set(history.map((r) => r.counterparty_name).filter(Boolean))];
    await Promise.all([
      refreshRecent(),
      refreshChips(),
      refreshNames(),
      refreshSuggestions(),
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
    const summary = commit
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
