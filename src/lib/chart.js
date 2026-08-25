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

/**
 * A bridge (waterfall): a starting total, a run of signed steps, and the total
 * they leave behind. It exists to *draw the arithmetic* a headline hides — cash,
 * less the bills and the savings and what you owe, equals what is safe — so the
 * subtraction is visible rather than asserted.
 *
 * Steps carry a signed `minor` (negative subtracts). The scale spans whatever
 * the running balance actually reaches, including below zero, so a period that
 * ends over budget shows its final bar dropping through the baseline rather than
 * clamping to it and lying about the sign.
 *
 * Pure geometry over numbers, so verify.mjs can assert the property that makes a
 * waterfall correct: every floating bar begins exactly where the last one ended.
 */
export function bridgeLayout(
  { startMinor, steps = [] },
  { frame = FRAME, maxCap = 34 } = {}
) {
  const plotW = frame.w - frame.left - frame.right;
  const plotH = frame.h - frame.top - frame.bottom;
  const base = frame.top + plotH;

  const levels = [startMinor];
  let run = startMinor;
  for (const s of steps) {
    run += s.minor;
    levels.push(run);
  }
  const endMinor = run;

  const hi = Math.max(1, 0, startMinor, endMinor, ...levels);
  const loRaw = Math.min(0, endMinor, ...levels);
  const max = ceilNice(hi);
  const min = loRaw < 0 ? -ceilNice(-loRaw) : 0;
  const span = max - min || 1;
  const y = (v) => base - ((v - min) / span) * plotH;
  const zeroY = y(0);

  const cols = steps.length + 2;
  const band = plotW / cols;
  const w = Math.min(maxCap, Math.max(6, band - 10));
  const colX = (i) => frame.left + band * i + band / 2;

  const bar = (i, fromMinor, toMinor, kind, label, valueMinor) => {
    const yTop = y(Math.max(fromMinor, toMinor));
    const yBot = y(Math.min(fromMinor, toMinor));
    const cx = colX(i);
    return {
      i, kind, label, valueMinor, fromMinor, toMinor,
      cx, x: cx - w / 2, w, y: yTop, h: Math.max(1, yBot - yTop),
    };
  };

  const bars = [bar(0, 0, startMinor, 'total', null, startMinor)];
  run = startMinor;
  steps.forEach((s, k) => {
    const from = run;
    run += s.minor;
    bars.push(bar(k + 1, from, run, s.minor >= 0 ? 'add' : 'sub', s.label, s.minor));
  });
  bars.push(bar(cols - 1, 0, endMinor, 'total', null, endMinor));

  return { max, min, base, zeroY, y, band, w, bars, levels, endMinor };
}

/**
 * Horizontal bars off a shared centre line, for a polarity question — over or
 * under, owed or owing — where the sign is the whole point. The bar's *side*
 * carries the sign, so the reading never rests on colour alone (red and green
 * are the finance convention but fail a colour-vision check; direction plus a
 * signed label is the primary channel, colour only reinforces it).
 *
 * `value` reads the signed magnitude off each item. The scale is symmetric, so
 * a +2,000 and a −2,000 are mirror images and comparable at a glance.
 */
export function divergingLayout(items, { width = 320, rowH = 30, gap = 6, labelW = 104, padRight = 8, value = (d) => d.minor } = {}) {
  const max = ceilNice(Math.max(1, ...items.map((d) => Math.abs(value(d)))));
  const track = Math.max(1, width - labelW - padRight);
  const cx = labelW + track / 2;
  const half = track / 2;
  const rows = items.map((d, i) => {
    const v = value(d);
    const len = (Math.abs(v) / max) * half;
    return {
      i, item: d, value: v, positive: v >= 0,
      y: i * (rowH + gap), h: rowH,
      x: v >= 0 ? cx : cx - len, w: Math.max(v === 0 ? 0 : 1, len),
    };
  });
  return { max, cx, labelW, width, rowH, gap, rows, height: items.length * (rowH + gap) };
}

/**
 * Points for a sparkline — a trend beside a number, so a total reads as high or
 * low against its own recent history rather than in a vacuum. Baseline is zero
 * (or lower, if a value is negative), never the minimum, so a flat-ish run does
 * not get amplified into false drama.
 */
export function sparkPoints(values, { w = 76, h = 24, pad = 3 } = {}) {
  const lo = Math.min(0, ...values);
  const hi = Math.max(1, ...values);
  const range = hi - lo || 1;
  const span = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  return values.map((v, i) => ({
    x: pad + i * span,
    y: pad + (h - pad * 2) * (1 - (v - lo) / range),
    value: v,
  }));
}

/**
 * Points for a line across a fixed number of slots — used by the burn-down,
 * where the x-axis is days in the period (fixed) rather than the number of
 * samples so far, so the actual line and the ideal line share one scale.
 */
export function linePoints(values, { slots, maxMinor, frame = FRAME } = {}) {
  const plotW = frame.w - frame.left - frame.right;
  const plotH = frame.h - frame.top - frame.bottom;
  const base = frame.top + plotH;
  const max = maxMinor || ceilNice(Math.max(1, ...values));
  const n = Math.max(1, (slots ?? values.length) - 1);
  const step = plotW / n;
  const y = (v) => base - (Math.max(0, v) / max) * plotH;
  return {
    max, base, y,
    x: (i) => frame.left + step * i,
    points: values.map((v, i) => ({ x: frame.left + step * i, y: y(v), value: v })),
  };
}
