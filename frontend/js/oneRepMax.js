// Estimated 1RM (Phase 3 of the openGym-inspired training upgrade) — pure
// math only, same "no DOM, no network, independently reasoned-about" shape
// as nutritionMath.js. Deliberately knows nothing about sessions/exercises
// as objects: it takes plain weight/reps numbers and plain set arrays, so
// workoutDiary.js stays the only place that knows how those map onto a
// session/exercise.
//
// Epley (1985): 1RM = weight * (1 + reps / 30). The one most lifters have
// already seen, and simple enough that its own error profile is easy to
// reason about. A single rep is a measurement, not an estimate, so reps===1
// returns the weight itself unchanged rather than running it through the
// formula.
//
// Above ONE_RM_REP_CAP, submaximal-load estimators diverge sharply from each
// other and from reality — this app would rather show nothing than a
// confidently-wrong number, so estimateOneRepMax returns null past the cap
// (and for any other input it can't honestly answer: zero/negative weight,
// zero reps, non-finite input).
export const ONE_RM_REP_CAP = 12;

export function estimateOneRepMax(weightKg, reps) {
  const weight = Number(weightKg);
  const repCount = Math.round(Number(reps));
  if (!isFinite(weight) || !isFinite(repCount)) return null;
  if (weight <= 0 || repCount < 1 || repCount > ONE_RM_REP_CAP) return null;
  const estimate = repCount === 1 ? weight : weight * (1 + repCount / 30);
  return Math.round(estimate * 10) / 10;
}

// The single best (highest-estimate) set out of a flat list of {weight_kg,
// reps} — used both for "what's the headline Est. 1RM number" and for PR
// detection (compare a fresh estimate against the best of everything
// logged *before* it).
export function bestOneRepMax(sets) {
  let best = null;
  for (const s of sets || []) {
    const est = estimateOneRepMax(s.weight_kg, s.reps);
    if (est != null && (best == null || est > best)) best = est;
  }
  return best;
}

// One point per session for a given exercise — not one point per set, which
// would just be visual noise from ordinary same-session rep variation. Each
// point is that session's own best estimate, in session order (oldest
// first), which is what a "1RM over time" trend line should actually plot.
// `sessions` is the same shape workoutDiary.js already caches
// (getCachedSessions()): [{ session_date, sets: [...] }], already sorted
// newest-first in that cache, so this re-sorts to oldest-first for the chart.
export function oneRepMaxSeries(sessions, exerciseName) {
  const name = exerciseName.toLowerCase();
  const points = [];
  for (const session of sessions || []) {
    const matching = (session.sets || []).filter((s) => s.exercise_name.toLowerCase() === name);
    if (!matching.length) continue;
    const est = bestOneRepMax(matching);
    if (est != null) points.push({ date: session.session_date, est });
  }
  return points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
