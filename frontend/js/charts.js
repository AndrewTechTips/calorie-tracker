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

// One numeric value over time, as a line + dots — shared by the weight
// trend, per-measurement trend, and (Phase 3) the per-exercise 1RM
// sparkline. `chronological` is oldest-first; `valueKey` is read off each
// entry. Styling (line/dot color) comes entirely from CSS scoped under
// whatever class the caller's own <svg> element carries — this function
// never hardcodes a color, which is what lets three different charts share
// it while each keeping its own accent.
export function drawTrendLine(svg, chronological, valueKey) {
  svg.innerHTML = "";
  const height = 140;
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
  svg.appendChild(svgEl("path", { d: pathData, class: "chart-line" }));
  points.forEach(([x, y]) => svg.appendChild(svgEl("circle", { cx: x, cy: y, r: 3, class: "chart-dot" })));
}
