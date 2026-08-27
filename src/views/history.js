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

import {
  listTransactions,
  deleteTransaction,
  updateTransaction,
  getMeta,
  setMeta,
  newId,
} from '../db/local.js';
import { CATEGORIES } from '../lib/categories.js';
import { suggestMatch } from '../lib/rules.js';
import { formatTxnAmount, formatMinor, toMinor } from '../lib/money.js';
import { escapeHtml } from '../capture/entry.js';
import { txnLabel, hasRewrite } from '../lib/label.js';
import { personKey } from '../capture/split.js';
import {
  isSharedSpend,
  isWrittenOffShare,
  isOutstandingLoan,
  ON_OTHERS,
  calendarPeriod,
} from '../lib/budget.js';
import { invalidate } from '../capture/predict.js';
import { syncNow } from '../db/sync.js';

const DAY = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

const filter = { text: '', category: '', person: '', from: null, to: null };
let datesInitialised = false;

export async function renderHistory(root, params) {
  // Default to the current period — a month — the first time this screen opens.
  // After that the user's own choice of dates is kept between visits.
  if (!datesInitialised) {
    filter.from = toDateInput(calendarPeriod().periodStart);
    filter.to = '';
    datesInitialised = true;
  }

  // A link from another tab wins over whatever was left set here.
  if (params?.has('q')) {
    filter.text = params.get('q') || '';
    filter.category = '';
    filter.person = '';
  }
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
  // A drill-down from Spending carries the same window its bar was counted over,
  // so the entries can never total more than the figure that was tapped.
  if (params?.has('from') || params?.has('to')) {
    filter.from = params.get('from') || '';
    filter.to = params.get('to') || '';
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
        <div class="h-filter-row date-range">
          <label class="stack">From
            <input id="f-from" type="date" aria-label="From date" value="${escapeHtml(filter.from || '')}" />
          </label>
          <label class="stack">To
            <input id="f-to" type="date" aria-label="To date" value="${escapeHtml(filter.to || '')}" />
          </label>
        </div>
      </div>
      <div id="history-body"><p class="empty">Loading…</p></div>
    </section>
  `;

  const body = root.querySelector('#history-body');
  const text = root.querySelector('#f-text');
  const cat = root.querySelector('#f-cat');
  const person = root.querySelector('#f-person');
  const from = root.querySelector('#f-from');
  const to = root.querySelector('#f-to');

  from.addEventListener('change', () => {
    filter.from = from.value;
    paint(body, { cat, person });
  });
  to.addEventListener('change', () => {
    filter.to = to.value;
    paint(body, { cat, person });
  });

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

/** ISO instant -> the "YYYY-MM-DD" a date input expects, in local time. */
function toDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO instant -> the "YYYY-MM-DDTHH:mm" a datetime-local input expects, in local time. */
function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* Two headings that are not categories.
 *
 * Spending counts a row under "On other people" rather than under Groceries, so
 * tapping through has to land on the same set or the two screens disagree about
 * the same word. A real category therefore means *your* Groceries; what you
 * bought for someone else is reachable under these, or by person. */
const OWED = 'Owed back to you';

function inGroup(r, group) {
  if (group === ON_OTHERS) return isWrittenOffShare(r);
  if (group === OWED) return isOutstandingLoan(r);
  return false;
}

function matches(r) {
  if (filter.category === ON_OTHERS || filter.category === OWED) {
    if (!inGroup(r, filter.category)) return false;
  } else if (filter.category) {
    if ((r.category || 'Uncategorised') !== filter.category) return false;
    // A category bar on Spending counts only what you spent on yourself.
    if (isSharedSpend(r)) return false;
  }
  // By key, not by string: the Spending card links in with whichever spelling
  // it saw first, and "sister" must not filter out "Sister".
  if (filter.person && personKey(r.counterparty_name) !== personKey(filter.person)) return false;
  if (filter.from || filter.to) {
    const at = new Date(r.occurred_at).getTime();
    if (filter.from && at < new Date(`${filter.from}T00:00:00`).getTime()) return false;
    if (filter.to && at > new Date(`${filter.to}T23:59:59.999`).getTime()) return false;
  }
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
    const groups = [ON_OTHERS, OWED].filter((g) => rows.some((r) => inGroup(r, g)));
    fillOptions(
      controls.cat,
      [
        ...new Set(rows.filter((r) => !isSharedSpend(r)).map((r) => r.category || 'Uncategorised')),
      ].sort().concat(groups),
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
  const filtering = Boolean(filter.text || filter.category || filter.person || filter.from || filter.to);

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
    <label>Category
      <select name="category">
        <option value=""${r.category ? '' : ' selected'}>—</option>
        ${CATEGORIES.map(
          (c) => `<option value="${escapeHtml(c)}"${r.category === c ? ' selected' : ''}>${escapeHtml(c)}</option>`
        ).join('')}
      </select>
    </label>
    <label class="h-remember" hidden>
      <input type="checkbox" name="remember" />
      <span></span>
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

  // Offer to remember a category correction as a rule — the learning loop.
  // Only when the category is actually being changed to something.
  const catSelect = form.querySelector('select[name="category"]');
  const remember = form.querySelector('.h-remember');
  const match = suggestMatch(r.raw_name);
  catSelect.addEventListener('change', () => {
    const changed = catSelect.value && catSelect.value !== r.category;
    remember.hidden = !changed || !match;
    if (changed) {
      remember.querySelector('span').textContent = `Always file “${match}” as ${catSelect.value}`;
    }
  });

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

    // An explicit category wins over the model and sticks: mark it done so the
    // enrichment pass will not re-file it. This runs after the clear above, so a
    // simultaneous name edit does not wipe the category the user just chose.
    const chosenCat = fields.category.value || null;
    if (chosenCat !== (r.category || null)) {
      patch.category = chosenCat;
      if (chosenCat) {
        patch.enriched_at = new Date().toISOString();
        patch.enriched = 1;
      }
    }

    await updateTransaction(r.id, patch);

    // Learn: turn the correction into a rule if asked.
    if (fields.remember?.checked && chosenCat && match) {
      const existing = await getMeta('capture.rules', []);
      if (!existing.some((rule) => rule.match === match && rule.category === chosenCat)) {
        await setMeta('capture.rules', [...existing, { id: newId(), match, category: chosenCat }]);
      }
    }

    invalidate();
    syncNow().catch(() => {});
    await paint(body, controls);
  });

  return form;
}
