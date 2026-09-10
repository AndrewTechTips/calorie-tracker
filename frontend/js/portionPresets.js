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
    grams: 165, // prompt: "fist of cooked rice/pasta ~150-180g"
    match: [
      "rice", "pasta", "noodle", "spaghetti", "penne", "macaroni", "couscous",
      "quinoa", "bulgur", "barley", "orez", "paste", "taitei", "cuscus", "arpacas",
    ],
  },
  {
    id: "palm_meat",
    labelKey: "portion.palm",
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
    grams: 500, // prompt: "bowl ~400-600ml"
    match: ["soup", "ciorba", "supa", "stew", "tocanita", "porridge", "cereal", "terci", "iaurt", "yogurt", "salad", "salata"],
  },
  {
    id: "mug",
    labelKey: "portion.mug",
    grams: 300, // prompt: "mug ~250-350ml"
    match: ["milk", "coffee", "tea", "juice", "smoothie", "water", "lapte", "cafea", "ceai", "suc", "apa"],
  },
  // --- universal: always offered, sorted last ------------------------------
  { id: "tbsp", labelKey: "portion.tbsp", grams: 15, match: null },
  { id: "cup", labelKey: "portion.cup", grams: 240, match: null },
];

// A chip whose gram value is already what the field holds is not worth a tap,
// and showing it invites one that appears to do nothing. This is the band
// within which a chip is considered "already applied" and gets marked as the
// active one instead.
const ACTIVE_TOLERANCE_G = 2;

// Cap so a row never grows a second line of chips on a narrow phone. Ordered
// by specificity, so the cut always falls on the most generic options.
const MAX_CHIPS = 4;

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
 */
export function renderPortionChips(idx, foodName, currentGrams) {
  const presets = presetsFor(foodName);
  if (!presets.length) return "";
  const chips = presets
    .map((p) => {
      const active = isPresetActive(p, currentGrams);
      return `
        <button type="button" class="portion-chip${active ? " is-active" : ""}"
                data-idx="${idx}" data-portion-grams="${p.grams}"
                aria-pressed="${active ? "true" : "false"}">
          <span class="portion-chip-label">${t(p.labelKey)}</span>
          <span class="portion-chip-grams">${p.grams}g</span>
        </button>`;
    })
    .join("");
  return `
    <div class="portion-chips" role="group" aria-label="${t("portion.groupLabel")}">
      <span class="portion-chips-hint">${t("portion.hint")}</span>
      <div class="portion-chips-row">${chips}</div>
    </div>`;
}
