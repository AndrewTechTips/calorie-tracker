// Smart Meal Suggester — a bottom sheet (#meal-suggester-sheet in index.html)
// that asks Gemini for 3-4 real-world meal ideas fitting this user's own
// remaining macros for today, optionally narrowed by a handful of filter
// pills. The backend (routers/coach.py::suggest_meals) recomputes remaining
// macros itself from this user's real rows — the `context` below is purely
// for the sheet's own "you have X kcal left" display line, never sent as-is
// to the API.
import { api } from "./api.js?v=20260811a";
import { escapeHtml, openSheet, showToast } from "./ui.js?v=20260811a";
import { t } from "./i18n.js?v=20260811a";
import { scaleMacrosByWeight } from "./nutritionMath.js?v=20260811a";

const el = (id) => document.getElementById(id);

// Fed by app.js on every render() — same stashed-primitives pattern as
// aiCoach.js/reminders.js's own setContext, so this module stays independent
// of app.js's actual state shape.
let context = { remainingCalories: 0, remainingProtein: 0, remainingCarbs: 0, remainingFats: 0 };
export function setContext(next) {
  context = { ...context, ...next };
}

let logSuggestionCallback = null; // injected — see initMealSuggester
let currentSuggestions = []; // the untouched {name, weight_g, calories, ...} snapshots Gemini returned, matched by index
let displayWeights = []; // parallel to currentSuggestions — the portion (g) each card currently shows, starts at each suggestion's own weight_g and moves independently as the user edits it
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

// Cycling "here's what's happening" copy shown above the loading skeleton —
// same setInterval idiom as scan.js's startLoadingStageCycle/
// LOADING_STAGE_MESSAGE_KEYS, just its own message set for this sheet.
const LOADING_MESSAGE_KEYS = ["mealSuggester.loadingStage1", "mealSuggester.loadingStage2", "mealSuggester.loadingStage3"];
const LOADING_MESSAGE_INTERVAL_MS = 1600;
let loadingMessageTimer = null;

function setLoadingText(text) {
  const target = el("meal-suggester-loading-text");
  target.textContent = text;
  // Remove + force reflow + re-add restarts the CSS animation from its first
  // frame every time — without the reflow, re-adding an already-present
  // class is a no-op and the fade-in would only ever play once.
  target.classList.remove("text-cycle-in");
  void target.offsetWidth;
  target.classList.add("text-cycle-in");
}

function startLoadingTextCycle() {
  let i = 0;
  setLoadingText(t(LOADING_MESSAGE_KEYS[0]));
  loadingMessageTimer = setInterval(() => {
    i = (i + 1) % LOADING_MESSAGE_KEYS.length;
    setLoadingText(t(LOADING_MESSAGE_KEYS[i]));
  }, LOADING_MESSAGE_INTERVAL_MS);
}

function stopLoadingTextCycle() {
  clearInterval(loadingMessageTimer);
  loadingMessageTimer = null;
}

// Only ever touches the skeleton/error/empty/list — NOT the get-ideas
// button's disabled state, which fetchSuggestions owns directly (it needs
// to stay disabled through the post-success cooldown below, well after
// isLoading has already gone back to false).
function setLoading(isLoading) {
  fetchInFlight = isLoading;
  el("meal-suggester-loading").hidden = !isLoading;
  if (isLoading) {
    startLoadingTextCycle();
    el("meal-suggester-error").hidden = true;
    el("meal-suggester-empty").hidden = true;
    el("meal-suggestions-list").innerHTML = "";
  } else {
    stopLoadingTextCycle();
  }
}

// Swaps the button's own label + spinner — separate from .disabled (managed
// by fetchSuggestions) since the label should say "Get ideas" again the
// instant results are back, even while the button stays disabled a little
// longer for the cooldown below.
function setButtonBusy(isBusy) {
  el("meal-suggester-get-btn-spinner").hidden = !isBusy;
  el("meal-suggester-get-btn-label").textContent = isBusy ? t("mealSuggester.loadingBtn") : t("mealSuggester.getIdeasBtn");
}

// Cooldown after a successful render — a real per-open action, backed by a
// live Gemini call (see backend/routers/coach.py's own 10/minute;3/10
// seconds limiter on this route), not something a satisfied "got my ideas"
// tap-tap-tap reflex should be able to immediately re-fire before even
// reading the first set of results. Deliberately NOT applied on a failed
// request (see fetchSuggestions' catch branch) — a genuine error should be
// retryable right away, not penalized on top of whatever just went wrong.
const RESULT_COOLDOWN_MS = 2500;
let cooldownTimer = null;

// Returns the macro set a card should currently display: `original` scaled
// from its own weight_g to whatever portion (grams) the user has dialed in
// for that card, via the exact same scaleMacrosByWeight() the AI Scan Review
// sheet and the ingredients editor already use (nutritionMath.js) — one
// shared rescale formula everywhere in the app, not a second copy of the
// ratio math for this sheet. A blank/zero/invalid weight (mid-edit, field
// cleared) renders as all-zero macros rather than NaN/Infinity from a
// divide-by-zero, so the card never shows garbage while the user is typing.
function scaledFor(idx) {
  const weight = displayWeights[idx];
  if (!(weight > 0)) return { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0, sugar: 0, sodium: 0 };
  return scaleMacrosByWeight(currentSuggestions[idx], weight);
}

function renderCardMacros(card, idx) {
  const scaled = scaledFor(idx);
  card.querySelector('[data-field="calories"]').textContent = Math.round(scaled.calories);
  card.querySelector('[data-field="protein"]').textContent = `${scaled.protein}g`;
  card.querySelector('[data-field="carbs"]').textContent = `${scaled.carbs}g`;
  card.querySelector('[data-field="fats"]').textContent = `${scaled.fats}g`;
  card.querySelector('[data-field="fiber"]').textContent = `${scaled.fiber}g`;
  card.querySelector('[data-field="sugar"]').textContent = `${scaled.sugar}g`;
  card.querySelector('[data-field="sodium"]').textContent = `${Math.round(scaled.sodium)}mg`;
}

// Each card gets a full 4-column primary macro grid (Calories/Protein/Carbs/
// Fats) — one consistent row, not a calorie badge plus 3 wrapping chips — so
// fats always renders in the same fixed slot as the other three instead of
// being the one macro that can wrap away or get lost against the other
// chips. Fiber/sugar/sodium live behind the same collapsed "more nutrients"
// disclosure the AI Scan Review sheet uses (.nutrient-detail, index.html's
// #scan-nutrient-detail) — same reasoning: checked less often, so tucked
// away rather than crowding the primary row, but still one tap from fully
// informed. Every value above is driven by the portion-weight input
// (.meal-suggestion-weight-input) via scaledFor()/renderCardMacros(), so
// what's on screen always matches the grams currently dialed in — never the
// flat Gemini-suggested serving alone. The sparkle icon reuses the exact
// path from the add-sheet's own "Suggest a meal" option (#opt-suggest), so
// the badge on every card visibly ties back to the entry point that opened
// this sheet.
function renderSuggestions(suggestions) {
  currentSuggestions = suggestions;
  displayWeights = suggestions.map((s) => s.weight_g);
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
      <div class="meal-suggestion-card" data-card-i="${idx}">
        <div class="meal-suggestion-header">
          <span class="meal-suggestion-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>
          </span>
          <div class="meal-suggestion-title-wrap">
            <strong class="meal-suggestion-name">${escapeHtml(s.name)}</strong>
            <p class="meal-suggestion-note">${escapeHtml(s.note || "")}</p>
          </div>
        </div>
        <div class="meal-suggestion-weight-row">
          <label class="meal-suggestion-weight-field-label" for="ms-weight-${idx}">${t("field.weight")}</label>
          <div class="meal-suggestion-weight-input-wrap">
            <input
              type="number"
              id="ms-weight-${idx}"
              class="meal-suggestion-weight-input"
              data-idx="${idx}"
              min="1"
              max="10000"
              step="1"
              inputmode="numeric"
              value="${Math.round(s.weight_g)}"
              aria-label="${escapeHtml(t("mealSuggester.weightAriaLabel", { name: s.name }))}"
            />
            <span class="meal-suggestion-weight-unit" aria-hidden="true">g</span>
          </div>
        </div>
        <div class="meal-suggestion-macros">
          <div class="meal-suggestion-macro-cell macro-calories">
            <span class="meal-suggestion-macro-value" data-field="calories"></span>
            <span class="meal-suggestion-macro-label">${t("dashboard.macroAbbrCalories")}</span>
          </div>
          <div class="meal-suggestion-macro-cell macro-protein">
            <span class="meal-suggestion-macro-value" data-field="protein"></span>
            <span class="meal-suggestion-macro-label">${t("dashboard.macroAbbrProtein")}</span>
          </div>
          <div class="meal-suggestion-macro-cell macro-carbs">
            <span class="meal-suggestion-macro-value" data-field="carbs"></span>
            <span class="meal-suggestion-macro-label">${t("dashboard.macroAbbrCarbs")}</span>
          </div>
          <div class="meal-suggestion-macro-cell macro-fats">
            <span class="meal-suggestion-macro-value" data-field="fats"></span>
            <span class="meal-suggestion-macro-label">${t("dashboard.macroAbbrFats")}</span>
          </div>
        </div>
        <details class="nutrient-detail meal-suggestion-nutrient-detail">
          <summary>
            <span>${t("nutrients.moreLabel")}</span>
            <svg class="nutrient-detail-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </summary>
          <div class="nutrient-detail-grid">
            <div class="nutrient-detail-item">
              <span class="nutrient-detail-label">${t("dashboard.fiber")}</span>
              <span class="nutrient-detail-value meal-suggestion-fiber-value" data-field="fiber"></span>
            </div>
            <div class="nutrient-detail-item">
              <span class="nutrient-detail-label">${t("nutrients.sugar")}</span>
              <span class="nutrient-detail-value meal-suggestion-sugar-value" data-field="sugar"></span>
            </div>
            <div class="nutrient-detail-item">
              <span class="nutrient-detail-label">${t("nutrients.sodium")}</span>
              <span class="nutrient-detail-value meal-suggestion-sodium-value" data-field="sodium"></span>
            </div>
          </div>
        </details>
        <button type="button" class="btn btn-primary btn-sm meal-suggestion-log-btn" data-idx="${idx}">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
          ${t("mealSuggester.logBtn")}
        </button>
      </div>`
    )
    .join("");
  // --card-i drives each card's stagger delay (see style.css's
  // .meal-suggestion-card). Set via the CSSOM here, not baked into the
  // template string above as style="--card-i: ..." — a literal style
  // attribute is parsed by the HTML parser and blocked by this app's CSP
  // (style-src has no 'unsafe-inline'), where the exact same violation
  // already broke the fasting-ring gradient stops (see index.html).
  // el.style.setProperty(), by contrast, goes through the CSSOM directly and
  // is exempt from style-src by spec — the same reason ui.js's water-splash
  // custom properties (--surface-y etc.) already work under this CSP.
  list.querySelectorAll(".meal-suggestion-card[data-card-i]").forEach((card) => {
    const idx = Number(card.dataset.cardI);
    card.style.setProperty("--card-i", idx);
    // Initial fill goes through the exact same renderCardMacros() a later
    // weight edit uses, rather than duplicating the rounding/formatting
    // rules inline in the template above — one source of truth for what a
    // card's numbers look like, whether it's the first paint or the
    // hundredth keystroke in the weight field.
    renderCardMacros(card, idx);
  });
}

async function fetchSuggestions() {
  const btn = el("meal-suggester-get-btn");
  // Belt-and-suspenders re-entrancy guard: a disabled <button> already
  // doesn't dispatch click events at all, so this mainly protects any
  // non-click caller. Both checks (and btn.disabled = true right below) run
  // synchronously, before the first `await` — i.e. in the same tick as the
  // tap itself, so a rapid double/triple tap physically cannot start a
  // second request no matter how fast it lands.
  if (fetchInFlight || btn.disabled) return;
  clearTimeout(cooldownTimer);
  cooldownTimer = null;
  btn.disabled = true;
  setButtonBusy(true);
  setLoading(true);
  try {
    const { suggestions } = await api.suggestMeals(activeFilters());
    renderSuggestions(suggestions || []);
    // Cooldown (see RESULT_COOLDOWN_MS above) — button stays disabled a bit
    // longer than the network call itself took.
    cooldownTimer = setTimeout(() => {
      btn.disabled = false;
      cooldownTimer = null;
    }, RESULT_COOLDOWN_MS);
  } catch (err) {
    el("meal-suggester-error").hidden = false;
    el("meal-suggester-error").textContent = err?.status === 503 ? t("quota.atCapacity") : err.message || t("mealSuggester.errorGeneric");
    btn.disabled = false; // no cooldown on a failed attempt — let the user retry immediately
  } finally {
    setButtonBusy(false);
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

  // Live rescale on every keystroke — same "instant, no submit needed"
  // feel as the AI Scan Review sheet's own weight field. Only the one card
  // being edited is touched (renderCardMacros scopes its querySelectors to
  // that card), so an in-progress edit in another card and scroll position
  // both survive untouched, unlike a full renderSuggestions() re-render.
  el("meal-suggestions-list").addEventListener("input", (e) => {
    const input = e.target.closest(".meal-suggestion-weight-input");
    if (!input) return;
    const idx = Number(input.dataset.idx);
    if (!currentSuggestions[idx]) return;
    displayWeights[idx] = Number(input.value) || 0;
    renderCardMacros(input.closest(".meal-suggestion-card"), idx);
  });

  el("meal-suggestions-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".meal-suggestion-log-btn");
    if (!btn || btn.disabled) return;
    const idx = Number(btn.dataset.idx);
    const original = currentSuggestions[idx];
    const weight = displayWeights[idx];
    if (!original) return;
    if (!(weight > 0)) {
      showToast(t("mealSuggester.needsWeight"), "error");
      return;
    }

    // A complete, freshly-scaled snapshot at whatever portion the user
    // dialed in — never the flat Gemini-suggested serving — built with the
    // same scaleMacrosByWeight() the card's own live display already used,
    // so what gets logged is guaranteed to match what was just on screen.
    const suggestion = { ...original, weight_g: weight, ...scaledFor(idx) };

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
