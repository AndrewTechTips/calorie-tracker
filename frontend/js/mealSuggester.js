// Smart Meal Suggester — a bottom sheet (#meal-suggester-sheet in index.html)
// that asks Gemini for 3-4 real-world meal ideas fitting this user's own
// remaining macros for today, optionally narrowed by a handful of filter
// pills. The backend (routers/coach.py::suggest_meals) recomputes remaining
// macros itself from this user's real rows — the `context` below is purely
// for the sheet's own "you have X kcal left" display line, never sent as-is
// to the API.
import { api } from "./api.js?v=20260810o";
import { escapeHtml, openSheet } from "./ui.js?v=20260810o";
import { t } from "./i18n.js?v=20260810o";

const el = (id) => document.getElementById(id);

// Fed by app.js on every render() — same stashed-primitives pattern as
// aiCoach.js/reminders.js's own setContext, so this module stays independent
// of app.js's actual state shape.
let context = { remainingCalories: 0, remainingProtein: 0, remainingCarbs: 0, remainingFats: 0 };
export function setContext(next) {
  context = { ...context, ...next };
}

let logSuggestionCallback = null; // injected — see initMealSuggester
let currentSuggestions = []; // the raw list backing each card's "Log this Meal" button (matched by index)
let fetchInFlight = false;

function renderRemainingLine() {
  el("meal-suggester-remaining").textContent = t("mealSuggester.remainingLine", {
    calories: Math.round(Math.max(0, context.remainingCalories)),
    protein: Math.round(Math.max(0, context.remainingProtein)),
  });
}

function activeFilters() {
  return [...document.querySelectorAll("#meal-suggester-filters .filter-pill.active")].map((btn) => btn.dataset.filter);
}

function setFilters(filters) {
  const active = new Set(filters || []);
  document.querySelectorAll("#meal-suggester-filters .filter-pill").forEach((btn) => {
    btn.classList.toggle("active", active.has(btn.dataset.filter));
  });
}

function setLoading(isLoading) {
  fetchInFlight = isLoading;
  el("meal-suggester-loading").hidden = !isLoading;
  el("meal-suggester-get-btn").disabled = isLoading;
  if (isLoading) {
    el("meal-suggester-error").hidden = true;
    el("meal-suggester-empty").hidden = true;
    el("meal-suggestions-list").innerHTML = "";
  }
}

// Deliberately reuses the same macro-abbreviation/chip visual language the
// ingredients editor and journal cards already use throughout this app
// (see style.css's .ingredient-total-chip), rather than inventing a fourth
// look for "here are some macros" — a suggestion card should read as
// obviously kin to every other place this app shows a food's numbers.
function renderSuggestions(suggestions) {
  currentSuggestions = suggestions;
  const list = el("meal-suggestions-list");
  if (!suggestions.length) {
    el("meal-suggester-empty").hidden = false;
    el("meal-suggester-empty").textContent = t("mealSuggester.noResults");
    list.innerHTML = "";
    return;
  }
  el("meal-suggester-empty").hidden = true;
  list.innerHTML = suggestions
    .map(
      (s, idx) => `
      <div class="meal-suggestion-card" style="--card-i: ${idx}">
        <div class="meal-suggestion-header">
          <strong class="meal-suggestion-name">${escapeHtml(s.name)}</strong>
          <span class="meal-suggestion-cal">${Math.round(s.calories)} ${t("field.calories")}</span>
        </div>
        <p class="meal-suggestion-note">${escapeHtml(s.note || "")}</p>
        <div class="meal-suggestion-macros">
          <span class="ingredient-total-chip chip-protein">${Math.round(s.protein)}g ${t("dashboard.macroAbbrProtein")}</span>
          <span class="ingredient-total-chip chip-carbs">${Math.round(s.carbs)}g ${t("dashboard.macroAbbrCarbs")}</span>
          <span class="ingredient-total-chip chip-fats">${Math.round(s.fats)}g ${t("dashboard.macroAbbrFats")}</span>
        </div>
        <button type="button" class="btn btn-primary btn-sm meal-suggestion-log-btn" data-idx="${idx}">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
          ${t("mealSuggester.logBtn")}
        </button>
      </div>`
    )
    .join("");
}

async function fetchSuggestions() {
  if (fetchInFlight) return;
  setLoading(true);
  try {
    const { suggestions } = await api.suggestMeals(activeFilters());
    renderSuggestions(suggestions || []);
  } catch (err) {
    el("meal-suggester-error").hidden = false;
    el("meal-suggester-error").textContent = err?.status === 503 ? t("quota.atCapacity") : err.message || t("mealSuggester.errorGeneric");
  } finally {
    setLoading(false);
  }
}

// `suggestedFilters` (optional): damageControl.js's "Find a lighter meal"
// handoff opens straight into a sensible default (low-fat) instead of a
// blank slate — every other entry point (the add-sheet's own "Suggest a
// meal" option) omits this and leaves whatever filters were last picked this
// session in place, which reads as a small, welcome convenience rather than
// a reset every time.
export function openMealSuggesterSheet({ suggestedFilters } = {}) {
  if (suggestedFilters) setFilters(suggestedFilters);
  renderRemainingLine();
  el("meal-suggester-error").hidden = true;
  openSheet("meal-suggester-sheet");
}

export function initMealSuggester({ logSuggestion }) {
  logSuggestionCallback = logSuggestion;

  document.querySelectorAll("#meal-suggester-filters .filter-pill").forEach((btn) => {
    btn.addEventListener("click", () => btn.classList.toggle("active"));
  });

  el("meal-suggester-get-btn").addEventListener("click", fetchSuggestions);

  el("meal-suggestions-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".meal-suggestion-log-btn");
    if (!btn || btn.disabled) return;
    const idx = Number(btn.dataset.idx);
    const suggestion = currentSuggestions[idx];
    if (!suggestion) return;

    btn.disabled = true;
    logSuggestionCallback?.(suggestion);
    // Marked logged in place rather than removing the card or closing the
    // sheet — a user asking for ideas often wants to log more than one
    // (e.g. a meal + a snack), so the sheet stays open and every OTHER
    // suggestion stays fully tappable.
    btn.classList.add("meal-suggestion-logged");
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg> ${t("mealSuggester.loggedBtn")}`;
  });
}
