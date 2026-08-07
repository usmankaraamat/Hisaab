import './styles.css';
import { renderAdd } from './capture/entry.js';
import { renderHistory } from './views/history.js';
import { renderSettings } from './views/settings.js';
import { renderReview } from './views/review.js';
import { renderLedger } from './views/ledger.js';
import { renderSpending } from './views/spending.js';
import { startAutoSync } from './db/sync.js';
import { setMeta } from './db/local.js';
import { invalidate } from './capture/predict.js';
import { parseHash, go } from './nav.js';

const views = {
  add: renderAdd,
  history: renderHistory,
  spending: renderSpending,
  ledger: renderLedger,
  // "insights" was the old tab name; a bookmark or an installed shortcut can
  // still be pointing at it.
  insights: renderSpending,
  review: renderReview,
  settings: renderSettings,
};

const view = document.querySelector('#view');
const tabs = document.querySelector('#tabs');

async function show() {
  const { name, params } = parseHash();
  const render = views[name] || views.add;
  for (const b of tabs.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.tab === name);
  }
  await render(view, params);
}

tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  // Always through the hash, so a tab tap clears any filter a link left behind.
  if (btn) go(btn.dataset.tab);
});

window.addEventListener('hashchange', show);

show();

// Sync runs entirely off the capture path — a failure here must never surface
// as an error on the Add screen.
startAutoSync(async (result) => {
  if (!result || result.error || result.skipped) return;
  await setMeta('sync.lastRun', new Date().toISOString());
  if (result.pulled > 0) {
    invalidate();
    if (parseHash().name !== 'settings') await show();
  }
});

// sw.js lives in public/, so it is served from the deploy base — not from the
// hashed assets/ directory that import.meta.url would resolve against.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const base = import.meta.env.BASE_URL;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .catch((err) => console.warn('Service worker registration failed:', err));
  });
}
