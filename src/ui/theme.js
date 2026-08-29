/* The accent colour, as a user setting.
 *
 * Every accent ships as a pair, not one hue: the same colour has to work as a
 * fill with near-white text on it (Save, the active direction button) *and* as
 * text on the surface (links, the under-pace delta). Light mode therefore needs
 * the dark end of a hue, and dark mode a pastel — a single value cannot do both
 * jobs. Each pair below clears 4.5:1 on the card and the ground in its own
 * theme, and 4.5:1 for the text that sits on top of it.
 *
 * Stored in localStorage rather than the IndexedDB meta store, because it has
 * to be applied before the first paint and awaiting a database to find out what
 * colour the app is would show the wrong one first. It is a per-device
 * preference, like a theme, so it does not sync.
 */

const KEY = 'hisaab.accent';

export const ACCENTS = [
  { id: 'blue', name: 'Blue', light: '#3b6ea5', dark: '#9cc2e8' },
  { id: 'green', name: 'Green', light: '#2f7a55', dark: '#8ed6ae' },
  { id: 'teal', name: 'Teal', light: '#0f7175', dark: '#7fd2d6' },
  { id: 'violet', name: 'Violet', light: '#6a4fb5', dark: '#c0b0f2' },
  { id: 'rose', name: 'Rose', light: '#b03c5e', dark: '#f0a5b8' },
  { id: 'amber', name: 'Amber', light: '#8a6116', dark: '#e3bd6d' },
  { id: 'slate', name: 'Slate', light: '#4d5a6b', dark: '#b6c3d3' },
];

export const DEFAULT_ACCENT = 'blue';

export function accentById(id) {
  return ACCENTS.find((a) => a.id === id) || ACCENTS.find((a) => a.id === DEFAULT_ACCENT);
}

/** The chosen accent, falling back to the default when nothing is stored. */
export function currentAccent() {
  let stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    // Private mode or blocked storage: the default is a fine answer.
  }
  return accentById(stored);
}

function prefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Paint the chosen accent. Inline on the root, so it wins over both themes. */
export function paintAccent(accent = currentAccent()) {
  document.documentElement.style.setProperty('--accent', prefersDark() ? accent.dark : accent.light);
}

/** Store a choice and paint it. Returns the accent that is now in force. */
export function setAccent(id) {
  const accent = accentById(id);
  try {
    localStorage.setItem(KEY, accent.id);
  } catch {
    // Not storable — the choice still applies for this session.
  }
  paintAccent(accent);
  return accent;
}

/** Paint at boot, and repaint when the system flips between light and dark. */
export function initAccent() {
  paintAccent();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => paintAccent());
}
