// "Damage Control" intervention — a floating action card (see its markup in
// index.html, deliberately NOT a .sheet-overlay: no backdrop, doesn't block
// the rest of the app, dismissible without losing where the user was)
// triggered right after app.js logs a new food entry that massively exceeds
// today's calorie target. The numbers shown are always the backend's own
// (see api.getDamageControlPlan / backend/routers/coach.py's
// damage_control) — this module only ever decides WHEN to ask, never
// computes the remaining-macro numbers itself.
import { api } from "./api.js?v=20260818b";
import { t } from "./i18n.js?v=20260818b";

const el = (id) => document.getElementById(id);

// Two independent trigger conditions, combined with OR — catches both "one
// blowout meal" and "a day that crept over gradually then tipped hard"
// without firing on an ordinary, only-slightly-over day:
//   - This ONE meal alone is already >= 60% of the whole day's calorie
//     target (a single very large meal, regardless of what else was logged).
//   - Today's RUNNING TOTAL (including this meal) is >= 140% of target.
// The single-meal condition can fire again later the same day (a second
// blowout deserves its own note); the daily-overage condition fires at most
// once per calendar day (dailyOverageShownDate below) so it doesn't re-nag
// on every subsequent smaller log once the day's already over the line.
const SINGLE_MEAL_TARGET_FRACTION = 0.6;
const DAILY_OVERAGE_FRACTION = 1.4;

let openSuggesterCallback = null;
let dailyOverageShownDate = null;

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function triggerReason(mealCalories, todayTotalCalories, targetCalories) {
  if (!targetCalories) return null;
  if (mealCalories >= targetCalories * SINGLE_MEAL_TARGET_FRACTION) return "single_meal";
  if (todayTotalCalories >= targetCalories * DAILY_OVERAGE_FRACTION && dailyOverageShownDate !== todayDateStr()) {
    return "daily_overage";
  }
  return null;
}

// Exported separately from maybeTrigger below so app.js can decide whether
// to even bother (e.g. skip entirely for a backdated past-day entry, which
// isn't "right now" in any meaningful sense for an intervention like this).
export function shouldTrigger(mealCalories, todayTotalCalories, targetCalories) {
  return triggerReason(mealCalories, todayTotalCalories, targetCalories) !== null;
}

function showCard() {
  const card = el("damage-control-card");
  card.hidden = false;
  // Two rAFs, not one: the browser needs a full frame with `hidden` already
  // removed (display: block) before the .show class's transform/opacity
  // transition has anything to animate FROM — adding both in the same tick
  // an element becomes displayed is a well-known way to get a transition
  // that silently just snaps to its end state instead of playing.
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add("show")));
}

function hideCard() {
  const card = el("damage-control-card");
  if (card.hidden) return;
  card.classList.remove("show");
  // Matches --damage-control-exit-ms in style.css's transition duration.
  setTimeout(() => {
    card.hidden = true;
  }, 320);
}

function setLoading(isLoading) {
  el("damage-control-loading").hidden = !isLoading;
  el("damage-control-message").hidden = isLoading;
}

async function fetchAndRenderPlan(foodName, estimatedOverage) {
  setLoading(true);
  el("damage-control-remaining").hidden = true;
  el("damage-control-subtitle").textContent = t("damageControl.subtitleOver", { amount: Math.round(Math.max(0, estimatedOverage)) });

  try {
    const plan = await api.getDamageControlPlan(foodName);
    el("damage-control-subtitle").textContent = t("damageControl.subtitleOver", { amount: Math.round(plan.calories_over) });
    el("damage-control-message").textContent = plan.message;
    el("damage-control-remaining-protein").textContent = `${Math.round(plan.remaining_protein)}g`;
    el("damage-control-remaining-carbs").textContent = `${Math.round(plan.remaining_carbs)}g`;
    el("damage-control-remaining-fats").textContent = `${Math.round(plan.remaining_fats)}g`;
    el("damage-control-remaining").hidden = false;
  } catch {
    // Never leave the card stuck on its loading state — a quota/network
    // failure still gets a genuinely reassuring, fully local fallback rather
    // than an error dead-end for a feature whose whole point is reassurance.
    el("damage-control-message").textContent = t("damageControl.fallbackMessage");
  } finally {
    setLoading(false);
  }
}

// `openMealSuggester` is mealSuggester.js's own open function, injected
// rather than imported directly — same dependency-injection pattern
// scan.js/coachChat.js already use, so neither module needs to know the
// other exists beyond this one callback.
export function initDamageControl({ openMealSuggester }) {
  openSuggesterCallback = openMealSuggester;
  el("damage-control-dismiss-btn").addEventListener("click", hideCard);
  el("damage-control-suggest-btn").addEventListener("click", () => {
    hideCard();
    openSuggesterCallback?.();
  });
}

// The one entry point app.js calls right after a new food log succeeds —
// `foodName`/`mealCalories` describe THAT entry, `todayTotalCalories` is
// today's running total including it, `targetCalories` this user's own
// daily target. No-ops silently (never throws, never shows anything) when
// neither trigger condition is met, so every caller can call this
// unconditionally after every fresh log without its own threshold check.
export function maybeTriggerDamageControl({ foodName, mealCalories, todayTotalCalories, targetCalories }) {
  const reason = triggerReason(mealCalories, todayTotalCalories, targetCalories);
  if (!reason) return;
  if (reason === "daily_overage") dailyOverageShownDate = todayDateStr();

  showCard();
  fetchAndRenderPlan(foodName, todayTotalCalories - targetCalories || mealCalories);
}
