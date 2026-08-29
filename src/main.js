import './styles.css';
import { renderAdd } from './capture/entry.js';
import { renderHistory } from './views/history.js';
import { renderSettings } from './views/settings.js';
import { renderReview } from './views/review.js';
import { renderLedger } from './views/ledger.js';
import { renderSpending } from './views/spending.js';
import { renderOverview } from './views/overview.js';
import { startAutoSync } from './db/sync.js';
import { pullInbox } from './db/ingest.js';
import { setMeta, addPending } from './db/local.js';
import { parseNotification } from './capture/notif.js';
import { invalidate } from './capture/predict.js';
import { parseHash, go } from './nav.js';
import { renderIcons } from './ui/icons.js';
import { initAccent } from './ui/theme.js';
import { getPendingProposalCount } from './views/review.js';

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
const sectionTitle = document.querySelector('#section-title');
const moreToggle = document.querySelector('#more-toggle');
const moreBackdrop = document.querySelector('#more-backdrop');
const moreSheet = document.querySelector('#more-sheet');
const moreClose = document.querySelector('#more-close');

const TITLES = {
  add: 'Add expense',
  history: 'History',
  spending: 'Spending',
  overview: 'Overview',
  ledger: 'Ledger',
  review: 'Review inbox',
  settings: 'Settings',
};

function setMore(open, { restoreFocus = false } = {}) {
  moreBackdrop.hidden = !open;
  moreToggle.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('sheet-open', open);
  if (open) moreSheet.querySelector('button[data-tab]')?.focus();
  else if (restoreFocus) moreToggle.focus();
}

function setReviewBadge(count) {
  const value = Math.max(0, Number(count) || 0);
  for (const badge of document.querySelectorAll('[data-review-badge]')) {
    badge.hidden = value === 0;
    badge.textContent = value > 99 ? '99+' : String(value);
    badge.setAttribute('aria-label', `${value} review proposal${value === 1 ? '' : 's'} waiting`);
  }
}

async function refreshReviewBadge() {
  setReviewBadge(await getPendingProposalCount().catch(() => 0));
}

async function show() {
  const { name, params } = parseHash();
  const render = views[name] || views.add;
  for (const b of tabs.querySelectorAll('button')) {
    const active = b.dataset.tab === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const b of moreSheet.querySelectorAll('button[data-tab]')) {
    const active = b.dataset.tab === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  sectionTitle.textContent = TITLES[name] || TITLES.add;
  setMore(false);
  await render(view, params);
  refreshReviewBadge();
}

tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  // Always through the hash, so a tab tap clears any filter a link left behind.
  if (btn) go(btn.dataset.tab);
});

moreToggle.addEventListener('click', () => setMore(moreBackdrop.hidden));
moreClose.addEventListener('click', () => setMore(false, { restoreFocus: true }));
moreBackdrop.addEventListener('click', (e) => {
  if (e.target === moreBackdrop) setMore(false, { restoreFocus: true });
});
moreSheet.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) go(btn.dataset.tab);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !moreBackdrop.hidden) {
    e.preventDefault();
    setMore(false, { restoreFocus: true });
  }
});
window.addEventListener('hisaab:review-count', (e) => setReviewBadge(e.detail));
initAccent();
renderIcons();

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

// Auto-capture: pull any forwarded notifications on load. Gated + best-effort
// inside pullInbox, so this is a no-op unless the user has set it up.
pullInbox().then((r) => {
  if (r?.pulled && parseHash().name === 'add') show();
});

// Sync runs entirely off the capture path — a failure here must never surface
// as an error on the Add screen.
startAutoSync(async (result) => {
  if (!result || result.error || result.skipped) return;
  await setMeta('sync.lastRun', new Date().toISOString());
  if (result.pulled > 0) {
    invalidate();
    if (parseHash().name !== 'settings') await show();
  }
  // Piggyback the inbox pull on the same cadence as sync.
  const ingest = await pullInbox().catch(() => null);
  if (ingest?.pulled && parseHash().name === 'add') await show();
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
