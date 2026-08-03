/* Turning a free-text `raw_name` into a stable grouping key.
 *
 * This is the cheap, deterministic half of canonicalisation — enough to power
 * prediction chips offline, with no API call. The AI enrichment pass in
 * Phase 4 does the semantic half (merging "Diet Coke"/"Diet Pepsi"/"Cold Drink",
 * telling the person "Anser" apart from the place "Anser").
 *
 * Rides matter most: they are ~30% of all entries and their spelling drifts.
 * The export contains "Indrive Flat-Office", "Indrive Flat - Office" and
 * "Indrive Office - Flat" — the first two are the same route, the third is the
 * reverse of it, so direction has to survive normalisation.
 */

const PROVIDERS = ['indrive', 'yango', 'careem', 'uber', 'bykea'];

/** Title-case a place token, preserving all-caps acronyms like NUST and F10. */
function titleCase(s) {
  return s
    .split(/\s+/)
    .map((w) => {
      if (/^[A-Z0-9]{2,}$/.test(w)) return w;
      if (/\d/.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * @returns {{provider: string, from: string, to: string}|null}
 */
export function parseRoute(rawName) {
  const text = String(rawName || '').trim();
  const m = text.match(/^(\w+)\s+(.+)$/);
  if (!m) return null;

  const provider = m[1].toLowerCase();
  if (!PROVIDERS.includes(provider)) return null;

  // Split on a hyphen, en dash, arrow or " to ", with or without spaces.
  const parts = m[2].split(/\s*(?:-|–|—|→|\bto\b)\s*/i).filter(Boolean);
  if (parts.length !== 2) return null;

  const from = parts[0].trim();
  const to = parts[1].trim();
  if (!from || !to) return null;

  return { provider, from, to };
}

/**
 * A stable key for grouping equivalent entries.
 * Rides collapse to `ride:provider|from|to`; everything else to its
 * lowercased, punctuation-stripped name.
 */
export function groupKey(rawName) {
  const route = parseRoute(rawName);
  if (route) {
    return `ride:${route.provider}|${route.from.toLowerCase()}|${route.to.toLowerCase()}`;
  }
  return `item:${String(rawName || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()}`;
}

/** How a group should read on a chip. */
export function displayName(rawName) {
  const route = parseRoute(rawName);
  if (!route) return String(rawName || '').trim();
  const provider = route.provider.charAt(0).toUpperCase() + route.provider.slice(1);
  return `${provider} ${titleCase(route.from)} → ${titleCase(route.to)}`;
}

/**
 * The text to put back in the input when a chip is tapped. Must round-trip
 * through parseEntry, so it uses the plain "A - B" form rather than the arrow.
 */
export function templateText(rawName) {
  const route = parseRoute(rawName);
  if (!route) return String(rawName || '').trim();
  const provider = route.provider.charAt(0).toUpperCase() + route.provider.slice(1);
  return `${provider} ${titleCase(route.from)} - ${titleCase(route.to)}`;
}

export function isRide(rawName) {
  return parseRoute(rawName) !== null;
}
