// Shared lightweight SVG chart helpers — extracted from progress.js (which
// already built these for the weight/calorie/measurement trend charts) so
// workoutDiary.js's own 1RM sparkline (Phase 3, muscle heatmap/1RM tracker)
// can reuse the exact same, already-proven drawing code instead of a second
// hand-rolled copy. Deliberately its own module rather than progress.js
// exporting these — workoutDiary.js must never import from progress.js (see
// workoutDiary.js's own header comment on the "thin context object, no
// circular import" rule progress.js already follows in the other direction).
const SVG_NS = "http://www.w3.org/2000/svg";

export function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// `hidden` as a property is unreliable on some browsers/polyfill setups for
// SVG elements specifically (see this function's original call sites) —
// toggleAttribute writes the attribute directly, which is what the `[hidden]
// { display: none }` UA rule actually keys off.
export function setSvgHidden(svg, hidden) {
  svg.toggleAttribute("hidden", hidden);
}

// Sets the SVG's viewBox to exactly match its actual rendered pixel width
// (height is fixed by CSS) so a responsive, `preserveAspectRatio="none"`
// chart never has anything to stretch. Caches the last real measurement per
// SVG element so a redraw that happens while the chart's container is still
// `display:none` (e.g. a tab switch's cache-first render, see progress.js's
// own callers) reuses the last known-good width instead of a wrong guess
// that would cause a visible snap-to-correct-size a moment later.
const lastKnownSvgWidth = new WeakMap();
export function sizeSvgToContainer(svg, height) {
  const measured = Math.round(svg.getBoundingClientRect().width);
  const width = measured || lastKnownSvgWidth.get(svg) || 320;
  if (measured) lastKnownSvgWidth.set(svg, measured);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return width;
}

// How many dots a trend line will draw, at most. The lines themselves always
// carry every point — a <path> is one element and one `d` string no matter how
// long the history is — but a dot per point is one DOM node per point, and on a
// ~340px-wide chart a few hundred of them are not even distinguishable from the
// line they sit on. Past this count the dots are evenly subsampled (first and
// last always kept, so the line's endpoints still read as real readings). This
// is what keeps a long-time user's weight chart from costing an order of
// magnitude more to draw than a new user's while looking identical.
const MAX_TREND_DOTS = 60;

export function trendDotIndices(count) {
  if (count <= MAX_TREND_DOTS) return null; // draw them all
  const step = (count - 1) / (MAX_TREND_DOTS - 1);
  const keep = new Set();
  for (let i = 0; i < MAX_TREND_DOTS; i++) keep.add(Math.round(i * step));
  return keep;
}

// Appends the dots for `points` into `parent` (a DocumentFragment, never the
// live SVG). Building into a fragment and attaching once is the whole point:
// appendChild into an already-attached SVG invalidates that subtree on every
// call, so N points cost N invalidations instead of one.
export function appendTrendDots(parent, points, className = "chart-dot") {
  const keep = trendDotIndices(points.length);
  points.forEach(([x, y], i) => {
    if (keep && !keep.has(i)) return;
    parent.appendChild(svgEl("circle", { cx: x, cy: y, r: 3, class: className }));
  });
}

// Cheap change-detection key for a chart's input data.
//
// This replaced a JSON.stringify of the whole entry array. Both are O(n), but
// stringify walks and quotes every field of every object and allocates a string
// several times the size of the data — on a chart that is re-invoked on every
// cache-first render of its owning tab or sheet, over a list that is never
// retention-windowed and so only ever grows. This builds one compact number
// string per entry from just the fields that can actually change the drawing.
export function chartSignature(entries, valueKey) {
  let out = valueKey + "|" + entries.length;
  for (const e of entries) out += "," + e[valueKey];
  return out;
}

// One numeric value over time, as a line + dots — shared by the weight
// trend, per-measurement trend, and (Phase 3) the per-exercise 1RM
// sparkline. `chronological` is oldest-first; `valueKey` is read off each
// entry. Styling (line/dot color) comes entirely from CSS scoped under
// whatever class the caller's own <svg> element carries — this function
// never hardcodes a color, which is what lets three different charts share
// it while each keeping its own accent.
// Per-svg skip-if-unchanged cache, same reasoning/shape as progress.js's own
// lastRenderedCalorieChart/lastRenderedWeightChart: every caller here
// (measurement trend, 1RM sparkline) re-invokes this on every render of its
// owning tab/card, cache-first, even when nothing about the underlying data
// changed since last time — and unlike the calorie chart's `days` (capped at
// retention_days), neither measurements nor workout history are
// retention-windowed, so `chronological` only grows over a user's lifetime.
// Keyed per-<svg> (WeakMap, same as lastKnownSvgWidth just above) rather
// than one shared variable, since this one function serves multiple
// independent charts. The signature covers `valueKey`, the entry count and
// every plotted value — the only inputs that can change the drawing, since
// position on the x axis is index-derived rather than read off a date field.
const lastRenderedTrendLine = new WeakMap();
export function drawTrendLine(svg, chronological, valueKey) {
  const height = 140;
  const measuredWidth = Math.round(svg.getBoundingClientRect().width);
  const renderedViewBoxWidth = Number((svg.getAttribute("viewBox") || "").split(" ")[2]) || 0;
  const widthStable = !measuredWidth || measuredWidth === renderedViewBoxWidth;
  const signature = chartSignature(chronological, valueKey);
  if (signature === lastRenderedTrendLine.get(svg) && widthStable && svg.childElementCount) return;
  lastRenderedTrendLine.set(svg, signature);
  svg.replaceChildren();
  const width = sizeSvgToContainer(svg, height);
  const pad = 10;
  const values = chronological.map((e) => e[valueKey]);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const span = maxV - minV || 1;

  const points = chronological.map((entry, i) => {
    const x = pad + (chronological.length > 1 ? (i / (chronological.length - 1)) * (width - pad * 2) : 0);
    const y = pad + (1 - (entry[valueKey] - minV) / span) * (height - pad * 2);
    return [x, y];
  });

  const pathData = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  // One attach, not one per node — see appendTrendDots above.
  const frag = document.createDocumentFragment();
  frag.appendChild(svgEl("path", { d: pathData, class: "chart-line" }));
  appendTrendDots(frag, points);
  svg.appendChild(frag);
}
