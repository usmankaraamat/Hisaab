const PATHS = {
  add: '<path d="M12 5v14M5 12h14" />',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.2-5.7L3.5 8.5" /><path d="M3.5 4.5v4h4" /><path d="M12 7.5V12l3 2" />',
  spending: '<path d="M4 7.5h16v10H4z" /><path d="M7 7.5V5h10v2.5" /><path d="M15.5 12h2" />',
  ledger: '<path d="M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M3.5 19v-1.5A3.5 3.5 0 0 1 7 14h3a3.5 3.5 0 0 1 3.5 3.5V19" /><path d="M15.5 6.2a2.6 2.6 0 0 1 0 5" /><path d="M16 14a3.5 3.5 0 0 1 4 3.5V19" />',
  overview: '<path d="M4 19V9" /><path d="M10 19V5" /><path d="M16 19v-7" /><path d="M22 19H2" />',
  review: '<path d="M4 5.5h16v13H4z" /><path d="m4 7 8 6 8-6" /><path d="m17.5 3 .5-1 .5 1 1 .5-1 .5-.5 1-.5-1-1-.5z" />',
  settings: '<path d="M4 6h10M18 6h2M10 12h10M4 12h2M4 18h8M16 18h4" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="14" cy="18" r="2" />',
  more: '<circle cx="5" cy="12" r="1.25" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none" />',
  close: '<path d="m6 6 12 12M18 6 6 18" />',
  arrowUp: '<path d="m6 12 6-6 6 6M12 6v12" />',
  chevron: '<path d="m9 6 6 6-6 6" />',
};

export function icon(name, { size = 20, className = '' } = {}) {
  const path = PATHS[name] || PATHS.more;
  return `<svg class="ui-icon${className ? ` ${className}` : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
}

export function renderIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 20 });
  }
}
