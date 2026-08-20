/* History: everything captured, filterable, and editable in place.
 *
 * Two things this screen owes the rest of the app:
 *
 *   It is where a category actually becomes useful. The enrichment pass has
 *   been filing rows for weeks, but until there was a way to ask "how much on
 *   Eating Out", that filing was invisible work. The Spending card on Insights
 *   links straight here with a category applied.
 *
 *   It shows the tidy name, not the raw text. `home office indrive` was
 *   resolved to Indrive Home → Office at enrichment time and the app was
 *   throwing that away on every render. The raw text still appears under it
 *   when the two differ, so a rewrite is always visible and never silent.
 */

import { listTransactions, deleteTransaction, updateTransaction } from '../db/local.js';
import { formatTxnAmount, formatMinor, toMinor } from '../lib/money.js';
import { escapeHtml } from '../capture/entry.js';
import { txnLabel, hasRewrite } from '../lib/label.js';
import { personKey } from '../capture/split.js';
import { invalidate } from '../capture/predict.js';
import { syncNow } from '../db/sync.js';

const DAY = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

const filter = { text: '', category: '', person: '' };

export async function renderHistory(root, params) {
  // A link from another tab wins over whatever was left set here.
  if (params?.has('cat')) {
    filter.category = params.get('cat') || '';
    filter.text = '';
    filter.person = '';
  }
  if (params?.has('person')) {
    filter.person = params.get('person') || '';
    filter.text = '';
    filter.category = '';
  }

  root.innerHTML = `
    <section class="history">
      <h2>History</h2>
      <div class="h-filter">
        <input id="f-text" type="search" placeholder="Search" aria-label="Search entries"
               value="${escapeHtml(filter.text)}" spellcheck="false" />
        <div class="h-filter-row">
          <select id="f-cat" aria-label="Filter by category"></select>
          <select id="f-person" aria-label="Filter by person"></select>
        </div>
      </div>
      <div id="history-body"><p class="empty">Loading…</p></div>
    </section>
  `;

  const body = root.querySelector('#history-body');
  const text = root.querySelector('#f-text');
  const cat = root.querySelector('#f-cat');
  const person = root.querySelector('#f-person');

  let debounce = null;
  text.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      filter.text = text.value;
      paint(body, { cat, person });
    }, 150);
  });
  cat.addEventListener('change', () => {
    filter.category = cat.value;
    paint(body, { cat, person });
  });
  person.addEventListener('change', () => {
    filter.person = person.value;
    paint(body, { cat, person });
  });

  await paint(body, { cat, person });
}

/** ISO instant -> the "YYYY-MM-DDTHH:mm" a datetime-local input expects, in local time. */
function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function matches(r) {
  if (filter.category && (r.category || 'Uncategorised') !== filter.category) return false;
  // By key, not by string: the Spending card links in with whichever spelling
  // it saw first, and "sister" must not filter out "Sister".
  if (filter.person && personKey(r.counterparty_name) !== personKey(filter.person)) return false;
  if (filter.text) {
    const needle = filter.text.toLowerCase();
    const hay = `${r.raw_name} ${r.display_name ?? ''} ${r.category ?? ''} ${r.counterparty_name ?? ''}`;
    if (!hay.toLowerCase().includes(needle)) return false;
  }
  return true;
}

/** Rebuild both dropdowns from what is actually in the data, keeping the selection. */
function fillOptions(select, values, current, allLabel) {
  select.innerHTML =
    `<option value="">${allLabel}</option>` +
    values
      .map((v) => `<option value="${escapeHtml(v)}"${v === current ? ' selected' : ''}>${escapeHtml(v)}</option>`)
      .join('');
  // A filter that no longer matches anything would otherwise strand the screen
  // on an empty list with no visible cause.
  if (current && !values.includes(current)) select.value = '';
}

async function paint(body, controls) {
  const rows = await listTransactions({ limit: 2000 });

  if (controls) {
    fillOptions(
      controls.cat,
      [...new Set(rows.map((r) => r.category || 'Uncategorised'))].sort(),
      filter.category,
      'All categories'
    );
    fillOptions(
      controls.person,
      [...new Set(rows.map((r) => r.counterparty_name).filter(Boolean))].sort(),
      filter.person,
      'Anyone'
    );
    if (!controls.cat.value) filter.category = '';
    if (!controls.person.value) filter.person = '';
  }

  const shown = rows.filter(matches);
  const filtering = Boolean(filter.text || filter.category || filter.person);

  if (!rows.length) {
    body.innerHTML = '<p class="empty">No transactions yet.</p>';
    return;
  }
  if (!shown.length) {
    body.innerHTML = '<p class="empty">Nothing matches that.</p>';
    return;
  }

  body.innerHTML = '';

  if (filtering) {
    const total = shown
      .filter((r) => r.direction === 'out')
      .reduce((a, b) => a + b.amount_minor, 0);
    const summary = document.createElement('div');
    summary.className = 'h-summary';
    summary.innerHTML = `<span>${shown.length} entr${shown.length === 1 ? 'y' : 'ies'}</span>
      <span class="num">${formatMinor(total)}</span>`;
    body.append(summary);
  }

  // Group by calendar day, newest first. listTransactions already sorts.
  const groups = new Map();
  for (const r of shown) {
    const key = r.occurred_at.slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  for (const [day, items] of groups) {
    const spent = items
      .filter((i) => i.direction === 'out')
      .reduce((a, b) => a + b.amount_minor, 0);

    const section = document.createElement('div');
    section.className = 'day';
    section.innerHTML = `
      <div class="day-head">
        <span>${DAY.format(new Date(`${day}T12:00:00`))}</span>
        <span class="day-total">${formatMinor(spent)}</span>
      </div>
      <ul></ul>`;

    const ul = section.querySelector('ul');
    for (const r of items) ul.append(row(r, body, controls));
    body.append(section);
  }
}

function row(r, body, controls) {
  const li = document.createElement('li');
  li.className = 'h-row';

  // Whatever is known about the row beyond the raw text — set by the enrichment
  // pass, or at capture for a shared expense.
  const tags = [
    r.category,
    r.counterparty_name
      ? `${r.counterparty_name}${r.ledger_effect ? ` · ${r.ledger_effect.replace('_', ' ')}` : ''}`
      : null,
  ].filter(Boolean);

  li.innerHTML = `
    <button type="button" class="r-open" aria-label="Edit ${escapeHtml(r.raw_name)}">
      <span class="r-name">${escapeHtml(txnLabel(r))}</span>
      ${hasRewrite(r) ? `<span class="r-raw">${escapeHtml(r.raw_name)}</span>` : ''}
      ${tags.length ? `<span class="r-tags">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</span>` : ''}
      <span class="r-amt ${r.direction}">${formatTxnAmount(r)}</span>
    </button>`;

  li.querySelector('.r-open').addEventListener('click', () => {
    if (li.querySelector('form')) return;
    li.append(editor(r, body, controls));
    li.querySelector('input[name="name"]').focus();
  });

  return li;
}

/**
 * Inline editor. Correcting a typo is the single most common thing a person
 * wants from a history list, and until now the only options were delete and
 * retype.
 *
 * Changing the text or the amount clears the enrichment fields and re-queues
 * the row, because a category derived from the old text is no longer evidence
 * for anything. The counterparty and ledger effect survive: those were stated
 * by the user, not inferred, and dropping them would silently break a balance.
 */
function editor(r, body, controls) {
  const form = document.createElement('form');
  form.className = 'h-edit';
  form.innerHTML = `
    <label>Name
      <input name="name" type="text" value="${escapeHtml(r.raw_name)}" required spellcheck="false" />
    </label>
    <div class="h-edit-row">
      <label>Amount
        <input name="amount" type="text" inputmode="decimal" value="${(r.amount_minor / 100).toFixed(2).replace(/\.00$/, '')}" required />
      </label>
      <label>Direction
        <select name="direction">
          <option value="out"${r.direction === 'out' ? ' selected' : ''}>Spent</option>
          <option value="in"${r.direction === 'in' ? ' selected' : ''}>Received</option>
        </select>
      </label>
    </div>
    <label>When
      <input name="when" type="datetime-local" value="${toLocalInput(r.occurred_at)}" />
    </label>
    <p class="h-edit-msg" hidden></p>
    <div class="h-edit-actions">
      <button type="button" data-act="delete" class="danger">Delete</button>
      <button type="button" data-act="cancel">Cancel</button>
      <button type="submit">Save</button>
    </div>`;

  const msg = form.querySelector('.h-edit-msg');
  const fail = (text) => {
    msg.hidden = false;
    msg.textContent = text;
  };

  form.addEventListener('click', async (e) => {
    const act = e.target.closest('button[data-act]')?.dataset.act;
    if (act === 'cancel') form.remove();
    if (act === 'delete') {
      await deleteTransaction(r.id);
      invalidate();
      syncNow().catch(() => {});
      await paint(body, controls);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // `form.elements`, not `form.name` — the latter is the form's own name.
    const fields = form.elements;
    const name = fields.name.value.trim();
    const amountMinor = toMinor(fields.amount.value);
    const when = fields.when.value;

    if (!name) return fail('A name is required.');
    if (amountMinor === null || amountMinor <= 0) return fail('Enter an amount above zero.');
    const occurredAt = when ? new Date(when) : new Date(r.occurred_at);
    if (Number.isNaN(occurredAt.getTime())) return fail('That date is not valid.');

    const patch = {
      raw_name: name,
      amount_minor: amountMinor,
      direction: fields.direction.value === 'in' ? 'in' : 'out',
      occurred_at: occurredAt.toISOString(),
    };

    if (name !== r.raw_name || amountMinor !== r.amount_minor) {
      Object.assign(patch, {
        category: null,
        display_name: null,
        item_id: null,
        route_id: null,
        counterparty_id: null,
        enriched_at: null,
        enriched: 0,
      });
    }

    await updateTransaction(r.id, patch);
    invalidate();
    syncNow().catch(() => {});
    await paint(body, controls);
  });

  return form;
}
