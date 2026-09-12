// Momentum score + tier — the pure math behind the Progress tab's hero
// (js/progress.js, Phase 1) and its weekly history (js/weekHistory.js,
// Phase 2). Extracted into one place so both share a single definition and
// it stays unit-testable in isolation (see momentumMath.test in the QA
// sweep). No imports, no DOM, no i18n.
//
// The model: a 0–100 score accumulated forward over a 7-day window. An
// adherent day speeds it up, a logged-but-off day nudges it, an un-logged
// day only ever coasts it down — it can't reset to zero, so one missed day
// is nearly invisible. Constants tuned for the 7-slot window: ~6 adherent
// days reaches "Flying", an all-logged-but-off week lands around "Rolling",
// a window with no logging at all sits at a true 0 ("Just starting").

const MOMENTUM_TIERS = [
  { min: 85, key: "Flying" },
  { min: 60, key: "InGroove" },
  { min: 35, key: "Rolling" },
  { min: 12, key: "FindingFeet" },
  { min: 0, key: "JustStarting" },
];

const ON_TRACK_GAIN = 16; // adherent day: logged AND calories within ±10% of target
const LOGGED_GAIN = 5; // logged something but off target — showing up still counts for a little
const FIRST_MISS_DROP = 4; // first un-logged day after activity — "one bad day barely shows"
const MISS_DROP = 10; // each further consecutive un-logged day
const FLOOR = 4; // once there's momentum, it never fully empties — no zero to dread

// `key` is the i18n suffix for the tier name (progress.momentumTier<Key>),
// Ollie's live line (progress.momentumInsight<Key>) and the week nudge.
export function momentumTier(score) {
  return MOMENTUM_TIERS.find((band) => score >= band.min) || MOMENTUM_TIERS[MOMENTUM_TIERS.length - 1];
}

// days: chronological, oldest first. Each entry needs `adherent` (bool) plus
// a "was anything logged" signal — the live Progress hero passes
// `{ calories }` from GET /trends, a finished-week snapshot passes
// `{ logged }` (it doesn't keep calorie totals). Both are accepted.
//
// finalDayComplete:
//   false (default, the live hero) — the last entry is "today" and isn't
//     over yet, so an empty today is skipped rather than judged, exactly
//     like trends_service.py's own streak rule.
//   true (a finished-week snapshot) — its last day is a completed day and
//     is judged normally.
export function computeMomentum(days, targetCalories, { finalDayComplete = false } = {}) {
  if (!days?.length || !targetCalories) {
    return { score: 0, tier: momentumTier(0), onTrackDays: 0, judgedDays: 0, anyActivity: false };
  }
  let score = 0;
  let onTrackDays = 0;
  let judgedDays = 0;
  let anyActivity = false;
  let consecutiveMisses = 0;

  days.forEach((day, i) => {
    const isLast = i === days.length - 1;
    const hasLogs = (day.calories || 0) > 0 || day.logged === true;
    if (isLast && !finalDayComplete && !hasLogs) return; // today isn't over yet
    if (!hasLogs && !anyActivity) return; // window hasn't started — a leading gap isn't a setback

    judgedDays += 1;
    if (hasLogs) {
      anyActivity = true;
      consecutiveMisses = 0;
      if (day.adherent) {
        score = Math.min(100, score + ON_TRACK_GAIN);
        onTrackDays += 1;
      } else {
        score = Math.min(100, score + LOGGED_GAIN);
      }
    } else {
      consecutiveMisses += 1;
      score = Math.max(FLOOR, score - (consecutiveMisses === 1 ? FIRST_MISS_DROP : MISS_DROP));
    }
  });

  if (!anyActivity) score = 0; // the FLOOR only applies once there's real momentum to keep

  return { score: Math.round(score), tier: momentumTier(score), onTrackDays, judgedDays, anyActivity };
}
