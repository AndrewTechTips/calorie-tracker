// The compact Workout Diary summary card that lives in the Progress tab
// (#workout-diary-card), not inside the fullscreen view — hence its own module.
// Lifted verbatim out of workoutDiary.js (Phase 0.3).
import { getLanguage, t } from "../i18n.js";
import { translateExerciseName } from "../exerciseI18n.js";
import { isoDate, parseIsoDate, sessionDateSet, state, todayIso } from "./workoutState.js";

const el = (id) => document.getElementById(id);

// Compact Progress-tab card
// ---------------------------------------------------------------------------
export function computeStreakDays() {
  const datesWithSessions = sessionDateSet();
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
  return state.sessions
    .filter((s) => s.session_date === todayIso())
    .reduce((sum, s) => sum + (s.calories_burned || 0), 0);
}

export function renderCard() {
  const empty = el("workout-diary-card-empty");
  const summary = el("workout-diary-card-summary");
  if (!state.sessions.length) {
    empty.hidden = false;
    summary.hidden = true;
    return;
  }
  empty.hidden = true;
  summary.hidden = false;

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 6);
  const weekAgoIso = isoDate(weekAgo);
  const sessionsThisWeek = state.sessions.filter((s) => s.session_date >= weekAgoIso).length;

  const streak = computeStreakDays();
  const mostRecent = [...state.sessions].sort((a, b) => (a.session_date < b.session_date ? 1 : -1))[0];
  const lastExerciseName = mostRecent?.sets?.[mostRecent.sets.length - 1]?.exercise_name;
  const todaysCalories = todaysBurnedCalories();

  const parts = [t("workouts.cardSessionsThisWeek", { count: sessionsThisWeek })];
  if (streak > 0) parts.push(t("workouts.cardStreak", { days: streak }));
  if (todaysCalories > 0) parts.push(t("workouts.cardBurnedToday", { kcal: Math.round(todaysCalories) }));
  if (lastExerciseName) parts.push(t("workouts.cardLastExercise", { name: translateExerciseName(lastExerciseName, getLanguage()) }));
  summary.textContent = parts.join(" · ");
}
