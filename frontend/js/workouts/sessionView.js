// The day-detail list and the active-session workspace — everything between
// "which day am I looking at" and "which exercise am I logging right now".
// Lifted verbatim out of workoutDiary.js (Phase 0.3); the only edits are the
// imports, the exports, and the two seams noted inline (the exerciseSearch
// instance, which index.js still owns, and clearSelectedRpe() replacing a
// direct assignment to what is now rpeScale.js's private variable).
import { api, isConnectivityError } from "../api.js";
import { escapeHtml, lockAppScroll, reconcileList, showToast, unlockAppScroll } from "../ui.js";
import { getLanguage, getLocale, t } from "../i18n.js";
import { translateExerciseName } from "../exerciseI18n.js";
import { findSession, replaceSession, sessionsForDate, state, parseIsoDate } from "./workoutState.js";
import { updateCalendarDots } from "./calendar.js";
import { renderTrain } from "./trainView.js";
import { renderCard } from "./card.js";
import { applyGhostValues, clearGhostValues } from "./ghostValues.js";
import { renderOneRepMax } from "./oneRepMaxPanel.js";
import { renderCardioList } from "./cardioList.js";
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
    renderTrain();
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
    renderTrain();
    showToast(t("toast.queuedOffline"), "default");
    openActiveSession(local.id);
  }
}

// ---------------------------------------------------------------------------
// Elapsed clock (Phase 2.1) — how long this session has been running, in the
// persistent header. Ticks once a second via setInterval rather than rAF for
// exactly the reason restTimer.js gives for its own: the displayed second only
// changes once a second, so anything faster is wasted wake-ups against a
// phone's battery. Derived from `started_at` on every tick rather than
// incremented, so a throttled background tab (the screen locking mid-set is the
// common case) self-corrects instead of drifting behind.
// ---------------------------------------------------------------------------
let elapsedIntervalId = null;

function formatElapsed(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function tickElapsed() {
  const session = findSession(state.activeSessionId);
  const node = el("ws-elapsed");
  if (!session || !node) return;
  // A finished session shows the time it actually took, frozen, not a clock
  // that keeps running after the workout ended.
  const end = session.ended_at ? new Date(session.ended_at) : new Date();
  const seconds = Math.max(0, Math.round((end - new Date(session.started_at)) / 1000));
  node.textContent = formatElapsed(seconds);
}

export function startElapsedClock() {
  stopElapsedClock();
  tickElapsed();
  elapsedIntervalId = setInterval(tickElapsed, 1000);
}

export function stopElapsedClock() {
  if (elapsedIntervalId) clearInterval(elapsedIntervalId);
  elapsedIntervalId = null;
}

// ---------------------------------------------------------------------------
// Active session workspace
// ---------------------------------------------------------------------------
export function closeActiveSession() {
  stopElapsedClock();
  el("workout-session-view").hidden = true;
  // Only release the page if nothing else is holding it. A session opened from
  // the diary's own day list leaves the calendar showing underneath, and
  // unlocking here would let that page scroll behind a surface the user has not
  // left yet.
  if (el("workout-diary-view").hidden) unlockAppScroll();
  state.activeSessionId = null;
  state.activeExerciseName = null;
  state.activeExerciseCategory = null;
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
  el("ws-entry").hidden = true; // nothing chosen yet — nothing to log
  exerciseSearch?.reset();
  el("wd-exercise-search-input").focus();
  clearGhostValues();
  renderRoutineSuggestions();
  renderExerciseRail();
}

export function openActiveSession(sessionId) {
  const session = findSession(sessionId);
  if (!session) return;
  state.activeSessionId = sessionId;
  // Phase 2.1: its own fullscreen surface, so the logger is the whole screen
  // rather than a card below a calendar that had to be scrolled into view.
  el("workout-session-view").hidden = false;
  lockAppScroll();
  startElapsedClock();
  el("wd-active-session-title").textContent = session.name || t("workoutDiary.sessionUntitled");
  renderSessionSummary(session);
  // Phase 5.3 — whatever cardio is already on this session, visible from the
  // moment the logger opens rather than only after one is added.
  renderCardioList();

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
  el("ws-entry").hidden = false;
  el("wd-current-exercise-name").textContent = translateExerciseName(name, getLanguage());
  clearSelectedRpe();
  renderRpeSelection();
  renderSetList();
  renderExerciseRail();
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

// ---------------------------------------------------------------------------
// Exercise rail (Phase 2.4)
//
// Every exercise this session touches, in one horizontal strip under the
// header: the ones already logged, the one being logged, the rest of the
// routine still to come, and a "+" that opens the search. Tapping one switches
// to it.
//
// It replaces "Change exercise", which sent the user back to a blank search box
// every single time they moved between movements — including to an exercise
// they had already logged sets for a minute earlier, and including on a planned
// day where the app already knew the whole list. A session's exercises are
// known (from the routine) or accumulated (free session); moving between them
// should never involve typing.
//
// Deliberately NOT a swipe gesture. `initTabSwipe` in app.js already owns
// horizontal drags at this width, the rail scrolls horizontally itself, and a
// third meaning for the same gesture inside a fullscreen surface would be a
// coin toss at the edges. Taps are unambiguous, and the rail is scrollable.
// ---------------------------------------------------------------------------
function railEntries() {
  const session = findSession(state.activeSessionId);
  const logged = [];
  const seen = new Set();
  for (const s of session?.sets || []) {
    const key = s.exercise_name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    logged.push({ name: s.exercise_name, category: s.category || null, sets: 0 });
  }
  // Count per exercise in one pass rather than filtering inside the loop above.
  for (const s of session?.sets || []) {
    const entry = logged.find((e) => e.name.trim().toLowerCase() === s.exercise_name.trim().toLowerCase());
    if (entry) entry.sets += 1;
  }
  // Planned-but-not-yet-logged exercises keep their routine order after the
  // logged ones, so the rail reads as "what I've done, then what's left".
  const planned = (state.activeRoutineExercises || [])
    .filter((ex) => !seen.has(ex.exercise_name.trim().toLowerCase()))
    .map((ex) => ({ name: ex.exercise_name, category: ex.category || null, sets: 0 }));
  for (const ex of planned) seen.add(ex.name.trim().toLowerCase());

  // The exercise CURRENTLY selected belongs on the rail even with no sets yet
  // and no place in the routine — which is every ad-hoc exercise, at the moment
  // it is chosen. Without this the rail silently omits the one thing the user
  // is looking at until its first set lands, and there is no way back to it
  // after switching away.
  const current = (state.activeExerciseName || "").trim();
  const extra = current && !seen.has(current.toLowerCase())
    ? [{ name: state.activeExerciseName, category: state.activeExerciseCategory || null, sets: 0 }]
    : [];
  return [...logged, ...planned, ...extra];
}

export function renderExerciseRail() {
  const rail = el("ws-rail");
  if (!rail) return;
  const entries = railEntries();
  const active = (state.activeExerciseName || "").trim().toLowerCase();
  const lang = getLanguage();

  const nodes = entries.map((entry) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ws-rail-chip";
    btn.setAttribute("role", "tab");
    const isActive = entry.name.trim().toLowerCase() === active;
    btn.setAttribute("aria-selected", String(isActive));
    if (isActive) btn.classList.add("ws-rail-chip-active");
    if (entry.sets > 0) btn.classList.add("ws-rail-chip-done");
    btn.innerHTML = `<span class="ws-rail-chip-name">${escapeHtml(translateExerciseName(entry.name, lang))}</span>${
      entry.sets > 0 ? `<span class="ws-rail-chip-count mono">${entry.sets}</span>` : ""
    }`;
    btn.addEventListener("click", () => selectExercise(entry.name, entry.category));
    return btn;
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "ws-rail-chip ws-rail-chip-add";
  add.setAttribute("aria-label", t("workoutSession.addExerciseAria"));
  add.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
  add.addEventListener("click", showExercisePicker);
  nodes.push(add);

  rail.hidden = false;
  rail.replaceChildren(...nodes);

  // Keep the current exercise in view when switching via the rail — with more
  // than about four exercises the active one can otherwise sit off-screen.
  rail.querySelector(".ws-rail-chip-active")?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
}
