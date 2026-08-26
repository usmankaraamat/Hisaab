import './styles.css';
import { renderAdd } from './capture/entry.js';
import { renderHistory } from './views/history.js';
import { renderSettings } from './views/settings.js';
import { renderReview } from './views/review.js';
import { renderLedger } from './views/ledger.js';
import { renderSpending } from './views/spending.js';
import { renderOverview } from './views/overview.js';
import { startAutoSync } from './db/sync.js';
import { setMeta, addPending } from './db/local.js';
import { parseNotification } from './capture/notif.js';
import { invalidate } from './capture/predict.js';
import { parseHash, go } from './nav.js';

const views = {
  add: renderAdd,
  history: renderHistory,
  spending: renderSpending,
  overview: renderOverview,
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

/* Web Share Target: an installed Hisaab appears in Android's share sheet, so a
 * payment notification (or its copied text) can be shared straight in. It
 * arrives as ?text=…&title=… on the start URL; parse it into the pending inbox,
 * strip the query so a refresh does not re-add it, and land on the capture
 * screen where the inbox lives. */
async function handleShare() {
  const q = new URLSearchParams(location.search);
  const shared = [q.get('text'), q.get('title'), q.get('url')].filter(Boolean).join(' ').trim();
  if (!shared) return;
  const parsed = parseNotification(shared);
  if (parsed) await addPending({ ...parsed, occurred_at: parsed.occurredAt });
  // Drop the query string but keep the hash route.
  history.replaceState(null, '', location.pathname + (location.hash || '#add'));
}

await handleShare();
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
