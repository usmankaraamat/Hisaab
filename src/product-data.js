import { countTransactions } from './db/local.js';
import { currentUser, isConfigured, supabase } from './db/supabase.js';

const ENABLED_KEY = 'hisaab.analytics.enabled';
const INSTALL_KEY = 'hisaab.analytics.installId';
const PING_KEY = 'hisaab.analytics.lastPing';
const ACTIVATED_KEY = 'hisaab.analytics.activatedDay';

export function productAnalyticsEnabled() {
  try { return localStorage.getItem(ENABLED_KEY) !== 'false'; } catch (_) { return true; }
}

export function setProductAnalyticsEnabled(enabled) {
  try { localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false'); } catch (_) { /* unavailable */ }
}

function installId() {
  try {
    let id = localStorage.getItem(INSTALL_KEY);
    if (!/^[0-9a-f-]{36}$/i.test(id || '')) {
      id = crypto.randomUUID();
      localStorage.setItem(INSTALL_KEY, id);
    }
    return id;
  } catch (_) {
    return crypto.randomUUID();
  }
}

function day() {
  return new Date().toISOString().slice(0, 10);
}

async function request(body) {
  if (!isConfigured()) throw new Error('Feedback is not configured yet.');
  const sb = await supabase();
  const { data, error } = await sb.functions.invoke('product-data', {
    body: { ...body, app: 'hisaab', installId: installId() },
  });
  if (error) {
    let detail = null;
    try { detail = await error.context?.json(); } catch (_) { /* SDK message is enough */ }
    throw new Error(detail?.error || error.message || 'Could not reach Hisaab.');
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function productHeartbeat({ force = false } = {}) {
  if (!productAnalyticsEnabled() || !navigator.onLine || !isConfigured()) return { skipped: true };
  const today = day();
  try {
    if (!force && localStorage.getItem(PING_KEY) === today) return { skipped: true };
    const [count, user] = await Promise.all([countTransactions(), currentUser()]);
    const activated = count > 0;
    const data = await request({
      kind: 'activity',
      activated,
      usesByok: Boolean(localStorage.getItem('hisaab.personalGeminiKey')),
      usesHosted: Boolean(user),
    });
    localStorage.setItem(PING_KEY, today);
    if (activated) localStorage.setItem(ACTIVATED_KEY, today);
    return data;
  } catch (error) {
    return { error };
  }
}

export function noteProductUse() {
  if (!productAnalyticsEnabled()) return;
  try { if (localStorage.getItem(ACTIVATED_KEY) === day()) return; } catch (_) { /* continue */ }
  productHeartbeat({ force: true });
}

export async function submitProductFeedback({ message, rating, replyEmail }) {
  return request({ kind: 'feedback', message, rating, replyEmail });
}

export function startProductTelemetry() {
  window.addEventListener('online', () => productHeartbeat());
  window.addEventListener('hisaab:meaningful-use', () => noteProductUse());
  window.setTimeout(() => productHeartbeat(), 1200);
}
