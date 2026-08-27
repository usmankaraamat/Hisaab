import { importBluecoins, summarise } from '../import/bluecoins.js';
import {
  allTransactions,
  addTransaction,
  updateTransaction,
  countTransactions,
  countEvents,
  resetAll,
  getMeta,
  setMeta,
  newId,
} from '../db/local.js';
import { formatMinor, toMinor } from '../lib/money.js';
import { budgetSummary, RECONCILE } from '../lib/budget.js';
import { SPEND_CATEGORIES, CATEGORIES } from '../lib/categories.js';
import { invalidate } from '../capture/predict.js';
import { isConfigured, currentUser, signIn, signOut } from '../db/supabase.js';
import { syncNow } from '../db/sync.js';
import { ensureIngestToken } from '../db/ingest.js';
import { escapeHtml } from '../capture/entry.js';

export async function renderSettings(root) {
  root.innerHTML = `
    <section class="settings">
      <h2>Settings</h2>

      <div class="card">
        <h3>Sync</h3>
        <div id="account"></div>
      </div>

      <div class="card">
        <h3>Budget</h3>
        <p class="hint">
          "Money left" counts forward from the start of the month — the 1st, or the first
          Monday if the 1st is a weekend, since that is when pay dated the 1st clears. Set an
          opening balance to anchor it to what you actually hold instead; a balance set later
          in the month wins over the month start.
          A savings target is subtracted <em>before</em> the daily allowance, not left over after it.
        </p>
        <label class="stack">Opening balance
          <input type="text" id="opening" inputmode="decimal" placeholder="e.g. 42000" />
        </label>
        <p class="hint" id="opening-at"></p>
        <label class="stack">Savings target per period
          <input type="text" id="target" inputmode="decimal" placeholder="e.g. 30000" />
        </label>
        <p id="budget-msg" class="hint"></p>
        <button type="button" id="save-budget">Save</button>
        <button type="button" id="clear-opening">Clear opening balance</button>
      </div>

      <div class="card">
        <h3>Savings goal</h3>
        <p class="hint">
          Measured against your savings pot — every amount you logged as savings, less
          what you took back out. It never resets when you are paid.
        </p>
        <label class="stack">What for
          <input type="text" id="goal-name" placeholder="e.g. Laptop" spellcheck="false" />
        </label>
        <label class="stack">Amount
          <input type="text" id="goal-amount" inputmode="decimal" placeholder="e.g. 180000" />
        </label>
        <label class="stack">By when <small>(optional)</small>
          <input type="date" id="goal-by" />
        </label>
        <p id="goal-msg" class="hint"></p>
        <button type="button" id="save-goal">Save goal</button>
        <button type="button" id="clear-goal">Clear</button>
      </div>

      <div class="card">
        <h3>Category budgets</h3>
        <p class="hint">
          A monthly cap per category. The Spending tab shows how much of each is left this
          period, and flags any you go over. Leave a box blank for no cap.
        </p>
        <div class="cat-budgets" id="cat-budgets"></div>
        <p id="cat-budget-msg" class="hint"></p>
        <button type="button" id="save-cat-budgets">Save budgets</button>
      </div>

      <div class="card">
        <h3>Recurring &amp; reminders</h3>
        <p class="hint">
          Known charges — rent, a subscription, a salary. When one falls due it appears in
          “To be resolved” on the home screen for a one-tap confirm.
        </p>
        <div id="sched-list"></div>
        <div class="sched-add">
          <input type="text" id="sched-name" placeholder="e.g. Rent" spellcheck="false" />
          <input type="text" id="sched-amt" inputmode="decimal" placeholder="amount" />
          <select id="sched-dir">
            <option value="out">Spent</option>
            <option value="in">Received</option>
          </select>
          <select id="sched-cat"></select>
          <select id="sched-cadence">
            <option value="monthly">Monthly</option>
            <option value="fortnightly">Fortnightly</option>
            <option value="weekly">Weekly</option>
          </select>
          <label class="stack">Next due
            <input type="date" id="sched-due" />
          </label>
          <button type="button" id="add-sched">Add recurring</button>
        </div>
        <p id="sched-msg" class="hint"></p>
      </div>

      <div class="card">
        <h3>Capture rules</h3>
        <p class="hint">
          Anything you type containing the match text is filed under its category at capture,
          before the model runs. Add one here, or tap “remember” when you fix a category in
          History.
        </p>
        <div id="rules-list"></div>
        <div class="rule-add">
          <input type="text" id="rule-match" placeholder="e.g. indrive" spellcheck="false" />
          <select id="rule-cat"></select>
          <button type="button" id="add-rule">Add</button>
        </div>
      </div>

      <div class="card">
        <h3>Count your cash</h3>
        <p class="hint">
          Tracked balances drift — a missed entry, a rounding, a note handed over and
          forgotten. Count what you actually hold and the difference is recorded as an
          adjustment, so the balance stays worth reading.
        </p>
        <p id="recon-now" class="hint"></p>
        <label class="stack">What you actually have
          <input type="text" id="recon-amount" inputmode="decimal" placeholder="count it" />
        </label>
        <p id="recon-msg" class="hint"></p>
        <button type="button" id="do-recon">Reconcile</button>
      </div>

      <div class="card">
        <h3>Auto-capture <small>(advanced)</small></h3>
        <p class="hint">
          Forward payment notifications automatically. An automation app on your phone
          (MacroDroid, Tasker, HTTP Shortcuts) posts each notification to your private
          endpoint; the app turns them into “To be resolved” items. One-time setup — see
          <code>docs/auto-capture.md</code>. Paste and share both work with no setup.
        </p>
        <div id="ingest-box"></div>
      </div>

      <div class="card">
        <h3>Import from Bluecoins</h3>
        <p class="hint">Export from Bluecoins as CSV, then pick the file. Re-importing the same file adds nothing.</p>
        <input type="file" id="csv-file" accept=".csv,text/csv" />
        <div id="import-result"></div>
      </div>

      <div class="card">
        <h3>Export</h3>
        <p class="hint">Bluecoins-compatible CSV. You are never locked in here.</p>
        <button type="button" id="export">Download CSV</button>
      </div>

      <div class="card">
        <h3>Stored locally</h3>
        <dl id="stats"></dl>
      </div>

      <div class="card danger">
        <h3>Reset</h3>
        <p class="hint">Deletes every transaction and event on this device.</p>
        <button type="button" id="reset">Erase all data</button>
      </div>
    </section>
  `;

  const stats = root.querySelector('#stats');
  const result = root.querySelector('#import-result');
  const account = root.querySelector('#account');

  /* Budget.
   *
   * The opening balance is stored with the instant it was stated, not just an
   * amount. Without that timestamp there is no way to know which transactions
   * it already accounts for, and every entry made before it would be
   * double-counted against it. */
  const openingInput = root.querySelector('#opening');
  const openingAt = root.querySelector('#opening-at');
  const targetInput = root.querySelector('#target');
  const budgetMsg = root.querySelector('#budget-msg');

  async function refreshBudget() {
    const [opening, target] = await Promise.all([
      getMeta('budget.opening', null),
      getMeta('budget.savingsTarget', 0),
    ]);
    openingInput.value = opening ? String(opening.amountMinor / 100) : '';
    openingAt.textContent = opening
      ? `Counting from ${new Date(opening.at).toLocaleString()}.`
      : 'Not set — counting from the start of the month.';
    targetInput.value = Number(target) ? String(Number(target) / 100) : '';
  }

  root.querySelector('#save-budget').addEventListener('click', async () => {
    const openingMinor = openingInput.value.trim() ? toMinor(openingInput.value) : null;
    const targetMinor = targetInput.value.trim() ? toMinor(targetInput.value) : 0;

    if (openingInput.value.trim() && (openingMinor === null || openingMinor < 0)) {
      budgetMsg.className = 'warn';
      budgetMsg.textContent = 'That opening balance is not a number.';
      return;
    }
    if (targetMinor === null || targetMinor < 0) {
      budgetMsg.className = 'warn';
      budgetMsg.textContent = 'That savings target is not a number.';
      return;
    }

    const existing = await getMeta('budget.opening', null);
    if (openingMinor === null) {
      await setMeta('budget.opening', null);
    } else if (!existing || existing.amountMinor !== openingMinor) {
      // Re-stamped only when the figure actually changed, so re-saving the page
      // does not silently move the start of the period.
      await setMeta('budget.opening', { amountMinor: openingMinor, at: new Date().toISOString() });
    }
    await setMeta('budget.savingsTarget', targetMinor);

    await refreshBudget();
    budgetMsg.className = 'ok';
    budgetMsg.textContent = 'Saved.';
  });

  /* Savings goal.
   *
   * Stored as minor units plus an optional date. Measured against the pot — the
   * running total of logged savings — not against a per-period figure, because
   * a goal that resets every payday is not a goal. */
  const goalName = root.querySelector('#goal-name');
  const goalAmount = root.querySelector('#goal-amount');
  const goalBy = root.querySelector('#goal-by');
  const goalMsg = root.querySelector('#goal-msg');

  async function refreshGoal() {
    const goal = await getMeta('savings.goal', null);
    goalName.value = goal?.name ?? '';
    goalAmount.value = goal?.targetMinor ? String(goal.targetMinor / 100) : '';
    goalBy.value = goal?.byIso ? goal.byIso.slice(0, 10) : '';
  }

  root.querySelector('#save-goal').addEventListener('click', async () => {
    const targetMinor = toMinor(goalAmount.value);
    if (targetMinor === null || targetMinor <= 0) {
      goalMsg.className = 'warn';
      goalMsg.textContent = 'Enter the amount you are saving towards.';
      return;
    }
    await setMeta('savings.goal', {
      name: goalName.value.trim() || 'Savings goal',
      targetMinor,
      byIso: goalBy.value ? new Date(`${goalBy.value}T12:00:00`).toISOString() : null,
    });
    await refreshGoal();
    goalMsg.className = 'ok';
    goalMsg.textContent = 'Saved. It shows on Overview.';
  });

  root.querySelector('#clear-goal').addEventListener('click', async () => {
    await setMeta('savings.goal', null);
    await refreshGoal();
    goalMsg.className = 'hint';
    goalMsg.textContent = 'Cleared.';
  });

  /* Reconciliation.
   *
   * Recording the difference as one honest "Reconcile cash" row is all it takes:
   * cash moves to what you counted, and — unlike re-stamping the opening balance,
   * which used to reset the start of the period and drop this month's salary out
   * of it, leaving the balance negative — the period stays put. The row is a
   * correction, not a purchase, so it never touches the spending breakdown or the
   * daily allowance. The drift is also logged so a pattern of always being short
   * is visible rather than absorbed. */
  const reconAmount = root.querySelector('#recon-amount');
  const reconNow = root.querySelector('#recon-now');
  const reconMsg = root.querySelector('#recon-msg');

  async function refreshRecon() {
    const [rows, opening, target] = await Promise.all([
      allTransactions(),
      getMeta('budget.opening', null),
      getMeta('budget.savingsTarget', 0),
    ]);
    const b = budgetSummary(rows, { opening, savingsTargetMinor: Number(target) || 0 });
    const last = await getMeta('budget.lastReconciled', null);
    reconNow.textContent =
      `The app thinks you have ${formatMinor(b.cashMinor)}.` +
      (last
        ? ` Last counted ${new Date(last.at).toLocaleDateString()}, ${
            last.driftMinor === 0
              ? 'exactly right'
              : `${formatMinor(Math.abs(last.driftMinor))} ${last.driftMinor > 0 ? 'more' : 'less'} than tracked`
          }.`
        : '');
    return b;
  }

  root.querySelector('#do-recon').addEventListener('click', async () => {
    const actualMinor = toMinor(reconAmount.value);
    if (actualMinor === null || actualMinor < 0) {
      reconMsg.className = 'warn';
      reconMsg.textContent = 'Enter what you counted.';
      return;
    }
    const before = await refreshRecon();
    const driftMinor = actualMinor - before.cashMinor;
    const at = new Date().toISOString();

    // The correction is a real, visible transaction so the balance stays
    // honest without moving the period. It is stamped as already enriched so
    // the model never re-files it out of the Reconcile category the budget maths
    // keys on.
    if (driftMinor !== 0) {
      const rec = await addTransaction({
        raw_name: 'Reconcile cash',
        amount_minor: Math.abs(driftMinor),
        direction: driftMinor > 0 ? 'in' : 'out',
        category: RECONCILE,
        occurred_at: at,
      });
      await updateTransaction(rec.id, { enriched: 1, enriched_at: at });
    }

    await setMeta('budget.lastReconciled', { at, driftMinor, actualMinor });
    reconAmount.value = '';
    invalidate();
    syncNow().catch(() => {});
    await Promise.all([refreshBudget(), refreshRecon()]);
    reconMsg.className = 'ok';
    reconMsg.textContent =
      driftMinor === 0
        ? 'Exactly right. Nothing to adjust.'
        : `Adjusted by ${formatMinor(Math.abs(driftMinor))} — you had ${
            driftMinor > 0 ? 'more' : 'less'
          } than tracked, recorded as a "Reconcile cash" ${
            driftMinor > 0 ? 'credit' : 'charge'
          }.`;
  });

  root.querySelector('#clear-opening').addEventListener('click', async () => {
    await setMeta('budget.opening', null);
    await refreshBudget();
    budgetMsg.className = 'ok';
    budgetMsg.textContent = 'Cleared. Counting from the start of the month.';
  });

  /* Auto-capture. A per-user token the phone automation carries; the client
   * pulls forwarded messages when enabled. All best-effort — the feature is a
   * convenience over manual paste, never a dependency. */
  const ingestBox = root.querySelector('#ingest-box');
  const ingestUrl = `${import.meta.env.VITE_SUPABASE_URL || '<your Supabase URL>'}/functions/v1/ingest`;

  async function refreshIngest() {
    const token = await getMeta('ingest.token', null);
    const enabled = await getMeta('ingest.enabled', false);
    ingestBox.innerHTML = token
      ? `<label class="stack">Endpoint
           <input type="text" readonly value="${escapeHtml(ingestUrl)}" onclick="this.select()" /></label>
         <label class="stack">Your token
           <input type="text" readonly value="${escapeHtml(token)}" onclick="this.select()" /></label>
         <p class="hint">The automation POSTs the notification as plain text, with the
           token in a header — a bank SMS carries line breaks and quotation marks, and
           nothing here has to survive being pasted into JSON:</p>
         <pre class="ingest-body">POST ${escapeHtml(ingestUrl)}?app=&lt;app name&gt;
X-Ingest-Token: ${escapeHtml(token)}
Content-Type: text/plain

&lt;notification text&gt;</pre>
         <label class="ingest-toggle">
           <input type="checkbox" id="ingest-enabled"${enabled ? ' checked' : ''} />
           <span>Pull forwarded messages into the inbox</span>
         </label>
         <p id="ingest-state" class="hint">Checking the token with the server…</p>
         <p id="ingest-msg" class="hint"></p>
         <button type="button" id="ingest-regen" class="link">Generate a new token</button>`
      : `<button type="button" id="ingest-gen">Generate my token</button>`;

    const enabledBox = root.querySelector('#ingest-enabled');
    enabledBox?.addEventListener('change', () => setMeta('ingest.enabled', enabledBox.checked));
    root.querySelector('#ingest-gen')?.addEventListener('click', generateToken);
    root.querySelector('#ingest-regen')?.addEventListener('click', generateToken);
    if (token) showTokenState();
  }

  /* Whether the endpoint will actually accept this token, stated on the screen
   * that shows it. A token the server has never seen looks identical here but
   * answers every macro with 401, and the macro cannot tell you why. */
  async function showTokenState() {
    const { state, detail } = await ensureIngestToken();
    const line = root.querySelector('#ingest-state');
    if (!line) return;
    const said = {
      ok: ['ok', 'Registered — the endpoint will accept this token.'],
      'signed-out': ['warn', 'Not registered: sign in under Sync, then reopen this page. Until then every forwarded message comes back 401.'],
      failed: ['warn', 'Could not register this token, so forwarded messages will 401 until it works. Reopen this page when you are online.'],
      'no-token': ['hint', ''],
    }[state] ?? ['hint', ''];
    line.className = said[0];
    // The underlying reason, when there is one. A generic "could not reach the
    // server" sent the last round of debugging at the network and the macro,
    // when the fault was in this file.
    line.textContent = detail ? `${said[1]} (${detail})` : said[1];
  }

  async function generateToken() {
    const token = `${newId()}${newId()}`.replace(/-/g, '');
    await setMeta('ingest.token', token);

    /* A new token is only half of revoking the old one; the server has to be
     * told, and told that the previous row is finished. `ensureIngestToken`
     * owns both halves so the app start-up path repairs exactly what this
     * button writes. The result is reported rather than swallowed: a token
     * that never reached the server looks identical on this screen and answers
     * every forwarded message with 401. */
    await setMeta('ingest.registered', null);
    const { state, detail } = await ensureIngestToken();
    const registered = state === 'ok';
    const why = state === 'signed-out'
      ? 'Saved on this device, but sign in under Sync before it will work — an unregistered token is refused with 401.'
      : `Saved on this device, but the server would not take it${detail ? `: ${detail}` : ''}. Reopen this page when you are online.`;

    await refreshIngest();
    const msg = root.querySelector('#ingest-msg');
    if (msg) {
      msg.className = registered ? 'ok' : 'warn';
      msg.textContent = registered
        ? 'Token ready, and any earlier one is now revoked. Point your automation app at the endpoint above.'
        : why;
    }
  }

  /* Recurring schedules. A plain array in meta. */
  const schedList = root.querySelector('#sched-list');
  const schedCat = root.querySelector('#sched-cat');
  const schedMsg = root.querySelector('#sched-msg');
  const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
  schedCat.innerHTML =
    '<option value="">no category</option>' +
    CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');

  async function refreshSchedules() {
    const schedules = await getMeta('schedules', []);
    schedList.innerHTML = schedules.length
      ? schedules
          .map(
            (s) => `<div class="rule-row">
              <span class="rule-desc"><b>${escapeHtml(s.name)}</b> · ${formatMinor(s.amountMinor)} · ${
                s.cadence
              }<br><small>next ${DATE.format(new Date(s.nextDue))}${
                s.category ? ` · ${escapeHtml(s.category)}` : ''
              }</small></span>
              <button type="button" class="link" data-del-sched="${s.id}">Remove</button>
            </div>`
          )
          .join('')
      : '<p class="hint">Nothing recurring yet.</p>';
  }

  schedList.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-del-sched]')?.dataset.delSched;
    if (!id) return;
    const schedules = await getMeta('schedules', []);
    await setMeta('schedules', schedules.filter((s) => s.id !== id));
    await refreshSchedules();
  });

  root.querySelector('#add-sched').addEventListener('click', async () => {
    const name = root.querySelector('#sched-name').value.trim();
    const amountMinor = toMinor(root.querySelector('#sched-amt').value);
    const due = root.querySelector('#sched-due').value;
    if (!name || amountMinor === null || amountMinor <= 0 || !due) {
      schedMsg.className = 'warn';
      schedMsg.textContent = 'Give it a name, an amount, and a first due date.';
      return;
    }
    const schedules = await getMeta('schedules', []);
    schedules.push({
      id: newId(),
      name,
      amountMinor,
      direction: root.querySelector('#sched-dir').value === 'in' ? 'in' : 'out',
      category: schedCat.value || null,
      cadence: root.querySelector('#sched-cadence').value,
      // Fire in the morning of the due day rather than at midnight.
      nextDue: new Date(`${due}T09:00:00`).toISOString(),
    });
    await setMeta('schedules', schedules);
    root.querySelector('#sched-name').value = '';
    root.querySelector('#sched-amt').value = '';
    root.querySelector('#sched-due').value = '';
    schedMsg.className = 'ok';
    schedMsg.textContent = 'Added.';
    await refreshSchedules();
  });

  /* Capture rules. A plain array in meta: { id, match, category }. */
  const rulesList = root.querySelector('#rules-list');
  const ruleMatch = root.querySelector('#rule-match');
  const ruleCat = root.querySelector('#rule-cat');
  ruleCat.innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');

  async function refreshRules() {
    const rules = await getMeta('capture.rules', []);
    rulesList.innerHTML = rules.length
      ? rules
          .map(
            (r) => `<div class="rule-row">
              <span class="rule-desc">“${escapeHtml(r.match)}” → <b>${escapeHtml(r.category)}</b></span>
              <button type="button" class="link" data-del="${r.id}">Remove</button>
            </div>`
          )
          .join('')
      : '<p class="hint">No rules yet.</p>';
  }

  rulesList.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-del]')?.dataset.del;
    if (!id) return;
    const rules = await getMeta('capture.rules', []);
    await setMeta('capture.rules', rules.filter((r) => r.id !== id));
    await refreshRules();
  });

  root.querySelector('#add-rule').addEventListener('click', async () => {
    const m = ruleMatch.value.trim().toLowerCase();
    if (!m) return;
    const rules = await getMeta('capture.rules', []);
    if (!rules.some((r) => r.match === m && r.category === ruleCat.value)) {
      await setMeta('capture.rules', [...rules, { id: newId(), match: m, category: ruleCat.value }]);
    }
    ruleMatch.value = '';
    await refreshRules();
  });

  /* Category budgets. Stored as { [category]: capMinor }; a blank box means no
   * cap and is simply left out of the map. */
  const catBudgetsBox = root.querySelector('#cat-budgets');
  const catBudgetMsg = root.querySelector('#cat-budget-msg');

  async function refreshCatBudgets() {
    const budgets = await getMeta('budget.categories', {});
    catBudgetsBox.innerHTML = SPEND_CATEGORIES.map(
      (cat) => `<label class="stack">${cat}
        <input type="text" inputmode="decimal" data-cat="${cat}" placeholder="no cap"
          value="${budgets[cat] ? budgets[cat] / 100 : ''}" /></label>`
    ).join('');
  }

  root.querySelector('#save-cat-budgets').addEventListener('click', async () => {
    const next = {};
    let bad = false;
    for (const input of catBudgetsBox.querySelectorAll('input[data-cat]')) {
      const value = input.value.trim();
      if (!value) continue;
      const minor = toMinor(value);
      if (minor === null || minor <= 0) {
        bad = true;
        continue;
      }
      next[input.dataset.cat] = minor;
    }
    await setMeta('budget.categories', next);
    const count = Object.keys(next).length;
    catBudgetMsg.className = bad ? 'warn' : 'ok';
    catBudgetMsg.textContent = bad
      ? 'Saved the valid ones; some boxes were not numbers.'
      : count
        ? `Saved ${count} budget${count === 1 ? '' : 's'}.`
        : 'Cleared all budgets.';
  });

  async function refreshAccount() {
    if (!isConfigured()) {
      account.innerHTML =
        '<p class="hint">Not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local, then restart the dev server. Capture works fine without this.</p>';
      return;
    }

    const user = await currentUser();

    if (!user) {
      account.innerHTML = `
        <p class="hint">Sign in to sync across devices. A link gets emailed to you — no password.</p>
        <input type="email" id="email" placeholder="you@example.com" autocomplete="email" />
        <button type="button" id="signin">Send link</button>
        <p id="auth-msg"></p>`;

      account.querySelector('#signin').addEventListener('click', async () => {
        const email = account.querySelector('#email').value.trim();
        const msg = account.querySelector('#auth-msg');
        if (!email) return;
        msg.className = 'hint';
        msg.textContent = 'Sending…';
        try {
          await signIn(email);
          msg.className = 'ok';
          msg.textContent = `Link sent to ${email}. Open it on this device.`;
        } catch (err) {
          msg.className = 'warn';
          msg.textContent = err.message;
        }
      });
      return;
    }

    const last = await getMeta('sync.lastRun');
    account.innerHTML = `
      <dl>
        <dt>Signed in</dt><dd>${escapeHtml(user.email || user.id)}</dd>
        <dt>Last sync</dt><dd>${last ? new Date(last).toLocaleString() : 'never'}</dd>
      </dl>
      <p id="sync-msg" class="hint"></p>
      <button type="button" id="sync">Sync now</button>
      <button type="button" id="signout">Sign out</button>`;

    account.querySelector('#sync').addEventListener('click', async () => {
      const msg = account.querySelector('#sync-msg');
      msg.className = 'hint';
      msg.textContent = 'Syncing…';
      try {
        const r = await syncNow();
        await setMeta('sync.lastRun', new Date().toISOString());
        msg.className = 'ok';
        msg.textContent = r.skipped
          ? 'Offline — will sync when back online.'
          : `Pushed ${r.pushed}, pulled ${r.pulled}.`;
        invalidate();
        await refreshStats();
      } catch (err) {
        msg.className = 'warn';
        msg.textContent = err.message;
      }
    });

    account.querySelector('#signout').addEventListener('click', async () => {
      await signOut();
      await refreshAccount();
    });
  }

  async function refreshStats() {
    const [txns, evts, rows] = await Promise.all([
      countTransactions(),
      countEvents(),
      allTransactions(),
    ]);
    const s = summarise(
      rows.map((r) => ({
        amount_minor: r.amount_minor,
        direction: r.direction,
        occurred_at: r.occurred_at,
      }))
    );
    stats.innerHTML = `
      <dt>Transactions</dt><dd>${txns}</dd>
      <dt>Log events</dt><dd>${evts}</dd>
      ${
        s
          ? `<dt>Days covered</dt><dd>${s.days}</dd>
             <dt>Range</dt><dd>${s.min.slice(0, 10)} → ${s.max.slice(0, 10)}</dd>
             <dt>Total spent</dt><dd>${formatMinor(s.spentMinor)}</dd>
             <dt>Total received</dt><dd>${formatMinor(s.receivedMinor)}</dd>`
          : ''
      }`;
  }

  root.querySelector('#csv-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    result.innerHTML = '<p class="hint">Importing…</p>';

    try {
      const text = await file.text();
      const { added, skipped, summary, errors } = await importBluecoins(text);
      invalidate();

      result.innerHTML = `
        <p class="ok">Added ${added}${skipped ? `, skipped ${skipped} already present` : ''}.</p>
        ${
          summary
            ? `<dl class="reconcile">
                 <dt>Rows in file</dt><dd>${summary.count}</dd>
                 <dt>Date range</dt><dd>${summary.min.slice(0, 10)} → ${summary.max.slice(0, 10)}</dd>
                 <dt>Days covered</dt><dd>${summary.days}</dd>
                 <dt>Total spent</dt><dd>${formatMinor(summary.spentMinor)}</dd>
                 <dt>Total received</dt><dd>${formatMinor(summary.receivedMinor)}</dd>
               </dl>
               <p class="hint">Check these against the source file before trusting the import.</p>`
            : ''
        }
        ${errors.length ? `<p class="warn">${errors.length} row(s) skipped:</p><pre>${errors.slice(0, 10).join('\n')}</pre>` : ''}`;

      await refreshStats();
    } catch (err) {
      result.innerHTML = `<p class="warn">Import failed: ${err.message}</p>`;
    }
  });

  root.querySelector('#export').addEventListener('click', async () => {
    const rows = await allTransactions();
    const blob = new Blob([toBluecoinsCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hisaab-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  root.querySelector('#reset').addEventListener('click', async () => {
    if (!confirm('Erase every transaction on this device? This cannot be undone.')) return;
    await resetAll();
    invalidate();
    await refreshStats();
  });

  await Promise.all([
    refreshStats(),
    refreshAccount(),
    refreshBudget(),
    refreshGoal(),
    refreshRecon(),
    refreshCatBudgets(),
    refreshRules(),
    refreshSchedules(),
    refreshIngest(),
  ]);
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** Local wall-clock, matching what Bluecoins writes. */
function localStamp(iso) {
  const d = new Date(iso);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function q(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function toBluecoinsCsv(rows) {
  const header = [
    'Type',
    'Date',
    'Set Time',
    'Name',
    'Amount',
    'Currency',
    'Exchange Rate',
    'Category Group',
    'Category',
    'Account',
    'Notes',
    'Labels',
    'Status',
  ];

  const lines = [header.map(q).join(',')];
  const sorted = [...rows].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));

  for (const r of sorted) {
    const d = new Date(r.occurred_at);
    const signed = (r.direction === 'in' ? 1 : -1) * (r.amount_minor / 100);
    lines.push(
      [
        r.direction === 'in' ? 'Income' : 'Expense',
        localStamp(r.occurred_at),
        `${pad(d.getHours())}:${pad(d.getMinutes())}`,
        r.raw_name,
        signed.toFixed(2),
        r.currency || 'PKR',
        '1.0',
        r.category || 'Others',
        r.category || 'Others',
        'Wallet',
        '',
        '',
        'None',
      ]
        .map(q)
        .join(',')
    );
  }

  return `﻿${lines.join('\n')}\n`;
}
