/* The capture screen. This is the whole product for Phase 1.
 *
 * Constraints it has to hold to:
 *   - never touch the network (writes go straight to IndexedDB)
 *   - open focused, save on Enter, clear, stay focused
 *   - show exactly how the input was split, so a bad parse is visible
 */

import { parseEntry } from './parse.js';
import { planEntry, parseReimbursement, parseFromClause } from './split.js';
import { knownNames, suggestChips, invalidate } from './predict.js';
import {
  addTransaction,
  addTransactions,
  deleteTransaction,
  allTransactions,
  listPending,
  addPending,
  deletePending,
  getMeta,
  setMeta,
} from '../db/local.js';
import { parseNotification } from './notif.js';
import { matchRule, ruleFields } from '../lib/rules.js';
import { dueSchedules, advanceSchedule, occurrenceKey } from '../lib/schedule.js';
import { formatMinor, toMinor } from '../lib/money.js';
import { surgeCheck } from '../lib/insights.js';
import { syncNow } from '../db/sync.js';
import { budgetSummary, categoryTotals, calendarPeriod } from '../lib/budget.js';
import { sparkPoints } from '../lib/chart.js';
import { findDuplicate } from '../lib/dupes.js';
import { learnPayee, recallPayee } from '../lib/payees.js';
import { icon } from '../ui/icons.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/* The order of this screen is an argument about attention.
 *
 * The input is first because capture is the product. What comes next is
 * whatever the app is *waiting on you for* — a forwarded payment whose meaning
 * only you know — because that is the likeliest next action and it used to sit
 * below three blocks of reporting, which meant scrolling past two numbers to do
 * the one thing outstanding. It disappears entirely when there is nothing
 * pending, so the quiet case stays quiet.
 *
 * Then the suggestions, which are a faster way to type — three of them, for the
 * two-hour slot of the day you are in. The row of stock amounts that used to
 * follow them is gone: it was a numpad that guessed, and nobody tapped it, so
 * the numbers that do get read now start a screenful higher. Those come in the
 * order they change a decision: what is left per day first, then the shape
 * of the habit. "Paste a message" sits at the very bottom: it is a tool, used
 * once in a while, and it was taking a heading next to work that mattered.
 */
export async function renderAdd(root) {
  root.innerHTML = `
    <section class="capture">
      <form id="entry-form" class="capture-composer" autocomplete="off">
        <div class="composer-line">
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
          <button type="submit" id="save" class="save" disabled aria-label="Save entry">${icon('arrowUp', { size: 22 })}</button>
        </div>

        <div class="preview" id="preview" aria-live="polite">
          <span class="preview-name">&nbsp;</span>
        </div>

        <div class="split" id="split" role="status" hidden></div>

        <p class="surge" id="surge" role="status" hidden></p>
        <p class="dupe" id="dupe" role="status" hidden></p>

        <div class="direction" role="group" aria-label="Direction">
          <button type="button" data-dir="out" class="active" aria-pressed="true">Spent</button>
          <button type="button" data-dir="in" aria-pressed="false">Received</button>
        </div>
      </form>

      <section class="inbox" id="inbox" hidden>
        <h2 class="recent-head" id="inbox-head">To be resolved</h2>
        <ul class="inbox-list" id="inbox-list"></ul>
      </section>

      <div class="suggestions" id="suggestions" aria-label="Suggestions for right now"></div>

      <div class="toast" id="toast" hidden></div>

      <p class="allowance" id="allowance" hidden></p>

      <h2 class="recent-head">Spending so far</h2>
      <div class="spend-tiles" id="spend-tiles"></div>

      <div class="paste-foot">
        <button type="button" class="link" id="paste-notif">Paste a message</button>
        <form class="paste-box" id="paste-box" hidden>
          <textarea id="paste-text" rows="3" placeholder="Paste a bank or wallet notification…"
            spellcheck="false"></textarea>
          <div class="paste-actions">
            <button type="button" class="link" id="paste-cancel">Cancel</button>
            <button type="submit">Add</button>
          </div>
          <p class="paste-msg hint" id="paste-msg"></p>
        </form>
      </div>
    </section>
  `;

  const form = root.querySelector('#entry-form');
  const input = root.querySelector('#entry-input');
  const preview = root.querySelector('#preview');
  const saveBtn = root.querySelector('#save');
  const suggestions = root.querySelector('#suggestions');
  const dirButtons = [...root.querySelectorAll('.direction button')];
  const toast = root.querySelector('#toast');
  const spendTiles = root.querySelector('#spend-tiles');
  const inbox = root.querySelector('#inbox');
  const inboxHead = root.querySelector('#inbox-head');
  const inboxList = root.querySelector('#inbox-list');
  const pasteBtn = root.querySelector('#paste-notif');
  const pasteBox = root.querySelector('#paste-box');
  const pasteText = root.querySelector('#paste-text');
  const pasteMsg = root.querySelector('#paste-msg');
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
  // Deterministic capture rules, applied to plain entries before the model runs.
  let rules = [];
  // What each payee has sold you before, so a resolve form opens on the thing
  // rather than on their name. See lib/payees.js.
  let payees = {};

  /* If a rule matches, set its category outright and mark the row done so the
   * enrichment pass leaves it alone. Splits are exempt: they already carry a
   * stated meaning. Returns the input, mutated. */
  function applyRule(input) {
    const fields = ruleFields(matchRule(rules, input.raw_name));
    if (fields) {
      input.category = fields.category;
      input.enriched_at = new Date().toISOString();
    }
    return input;
  }

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
    for (const b of dirButtons) {
      const active = b.dataset.dir === next;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    }
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
   * Whole-entry rows for the two-hour slot the user is in right now, drawn from
   * the days that resemble today — the last five weekdays, or the last two
   * weekends. Three of them, not five: this sits above the numbers that were
   * being scrolled past, and a shorter list is read rather than scanned. They
   * carry no caption — a name and its price are self-evident, and a line of
   * explanation above three short rows was more furniture than the rows.
   *
   * Tapping one fills the input with the name and its median amount and leaves
   * the cursor there, so the predicted price is confirmed rather than silently
   * committed — Save is one tap away and already enabled.
   */
  async function refreshSuggestions() {
    const picks = await suggestChips({ limit: 3 });
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

  /* ---------------------------------------------------------- pending inbox */

  /**
   * Captures waiting to be resolved — a payment notification whose amount is
   * known but whose *meaning* is not. This is the other half of the capture
   * thesis: the notification already did the typing, so all that is left is to
   * say what the money was for, and to split one payment across several things
   * when that is what it was.
   */
  /* Surface any recurring charge that has come due into the inbox, then advance
   * it. Idempotent: the occurrence key means running this on every refresh adds
   * each due charge exactly once. */
  async function materializeDue() {
    const schedules = await getMeta('schedules', []);
    const due = dueSchedules(schedules, new Date());
    if (!due.length) return;
    for (const s of due) {
      await addPending({
        amountMinor: s.amountMinor,
        direction: s.direction,
        counterparty: s.name,
        category: s.category || null,
        source: 'Recurring',
        kind: 'recurring',
        source_key: occurrenceKey(s),
        occurred_at: s.nextDue,
        raw: `${s.name} — recurring ${s.cadence}`,
      });
    }
    const now = new Date();
    const advanced = schedules.map((s) =>
      due.some((d) => d.id === s.id) ? advanceSchedule(s, now) : s
    );
    await setMeta('schedules', advanced);
  }

  async function refreshPending() {
    await materializeDue();
    const items = await listPending();
    inboxList.innerHTML = '';

    // Nothing waiting means nothing here at all. An empty section with a line
    // of explanation is a permanent apology for a screen that is working.
    if (!items.length) {
      inbox.hidden = true;
      return;
    }

    inbox.hidden = false;
    inboxHead.textContent =
      items.length === 1 ? 'To be resolved' : `To be resolved · ${items.length}`;
    for (const p of items) inboxList.append(pendingRow(p, items.length === 1));
  }

  function dirWord(dir) {
    return dir === 'in' ? 'Received' : 'Sent';
  }

  function pendingRow(p, openNow = false) {
    const li = document.createElement('li');
    li.className = 'inbox-row';
    const bits = [p.source || 'payment', p.counterparty].filter(Boolean).join(' · ');
    const tag = p.kind === 'recurring' ? '<span class="inbox-tag">due</span>' : '';
    li.innerHTML = `
      <button type="button" class="inbox-open">
        <span class="inbox-amt ${p.direction}">${p.direction === 'in' ? '+' : ''}${formatMinor(
          p.amountMinor
        )}</span>
        <span class="inbox-meta"><b>${dirWord(p.direction)}</b> · ${escapeHtml(bits)}${tag}</span>
      </button>`;

    const open = ({ focus = true } = {}) => {
      if (li.querySelector('form')) return;
      li.append(resolver(p, li));
      if (focus) li.querySelector('input[name="name"]')?.focus();
    };
    li.querySelector('.inbox-open').addEventListener('click', () => open());

    // One waiting payment needs no tap to reveal itself — opening it is the
    // only reason to be looking at it. Several stay collapsed, because a list
    // of open forms is not a list.
    if (openNow) open({ focus: false });
    return li;
  }

  /**
   * Resolve one pending capture into real transactions. The captured amount is
   * the truth — money that actually moved — so the line items must add back to
   * it, the same rule the shared-expense split already lives by. Each item is a
   * normal capture line: "for sister" splits it, "reimbursement from tom" nets
   * it, plain text is an ordinary entry.
   */
  function resolver(p, li) {
    const form = document.createElement('form');
    form.className = 'resolve';

    const itemRow = (name = '', amountMinor = null) => `
      <div class="resolve-item">
        <input name="name" type="text" placeholder="what was it for?" spellcheck="false"
          value="${escapeHtml(name)}" />
        <input name="amt" type="text" inputmode="decimal" placeholder="amount"
          value="${amountMinor === null ? '' : (amountMinor / 100).toFixed(2).replace(/\.00$/, '')}" />
        <button type="button" class="resolve-del" aria-label="Remove item">×</button>
      </div>`;

    /* What this payee has sold you before — never who they are.
     *
     * The name box used to open holding the counterparty, which is never the
     * answer: you are not buying *Awais Iqbal*, you are buying chicken from
     * him, so the first keystroke was always a clear. The payee is still the
     * best clue available, just about the wrong field. See lib/payees.js for
     * why one shop is filled in and another is only offered. */
    const recall = recallPayee(payees, p.counterparty);
    const usual = recall.items.length
      ? `<div class="resolve-recall">
           <span class="hint">${escapeHtml(p.counterparty || 'Before')}:</span>
           ${recall.items
             .map((i) => `<button type="button" class="chip">${escapeHtml(i.name)}</button>`)
             .join('')}
         </div>`
      : '';

    form.innerHTML = `
      ${p.raw ? `<p class="resolve-raw">${escapeHtml(p.raw)}</p>` : ''}
      ${usual}
      <div class="resolve-items">${itemRow(recall.fill || '', p.amountMinor)}</div>
      <button type="button" class="link resolve-add">+ Add another item</button>
      <p class="resolve-sum hint"></p>
      <div class="resolve-actions">
        <button type="button" class="danger" data-act="dismiss">Dismiss</button>
        <button type="submit">Log</button>
      </div>`;

    const items = form.querySelector('.resolve-items');
    const sumLine = form.querySelector('.resolve-sum');
    const submit = form.querySelector('button[type="submit"]');

    const readItems = () =>
      [...items.querySelectorAll('.resolve-item')].map((row) => ({
        name: row.querySelector('input[name="name"]').value.trim(),
        amtMinor: toMinor(row.querySelector('input[name="amt"]').value),
      }));

    function refreshSum() {
      const rows = readItems();
      const sum = rows.reduce((a, r) => a + (r.amtMinor || 0), 0);
      const diff = p.amountMinor - sum;
      const balanced = Math.abs(diff) < 1;
      sumLine.textContent = balanced
        ? `Adds up to ${formatMinor(p.amountMinor)}.`
        : diff > 0
          ? `${formatMinor(diff)} left of ${formatMinor(p.amountMinor)} to account for.`
          : `${formatMinor(-diff)} over the ${formatMinor(p.amountMinor)} received.`;
      sumLine.className = `resolve-sum hint${balanced ? ' ok' : ''}`;
      submit.disabled = !balanced || rows.some((r) => !r.name);
    }

    // A remembered name goes into whichever box is in play: the one being
    // typed in, else the first still empty, else the first.
    form.querySelector('.resolve-recall')?.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const boxes = [...items.querySelectorAll('input[name="name"]')];
      const box =
        boxes.find((b) => b === document.activeElement) || boxes.find((b) => !b.value) || boxes[0];
      box.value = chip.textContent;
      box.focus();
      refreshSum();
    });

    items.addEventListener('input', refreshSum);
    items.addEventListener('click', (e) => {
      if (!e.target.closest('.resolve-del')) return;
      if (items.querySelectorAll('.resolve-item').length <= 1) return;
      e.target.closest('.resolve-item').remove();
      refreshSum();
    });

    form.querySelector('.resolve-add').addEventListener('click', () => {
      // Seed the new row with whatever is still unaccounted for.
      const sum = readItems().reduce((a, r) => a + (r.amtMinor || 0), 0);
      const left = Math.max(0, p.amountMinor - sum);
      items.insertAdjacentHTML('beforeend', itemRow('', left || null));
      refreshSum();
      items.querySelector('.resolve-item:last-child input[name="name"]').focus();
    });

    form.addEventListener('click', async (e) => {
      if (e.target.closest('button[data-act="dismiss"]')) {
        await deletePending(p.id);
        await refreshPending();
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rows = readItems();
      if (rows.some((r) => !r.name || !r.amtMinor)) return;

      for (const it of rows) {
        const plan = planEntry(it.name, it.amtMinor, p.direction, { knownPeople: people });
        if (plan) {
          await addTransactions(
            plan.rows.map((r) => ({ ...r, occurred_at: p.occurred_at })),
            { source_text: it.name }
          );
        } else {
          const input = applyRule({
            raw_name: it.name,
            amount_minor: it.amtMinor,
            direction: p.direction,
            occurred_at: p.occurred_at,
          });
          // A recurring capture carries its category; use it unless a rule
          // already spoke.
          if (!input.category && p.category) {
            input.category = p.category;
            input.enriched_at = new Date().toISOString();
          }
          await addTransaction(input);
        }
      }

      // Remember the pairing before the pending row is gone, so the next
      // payment to this payee opens on what you actually bought from them.
      if (p.counterparty) {
        payees = learnPayee(payees, p.counterparty, rows.map((r) => r.name), p.occurred_at);
        await setMeta('payees', payees);
      }

      await deletePending(p.id);
      invalidate();
      syncNow().catch(() => {});
      showToast(
        rows.length > 1
          ? `Logged ${formatMinor(p.amountMinor)} across ${rows.length} entries`
          : `Logged ${formatMinor(p.amountMinor)} · ${rows[0].name}`
      );
      await refreshAll();
    });

    refreshSum();
    return form;
  }

  function openPaste(prefill = '') {
    pasteBox.hidden = false;
    pasteMsg.textContent = '';
    pasteText.value = prefill;
    pasteText.focus();
  }

  pasteBtn.addEventListener('click', () => {
    if (pasteBox.hidden) openPaste();
    else pasteBox.hidden = true;
  });
  root.querySelector('#paste-cancel').addEventListener('click', () => {
    pasteBox.hidden = true;
  });
  pasteBox.addEventListener('submit', async (e) => {
    e.preventDefault();
    const parsed = parseNotification(pasteText.value);
    if (!parsed) {
      pasteMsg.className = 'paste-msg warn';
      pasteMsg.textContent = "Couldn't find an amount in that. Paste the whole message.";
      return;
    }
    await addPending({ ...parsed, occurred_at: parsed.occurredAt });
    pasteText.value = '';
    pasteBox.hidden = true;
    await refreshPending();
  });

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
    // The per-day figure leads. It is the one that can change what you do in
    // the next minute; the balance behind it is context for the figure, not the
    // other way round.
    allowance.innerHTML = over
      ? `<span class="allowance-kicker">Money for now</span>
         <span class="allowance-main">${formatMinor(-b.safeToSpendMinor)} over</span>
         <span class="allowance-detail">${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'} left in this period</span>`
      : `<span class="allowance-kicker">Money for now</span>
         <span class="allowance-main">${formatMinor(b.dailyMinor)} <small>a day</small></span>
         <span class="allowance-detail">${formatMinor(b.safeToSpendMinor)} safe · ${b.daysLeft} day${
           b.daysLeft === 1 ? '' : 's'
         } remaining</span>`;
  }

  async function refreshNames() {
    const names = await knownNames(300);
    datalist.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
  }

  async function refreshAll() {
    history = await allTransactions();
    rules = await getMeta('capture.rules', []);
    payees = await getMeta('payees', {});
    people = [...new Set(history.map((r) => r.counterparty_name).filter(Boolean))];
    refreshSpendTiles();
    await Promise.all([
      refreshNames(),
      refreshSuggestions(),
      refreshAllowance(),
      refreshPending(),
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
      : [await addTransaction(applyRule({ raw_name: name, amount_minor: amountMinor, direction: dir }))];

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
