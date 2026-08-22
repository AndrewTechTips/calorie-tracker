// Workout Diary — calendar + session diary + fast, one-handed RPE set entry.
// This app's first genuinely new top-level surface (`.fullscreen-view`, see
// style.css): opened from a compact card in the Progress tab
// (#workout-diary-card), not a bottom-nav tab or a rounded-top sheet — see
// CLAUDE.md's Workout Diary section for why. Owns the whole feature end to
// end (backend/routers/workouts.py's session/set REST surface); progress.js
// only calls loadWorkoutSessions() during its own boot and reads back the
// flattened set list for achievements/PDF export, same "thin context
// object, no circular import" pattern analytics.js/suggestions.js already use.
import { api } from "./api.js?v=20260822b";
import {
  deleteWithUndo,
  escapeHtml,
  lockAppScroll,
  reconcileList,
  showToast,
  unlockAppScroll,
  vibrate,
} from "./ui.js?v=20260822b";
import { getLanguage, getLocale, onLanguageChange, t } from "./i18n.js?v=20260822b";
import { translateCategory, translateExerciseName } from "./exerciseI18n.js?v=20260822b";

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

function showExercisePicker() {
  activeExerciseName = null;
  activeExerciseCategory = null;
  el("wd-exercise-picker").hidden = false;
  el("wd-current-exercise-panel").hidden = true;
  el("wd-exercise-search-input").value = "";
  el("wd-exercise-search-results").replaceChildren();
  el("wd-exercise-search-input").focus();
}

function openActiveSession(sessionId) {
  const session = findSession(sessionId);
  if (!session) return;
  activeSessionId = sessionId;
  el("wd-active-session").hidden = false;
  el("wd-active-session-title").textContent = session.name || t("workoutDiary.sessionUntitled");
  renderSessionSummary(session);

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
  openView();
  if (pendingPrefill) {
    startOrOpenTodaysSession();
  }
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

  onLanguageChange(() => {
    renderCard();
    if (!el("workout-diary-view").hidden) {
      renderCalendar();
      renderDayDetail();
      if (activeExerciseName) el("wd-current-exercise-name").textContent = translateExerciseName(activeExerciseName, getLanguage());
    }
  });
}
