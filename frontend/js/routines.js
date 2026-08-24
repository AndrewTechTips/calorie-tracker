// Weekly Plan Builder — Phase 2 of the openGym-inspired training upgrade.
// Moves the Workout Diary from log-first (open it, decide what to do) to
// plan-first: a routine is a reusable exercise template, and each weekday
// can have at most one assigned (sql/schema.sql's workout_routines /
// weekly_plan_days, backend/routers/routines.py). Starting a planned day
// still goes through the ordinary Workout Diary session/set flow
// (workoutDiary.js::startRoutineToday) — this module never logs anything
// itself, it only decides what *should* happen today and hands off.
//
// Same "thin context object, no circular import" shape workoutDiary.js
// itself documents: this module owns its own state (routines, weekly plan)
// and reaches into workoutDiary.js for exactly the two things it needs
// (startRoutineToday, getCachedSessions), never the other way around.
import { api } from "./api.js?v=20260824a";
import {
  closeSheet,
  deleteWithUndo,
  escapeHtml,
  lockAppScroll,
  openSheet,
  showToast,
  unlockAppScroll,
} from "./ui.js?v=20260824a";
import { getLanguage, getLocale, onLanguageChange, t } from "./i18n.js?v=20260824a";
import { translateCategory, translateExerciseName } from "./exerciseI18n.js?v=20260824a";
import { startRoutineToday } from "./workoutDiary.js?v=20260824a";

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Weekday helpers — 0=Monday..6=Sunday, the exact convention
// workoutDiary.js's own calendar already uses. 2024-01-01 is a real Monday,
// so `new Date(2024, 0, 1 + weekday)` gives every weekday a stable date to
// pull a locale-formatted name off, the same trick renderWeekdayHeader()
// uses there — this module deliberately doesn't import that helper (a
// one-line duplication is cheaper than a cross-module dependency for
// something this small).
// ---------------------------------------------------------------------------
function weekdayAnchorDate(weekday) {
  return new Date(2024, 0, 1 + weekday);
}
function todayWeekday() {
  return (new Date().getDay() + 6) % 7;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let cachedRoutines = [];
let cachedWeeklyPlan = []; // sparse: [{ weekday, routine_id, routine_name, exercises }]
let selectedPlanWeekday = todayWeekday();
let pendingAssignWeekday = null; // set while routine-picker-sheet is open
let editingRoutineId = null; // null = the editor sheet is creating a new routine
let editorExercises = []; // working copy while routine-editor-sheet is open
let routineExerciseSearchAbort = null;
let routineExerciseSearchTimeout = null;

function planForWeekday(weekday) {
  return cachedWeeklyPlan.find((d) => d.weekday === weekday) || null;
}

// ---------------------------------------------------------------------------
// Dashboard prompt — "Today is X" (only rendered here, in response to this
// module's own writes; app.js's per-render() loop does NOT call this, since
// nothing about a food/water log ever changes today's assigned routine).
// ---------------------------------------------------------------------------
function renderRoutineBanner() {
  const banner = el("routine-today-banner");
  const plan = planForWeekday(todayWeekday());
  if (!plan) {
    banner.hidden = true;
    return;
  }
  el("routine-today-banner-text").textContent = [
    t("routines.dashboardPrompt", { name: plan.routine_name }),
    t("routines.dashboardSubtitle", { count: plan.exercises.length }),
  ].join(" · ");
  banner.hidden = false;
}

export async function loadWeeklyPlan() {
  try {
    cachedWeeklyPlan = await api.getWeeklyPlan();
  } catch {
    cachedWeeklyPlan = []; // not-yet-migrated project, or offline boot — no plan-first prompt, nothing else breaks
  }
  renderRoutineBanner();
}

// ---------------------------------------------------------------------------
// Week strip
// ---------------------------------------------------------------------------
function renderWeekStrip() {
  const container = el("plan-week-strip");
  const today = todayWeekday();
  const locale = getLocale();
  container.replaceChildren(
    ...Array.from({ length: 7 }, (_, weekday) => {
      const plan = planForWeekday(weekday);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wd-week-day";
      if (weekday === today) btn.classList.add("wd-week-day-today");
      if (weekday === selectedPlanWeekday) btn.classList.add("wd-week-day-selected");
      btn.innerHTML = `
        <span class="wd-week-day-abbr">${escapeHtml(weekdayAnchorDate(weekday).toLocaleDateString(locale, { weekday: "short" }))}</span>
        <span class="wd-week-day-label">${plan ? escapeHtml(plan.routine_name) : escapeHtml(t("routines.restDay"))}</span>
        ${plan ? '<span class="wd-week-day-dot"></span>' : ""}
      `;
      btn.addEventListener("click", () => {
        selectedPlanWeekday = weekday;
        renderWeekStrip();
        renderDayDetail();
      });
      return btn;
    }),
  );
}

// ---------------------------------------------------------------------------
// Day detail panel
// ---------------------------------------------------------------------------
function renderDayDetail() {
  const weekday = selectedPlanWeekday;
  el("plan-day-detail-title").textContent = weekdayAnchorDate(weekday).toLocaleDateString(getLocale(), { weekday: "long" });
  const plan = planForWeekday(weekday);
  const body = el("plan-day-detail-body");

  if (!plan) {
    body.innerHTML = `
      <p class="empty-state plan-day-empty">
        <span class="empty-state-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 12h16M4 9v6M7 8v8M17 8v8M20 9v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span>
        <span>${escapeHtml(t("routines.emptyDayHint"))}</span>
      </p>
      <div class="plan-day-actions">
        <button type="button" class="section-action-btn plan-day-assign-btn" id="plan-day-assign-btn">${escapeHtml(t("routines.assignBtn"))}</button>
      </div>
    `;
    el("plan-day-assign-btn").addEventListener("click", () => openRoutinePicker(weekday));
    return;
  }

  const lang = getLanguage();
  const exerciseRows = plan.exercises.length
    ? plan.exercises
        .map(
          (ex) => `
      <div class="plan-day-exercise-row">
        <span class="plan-day-exercise-name">${escapeHtml(translateExerciseName(ex.exercise_name, lang))}</span>
        ${ex.target_sets && ex.target_reps ? `<span class="plan-day-exercise-scheme mono">${ex.target_sets}&times;${ex.target_reps}</span>` : ""}
      </div>
    `,
        )
        .join("")
    : `<p class="empty-state"><span>${escapeHtml(t("routines.noExercisesYet"))}</span></p>`;

  body.innerHTML = `
    <div class="plan-day-exercises">${exerciseRows}</div>
    <div class="plan-day-actions">
      <button type="button" class="section-action-btn" id="plan-day-change-btn">${escapeHtml(t("routines.changeBtn"))}</button>
      <button type="button" class="section-action-btn" id="plan-day-clear-btn">${escapeHtml(t("routines.clearBtn"))}</button>
    </div>
  `;
  el("plan-day-change-btn").addEventListener("click", () => openRoutinePicker(weekday));
  el("plan-day-clear-btn").addEventListener("click", () => clearPlanDay(weekday));
}

function clearPlanDay(weekday) {
  const previousPlan = cachedWeeklyPlan;
  deleteWithUndo({
    removeNow: () => {
      cachedWeeklyPlan = cachedWeeklyPlan.filter((d) => d.weekday !== weekday);
      renderWeekStrip();
      renderDayDetail();
      renderRoutineBanner();
    },
    restore: () => {
      cachedWeeklyPlan = previousPlan;
      renderWeekStrip();
      renderDayDetail();
      renderRoutineBanner();
    },
    callDelete: () => api.clearWeeklyPlanDay(weekday),
    removedToastKey: "routines.toastDayCleared",
    revertToastKey: "routines.toastError",
  });
}

// ---------------------------------------------------------------------------
// Routine picker — assigning/changing a day
// ---------------------------------------------------------------------------
async function openRoutinePicker(weekday) {
  pendingAssignWeekday = weekday;
  openSheet("routine-picker-sheet");
  renderRoutinePickerList(); // whatever's cached, instantly — no blank flash
  await loadRoutines(); // then refresh, in case a routine changed on another device
  renderRoutinePickerList();
}

function renderRoutinePickerList() {
  const list = el("routine-picker-list");
  if (!cachedRoutines.length) {
    list.innerHTML = `<p class="empty-state"><span>${escapeHtml(t("routines.noRoutinesYet"))}</span></p>`;
    return;
  }
  list.replaceChildren(
    ...cachedRoutines.map((routine) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wd-exercise-result";
      btn.innerHTML = `<span class="wd-exercise-result-name">${escapeHtml(routine.name)}</span><span class="wd-exercise-result-meta">${escapeHtml(t("routines.exerciseCount", { count: routine.exercises.length }))}</span>`;
      btn.addEventListener("click", () => assignRoutineToPendingDay(routine));
      return btn;
    }),
  );
}

async function assignRoutineToPendingDay(routine) {
  const weekday = pendingAssignWeekday;
  if (weekday == null) return;
  try {
    const saved = await api.assignWeeklyPlanDay(weekday, routine.id);
    cachedWeeklyPlan = [...cachedWeeklyPlan.filter((d) => d.weekday !== weekday), saved];
    pendingAssignWeekday = null;
    closeSheet("routine-picker-sheet");
    renderWeekStrip();
    renderDayDetail();
    renderRoutineBanner();
    showToast(t("routines.toastDayAssigned", { name: routine.name }), "success");
  } catch (err) {
    showToast(err.message || t("routines.toastError"), "error");
  }
}

// ---------------------------------------------------------------------------
// My Routines — management list
// ---------------------------------------------------------------------------
async function loadRoutines() {
  try {
    cachedRoutines = await api.listRoutines();
  } catch {
    cachedRoutines = [];
  }
  renderRoutinesList();
}

function renderRoutinesList() {
  const list = el("plan-routines-list");
  const empty = el("plan-routines-empty");
  if (!cachedRoutines.length) {
    empty.hidden = false;
    list.replaceChildren();
    return;
  }
  empty.hidden = true;
  list.replaceChildren(
    ...cachedRoutines.map((routine) => {
      const row = document.createElement("div");
      row.className = "plan-routine-row";
      row.innerHTML = `
        <span class="plan-routine-row-name">${escapeHtml(routine.name)}</span>
        <span class="plan-routine-row-count mono">${escapeHtml(t("routines.exerciseCount", { count: routine.exercises.length }))}</span>
        <div class="plan-routine-row-actions">
          <button type="button" class="plan-routine-row-btn" data-action="edit" aria-label="${escapeHtml(t("routines.editRoutineAriaLabel", { name: routine.name }))}">
            <svg viewBox="0 0 24 24" fill="none"><path d="M4 21l4.5-1L20 8.5a1.5 1.5 0 000-2.1l-1.4-1.4a1.5 1.5 0 00-2.1 0L5 16.5 4 21z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="plan-routine-row-btn plan-routine-row-btn-delete" data-action="delete" aria-label="${escapeHtml(t("routines.deleteRoutineAriaLabel", { name: routine.name }))}">
            <svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </div>
      `;
      row.querySelector('[data-action="edit"]').addEventListener("click", () => openRoutineEditor(routine));
      row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteRoutine(routine));
      return row;
    }),
  );
}

function deleteRoutine(routine) {
  const previousRoutines = cachedRoutines;
  const previousPlan = cachedWeeklyPlan;
  deleteWithUndo({
    removeNow: () => {
      cachedRoutines = cachedRoutines.filter((r) => r.id !== routine.id);
      // The backend cascade-deletes matching weekly_plan_days rows, but the
      // local cache needs the same edit by hand to stay in sync without an
      // extra round trip.
      cachedWeeklyPlan = cachedWeeklyPlan.filter((d) => d.routine_id !== routine.id);
      renderRoutinesList();
      renderWeekStrip();
      renderDayDetail();
      renderRoutineBanner();
    },
    restore: () => {
      cachedRoutines = previousRoutines;
      cachedWeeklyPlan = previousPlan;
      renderRoutinesList();
      renderWeekStrip();
      renderDayDetail();
      renderRoutineBanner();
    },
    callDelete: () => api.deleteRoutine(routine.id),
    removedToastKey: "routines.toastRoutineDeleted",
    revertToastKey: "routines.toastError",
  });
}

// ---------------------------------------------------------------------------
// Routine editor — name + an ordered exercise list built entirely by
// tapping. No drag-and-drop: adding appends, removing splices, both followed
// by a full (but tiny — at most 50 rows, realistically 3-8) replaceChildren
// re-render, the same low-cost list pattern workoutDiary.js's own set list
// already uses.
// ---------------------------------------------------------------------------
function openRoutineEditor(routine = null) {
  editingRoutineId = routine?.id || null;
  editorExercises = routine ? routine.exercises.map((ex) => ({ ...ex })) : [];
  el("routine-editor-title").textContent = t(routine ? "routines.editorTitleEdit" : "routines.editorTitleNew");
  el("routine-editor-name").value = routine?.name || "";
  el("routine-exercise-search-input").value = "";
  el("routine-exercise-search-results").replaceChildren();
  renderEditorExercises();
  openSheet("routine-editor-sheet");
  el("routine-editor-name").focus();
}

function renderEditorExercises() {
  const container = el("routine-editor-exercises");
  const empty = el("routine-editor-exercises-empty");
  empty.hidden = editorExercises.length > 0;
  const lang = getLanguage();
  container.replaceChildren(
    ...editorExercises.map((ex, idx) => {
      const row = document.createElement("div");
      row.className = "routine-exercise-row";
      row.innerHTML = `
        <span class="routine-exercise-name">${escapeHtml(translateExerciseName(ex.exercise_name, lang))}</span>
        <input type="number" class="routine-exercise-target" data-idx="${idx}" data-field="target_sets" min="1" max="20" value="${ex.target_sets ?? 3}" aria-label="${escapeHtml(t("routines.setsLabel"))}" />
        <span class="routine-exercise-target-sep">&times;</span>
        <input type="number" class="routine-exercise-target" data-idx="${idx}" data-field="target_reps" min="1" max="200" value="${ex.target_reps ?? 10}" aria-label="${escapeHtml(t("routines.repsLabel"))}" />
        <button type="button" class="routine-exercise-remove" data-idx="${idx}" aria-label="${escapeHtml(t("routines.removeExerciseAriaLabel", { name: ex.exercise_name }))}">
          <svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M6 18L18 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      `;
      return row;
    }),
  );
}

async function runRoutineExerciseSearch() {
  const q = el("routine-exercise-search-input").value.trim();
  if (q.length === 1) {
    routineExerciseSearchAbort?.abort();
    return;
  }
  routineExerciseSearchAbort?.abort();
  routineExerciseSearchAbort = new AbortController();
  const results = el("routine-exercise-search-results");
  try {
    const exercises = await api.searchExercises(q ? { q } : {}, { signal: routineExerciseSearchAbort.signal });
    if (!exercises.length) {
      results.innerHTML = `<p class="empty-state">${escapeHtml(t("workoutDiary.exerciseSearchEmpty"))}</p>`;
      return;
    }
    const lang = getLanguage();
    results.replaceChildren(
      ...exercises.map((ex) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "wd-exercise-result";
        btn.innerHTML = `<span class="wd-exercise-result-name">${escapeHtml(translateExerciseName(ex.name, lang))}</span><span class="wd-exercise-result-meta">${escapeHtml(translateCategory(ex.category, lang) || "")}</span>`;
        btn.addEventListener("click", () => {
          editorExercises.push({ exercise_name: ex.name, category: ex.category || null, target_sets: 3, target_reps: 10 });
          renderEditorExercises();
          el("routine-exercise-search-input").value = "";
          results.replaceChildren();
        });
        return btn;
      }),
    );
  } catch (err) {
    if (err.name === "AbortError") return;
    results.innerHTML = `<p class="empty-state">${escapeHtml(t("workoutDiary.exerciseSearchEmpty"))}</p>`;
  }
}

// Same 400ms band as workoutDiary.js's own exercise search, for the same
// reason: aggressively cutting request volume against a rate-limited search
// endpoint matters more here than shaving a bit of perceived latency.
function scheduleRoutineExerciseSearch() {
  clearTimeout(routineExerciseSearchTimeout);
  routineExerciseSearchTimeout = setTimeout(runRoutineExerciseSearch, 400);
}

async function submitRoutineEditor(e) {
  e.preventDefault();
  const name = el("routine-editor-name").value.trim();
  if (!name) return;
  const payload = {
    name,
    exercises: editorExercises.map((ex) => ({
      exercise_name: ex.exercise_name,
      category: ex.category || null,
      target_sets: ex.target_sets || null,
      target_reps: ex.target_reps || null,
    })),
  };
  try {
    const saved = editingRoutineId ? await api.updateRoutine(editingRoutineId, payload) : await api.createRoutine(payload);
    if (editingRoutineId) {
      cachedRoutines = cachedRoutines.map((r) => (r.id === saved.id ? saved : r));
      cachedWeeklyPlan = cachedWeeklyPlan.map((d) => (d.routine_id === saved.id ? { ...d, routine_name: saved.name, exercises: saved.exercises } : d));
    } else {
      cachedRoutines = [...cachedRoutines, saved];
    }
    const wasCreating = !editingRoutineId;
    editingRoutineId = null;
    closeSheet("routine-editor-sheet");
    renderRoutinesList();
    renderWeekStrip();
    renderDayDetail();
    renderRoutineBanner();
    showToast(t("routines.toastRoutineSaved"), "success");
    // Reached via routine-picker-sheet's "+ New routine" — finish that flow
    // by assigning the just-created routine immediately, instead of making
    // the user reopen the picker and tap the thing they just built.
    if (wasCreating && pendingAssignWeekday != null) {
      await assignRoutineToPendingDay(saved);
    }
  } catch (err) {
    showToast(err.message || t("routines.toastError"), "error");
  }
}

// ---------------------------------------------------------------------------
// Fullscreen open/close
// ---------------------------------------------------------------------------
function openPlanBuilder() {
  el("plan-builder-view").hidden = false;
  lockAppScroll();
  selectedPlanWeekday = todayWeekday();
  renderWeekStrip();
  renderDayDetail();
  loadRoutines();
}
function closePlanBuilder() {
  el("plan-builder-view").hidden = true;
  unlockAppScroll();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
export function initRoutines() {
  el("plan-builder-open-btn").addEventListener("click", openPlanBuilder);
  el("plan-builder-close-btn").addEventListener("click", closePlanBuilder);

  el("routine-today-banner-btn").addEventListener("click", () => {
    const plan = planForWeekday(todayWeekday());
    if (plan) startRoutineToday(plan);
  });

  el("plan-new-routine-btn").addEventListener("click", () => {
    pendingAssignWeekday = null; // standalone creation — never auto-assigns anywhere
    openRoutineEditor(null);
  });
  el("routine-picker-new-btn").addEventListener("click", () => {
    closeSheet("routine-picker-sheet");
    openRoutineEditor(null); // pendingAssignWeekday stays set from openRoutinePicker() — submit auto-assigns
  });

  el("routine-editor-form").addEventListener("submit", submitRoutineEditor);
  el("routine-exercise-search-input").addEventListener("input", scheduleRoutineExerciseSearch);
  el("routine-exercise-search-input").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault(); // this input lives inside a <form> — Enter must never submit the routine itself
  });

  // Delegated (not one listener per row): the exercise list is rebuilt on
  // every add/remove, so per-row listeners would just leak on each render.
  el("routine-editor-exercises").addEventListener("input", (e) => {
    const input = e.target.closest(".routine-exercise-target");
    if (!input) return;
    const idx = Number(input.dataset.idx);
    const value = Number(input.value);
    if (editorExercises[idx] && value > 0) editorExercises[idx][input.dataset.field] = value;
  });
  el("routine-editor-exercises").addEventListener("click", (e) => {
    const btn = e.target.closest(".routine-exercise-remove");
    if (!btn) return;
    editorExercises.splice(Number(btn.dataset.idx), 1);
    renderEditorExercises();
  });

  onLanguageChange(() => {
    renderRoutineBanner();
    if (!el("plan-builder-view").hidden) {
      renderWeekStrip();
      renderDayDetail();
      renderRoutinesList();
    }
  });
}
