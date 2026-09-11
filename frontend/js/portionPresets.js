// ---------------------------------------------------------------------------
// Household-measure portion chips — the UI half of the accuracy problem that
// no model solves.
//
// WHY THIS EXISTS. Portion weight, not food identification, is the dominant
// error source in photo-based calorie tracking, and it is not a model-quality
// problem: published benchmarks of this exact task put weight error at
// 54-98g MAE across every frontier vision model tested, including the best
// one, EVEN WHEN the food was identified correctly. A photograph genuinely
// does not contain the information needed to recover a portion's mass —
// density, occlusion and container depth are underdetermined. So the backend
// estimates a weight, and the only thing that can actually correct it is the
// person who ate the food.
//
// The problem with "just edit the number" is that grams are not how anyone
// perceives a portion. A user knows they ate "a bowl of rice"; asking them to
// convert that to 180 vs 250 grams is asking them to do the estimation the
// model just failed at, in a unit they don't think in. These chips let them
// answer in the unit they DO think in, and do the conversion for them.
//
// THE NUMBERS ARE NOT NEW. Every gram value below is lifted verbatim from
// backend/services/gemini_service.py's VISION_EXTRACTION_PROMPT — its own
// "anchor to a reference object of known size" list, which is what the model
// is already told to reason with. Keeping one set of anchors means a user
// tapping "1 fist" and the model looking at a fist-sized mound land on the
// same number instead of quietly disagreeing. If that prompt's anchors ever
// change, change these to match (same manual-sync discipline as
// VAPID_PUBLIC_KEY across config.js/sw.js, or RETENTION_DAYS across
// config.py/schema.sql).
//
// Where the prompt gives a range ("fist of cooked rice/pasta ~150-180g"),
// this takes the MIDPOINT: a chip is a starting point the user can still
// nudge in the weight field, and midpoint is the honest reading of a range.
// ---------------------------------------------------------------------------

import { t } from "./i18n.js";

// ---------------------------------------------------------------------------
// Chip glyphs. One minimal 24x24 line icon per preset, drawn in the same
// stroke vocabulary every other inline SVG in this app uses (fill: none,
// currentColor stroke at 1.5-1.6, round joins) so they inherit the chip's
// own active/inactive color with no per-state SVG swap.
//
// They exist because a household measure is a PHYSICAL thing — a fist, a
// spoon, a glass — and a row of identical text boxes makes the user read
// every label to find the one they mean. A silhouette is recognized before
// it is read, which is the whole point of offering household measures at
// all (see this file's header): the faster the right chip is found, the more
// likely the portion actually gets corrected.
//
// Deliberately not an icon font or a sprite sheet — this app ships no icon
// dependency anywhere (see ingredientsList.js's own inline glyphs), and nine
// small paths cost less than either.
// ---------------------------------------------------------------------------
const ICON_FIST = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="8.5" width="16" height="11" rx="4.2" stroke="currentColor" stroke-width="1.5"/><path d="M7.2 8.5V6.8a2.4 2.4 0 014.8 0v1.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8.6 12.6v2.2M12 12.6v2.2M15.4 12.6v2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const ICON_PALM = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.6 12.4V7a1.5 1.5 0 013 0v4.4M11.6 11.4V5.4a1.5 1.5 0 013 0v6M14.6 11.4V7.6a1.5 1.5 0 013 0V15a5.6 5.6 0 01-5.6 5.6h-.9A5.6 5.6 0 015.5 15v-2.8a1.5 1.5 0 013 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_THUMB = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.4 11l2.9-5.3a2 2 0 013.7 1v3.5h3.6a1.8 1.8 0 011.77 2.15l-1.05 5.2A2.3 2.3 0 0117.1 19.4H8.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="3.6" y="10.4" width="4.8" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/></svg>`;
const ICON_HANDFUL = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.8 11.6a8.2 8.2 0 0016.4 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M6.4 15.8l-1.9 2.8M17.6 15.8l1.9 2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8.7" cy="7.8" r="1.35" stroke="currentColor" stroke-width="1.4"/><circle cx="12.6" cy="6.2" r="1.35" stroke="currentColor" stroke-width="1.4"/><circle cx="15.8" cy="8.3" r="1.35" stroke="currentColor" stroke-width="1.4"/></svg>`;
const ICON_SLICE = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 10.6C6 7.4 8.7 4.8 12 4.8s6 2.6 6 5.8c0 1.2-.95 2.1-2.1 2.1v5.2a1.6 1.6 0 01-1.6 1.6H9.7a1.6 1.6 0 01-1.6-1.6v-5.2C6.95 12.7 6 11.8 6 10.6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
const ICON_BOWL = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.4 11.2h17.2a8.6 8.6 0 01-17.2 0z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8.9 7.9c0-1 .9-1.4.9-2.4M12 7.4c0-1.2 1-1.7 1-2.8M15.1 7.9c0-1 .9-1.4.9-2.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const ICON_MUG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.4 8.4h11v7.2a4.2 4.2 0 01-4.2 4.2H8.6a4.2 4.2 0 01-4.2-4.2V8.4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M15.4 10.4h1.9a2.8 2.8 0 010 5.6h-1.9" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7.6 5.6c0-.9.8-1.2.8-2.1M11.2 5.6c0-.9.8-1.2.8-2.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
const ICON_SPOON = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14.9 3.4c2.1 0 3.7 2 3.7 4.4s-1.6 4.4-3.7 4.4-3.7-2-3.7-4.4 1.6-4.4 3.7-4.4z" stroke="currentColor" stroke-width="1.5"/><path d="M12.7 11.2L5.4 20.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const ICON_GLASS = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 4.6h12l-1.3 13.6a2.2 2.2 0 01-2.19 2H9.49a2.2 2.2 0 01-2.19-2L6 4.6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6.75 11.4h10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

// Each preset declares the food categories it applies to via `match`
// keywords, checked against the ingredient's own name in BOTH languages (the
// food_name a Romanian user sees is Romanian — see the OUTPUT_LANGUAGE rule
// in the extraction prompts — so an English-only keyword list would show this
// affordance to English users only, which is exactly backwards for this
// app's core audience).
//
// `match: null` means universal — offered for any food, since a spoon or a
// cup applies to almost anything and a user who disagrees just ignores the
// chip. Universal presets sort last so food-specific ones lead.
const PRESETS = [
  {
    id: "fist_grain",
    labelKey: "portion.fist",
    icon: ICON_FIST,
    grams: 165, // prompt: "fist of cooked rice/pasta ~150-180g"
    match: [
      "rice", "pasta", "noodle", "spaghetti", "penne", "macaroni", "couscous",
      "quinoa", "bulgur", "barley", "orez", "paste", "taitei", "cuscus", "arpacas",
    ],
  },
  {
    id: "palm_meat",
    labelKey: "portion.palm",
    icon: ICON_PALM,
    grams: 100, // prompt: "deck-of-cards of cooked meat/fish ~85-110g"
    match: [
      "chicken", "beef", "pork", "turkey", "lamb", "steak", "fish", "salmon",
      "tuna", "cod", "shrimp", "meat", "breast", "thigh", "mince",
      "pui", "vita", "porc", "curcan", "miel", "peste", "somon", "ton",
      "carne", "piept", "pulpa", "cotlet", "snitel",
    ],
  },
  {
    id: "thumb_fat",
    labelKey: "portion.thumb",
    icon: ICON_THUMB,
    grams: 12, // prompt: "thumb-tip of oil/butter/nut butter ~10-15g"
    match: [
      "oil", "butter", "margarine", "mayo", "mayonnaise", "lard", "ghee",
      "tahini", "peanut butter", "nutella",
      "ulei", "unt", "margarina", "maioneza", "untura", "smantana",
    ],
  },
  {
    id: "handful_nuts",
    labelKey: "portion.handful",
    icon: ICON_HANDFUL,
    grams: 30, // prompt: "cupped handful of nuts ~30g"
    match: [
      "nut", "almond", "walnut", "cashew", "pistachio", "peanut", "hazelnut",
      "seed", "raisin", "granola", "trail mix",
      "nuca", "nuci", "migdale", "alune", "caju", "fistic", "seminte", "stafide",
    ],
  },
  {
    id: "slice_bread",
    labelKey: "portion.slice",
    icon: ICON_SLICE,
    grams: 35,
    // Not in the prompt's own anchor list (it names no bread reference), so
    // this is a standard commercial sandwich-loaf slice — the one addition
    // here, made because bread is among the most-logged foods and "a slice"
    // is overwhelmingly how it is perceived.
    match: ["bread", "toast", "baguette", "roll", "bun", "paine", "paini", "chifla", "bagheta", "toast"],
  },
  {
    id: "bowl",
    labelKey: "portion.bowl",
    icon: ICON_BOWL,
    grams: 500, // prompt: "bowl ~400-600ml"
    match: ["soup", "ciorba", "supa", "stew", "tocanita", "porridge", "cereal", "terci", "iaurt", "yogurt", "salad", "salata"],
  },
  {
    id: "mug",
    labelKey: "portion.mug",
    icon: ICON_MUG,
    grams: 300, // prompt: "mug ~250-350ml"
    match: ["milk", "coffee", "tea", "juice", "smoothie", "water", "lapte", "cafea", "ceai", "suc", "apa"],
  },
  // --- universal: always offered, sorted last ------------------------------
  { id: "tbsp", labelKey: "portion.tbsp", grams: 15, match: null, icon: ICON_SPOON },
  { id: "cup", labelKey: "portion.cup", grams: 240, match: null, icon: ICON_GLASS },
];

// A chip whose gram value is already what the field holds is not worth a tap,
// and showing it invites one that appears to do nothing. This is the band
// within which a chip is considered "already applied" and gets marked as the
// active one instead.
const ACTIVE_TOLERANCE_G = 2;

// Cap on how many chips one row offers. Ordered by specificity, so the cut
// always falls on the most generic options.
//
// This used to be 4, sized by how many text-only pills fit on ONE wrapped
// line of a narrow phone — a layout constraint, not a usefulness one. The
// row is now a single-line horizontal scroller (see renderPortionChips and
// .portion-chips-row in style.css), so "how many fit" stopped being the
// question: the next chip peeking past the right edge is what tells the user
// the row scrolls at all, and a food matching two specific presets plus the
// two universal ones was hitting the old cap and hiding that affordance.
// 6 keeps every specific match that can realistically fire, plus both
// universal fallbacks, without turning the row into a scroll marathon.
const MAX_CHIPS = 6;

function normalize(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // strip Romanian diacritics so "pâine" matches "paine"
}

/**
 * The presets worth offering for one ingredient, most specific first.
 * Always returns at least the universal ones, so the affordance never
 * silently disappears on an unrecognized food.
 */
export function presetsFor(foodName) {
  const name = normalize(foodName);
  const specific = name
    ? PRESETS.filter((p) => p.match && p.match.some((kw) => name.includes(normalize(kw))))
    : [];
  const universal = PRESETS.filter((p) => !p.match);
  return [...specific, ...universal].slice(0, MAX_CHIPS);
}

/** Whether `grams` is close enough to a preset that it reads as applied. */
export function isPresetActive(preset, grams) {
  return Math.abs((Number(grams) || 0) - preset.grams) <= ACTIVE_TOLERANCE_G;
}

/**
 * Renders the chip row for one ingredient. Returns "" when there is nothing
 * worth showing, so callers can interpolate it unconditionally.
 *
 * Chips are <button type="button"> rather than styled spans specifically so
 * they are keyboard-reachable and announce as controls — this is a real
 * input affordance, not decoration.
 *
 * Each chip is [icon][label over grams]: the glyph is what the eye lands on
 * first, the label names the measure, and the gram figure underneath is the
 * receipt for what tapping it will actually write into the weight field —
 * stacked rather than inline so a longer Romanian label ("1 lingură") can't
 * push the number out of the chip.
 *
 * The `.portion-chips-scroller` wrapper is the element that actually scrolls;
 * `.portion-chips-row` inside it is the plain nowrap flex track. They are two
 * elements rather than one because the scroller carries the edge-fade mask
 * (see syncPortionScrollHints below) and a mask on a scroll container fades
 * against the container's own box, which is exactly what's wanted — folding
 * both jobs into one element would make the fade scroll away with the
 * content.
 */
export function renderPortionChips(idx, foodName, currentGrams) {
  const presets = presetsFor(foodName);
  if (!presets.length) return "";
  const chips = presets
    .map((p) => {
      const active = isPresetActive(p, currentGrams);
      const label = t(p.labelKey);
      return `
        <button type="button" class="portion-chip${active ? " is-active" : ""}"
                data-idx="${idx}" data-portion-grams="${p.grams}"
                aria-pressed="${active ? "true" : "false"}">
          <span class="portion-chip-icon" aria-hidden="true">${p.icon}</span>
          <span class="portion-chip-text">
            <span class="portion-chip-label">${label}</span>
            <span class="portion-chip-grams">${p.grams}g</span>
          </span>
        </button>`;
    })
    .join("");
  return `
    <div class="portion-chips" role="group" aria-label="${t("portion.groupLabel")}">
      <span class="portion-chips-hint">${t("portion.hint")}</span>
      <div class="portion-chips-scroller">
        <div class="portion-chips-row">${chips}</div>
      </div>
    </div>`;
}

/**
 * Paints the two edge-fade hints on every chip scroller inside `root`.
 *
 * The fades are how a single-line horizontal scroller admits it scrolls at
 * all, but they can only be honest about it from a live measurement — a
 * permanent right-hand fade on a row whose three chips already fit would be
 * lying about hidden content, and a permanent left-hand one would dim the
 * first chip at rest. So the classes are toggled from scrollWidth/scrollLeft
 * rather than declared in CSS, the same way js/ui.js's journal scroll hint
 * already works.
 *
 * Two different tolerances, and they are not the same number by accident:
 *
 *   SCROLLABLE_SLACK_PX — how much hidden content is worth ADMITTING TO at
 *     all. A row can overflow by 3px (measured: three chips at 291px inside
 *     a 288px scroller on a 320px phone) purely from rounding, and dressing
 *     that up with a 28px gradient promises a whole chip the user will never
 *     find. Below this, the row is treated as "it fits" and gets no fade.
 *   EDGE_EPSILON_PX — how close to an end counts AS that end. A fractional
 *     scrollLeft is routine on a high-DPI phone after an elastic overscroll,
 *     and without slack a fully-scrolled row keeps a sliver of fade stuck on.
 */
const SCROLLABLE_SLACK_PX = 10;
const EDGE_EPSILON_PX = 1;

export function syncPortionScrollHints(root) {
  root?.querySelectorAll(".portion-chips-scroller").forEach((scroller) => {
    const max = scroller.scrollWidth - scroller.clientWidth;
    const left = scroller.scrollLeft;
    const scrollable = max > SCROLLABLE_SLACK_PX;
    scroller.classList.toggle("has-scroll-start", scrollable && left > EDGE_EPSILON_PX);
    scroller.classList.toggle("has-scroll-end", scrollable && left < max - EDGE_EPSILON_PX);
  });
}
