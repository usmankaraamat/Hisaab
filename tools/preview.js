/* See README.md. Fixtures load from tools/preview-rows.json, which is
 * gitignored because it holds real transactions. */
import { renderOverview } from '../src/views/overview.js';
window.__rows = await fetch('./preview-rows.json')
  .then((r) => (r.ok ? r.json() : []))
  .catch(() => []);
window.__meta = {};
renderOverview(document.querySelector('#view'), new URLSearchParams(location.search.slice(1)))
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
