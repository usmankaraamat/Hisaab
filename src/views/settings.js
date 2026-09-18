import { importBluecoins, summarise } from '../import/bluecoins.js';
import {
  allTransactions,
  addTransaction,
  updateTransaction,
  countTransactions,
  countEvents,
  resetAll,
  setFundingSnapshot,
  getMeta,
  setMeta,
  newId,
} from '../db/local.js';
import { formatMinor, toMinor } from '../lib/money.js';
import { budgetSummary, RECONCILE } from '../lib/budget.js';
import { isFundingSnapshot } from '../lib/funding.js';
import { makeFundingTransfer } from '../lib/transfers.js';
import { SPEND_CATEGORIES, CATEGORIES } from '../lib/categories.js';
import { invalidate } from '../capture/predict.js';
import { isConfigured, currentUser, signIn, signOut } from '../db/supabase.js';
import { syncNow } from '../db/sync.js';
import { ensureIngestToken } from '../db/ingest.js';
import { escapeHtml } from '../capture/entry.js';
import { ACCENTS, currentAccent, setAccent } from '../ui/theme.js';
import { createSettingsHelp, openOnboarding } from '../ui/onboarding.js';

export async function renderSettings(root, params) {
  root.innerHTML = `
    <section class="settings">
      <h2>Settings</h2>

      <div class="settings-guide-card">
        <div>
          <b>Not sure what any of this does?</b>
          <span>Start with the quick tour, then open “How to set this up” inside any section.</span>
        </div>
        <button type="button" id="open-guide">Open quick tour</button>
      </div>

      <div class="card">
        <h3>Sync</h3>
        <div id="account"></div>
      </div>

      <div class="card">
        <h3>AI categorisation <small>(optional)</small></h3>
        <p class="hint">
          Hisaab includes five hosted categorisation runs each day. If you use
          them all, you can continue with your own Gemini key. The key stays on
          this device and is not included in sync or exports.
        </p>
        <label class="stack">Personal Gemini key
          <input type="password" id="personal-gemini" placeholder="optional" autocomplete="off" />
        </label>
        <p id="personal-gemini-msg" class="hint"></p>
        <button type="button" id="save-personal-gemini">Save on this device</button>
      </div>

      <div class="card">
        <h3>Accent colour</h3>
        <p class="hint">
          Changes the colour of buttons, links, and the active tab on this device.
          Tap a colour to see it straight away.
        </p>
        <div class="accent-picker" id="accent-picker" role="radiogroup" aria-label="Accent colour"></div>
      </div>

      <div class="card">
        <h3>Monthly spending setup</h3>
        <p class="hint">
          Opening balance tells Hisaab how much money you started the period with. You can
          leave it blank after setting Current balances. A savings target protects that amount
          before Hisaab works out what is safe to spend each day.
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
        <h3>Current balances</h3>
        <p class="hint">
          Essential is money you normally spend from. Other is money you are keeping aside.
          Enter what you have right now; older entries stay in your history. If you only use
          one account, put its full balance in Essential and enter 0 for Other.
        </p>
        <label class="stack">Essential account now
          <input type="text" id="funding-essential" inputmode="decimal" placeholder="e.g. 42000" />
        </label>
        <label class="stack">Other bank money now
          <input type="text" id="funding-other" inputmode="decimal" placeholder="e.g. 180000" />
        </label>
        <p id="funding-at" class="hint"></p>
        <p id="funding-msg" class="hint"></p>
        <button type="button" id="save-funding">Save balances</button>
        <div id="funding-transfer" hidden>
          <h4>Move money between balances</h4>
          <p class="hint">Record a top-up once. It changes the two balances, never your spending or total money.</p>
          <label class="stack">Move from
            <select id="transfer-from">
              <option value="other">Other bank money → Essential</option>
              <option value="essential">Essential → Other bank money</option>
            </select>
          </label>
          <label class="stack">Amount
            <input type="text" id="transfer-amount" inputmode="decimal" placeholder="e.g. 10000" />
          </label>
          <p id="transfer-msg" class="hint"></p>
          <button type="button" id="save-transfer">Move money</button>
        </div>
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
        <h3>Category rules</h3>
        <p class="hint">
          A rule puts familiar purchases in the same category every time. Add one here, or
          tap “remember” after fixing a category in History.
        </p>
        <div id="rules-list"></div>
        <div class="rule-add">
          <input type="text" id="rule-match" placeholder="e.g. indrive" spellcheck="false" />
          <select id="rule-cat"></select>
          <button type="button" id="add-rule">Add</button>
        </div>
      </div>

      <div class="card">
        <h3>Correct a balance</h3>
        <p class="hint">
          If Hisaab and your real balance stop matching, enter what you actually have.
          The difference is recorded as a correction so your history still adds up.
        </p>
        <p id="recon-now" class="hint"></p>
        <label class="stack">What you actually have
          <input type="text" id="recon-amount" inputmode="decimal" placeholder="count it" />
        </label>
        <label class="stack" id="recon-source-wrap" hidden>Balance counted
          <select id="recon-source">
            <option value="essential">Essential account</option>
            <option value="other">Other bank money</option>
          </select>
        </label>
        <p id="recon-msg" class="hint"></p>
        <button type="button" id="do-recon">Correct balance</button>
      </div>

      <div class="card">
        <h3>Payment notification import <small>(advanced)</small></h3>
        <p class="hint">
          This lets an Android automation app forward bank or wallet notifications into
          “To be resolved”. It takes a one-time technical setup; see
          <code>docs/auto-capture.md</code>. For the simple version, use “Paste a message”
          on the Add screen instead.
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
        <h3>Download a backup</h3>
        <p class="hint">Downloads your entries as a Bluecoins-compatible CSV file.</p>
        <button type="button" id="export">Download backup</button>
      </div>

      <div class="card">
        <h3>Data on this device</h3>
        <dl id="stats"></dl>
      </div>

      <div class="card danger">
        <h3>Erase local data</h3>
        <p class="hint">Deletes every transaction and event on this device.</p>
        <button type="button" id="reset">Erase all data</button>
      </div>
    </section>
  `;

  organiseSettings(root);

  root.querySelector('#open-guide').addEventListener('click', (event) => {
    openOnboarding({ returnFocus: event.currentTarget });
  });

  /* Accent colour. A live preview is the whole point: the swatches sit inside
   * the app they recolour, so the choice is judged in place rather than from a
   * name. */
  const accentPicker = root.querySelector('#accent-picker');

  function refreshAccent() {
    const active = currentAccent();
    accentPicker.innerHTML = '';
    for (const accent of ACCENTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'accent-swatch';
      b.dataset.accent = accent.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(accent.id === active.id));
      b.setAttribute('aria-label', accent.name);
      b.title = accent.name;
      b.style.setProperty('--swatch-light', accent.light);
      b.style.setProperty('--swatch-dark', accent.dark);
      b.classList.toggle('active', accent.id === active.id);
      b.innerHTML = `<span class="accent-dot"></span><span class="accent-name">${escapeHtml(accent.name)}</span>`;
      b.addEventListener('click', () => {
        setAccent(accent.id);
        refreshAccent();
      });
      accentPicker.append(b);
    }
  }

  refreshAccent();

  const stats = root.querySelector('#stats');
  const result = root.querySelector('#import-result');
  const account = root.querySelector('#account');

  const personalGemini = root.querySelector('#personal-gemini');
  const personalGeminiMsg = root.querySelector('#personal-gemini-msg');
  personalGemini.value = localStorage.getItem('hisaab.personalGeminiKey') || '';
  root.querySelector('#save-personal-gemini').addEventListener('click', () => {
    const value = personalGemini.value.trim();
    if (value) localStorage.setItem('hisaab.personalGeminiKey', value);
    else localStorage.removeItem('hisaab.personalGeminiKey');
    personalGeminiMsg.className = 'ok';
    personalGeminiMsg.textContent = value ? 'Saved on this device.' : 'Personal key cleared.';
  });

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
  const fundingEssential = root.querySelector('#funding-essential');
  const fundingOther = root.querySelector('#funding-other');
  const fundingAt = root.querySelector('#funding-at');
  const fundingMsg = root.querySelector('#funding-msg');
  const saveFunding = root.querySelector('#save-funding');
  const transferBox = root.querySelector('#funding-transfer');
  const transferFrom = root.querySelector('#transfer-from');
  const transferAmount = root.querySelector('#transfer-amount');
  const transferMsg = root.querySelector('#transfer-msg');
  const saveTransfer = root.querySelector('#save-transfer');

  async function refreshFunding() {
    const [funding, rows, opening, target] = await Promise.all([
      getMeta('budget.funding', null),
      allTransactions(),
      getMeta('budget.opening', null),
      getMeta('budget.savingsTarget', 0),
    ]);
    const configured = isFundingSnapshot(funding);
    const balances = configured
      ? budgetSummary(rows, { opening, savingsTargetMinor: Number(target) || 0, funding })
      : null;
    fundingEssential.value = configured ? String(balances.essentialMinor / 100) : '';
    fundingOther.value = configured ? String(balances.otherMinor / 100) : '';
    fundingEssential.disabled = configured;
    fundingOther.disabled = configured;
    saveFunding.hidden = configured;
    transferBox.hidden = !configured;
    fundingAt.textContent = configured
      ? `Set on ${new Date(funding.at).toLocaleString()}. These are your live balances. Use Correct a balance to fix either one; marking a newer entry as non-essential moves its amount between them. Older entries stay as historical records.`
      : 'Not set. Until you save this, the app uses the original single-balance budget.';

    // There must be one balance anchor. The split snapshot is the newer, more
    // specific model, so leaving opening editable here would make two answers.
    openingInput.disabled = configured;
    openingInput.closest('label').hidden = configured;
    openingAt.hidden = configured;
    root.querySelector('#clear-opening').hidden = configured;
  }

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
    const funding = await getMeta('budget.funding', null);
    const openingMinor = openingInput.value.trim() ? toMinor(openingInput.value) : null;
    const targetMinor = targetInput.value.trim() ? toMinor(targetInput.value) : 0;

    if (!funding && openingInput.value.trim() && (openingMinor === null || openingMinor < 0)) {
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
    if (funding) {
      // The split snapshot owns the balance anchor. The period target remains
      // useful, so saving it must not be blocked by the separate setup.
    } else if (openingMinor === null) {
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

  saveFunding.addEventListener('click', async () => {
    if (saveFunding.disabled) return;
    const essentialMinor = toMinor(fundingEssential.value);
    const otherMinor = toMinor(fundingOther.value);
    if (essentialMinor === null || essentialMinor < 0 || otherMinor === null || otherMinor < 0) {
      fundingMsg.className = 'warn';
      fundingMsg.textContent = 'Enter both current balances as zero or a positive amount.';
      return;
    }

    saveFunding.disabled = true;
    try {
      const user = isConfigured() ? await currentUser() : null;
      await setFundingSnapshot(
        { essentialMinor, otherMinor, at: new Date().toISOString() },
        { ownerId: user?.id ?? null }
      );
      await refreshFunding();
      fundingMsg.className = 'ok';
      fundingMsg.textContent = 'Saved. New purchases draw from Essential until you mark one non-essential in History.';
      invalidate();
      syncNow().catch(() => {});
    } catch (err) {
      fundingMsg.className = 'warn';
      fundingMsg.textContent = `Could not save balances: ${err.message}`;
    } finally {
      saveFunding.disabled = false;
    }
  });

  saveTransfer.addEventListener('click', async () => {
    if (saveTransfer.disabled) return;
    const amountMinor = toMinor(transferAmount.value);
    if (amountMinor === null || amountMinor <= 0) {
      transferMsg.className = 'warn';
      transferMsg.textContent = 'Enter an amount above zero.';
      return;
    }
    saveTransfer.disabled = true;
    try {
      const [funding, rows, opening, target] = await Promise.all([
        getMeta('budget.funding', null),
        allTransactions(),
        getMeta('budget.opening', null),
        getMeta('budget.savingsTarget', 0),
      ]);
      if (!isFundingSnapshot(funding)) throw new Error('Set the two starting balances first.');
      const b = budgetSummary(rows, { opening, savingsTargetMinor: Number(target) || 0, funding });
      const available = transferFrom.value === 'essential' ? b.essentialMinor : b.otherMinor;
      if (amountMinor > available) throw new Error(`Only ${formatMinor(Math.max(0, available))} is available in that balance.`);
      const at = new Date().toISOString();
      await addTransaction(makeFundingTransfer({ from: transferFrom.value, amountMinor, occurredAt: at }));
      transferAmount.value = '';
      invalidate();
      syncNow().catch(() => {});
      await Promise.all([refreshFunding(), refreshRecon()]);
      transferMsg.className = 'ok';
      transferMsg.textContent = 'Moved. Your total money is unchanged.';
    } catch (err) {
      transferMsg.className = 'warn';
      transferMsg.textContent = err.message;
    } finally {
      saveTransfer.disabled = false;
    }
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
  const reconSourceWrap = root.querySelector('#recon-source-wrap');
  const reconSource = root.querySelector('#recon-source');

  async function refreshRecon() {
    const [rows, opening, target, funding] = await Promise.all([
      allTransactions(),
      getMeta('budget.opening', null),
      getMeta('budget.savingsTarget', 0),
      getMeta('budget.funding', null),
    ]);
    const b = budgetSummary(rows, { opening, savingsTargetMinor: Number(target) || 0, funding });
    reconSourceWrap.hidden = !b.funding;
    const last = await getMeta('budget.lastReconciled', null);
    const source = b.funding ? reconSource.value : 'essential';
    const trackedMinor = b.funding
      ? (source === 'other' ? b.otherMinor : b.essentialMinor)
      : b.cashMinor;
    const sourceLabel = source === 'other' ? 'other bank money' : 'essential account';
    reconNow.textContent =
      `The app thinks your ${b.funding ? sourceLabel : 'cash'} is ${formatMinor(trackedMinor)}.` +
      (last
        ? ` Last counted ${new Date(last.at).toLocaleDateString()}, ${
            last.driftMinor === 0
              ? 'exactly right'
              : `${formatMinor(Math.abs(last.driftMinor))} ${last.driftMinor > 0 ? 'more' : 'less'} than tracked`
          }.`
        : '');
    return { b, trackedMinor, source, sourceLabel };
  }

  reconSource.addEventListener('change', () => { refreshRecon().catch(() => {}); });

  const doRecon = root.querySelector('#do-recon');
  doRecon.addEventListener('click', async () => {
    if (doRecon.disabled) return;
    const actualMinor = toMinor(reconAmount.value);
    if (actualMinor === null || actualMinor < 0) {
      reconMsg.className = 'warn';
      reconMsg.textContent = 'Enter what you counted.';
      return;
    }
    doRecon.disabled = true;
    try {
      const before = await refreshRecon();
      const driftMinor = actualMinor - before.trackedMinor;
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
          funding_source: before.b.funding ? before.source : undefined,
        });
        await updateTransaction(rec.id, { enriched: 1, enriched_at: at });
      }

      await setMeta('budget.lastReconciled', { at, driftMinor, actualMinor, fundingSource: before.source });
      reconAmount.value = '';
      invalidate();
      syncNow().catch(() => {});
    await Promise.all([refreshBudget(), refreshFunding(), refreshRecon()]);
      reconMsg.className = 'ok';
      reconMsg.textContent =
        driftMinor === 0
          ? 'Exactly right. Nothing to adjust.'
          : `Adjusted your ${before.sourceLabel} by ${formatMinor(Math.abs(driftMinor))} — you had ${
              driftMinor > 0 ? 'more' : 'less'
            } than tracked, recorded as a "Reconcile cash" ${
              driftMinor > 0 ? 'credit' : 'charge'
            }.`;
    } catch (err) {
      reconMsg.className = 'warn';
      reconMsg.textContent = `Could not reconcile: ${err.message}`;
    } finally {
      doRecon.disabled = false;
    }
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
    refreshFunding(),
    refreshGoal(),
    refreshRecon(),
    refreshCatBudgets(),
    refreshRules(),
    refreshSchedules(),
    refreshIngest(),
  ]);

  if (params?.get('focus') === 'transfer') {
    const section = transferBox.closest('details');
    if (section) section.open = true;
    (transferBox.hidden ? fundingEssential : transferAmount).focus();
  }
}

function organiseSettings(root) {
  const section = root.querySelector('.settings');
  const cards = [...section.querySelectorAll(':scope > .card')];
  const byTitle = new Map(cards.map((card) => [card.querySelector('h3')?.textContent.trim(), card]));

  const groups = [
    ['Account & sync', 'Use the same ledger on your devices.', ['Sync'], true],
    ['Smart capture', 'Optional categorisation and notification shortcuts.', ['AI categorisation (optional)', 'Payment notification import (advanced)'], false],
    ['Appearance', 'Choose how the app looks on this device.', ['Accent colour'], false],
    ['Balances & budget', 'Set what you have, what to protect, and where to slow down.', ['Current balances', 'Monthly spending setup', 'Savings goal', 'Category budgets'], false],
    ['Recurring payments', 'Keep regular bills and income from slipping past.', ['Recurring & reminders'], false],
    ['Automatic categories', 'File familiar purchases the same way every time.', ['Category rules'], false],
    ['Backup & corrections', 'Fix a balance, move old data, or download a copy.', ['Correct a balance', 'Import from Bluecoins', 'Download a backup', 'Data on this device'], false],
    ['Reset', 'Start over on this device.', ['Erase local data'], false],
  ];

  for (const [title, note, names, open] of groups) {
    const details = document.createElement('details');
    details.className = `settings-group${title === 'Reset' ? ' danger-zone' : ''}`;
    if (open) details.open = true;
    details.innerHTML = `<summary><span><b>${title}</b><small>${note}</small></span></summary>`;
    const help = createSettingsHelp(title);
    if (help) details.append(help);
    for (const name of names) {
      const card = byTitle.get(name);
      if (!card) continue;
      card.classList.add('settings-subcard');
      details.append(card);
    }
    section.append(details);
  }
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
