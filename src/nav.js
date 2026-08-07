/* Navigation between tabs, including tabs that carry a filter.
 *
 * The hash is the single source of truth — "#history?cat=Eating Out" is a real
 * address, so the Spending card can link into a filtered History and the back
 * button still does the obvious thing. Kept out of main.js so a view can
 * navigate without importing the module that imports it.
 */

export function parseHash(hash = location.hash) {
  const [name, query] = hash.replace(/^#/, '').split('?');
  return { name: name || 'add', params: new URLSearchParams(query || '') };
}

export function go(name, params) {
  const query = params ? new URLSearchParams(params).toString() : '';
  const next = `#${query ? `${name}?${query}` : name}`;
  // Assigning an unchanged hash fires nothing, so the view would never repaint.
  if (location.hash === next) window.dispatchEvent(new Event('hashchange'));
  else location.hash = next;
}
