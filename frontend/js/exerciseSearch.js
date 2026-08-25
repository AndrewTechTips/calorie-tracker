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
import { MUSCLE_GROUPS, translateCategory, translateExerciseName, translateQueryToEnglish } from "./exerciseI18n.js";

// 400ms of no typing before a request fires — the search endpoint is rate
// limited (20/minute;6/10 seconds, see backend/routers/discover.py) and
// these inputs have no submit button, so every keystroke is a candidate
// trigger; without a real debounce a normal typing burst blows through the
// 6-per-10s burst ceiling and the user sees a raw 429. Deliberately on the
// generous end of the 300-500ms band this needs to sit in: aggressively
// cutting request volume matters more here than shaving a bit of perceived
// latency.
const DEBOUNCE_MS = 400;

// A mobile picker sheet has no patience for scrolling past a long results
// list to reach either a real match or the "create custom" escape hatch —
// the backend already returns up to 30 live-search matches (see
// backend/routers/discover.py's `limit=30`) or the ~28-entry curated
// POPULAR_EXERCISES list on an empty query, and rendering either dump in
// full was exactly the "scroll endlessly to find what you need" fatigue
// this was built to fix. Cap what's actually rendered to a glanceable
// handful; a still-too-broad query is narrowed by typing further, not by
// scrolling — see renderResults()'s truncation hint below.
const MAX_VISIBLE_RESULTS = 6;

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
// purely a discoverability fix, not a new capability. Tapping it doesn't
// finalize the exercise directly anymore — it hands off to
// `onStartCustom(name)`, which swaps the results list for the muscle-group
// picker below, so a custom exercise never gets created without at least
// being offered a target muscle group.
function buildCustomButton(name, onStartCustom) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wd-exercise-result wd-exercise-result-custom";
  btn.innerHTML = `
    <svg class="wd-exercise-result-custom-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    <span class="wd-exercise-result-name">${t("workoutDiary.createCustomExercise", { name: escapeHtml(name) })}</span>
  `;
  btn.addEventListener("click", () => onStartCustom(name));
  return btn;
}

// The muscle-group step for a custom exercise — replaces the results list
// with a self-contained card (its own accent-tinted background/border, not
// a flat continuation of the results list) so it reads as a distinct step
// in a short "name it → tag it" flow rather than looking dumped onto the
// page. Whatever's picked here becomes the set's `category`
// (selectExercise() in workoutDiary.js / addExerciseToEditor() in
// routines.js both already forward it straight through, no backend
// validation against a fixed list — see backend/models.py's
// WorkoutSetCreate.category), which is exactly the field progress.js's
// Muscle Heatmap groups sets by — this is what pulls a custom exercise out
// of the "vacuum" it used to log into. A single chip tap both picks the
// group AND finishes creating the exercise, no separate confirm step,
// since a second required tap would undercut the whole "frictionless"
// point; "Skip" is the one deliberate opt-out, for a custom exercise that
// genuinely isn't a single-muscle-group movement (a cardio drill, a
// mobility circuit). `onBack` returns to the search results this step was
// entered from, so a user who tapped in by mistake (or just wants to check
// spelling before committing) isn't stuck — see createExerciseSearch's
// goBack() for what it actually does.
function buildMuscleGroupPanel(name, lang, onSelect, onBack) {
  const wrap = document.createElement("div");
  wrap.className = "wd-custom-exercise-confirm";

  const header = document.createElement("div");
  header.className = "wd-custom-exercise-confirm-header";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "wd-custom-exercise-back";
  back.setAttribute("aria-label", t("workoutDiary.customExerciseBackAriaLabel"));
  back.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  back.addEventListener("click", onBack);
  const eyebrow = document.createElement("span");
  eyebrow.className = "wd-custom-exercise-eyebrow";
  eyebrow.textContent = t("workoutDiary.customExerciseEyebrow");
  header.append(back, eyebrow);
  wrap.appendChild(header);

  const nameEl = document.createElement("p");
  nameEl.className = "wd-custom-exercise-name";
  nameEl.textContent = name;
  wrap.appendChild(nameEl);

  const label = document.createElement("p");
  label.className = "wd-custom-exercise-confirm-label";
  label.textContent = t("workoutDiary.customExerciseMuscleLabel");
  wrap.appendChild(label);

  const chipRow = document.createElement("div");
  chipRow.className = "wd-muscle-chip-row";
  chipRow.replaceChildren(
    ...MUSCLE_GROUPS.map((group) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "wd-muscle-chip";
      chip.textContent = translateCategory(group, lang);
      chip.addEventListener("click", () => onSelect(name, group));
      return chip;
    }),
  );
  wrap.appendChild(chipRow);

  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "wd-custom-exercise-skip";
  skip.textContent = t("workoutDiary.customExerciseSkip");
  skip.addEventListener("click", () => onSelect(name, null));
  wrap.appendChild(skip);

  return wrap;
}

/** Wires a text input + results container into a debounced, bilingual,
 * fuzzy-tolerant exercise search with a "create custom exercise" fallback.
 * `onSelect(name, category)` fires for a real catalog result (category from
 * the catalog) and for a custom exercise after its muscle-group step
 * (category one of exerciseI18n.js's MUSCLE_GROUPS, or null if skipped).
 * Returns `{ reset }` — call it whenever the picker is (re)opened to clear
 * stale input/results from the previous time it was shown. */
export function createExerciseSearch({ input, results, onSelect }) {
  let abortController = null;
  let debounceTimer = null;
  // What renderResults() last actually painted — lets goBack() below restore
  // the exact same list instantly (no network round trip, no 400ms of blank
  // panel) whenever it's still valid for the current input value.
  let lastRender = { rawQuery: "", exercises: [] };

  function renderEmpty() {
    results.innerHTML = `<p class="empty-state">${escapeHtml(t("workoutDiary.exerciseSearchEmpty"))}</p>`;
  }

  // Swaps the results list for the muscle-group picker (see
  // buildMuscleGroupPanel() above) — the shared landing point for both the
  // visible "create custom exercise" button and the Enter-key fast path
  // below, so neither route can skip the muscle-group step.
  function showCustomConfirm(name) {
    results.replaceChildren(buildMuscleGroupPanel(name, getLanguage(), onSelect, goBack));
  }

  // The muscle-group panel's back arrow. If the input still holds exactly
  // what it held when the results were last rendered (the common case — the
  // panel doesn't touch the input, so this is true unless the user typed
  // more before backing out), restore that list instantly from memory
  // instead of re-hitting the rate-limited search endpoint
  // (20/minute;6/10 seconds, see backend/routers/discover.py) for a result
  // set that hasn't changed. Otherwise fall back to a fresh debounced
  // search, same as if the user had just typed the last character.
  function goBack() {
    input.focus();
    if (input.value.trim() === lastRender.rawQuery) {
      renderResults(lastRender.rawQuery, lastRender.exercises);
    } else {
      results.replaceChildren();
      schedule();
    }
  }

  function renderResults(rawQuery, exercises) {
    lastRender = { rawQuery, exercises };
    const lang = getLanguage();

    // Offer the custom-exercise button whenever there's a typed query that
    // isn't already an exact (case-insensitive) match among the results —
    // covers both "nothing found at all" and "found related exercises, but
    // not this specific one" (e.g. a home-gym variant, a coach's own name
    // for a movement).
    const trimmed = rawQuery.trim();
    const hasExactMatch = exercises.some((ex) => ex.name.toLowerCase() === trimmed.toLowerCase());

    const nodes = [];
    // The custom-exercise escape hatch goes FIRST, immediately under the
    // search input — not appended after however many catalog results came
    // back. Burying it at the bottom of up to 30 rows was exactly the "have
    // to scroll to reach Create New" complaint this was built to fix; now
    // it's the first thing on screen the instant a search comes up short.
    if (trimmed && !hasExactMatch) {
      nodes.push(buildCustomButton(trimmed, showCustomConfirm));
    }

    const visible = exercises.slice(0, MAX_VISIBLE_RESULTS);
    nodes.push(...visible.map((ex) => buildResultButton(ex, lang, onSelect)));

    // A silent cap would just look like the search missed results further
    // down — spell out that there's more, and that narrowing the query (not
    // scrolling) is how to reach them.
    if (exercises.length > MAX_VISIBLE_RESULTS) {
      const hint = document.createElement("p");
      hint.className = "wd-exercise-search-hint";
      hint.textContent = t("workoutDiary.exerciseSearchMoreHint", { count: exercises.length - MAX_VISIBLE_RESULTS });
      nodes.push(hint);
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
    lastRender = { rawQuery: "", exercises: [] };
    results.replaceChildren();
  }

  input.addEventListener("input", schedule);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // Enter is still a fast path for a user who already knows exactly what
    // they want to log and doesn't want to wait for/tap through search
    // results — it jumps straight to the muscle-group picker rather than
    // waiting for the debounced search to render its own custom button
    // (the discoverable version of this same action).
    const name = input.value.trim();
    if (name) showCustomConfirm(name);
  });

  return { reset };
}
