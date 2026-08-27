/* See README.md. Fixtures load from tools/preview-rows.json, which is
 * gitignored because it holds real transactions.
 *
 * `?view=` picks the screen — overview (default), add, spending, history,
 * ledger — so a layout change to the capture screen can be looked at the same
 * way a chart can.
 */
import { renderOverview } from '../src/views/overview.js';
import { renderAdd } from '../src/capture/entry.js';
import { renderSpending } from '../src/views/spending.js';
import { renderHistory } from '../src/views/history.js';
import { renderLedger } from '../src/views/ledger.js';

const VIEWS = {
  overview: renderOverview,
  add: renderAdd,
  spending: renderSpending,
  history: renderHistory,
  ledger: renderLedger,
};

const params = new URLSearchParams(location.search.slice(1));
const fixture = await fetch(`./${params.get('fixture') || 'preview-rows'}.json`)
  .then((r) => (r.ok ? r.json() : []))
  .catch(() => []);

// A fixture may be a bare array of rows, or { rows, pending, meta }.
window.__rows = Array.isArray(fixture) ? fixture : fixture.rows || [];
const allPending = Array.isArray(fixture) ? [] : fixture.pending || [];
// ?pending=N trims the inbox, so the one-waiting case (which opens itself) and
// the several-waiting case can both be looked at from one fixture.
const skip = Number(params.get('skip')) || 0;
window.__pending = params.has('pending')
  ? allPending.slice(skip, skip + (Number(params.get('pending')) || 0))
  : allPending.slice(skip);
window.__meta = Array.isArray(fixture) ? {} : fixture.meta || {};

const render = VIEWS[params.get('view') || 'overview'] || VIEWS.overview;

render(document.querySelector('#view'), params)
  .then(() => {
    const app = document.querySelector('#app');
    const w = app.clientWidth;
    const bad = [...document.querySelectorAll('#view *')]
      .filter((el) => el.getBoundingClientRect().right > app.getBoundingClientRect().right + 0.5)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
    document.title = `app=${w} scroll=${app.scrollWidth} over=${bad.length ? bad.join(' | ') : 'none'}`;
    document.querySelector('#err').remove();
  })
  .catch((e) => { document.querySelector('#err').textContent = e.stack || String(e); });
