import { t } from "./i18n.js?v=20260810i";

// Turns today's totals-vs-targets into one short, professional-macro-coach
// style message — not just a calorie number, but one that reacts to *which*
// macro actually needs attention (low protein, carbs/fats already maxed,
// which macro drove an overage). Tone drives the banner color in ui.js; the
// thresholds below are deliberately simple (percentage-of-target bands)
// rather than a "smart" model — this is a UI status line, not another AI
// call, so it has to be instant and free every time it renders.
const OVERAGE_ATTRIBUTION_THRESHOLD = 1.15; // a macro has to be >15% over its own target to get named specifically
const PROTEIN_BEHIND_MIDDAY = 0.4; // >40% of protein target still remaining, with the day half-spent
const PROTEIN_BEHIND_EARLY = 0.7; // >70% still remaining, early in the day — just a gentle nudge
const PROTEIN_BEHIND_LATE = 0.15; // >15% still remaining, day almost over — this one's urgent
const FATS_DISCIPLINE_THRESHOLD = 0.75; // fats at/under 75% of target — worth calling out as real discipline, not just "not over yet"

// Picks one of N phrasings for the same status, stable for the whole
// calendar day (so the banner doesn't flicker between variants on every
// re-render) but rotating day to day — otherwise a user sitting in the same
// pace bracket for a week reads the literal same sentence every single time,
// which is what reads as canned/AI-generated rather than a coach actually
// looking at today's numbers. `key` is used bare for variant 0 (keeping
// every existing i18n key/string as-is) and as `${key}2`, `${key}3`, ... for
// the rest.
function tv(key, variantCount, vars) {
  if (variantCount <= 1) return t(key, vars);
  const dayIndex = Math.floor(Date.now() / 86400000);
  const variant = dayIndex % variantCount;
  return t(variant === 0 ? key : `${key}${variant + 1}`, vars);
}

// Protein goal hit is always good news, but it's better news specifically
// when it didn't come at the cost of also maxing out fats — that combination
// (full protein, fats still in check) is the actual behavior worth
// reinforcing for hypertrophy, so it gets its own, more specific message
// instead of the plain "protein goal hit" one. Shared by every pct band
// below instead of repeating the same branch three times.
function proteinGoalMessage(remaining, fatsConsumedPct, fatsTarget) {
  if (fatsTarget > 0 && fatsConsumedPct <= FATS_DISCIPLINE_THRESHOLD) {
    return { tone: "success", icon: "trophy", text: tv("status.dialedIn", 2, { remaining }) };
  }
  return { tone: "success", icon: "trophy", text: tv("status.proteinGoalHit", 2, { remaining }) };
}

export function getCalorieStatus(totals, targets) {
  const calTarget = targets.daily_calories || 1;
  const calRemaining = calTarget - totals.calories;
  const pct = totals.calories / calTarget;

  const proteinTarget = targets.daily_protein || 0;
  const carbsTarget = targets.daily_carbs || 0;
  const fatsTarget = targets.daily_fats || 0;
  const proteinRemaining = Math.max(Math.round(proteinTarget - totals.protein), 0);
  const proteinRemainingPct = proteinTarget > 0 ? (proteinTarget - totals.protein) / proteinTarget : 0;
  const carbsConsumedPct = carbsTarget > 0 ? totals.carbs / carbsTarget : 0;
  const fatsConsumedPct = fatsTarget > 0 ? totals.fats / fatsTarget : 0;

  // Over calories: name whichever of carbs/fats actually drove it, when one
  // clearly did. Protein overage is deliberately never named here — running
  // extra protein isn't really a "problem" the way extra carbs/fats can be,
  // so it just falls back to the generic message instead of something
  // backwards-sounding like "you had too much protein."
  //
  // On a bulk goal, this whole outcome flips: a surplus is the actual point,
  // not a slip-up, so it gets its own reframed message instead of the
  // cautionary ones below. "cut" and "maintain" (the default — so anyone who
  // never sets a goal type sees zero behavior change here) keep exactly
  // today's existing copy; this is deliberately the *only* place goal_type
  // changes anything, to keep the effect small and easy to reason about.
  const isCut = targets.goal_type === "cut";

  if (calRemaining < -0.5) {
    const over = Math.round(-calRemaining);
    if (targets.goal_type === "bulk") {
      return { tone: "success", icon: "flame", text: t("status.overCaloriesBulk", { over }) };
    }
    if (carbsConsumedPct > OVERAGE_ATTRIBUTION_THRESHOLD && carbsConsumedPct >= fatsConsumedPct) {
      return { tone: "danger", icon: "alert", text: t(isCut ? "status.overCarbsCut" : "status.overCarbs", { over }) };
    }
    if (fatsConsumedPct > OVERAGE_ATTRIBUTION_THRESHOLD) {
      return { tone: "danger", icon: "alert", text: t(isCut ? "status.overFatsCut" : "status.overFats", { over }) };
    }
    return { tone: "danger", icon: "alert", text: t(isCut ? "status.overCaloriesCut" : "status.overCalories", { over }) };
  }

  if (Math.abs(calRemaining) <= 0.5) {
    return { tone: "info", icon: "leaf", text: tv("status.exactlyOnTarget", 2) };
  }

  const remaining = Math.round(calRemaining);

  // Protein target already met is good news worth calling out on its own,
  // regardless of which pace bracket the day is in below (an over-calories
  // day already got its own message above).
  const proteinGoalHit = proteinTarget > 0 && proteinRemainingPct <= 0;

  if (pct >= 0.9) {
    if (proteinGoalHit) {
      return proteinGoalMessage(remaining, fatsConsumedPct, fatsTarget);
    }
    if (proteinRemainingPct > PROTEIN_BEHIND_LATE) {
      return { tone: "warning", icon: "info", text: tv("status.almostDoneNeedsProtein", 2, { remaining, protein: proteinRemaining }) };
    }
    return { tone: "warning", icon: "info", text: tv("status.almostDone", 2, { remaining }) };
  }

  if (pct >= 0.5) {
    // The sweet spot for a specific, humanized nudge: enough of the day has
    // passed that "still behind on protein" or "carbs already maxed" are
    // meaningful observations, not noise from an incomplete day.
    if (proteinGoalHit) {
      return proteinGoalMessage(remaining, fatsConsumedPct, fatsTarget);
    }
    if (proteinRemainingPct > PROTEIN_BEHIND_MIDDAY) {
      return { tone: "warning", icon: "info", text: tv("status.onTrackNeedsProtein", 2, { remaining, protein: proteinRemaining }) };
    }
    if (carbsConsumedPct >= 1) {
      return { tone: "info", icon: "plate", text: t("status.onTrackCarbsTopped", { remaining }) };
    }
    if (fatsConsumedPct >= 1) {
      return { tone: "info", icon: "plate", text: t("status.onTrackFatsTopped", { remaining }) };
    }
    return { tone: "info", icon: "plate", text: tv("status.onTrack", 2, { remaining }) };
  }

  // Plenty left — early in the day. Only worth a protein nudge if they've
  // barely touched it yet; otherwise this is just an encouraging default.
  if (proteinGoalHit) {
    return proteinGoalMessage(remaining, fatsConsumedPct, fatsTarget);
  }
  if (proteinRemainingPct > PROTEIN_BEHIND_EARLY) {
    return { tone: "success", icon: "flame", text: tv("status.plentyLeftNeedsProtein", 2, { remaining }) };
  }
  return { tone: "success", icon: "flame", text: tv("status.plentyLeft", 2, { remaining }) };
}
