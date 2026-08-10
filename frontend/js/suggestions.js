// Smart food/workout suggestions — a zero-cost, client-side "what should I
// log next" card for the Progress tab, in the same spirit as aiCoach.js's
// preset insights: deterministic math against data already in memory, no
// Gemini call, works fully offline. Two independent halves:
//
// 1. Food: ranks the user's own saved meals (never an external food
//    database this app doesn't have) against how much of today's remaining
//    calorie/protein/carb/fat budget each one covers.
// 2. Workout: surfaces whichever exercise the user's own training log shows
//    as least-recently-trained, a simple rotation nudge built entirely from
//    data already logged — no external exercise/muscle-group database.
import { escapeHtml, reconcileList, vibrate } from "./ui.js?v=20260810e";
import { t } from "./i18n.js?v=20260810e";

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

// `remaining` = { calories, protein, carbs, fats, proteinTarget } — today's
// target minus today's logged total for each, exactly what aiCoach.js's own
// context object already carries (see progress.js's renderFromCache for how
// this is derived from lastTrends.days).
export function computeFoodSuggestions(remaining, savedMeals, limit = FOOD_SUGGESTIONS_LIMIT) {
  if (!savedMeals?.length) return [];
  if (remaining.calories <= 0) return []; // today's calorie budget is already spent

  const proteinRemaining = Math.max(remaining.protein, 0);
  const proteinIsGap = proteinRemaining > MEANINGFUL_PROTEIN_GAP_G;

  return savedMeals
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
}

function renderFoodSuggestions(items) {
  const list = el("suggestions-food-list");
  const empty = el("suggestions-food-empty");
  if (!items.length) {
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const pAbbr = t("dashboard.macroAbbrProtein");
  const cAbbr = t("dashboard.macroAbbrCarbs");
  const fAbbr = t("dashboard.macroAbbrFats");

  reconcileList(list, items, {
    getId: (item) => item.meal.id,
    buildHtml: ({ meal, reason }) => `
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
// Workout suggestion
// ---------------------------------------------------------------------------

export function computeWorkoutSuggestion(workouts) {
  if (!workouts?.length) return { kind: "noHistory" };

  const lastLoggedAtByExercise = new Map();
  workouts.forEach((w) => {
    const loggedAt = new Date(w.logged_at).getTime();
    const prev = lastLoggedAtByExercise.get(w.exercise_name);
    if (prev === undefined || loggedAt > prev) lastLoggedAtByExercise.set(w.exercise_name, loggedAt);
  });

  let stalestName = null;
  let stalestAt = Infinity;
  for (const [name, loggedAt] of lastLoggedAtByExercise) {
    if (loggedAt < stalestAt) {
      stalestAt = loggedAt;
      stalestName = name;
    }
  }

  const daysSince = Math.max(0, Math.floor((Date.now() - stalestAt) / 86400000));
  return { kind: "suggestion", exerciseName: stalestName, daysSince };
}

function renderWorkoutSuggestion(suggestion) {
  const row = el("suggestions-workout-row");
  const empty = el("suggestions-workout-empty");

  if (suggestion.kind === "noHistory") {
    row.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  row.hidden = false;
  el("suggestions-workout-name").textContent = suggestion.exerciseName;
  el("suggestions-workout-meta").textContent =
    suggestion.daysSince <= 0
      ? t("suggestions.workoutTrainedToday")
      : t("suggestions.workoutDaysSince", { days: suggestion.daysSince });
  row.dataset.exerciseName = suggestion.exerciseName;
}

// ---------------------------------------------------------------------------
// Public entry points — mirrors progress.js's own "compute from data already
// in memory, then paint" split (see renderFromCache there).
// ---------------------------------------------------------------------------

export function renderSuggestions({ remaining, savedMeals, workouts }) {
  renderFoodSuggestions(computeFoodSuggestions(remaining, savedMeals));
  renderWorkoutSuggestion(computeWorkoutSuggestion(workouts));
}

// `onLogFood(meal)` / `onOpenWorkoutSheet(exerciseName)` are owned by the
// callers that actually know how to perform each action (app.js's
// optimistic saved-meal logger; progress.js's own workout sheet) — this
// module only ever ranks/paints, never mutates state itself, same
// separation ui.js's other list components already use.
export function initSuggestions({ onLogFood, onOpenWorkoutSheet }) {
  el("suggestions-food-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action='log-suggested-food']");
    if (!btn) return;
    const id = btn.closest(".log-item")?.dataset.id;
    if (!id) return;
    vibrate(12);
    onLogFood?.(id);
  });

  el("suggestions-workout-log-btn").addEventListener("click", () => {
    const name = el("suggestions-workout-row").dataset.exerciseName;
    if (name) onOpenWorkoutSheet?.(name);
  });
}
