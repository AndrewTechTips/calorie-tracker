// The workout reward layer (Phase 4.3) — what, besides a 1RM PR, is worth
// celebrating, and the one guard that keeps a celebration meaningful.
//
// Before this, the gym had exactly ONE celebration: a new estimated 1RM
// (oneRepMaxPanel.js::celebratePr). Everything else a lifter actually feels
// good about — finishing at all, out-lifting every previous session, getting
// through the routine they planned, covering the whole body in a week — was
// silent, despite all four being computable from data already in memory.
//
// THE STANDARD THIS HAD TO MATCH is the PR guard's, and it is worth naming
// because it is the thing that makes any of this worth having: celebratePr
// fires only when there was ALREADY a record to beat, so the very first set
// for a new exercise does not trivially "win". A celebration that fires on
// every action is not a celebration, it is a decoration — and the second time
// a user sees confetti for something unremarkable, none of it means anything
// again. So every condition below carries its own version of that guard:
//
//   volume   — needs MIN_SESSIONS_FOR_VOLUME_RECORD prior finished sessions to
//              have been a record at all, and a non-zero volume (an all
//              bodyweight session has volume 0 and can never "beat" anything).
//   routine  — needs a routine to have actually been planned, and EVERY one of
//              its exercises to carry at least one logged set.
//   coverage — needs the week to have been INCOMPLETE before this session and
//              complete after it. That is what makes it fire once, on the
//              session that closed the gap, rather than on every session for
//              the rest of the week.
//   session  — needs at least one set. Finishing an empty session is not an
//              achievement, and treating it as one is exactly how the whole
//              mechanic gets discounted.
//
// ONE headline per finish. All four are evaluated, the highest-ranked wins the
// confetti and the toast, and Ollie speaks that same one — three simultaneous
// bursts for one tap would read as a bug, and the user could not tell which
// thing they were being congratulated for anyway.
import { showToast, vibrate } from "../ui.js";
import { t } from "../i18n.js";
import { fireConfetti } from "../confetti.js";
import { PetHud } from "../petHud.js";
import { allSetsFlat, state } from "./workoutState.js";
import { computeMuscleHeatmap, MUSCLE_HEATMAP_CATEGORIES } from "./muscleMap.js";

const el = (id) => document.getElementById(id);

// Three is the smallest number for which "your best ever" is a claim rather
// than an artefact of having barely started. At one prior session every second
// workout would be a record; at two, most would.
export const MIN_SESSIONS_FOR_VOLUME_RECORD = 3;

// Highest first. Ranked by how hard each one is to reach, not by how recently
// it was added: an all-time volume record outranks a week's balance, which
// outranks doing the plan you wrote for yourself, which outranks finishing.
const RANK = ["volume", "coverage", "routine", "session"];

function sessionVolume(session) {
  return (session?.sets || []).reduce((sum, s) => sum + (s.weight_kg || 0) * (s.reps || 0), 0);
}

function isFinished(session) {
  return Boolean(session?.ended_at);
}

/** Pure, and exported for exactly that reason: every branch here is a claim
 *  about the user's own history that is cheap to get subtly wrong, and this is
 *  the shape that can be driven from a fixture without a DOM.
 *
 *  `sessions` is the whole cache INCLUDING `session` (which is how it arrives
 *  from setEntry.js, since the finish response is reconciled before this runs);
 *  `routineExercises` is the routine the session was started from, or [] for an
 *  ad-hoc one. */
export function evaluateSessionCelebrations(session, { sessions = [], routineExercises = [] } = {}) {
  const sets = session?.sets || [];
  if (!sets.length) return [];

  const events = [{ kind: "session", sets: sets.length, volume: sessionVolume(session) }];

  // --- volume record ---------------------------------------------------------
  const volume = sessionVolume(session);
  const priorVolumes = sessions
    .filter((s) => s.id !== session.id && isFinished(s))
    .map(sessionVolume)
    .filter((v) => v > 0);
  if (volume > 0 && priorVolumes.length >= MIN_SESSIONS_FOR_VOLUME_RECORD && volume > Math.max(...priorVolumes)) {
    events.push({ kind: "volume", volume, sets: sets.length });
  }

  // --- routine completed -----------------------------------------------------
  const planned = (routineExercises || []).map((ex) => (ex.exercise_name || "").trim().toLowerCase()).filter(Boolean);
  if (planned.length) {
    const logged = new Set(sets.map((s) => (s.exercise_name || "").trim().toLowerCase()));
    if (planned.every((name) => logged.has(name))) {
      events.push({ kind: "routine", routine: session.name || "", sets: sets.length });
    }
  }

  // --- every muscle group covered this week ----------------------------------
  // Measured twice against the SAME function the map draws from, once with this
  // session's sets and once without. Re-deriving "what counts as trained" here
  // would eventually disagree with the map sitting on the screen beside it.
  const all = allSetsFlat();
  const thisSessionSetIds = new Set(sets.map((s) => s.id));
  const before = computeMuscleHeatmap(all.filter((s) => !thisSessionSetIds.has(s.id))).counts;
  const after = computeMuscleHeatmap(all).counts;
  const complete = (counts) => MUSCLE_HEATMAP_CATEGORIES.every((c) => counts[c] > 0);
  if (complete(after) && !complete(before)) {
    events.push({ kind: "coverage", sets: sets.length });
  }

  return events;
}

/** The single highest-ranked event, or null when nothing qualified. */
export function headlineEvent(events) {
  for (const kind of RANK) {
    const found = events.find((e) => e.kind === kind);
    if (found) return found;
  }
  return null;
}

function toastFor(event) {
  switch (event.kind) {
    case "volume":
      return t("workoutDiary.celebrateVolume", { volume: Math.round(event.volume).toLocaleString() });
    case "coverage":
      return t("workoutDiary.celebrateCoverage");
    case "routine":
      return t("workoutDiary.celebrateRoutine");
    default:
      return null; // "session" already has finishSession's own toast
  }
}

/** Called by setEntry.js the moment a finish has been confirmed by the server.
 *
 *  Everything it touches degrades to nothing on its own: fireConfetti already
 *  no-ops under prefers-reduced-motion, PetHud's methods already no-op when the
 *  AI Coach sheet is closed (which it is, for almost every workout), and a
 *  missing anchor element makes the burst radiate from the viewport instead of
 *  failing. So this can never be the reason a finish fails. */
export function celebrateFinishedSession(session, { routineExercises = [] } = {}) {
  const events = evaluateSessionCelebrations(session, { sessions: state.sessions, routineExercises });
  const headline = headlineEvent(events);
  if (!headline) return null;

  // Phase 4.2: Ollie reacts to the gym at last. He speaks for the headline,
  // not for each event — see this file's header.
  PetHud.pulseWorkout(headline);

  const message = toastFor(headline);
  if (message) {
    // The same "achievement unlocked" vocabulary this app already uses for a
    // PR and for a milestone — confetti, the two-beat haptic, a success toast —
    // rather than a second celebration language for the same kind of moment.
    vibrate([20, 60, 20]);
    showToast(message, "success");
    fireConfetti(el("train-today") || el("wd-finish-session-btn"));
  }
  return headline;
}
