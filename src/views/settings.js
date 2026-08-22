import { importBluecoins, summarise } from '../import/bluecoins.js';
import {
  allTransactions,
  countTransactions,
  countEvents,
  resetAll,
  getMeta,
  setMeta,
} from '../db/local.js';
import { formatMinor, toMinor } from '../lib/money.js';
import { budgetSummary } from '../lib/budget.js';
import { invalidate } from '../capture/predict.js';
import { isConfigured, currentUser, signIn, signOut } from '../db/supabase.js';
import { syncNow } from '../db/sync.js';
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
          "Money left" counts forward from your last income entry. Set an opening balance
          if you want it anchored to what you actually hold instead — the later of the two wins.
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
      : 'Not set — counting from your last income entry.';
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
   * Re-stamping the opening balance is all it takes: everything after that
   * instant is counted forward from the number you just verified. The drift is
   * logged so a pattern of always being short is visible rather than absorbed. */
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
    await setMeta('budget.opening', { amountMinor: actualMinor, at });
    await setMeta('budget.lastReconciled', { at, driftMinor, actualMinor });
    reconAmount.value = '';
    await Promise.all([refreshBudget(), refreshRecon()]);
    reconMsg.className = 'ok';
    reconMsg.textContent =
      driftMinor === 0
        ? 'Exactly right. Nothing to adjust.'
        : `Adjusted by ${formatMinor(Math.abs(driftMinor))} — you had ${
            driftMinor > 0 ? 'more' : 'less'
          } than tracked. Counting forward from now.`;
  });

  root.querySelector('#clear-opening').addEventListener('click', async () => {
    await setMeta('budget.opening', null);
    await refreshBudget();
    budgetMsg.className = 'ok';
    budgetMsg.textContent = 'Cleared. Counting from your last income entry.';
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

  await Promise.all([refreshStats(), refreshAccount(), refreshBudget(), refreshGoal(), refreshRecon()]);
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
