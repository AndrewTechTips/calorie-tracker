// The macro mark — Iron Log's generated per-food glyph (Phase 2 of the Pantry
// redesign, see the concept doc). Three concentric arcs sharing a centre:
// protein outermost, carbs in the middle, fats innermost, each sweeping in
// proportion to the share of the food's CALORIES that macro contributes
// (4/4/9, not grams — grams would make fat look small when it is usually the
// biggest energy contributor).
//
// Why this exists at all: the Saved list used to render the same grey fork
// icon on every single row, so forty saved meals were forty identical rows
// and the icon column was pure decoration. This makes that column carry
// information instead — chicken breast is one long teal stroke and almost
// nothing else, walnuts are the inverse, a bowl of rice is one fat amber
// ring. Two jobs at once: every food gets a silhouette you can pick out of a
// list at a glance, and the silhouette is TRUE.
//
// It is drawn from tokens the design system already defines (--c-protein /
// --c-carbs / --c-fats) rather than hardcoded hexes, so it is correct in both
// themes for free — see style.css's own warning about rgba() literals
// freezing at dark-mode values.
//
// DECORATIVE, deliberately: every card that renders a mark also prints the
// same macros as text right next to it, so the mark is always aria-hidden and
// never the only carrier of the numbers.

// Geometry is expressed against a fixed 44-unit viewBox and scaled by the
// `size` argument, so one set of numbers works at every render size.
const VIEWBOX = 44;
const CENTRE = VIEWBOX / 2;
const STROKE = 3.5;
// Outer -> inner. The 4.8-unit step between radii leaves ~1.3 units of clear
// space between neighbouring strokes, which is what keeps the three rings
// readable as three rings rather than a single thick band.
const RADII = [17, 12.2, 7.4];
const MACRO_VARS = ["--c-protein", "--c-carbs", "--c-fats"];
// A share of 1.0 sweeps 84% of the ring, never the full circle: a closed ring
// and a 97%-closed ring are indistinguishable at 40px, so capping the sweep
// keeps the gap legible as "this is an arc, and it is nearly full".
const MAX_SWEEP = 0.84;
// Below this share a macro is rendered as a round dot rather than nothing, so
// "a trace of fat" and "no fat at all" stay visually distinct. Anything at or
// below it is genuinely absent and draws only the empty track.
const TRACE_SHARE = 0.004;

// Calorie share per macro, using Atwater factors. Returns [protein, carbs,
// fats] fractions summing to 1 — or three zeros for an item with no macro
// data at all, which draws as three empty tracks (an honest "nothing known"
// rather than a fabricated shape).
function macroCalorieShares({ protein = 0, carbs = 0, fats = 0 } = {}) {
  const kcal = [Math.max(protein, 0) * 4, Math.max(carbs, 0) * 4, Math.max(fats, 0) * 9];
  const total = kcal[0] + kcal[1] + kcal[2];
  if (!total) return [0, 0, 0];
  return kcal.map((k) => k / total);
}

// Returns an <svg> string. `size` is the rendered px box; the viewBox does the
// rest. Built as a string rather than DOM nodes because every caller feeds it
// straight into reconcileList's buildHtml, which diffs on the markup string
// and skips the innerHTML write entirely when a row hasn't changed — so this
// runs once per row per data change, not once per render.
export function macroMarkSvg(macros, size = 40) {
  const shares = macroCalorieShares(macros);
  const arcs = shares
    .map((share, i) => {
      const r = RADII[i];
      const circumference = 2 * Math.PI * r;
      const track = `<circle cx="${CENTRE}" cy="${CENTRE}" r="${r}" fill="none" stroke="currentColor" stroke-opacity="0.13" stroke-width="${STROKE}"/>`;
      if (share <= TRACE_SHARE) return track;
      // stroke-linecap: round adds half a stroke-width of cap at each end, so
      // a dash of ~0.9 * STROKE renders as a clean dot rather than a stub.
      const length = Math.max(share * circumference * MAX_SWEEP, STROKE * 0.9);
      const arc =
        `<circle cx="${CENTRE}" cy="${CENTRE}" r="${r}" fill="none" stroke="var(${MACRO_VARS[i]})"` +
        ` stroke-width="${STROKE}" stroke-linecap="round"` +
        ` stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}"` +
        ` transform="rotate(-90 ${CENTRE} ${CENTRE})"/>`;
      return track + arc;
    })
    .join("");
  return `<svg viewBox="0 0 ${VIEWBOX} ${VIEWBOX}" width="${size}" height="${size}" aria-hidden="true" focusable="false">${arcs}</svg>`;
}
