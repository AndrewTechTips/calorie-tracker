// Shared exercise-search controller — powers both the Workout Diary's
// set-entry exercise picker (workoutDiary.js) and the Weekly Plan Builder's
// routine editor (routines.js). Used to be two near-identical
// debounce/abort/render implementations that would otherwise have to be
// kept in sync by hand every time this logic changes (bilingual query
// translation, the "create custom exercise" escape hatch below) — now one
// controller both call sites configure with their own input/results
// elements and their own onSelect callback.
import { api } from "./api.js";
import { escapeHtml } from "./ui.js";
import { getLanguage, t } from "./i18n.js";
import { translateCategory, translateExerciseName, translateQueryToEnglish } from "./exerciseI18n.js";

// 400ms of no typing before a request fires — the search endpoint is rate
// limited (20/minute;6/10 seconds, see backend/routers/discover.py) and
// these inputs have no submit button, so every keystroke is a candidate
// trigger; without a real debounce a normal typing burst blows through the
// 6-per-10s burst ceiling and the user sees a raw 429. Deliberately on the
// generous end of the 300-500ms band this needs to sit in: aggressively
// cutting request volume matters more here than shaving a bit of perceived
// latency.
const DEBOUNCE_MS = 400;

function buildResultButton(ex, lang, onSelect) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wd-exercise-result";
  btn.innerHTML = `<span class="wd-exercise-result-name">${escapeHtml(translateExerciseName(ex.name, lang))}</span><span class="wd-exercise-result-meta">${escapeHtml(translateCategory(ex.category, lang) || "")}</span>`;
  btn.addEventListener("click", () => onSelect(ex.name, ex.category || null));
  return btn;
}

// The escape hatch for issue #3: whatever the user actually typed, offered
// back as a one-tap "add this as a new exercise" action rather than a
// hidden Enter-to-submit gesture. `selectExercise()` (workoutDiary.js) and
// the routine-editor's own add-callback both already accept any free-text
// exercise_name with no backend validation against a fixed catalog (see
// backend/models.py's WorkoutSetCreate.exercise_name) — this button is
// purely a discoverability fix, not a new capability.
function buildCustomButton(name, onSelect) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wd-exercise-result wd-exercise-result-custom";
  btn.innerHTML = `
    <svg class="wd-exercise-result-custom-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    <span class="wd-exercise-result-name">${t("workoutDiary.createCustomExercise", { name: escapeHtml(name) })}</span>
  `;
  btn.addEventListener("click", () => onSelect(name, null));
  return btn;
}

/** Wires a text input + results container into a debounced, bilingual,
 * fuzzy-tolerant exercise search with a "create custom exercise" fallback.
 * `onSelect(name, category)` fires both for a real catalog result and for
 * the custom-exercise button (category null in that case). Returns
 * `{ reset }` — call it whenever the picker is (re)opened to clear stale
 * input/results from the previous time it was shown. */
export function createExerciseSearch({ input, results, onSelect }) {
  let abortController = null;
  let debounceTimer = null;

  function renderEmpty() {
    results.innerHTML = `<p class="empty-state">${escapeHtml(t("workoutDiary.exerciseSearchEmpty"))}</p>`;
  }

  function renderResults(rawQuery, exercises) {
    const lang = getLanguage();
    const nodes = exercises.map((ex) => buildResultButton(ex, lang, onSelect));

    // Offer the custom-exercise button whenever there's a typed query that
    // isn't already an exact (case-insensitive) match among the results —
    // covers both "nothing found at all" and "found related exercises, but
    // not this specific one" (e.g. a home-gym variant, a coach's own name
    // for a movement).
    const trimmed = rawQuery.trim();
    const hasExactMatch = exercises.some((ex) => ex.name.toLowerCase() === trimmed.toLowerCase());
    if (trimmed && !hasExactMatch) {
      nodes.push(buildCustomButton(trimmed, onSelect));
    }

    if (!nodes.length) {
      renderEmpty();
      return;
    }
    results.replaceChildren(...nodes);
  }

  async function run() {
    const rawQuery = input.value.trim();
    // A single stray keystroke is almost never a useful query against ~400
    // cached exercise names and just burns a request for a result set the
    // user is about to retype over anyway — skip firing until there's at
    // least 2 characters (an empty query is still allowed through: that's
    // the "show the curated popular list" default, not a search).
    if (rawQuery.length === 1) {
      abortController?.abort();
      results.replaceChildren();
      return;
    }
    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;
    const lang = getLanguage();
    // The backend's exercise search is English-only by design (see
    // exerciseI18n.js's header comment) and matches literally against wger's
    // English catalog — translate whatever's recognizable in a Romanian
    // query before it leaves the browser, so "genuflexiune cu bara" finds
    // the same "Barbell Back Squat" an English query for "squat" would.
    // Unrecognized words (typos, terms outside this dictionary's curated
    // coverage) pass through untouched for the backend's own fuzzy matching
    // to handle.
    const backendQuery = rawQuery ? translateQueryToEnglish(rawQuery, lang) : rawQuery;
    try {
      const exercises = await api.searchExercises(backendQuery ? { q: backendQuery } : {}, { signal });
      if (signal.aborted) return;
      renderResults(rawQuery, exercises);
    } catch (err) {
      if (err.name === "AbortError") return;
      renderResults(rawQuery, []);
    }
  }

  function schedule() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, DEBOUNCE_MS);
  }

  function reset() {
    clearTimeout(debounceTimer);
    abortController?.abort();
    input.value = "";
    results.replaceChildren();
  }

  input.addEventListener("input", schedule);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // Enter still submits the typed text directly as a custom exercise —
    // kept as a fast path for a user who already knows exactly what they
    // want to log and doesn't want to wait for/tap through search results —
    // but this is no longer the ONLY way to do it; the visible button in
    // renderResults() above is the discoverable version of the same action.
    const name = input.value.trim();
    if (name) onSelect(name, null);
  });

  return { reset };
}
