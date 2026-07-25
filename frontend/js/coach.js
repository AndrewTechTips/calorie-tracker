import { t } from "./i18n.js?v=20260725n";

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
  if (calRemaining < -0.5) {
    const over = Math.round(-calRemaining);
    if (carbsConsumedPct > OVERAGE_ATTRIBUTION_THRESHOLD && carbsConsumedPct >= fatsConsumedPct) {
      return { tone: "danger", text: t("status.overCarbs", { over }) };
    }
    if (fatsConsumedPct > OVERAGE_ATTRIBUTION_THRESHOLD) {
      return { tone: "danger", text: t("status.overFats", { over }) };
    }
    return { tone: "danger", text: t("status.overCalories", { over }) };
  }

  if (Math.abs(calRemaining) <= 0.5) {
    return { tone: "info", text: t("status.exactlyOnTarget") };
  }

  const remaining = Math.round(calRemaining);

  // Protein target already met is good news worth calling out on its own,
  // regardless of which pace bracket the day is in below (an over-calories
  // day already got its own message above).
  const proteinGoalHit = proteinTarget > 0 && proteinRemainingPct <= 0;

  if (pct >= 0.9) {
    if (proteinGoalHit) {
      return { tone: "success", text: t("status.proteinGoalHit", { remaining }) };
    }
    if (proteinRemainingPct > PROTEIN_BEHIND_LATE) {
      return { tone: "warning", text: t("status.almostDoneNeedsProtein", { remaining, protein: proteinRemaining }) };
    }
    return { tone: "warning", text: t("status.almostDone", { remaining }) };
  }

  if (pct >= 0.5) {
    // The sweet spot for a specific, humanized nudge: enough of the day has
    // passed that "still behind on protein" or "carbs already maxed" are
    // meaningful observations, not noise from an incomplete day.
    if (proteinGoalHit) {
      return { tone: "success", text: t("status.proteinGoalHit", { remaining }) };
    }
    if (proteinRemainingPct > PROTEIN_BEHIND_MIDDAY) {
      return { tone: "warning", text: t("status.onTrackNeedsProtein", { remaining, protein: proteinRemaining }) };
    }
    if (carbsConsumedPct >= 1) {
      return { tone: "info", text: t("status.onTrackCarbsTopped", { remaining }) };
    }
    if (fatsConsumedPct >= 1) {
      return { tone: "info", text: t("status.onTrackFatsTopped", { remaining }) };
    }
    return { tone: "info", text: t("status.onTrack", { remaining }) };
  }

  // Plenty left — early in the day. Only worth a protein nudge if they've
  // barely touched it yet; otherwise this is just an encouraging default.
  if (proteinGoalHit) {
    return { tone: "success", text: t("status.proteinGoalHit", { remaining }) };
  }
  if (proteinRemainingPct > PROTEIN_BEHIND_EARLY) {
    return { tone: "success", text: t("status.plentyLeftNeedsProtein", { remaining }) };
  }
  return { tone: "success", text: t("status.plentyLeft", { remaining }) };
}
