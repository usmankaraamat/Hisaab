import './styles.css';
import { renderAdd } from './capture/entry.js';
import { renderHistory } from './views/history.js';
import { renderSettings } from './views/settings.js';
import { renderReview } from './views/review.js';
import { renderInsights } from './views/insights.js';
import { startAutoSync } from './db/sync.js';
import { setMeta } from './db/local.js';
import { invalidate } from './capture/predict.js';

const views = {
  add: renderAdd,
  history: renderHistory,
  insights: renderInsights,
  review: renderReview,
  settings: renderSettings,
};

const view = document.querySelector('#view');
const tabs = document.querySelector('#tabs');

async function show(name) {
  const render = views[name] || views.add;
  for (const b of tabs.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.tab === name);
  }
  location.hash = name;
  await render(view);
}

tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) show(btn.dataset.tab);
});

window.addEventListener('hashchange', () => show(location.hash.slice(1) || 'add'));

show(location.hash.slice(1) || 'add');

// Sync runs entirely off the capture path — a failure here must never surface
// as an error on the Add screen.
startAutoSync(async (result) => {
  if (!result || result.error || result.skipped) return;
  await setMeta('sync.lastRun', new Date().toISOString());
  if (result.pulled > 0) {
    invalidate();
    if ((location.hash.slice(1) || 'add') !== 'settings') {
      await show(location.hash.slice(1) || 'add');
    }
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
