// Workout Diary — the folder's public surface and its only wiring.
//
// This is what the rest of the app imports (app.js, progress.js, discover.js,
// routines.js); nothing outside this folder reaches past it into an individual
// module. Everything here was the tail of the old single-file workoutDiary.js
// (Phase 0.3) — fullscreen open/close, the two deep-link entry points, the
// boot/cache exports, and initWorkoutDiary()'s listener wiring — moved as-is.
//
// It is also the one place that knows how the pieces fit together: it injects
// calendar.js's onDateSelected callback and hands sessionView.js the
// exerciseSearch instance it creates, which is what keeps the folder's import
// graph acyclic. See calendar.js's own header for why that seam exists.
import { api } from "../api.js";
import { lockAppScroll, unlockAppScroll } from "../ui.js";
import { getLanguage, onLanguageChange } from "../i18n.js";
import { translateExerciseName } from "../exerciseI18n.js";
import { createExerciseSearch } from "./exerciseSearch.js";
// routines.js imports getCachedSessions/startRoutineToday from THIS module, so
// this pair is a genuine cycle. It is safe because it is lazy on both sides:
// nothing here calls into routines.js at module-evaluation time (only from
// click handlers and renders), and nothing there calls back into this module at
// evaluation time either. ES modules hoist function declarations across a
// cycle, so both bindings are live by the time either is invoked. The
// alternative — routing these through setTrainActions too — would have meant
// app.js wiring two modules together that already know about each other.
import { getTodayPlan, openRoutinesSheet, renderPlanWeek } from "./routines.js";
import { allSetsFlat, parseIsoDate, removeSessionFromCache, replaceSession, state, todayIso } from "./workoutState.js";
import { cacheSessions, hydrateSessionsFromCache } from "./offline.js";
import { renderCalendar, setOnDateSelected, updateCalendarDots } from "./calendar.js";
import { renderCard } from "./card.js";
import {
  closeActiveSession,
  openActiveSession,
  renderDayDetail,
  selectExercise,
  setExerciseSearch,
  startOrOpenTodaysSession,
} from "./sessionView.js";
import { deleteSession, deleteSet, finishSession, submitSet } from "./setEntry.js";
import { initTrainView, onTrainTabOpened, renderTrain, setTrainActions } from "./trainView.js";

// Re-exported rather than let app.js import trainView.js directly: this module
// is the folder's only public surface, and switchView() needs exactly this one
// function to catch the tab up when it becomes visible.
export { onTrainTabOpened };
import { buildRpeScale } from "./rpeScale.js";
import { initSteppers } from "./stepper.js";
import { initCardio, openCardioSheet, setCardioHandlers } from "./cardio.js";
import { adjustRestTimer, skipRestTimer } from "./restTimer.js";

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Fullscreen open/close
// ---------------------------------------------------------------------------
function openView() {
  el("workout-diary-view").hidden = false;
  lockAppScroll();
  state.calendarCursor = parseIsoDate(state.selectedDate);
  renderCalendar();
  renderDayDetail();
}
function closeView() {
  el("workout-diary-view").hidden = true;
  unlockAppScroll();
  closeActiveSession();
  // The diary overlays whatever view was underneath — usually Train, whose
  // Today card and week strip may both have changed while it was open.
  renderTrain();
}

// `prefillExerciseName`/`prefillReps`: from suggestions.js's "log this
// workout" card or discover.js's exercise-library/workout-plan "Log" action
// — jumps straight to today, ensures a session exists, and opens that
// exercise's set-entry panel directly rather than making the user pick it
// again from the search box.
export function openWorkoutDiary(prefillExerciseName = null, prefillReps = null, prefillCategory = null) {
  state.selectedDate = todayIso();
  state.pendingRoutineExercises = null; // a single-exercise deep link always wins over any stale routine queue
  // Phase 2.1: with the logger on its own surface, a deep link that names an
  // exercise goes STRAIGHT there. Opening the month calendar first and then
  // stacking the session on top of it was an artefact of the two living in one
  // view — it put a screen the user did not ask for between them and the set
  // they came to log, and left two overlapping surfaces to unwind afterwards.
  if (prefillExerciseName) {
    state.pendingPrefill = { exerciseName: prefillExerciseName, reps: prefillReps, category: prefillCategory };
    startOrOpenTodaysSession();
    return;
  }
  state.pendingPrefill = null;
  openView();
}

// Weekly Plan Builder integration (js/routines.js) — "Start" on today's
// planned routine. Ensures/opens today's session exactly like the calendar's
// own "Start workout" button, but seeds the exercise picker with the whole
// routine as tap-to-select suggestion chips (renderRoutineSuggestions above)
// instead of leaving it on a blank search box.
export function startRoutineToday(routine) {
  state.selectedDate = todayIso();
  state.pendingPrefill = null;
  state.pendingRoutineExercises = routine?.exercises || [];
  startOrOpenTodaysSession(); // straight into the logger, not via the calendar
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
export async function loadWorkoutSessions() {
  try {
    state.sessions = await api.listWorkoutSessions();
    // The cache is only ever a picture of what the server last confirmed, so
    // it is written here and nowhere else on this path (Phase 0.4).
    cacheSessions();
  } catch {
    // Previously this set the list to [] — which on a cold OFFLINE open wiped
    // the calendar, the diary, the streak and the Progress-tab card, as if the
    // user had never trained. Falling back to the last cached list shows their
    // real history instead; [] stays the answer only when there is genuinely
    // nothing cached (a first run, or storage unavailable).
    state.sessions = (await hydrateSessionsFromCache()) || [];
  }
  renderCard();
  renderTrain();
  return state.sessions;
}

// ---------------------------------------------------------------------------
// Offline replay hooks (Phase 0.4) — called by app.js's drainWriteQueue() as
// each queued workout write finally reaches the server. Kept here rather than
// in app.js so the folder's state stays owned by the folder: app.js decides
// WHEN a replay happens, this decides what it means to the diary.
// ---------------------------------------------------------------------------
function rerenderAfterSync() {
  renderDayDetail();
  updateCalendarDots();
  renderCard();
  renderTrain();
  cacheSessions();
}

/** A queued create/add came back. `tempSessionId` is passed only for a
 *  replayed session creation, where the local stand-in has a different id from
 *  the row the server just made and has to be dropped rather than updated. */
export function applySyncedWorkoutSession(saved, tempSessionId = null) {
  if (tempSessionId) {
    removeSessionFromCache(tempSessionId);
    // Keep whoever was mid-workout pointed at the same session they were
    // looking at a moment ago, now under its real id.
    if (state.activeSessionId === tempSessionId) state.activeSessionId = saved.id;
  }
  replaceSession(saved);
  rerenderAfterSync();
}

/** A queued write that can never succeed (a real rejection on replay, not a
 *  connectivity failure) — drop the local stand-in rather than leave a row
 *  that will never sync. Mirrors app.js's rollbackNewLog for food. */
export function dropUnsyncableWorkoutSession(tempSessionId) {
  removeSessionFromCache(tempSessionId);
  if (state.activeSessionId === tempSessionId) closeActiveSession();
  rerenderAfterSync();
}

export function getCachedSets() {
  return allSetsFlat();
}
export function getCachedSessions() {
  return state.sessions;
}

// Set by app.js — switchView lives there, and this folder must not import it.
let onOpenTrainTab = null;
export function setOpenTrainTab(fn) {
  onOpenTrainTab = fn;
}

export function initWorkoutDiary() {
  buildRpeScale();
  initTrainView();
  initSteppers();
  initCardio();
  setCardioHandlers({
    onSaved: (saved) => {
      // The response is the whole session, so this is the same reconcile a set
      // write does — one path, not a second one for cardio.
      replaceSession(saved);
      renderDayDetail();
      updateCalendarDots();
      renderCard();
      renderTrain();
      cacheSessions();
    },
    onSession: (session) => {
      replaceSession(session);
      updateCalendarDots();
      renderTrain();
    },
  });

  // The Train tab composes this folder rather than reaching into it: every
  // action it offers is a function that already existed here, injected once.
  // Same seam as calendar.js's onDateSelected, and for the same reason — the
  // tab sits ABOVE these modules, so importing downward would close a cycle.
  setTrainActions({
    startPlanned: (plan) => startRoutineToday(plan),
    startFree: () => {
      // "Free session" and "Start workout" both mean today, unplanned. Reuses
      // startOrOpenTodaysSession's own "a session already exists on this date"
      // handling; the calendar is not involved.
      state.selectedDate = todayIso();
      state.pendingPrefill = null;
      state.pendingRoutineExercises = null;
      startOrOpenTodaysSession();
    },
    openSession: (sessionId) => openActiveSession(sessionId),
    openCalendar: () => openWorkoutDiary(),
    openRoutines: () => openRoutinesSheet(),
    planForToday: () => getTodayPlan(),
    renderWeek: () => renderPlanWeek(),
    openCardio: () => openCardioSheet(),
  });

  // The two things selectDate() used to call directly, before the calendar
  // moved into its own module — see calendar.js's header for why they are
  // injected rather than imported. Same functions, same order, same moment.
  setOnDateSelected(() => {
    renderDayDetail();
    closeActiveSession();
  });

  // Progress tab -> Train tab. It used to open the month-calendar diary
  // directly, which was the only door that existed; now that Train is a real
  // destination, sending a user there instead lands them on the Today card
  // rather than three zones deeper than they asked for.
  el("workout-diary-open-btn").addEventListener("click", () => onOpenTrainTab?.());
  el("workout-diary-close-btn").addEventListener("click", closeView);
  el("ws-close-btn").addEventListener("click", closeActiveSession);

  el("wd-cal-prev").addEventListener("click", () => {
    state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  el("wd-cal-next").addEventListener("click", () => {
    state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() + 1, 1);
    renderCalendar();
  });

  el("wd-start-workout-btn").addEventListener("click", startOrOpenTodaysSession);

  el("wd-session-list").addEventListener("click", (e) => {
    const deleteBtn = e.target.closest("button[data-action='delete-session']");
    const item = e.target.closest(".log-item");
    if (!item) return;
    const id = item.dataset.id;
    if (deleteBtn) {
      deleteSession(id);
      return;
    }
    openActiveSession(id);
  });

  el("wd-delete-session-btn").addEventListener("click", () => {
    if (state.activeSessionId) deleteSession(state.activeSessionId);
  });

  setExerciseSearch(
    createExerciseSearch({
      input: el("wd-exercise-search-input"),
      results: el("wd-exercise-search-results"),
      onSelect: (name, category) => selectExercise(name, category),
    }),
  );

  el("wd-set-entry-form").addEventListener("submit", submitSet);

  el("wd-set-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".wd-set-row-delete");
    if (btn) deleteSet(btn.dataset.setId);
  });

  el("wd-finish-session-btn").addEventListener("click", finishSession);

  el("wd-rest-timer-minus").addEventListener("click", () => adjustRestTimer(-15));
  el("wd-rest-timer-plus").addEventListener("click", () => adjustRestTimer(15));
  el("wd-rest-timer-skip").addEventListener("click", skipRestTimer);

  onLanguageChange(() => {
    renderCard();
    if (!el("workout-diary-view").hidden) {
      renderCalendar();
      renderDayDetail();
      if (state.activeExerciseName) el("wd-current-exercise-name").textContent = translateExerciseName(state.activeExerciseName, getLanguage());
    }
  });
}
