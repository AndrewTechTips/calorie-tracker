// Workout Diary — the one piece of mutable state every other module in this
// folder reads and writes, plus the tiny pure helpers over it.
//
// Split out of the old single-file workoutDiary.js (Phase 0.3). It was nine
// module-level `let`s closed over by every function in a 900-line file; once
// those functions live in separate modules that no longer works, because an
// imported binding is read-only on the importing side. One exported object
// whose PROPERTIES are mutable is the same shape app.js already uses for the
// app's own state, so this is the codebase's existing idiom rather than a new
// one. No DOM and no sibling imports: this is the bottom of the folder's
// dependency graph, which is what keeps the rest of it free of cycles.

// ---------------------------------------------------------------------------
// Date helpers — plain local-clock dates (YYYY-MM-DD), matching the plain
// `date` column workout_sessions.session_date is (see sql/schema.sql). This
// is deliberately simpler than app.js's own backend-timezone-aware "local
// today" (routers/day.py): a calendar widget's own "today" marker doesn't
// need to be right down to the same instant a day boundary flips, and
// avoiding that dependency here keeps this module free of a circular
// import into app.js's own state.
// ---------------------------------------------------------------------------
export function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
export function todayIso() {
  return isoDate(new Date());
}
export function parseIsoDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export const state = {
  /** Every session in the retained window, newest-first, as
   *  loadWorkoutSessions() fetched them and every mutation keeps them. */
  sessions: [],
  /** Day-of-month is ignored — only used for its month/year. */
  calendarCursor: parseIsoDate(todayIso()),
  selectedDate: todayIso(),
  activeSessionId: null,
  activeExerciseName: null,
  activeExerciseCategory: null,
  /** { exerciseName, reps, category } from suggestions.js/discover.js. */
  pendingPrefill: null,
  /** Set by startRoutineToday() (js/routines.js), consumed once by
   *  openActiveSession() into activeRoutineExercises below — same "transient
   *  hand-off var, cleared the instant it's read" shape as pendingPrefill. */
  pendingRoutineExercises: null,
  /** Persists for the life of the current active session (cleared in
   *  closeActiveSession) — this is what showExercisePicker()'s suggestion
   *  chips actually render from, so they survive tapping between exercises. */
  activeRoutineExercises: [],
};

export function sessionsForDate(dateIso) {
  return state.sessions.filter((s) => s.session_date === dateIso);
}

export function findSession(id) {
  return state.sessions.find((s) => s.id === id) || null;
}

export function replaceSession(updated) {
  const idx = state.sessions.findIndex((s) => s.id === updated.id);
  if (idx >= 0) state.sessions[idx] = updated;
  else state.sessions.unshift(updated);
}

export function removeSessionFromCache(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
}

export function allSetsFlat() {
  return state.sessions.flatMap((s) => s.sets || []);
}

// The one thing in the grid that depends on logged data: which dates have at
// least one session. Shared by calendar.js's full rebuild and its targeted
// dot sync so the two can never disagree about what a dot means.
export function sessionDateSet() {
  return new Set(state.sessions.map((s) => s.session_date));
}
