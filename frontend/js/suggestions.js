// Smart food suggestions — the zero-cost, client-side "what should I log
// next" band at the top of the Saved tab ("Ready now"), in the same spirit
// as aiCoach.js's preset insights: deterministic math against data already
// in memory, no Gemini call, works fully offline.
// Ranks the user's own saved meals (never an external food database this
// app doesn't have) against how much of today's remaining calorie/protein/
// carb/fat budget each one covers. Strictly food/nutrition — a workout
// suggestion half used to live here too but was removed: this band sits
// inside the Saved tab, which is scoped to food/nutrition, and a workout
// nudge didn't belong next to it (training suggestions live in the Progress
// tab's own Workout Diary instead).
//
// Phase 1 of the Pantry redesign changed presentation only; the QA pass after
// Phase 5 then made one behavioural fix to the ranking itself — see
// perServingView below for why a multi-serving recipe has to be scored and
// shown per portion. Everything else about the scoring is as it was. What
// Phase 1 moved: this used to
// render as full-width .log-item rows inside a collapsed-by-default
// accordion sitting BELOW the Saved tab's pill tabs, so the one feature on
// that screen that knows what time it is was the one you had to go looking
// for. It now renders as .ready-card cards in a horizontal strip directly
// under the heading, above the tabs. See index.html's #ready-now comment.
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
import { animateItemRemoval, escapeHtml, reconcileList, vibrate } from "./ui.js";
import { onLanguageChange, t } from "./i18n.js";

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

// A multi-serving recipe's stored snapshot is the WHOLE batch, but tapping a
// Ready Now card logs one serving (app.js's logSavedItemWithUndo scales it).
// So both the ranking and the figures on the card have to be per-serving, or
// the card reasons about — and prints — a number that is not the number that
// gets logged: a 4-serving 1,835 kcal batch would be ruled out as not fitting
// a 600 kcal budget that its actual 459 kcal portion fits comfortably, and
// when it did show, the card would promise 1,835 and log 459.
//
// Only the numbers are scaled; `id` and `name` pass through untouched, so the
// caller still logs the real saved meal by its real id.
function perServingView(meal) {
  const servings = meal.servings > 1 ? meal.servings : 1;
  if (servings === 1) return meal;
  return {
    ...meal,
    weight_g: meal.weight_g / servings,
    calories: meal.calories / servings,
    protein: meal.protein / servings,
    carbs: meal.carbs / servings,
    fats: meal.fats / servings,
  };
}

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
    .map(perServingView)
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
  const band = el("ready-now");
  const list = el("suggestions-food-list");
  const empty = el("suggestions-food-empty");
  const stat = el("suggestions-remaining-stat");

  // The whole band hides itself when the only thing it could say is what the
  // saved-meals list immediately below it already says. That's exactly one
  // case — "you haven't saved anything yet" — and it only became a problem
  // once this panel stopped being collapsed by default: two identical empty
  // states stacked on top of each other is a worse screen than the collapsed
  // pill this replaced. The other two reasons ("you're already at budget,
  // nice work" / "nothing you've saved fits what's left") are real, specific
  // information found nowhere else on the tab, so those still show.
  band.hidden = !items.length && emptyReason === "noSavedMeals";

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
    list.querySelectorAll(".ready-card").forEach((n) => n.remove());
    el("suggestions-food-empty-text").textContent = t(FOOD_EMPTY_MESSAGE_KEYS[emptyReason] || "suggestions.foodEmpty");
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const pAbbr = t("dashboard.macroAbbrProtein");
  const cAbbr = t("dashboard.macroAbbrCarbs");
  const fAbbr = t("dashboard.macroAbbrFats");

  reconcileList(list, items, {
    // Not .log-item: this is a card in a horizontal strip, not a row in a
    // vertical list, and it shares none of .log-item's grid anatomy.
    // animateItemRemoval below matches on data-id alone (class-agnostic), so
    // the exit animation still works unchanged.
    itemClass: "ready-card",
    getId: (item) => item.meal.id,
    // The whole card is one button — the only action a suggestion has is
    // "log it", so splitting a 17px icon button out of a card this size just
    // shrinks the tap target for no gain. data-action is unchanged, so
    // initSuggestions' delegated handler below needed no edit.
    // The reason line is tinted by WHICH gap this meal closes: protein green
    // when it's filling a protein gap, calorie ember when it's simply what
    // fits — the same two accents those two numbers already carry everywhere
    // else in the app, so the colour is information rather than decoration.
    buildHtml: ({ meal, reason }) => `
      <button type="button" class="ready-card-btn" data-action="log-suggested-food" aria-label="${escapeHtml(t("suggestions.logFoodBtn", { name: meal.name }))}">
        <span class="ready-card-top">
          <span class="ready-card-cal">${Math.round(meal.calories)}</span>
          <span class="ready-card-unit">kcal</span>
          <span class="ready-card-bolt" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></span>
        </span>
        <span class="ready-card-name">${escapeHtml(meal.name)}</span>
        <span class="ready-card-macros">${pAbbr}${Math.round(meal.protein)} ${cAbbr}${Math.round(meal.carbs)} ${fAbbr}${Math.round(meal.fats)}</span>
        <span class="ready-card-reason${reason.key === "suggestions.reasonProtein" ? " is-protein" : ""}">${escapeHtml(t(reason.key, reason.vars))}</span>
      </button>
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
    const id = btn.closest(".ready-card")?.dataset.id;
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
