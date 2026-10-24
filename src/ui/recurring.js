/* "Looks recurring — track it?" prompts, shared by Spending and Settings.
 *
 * Detection only ever asks; nothing it finds reaches the balance until the
 * person says yes. A no is remembered (meta `schedules.dismissed`, a list of
 * group keys) so the same purchases are not raised again.
 */

import { getMeta, setMeta, newId } from '../db/local.js';
import { recurringSuggestions, scheduleFromSuggestion } from '../lib/schedule.js';
import { formatMinor } from '../lib/money.js';
import { escapeHtml } from '../capture/entry.js';

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export async function loadSuggestions(rows, now = new Date()) {
  const [schedules, dismissed] = await Promise.all([
    getMeta('schedules', []),
    getMeta('schedules.dismissed', []),
  ]);
  return recurringSuggestions(rows, schedules, dismissed, { now });
}

export function suggestionsHtml(suggestions) {
  if (!suggestions.length) return '';
  return `<div class="recurring-suggest">
    <p class="hint">These look like they repeat. Track one and it is listed under upcoming bills and
      reminded in “To be resolved” when due — it is never taken off what is safe to spend.</p>
    ${suggestions
      .map(
        (s) => `<div class="rule-row" data-suggest="${escapeHtml(s.key)}">
          <span class="rule-desc"><b>${escapeHtml(s.label)}</b> · ${formatMinor(s.lastMinor)} · ${s.cadence}<br>
            <small>${s.count} charges · next around ${DATE.format(new Date(s.nextDue))}</small></span>
          <span class="suggest-actions">
            <button type="button" class="link" data-track="${escapeHtml(s.key)}">Track</button>
            <button type="button" class="link muted-link" data-dismiss="${escapeHtml(s.key)}">Not recurring</button>
          </span>
        </div>`
      )
      .join('')}
  </div>`;
}

/** Handle Track / Not recurring inside `host`, then call `onChange`.
 * `current` returns the suggestions now on screen, which change as they are
 * answered. */
export function wireSuggestions(host, current, onChange) {
  host.addEventListener('click', async (e) => {
    const track = e.target.closest('[data-track]')?.dataset.track;
    const dismiss = e.target.closest('[data-dismiss]')?.dataset.dismiss;
    if (!track && !dismiss) return;

    if (track) {
      const s = current().find((x) => x.key === track);
      if (!s) return;
      const schedules = await getMeta('schedules', []);
      schedules.push(scheduleFromSuggestion(s, { id: newId() }));
      await setMeta('schedules', schedules);
    } else {
      const dismissed = await getMeta('schedules.dismissed', []);
      if (!dismissed.includes(dismiss)) dismissed.push(dismiss);
      await setMeta('schedules.dismissed', dismissed);
    }
    await onChange();
  });
}
