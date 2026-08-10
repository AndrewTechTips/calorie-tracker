// Smart Meal Suggester — a bottom sheet (#meal-suggester-sheet in index.html)
// that asks Gemini for 3-4 real-world meal ideas fitting this user's own
// remaining macros for today, optionally narrowed by a handful of filter
// pills. The backend (routers/coach.py::suggest_meals) recomputes remaining
// macros itself from this user's real rows — the `context` below is purely
// for the sheet's own "you have X kcal left" display line, never sent as-is
// to the API.
import { api } from "./api.js?v=20260810r";
import { escapeHtml, openSheet } from "./ui.js?v=20260810r";
import { t } from "./i18n.js?v=20260810r";

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
  el("msr-calories").textContent = Math.round(Math.max(0, context.remainingCalories));
  el("msr-protein").textContent = Math.round(Math.max(0, context.remainingProtein));
  el("msr-carbs").textContent = Math.round(Math.max(0, context.remainingCarbs));
  el("msr-fats").textContent = Math.round(Math.max(0, context.remainingFats));
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

// Each card gets a full 4-column macro grid (Calories/Protein/Carbs/Fats) —
// one consistent row, not a calorie badge plus 3 wrapping chips — so fats
// always renders in the same fixed slot as the other three instead of being
// the one macro that can wrap away or get lost against the other chips.
// The sparkle icon reuses the exact path from the add-sheet's own
// "Suggest a meal" option (#opt-suggest), so the badge on every card visibly
// ties back to the entry point that opened this sheet.
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
          <span class="meal-suggestion-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>
          </span>
          <div class="meal-suggestion-title-wrap">
            <strong class="meal-suggestion-name">${escapeHtml(s.name)}</strong>
            <p class="meal-suggestion-note">${escapeHtml(s.note || "")}</p>
          </div>
        </div>
        <div class="meal-suggestion-macros">
          <div class="meal-suggestion-macro-cell macro-calories">
            <span class="meal-suggestion-macro-value">${Math.round(s.calories)}</span>
            <span class="meal-suggestion-macro-label">${t("dashboard.macroAbbrCalories")}</span>
          </div>
          <div class="meal-suggestion-macro-cell macro-protein">
            <span class="meal-suggestion-macro-value">${Math.round(s.protein)}g</span>
            <span class="meal-suggestion-macro-label">${t("dashboard.macroAbbrProtein")}</span>
          </div>
          <div class="meal-suggestion-macro-cell macro-carbs">
            <span class="meal-suggestion-macro-value">${Math.round(s.carbs)}g</span>
            <span class="meal-suggestion-macro-label">${t("dashboard.macroAbbrCarbs")}</span>
          </div>
          <div class="meal-suggestion-macro-cell macro-fats">
            <span class="meal-suggestion-macro-value">${Math.round(s.fats)}g</span>
            <span class="meal-suggestion-macro-label">${t("dashboard.macroAbbrFats")}</span>
          </div>
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
