import { listTransactions, deleteTransaction } from '../db/local.js';
import { formatTxnAmount, formatMinor } from '../lib/money.js';
import { escapeHtml } from '../capture/entry.js';
import { invalidate } from '../capture/predict.js';

const DAY = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

export async function renderHistory(root) {
  root.innerHTML = `
    <section class="history">
      <h2>History</h2>
      <div id="history-body"><p class="empty">Loading…</p></div>
    </section>
  `;
  await paint(root.querySelector('#history-body'));
}

async function paint(body) {
  const rows = await listTransactions({ limit: 500 });

  if (!rows.length) {
    body.innerHTML = '<p class="empty">No transactions yet.</p>';
    return;
  }

  // Group by calendar day, newest first. listTransactions already sorts.
  const groups = new Map();
  for (const r of rows) {
    const key = r.occurred_at.slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  body.innerHTML = '';
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
    for (const r of items) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="r-name">${escapeHtml(r.raw_name)}</span>
        <span class="r-amt ${r.direction}">${formatTxnAmount(r)}</span>
        <button class="r-del" aria-label="Delete ${escapeHtml(r.raw_name)}">×</button>`;
      li.querySelector('.r-del').addEventListener('click', async () => {
        await deleteTransaction(r.id);
        invalidate();
        await paint(body);
      });
      ul.append(li);
    }
    body.append(section);
  }
}
