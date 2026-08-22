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
  // Fine enough that the tallest bar fills most of the frame: the coarse
  // [1,2,2.5,5,10] rounded 120k up to 200k and wasted 40% of the height.
  for (const step of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10]) {
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
 * Where every bar goes.
 *
 * One series, deliberately. Saving happens as an occasional lump — a single
 * 50,000 deposit against months of a few thousand a day — so plotting it beside
 * spending set the y-scale to the deposit and squashed every spending bar into
 * the bottom eighth of the frame. The chart answers one question, "where is the
 * money going", and the savings balance gets its own card above rather than a
 * second series that flattens the one you came to read.
 *
 * Bars are centred in their band and capped rather than filling it: the
 * leftover is air, and two months should not be two slabs.
 */
export function barLayout(buckets, { frame = FRAME, maxCap = 24, value = (b) => b.spendMinor } = {}) {
  const plotW = frame.w - frame.left - frame.right;
  const plotH = frame.h - frame.top - frame.bottom;
  const base = frame.top + plotH;

  const max = ceilNice(Math.max(1, ...buckets.map((b) => value(b) || 0)));
  const y = (v) => base - (Math.max(0, v) / max) * plotH;
  const band = plotW / Math.max(1, buckets.length);
  const w = Math.min(maxCap, Math.max(3, band - 8));

  const bars = buckets.map((b, i) => {
    const cx = frame.left + band * i + band / 2;
    const top = y(value(b) || 0);
    return { i, cx, w, x: cx - w / 2, y: top, h: base - top };
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
