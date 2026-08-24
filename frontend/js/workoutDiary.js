// Workout Diary — calendar + session diary + fast, one-handed RPE set entry.
// This app's first genuinely new top-level surface (`.fullscreen-view`, see
// style.css): opened from a compact card in the Progress tab
// (#workout-diary-card), not a bottom-nav tab or a rounded-top sheet — see
// CLAUDE.md's Workout Diary section for why. Owns the whole feature end to
// end (backend/routers/workouts.py's session/set REST surface); progress.js
// only calls loadWorkoutSessions() during its own boot and reads back the
// flattened set list for achievements/PDF export, same "thin context
// object, no circular import" pattern analytics.js/suggestions.js already use.
import { api } from "./api.js";
import {
  deleteWithUndo,
  escapeHtml,
  lockAppScroll,
  reconcileList,
  showToast,
  unlockAppScroll,
  vibrate,
} from "./ui.js";
import { getLanguage, getLocale, onLanguageChange, t } from "./i18n.js";
import { translateCategory, translateExerciseName } from "./exerciseI18n.js";
import { drawTrendLine, setSvgHidden } from "./charts.js";
import { bestOneRepMax, estimateOneRepMax, oneRepMaxSeries } from "./oneRepMax.js";
import { fireConfetti } from "./confetti.js";

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Date helpers — plain local-clock dates (YYYY-MM-DD), matching the plain
// `date` column workout_sessions.session_date is (see sql/schema.sql). This
// is deliberately simpler than app.js's own backend-timezone-aware "local
// today" (routers/day.py): a calendar widget's own "today" marker doesn't
// need to be right down to the same instant a day boundary flips, and
// avoiding that dependency here keeps this module free of a circular
// import into app.js's own state.
// ---------------------------------------------------------------------------
function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function todayIso() {
  return isoDate(new Date());
}
function parseIsoDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let lastSessions = [];
let calendarCursor = parseIsoDate(todayIso()); // day-of-month is ignored, only used for its month/year
let selectedDate = todayIso();
let activeSessionId = null;
let activeExerciseName = null;
let activeExerciseCategory = null;
let selectedRpe = null;
let pendingPrefill = null; // { exerciseName, reps } from suggestions.js/discover.js
// Set by startRoutineToday() (js/routines.js), consumed once by
// openActiveSession() into activeRoutineExercises below — same "transient
// hand-off var, cleared the instant it's read" shape as pendingPrefill.
let pendingRoutineExercises = null;
// Persists for the life of the current active session (cleared in
// closeActiveSession) — this is what showExercisePicker()'s suggestion
// chips actually render from, so they survive tapping between exercises.
let activeRoutineExercises = [];
let exerciseSearchAbort = null;
let exerciseSearchTimeout = null;

function sessionsForDate(dateIso) {
  return lastSessions.filter((s) => s.session_date === dateIso);
}

function findSession(id) {
  return lastSessions.find((s) => s.id === id) || null;
}

function replaceSession(updated) {
  const idx = lastSessions.findIndex((s) => s.id === updated.id);
  if (idx >= 0) lastSessions[idx] = updated;
  else lastSessions.unshift(updated);
}

function removeSessionFromCache(id) {
  lastSessions = lastSessions.filter((s) => s.id !== id);
}

function allSetsFlat() {
  return lastSessions.flatMap((s) => s.sets || []);
}

// ---------------------------------------------------------------------------
// Compact Progress-tab card
// ---------------------------------------------------------------------------
function computeStreakDays() {
  const datesWithSessions = new Set(lastSessions.map((s) => s.session_date));
  let streak = 0;
  const cursor = parseIsoDate(todayIso());
  // Today not yet trained doesn't zero out an otherwise-intact streak — same
  // "today isn't over yet" philosophy backend/services/trends_service.py
  // already applies to the nutrition-adherence streak.
  if (!datesWithSessions.has(isoDate(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (datesWithSessions.has(isoDate(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// Display-only — never touches the dashboard calorie ring's own math (see
// backend/services/analytics_service.py's calculate_tdee_with_logged_activity
// docstring for why burned calories don't offset the daily budget). Used to
// live on the dashboard as its own chip under the ring; relocated here since
// "today's burn" is workout data and belongs next to the rest of the
// Workout Diary summary, not competing with the calorie ring above it.
function todaysBurnedCalories() {
  return lastSessions
    .filter((s) => s.session_date === todayIso())
    .reduce((sum, s) => sum + (s.calories_burned || 0), 0);
}

function renderCard() {
  const empty = el("workout-diary-card-empty");
  const summary = el("workout-diary-card-summary");
  if (!lastSessions.length) {
    empty.hidden = false;
    summary.hidden = true;
    return;
  }
  empty.hidden = true;
  summary.hidden = false;

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 6);
  const weekAgoIso = isoDate(weekAgo);
  const sessionsThisWeek = lastSessions.filter((s) => s.session_date >= weekAgoIso).length;

  const streak = computeStreakDays();
  const mostRecent = [...lastSessions].sort((a, b) => (a.session_date < b.session_date ? 1 : -1))[0];
  const lastExerciseName = mostRecent?.sets?.[mostRecent.sets.length - 1]?.exercise_name;
  const todaysCalories = todaysBurnedCalories();

  const parts = [t("workouts.cardSessionsThisWeek", { count: sessionsThisWeek })];
  if (streak > 0) parts.push(t("workouts.cardStreak", { days: streak }));
  if (todaysCalories > 0) parts.push(t("workouts.cardBurnedToday", { kcal: Math.round(todaysCalories) }));
  if (lastExerciseName) parts.push(t("workouts.cardLastExercise", { name: translateExerciseName(lastExerciseName, getLanguage()) }));
  summary.textContent = parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
// Weekday header built off a known Monday (2024-01-01), so it's correct
// regardless of the current date, and locale-formatted so English/Romanian
// each get their own real weekday abbreviations rather than a hardcoded set.
function renderWeekdayHeader() {
  const container = el("wd-cal-weekdays");
  if (container.childElementCount) return; // static — built once
  const monday = new Date(2024, 0, 1);
  const labels = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    labels.push(d.toLocaleDateString(getLocale(), { weekday: "short" }));
  }
  container.replaceChildren(
    ...labels.map((label) => {
      const span = document.createElement("span");
      span.className = "wd-calendar-weekday";
      span.textContent = label;
      return span;
    }),
  );
}

function renderCalendar() {
  renderWeekdayHeader();
  el("wd-cal-title").textContent = calendarCursor.toLocaleDateString(getLocale(), { month: "long", year: "numeric" });

  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  // Monday-first grid: JS getDay() is 0=Sunday..6=Saturday, shift so Monday=0.
  const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - leadingBlanks);

  const datesWithSessions = new Set(lastSessions.map((s) => s.session_date));
  const todayIsoStr = todayIso();

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    const dateIso = isoDate(date);
    if (i >= 35 && date.getMonth() !== month) break; // 5 full rows already cover every real month; only extend to 6 if the month itself needs it
    cells.push({ date, dateIso, otherMonth: date.getMonth() !== month });
  }

  const grid = el("wd-cal-grid");
  grid.replaceChildren(
    ...cells.map(({ date, dateIso, otherMonth }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wd-calendar-day";
      if (otherMonth) btn.classList.add("wd-other-month");
      if (dateIso === todayIsoStr) btn.classList.add("wd-today");
      if (dateIso === selectedDate) btn.classList.add("wd-selected");
      btn.dataset.date = dateIso;
      btn.textContent = String(date.getDate());
      if (datesWithSessions.has(dateIso)) {
        const dot = document.createElement("span");
        dot.className = "wd-calendar-day-dot";
        btn.appendChild(dot);
      }
      btn.addEventListener("click", () => selectDate(dateIso));
      return btn;
    }),
  );
}

function selectDate(dateIso) {
  selectedDate = dateIso;
  const selectedMonth = parseIsoDate(dateIso);
  if (selectedMonth.getMonth() !== calendarCursor.getMonth() || selectedMonth.getFullYear() !== calendarCursor.getFullYear()) {
    calendarCursor = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), 1);
  }
  renderCalendar();
  renderDayDetail();
  closeActiveSession();
}

// ---------------------------------------------------------------------------
// Day detail — sessions logged on `selectedDate`
// ---------------------------------------------------------------------------
function formatSessionMeta(session) {
  const setCount = (session.sets || []).length;
  const time = new Date(session.started_at).toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" });
  return `${t("workoutDiary.sessionSetsCount", { count: setCount })} · ${time}`;
}

function renderDayDetail() {
  el("wd-day-detail-date").textContent = parseIsoDate(selectedDate).toLocaleDateString(getLocale(), {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const sessions = sessionsForDate(selectedDate);
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

async function startOrOpenTodaysSession() {
  const existing = sessionsForDate(selectedDate)[0];
  if (existing) {
    openActiveSession(existing.id);
    return;
  }
  try {
    const session = await api.createWorkoutSession({ session_date: selectedDate });
    replaceSession(session);
    renderDayDetail();
    renderCalendar();
    renderCard();
    showToast(t("workoutDiary.toastSessionCreated"), "success");
    openActiveSession(session.id);
  } catch (err) {
    showToast(err.message || t("workoutDiary.toastError"), "error");
  }
}

// ---------------------------------------------------------------------------
// Active session workspace
// ---------------------------------------------------------------------------
function closeActiveSession() {
  activeSessionId = null;
  activeExerciseName = null;
  activeExerciseCategory = null;
  el("wd-active-session").hidden = true;
  clearRestTimer();
  el("wd-rest-timer").hidden = true;
  activeRoutineExercises = [];
}

function renderSessionSummary(session) {
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
function renderRoutineSuggestions() {
  const container = el("wd-routine-suggestions");
  if (!activeRoutineExercises.length) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  const session = findSession(activeSessionId);
  const loggedNames = new Set((session?.sets || []).map((s) => s.exercise_name.toLowerCase()));
  const lang = getLanguage();
  container.hidden = false;
  container.replaceChildren(
    ...activeRoutineExercises.map((ex) => {
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

function showExercisePicker() {
  activeExerciseName = null;
  activeExerciseCategory = null;
  el("wd-exercise-picker").hidden = false;
  el("wd-current-exercise-panel").hidden = true;
  el("wd-exercise-search-input").value = "";
  el("wd-exercise-search-results").replaceChildren();
  el("wd-exercise-search-input").focus();
  clearGhostValues();
  renderRoutineSuggestions();
}

function openActiveSession(sessionId) {
  const session = findSession(sessionId);
  if (!session) return;
  activeSessionId = sessionId;
  el("wd-active-session").hidden = false;
  el("wd-active-session-title").textContent = session.name || t("workoutDiary.sessionUntitled");
  renderSessionSummary(session);

  activeRoutineExercises = pendingRoutineExercises || [];
  pendingRoutineExercises = null;

  if (pendingPrefill) {
    const { exerciseName, category, reps } = pendingPrefill;
    pendingPrefill = null;
    selectExercise(exerciseName, category || null);
    if (reps) el("wd-set-reps").value = reps;
  } else {
    showExercisePicker();
  }

  el("wd-active-session").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderSetList() {
  const session = findSession(activeSessionId);
  const sets = (session?.sets || []).filter((s) => s.exercise_name.toLowerCase() === activeExerciseName.toLowerCase());
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

function selectExercise(name, category) {
  activeExerciseName = name;
  activeExerciseCategory = category;
  el("wd-exercise-picker").hidden = true;
  el("wd-current-exercise-panel").hidden = false;
  el("wd-current-exercise-name").textContent = translateExerciseName(name, getLanguage());
  selectedRpe = null;
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

// ---------------------------------------------------------------------------
// Ghost values — Hevy-style prefill ("what did I lift last time"), read
// straight out of the sessions already resident in memory (lastSessions,
// populated once at app boot by loadWorkoutSessions() and kept current by
// replaceSession() on every mutation) rather than a network round trip: the
// full retained history is already local by the time this view can even be
// opened, so this is a synchronous scan over at most a few hundred sets —
// strictly faster than any fetch, and it cannot block the main thread the
// way waiting on a request risks doing on a slow connection.
// ---------------------------------------------------------------------------
function lastSetFor(exerciseName) {
  const name = exerciseName.toLowerCase();
  let best = null;
  let bestTime = -Infinity;
  for (const s of allSetsFlat()) {
    if (s.exercise_name.toLowerCase() !== name) continue;
    const time = new Date(s.logged_at).getTime();
    if (time > bestTime) {
      bestTime = time;
      best = s;
    }
  }
  return best;
}

function clearGhostValues() {
  el("wd-set-weight").placeholder = "";
  el("wd-set-reps").placeholder = "";
  const hint = el("wd-ghost-hint");
  hint.hidden = true;
  hint.textContent = "";
}

// Sets both the native `placeholder` (shown only while the field is empty —
// the fastest, zero-JS-per-keystroke way to surface it) and a small text
// hint alongside it (a placeholder vanishes the instant the field holds any
// value, including the one just typed for this very set, so the hint is
// what stays legible as a "here's what you did last time" reference).
function applyGhostValues(exerciseName) {
  const last = exerciseName ? lastSetFor(exerciseName) : null;
  if (!last) {
    clearGhostValues();
    return;
  }
  el("wd-set-weight").placeholder = String(last.weight_kg);
  el("wd-set-reps").placeholder = String(last.reps);
  const hint = el("wd-ghost-hint");
  hint.textContent =
    last.weight_kg > 0
      ? t("workoutDiary.lastSetHint", { weight: last.weight_kg, reps: last.reps })
      : t("workoutDiary.lastSetHintBodyweight", { reps: last.reps });
  hint.hidden = false;
}

// ---------------------------------------------------------------------------
// Estimated 1RM (Phase 3) — a per-exercise trend, not a per-set one: reads
// every session already cached in lastSessions (same zero-network-cost
// posture as the ghost values above) and reduces it to one best-estimate
// point per session via oneRepMax.js's pure functions. `getCachedSessions()`
// is already sorted newest-first for the calendar's own use; oneRepMaxSeries
// re-sorts to oldest-first, which is what a left-to-right progression chart
// needs.
// ---------------------------------------------------------------------------
function renderOneRepMax(exerciseName) {
  const card = el("wd-onerm-card");
  const series = exerciseName ? oneRepMaxSeries(lastSessions, exerciseName) : [];
  if (!series.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const best = Math.max(...series.map((p) => p.est));
  el("wd-onerm-value").textContent = `${best} kg`;

  const chart = el("wd-onerm-chart");
  if (series.length >= 2) {
    setSvgHidden(chart, false);
    drawTrendLine(chart, series, "est");
  } else {
    setSvgHidden(chart, true);
  }
}

// Fired only on a genuine improvement (see submitSet()'s own guard: there
// must already have been a prior best to beat) — reuses this app's existing
// "achievement unlocked" vocabulary exactly (confetti + haptic pattern +
// toast, see progress.js's renderMilestones) rather than inventing a
// second celebration language for the same kind of moment.
function celebratePr(newEst) {
  vibrate([20, 60, 20]);
  showToast(t("workoutDiary.newPrToast", { est: newEst }), "success");
  const badge = el("wd-onerm-pr-badge");
  fireConfetti(badge);
  badge.classList.remove("wd-onerm-pr-shine");
  void badge.offsetWidth; // restart the CSS animation — a deliberate one-off reflow for a rare, user-triggered celebration, not a per-frame cost
  badge.classList.add("wd-onerm-pr-shine");
}

// ---------------------------------------------------------------------------
// Rest timer — a lightweight countdown, auto-started after every logged set.
// Ticks once a second via setInterval rather than requestAnimationFrame: the
// displayed second only changes once a second, so anything faster (rAF fires
// ~60x/sec) is wasted wake-ups against a phone's CPU/battery for zero visible
// benefit. Tracks an absolute end timestamp instead of decrementing a
// counter, so a tick delayed by a throttled background tab (the phone screen
// locking mid-rest is the common case) self-corrects on its next fire rather
// than drifting permanently. The progress fill is a CSS `transform: scaleX()`
// with a 1s linear transition doing the visual smoothing between those
// once-a-second writes — compositor-only, no layout or paint triggered per
// tick, and the only two DOM writes each second are a textContent swap and a
// single inline style, never a re-render of any list.
// ---------------------------------------------------------------------------
const REST_TIMER_SECONDS = 90;
let restTimer = null; // { endAt, totalMs, intervalId }

function formatRestClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function tickRestTimer() {
  if (!restTimer) return;
  const remainingMs = restTimer.endAt - Date.now();
  if (remainingMs <= 0) {
    finishRestTimer();
    return;
  }
  el("wd-rest-timer-time").textContent = formatRestClock(Math.ceil(remainingMs / 1000));
  el("wd-rest-timer-fill").style.transform = `scaleX(${Math.min(1, remainingMs / restTimer.totalMs)})`;
}

function startRestTimer(seconds = REST_TIMER_SECONDS) {
  clearRestTimer();
  restTimer = { endAt: Date.now() + seconds * 1000, totalMs: seconds * 1000, intervalId: null };
  el("wd-rest-timer").hidden = false;
  tickRestTimer();
  restTimer.intervalId = setInterval(tickRestTimer, 1000);
}

function adjustRestTimer(deltaSeconds) {
  if (!restTimer) return;
  restTimer.endAt += deltaSeconds * 1000;
  tickRestTimer();
}

function clearRestTimer() {
  if (restTimer?.intervalId) clearInterval(restTimer.intervalId);
  restTimer = null;
}

function finishRestTimer() {
  clearRestTimer();
  el("wd-rest-timer").hidden = true;
  vibrate(20);
}

function skipRestTimer() {
  clearRestTimer();
  el("wd-rest-timer").hidden = true;
}

// ---------------------------------------------------------------------------
// Exercise search (reuses the same discover.js/exercise_cache_service.py
// endpoint the Discover tab's own exercise library uses — no separate data
// source for this feature).
// ---------------------------------------------------------------------------
async function runExerciseSearch() {
  const q = el("wd-exercise-search-input").value.trim();
  // A single stray keystroke (q.length === 1) is almost never a useful query
  // against ~400 cached exercise names and just burns a request for a result
  // set the user is about to retype over anyway — skip firing until there's
  // at least 2 characters (an empty query is still allowed through: that's
  // the "show the curated popular list" default, not a search).
  if (q.length === 1) {
    exerciseSearchAbort?.abort();
    return;
  }
  exerciseSearchAbort?.abort();
  exerciseSearchAbort = new AbortController();
  const results = el("wd-exercise-search-results");
  try {
    const exercises = await api.searchExercises(q ? { q } : {}, { signal: exerciseSearchAbort.signal });
    if (!exercises.length) {
      results.innerHTML = `<p class="empty-state">${t("workoutDiary.exerciseSearchEmpty")}</p>`;
      return;
    }
    results.replaceChildren(
      ...exercises.map((ex) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "wd-exercise-result";
        // Display only — the API never sees a translated name/category, see
        // exerciseI18n.js's own header comment.
        const lang = getLanguage();
        btn.innerHTML = `<span class="wd-exercise-result-name">${escapeHtml(translateExerciseName(ex.name, lang))}</span><span class="wd-exercise-result-meta">${escapeHtml(translateCategory(ex.category, lang) || "")}</span>`;
        btn.addEventListener("click", () => selectExercise(ex.name, ex.category || null));
        return btn;
      }),
    );
  } catch (err) {
    if (err.name === "AbortError") return;
    results.innerHTML = `<p class="empty-state">${t("workoutDiary.exerciseSearchEmpty")}</p>`;
  }
}

// 400ms of no typing before a request fires — the search endpoint is rate
// limited (20/minute;6/10 seconds, see backend/routers/discover.py) and this
// input has no submit button, so every keystroke is a candidate trigger;
// without a real debounce a normal typing burst blows through the 6-per-10s
// burst ceiling and the user sees a raw 429. Deliberately on the generous
// end of the 300-500ms band this needs to sit in: aggressively cutting
// request volume matters more here than shaving a bit of perceived latency.
function scheduleExerciseSearch() {
  clearTimeout(exerciseSearchTimeout);
  exerciseSearchTimeout = setTimeout(runExerciseSearch, 400);
}

// ---------------------------------------------------------------------------
// RPE picker — 10 segments, built once; renderRpeSelection() below just
// toggles which one is marked active.
// ---------------------------------------------------------------------------
function buildRpeScale() {
  const container = el("wd-rpe-scale");
  container.replaceChildren(
    ...Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rpe-scale-btn";
      btn.dataset.rpe = String(n);
      btn.textContent = String(n);
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", "false");
      btn.addEventListener("click", () => {
        selectedRpe = selectedRpe === n ? null : n; // tap again to clear — RPE is optional
        renderRpeSelection();
      });
      return btn;
    }),
  );
}
function renderRpeSelection() {
  el("wd-rpe-scale")
    .querySelectorAll(".rpe-scale-btn")
    .forEach((btn) => {
      const active = Number(btn.dataset.rpe) === selectedRpe;
      btn.classList.toggle("wd-rpe-active", active);
      btn.setAttribute("aria-checked", String(active));
    });
}

// ---------------------------------------------------------------------------
// Set entry
// ---------------------------------------------------------------------------
async function submitSet(e) {
  e.preventDefault();
  const weightKg = el("wd-set-weight").value === "" ? 0 : Number(el("wd-set-weight").value);
  const reps = Number(el("wd-set-reps").value);
  if (!reps) return;

  // Captured *before* the write, from whatever is already cached — this is
  // "was there already a record to beat", so it must reflect history only,
  // never the set about to be added.
  const priorBest = bestOneRepMax(allSetsFlat().filter((s) => s.exercise_name.toLowerCase() === activeExerciseName.toLowerCase()));

  const payload = { exercise_name: activeExerciseName, category: activeExerciseCategory, reps, weight_kg: weightKg, rpe: selectedRpe };
  try {
    const session = await api.addWorkoutSet(activeSessionId, payload);
    replaceSession(session);
    renderSessionSummary(session);
    renderSetList();
    renderDayDetail();
    renderCalendar();
    renderCard();
    vibrate(12);
    // Weight/reps deliberately kept as-is (fast consecutive straight sets are
    // then a single tap); only RPE resets, since perceived effort can
    // legitimately differ set to set.
    selectedRpe = null;
    renderRpeSelection();
    applyGhostValues(activeExerciseName); // now reflects the set just logged
    renderOneRepMax(activeExerciseName);
    startRestTimer();
    // Only a genuine improvement over an *existing* record counts — the
    // very first set ever logged for a brand new exercise trivially "beats"
    // nothing, and celebrating that would just be noise.
    const newEst = estimateOneRepMax(weightKg, reps);
    if (newEst != null && priorBest != null && newEst > priorBest) celebratePr(newEst);
  } catch (err) {
    showToast(err.message || t("workoutDiary.toastError"), "error");
  }
}

async function deleteSet(setId) {
  try {
    const session = await api.deleteWorkoutSet(setId);
    replaceSession(session);
    renderSessionSummary(session);
    renderSetList();
    renderDayDetail();
    renderCalendar();
    renderCard();
    // Deleting the most recent set changes what "last time" means for this
    // exercise (falls back to the one before it, or clears entirely) — same
    // refresh submitSet() already does after adding one.
    applyGhostValues(activeExerciseName);
    renderOneRepMax(activeExerciseName); // the deleted set may have been the exercise's best estimate
    showToast(t("workoutDiary.toastSetDeleted"), "success");
  } catch (err) {
    showToast(err.message || t("workoutDiary.toastError"), "error");
  }
}

async function finishSession() {
  if (!activeSessionId) return;
  try {
    const session = await api.finishWorkoutSession(activeSessionId);
    replaceSession(session);
    renderDayDetail();
    renderCalendar();
    renderCard();
    showToast(t("workoutDiary.toastSessionFinished"), "success");
    closeActiveSession();
  } catch (err) {
    showToast(err.message || t("workoutDiary.toastError"), "error");
  }
}

function deleteSession(id) {
  const previous = lastSessions;
  deleteWithUndo({
    removeNow: () => {
      removeSessionFromCache(id);
      if (activeSessionId === id) closeActiveSession();
      renderDayDetail();
      renderCalendar();
      renderCard();
    },
    restore: () => {
      lastSessions = previous;
      renderDayDetail();
      renderCalendar();
      renderCard();
    },
    callDelete: () => api.deleteWorkoutSession(id),
    removedToastKey: "workoutDiary.toastSessionDeleted",
    revertToastKey: "workoutDiary.toastError",
  });
}

// ---------------------------------------------------------------------------
// Fullscreen open/close
// ---------------------------------------------------------------------------
function openView() {
  el("workout-diary-view").hidden = false;
  lockAppScroll();
  calendarCursor = parseIsoDate(selectedDate);
  renderCalendar();
  renderDayDetail();
}
function closeView() {
  el("workout-diary-view").hidden = true;
  unlockAppScroll();
  closeActiveSession();
}

// `prefillExerciseName`/`prefillReps`: from suggestions.js's "log this
// workout" card or discover.js's exercise-library/workout-plan "Log" action
// — jumps straight to today, ensures a session exists, and opens that
// exercise's set-entry panel directly rather than making the user pick it
// again from the search box.
export function openWorkoutDiary(prefillExerciseName = null, prefillReps = null, prefillCategory = null) {
  selectedDate = todayIso();
  pendingPrefill = prefillExerciseName ? { exerciseName: prefillExerciseName, reps: prefillReps, category: prefillCategory } : null;
  pendingRoutineExercises = null; // a single-exercise deep link always wins over any stale routine queue
  openView();
  if (pendingPrefill) {
    startOrOpenTodaysSession();
  }
}

// Weekly Plan Builder integration (js/routines.js) — "Start" on today's
// planned routine. Ensures/opens today's session exactly like the calendar's
// own "Start workout" button, but seeds the exercise picker with the whole
// routine as tap-to-select suggestion chips (renderRoutineSuggestions above)
// instead of leaving it on a blank search box.
export function startRoutineToday(routine) {
  selectedDate = todayIso();
  pendingPrefill = null;
  pendingRoutineExercises = routine?.exercises || [];
  openView();
  startOrOpenTodaysSession();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
export async function loadWorkoutSessions() {
  try {
    lastSessions = await api.listWorkoutSessions();
  } catch {
    lastSessions = [];
  }
  renderCard();
  return lastSessions;
}

export function getCachedSets() {
  return allSetsFlat();
}
export function getCachedSessions() {
  return lastSessions;
}

export function initWorkoutDiary() {
  buildRpeScale();

  el("workout-diary-open-btn").addEventListener("click", () => openWorkoutDiary());
  el("workout-diary-close-btn").addEventListener("click", closeView);

  el("wd-cal-prev").addEventListener("click", () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  el("wd-cal-next").addEventListener("click", () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
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
    if (activeSessionId) deleteSession(activeSessionId);
  });

  el("wd-exercise-search-input").addEventListener("input", scheduleExerciseSearch);
  el("wd-exercise-search-input").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const name = el("wd-exercise-search-input").value.trim();
    if (name) selectExercise(name, null);
  });

  el("wd-change-exercise-btn").addEventListener("click", showExercisePicker);
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
      if (activeExerciseName) el("wd-current-exercise-name").textContent = translateExerciseName(activeExerciseName, getLanguage());
    }
  });
}
