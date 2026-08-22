// Smart food suggestions — a zero-cost, client-side "what should I log
// next" card for the Saved Meals view's Intelligent Suggestions panel, in
// the same spirit as aiCoach.js's preset insights: deterministic math
// against data already in memory, no Gemini call, works fully offline.
// Ranks the user's own saved meals (never an external food database this
// app doesn't have) against how much of today's remaining calorie/protein/
// carb/fat budget each one covers. Strictly food/nutrition — a workout
// suggestion half used to live here too but was removed: this panel sits
// inside Saved Meals, which is scoped to food/nutrition, and a workout
// nudge didn't belong next to it (training suggestions live in the Progress
// tab's own Workout Diary instead).
//
// Reactivity model: fresh state (remaining budget, saved meals) is pushed
// in via setSuggestionsContext() every time app.js's central
// render() runs — the same "off-screen context is always current" pattern
// aiCoach.js/discover.js/mealSuggester.js already use for their own
// setContext-style entry points (see app.js's render()). This module used to
// only recompute when progress.js's own network-driven renderProgress() ran
// (i.e. only on a Progress-tab visit), with "remaining" sourced from
// GET /trends — a separate network round trip that lagged behind the
// already-live, already-optimistic state.logs every other surface in this
// app reacts to instantly. That mismatch was the root cause of the card
// going stale after logging a suggested item from right here (nothing ever
// told it the log happened), showing suggestions computed against an
// out-of-date remaining budget, and popping in a beat late after switching
// tabs. Sourcing purely from already-live state removes the whole class of
// staleness instead of patching individual symptoms.
import { animateItemRemoval, escapeHtml, reconcileList, vibrate } from "./ui.js?v=20260822m";
import { onLanguageChange, t } from "./i18n.js?v=20260822m";

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Food suggestions
// ---------------------------------------------------------------------------

// A candidate can run up to 20% over what's left today before it's excluded
// outright — a small overshoot is a normal, acceptable "close enough"
// suggestion; anything further would mislead someone trying to stay in
// budget. Below MEANINGFUL_PROTEIN_GAP_G, remaining protein is treated as
// already met (not worth optimizing a suggestion around a few leftover
// grams) and ranking falls back to "biggest remaining-budget usage" instead.
const CALORIE_OVER_BUDGET_RATIO = 1.2;
const MEANINGFUL_PROTEIN_GAP_G = 5;
const FOOD_SUGGESTIONS_LIMIT = 3;

// `remaining` = { calories, protein, carbs, fats } — today's target minus
// today's logged total for each, the exact shape app.js's render() already
// builds for setDiscoverContext (see that call site) and now pushes here too
// via setSuggestionsContext.
//
// Three different reasons can leave this empty, and they mean very different
// things to the user — collapsing them into one generic message is what
// used to read as a flatly wrong "you haven't eaten today" state even when
// the real reason was "you're already at budget, nice work" or "none of
// your saved meals happen to fit." `emptyReason` lets the render step pick
// the message that actually matches what happened.
export function computeFoodSuggestions(remaining, savedMeals, limit = FOOD_SUGGESTIONS_LIMIT) {
  if (!savedMeals?.length) return { items: [], emptyReason: "noSavedMeals" };
  if (!remaining || remaining.calories <= 0) return { items: [], emptyReason: "budgetSpent" };

  const proteinRemaining = Math.max(remaining.protein, 0);
  const proteinIsGap = proteinRemaining > MEANINGFUL_PROTEIN_GAP_G;

  const items = savedMeals
    .filter((meal) => meal.calories > 0 && meal.calories <= remaining.calories * CALORIE_OVER_BUDGET_RATIO)
    .map((meal) => {
      const fitsCarbs = remaining.carbs > 0 ? meal.carbs <= remaining.carbs : meal.carbs <= 0;
      const fitsFats = remaining.fats > 0 ? meal.fats <= remaining.fats : meal.fats <= 0;
      return { meal, fitsBudget: fitsCarbs && fitsFats };
    })
    .sort((a, b) => {
      // Fitting the carb/fat budget outranks everything else — a
      // high-protein option that blows the fat budget isn't actually a good
      // suggestion, just a protein-heavy one.
      if (a.fitsBudget !== b.fitsBudget) return a.fitsBudget ? -1 : 1;
      return proteinIsGap ? b.meal.protein - a.meal.protein : b.meal.calories - a.meal.calories;
    })
    .slice(0, limit)
    .map(({ meal }) => ({
      meal,
      reason:
        proteinIsGap && meal.protein > 0
          ? { key: "suggestions.reasonProtein", vars: { grams: Math.round(Math.min(meal.protein, proteinRemaining)) } }
          : { key: "suggestions.reasonFits", vars: { calories: Math.round(meal.calories) } },
    }));

  return { items, emptyReason: items.length ? null : "nothingFits" };
}

const FOOD_EMPTY_MESSAGE_KEYS = {
  noSavedMeals: "suggestions.foodEmpty",
  budgetSpent: "suggestions.foodEmptyBudgetSpent",
  nothingFits: "suggestions.foodEmptyNothingFits",
};

function renderFoodSuggestions({ items, emptyReason }, remaining) {
  const list = el("suggestions-food-list");
  const empty = el("suggestions-food-empty");
  const stat = el("suggestions-remaining-stat");

  // "Why am I seeing these?" answered directly, at a glance — the remaining
  // budget driving every ranking below, not just implied by the results.
  // Hidden once today's calories are already spent (emptyReason "budgetSpent"
  // already says that explicitly) so it never states a number that reads as
  // contradicting its own empty-state message right below it.
  if (remaining && remaining.calories > 0) {
    stat.textContent = t("suggestions.foodRemainingStat", { calories: Math.round(remaining.calories) });
    stat.hidden = false;
  } else {
    stat.hidden = true;
  }

  if (!items.length) {
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    el("suggestions-food-empty-text").textContent = t(FOOD_EMPTY_MESSAGE_KEYS[emptyReason] || "suggestions.foodEmpty");
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const pAbbr = t("dashboard.macroAbbrProtein");
  const cAbbr = t("dashboard.macroAbbrCarbs");
  const fAbbr = t("dashboard.macroAbbrFats");

  reconcileList(list, items, {
    getId: (item) => item.meal.id,
    // The bookmark badge (not the app's sparkle/AI glyph — see index.html's
    // comment on this section) marks every card here as "one of your own
    // saved meals," same icon meaning as the favorite button and the
    // Journal's own saved_meal badge (ui.js).
    buildHtml: ({ meal, reason }) => `
      <div class="log-item-icon history-item-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M6 4h12v16l-6-4-6 4V4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(meal.name)}</div>
        <div class="log-item-meta">${pAbbr}${Math.round(meal.protein)} ${cAbbr}${Math.round(meal.carbs)} ${fAbbr}${Math.round(meal.fats)} &middot; ${escapeHtml(t(reason.key, reason.vars))}</div>
      </div>
      <div class="log-item-cal">${Math.round(meal.calories)}</div>
      <div class="log-item-actions">
        <button class="saved-log-icon-btn" data-action="log-suggested-food" aria-label="${escapeHtml(t("suggestions.logFoodBtn", { name: meal.name }))}"><svg viewBox="0 0 24 24" fill="none"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
      </div>
    `,
  });
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

// Last-known values, kept purely so onLanguageChange below can re-render
// with whatever's already current without needing a caller to re-push data
// it hasn't actually changed.
let lastRemaining = null;
let lastSavedMeals = [];

// The food half's real reactive entry point — call with either or both
// fields whenever they change (a caller that only knows one changed can omit
// the other; the last-known value for it is kept). app.js's render() calls
// this with both on every single state mutation (the same "off-screen
// context is always current" pattern as setDiscoverContext/setContext in
// aiCoach.js and mealSuggester.js), and the handful of saved-meal
// add/edit/delete paths that bypass render() call it with just
// { savedMeals } — see those call sites' own comments for why they need it
// too. Cheap and synchronous (pure math + a small reconcileList diff, no
// network), so it's safe to call unconditionally on every relevant change
// regardless of whether the Progress tab is even visible right now — that's
// what makes switching to it never show a stale card popping in a beat
// later.
export function setSuggestionsContext({ remaining, savedMeals } = {}) {
  if (remaining !== undefined) lastRemaining = remaining;
  if (savedMeals !== undefined) lastSavedMeals = savedMeals;
  renderFoodSuggestions(computeFoodSuggestions(lastRemaining, lastSavedMeals), lastRemaining);
}

// Every module that renders user-facing text re-renders its own dynamic bits
// on a language change (see CLAUDE.md's i18n section) — this one used to get
// that for free as a side effect of progress.js's renderFromCache also
// running on language change, but that coupling is exactly what's being
// removed above, so it needs its own hook now.
onLanguageChange(() => {
  renderFoodSuggestions(computeFoodSuggestions(lastRemaining, lastSavedMeals), lastRemaining);
});

// `onLogFood(mealId)` is owned by the caller that actually knows how to
// perform the action (app.js's optimistic saved-meal logger) — this module
// only ever ranks/paints, never mutates state itself, same separation
// ui.js's other list components already use.
export function initSuggestions({ onLogFood }) {
  el("suggestions-food-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action='log-suggested-food']");
    if (!btn) return;
    const id = btn.closest(".log-item")?.dataset.id;
    if (!id) return;
    vibrate(12);
    // Same "animate the exit, then mutate" sequencing as every other delete
    // in this app (see the saved-meal list's own delete handler in app.js) —
    // without awaiting this first, the very next setSuggestionsContext push
    // that onLogFood triggers (via render()) would reconcile this row out
    // instantly, abruptly, before the fade had any chance to play.
    await animateItemRemoval("suggestions-food-list", id);
    onLogFood?.(id);
  });
}
