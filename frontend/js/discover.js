// The Discover tab — recipes (curated static catalog), workout plans
// (curated static catalog) + a live exercise-library search (wger.de), and
// a live product search (Open Food Facts). See backend/routers/discover.py
// and backend/data/discover_data.py for the server side of all four.
import { api } from "./api.js";
import { closeSheet, escapeHtml, openSheet, runOrDeferDuringSwipe, showToast, wirePillTabs } from "./ui.js";
import { getLanguage, onLanguageChange, t } from "./i18n.js";
import { openProductResult } from "./scan.js";
import { openWorkoutDiary } from "./workoutDiary.js";
import { cacheDiscoverList, getCachedDiscoverList } from "./db.js";
import { asImplicitIngredient, createIngredientsEditor } from "./ingredientsList.js";
import { translateMuscle } from "./exerciseI18n.js";
import { roundTo1 } from "./nutritionMath.js";
import { PetHud } from "./petHud.js";

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// A distinct pictogram + accent tint per category, instead of one placeholder
// icon repeated across every card — the backend tags each recipe/plan with an
// `icon` key (see backend/data/discover_data.py's module docstring), this
// just maps that key to real app-native artwork. Same stroke-based,
// currentColor line-icon style already used everywhere else in this app
// (header/nav icons etc.) rather than inventing a second visual language, and
// the accent colors reuse the existing macro-ring palette (--c-*-rgb, see
// style.css) rather than adding new brand colors.
// ---------------------------------------------------------------------------
const ICONS = {
  soup: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 11h16a7 7 0 01-7 7h-2a7 7 0 01-7-7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 4c-1 1-1 2 0 3M12 3c-1 1-1 2 0 3M15 4c-1 1-1 2 0 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  grill: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 9h18M3 15h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 5v14M12 5v14M17 5v14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.7"/></svg>',
  stew: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 11h16v3a6 6 0 01-6 6h-4a6 6 0 01-6-6v-3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M2 11h20M9 11V8a3 3 0 016 0v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  mash: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 12h11a5.5 5.5 0 01-5.5 5.5A5.5 5.5 0 014 12z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M17 5v6M19 5v4M21 5v4M19 9v8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  salad: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 11h16a7 7 0 01-7 7h-2a7 7 0 01-7-7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 11c-1-3 1-5 4-5 0 3-2 5-4 5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  bowl: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 11h16a7 7 0 01-7 7h-2a7 7 0 01-7-7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 11v7M8 12.5c0 2 .8 3.8 2 5M16 12.5c0 2-.8 3.8-2 5" stroke="currentColor" stroke-width="1.2" opacity="0.7"/></svg>',
  parfait: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 4h10l-1.5 15a1 1 0 01-1 .9h-5a1 1 0 01-1-.9L7 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.6 10h8.8M8.2 15h7.6" stroke="currentColor" stroke-width="1.3"/></svg>',
  oats: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 12h13a5.5 5.5 0 01-5.5 5.5A5.5 5.5 0 014 12z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><ellipse cx="18.5" cy="6" rx="2" ry="2.7" stroke="currentColor" stroke-width="1.4"/><path d="M18.5 8.7V17" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  fish: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 12c3-4 8-6 13-4 2 .8 4 2.3 5 4-1 1.7-3 3.2-5 4-5 2-10 0-13-4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M16 9l3-3M16 15l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8.5" cy="11.2" r="0.9" fill="currentColor"/></svg>',
  stirfry: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 12c0 3.3 4 6 9 6s9-2.7 9-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3 12h18M20 9l2.5-1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  curry: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 11h16v2a6 6 0 01-6 6h-4a6 6 0 01-6-6v-2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 4.5c1.2.5 1.2 1.5 0 2s-1.2 1.5 0 2M13 4.5c1.2.5 1.2 1.5 0 2s-1.2 1.5 0 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  omelette: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 13c0 4 4 6 9 6s9-2 9-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3 13h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M8 9.5c1.5-2 6.5-2 8 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  dessert: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/><path d="M7 8c1 1 2 1 3 0M14 8c1 1 2 1 3 0M7 16c1-1 2-1 3 0M14 16c1-1 2-1 3 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  sandwich: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 10l8-6 8 6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 10h16v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M5 17h14M6 20h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  pizza: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l9 16H3L12 3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="10" cy="15.5" r="1" fill="currentColor"/><circle cx="14" cy="15.5" r="1" fill="currentColor"/></svg>',
  smoothie: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 8h10l-1.3 10.5a1.5 1.5 0 01-1.5 1.3h-4.4a1.5 1.5 0 01-1.5-1.3L7 8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M15 8l1.5-4.5M9 3.5L10.5 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  pasta: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 12h13a5.5 5.5 0 01-5.5 5.5A5.5 5.5 0 014 12z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 7c1.5 1 1.5 2.5 0 3.5M11 6.5c1.5 1 1.5 2.5 0 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M17 5v6M19 5v4M21 5v4M19 9v8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 10v4M2.5 9v6M7 8v8M17 8v8M19.5 9v6M21.5 10v4M7 12h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fullbody: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M4 9l3-3M20 15l-3 3M8 8l8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.4"/><circle cx="18" cy="18" r="2" stroke="currentColor" stroke-width="1.4"/></svg>',
  bodyweight: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="4.5" r="1.8" stroke="currentColor" stroke-width="1.5"/><path d="M5 18c0-4 1-6 3-7-1-2 0-4 2-4.5 2.5-.6 4 1 4 3 0 1.5-.8 2-1.5 2.5 2 .3 3.5 2 3.5 4.5v2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  upperlower: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v7M9 7l3 3 3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 21v-7M9 17l3-3 3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  brosplit: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="9" r="4" stroke="currentColor" stroke-width="1.6"/><path d="M9.5 12.5L7 20M14.5 12.5L17 20M8 20h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  hiit: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="13" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M10 2h4M12 5v2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13 9l-4 5h3l-1 4 4-5h-3l1-4z" fill="currentColor"/></svg>',
  dumbbell: '<svg viewBox="0 0 24 24" fill="none"><rect x="10" y="9" width="4" height="6" rx="1" stroke="currentColor" stroke-width="1.6"/><path d="M10 11H6M14 11h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 9.5v3M6 8.5v5M18 8.5v5M20 9.5v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  mobility: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="4.5" r="1.8" stroke="currentColor" stroke-width="1.5"/><path d="M12 6.5v6M8 9l4-1.5 4 1.5M9 20l3-7 3 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
// Thematic accent per icon — reuses the app's existing macro-ring palette
// (--c-*-rgb custom properties) rather than inventing new brand colors, just
// like the Settings profile card's decorative pattern already does.
const ICON_COLOR = {
  soup: "calories", grill: "calories", stew: "calories", curry: "calories", brosplit: "calories", hiit: "calories",
  mash: "fiber", salad: "fiber", sandwich: "fiber", bodyweight: "fiber",
  bowl: "protein", stirfry: "protein", omelette: "protein", split: "protein", fullbody: "protein", upperlower: "protein", dumbbell: "protein",
  parfait: "carbs", oats: "carbs", pizza: "carbs", pasta: "carbs",
  fish: "water", smoothie: "water",
  dessert: "fats", mobility: "fats",
};
const DEFAULT_RECIPE_ICON = "bowl";
const DEFAULT_PLAN_ICON = "split";

// Recipe/workout-plan photos are hotlinked from Wikimedia Commons (see
// backend/data/discover_data.py) via its Special:FilePath redirect, which by
// default serves the ORIGINAL uploaded file — often several megabytes for a
// real photo. Special:FilePath also supports a documented `width` query
// param that redirects to a pre-generated thumbnail instead (a 480px-wide
// thumbnail of a ~2MB original was measured at ~28KB — a ~70x reduction),
// which is what actually made the Discover tab feel slow to load. Card
// thumbnails and the bigger detail-sheet hero image request different
// widths; exercise/product photos (wger.de/Open Food Facts) already come
// pre-sized from their own APIs, so this is a deliberate no-op for any URL
// that isn't a Commons one.
const CARD_IMAGE_WIDTH = 480;
const DETAIL_IMAGE_WIDTH = 960;
function wikimediaThumb(url, width) {
  if (!url || !url.includes("commons.wikimedia.org")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}width=${width}`;
}

// Shared by every detail-sheet hero image (recipe/workout-plan/exercise) —
// swaps in the same branded icon+color placeholder buildCard's grid cards
// already fall back to (never the browser's default broken-image glyph),
// whether there's no photo at all or the hotlinked third-party photo 404s/
// times out (e.g. offline and not yet in the service worker's media cache —
// see sw.js's handleMediaRequest, which deliberately resolves offline misses
// as a failing Response so this same onerror path fires either way).
function setDetailImage(img, placeholder, url, iconKey) {
  img.onerror = null;
  img.onload = null;
  const showPlaceholder = () => {
    img.hidden = true;
    if (!placeholder) return;
    const key = iconKey && ICONS[iconKey] ? iconKey : DEFAULT_RECIPE_ICON;
    placeholder.className = `discover-detail-image-placeholder discover-icon-${ICON_COLOR[key] || "protein"}`;
    placeholder.innerHTML = ICONS[key];
    placeholder.hidden = false;
  };
  if (!url) {
    showPlaceholder();
    return;
  }
  if (placeholder) placeholder.hidden = true;
  img.hidden = false;
  img.classList.add("discover-card-image-loading");
  img.onload = () => img.classList.remove("discover-card-image-loading");
  img.onerror = showPlaceholder;
  img.src = url;
}

let currentTab = "recipes";
let activeRecipeTag = null;
let activePlanTag = null;
let onDataChanged = null;

// ---------------------------------------------------------------------------
// Macro-fit engine — one deterministic, client-side "does this plate fit
// what's left of my day" score, driving BOTH the "Tonight's Pick" hero and
// the "More that fit" rail below it. Ranked against data app.js already
// holds (setDiscoverContext, bound to discoverContextBridge): today's
// remaining calorie/protein budget, the user's goal phase, and whether a
// workout meal was logged today. No backend ranking call; runs offline off
// the IndexedDB-cached catalog. Same "computed at read time, no second
// source of truth" spirit as suggestions.js / trends_service.
// ---------------------------------------------------------------------------
let discoverCtx = { remaining: null, goalType: "maintain", trainedToday: false, loggedToday: false };

const MEANINGFUL_PROTEIN_GAP_G = 5;
// Calorie-overshoot ceiling as a multiple of what's left today, by goal
// phase — a cut tolerates almost none, a bulk day a fair bit. A recipe
// above its ceiling isn't a candidate for the hero OR the rail.
const OVERSHOOT_CAP = { cut: 1.05, maintain: 1.15, bulk: 1.3 };
// How hard an over-budget (but still under the cap) recipe is penalised,
// again by goal — a cut punishes the overshoot, a bulk mostly shrugs.
const OVERSHOOT_PENALTY = { cut: 1.0, maintain: 0.6, bulk: 0.35 };
const FIT_WEIGHTS = { calorie: 0.34, protein: 0.34, goal: 0.22, training: 0.1 };

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Stable within a calendar day, different the next — so the pick genuinely
// rotates day to day even when the remaining-macro numbers barely move,
// without ever being random within a day (which would reshuffle the hero on
// every render). Weighted tiny (±0.02) so it only ever breaks a near-tie.
function dailyJitter(id) {
  const seed = `${id}|${new Date().toISOString().slice(0, 10)}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function mealSlot(d = new Date()) {
  const h = d.getHours();
  if (h < 11) return "morning";
  if (h < 16) return "midday";
  return "evening";
}

// Scores one recipe (as a single standard serving) against the current
// context. Returns null when the recipe is over its goal's calorie ceiling
// — not a candidate at all — else a { score 0..1, ...breakdown } object
// used both to rank and to choose the "why it fits" line.
function fitComponents(recipe, ctx) {
  const rem = ctx.remaining;
  if (!rem || !(rem.calories > 0) || !(recipe.calories > 0)) return null;
  const cap = OVERSHOOT_CAP[ctx.goalType] ?? OVERSHOOT_CAP.maintain;
  if (recipe.calories > rem.calories * cap) return null;

  const tags = new Set(recipe.tags);
  const isDessert = tags.has("dessert");
  const proteinGap = Math.max(rem.protein, 0);
  const proteinIsGap = proteinGap > MEANINGFUL_PROTEIN_GAP_G;

  // calorieFit — peaks when the recipe uses a healthy slice of what's left
  // (ratio ~0.65), tails off if it's trivially small or pushes over budget.
  const cr = recipe.calories / rem.calories;
  let calorieFit;
  if (cr < 0.25) calorieFit = (cr / 0.25) * 0.6;
  else if (cr <= 0.9) calorieFit = 0.6 + (1 - Math.abs(cr - 0.65) / 0.4) * 0.4;
  else if (cr <= 1) calorieFit = 0.75 - ((cr - 0.9) / 0.1) * 0.25;
  else calorieFit = Math.max(0, 0.5 - ((cr - 1) / (cap - 1)) * 0.5);
  calorieFit = clamp01(calorieFit);

  // proteinClose — how much of the remaining protein gap this plate closes.
  // Neutral (0.5) once protein's essentially met, so ranking then leans on
  // calorie fit + goal alignment instead of chasing a few leftover grams.
  const proteinClose = proteinIsGap ? clamp01(recipe.protein / proteinGap) : 0.5;

  // goalAlign — tag-driven tilt for the active goal phase.
  let goalAlign = 0.5;
  if (ctx.goalType === "cut") {
    if (tags.has("cut")) goalAlign += 0.28;
    if (tags.has("low-calorie")) goalAlign += 0.14;
    if (tags.has("high-protein")) goalAlign += 0.12;
    if (tags.has("bulk")) goalAlign -= 0.22;
    if (isDessert) goalAlign -= 0.2;
  } else if (ctx.goalType === "bulk") {
    if (tags.has("bulk")) goalAlign += 0.26;
    if (tags.has("high-protein")) goalAlign += 0.14;
    if (tags.has("comfort-food")) goalAlign += 0.08;
    if (tags.has("low-calorie")) goalAlign -= 0.12;
  } else {
    if (tags.has("balanced")) goalAlign += 0.24;
    if (tags.has("maintain")) goalAlign += 0.16;
    if (tags.has("high-protein")) goalAlign += 0.06;
  }
  goalAlign = clamp01(goalAlign);

  // trainingBonus — only when a workout meal was logged today: reward
  // protein and real post-workout carbs.
  let trainingBonus = 0;
  if (ctx.trainedToday) {
    if (tags.has("high-protein")) trainingBonus += 0.5;
    if (recipe.carbs >= 35) trainingBonus += 0.5;
    trainingBonus = clamp01(trainingBonus);
  }

  // Soft meal-time nudge — never decisive on its own.
  const slot = mealSlot();
  let slotAdj = 0;
  if (slot === "morning") {
    if (tags.has("breakfast")) slotAdj += 0.12;
    if (recipe.prep_minutes > 35) slotAdj -= 0.1;
  } else if (slot === "evening" && tags.has("breakfast")) {
    slotAdj -= 0.08;
  }

  let score =
    FIT_WEIGHTS.calorie * calorieFit +
    FIT_WEIGHTS.protein * proteinClose +
    FIT_WEIGHTS.goal * goalAlign +
    FIT_WEIGHTS.training * trainingBonus +
    slotAdj;

  if (recipe.calories > rem.calories) {
    const overFrac = (recipe.calories - rem.calories) / rem.calories;
    score -= overFrac * (OVERSHOOT_PENALTY[ctx.goalType] ?? OVERSHOOT_PENALTY.maintain);
  }
  if (isDessert) score -= 0.12;
  score = clamp01(score + (dailyJitter(recipe.id) - 0.5) * 0.04);

  return { score, calorieFit, proteinClose, goalAlign, trainingBonus, proteinIsGap, proteinGap, isDessert };
}

// Ranked best-first: [{ recipe, fit }]. Tie-break prefers a savoury dish,
// then more protein, then a shorter cook.
function rankRecipesByFit(recipes, ctx) {
  return recipes
    .map((recipe) => ({ recipe, fit: fitComponents(recipe, ctx) }))
    .filter((x) => x.fit)
    .sort(
      (a, b) =>
        b.fit.score - a.fit.score ||
        Number(a.fit.isDessert) - Number(b.fit.isDessert) ||
        b.recipe.protein - a.recipe.protein ||
        a.recipe.prep_minutes - b.recipe.prep_minutes,
    );
}

// A dessert is never the headline pick unless protein is already met AND it
// leaves comfortable calorie room — otherwise "eat cake" scores as a fine
// macro fit and reads as a terrible suggestion.
function heroEligible({ recipe, fit }, ctx) {
  if (!fit.isDessert) return true;
  return ctx.remaining.protein <= MEANINGFUL_PROTEIN_GAP_G && recipe.calories <= ctx.remaining.calories * 0.6;
}

// The single "why this plate" line — strongest real reason wins.
function fitReason({ recipe, fit }, ctx) {
  if (fit.trainingBonus >= 0.6) {
    return t("discover.fitReasonPostWorkout", { protein: Math.round(recipe.protein), carbs: Math.round(recipe.carbs) });
  }
  if (fit.proteinIsGap && fit.proteinClose >= fit.goalAlign && recipe.protein >= Math.min(fit.proteinGap * 0.6, 25)) {
    return t("discover.fitReasonProtein", { grams: Math.round(Math.min(recipe.protein, fit.proteinGap)) });
  }
  if (fit.goalAlign >= 0.72) {
    const suffix = ctx.goalType === "cut" ? "Cut" : ctx.goalType === "bulk" ? "Bulk" : "Maintain";
    return t(`discover.fitReason${suffix}`);
  }
  if (fit.calorieFit >= 0.7) {
    return t("discover.fitReasonCalories", { calories: Math.round(ctx.remaining.calories) });
  }
  return t("discover.fitReasonGeneric");
}

// app.js now pushes { remaining, goalType, trainedToday, loggedToday };
// tolerate a bare remaining-macros object too (older call shape / tests).
export function setDiscoverContext(ctx) {
  discoverCtx = ctx && "remaining" in ctx ? { ...discoverCtx, ...ctx } : { ...discoverCtx, remaining: ctx };
  if (!el("view-discover").hidden) {
    renderTonightsPick();
    renderMoreThatFit();
  }
}

// ---------------------------------------------------------------------------
// "Tonight's Pick" — the macro-fit hero at the very top of the tab
// ---------------------------------------------------------------------------
const PICK_EYEBROW_KEY = {
  morning: "discover.pickEyebrowMorning",
  midday: "discover.pickEyebrowMidday",
  evening: "discover.pickEyebrowEvening",
};
const SPARK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3l1.8 5.6L19.5 10l-5.7 1.4L12 17l-1.8-5.6L4.5 10l5.7-1.4L12 3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
// Weekly-challenge eyebrow (renderChallenge below) — same stroke/currentColor
// line-icon language as ICONS / SPARK_ICON above.
const TROPHY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 4h10v4a5 5 0 01-10 0V4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M17 5h2.4a1 1 0 011 1c0 2-1.4 3.6-3.6 3.9M7 5H4.6a1 1 0 00-1 1c0 2 1.4 3.6 3.6 3.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12 13v3M9 20h6M10 20a2 2 0 014 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// `lastPickPaintKey` is the same anti-flash guard the old rail used — skip a
// rebuild that would produce a byte-identical hero so the photo never
// re-flashes / the load-in never replays. `lastRankingKey` is separate: it
// tracks only the ranked-id order, so the "next pick" chevron's manual
// pickCycleIndex isn't reset on an unrelated re-render, but IS reset when
// the ranking itself actually changes (a food gets logged).
let lastPickPaintKey = null;
let lastRankingKey = null;
let pickCycleIndex = 0;
let pickCandidates = [];

function currentHeroId() {
  const n = pickCandidates.length;
  return n ? pickCandidates[pickCycleIndex % n].recipe.id : null;
}

async function renderTonightsPick() {
  const host = el("discover-pick");
  if (!discoverCtx.remaining) {
    host.hidden = true;
    lastPickPaintKey = lastRankingKey = null;
    pickCandidates = [];
    return;
  }
  let recipes;
  try {
    recipes = await getBaselineRecipes();
  } catch {
    runOrDeferDuringSwipe(() => (host.hidden = true));
    return;
  }

  // Calorie budget already spent — a calm "you're there" state instead of a
  // pick that can't help but tell someone at their limit to eat more.
  if (discoverCtx.remaining.calories <= 0) {
    pickCandidates = [];
    if (lastPickPaintKey === "goal-met" && !host.hidden) return;
    lastPickPaintKey = "goal-met";
    lastRankingKey = null;
    runOrDeferDuringSwipe(() => {
      host.hidden = false;
      host.innerHTML = `
        <div class="discover-pick-met">
          <span class="discover-pick-met-icon">${SPARK_ICON}</span>
          <div>
            <p class="discover-pick-met-title">${escapeHtml(t("discover.pickGoalMetTitle"))}</p>
            <p class="discover-pick-met-body">${escapeHtml(t("discover.pickGoalMetBody"))}</p>
          </div>
        </div>`;
    });
    return;
  }

  const ranked = rankRecipesByFit(recipes, discoverCtx).filter((x) => heroEligible(x, discoverCtx));
  if (!ranked.length) {
    runOrDeferDuringSwipe(() => (host.hidden = true));
    lastPickPaintKey = lastRankingKey = null;
    pickCandidates = [];
    return;
  }

  pickCandidates = ranked.slice(0, 5);
  const rankingKey = pickCandidates.map((x) => x.recipe.id).join("|");
  if (rankingKey !== lastRankingKey) {
    lastRankingKey = rankingKey;
    pickCycleIndex = 0;
  }
  const idx = pickCycleIndex % pickCandidates.length;
  const paintKey = `${rankingKey}#${idx}`;
  if (paintKey === lastPickPaintKey && !host.hidden && host.querySelector(".discover-pick-card")) return;
  lastPickPaintKey = paintKey;

  const chosen = pickCandidates[idx];
  runOrDeferDuringSwipe(() => {
    host.hidden = false;
    paintPickCard(host, chosen);
  });
}

function paintPickCard(host, entry) {
  const { recipe } = entry;
  const rem = discoverCtx.remaining;
  const iconKey = recipe.icon && ICONS[recipe.icon] ? recipe.icon : DEFAULT_RECIPE_ICON;
  const placeholder = `<div class="discover-pick-img discover-card-image-placeholder discover-icon-${ICON_COLOR[iconKey] || "protein"}">${ICONS[iconKey]}</div>`;
  const imageUrl = wikimediaThumb(recipe.image_url, DETAIL_IMAGE_WIDTH);

  // The two "budget fill" bars: how much of what's left today this one
  // plate uses. Clamped to 1 for the bar; the label carries the real math.
  const calRatio = clamp01(recipe.calories / rem.calories);
  const proteinLeft = Math.max(rem.protein, 0);
  const proRatio = proteinLeft > 0 ? clamp01(recipe.protein / proteinLeft) : 1;
  const hasChoice = pickCandidates.length > 1;

  host.innerHTML = `
    <article class="discover-pick-card" data-recipe-id="${escapeHtml(recipe.id)}">
      ${
        imageUrl
          ? `<img class="discover-pick-img discover-card-image-loading" src="${imageUrl}" alt="" decoding="async" />`
          : placeholder
      }
      <div class="discover-pick-scrim" aria-hidden="true"></div>
      <div class="discover-pick-body">
        <p class="discover-pick-eyebrow">
          ${SPARK_ICON}<span>${escapeHtml(t(PICK_EYEBROW_KEY[mealSlot()]))}</span>
          ${
            hasChoice
              ? `<button type="button" class="discover-pick-next" aria-label="${escapeHtml(t("discover.pickNextAria"))}"><span>${escapeHtml(t("discover.pickNext"))}</span><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
              : ""
          }
        </p>
        <h3 class="discover-pick-name">${escapeHtml(recipe.name)}</h3>
        <p class="discover-pick-reason">${escapeHtml(fitReason(entry, discoverCtx))}</p>
        <p class="discover-pick-facts mono">${escapeHtml(
          t("discover.recipeMeta", { calories: Math.round(recipe.calories), minutes: recipe.prep_minutes }),
        )}</p>
        <div class="discover-pick-meters">
          <div class="discover-pick-meter">
            <div class="discover-pick-meter-head">
              <span>${escapeHtml(t("discover.macroCalories"))}</span>
              <span class="mono">${escapeHtml(
                t("discover.pickBudgetCalories", { used: Math.round(recipe.calories), left: Math.round(rem.calories) }),
              )}</span>
            </div>
            <div class="discover-pick-meter-track"><div class="discover-pick-meter-fill is-calories"></div></div>
          </div>
          <div class="discover-pick-meter">
            <div class="discover-pick-meter-head">
              <span>${escapeHtml(t("discover.macroProtein"))}</span>
              <span class="mono">${escapeHtml(
                t("discover.pickBudgetProtein", { used: Math.round(recipe.protein), left: Math.round(proteinLeft) }),
              )}</span>
            </div>
            <div class="discover-pick-meter-track"><div class="discover-pick-meter-fill is-protein"></div></div>
          </div>
        </div>
        <button type="button" class="btn btn-primary btn-block discover-pick-cta">${escapeHtml(t("discover.pickCta"))}</button>
      </div>
    </article>`;

  const img = host.querySelector("img.discover-pick-img");
  if (img) {
    img.addEventListener("load", () => img.classList.remove("discover-card-image-loading"), { once: true });
    img.addEventListener("error", () => (img.outerHTML = placeholder), { once: true });
  }
  // CSSOM writes, not an inline style attribute — CSP-safe, same pattern as
  // progress.js's macro-segment bars.
  host.querySelector(".discover-pick-meter-fill.is-calories").style.transform = `scaleX(${calRatio})`;
  host.querySelector(".discover-pick-meter-fill.is-protein").style.transform = `scaleX(${proRatio})`;
}

// ---------------------------------------------------------------------------
// "More that fit right now" — ranks 2..5 from the same engine as a
// horizontal rail (was renderRecommended). Each card's meta line is now its
// own fit reason instead of the generic "N kcal · N min".
// ---------------------------------------------------------------------------
let lastMoreKey = null;

async function renderMoreThatFit() {
  const container = el("discover-recommended");
  const strip = el("discover-recommended-strip");
  if (!discoverCtx.remaining || discoverCtx.remaining.calories <= 0) {
    container.hidden = true;
    lastMoreKey = null;
    return;
  }
  let recipes;
  try {
    recipes = await getBaselineRecipes();
  } catch {
    runOrDeferDuringSwipe(() => (container.hidden = true));
    return;
  }
  // Exclude whatever the hero is currently showing so the rail never repeats
  // it. renderTonightsPick() always runs immediately before this (see the
  // three call sites), so pickCandidates/pickCycleIndex are already current.
  const heroId = currentHeroId();
  const picks = rankRecipesByFit(recipes, discoverCtx)
    .filter((x) => x.recipe.id !== heroId)
    .slice(0, 4);
  if (!picks.length) {
    runOrDeferDuringSwipe(() => (container.hidden = true));
    lastMoreKey = null;
    return;
  }
  const key = picks.map((x) => x.recipe.id).join("|");
  if (key === lastMoreKey && !container.hidden && strip.children.length) return;
  lastMoreKey = key;
  runOrDeferDuringSwipe(() => {
    container.hidden = false;
    strip.replaceChildren(
      ...picks.map(({ recipe, fit }) =>
        buildCard({
          imageUrl: wikimediaThumb(recipe.image_url, CARD_IMAGE_WIDTH),
          icon: recipe.icon,
          name: recipe.name,
          meta: fitReason({ recipe, fit }, discoverCtx),
          badge: t("discover.kcalBadge", { calories: Math.round(recipe.calories) }),
          onClick: () => openRecipeDetail(recipe),
        }),
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Shared card builder — recipes/workout plans use a placeholder icon (no
// external photo source for hand-authored content); exercises/products use
// their real photo when the upstream API has one, falling back to the same
// placeholder treatment when it doesn't.
// ---------------------------------------------------------------------------
function placeholderHtml(iconKey) {
  return `<div class="discover-card-image-placeholder discover-icon-${ICON_COLOR[iconKey] || "protein"}">${ICONS[iconKey]}</div>`;
}

function buildCard({ imageUrl, icon, name, meta, tags, badge, onClick }) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "discover-card";
  const iconKey = icon && ICONS[icon] ? icon : DEFAULT_RECIPE_ICON;
  const imageHtml = imageUrl
    ? `<img class="discover-card-image discover-card-image-loading" src="${imageUrl}" alt="" loading="lazy" decoding="async" />`
    : placeholderHtml(iconKey);
  const tagsHtml = tags?.length
    ? `<div class="discover-card-tags">${tags
        .slice(0, 2)
        .map((tg) => `<span class="discover-card-tag">${escapeHtml(tagLabel(tg))}</span>`)
        .join("")}</div>`
    : "";
  // Tags render first (a category cue at a glance, magazine-cover style),
  // then the name, then the supporting meta line — see .discover-card-body's
  // own comment in style.css for why this whole block now overlays the
  // photo's bottom edge instead of sitting in a separate panel below it.
  const badgeHtml = badge ? `<span class="discover-card-badge">${escapeHtml(badge)}</span>` : "";
  card.innerHTML = `
    ${imageHtml}
    ${badgeHtml}
    <div class="discover-card-body">
      ${tagsHtml}
      <span class="discover-card-name">${escapeHtml(name)}</span>
      <span class="discover-card-meta">${escapeHtml(meta)}</span>
    </div>
  `;
  // A skeleton-shimmer background (discover-card-image-loading, CSS-only)
  // shows until the image actually paints, then fades in — smoother than
  // the previous abrupt pop-in against a flat placeholder color. A 404/
  // broken upstream photo (Wikimedia/wger URLs are hotlinked third-party
  // content this app doesn't control) swaps to the same icon-placeholder
  // treatment used for content with no photo at all, instead of the
  // browser's default broken-image glyph.
  const img = card.querySelector(".discover-card-image");
  if (img) {
    img.addEventListener("load", () => img.classList.remove("discover-card-image-loading"), { once: true });
    img.addEventListener(
      "error",
      () => {
        img.outerHTML = placeholderHtml(iconKey);
      },
      { once: true },
    );
  }
  card.addEventListener("click", onClick);
  return card;
}

// Tags/levels are stored as fixed English filter keys (see discover_data.py)
// so filtering logic never depends on the current UI language — only the
// *displayed* label is translated, via a lookup that falls back to the raw
// key for anything not in the dictionary (t() itself returns the key
// unchanged on a miss, so comparing against the key is how a miss is
// detected here).
function tagLabel(tagKey) {
  const translated = t(`discover.tag.${tagKey}`);
  return translated === `discover.tag.${tagKey}` ? tagKey : translated;
}
function levelLabel(levelKey) {
  const translated = t(`discover.level.${levelKey}`);
  return translated === `discover.level.${levelKey}` ? levelKey : translated;
}

function tagPill(tagText) {
  const span = document.createElement("span");
  span.className = "discover-card-tag";
  span.textContent = tagLabel(tagText);
  return span;
}

// Unlike tagPill above (backend-enum tags looked up via i18n.js's t()),
// muscle names come from wger's free-text `muscles` field, so they go
// through exerciseI18n.js's own local dictionary instead — see that
// module's docstring for why exercise names/categories are deliberately
// left untranslated (universal gym vocabulary) while muscle groups aren't.
function musclePill(muscleText) {
  const span = document.createElement("span");
  span.className = "discover-card-tag";
  span.textContent = translateMuscle(muscleText, getLanguage());
  return span;
}

// ---------------------------------------------------------------------------
// Language-aware fetch + local cache — every recipe/workout-plan request
// carries the current UI language (backend/routers/discover.py localizes
// server-side, see its module docstring), and the unfiltered baseline list
// per (type, language) is mirrored into IndexedDB (js/db.js) so reopening
// Discover — including offline or on a slow connection — can paint instantly
// from the last known copy while a fresh network fetch runs underneath.
// ---------------------------------------------------------------------------
async function fetchRecipes(params = {}, signal) {
  const language = getLanguage();
  const list = await api.getRecipes({ ...params, language }, { signal });
  if (!params.tag && !params.search) cacheDiscoverList("recipes", language, list);
  return list;
}

// ---------------------------------------------------------------------------
// In-memory dedupe for the unfiltered baseline recipe list specifically —
// separate from the IndexedDB cache above, which persists across sessions
// but still means a real network round-trip on first touch each session.
// renderTonightsPick()/renderMoreThatFit() (called from setDiscoverContext,
// which fires on every dashboard state change while Discover is open) and
// loadRecipes()'s own baseline path all want this exact same list; without
// this they'd each fire their own independent GET /discover/recipes. A
// single in-flight promise, keyed by language, means every caller within
// the same language session shares one real request.
// ---------------------------------------------------------------------------
let baselineRecipesLanguage = null;
let baselineRecipesPromise = null;

function getBaselineRecipes() {
  const language = getLanguage();
  if (language !== baselineRecipesLanguage) {
    baselineRecipesLanguage = language;
    baselineRecipesPromise = null;
  }
  if (!baselineRecipesPromise) {
    baselineRecipesPromise = fetchRecipes({}).catch((err) => {
      // Don't cache a failure — the next caller should get a fresh attempt.
      baselineRecipesPromise = null;
      throw err;
    });
  }
  return baselineRecipesPromise;
}

async function fetchWorkoutPlans(params = {}) {
  const language = getLanguage();
  const list = await api.getWorkoutPlans({ ...params, language });
  if (!params.level && !params.tag) cacheDiscoverList("workoutPlans", language, list);
  return list;
}

function renderRecipeGrid(recipes) {
  const grid = el("discover-recipes-grid");
  const empty = el("discover-recipes-empty");
  if (!recipes.length) {
    grid.replaceChildren();
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  grid.replaceChildren(
    ...recipes.map((r) =>
      buildCard({
        imageUrl: wikimediaThumb(r.image_url, CARD_IMAGE_WIDTH),
        icon: r.icon,
        name: r.name,
        meta: t("discover.recipeMeta", { calories: Math.round(r.calories), minutes: r.prep_minutes }),
        badge: t("discover.kcalBadge", { calories: Math.round(r.calories) }),
        tags: r.tags,
        onClick: () => openRecipeDetail(r),
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// M3 — "The Iron Log Table": editorial collections in place of filter chips.
// Membership is derived client-side from the catalogue's own fields (tags +
// a couple of computed predicates), so shelves need no backend change and
// render straight off the IndexedDB-cached list, offline included. The three
// recipe-panel views are: the shelves (default), one collection drilled
// into (a full grid), and a text search (also a full grid, backend-backed).
// ---------------------------------------------------------------------------
let activeCollectionId = null;
let lastShelvesKey = null;

const COLLECTIONS = [
  { id: "bunicas-kitchen", icon: "stew", match: (r) => r.tags.includes("romanian") },
  { id: "fast-protein", icon: "stirfry", match: (r) => r.prep_minutes <= 20 && r.protein >= 28 },
  { id: "cutting-board", icon: "salad", match: (r) => r.tags.includes("cut") || (r.calories <= 330 && r.protein >= 22) },
  { id: "big-plates", icon: "bowl", match: (r) => r.tags.includes("bulk") },
  { id: "no-cook", icon: "parfait", match: (r) => r.prep_minutes <= 8 },
  { id: "one-pan", icon: "curry", match: (r) => ["stew", "stirfry", "curry", "soup"].includes(r.icon) },
];
const MIN_SHELF_RECIPES = 3;
const SHELF_STRIP_MAX = 8;
const GOAL_LEAD_COLLECTION = { cut: "cutting-board", bulk: "big-plates", maintain: "bunicas-kitchen" };

const collectionTitle = (id) => t(`discover.collection.${id}.title`);
const collectionBlurb = (id) => t(`discover.collection.${id}.blurb`);

// The goal-matched shelf leads; the rest rotate by ISO week so the page
// reorders itself over time without any shelf ever disappearing.
function orderedCollections(goalType) {
  const leadId = GOAL_LEAD_COLLECTION[goalType] || GOAL_LEAD_COLLECTION.maintain;
  const lead = COLLECTIONS.filter((c) => c.id === leadId);
  const rest = COLLECTIONS.filter((c) => c.id !== leadId);
  const week = rest.length ? Math.floor(Date.now() / (7 * 864e5)) % rest.length : 0;
  return [...lead, ...rest.slice(week), ...rest.slice(0, week)];
}

function shelfCard(recipe) {
  return buildCard({
    imageUrl: wikimediaThumb(recipe.image_url, CARD_IMAGE_WIDTH),
    icon: recipe.icon,
    name: recipe.name,
    meta: t("discover.recipeMeta", { calories: Math.round(recipe.calories), minutes: recipe.prep_minutes }),
    badge: t("discover.kcalBadge", { calories: Math.round(recipe.calories) }),
    onClick: () => openRecipeDetail(recipe),
  });
}

async function renderShelves() {
  const host = el("discover-recipes-shelves");
  let recipes;
  try {
    recipes = await getBaselineRecipes();
  } catch {
    return; // no catalogue yet (offline first-run) — a later load fills it in
  }
  const goalType = discoverCtx.goalType || "maintain";
  const key = `${goalType}|${getLanguage()}|${Math.floor(Date.now() / 864e5 / 7)}`;
  if (key === lastShelvesKey && host.children.length) return;
  lastShelvesKey = key;

  const shelves = orderedCollections(goalType)
    .map((c) => ({ c, items: recipes.filter(c.match) }))
    .filter((s) => s.items.length >= MIN_SHELF_RECIPES);

  runOrDeferDuringSwipe(() => {
    host.replaceChildren(
      ...shelves.map(({ c, items }) => {
        const shelf = document.createElement("section");
        shelf.className = "discover-shelf";
        const head = document.createElement("button");
        head.type = "button";
        head.className = "discover-shelf-head";
        head.innerHTML = `
          <span class="discover-shelf-icon discover-icon-${ICON_COLOR[c.icon] || "protein"}">${ICONS[c.icon] || ICONS[DEFAULT_RECIPE_ICON]}</span>
          <span class="discover-shelf-text">
            <span class="discover-shelf-title">${escapeHtml(collectionTitle(c.id))}</span>
            <span class="discover-shelf-blurb">${escapeHtml(collectionBlurb(c.id))}</span>
          </span>
          <span class="discover-shelf-see">${escapeHtml(t("discover.collectionSeeAll", { count: items.length }))}<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
        head.addEventListener("click", () => openCollectionView(c.id));
        const strip = document.createElement("div");
        strip.className = "discover-shelf-strip";
        strip.append(...items.slice(0, SHELF_STRIP_MAX).map(shelfCard));
        shelf.append(head, strip);
        return shelf;
      }),
    );
  });
}

function showShelvesView() {
  activeCollectionId = null;
  el("discover-recipes-collection-bar").hidden = true;
  el("discover-recipes-grid").hidden = true;
  el("discover-recipes-empty").hidden = true;
  el("discover-recipes-shelves").hidden = false;
  renderShelves();
}

async function openCollectionView(id) {
  const collection = COLLECTIONS.find((c) => c.id === id);
  if (!collection) return;
  activeCollectionId = id;
  el("discover-recipes-search").value = "";
  el("discover-recipes-shelves").hidden = true;
  el("discover-recipes-collection-title").textContent = collectionTitle(id);
  el("discover-recipes-collection-bar").hidden = false;
  el("discover-recipes-grid").hidden = false;
  try {
    const recipes = await getBaselineRecipes();
    runOrDeferDuringSwipe(() => renderRecipeGrid(recipes.filter(collection.match)));
  } catch (err) {
    showToast(err.message || t("discover.loadFailed"), "error");
  }
}

function showSearchGridView() {
  activeCollectionId = null;
  el("discover-recipes-shelves").hidden = true;
  el("discover-recipes-collection-bar").hidden = true;
  el("discover-recipes-grid").hidden = false;
  loadRecipes();
}

// ---------------------------------------------------------------------------
// Recipes (search — the shelves above are the default browse surface)
// ---------------------------------------------------------------------------
let recipeSearchTimeout = null;
// Debounced the same way products/exercises search already are — an
// un-throttled per-keystroke fetch was enough on its own to trip the
// backend's 10-request/10-second burst limit during normal fast typing.
// Clearing the field drops straight back to the editorial shelves.
function onRecipeSearchInput() {
  clearTimeout(recipeSearchTimeout);
  recipeSearchTimeout = setTimeout(() => {
    if (el("discover-recipes-search").value.trim()) showSearchGridView();
    else showShelvesView();
  }, 300);
}

let recipesAbortController = null;

async function loadRecipes() {
  const search = el("discover-recipes-search").value.trim();
  const params = {};
  if (activeRecipeTag) params.tag = activeRecipeTag;
  if (search) params.search = search;

  // Cache-first instant paint, baseline (unfiltered) view only — a filtered
  // query always goes straight to the network below, same as any other
  // search box in this app. Both this and the network-resolved paint below
  // are past an `await`, so — unlike a plain synchronous call — nothing
  // guarantees either one lands before app.js's initTabSwipe has already
  // unhidden and started transforming this view mid-drag (see
  // runOrDeferDuringSwipe's own comment in ui.js); wrapping the actual DOM
  // mutation is what lets onDiscoverTabOpened() below be safely triggered
  // the instant a drag arms toward this tab instead of only once it commits.
  if (!activeRecipeTag && !search) {
    const cached = await getCachedDiscoverList("recipes", getLanguage());
    if (cached?.length) runOrDeferDuringSwipe(() => renderRecipeGrid(cached));
  }

  // Cancel a still-in-flight previous call so a slow response to an older
  // keystroke can't land after (and overwrite) a newer one's results. Not
  // applicable to the shared baseline request below — there's only ever one
  // "no tag, no search" query, so there's nothing for a newer one to race.
  recipesAbortController?.abort();
  recipesAbortController = new AbortController();
  try {
    const list = !activeRecipeTag && !search ? await getBaselineRecipes() : await fetchRecipes(params, recipesAbortController.signal);
    runOrDeferDuringSwipe(() => renderRecipeGrid(list));
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a newer search — not a real failure
    // A cached render above already gave the user something to look at —
    // only surface the error toast if this was a genuinely empty grid.
    if (!el("discover-recipes-grid").children.length) showToast(err.message || t("discover.loadFailed"), "error");
  }
}

// Recipes are one fixed nutritional total (not a per-ingredient breakdown
// like an AI scan/product result), so this mounts the same shared ingredient
// editor (js/ingredientsList.js, otherwise used for scan/barcode/manual
// entry) seeded with exactly one row — "the whole recipe as logged" — rather
// than a full multi-row editor. That single row's weight_g/calories/protein/
// carbs/fats stay fully editable (weight changes auto-rescale the rest, same
// convenience as everywhere else this editor is mounted), so "I ate more/less
// than a standard serving" is a real edit, not a fixed one-click log.
const recipePortionEditor = createIngredientsEditor({
  listEl: el("recipe-detail-portion-list"),
  totalsEl: el("recipe-detail-totals"),
});

function openRecipeDetail(recipe) {
  setDetailImage(el("recipe-detail-image"), el("recipe-detail-image-placeholder"), wikimediaThumb(recipe.image_url, DETAIL_IMAGE_WIDTH), recipe.icon);
  const taglineEl = el("recipe-detail-tagline");
  taglineEl.textContent = recipe.tagline || "";
  taglineEl.hidden = !recipe.tagline;
  el("recipe-detail-name").textContent = recipe.name;
  el("recipe-detail-tags").replaceChildren(...recipe.tags.map(tagPill));
  recipePortionEditor.setIngredients([asImplicitIngredient({ ...recipe, food_name: recipe.name })]);
  el("recipe-detail-ingredients").replaceChildren(
    ...recipe.ingredients.map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }),
  );
  el("recipe-detail-instructions").replaceChildren(
    ...recipe.instructions.map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }),
  );
  el("recipe-detail-log-btn").onclick = () => logRecipe(recipe);
  el("recipe-detail-cook-btn").onclick = () => openCookMode(recipe);
  openSheet("recipe-detail-sheet");
}

// A recipe's stored calories/protein/carbs/fats/fiber/weight_g are all for
// ONE standard serving (see backend/models.py's RecipeResult.weight_g
// comment) — this is the "what I'll log" portion at `servings` of them.
function scaleServing(recipe, servings) {
  return {
    weight_g: Math.round((recipe.weight_g || 0) * servings),
    calories: Math.round(recipe.calories * servings),
    protein: roundTo1(recipe.protein * servings),
    carbs: roundTo1(recipe.carbs * servings),
    fats: roundTo1(recipe.fats * servings),
    fiber: roundTo1((recipe.fiber || 0) * servings),
  };
}

// The one write path both the detail-sheet "Log this" and Cook Mode's
// finish screen funnel through (plus the "Your rotation" rail's 1-tap
// re-log): create a SavedMeal from the recipe (so it also lands in the
// user's favourites, same as before) then log it — tagged with the recipe
// id so it counts toward Discover activity — then let Ollie react and
// app.js refresh. Callers own their own button/loading state.
async function persistRecipeLog(recipe, portion) {
  const saved = await api.saveMeal({
    name: recipe.name,
    weight_g: portion.weight_g,
    calories: portion.calories,
    protein: portion.protein,
    carbs: portion.carbs,
    fats: portion.fats,
    fiber: portion.fiber,
  });
  await api.logSavedMeal(saved.id, recipe.id);
  // M7 — Ollie reacts to the cook with a one-shot, dish-specific line.
  // Deliberately reaction-only: pulseRecipe never touches hearts or the
  // adherence streak (that stays judged purely by real daily adherence,
  // server-side) — a Discover log earns a celebration, not a heart move.
  PetHud.pulseRecipe(recipe.name);
  await onDataChanged?.();
  // Refresh the "X of N cooked" counter + rotation rail off the new row, and
  // the weekly-challenge bar (this cook may have just advanced or completed
  // it — GET /discover/challenge recomputes progress live).
  renderActivity({ force: true });
  renderChallenge({ force: true });
}

// ---------------------------------------------------------------------------
// M6 — "Closing the loop" activity: the "X of N cooked" progress counter
// and the "Your rotation" 1-tap re-log rail, both fed by
// GET /discover/activity (a read-time rollup of daily_logs.discover_recipe_id
// over the retained window — see backend/services/discover_service.py, so
// "cooked" means "cooked recently", the same window cap streaks/trends
// already carry). Fetched once per Discover open and again right after a
// recipe log; cached in-session so a repeat open is cheap. Fully
// best-effort: any failure (offline, a backend without the migration yet)
// just leaves both surfaces hidden, never a toast — this is a progress
// ornament, not a core surface.
// ---------------------------------------------------------------------------
let activitySummary = null;
let activityInFlight = null;

async function renderActivity({ force = false } = {}) {
  if (force) activitySummary = null;
  if (!activitySummary && !activityInFlight) {
    activityInFlight = api
      .getDiscoverActivity()
      .then((data) => {
        activitySummary = data;
      })
      .catch(() => {
        /* leave whatever's already painted — no counter this time */
      })
      .finally(() => {
        activityInFlight = null;
      });
  }
  await activityInFlight;
  await paintActivity();
}

async function paintActivity() {
  const counterHost = el("discover-cooked");
  const rotationHost = el("discover-rotation");
  const summary = activitySummary;
  if (!summary) {
    counterHost.hidden = true;
    rotationHost.hidden = true;
    return;
  }

  // Counter — shown once at least one recipe has actually been cooked, so a
  // brand-new user never sees a slightly deflating "0 of 39".
  if (summary.cooked_count > 0 && summary.total_recipes > 0) {
    el("discover-cooked-count").textContent = t("discover.cookedCounter", {
      count: summary.cooked_count,
      total: summary.total_recipes,
    });
    el("discover-cooked-fill").style.transform = `scaleX(${clamp01(summary.cooked_count / summary.total_recipes)})`;
    counterHost.hidden = false;
  } else {
    counterHost.hidden = true;
  }

  // Rotation rail — only when there's a genuinely repeated recipe to
  // re-log, otherwise the whole section stays out of the way.
  const entries = summary.rotation || [];
  if (!entries.length) {
    rotationHost.hidden = true;
    return;
  }
  let recipes;
  try {
    recipes = await getBaselineRecipes();
  } catch {
    rotationHost.hidden = true;
    return;
  }
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const cards = entries
    .map((entry) => {
      const recipe = byId.get(entry.recipe_id);
      return recipe ? rotationCard(recipe, entry) : null;
    })
    .filter(Boolean);
  if (!cards.length) {
    rotationHost.hidden = true;
    return;
  }
  runOrDeferDuringSwipe(() => {
    rotationHost.hidden = false;
    el("discover-rotation-strip").replaceChildren(...cards);
  });
}

// A rotation card reuses the shared card look but its tap RE-LOGS the recipe
// (one standard serving) rather than opening the detail sheet — the whole
// point of the rail is friction-free re-logging of a meal you cook often.
function rotationCard(recipe, entry) {
  const card = buildCard({
    imageUrl: wikimediaThumb(recipe.image_url, CARD_IMAGE_WIDTH),
    icon: recipe.icon,
    name: recipe.name,
    meta: t("discover.rotationCookedTimes", { count: entry.times_cooked }),
    badge: t("discover.kcalBadge", { calories: Math.round(recipe.calories) }),
    onClick: () => relogRotationRecipe(recipe, card),
  });
  card.classList.add("discover-rotation-card");
  card.setAttribute("aria-label", t("discover.rotationRelogAria", { name: recipe.name }));
  return card;
}

async function relogRotationRecipe(recipe, card) {
  if (card.dataset.busy) return;
  card.dataset.busy = "1";
  card.classList.add("is-logging");
  try {
    // persistRecipeLog already fires Ollie's reaction, refreshes the
    // dashboard (onDataChanged) and re-renders this rail (renderActivity).
    await persistRecipeLog(recipe, scaleServing(recipe, 1));
    showToast(t("discover.rotationRelogged"), "success");
  } catch (err) {
    showToast(err.message || t("discover.recipeLogFailed"), "error");
  } finally {
    // The rail may have been rebuilt underneath us by renderActivity — a
    // no-op on a now-detached node, which is fine.
    card.classList.remove("is-logging");
    delete card.dataset.busy;
  }
}

// ---------------------------------------------------------------------------
// M8 — Weekly challenge ("The Payoff"). One rotating goal per ISO week
// (backend/data/discover_data.py's DISCOVER_CHALLENGES), scored live by
// GET /discover/challenge from this week's daily_logs. Completing it heals
// one Ollie heart + banks a badge — but that reward is applied SERVER-SIDE
// by the pet sweep (backend/services/pet_scheduler.py); this card is a
// read-only progress view and never touches hearts / the adherence streak
// itself. Fetched once per Discover open and again right after a recipe log;
// session-cached so a repeat open is cheap. Best-effort: any failure
// (offline, a backend without the migration) just leaves the card hidden,
// never a toast — it's a payoff ornament, not a core surface.
// ---------------------------------------------------------------------------
let challengeState = null;
let challengeInFlight = null;
let lastChallengePaintKey = null;

async function renderChallenge({ force = false } = {}) {
  if (force) {
    challengeState = null;
    lastChallengePaintKey = null;
  }
  if (!challengeState && !challengeInFlight) {
    challengeInFlight = api
      .getDiscoverChallenge()
      .then((data) => {
        challengeState = data;
      })
      .catch(() => {
        /* leave whatever's painted — no challenge card this time */
      })
      .finally(() => {
        challengeInFlight = null;
      });
  }
  await challengeInFlight;
  paintChallenge();
}

function paintChallenge() {
  const host = el("discover-challenge");
  const s = challengeState;
  if (!s) {
    host.hidden = true;
    return;
  }
  // Once the backend has stamped completed_at, honour that even if a later
  // live progress recompute reads lower (a Discover log deleted after the
  // fact) — the heal isn't clawed back, so the bar shouldn't half-empty.
  const done = s.completed ? s.target : Math.min(s.progress, s.target);
  const ratio = s.completed ? 1 : s.target > 0 ? clamp01(s.progress / s.target) : 0;
  const status = !s.completed
    ? ""
    : s.heart_awarded
      ? t("discover.challengeCompleteHealed")
      : t("discover.challengeCompletePending");
  // Anti-flash guard: skip a rebuild that would produce byte-identical
  // markup (an unrelated re-render / repeated tab open) so the fill's
  // grow-in transition never replays. Language is in the key because the
  // title/description come back already localized from the backend.
  const paintKey = [
    getLanguage(),
    s.challenge_key,
    s.progress,
    s.target,
    s.completed ? 1 : 0,
    s.heart_awarded ? 1 : 0,
    s.earned_badge_count,
  ].join("|");
  if (paintKey === lastChallengePaintKey && !host.hidden) return;
  lastChallengePaintKey = paintKey;

  const badges =
    s.earned_badge_count > 0
      ? `<span class="discover-challenge-badges">${escapeHtml(
          t("discover.challengeBadgeCount", { count: s.earned_badge_count }),
        )}</span>`
      : "";
  runOrDeferDuringSwipe(() => {
    host.hidden = false;
    host.innerHTML = `
      <div class="discover-challenge-card${s.completed ? " is-complete" : ""}">
        <div class="discover-challenge-head">
          <span class="discover-challenge-eyebrow">${TROPHY_ICON}<span>${escapeHtml(t("discover.challengeEyebrow"))}</span></span>
          ${badges}
        </div>
        <p class="discover-challenge-title">${escapeHtml(s.title)}</p>
        <p class="discover-challenge-desc">${escapeHtml(s.description)}</p>
        <div class="discover-challenge-track"><div class="discover-challenge-fill"></div></div>
        <div class="discover-challenge-foot">
          <span class="discover-challenge-progress mono">${escapeHtml(t("discover.challengeProgress", { done, target: s.target }))}</span>
          <span class="discover-challenge-status">${escapeHtml(status)}</span>
        </div>
      </div>`;
    if (s.earned_badge_count > 0) {
      host
        .querySelector(".discover-challenge-badges")
        ?.setAttribute("title", t("discover.challengeBadgeCountAria", { count: s.earned_badge_count }));
    }
    host.querySelector(".discover-challenge-fill").style.transform = `scaleX(${ratio})`;
  });
}

async function logRecipe(recipe) {
  const btn = el("recipe-detail-log-btn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("discover.loggingRecipe");
  try {
    await persistRecipeLog(recipe, recipePortionEditor.getAggregate());
    showToast(t("discover.recipeLogged"), "success");
    closeSheet("recipe-detail-sheet");
  } catch (err) {
    showToast(err.message || t("discover.recipeLogFailed"), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ===========================================================================
// M4 — Cook Mode: a full-screen, one-step-at-a-time cooking guide with a
// live portion scaler (rescales ingredient amounts + macro totals together)
// and per-step timers. 100% client-side; reuses the shared sheet infra
// (openSheet/closeSheet) for the scroll-lock + [data-close] plumbing.
// ===========================================================================
let cookRecipe = null;
// 0 = the ingredients/"get ready" panel, 1..N = instruction steps,
// N+1 = the finish/log panel.
let cookStep = 0;
let cookServings = 1;
const COOK_SERVING_OPTIONS = [0.5, 1, 2, 3, 4];
let cookWakeLock = null;
let cookTimer = null; // { remaining, total, id, done }

const COOK_CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const COOK_TIMER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="13" r="8" stroke="currentColor" stroke-width="1.7"/><path d="M12 9v4l2.5 2M9 2h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

const NICE_FRACTIONS = [
  [0.125, "⅛"],
  [0.25, "¼"],
  [1 / 3, "⅓"],
  [0.5, "½"],
  [2 / 3, "⅔"],
  [0.75, "¾"],
];

// Render a scaled quantity readably: whole-ish numbers as integers, small
// values as a unicode fraction where one lands close, otherwise ≤2 decimals
// with trailing zeros trimmed. Cooking amounts aren't lab-precise, so this
// leans toward "looks like a recipe" over exactness.
function formatAmount(value) {
  if (!isFinite(value) || value <= 0) return "0";
  const whole = Math.floor(value + 1e-9);
  const frac = value - whole;
  let fracGlyph = "";
  for (const [f, glyph] of NICE_FRACTIONS) {
    if (Math.abs(frac - f) < 0.06) {
      fracGlyph = glyph;
      break;
    }
  }
  if (fracGlyph) return whole > 0 ? `${whole}${fracGlyph}` : fracGlyph;
  if (value >= 10) return String(Math.round(value));
  const rounded = Math.round(value * 100) / 100;
  return String(rounded).replace(/\.?0+$/, "");
}

// Scale every standalone quantity in one ingredient line by `mult`.
// Handles integers, decimals, `a/b` fractions and `a-b` ranges; leaves
// non-quantity numbers (rare in ingredient lines) and unit words alone.
function scaleIngredientLine(line, mult) {
  if (mult === 1) return line;
  return line.replace(
    /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)/g,
    (match, fn, fd, r1, r2, n) => {
      if (fn !== undefined) return formatAmount((parseFloat(fn) / parseFloat(fd)) * mult);
      if (r1 !== undefined) return `${formatAmount(parseFloat(r1) * mult)}-${formatAmount(parseFloat(r2) * mult)}`;
      return formatAmount(parseFloat(n) * mult);
    },
  );
}

// Pull the first cook-time out of a step ("simmer 25 minutes",
// "3-4 minutes per side", "1.5-2 hours") → seconds, using the upper end of
// a range so nothing is under-cooked. Returns null when there's no usable
// duration or it's implausibly long/short for a kitchen timer.
function parseStepDuration(text) {
  const m = text.match(
    /(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/i,
  );
  if (!m) return null;
  const value = parseFloat(m[2] || m[1]);
  const unit = m[3].toLowerCase();
  const secs = unit.startsWith("h") ? value * 3600 : unit.startsWith("s") ? value : value * 60;
  if (secs < 30 || secs > 4 * 3600) return null;
  return Math.round(secs);
}

function cookMacroChips(p) {
  return `
    <div class="cook-macros">
      <span class="cook-macro cook-macro-cal">${p.calories}<small>${escapeHtml(t("discover.macroCalories"))}</small></span>
      <span class="cook-macro cook-macro-p">${formatAmount(p.protein)}g<small>${escapeHtml(t("discover.macroProtein"))}</small></span>
      <span class="cook-macro cook-macro-c">${formatAmount(p.carbs)}g<small>${escapeHtml(t("dashboard.macroAbbrCarbs"))}</small></span>
      <span class="cook-macro cook-macro-f">${formatAmount(p.fats)}g<small>${escapeHtml(t("dashboard.macroAbbrFats"))}</small></span>
    </div>`;
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

async function acquireCookWakeLock() {
  try {
    cookWakeLock = (await navigator.wakeLock?.request("screen")) || null;
  } catch {
    cookWakeLock = null; // denied / unsupported / low battery — never fatal
  }
}
function releaseCookWakeLock() {
  cookWakeLock?.release?.().catch(() => {});
  cookWakeLock = null;
}
// Registered once (initDiscover), not per open — screen wake locks are
// auto-dropped when the tab is hidden, so re-take it when the user comes
// back to a still-open Cook Mode. No-ops entirely when the sheet is closed.
function onCookVisibility() {
  if (document.visibilityState === "visible" && !el("cook-mode-sheet").hidden && !cookWakeLock) acquireCookWakeLock();
}

function stopCookTimer() {
  if (cookTimer?.id) clearInterval(cookTimer.id);
  cookTimer = null;
}

function openCookMode(recipe) {
  cookRecipe = recipe;
  cookStep = 0;
  cookServings = 1;
  stopCookTimer();
  closeSheet("recipe-detail-sheet");
  el("cook-mode-name").textContent = recipe.name;
  renderCookPanel();
  openSheet("cook-mode-sheet");
  acquireCookWakeLock();
}

function closeCookMode() {
  stopCookTimer();
  releaseCookWakeLock();
  closeSheet("cook-mode-sheet");
  cookRecipe = null;
}

function cookGoto(step) {
  const total = cookRecipe?.instructions.length || 0;
  cookStep = Math.max(0, Math.min(total + 1, step));
  stopCookTimer(); // a timer belongs to the step it was started on
  renderCookPanel();
  el("cook-mode-stage").scrollTop = 0;
}

function renderCookPanel() {
  const recipe = cookRecipe;
  if (!recipe) return;
  const stage = el("cook-mode-stage");
  const nav = el("cook-mode-nav");
  const total = recipe.instructions.length;
  const servingMult = cookServings; // recipe fields are per single serving
  const batchMult = recipe.servings ? cookServings / recipe.servings : cookServings;

  // progress: ingredients(0) → steps(1..total) → finish(total+1)
  el("cook-mode-bar").style.transform = `scaleX(${(cookStep / (total + 1)).toFixed(4)})`;
  el("cook-mode-progress").textContent =
    cookStep === 0
      ? t("discover.cookGetReady")
      : cookStep > total
        ? t("discover.cookFinishLabel")
        : t("discover.cookStepCounter", { current: cookStep, total });

  if (cookStep === 0) {
    const p = scaleServing(recipe, servingMult);
    stage.innerHTML = `
      <div class="cook-panel">
        <p class="cook-kicker">${escapeHtml(t("discover.cookGetReady"))}</p>
        <div class="cook-portion">
          <span class="cook-portion-label">${escapeHtml(t("discover.cookYourPortion"))}</span>
          <div class="cook-portion-opts" role="group">
            ${COOK_SERVING_OPTIONS.map(
              (v) =>
                `<button type="button" class="cook-portion-opt${v === cookServings ? " is-active" : ""}" data-servings="${v}">${v === 0.5 ? "½" : v}</button>`,
            ).join("")}
          </div>
        </div>
        ${cookMacroChips(p)}
        <p class="cook-amounts-note">${escapeHtml(t("discover.cookAmountsFor"))}</p>
        <ul class="cook-ingredients">
          ${recipe.ingredients
            .map((line) => `<li>${escapeHtml(scaleIngredientLine(line, batchMult))}</li>`)
            .join("")}
        </ul>
      </div>`;
    nav.hidden = false;
    el("cook-mode-prev").hidden = true;
    el("cook-mode-next").textContent = t("discover.cookStart");
    return;
  }

  if (cookStep > total) {
    const p = scaleServing(recipe, servingMult);
    stage.innerHTML = `
      <div class="cook-panel cook-finish">
        <span class="cook-finish-icon">${COOK_CHECK_ICON}</span>
        <p class="cook-finish-title">${escapeHtml(t("discover.cookDoneTitle"))}</p>
        <p class="cook-finish-sub">${escapeHtml(t("discover.cookDoneSub"))}</p>
        ${cookMacroChips(p)}
        <button type="button" class="btn btn-primary btn-block cook-log-btn" id="cook-mode-log">${escapeHtml(
          t("discover.cookLogBtn", { servings: formatAmount(cookServings) }),
        )}</button>
        <button type="button" class="btn btn-ghost-sm cook-finish-close">${escapeHtml(t("common.close"))}</button>
      </div>`;
    nav.hidden = true;
    el("cook-mode-stage").querySelector(".cook-finish-close").onclick = closeCookMode;
    el("cook-mode-log").onclick = logCookedRecipe;
    return;
  }

  // An instruction step
  const text = recipe.instructions[cookStep - 1];
  const duration = parseStepDuration(text);
  stage.innerHTML = `
    <div class="cook-panel cook-step">
      <span class="cook-step-num mono">${cookStep}</span>
      <p class="cook-step-text">${escapeHtml(text)}</p>
      ${
        duration
          ? `<div class="cook-timer" id="cook-timer">
               <button type="button" class="cook-timer-btn" id="cook-timer-btn">${COOK_TIMER_ICON}<span id="cook-timer-label">${escapeHtml(
                 t("discover.cookStartTimer", { time: formatClock(duration) }),
               )}</span></button>
             </div>`
          : ""
      }
    </div>`;
  if (duration) el("cook-timer-btn").onclick = () => toggleCookTimer(duration);
  nav.hidden = false;
  el("cook-mode-prev").hidden = false;
  el("cook-mode-prev").textContent = t("discover.cookBack");
  el("cook-mode-next").textContent = cookStep === total ? t("discover.cookFinish") : t("discover.cookNext");
}

// One timer per step (see cookGoto's stopCookTimer). Cycles:
// idle → running → paused → running … and, once it fires, done → restart.
function toggleCookTimer(durationSeconds) {
  const label = el("cook-timer-label");
  const wrap = el("cook-timer");

  // Running → pause.
  if (cookTimer && cookTimer.id && !cookTimer.done) {
    clearInterval(cookTimer.id);
    cookTimer.id = null;
    wrap.classList.remove("is-running");
    label.textContent = t("discover.cookResumeTimer", { time: formatClock(cookTimer.remaining) });
    return;
  }

  // Start fresh, resume from a pause, or restart after it finished.
  const remaining = cookTimer && !cookTimer.done && cookTimer.remaining > 0 ? cookTimer.remaining : durationSeconds;
  cookTimer = { remaining, total: durationSeconds, id: null, done: false };
  wrap.classList.remove("is-done");
  wrap.classList.add("is-running");
  label.textContent = formatClock(remaining);
  cookTimer.id = setInterval(() => {
    cookTimer.remaining -= 1;
    if (cookTimer.remaining <= 0) {
      clearInterval(cookTimer.id);
      cookTimer = { ...cookTimer, id: null, remaining: 0, done: true };
      wrap.classList.remove("is-running");
      wrap.classList.add("is-done");
      label.textContent = t("discover.cookTimerDone");
      try {
        navigator.vibrate?.([200, 100, 200, 100, 200]);
      } catch {
        /* no haptics API — the visual state change is enough */
      }
      return;
    }
    label.textContent = formatClock(cookTimer.remaining);
  }, 1000);
}

async function logCookedRecipe() {
  const btn = el("cook-mode-log");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("discover.loggingRecipe");
  try {
    await persistRecipeLog(cookRecipe, scaleServing(cookRecipe, cookServings));
    showToast(t("discover.recipeLogged"), "success");
    closeCookMode();
  } catch (err) {
    showToast(err.message || t("discover.recipeLogFailed"), "error");
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------------------------------------------------------------------------
// Workout plans (curated, static) + exercise library (live wger.de search)
// ---------------------------------------------------------------------------
function renderPlanGrid(plans) {
  el("discover-plans-grid").replaceChildren(
    ...plans.map((p) =>
      buildCard({
        imageUrl: wikimediaThumb(p.image_url, CARD_IMAGE_WIDTH),
        icon: p.icon,
        name: p.name,
        meta: t("discover.planMeta", { days: p.days.length, level: levelLabel(p.level) }),
        tags: p.tags,
        onClick: () => openWorkoutPlanDetail(p),
      }),
    ),
  );
}

async function loadWorkoutPlans() {
  if (!activePlanTag) {
    const cached = await getCachedDiscoverList("workoutPlans", getLanguage());
    if (cached?.length) renderPlanGrid(cached);
  }
  try {
    renderPlanGrid(await fetchWorkoutPlans(activePlanTag ? { tag: activePlanTag } : {}));
  } catch (err) {
    if (!el("discover-plans-grid").children.length) showToast(err.message || t("discover.loadFailed"), "error");
  }
}

// A plan's reps scheme is a display string ("8-10", "AMRAP", "30-45s") — the
// actual workout-log form's reps field is a plain single-number input, so
// this pulls out a sensible starting number (the low end of a range) to
// prefill with rather than leaving it unparsed; schemes with no number at
// all (e.g. "AMRAP") just leave the field blank for the user to fill in.
function firstNumberFrom(text) {
  const match = String(text).match(/\d+/);
  return match ? Number(match[0]) : "";
}

let currentPlanExercises = [];

function openWorkoutPlanDetail(plan) {
  setDetailImage(el("workout-plan-detail-image"), el("workout-plan-detail-image-placeholder"), wikimediaThumb(plan.image_url, DETAIL_IMAGE_WIDTH), plan.icon);
  el("workout-plan-detail-name").textContent = plan.name;
  el("workout-plan-detail-tags").replaceChildren(...plan.tags.map(tagPill));
  currentPlanExercises = plan.days.flatMap((day) => day.exercises);
  el("workout-plan-detail-days").innerHTML = plan.days
    .map(
      (day) => `
      <div class="discover-plan-day">
        <div class="discover-plan-day-label">${escapeHtml(day.label)}</div>
        ${day.exercises
          .map(
            (ex, idx) => `
          <div class="discover-plan-exercise-row">
            <div class="discover-plan-exercise-row-main">
              <span class="discover-plan-exercise-name">${escapeHtml(ex.name)}</span>
              <span class="discover-plan-exercise-scheme">${ex.sets} &times; ${escapeHtml(ex.reps)}</span>
              <button type="button" class="discover-plan-exercise-log-btn" data-plan-exercise="${currentPlanExercises.indexOf(ex)}" aria-label="${t("discover.logExerciseAriaLabel", { name: ex.name })}">
                <svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
              </button>
            </div>
            ${ex.description ? `<p class="discover-plan-exercise-howto">${escapeHtml(ex.description)}</p>` : ""}
          </div>
        `,
          )
          .join("")}
      </div>
    `,
    )
    .join("");
  openSheet("workout-plan-detail-sheet");
}

let exerciseSearchTimeout = null;

function scheduleExerciseSearch() {
  clearTimeout(exerciseSearchTimeout);
  exerciseSearchTimeout = setTimeout(loadExercises, 350);
}

let exercisesAbortController = null;

async function loadExercises() {
  const grid = el("discover-exercises-grid");
  const empty = el("discover-exercises-empty");
  const q = el("discover-exercises-search").value.trim();
  exercisesAbortController?.abort();
  exercisesAbortController = new AbortController();
  try {
    const exercises = await api.searchExercises(q ? { q } : {}, { signal: exercisesAbortController.signal });
    if (!exercises.length) {
      grid.replaceChildren();
      empty.hidden = false;
      empty.querySelector("span:last-child").textContent = q ? t("discover.exercisesNoResults") : t("discover.exercisesEmpty");
      return;
    }
    empty.hidden = true;
    grid.replaceChildren(
      ...exercises.map((ex) =>
        buildCard({
          imageUrl: wikimediaThumb(ex.image_url, CARD_IMAGE_WIDTH),
          icon: DEFAULT_PLAN_ICON,
          name: ex.name,
          meta: ex.category,
          onClick: () => openExerciseDetail(ex),
        }),
      ),
    );
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a newer search
    showToast(err.message || t("discover.loadFailed"), "error");
  }
}

function openExerciseDetail(exercise) {
  setDetailImage(el("exercise-detail-image"), el("exercise-detail-image-placeholder"), wikimediaThumb(exercise.image_url, DETAIL_IMAGE_WIDTH), DEFAULT_PLAN_ICON);
  el("exercise-detail-name").textContent = exercise.name;
  el("exercise-detail-category").textContent = exercise.category;
  el("exercise-detail-muscles").replaceChildren(...exercise.muscles.map(musclePill));
  el("exercise-detail-equipment").replaceChildren(...exercise.equipment.map(tagPill));
  const descriptionEl = el("exercise-detail-description");
  descriptionEl.textContent = exercise.description || "";
  descriptionEl.hidden = !exercise.description;
  el("exercise-detail-attribution").textContent = exercise.license_author
    ? t("discover.exerciseAttribution", { author: exercise.license_author })
    : "";
  el("exercise-detail-log-btn").onclick = () => {
    closeSheet("exercise-detail-sheet");
    openWorkoutDiary(exercise.name, null, exercise.category || null);
  };
  openSheet("exercise-detail-sheet");
}

// ---------------------------------------------------------------------------
// Products (live Open Food Facts search) — tapping a result reuses the
// existing scan-result-review form (scan.js's openProductResult) instead of
// a separate confirm UI, since this is already-verified label data exactly
// like a barcode scan.
// ---------------------------------------------------------------------------
let productSearchTimeout = null;

function scheduleProductSearch() {
  clearTimeout(productSearchTimeout);
  productSearchTimeout = setTimeout(loadProducts, 400);
}

let productsAbortController = null;

async function loadProducts() {
  const grid = el("discover-products-grid");
  const empty = el("discover-products-empty");
  const loading = el("discover-products-loading");
  const q = el("discover-products-search").value.trim();
  const country = el("discover-products-country").value;
  productsAbortController?.abort();
  if (!q) {
    loading.hidden = true;
    grid.replaceChildren();
    empty.hidden = false;
    empty.querySelector("span:last-child").textContent = t("discover.productsEmpty");
    return;
  }
  productsAbortController = new AbortController();
  // A live external search (Open Food Facts) can take a moment to answer —
  // recipes/exercises paint instantly from cache/local data, products has
  // nothing to show until the network responds, so this fills that gap
  // instead of the grid just looking frozen between the debounce firing and
  // the response landing.
  empty.hidden = true;
  loading.hidden = false;
  try {
    const products = await api.searchProducts(
      { q, language: getLanguage(), ...(country ? { country } : {}) },
      { signal: productsAbortController.signal },
    );
    loading.hidden = true;
    if (!products.length) {
      grid.replaceChildren();
      empty.hidden = false;
      empty.querySelector("span:last-child").textContent = t("discover.productsNoResults");
      return;
    }
    grid.replaceChildren(
      ...products.map((p) =>
        buildCard({
          imageUrl: p.image_url,
          icon: DEFAULT_RECIPE_ICON,
          name: p.food_name,
          meta: p.brand ? `${p.brand} · ${Math.round(p.calories)} kcal/100g` : `${Math.round(p.calories)} kcal/100g`,
          onClick: () => openProductResult(p),
        }),
      ),
    );
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a newer search — loading state left for the newer call to resolve
    loading.hidden = true;
    showToast(err.message || t("discover.loadFailed"), "error");
  }
}

// ---------------------------------------------------------------------------
// Eager media pre-fetch — see sw.js's "ironlog:warm-media-cache" message
// handler for the actual fetch/cache/evict logic (kept in one place, not
// duplicated here). This function's only job is deciding *which* photos are
// worth warming proactively: the curated POPULAR_EXERCISES thumbnails (an
// empty-query call to /discover/exercises/search returns exactly that list —
// see backend/routers/discover.py's own docstring), so a gym-basement/
// low-signal offline visit to Discover's exercise tab never opens onto a
// wall of blank cards, even on the very first time that tab is ever opened.
// Recipe/workout-plan photos are deliberately left to the "lazy" half of the
// strategy (the service worker's fetch-interception caches those the first
// time they're actually viewed online) rather than eagerly warmed here too —
// there's no equivalent "this is the default view" list for those the way
// POPULAR_EXERCISES is one for exercises.
//
// Fire-and-forget and fully best-effort: no loading state, no error surfaced
// to the user, and it's safe to call every app boot — an already-warm URL is
// a cheap cache.match() no-op on the service worker side, not a re-fetch.
// ---------------------------------------------------------------------------
async function warmDiscoverMediaCache() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.ready;
    const controller = navigator.serviceWorker.controller;
    if (!controller) return; // no SW controlling this page yet (e.g. very first load pre-reload) — next boot will catch it
    const exercises = await api.searchExercises({});
    // The card-thumbnail variant specifically (same wikimediaThumb transform
    // loadExercises applies before setting an <img src>) — warming the raw,
    // untransformed image_url instead would cache a URL the grid never
    // actually requests, missing the point of pre-warming.
    const urls = exercises.map((ex) => wikimediaThumb(ex.image_url, CARD_IMAGE_WIDTH)).filter(Boolean);
    if (urls.length) controller.postMessage({ type: "ironlog:warm-media-cache", urls });
  } catch {
    // Network unavailable, SW unsupported/failed, etc. — never block or
    // surface an error for what's purely a background enhancement.
  }
}

// ---------------------------------------------------------------------------
export function initDiscover({ onDataChanged: onChanged } = {}) {
  onDataChanged = onChanged;
  warmDiscoverMediaCache();

  wirePillTabs("discover-type-tabs", (type) => {
    currentTab = type;
    ["recipes", "workouts", "products"].forEach((t) => (el(`discover-panel-${t}`).hidden = t !== type));
    if (type === "recipes" && !el("discover-recipes-shelves").children.length) renderShelves();
    if (type === "workouts" && !el("discover-plans-grid").children.length) {
      loadWorkoutPlans();
      loadExercises();
    }
  });

  el("discover-recipes-search").addEventListener("input", onRecipeSearchInput);
  // The collection drill-in header doubles as a "back to all collections"
  // control (a left chevron + the collection's name).
  el("discover-recipes-collection-bar").addEventListener("click", showShelvesView);

  el("discover-plans-goal-filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".discover-chip");
    if (!chip) return;
    const tag = chip.dataset.tag;
    activePlanTag = activePlanTag === tag ? null : tag;
    el("discover-plans-goal-filters")
      .querySelectorAll(".discover-chip")
      .forEach((c) => c.classList.toggle("active", c.dataset.tag === activePlanTag));
    loadWorkoutPlans();
  });

  el("discover-exercises-search").addEventListener("input", scheduleExerciseSearch);
  el("discover-products-search").addEventListener("input", scheduleProductSearch);
  el("discover-products-country").addEventListener("change", loadProducts);

  // "Tonight's Pick" hero: the card (or its CTA) opens the recipe detail;
  // the chevron advances to the next-ranked candidate with no reload.
  el("discover-pick").addEventListener("click", (e) => {
    if (e.target.closest(".discover-pick-next")) {
      if (pickCandidates.length > 1) {
        pickCycleIndex = (pickCycleIndex + 1) % pickCandidates.length;
        renderTonightsPick();
        renderMoreThatFit();
      }
      return;
    }
    if (e.target.closest(".discover-pick-card")) {
      const entry = pickCandidates[pickCycleIndex % Math.max(pickCandidates.length, 1)];
      if (entry) openRecipeDetail(entry.recipe);
    }
  });

  // Cook Mode (M4) — the sheet markup is static in index.html; wire its
  // chrome once here.
  el("cook-mode-close").addEventListener("click", closeCookMode);
  // #cook-mode-sheet carries .sheet-overlay, so app.js's generic
  // backdrop-click handler would hide it through closeSheet() alone — which
  // skips closeCookMode()'s teardown and leaks the screen wake lock + the
  // running step timer. A backdrop tap only lands on the overlay itself in
  // the scrim strip above the 100dvh sheet (visible while the mobile URL
  // bar is up); route that through the real close path too.
  el("cook-mode-sheet").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeCookMode();
  });
  el("cook-mode-prev").addEventListener("click", () => cookGoto(cookStep - 1));
  el("cook-mode-next").addEventListener("click", () => cookGoto(cookStep + 1));
  el("cook-mode-stage").addEventListener("click", (e) => {
    const opt = e.target.closest(".cook-portion-opt");
    if (!opt) return;
    cookServings = Number(opt.dataset.servings) || 1;
    renderCookPanel();
  });
  document.addEventListener("visibilitychange", onCookVisibility);

  el("workout-plan-detail-days").addEventListener("click", (e) => {
    const btn = e.target.closest(".discover-plan-exercise-log-btn");
    if (!btn) return;
    const ex = currentPlanExercises[Number(btn.dataset.planExercise)];
    if (!ex) return;
    closeSheet("workout-plan-detail-sheet");
    // Only reps carries over as a prefill — the new Workout Diary logs one
    // set at a time (see js/workoutDiary.js), so a plan's prescribed set
    // COUNT no longer maps onto a single field the way the old bulk
    // sets/reps entry sheet did; the user just taps "+ Add set" that many
    // times, same starting point as before, one tap per set instead of one
    // typed number.
    openWorkoutDiary(ex.name, firstNumberFrom(ex.reps), null);
  });

  // Recipes/plans are localized server-side (see fetchRecipes/
  // fetchWorkoutPlans) — a language switch means whatever's already
  // rendered is now in the wrong language, so force a re-fetch rather than
  // relying on the usual "only load if empty" lazy-load check. Exercise
  // names are never translated (universal gym vocabulary), so that panel is
  // left alone here. Product *results* aren't translated either, but the
  // `language` param now also steers which OFF fields get searched (see
  // loadProducts/search_products's `langs` param) — a stale active query
  // should re-run against the newly-active language too, not just redraw.
  onLanguageChange(() => {
    // Hero, rail and shelves all carry server-localized names / translated
    // copy — clear their anti-flash guards so a language switch repaints.
    lastPickPaintKey = lastRankingKey = lastMoreKey = lastShelvesKey = null;
    if (!el("discover-pick").hidden) renderTonightsPick();
    if (!el("discover-recommended").hidden) renderMoreThatFit();
    // Repaint the cooked counter / rotation rail against the cached summary
    // — the counter copy and each rotation card's text run through t().
    if (!el("discover-panel-recipes").hidden) paintActivity();
    // The challenge title/description are localized server-side, so a
    // language switch needs a real refetch, not just a repaint.
    if (!el("discover-challenge").hidden) renderChallenge({ force: true });
    if (!el("discover-recipes-shelves").hidden) renderShelves();
    else if (activeCollectionId) openCollectionView(activeCollectionId);
    else if (el("discover-recipes-search").value.trim()) loadRecipes();
    if (el("discover-plans-grid").children.length) loadWorkoutPlans();
    if (el("discover-products-search").value.trim()) loadProducts();
    if (cookRecipe && !el("cook-mode-sheet").hidden) renderCookPanel();
  });

  // First real load happens when the Discover tab is actually opened (see
  // app.js's switchView), not here at boot — same lazy-load-on-first-visit
  // convention progress.js's data already follows, most sessions may never
  // open this tab at all.
}

export function onDiscoverTabOpened() {
  // Restore whichever recipe view was last active (shelves / a collection /
  // a search); renderShelves() has its own key-guard so a repeat open is
  // cheap and never re-flashes.
  if (activeCollectionId) openCollectionView(activeCollectionId);
  else if (el("discover-recipes-search").value.trim()) showSearchGridView();
  else showShelvesView();
  renderTonightsPick();
  renderMoreThatFit();
  // "X of N cooked" + "Your rotation" — session-cached, so this repaints
  // instantly on a repeat open and only hits the network the first time.
  renderActivity();
  // The weekly challenge bar ("The Payoff") — same session-cache pattern.
  renderChallenge();
}
