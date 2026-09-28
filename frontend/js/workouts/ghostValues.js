// Ghost values — Hevy-style "what did I lift last time" prefill. Lifted
// verbatim out of workoutDiary.js (Phase 0.3).
import { t } from "../i18n.js";
import { allSetsFlat } from "./workoutState.js";

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Ghost values — Hevy-style prefill ("what did I lift last time"), read
// straight out of the sessions already resident in memory (state.sessions,
// populated once at app boot by loadWorkoutSessions() and kept current by
// replaceSession() on every mutation) rather than a network round trip: the
// full retained history is already local by the time this view can even be
// opened, so this is a synchronous scan over at most a few hundred sets —
// strictly faster than any fetch, and it cannot block the main thread the
// way waiting on a request risks doing on a slow connection.
// ---------------------------------------------------------------------------
export function lastSetFor(exerciseName) {
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

export function clearGhostValues() {
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
export function applyGhostValues(exerciseName) {
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
