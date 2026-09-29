// A client-side mirror of backend/services/cardio_service.py, for the LIVE
// estimate only.
//
// WHY THIS DUPLICATION EXISTS, AND WHY IT IS THE LESSER EVIL
// ----------------------------------------------------------
// The cardio sheet's whole point is that the figure moves as you adjust speed,
// incline or watts — that is what makes the inputs feel connected to the
// answer instead of being a form you fill in and submit. Two ways to get that:
//
//   * ask the backend on every keystroke — a network round trip per digit,
//     which is unusable on gym wifi and pointless load besides; or
//   * compute it here.
//
// So it is computed here, and the DUPLICATION IS HAND-SYNCED — the same
// discipline CLAUDE.md already documents for VAPID_PUBLIC_KEY across
// config.js/sw.js and RETENTION_DAYS across config.py/schema.sql. If an
// equation or constant changes on either side, it must change on both.
//
// Two things keep that from being as fragile as it sounds:
//
//   1. THE BACKEND IS STILL AUTHORITATIVE. Nothing here is ever stored. The
//      figure written to cardio_sessions is the one cardio_service.py
//      computed, and the sheet shows the server's number once saved. A drift
//      between the two would show up as the preview disagreeing with the saved
//      row — visible, not silent.
//   2. BOTH SIDES ARE PINNED TO THE PUBLISHED EQUATIONS, not to each other.
//      tests/test_cardio_service.py and the harness cases for this file assert
//      the SAME hand-computed values, taken from the equation forms rather
//      than from either implementation. Two independent checks against one
//      external truth is a stronger guarantee than either one checked against
//      the other.

export const KCAL_PER_L_O2 = 5.0;
export const RESTING_VO2 = 3.5;
export const WATT_TO_KGM_PER_MIN = 6.12;
export const WALK_RUN_THRESHOLD_M_MIN = 107.0;
export const DEFAULT_STEP_HEIGHT_M = 0.2032;

const WALK_VALID_M_MIN = [50.0, 100.0];
const RUN_VALID_M_MIN = [134.0, 300.0];
const STEP_VALID_PER_MIN = [12.0, 30.0];
const ERGOMETRY_VALID_WATTS = [50.0, 200.0];

const ELLIPTICAL_MET_MIN = 4.5;
const ELLIPTICAL_MET_MAX = 9.5;
const ELLIPTICAL_MAX_RESISTANCE = 20.0;

const num = (v) => (v === "" || v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));
const atLeastResting = (vo2) => Math.max(vo2, RESTING_VO2);
const outside = (value, [lo, hi]) => value < lo || value > hi;

export const kmhToMMin = (kmh) => (kmh * 1000) / 60;

export function walkingVo2(speedMMin, gradeFraction) {
  return atLeastResting(0.1 * speedMMin + 1.8 * speedMMin * gradeFraction + RESTING_VO2);
}
export function runningVo2(speedMMin, gradeFraction) {
  return atLeastResting(0.2 * speedMMin + 0.9 * speedMMin * gradeFraction + RESTING_VO2);
}
export function steppingVo2(stepsPerMin, stepHeightM) {
  return atLeastResting(0.2 * stepsPerMin + 1.33 * 1.8 * stepHeightM * stepsPerMin + RESTING_VO2);
}
export function legErgometryVo2(watts, weightKg) {
  if (weightKg <= 0) return RESTING_VO2;
  return atLeastResting((1.8 * (watts * WATT_TO_KGM_PER_MIN)) / weightKg + RESTING_VO2 + RESTING_VO2);
}
/** Concept2's published relation: watts = 2.80 / pace^3, pace in seconds per
 *  metre. A 2:00/500m split is ~203 W. */
export function splitToWatts(splitSecondsPer500m) {
  if (splitSecondsPer500m <= 0) return 0;
  const paceSPerM = splitSecondsPer500m / 500;
  return 2.8 / paceSPerM ** 3;
}
export function ellipticalVo2(resistance) {
  let met;
  if (resistance === null || resistance === undefined || resistance === "") {
    met = (ELLIPTICAL_MET_MIN + ELLIPTICAL_MET_MAX) / 2;
  } else {
    const fraction = Math.min(Math.max(Number(resistance), 0), ELLIPTICAL_MAX_RESISTANCE) / ELLIPTICAL_MAX_RESISTANCE;
    met = ELLIPTICAL_MET_MIN + fraction * (ELLIPTICAL_MET_MAX - ELLIPTICAL_MET_MIN);
  }
  return met * RESTING_VO2;
}

export function vo2ToKcal(vo2, weightKg, durationMinutes, net = true) {
  const effective = Math.max(net ? vo2 - RESTING_VO2 : vo2, 0);
  return ((effective * weightKg) / 1000) * KCAL_PER_L_O2 * durationMinutes;
}
export const vo2ToMet = (vo2) => vo2 / RESTING_VO2;

function treadmill(params) {
  const speed = kmhToMMin(num(params.speed_kmh));
  const grade = num(params.incline_percent) / 100;
  if (speed >= WALK_RUN_THRESHOLD_M_MIN) {
    return { vo2: runningVo2(speed, grade), equationId: "acsm_running", estimate: outside(speed, RUN_VALID_M_MIN) };
  }
  return { vo2: walkingVo2(speed, grade), equationId: "acsm_walking", estimate: outside(speed, WALK_VALID_M_MIN) };
}

function stairmaster(params) {
  let steps = params.steps_per_min;
  if ((steps === undefined || steps === null || steps === "") && params.floors_per_hour) {
    steps = (num(params.floors_per_hour) * 16) / 60; // 16 steps to a floor
  }
  steps = num(steps);
  const height = num(params.step_height_m) || DEFAULT_STEP_HEIGHT_M;
  return { vo2: steppingVo2(steps, height), equationId: "acsm_stepping", estimate: outside(steps, STEP_VALID_PER_MIN) };
}

function bike(params, weightKg) {
  const watts = num(params.watts);
  return {
    vo2: legErgometryVo2(watts, weightKg),
    equationId: "acsm_leg_ergometry",
    estimate: outside(watts, ERGOMETRY_VALID_WATTS),
  };
}

function rower(params, weightKg) {
  let watts = params.watts;
  let equationId = "acsm_leg_ergometry_adapted";
  if ((watts === undefined || watts === null || watts === "") && params.split_seconds) {
    watts = splitToWatts(num(params.split_seconds));
    equationId = "concept2_split_to_watts";
  }
  // Always an estimate: the split -> watts step is exact, the watts -> VO2 step
  // borrows an equation validated on a leg ergometer, and a rowing stroke
  // recruits more than legs.
  return { vo2: legErgometryVo2(num(watts), weightKg), equationId, estimate: true };
}

function elliptical(params) {
  return { vo2: ellipticalVo2(params.resistance), equationId: "met_band_elliptical", estimate: true };
}

function outdoor(params, weightKg) {
  let speed = params.speed_kmh;
  if ((speed === undefined || speed === null || speed === "") && params.distance_km && params.duration_minutes) {
    const hours = num(params.duration_minutes) / 60;
    speed = hours > 0 ? num(params.distance_km) / hours : 0;
  }
  return treadmill({ ...params, speed_kmh: speed || 0 }, weightKg);
}

const MACHINES = {
  treadmill,
  stairmaster,
  stepmill: stairmaster,
  bike,
  cycling: bike,
  rower,
  rowing: rower,
  elliptical,
  outdoor,
  walk: outdoor,
  run: outdoor,
};

/** Mirrors cardio_service.estimate_cardio's return shape. Degrades the same
 *  way: no machine, no inputs or a zero duration all give a zero-kcal answer
 *  rather than throwing, because this runs on every keystroke and the empty
 *  form is the normal first state. */
export function estimateCardio(machine, params = {}, weightKg, durationMinutes, { net = true } = {}) {
  const zero = { kcal: 0, met: 0, vo2: 0, equationId: "invalid_input", isEstimate: true, basis: net ? "net" : "gross" };
  if (!(durationMinutes > 0) || !(weightKg > 0)) return zero;
  const handler = MACHINES[(machine || "").trim().toLowerCase()];
  if (!handler) return zero;
  const { vo2, equationId, estimate } = handler(params, weightKg);
  return {
    kcal: Math.round(vo2ToKcal(vo2, weightKg, durationMinutes, net) * 10) / 10,
    met: Math.round(vo2ToMet(vo2) * 100) / 100,
    vo2: Math.round(vo2 * 100) / 100,
    equationId,
    isEstimate: estimate,
    basis: net ? "net" : "gross",
  };
}

/** Total across a list of segments. Each is priced INDEPENDENTLY and the
 *  results summed — averaging a warm-up with the work would understate the
 *  session by more than the warm-up was worth, which is why segments exist. */
export function estimateSegments(segments, weightKg, { net = true } = {}) {
  let kcal = 0;
  let minutes = 0;
  let anyEstimate = false;
  for (const seg of segments) {
    const out = estimateCardio(seg.machine, seg.params, weightKg, Number(seg.duration_minutes) || 0, { net });
    kcal += out.kcal;
    minutes += Number(seg.duration_minutes) || 0;
    if (out.isEstimate) anyEstimate = true;
  }
  return { kcal: Math.round(kcal * 10) / 10, minutes, isEstimate: anyEstimate };
}
