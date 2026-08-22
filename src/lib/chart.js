/* Bar-chart geometry, kept apart from the view that draws it.
 *
 * Pure arithmetic over numbers: no DOM, no IndexedDB, so verify.mjs can assert
 * the thing that actually goes wrong with a hand-rolled chart — a bar escaping
 * the frame, a zero-height rect, an axis that does not reach the tallest bar.
 * Eyeballing an SVG catches that late and only on the data you happened to have.
 */

/** A round number at or above the largest bar, so the axis reads cleanly. */
export function ceilNice(minor) {
  if (!Number.isFinite(minor) || minor <= 0) return 100;
  const pow = 10 ** Math.floor(Math.log10(minor));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (minor <= step * pow) return step * pow;
  }
  return 10 * pow;
}

/** Compact axis text: 1,200,000 minor -> "12k". */
export function shortMinor(minor) {
  const whole = Math.round(minor / 100);
  if (Math.abs(whole) >= 1000) {
    const k = whole / 1000;
    return `${Math.abs(k) >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(whole);
}

export const FRAME = { w: 340, h: 150, top: 10, right: 6, bottom: 22, left: 30 };

/**
 * Where every mark goes.
 *
 * Two series share one scale because both are rupees — a second y-axis would
 * let any pair of numbers be drawn as any relationship at all.
 *
 * Bars are capped at 14 units wide rather than filling their band: the leftover
 * is air, and a chart of two months should not be two slabs. The pair inside a
 * band is separated by a 2-unit gap in the surface colour rather than a stroke,
 * so no non-data ink is added.
 */
export function barLayout(buckets, { frame = FRAME, maxCap = 14 } = {}) {
  const plotW = frame.w - frame.left - frame.right;
  const plotH = frame.h - frame.top - frame.bottom;
  const base = frame.top + plotH;

  const max = ceilNice(
    Math.max(1, ...buckets.map((b) => Math.max(b.spendMinor || 0, b.savedMinor || 0)))
  );
  const y = (v) => base - (Math.max(0, v) / max) * plotH;
  const band = plotW / Math.max(1, buckets.length);
  const w = Math.min(maxCap, Math.max(3, band / 2 - 2));

  const bars = buckets.map((b, i) => {
    const cx = frame.left + band * i + band / 2;
    const spendY = y(b.spendMinor || 0);
    const saveY = y(b.savedMinor || 0);
    return {
      i,
      cx,
      w,
      spendX: cx - w - 1,
      spendY,
      spendH: base - spendY,
      saveX: cx + 1,
      saveY,
      saveH: base - saveY,
    };
  });

  return { max, band, w, base, plotW, plotH, y, bars };
}

/** Gridline positions, bottom to top, with the label each one carries. */
export function gridLines(max, { frame = FRAME, steps = [0, 0.5, 1] } = {}) {
  const plotH = frame.h - frame.top - frame.bottom;
  return steps.map((f) => ({
    fraction: f,
    y: frame.top + plotH - f * plotH,
    label: f === 0 ? '0' : shortMinor(max * f),
  }));
}
