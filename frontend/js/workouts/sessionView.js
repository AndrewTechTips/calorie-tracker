// The day-detail list and the active-session workspace — everything between
// "which day am I looking at" and "which exercise am I logging right now".
// Lifted verbatim out of workoutDiary.js (Phase 0.3); the only edits are the
// imports, the exports, and the two seams noted inline (the exerciseSearch
// instance, which index.js still owns, and clearSelectedRpe() replacing a
// direct assignment to what is now rpeScale.js's private variable).
import { api, isConnectivityError } from "../api.js";
import { escapeHtml, reconcileList, showToast } from "../ui.js";
import { getLanguage, getLocale, t } from "../i18n.js";
import { translateExerciseName } from "../exerciseI18n.js";
import { findSession, replaceSession, sessionsForDate, state, parseIsoDate } from "./workoutState.js";
import { updateCalendarDots } from "./calendar.js";
import { renderCard } from "./card.js";
import { applyGhostValues, clearGhostValues } from "./ghostValues.js";
import { renderOneRepMax } from "./oneRepMaxPanel.js";
import { clearSelectedRpe, renderRpeSelection } from "./rpeScale.js";
import { clearRestTimer } from "./restTimer.js";
import { cacheSessions, PENDING_FLAG, tempId } from "./offline.js";
import { enqueueWrite } from "../db.js";

const el = (id) => document.getElementById(id);

// Created in index.js's initWorkoutDiary() (it owns the DOM wiring and the
// onSelect callback that points back at selectExercise here), handed over
// once. Optional-chained at the call site so this module never hard-depends
// on init order.
let exerciseSearch = null;
export function setExerciseSearch(instance) {
  exerciseSearch = instance;
}

// ---------------------------------------------------------------------------
// Day detail — sessions logged on `state.selectedDate`
// ---------------------------------------------------------------------------
export function formatSessionMeta(session) {
  const setCount = (session.sets || []).length;
  const time = new Date(session.started_at).toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" });
  return `${t("workoutDiary.sessionSetsCount", { count: setCount })} · ${time}`;
}

export function renderDayDetail() {
  el("wd-day-detail-date").textContent = parseIsoDate(state.selectedDate).toLocaleDateString(getLocale(), {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const sessions = sessionsForDate(state.selectedDate);
  const list = el("wd-session-list");
  const empty = el("wd-day-detail-empty");

  if (!sessions.length) {
    empty.hidden = false;
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    return;
  }
  empty.hidden = true;

  reconcileList(list, sessions, {
    getId: (s) => s.id,
    buildHtml: (s) => `
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(s.name || t("workoutDiary.sessionUntitled"))}</div>
        <div class="log-item-meta">${escapeHtml(formatSessionMeta(s))}</div>
      </div>
      <div class="log-item-cal">${s.calories_burned ? Math.round(s.calories_burned) + " kcal" : ""}</div>
      <div class="log-item-actions">
        <button data-action="delete-session" aria-label="${t("workoutDiary.deleteSessionAriaLabel")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `,
  });
}

export async function startOrOpenTodaysSession() {
  const existing = sessionsForDate(state.selectedDate)[0];
  if (existing) {
    openActiveSession(existing.id);
    return;
  }
  const payload = { session_date: state.selectedDate };
  try {
    const session = await api.createWorkoutSession(payload);
    replaceSession(session);
    renderDayDetail();
    updateCalendarDots();
    renderCard();
    cacheSessions();
    showToast(t("workoutDiary.toastSessionCreated"), "success");
    openActiveSession(session.id);
  } catch (err) {
    // Offline (Phase 0.4): stand the session up locally and let app.js's
    // drain create it for real on reconnect. Without this the user cannot
    // even BEGIN a workout in a basement gym, which makes queued sets moot —
    // there would be nothing to hang them off. A real server rejection still
    // falls through to the toast exactly as before.
    if (!isConnectivityError(err)) {
      showToast(err.message || t("workoutDiary.toastError"), "error");
      return;
    }
    const now = new Date().toISOString();
    const local = {
      id: tempId("session"),
      session_date: state.selectedDate,
      name: null,
      started_at: now,
      ended_at: null,
      notes: null,
      // No client-side MET table, so the burn stays blank until the real
      // session comes back from the drain — an empty figure is honest, a
      // guessed one would silently disagree with the server's.
      calories_burned: null,
      created_at: now,
      sets: [],
      [PENDING_FLAG]: true,
    };
    replaceSession(local);
    enqueueWrite({ type: "createWorkoutSession", payload, tempId: local.id });
    renderDayDetail();
    updateCalendarDots();
    renderCard();
    showToast(t("toast.queuedOffline"), "default");
    openActiveSession(local.id);
  }
}

// ---------------------------------------------------------------------------
// Active session workspace
// ---------------------------------------------------------------------------
export function closeActiveSession() {
  state.activeSessionId = null;
  state.activeExerciseName = null;
  state.activeExerciseCategory = null;
  el("wd-active-session").hidden = true;
  clearRestTimer();
  el("wd-rest-timer").hidden = true;
  state.activeRoutineExercises = [];
}

export function renderSessionSummary(session) {
  const totalVolume = (session.sets || []).reduce((sum, s) => sum + s.weight_kg * s.reps, 0);
  el("wd-summary-volume").textContent = `${Math.round(totalVolume)} kg`;
  el("wd-summary-calories").textContent = session.calories_burned ? `${Math.round(session.calories_burned)} kcal` : "—";
  if (session.ended_at) {
    const minutes = Math.round((new Date(session.ended_at) - new Date(session.started_at)) / 60000);
    el("wd-summary-duration").textContent = `${minutes} min`;
  } else {
    el("wd-summary-duration").textContent = "—";
  }
}

// Suggestion chips for a routine-started session (js/routines.js) — built
// fresh every time the picker opens so a chip's "done" checkmark always
// reflects the session's current sets, without needing its own separate
// update path wired into submitSet()/deleteSet(). A no-op, single
// `hidden = true` when there's no active routine (the ordinary, ad-hoc case).
export function renderRoutineSuggestions() {
  const container = el("wd-routine-suggestions");
  if (!state.activeRoutineExercises.length) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  const session = findSession(state.activeSessionId);
  const loggedNames = new Set((session?.sets || []).map((s) => s.exercise_name.toLowerCase()));
  const lang = getLanguage();
  container.hidden = false;
  container.replaceChildren(
    ...state.activeRoutineExercises.map((ex) => {
      const done = loggedNames.has(ex.exercise_name.toLowerCase());
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = done ? "wd-routine-chip wd-routine-chip-done" : "wd-routine-chip";
      const scheme = ex.target_sets && ex.target_reps ? ` · ${ex.target_sets}×${ex.target_reps}` : "";
      btn.innerHTML = `${done ? '<svg class="wd-routine-chip-check" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ""}<span>${escapeHtml(translateExerciseName(ex.exercise_name, lang))}${escapeHtml(scheme)}</span>`;
      btn.addEventListener("click", () => selectExercise(ex.exercise_name, ex.category || null));
      return btn;
    }),
  );
}

export function showExercisePicker() {
  state.activeExerciseName = null;
  state.activeExerciseCategory = null;
  el("wd-exercise-picker").hidden = false;
  el("wd-current-exercise-panel").hidden = true;
  exerciseSearch?.reset();
  el("wd-exercise-search-input").focus();
  clearGhostValues();
  renderRoutineSuggestions();
}

export function openActiveSession(sessionId) {
  const session = findSession(sessionId);
  if (!session) return;
  state.activeSessionId = sessionId;
  el("wd-active-session").hidden = false;
  el("wd-active-session-title").textContent = session.name || t("workoutDiary.sessionUntitled");
  renderSessionSummary(session);

  state.activeRoutineExercises = state.pendingRoutineExercises || [];
  state.pendingRoutineExercises = null;

  if (state.pendingPrefill) {
    const { exerciseName, category, reps } = state.pendingPrefill;
    state.pendingPrefill = null;
    selectExercise(exerciseName, category || null);
    if (reps) el("wd-set-reps").value = reps;
  } else {
    showExercisePicker();
  }

  el("wd-active-session").scrollIntoView({ behavior: "smooth", block: "start" });
}

export function renderSetList() {
  const session = findSession(state.activeSessionId);
  const sets = (session?.sets || []).filter((s) => s.exercise_name.toLowerCase() === state.activeExerciseName.toLowerCase());
  const container = el("wd-set-list");
  container.replaceChildren(
    ...sets.map((set) => {
      const row = document.createElement("div");
      row.className = "wd-set-row";
      const weightPart = set.weight_kg > 0 ? `${set.weight_kg}kg × ` : "";
      row.innerHTML = `
        <span class="wd-set-row-index mono">#${set.set_number}</span>
        <span class="wd-set-row-detail mono">${weightPart}${set.reps}</span>
        <span class="wd-set-row-rpe mono">${set.rpe ? `RPE ${set.rpe}` : ""}</span>
        <button type="button" class="wd-set-row-delete" aria-label="${t("workoutDiary.deleteSetAriaLabel")}" data-set-id="${set.id}">
          <svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      `;
      return row;
    }),
  );
}

export function selectExercise(name, category) {
  state.activeExerciseName = name;
  state.activeExerciseCategory = category;
  el("wd-exercise-picker").hidden = true;
  el("wd-current-exercise-panel").hidden = false;
  el("wd-current-exercise-name").textContent = translateExerciseName(name, getLanguage());
  clearSelectedRpe();
  renderRpeSelection();
  renderSetList();
  // submitSet() deliberately leaves weight/reps as-is after logging a set
  // (fast consecutive straight sets of the SAME exercise are then a single
  // tap) — but that convention was never meant to survive a switch to a
  // DIFFERENT exercise, where the previous exercise's numbers are just
  // stale and misleading rather than a helpful repeat. Clearing here, before
  // applyGhostValues() sets this exercise's own placeholder, is what keeps
  // that same-exercise fast-repeat behavior intact while fixing the leak.
  el("wd-set-weight").value = "";
  el("wd-set-reps").value = "";
  applyGhostValues(name);
  renderOneRepMax(name);
}
