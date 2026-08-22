// The "Cheap but Smart" AI coach's DATA layer — everything Ollie can say,
// split into two genuinely different cost profiles:
//
// 1. Preset "structural questions" (QUESTIONS below) and the proactive
//    "today's focus" insight (computeInsight), both answered purely from
//    client-side math against data already in memory. Zero cost, zero
//    latency, works offline.
// 2. A weekly natural-language recap (fetchWeeklyRecap, GET /coach/weekly-
//    recap), the one part that does call Gemini — but cached server-side per
//    (user, language) for a rolling week (services/coach_cache_service.py),
//    so it's a real API cost at most once a week per user, not once per tap.
//
// This module does no DOM rendering of its own — coachChat.js owns the
// entire AI Coach sheet (header, chat feed, suggestion chips, input) and
// renders both halves above through the exact same chat-bubble path as its
// own real, capped free-text replies, so none of them are visually
// distinguishable from one another. See coachChat.js for that unification
// and for waveOllie()'s one other caller (a fresh reply landing).
import { t } from "./i18n.js?v=20260822m";
import { api } from "./api.js?v=20260822m";

const el = (id) => document.getElementById(id);

// Fed by app.js on every render() — kept as plain stashed primitives, not a
// reference to app.js's own state object, so this module stays independent
// of it.
let context = {
  caloriesLeft: 0,
  targetCalories: 0,
  streak: 0,
  weekAdherentDays: 0,
  weekLoggedDays: 0,
  waterMl: 0,
  waterTargetMl: 3000,
  topFoodName: null,
  topFoodCalories: 0,
  proteinLeft: 0,
  proteinTarget: 0,
  loggedToday: false,
  // Fed by progress.js (not app.js — weight history is fetched there, not
  // in app.js's own state) whenever it renders the weight section. Shape:
  // nutritionMath.js's computeWeightForecast() return value, or null before
  // enough weigh-ins exist.
  weightForecast: null,
};
export function setContext(next) {
  context = { ...context, ...next };
}

// ---------------------------------------------------------------------------
// Proactive "today's focus" insight — coachChat.js posts this as Ollie's
// opening line the first time the sheet is opened each page load (see its
// own seedInsight()). A single ranked waterfall (same shape as coach.js's
// dashboard banner, most-actionable-first) picked instantly from context
// already in memory, never a network call. Deliberately picks exactly ONE
// sentence rather than trying to summarize everything at once — a coach that
// leads with one clear observation reads as more confident than one hedging
// across five stats.
// ---------------------------------------------------------------------------
const PROTEIN_BEHIND_THRESHOLD = 0.5; // still missing >50% of protein target
const WATER_BEHIND_THRESHOLD = 0.4; // still missing >60% of water target
const STREAK_CALLOUT_MIN = 3;

export function computeInsight() {
  if (!context.loggedToday && context.topFoodName === null) {
    return t("aiCoach.insightNoLogs");
  }
  if (context.caloriesLeft < -0.5) {
    return t("aiCoach.insightOverCalories", { over: Math.round(-context.caloriesLeft) });
  }
  const proteinRemainingPct = context.proteinTarget > 0 ? context.proteinLeft / context.proteinTarget : 0;
  if (context.proteinTarget > 0 && proteinRemainingPct > PROTEIN_BEHIND_THRESHOLD) {
    return t("aiCoach.insightProteinBehind", { grams: Math.round(Math.max(0, context.proteinLeft)) });
  }
  const waterRemainingPct = context.waterTargetMl > 0 ? (context.waterTargetMl - context.waterMl) / context.waterTargetMl : 0;
  if (waterRemainingPct > WATER_BEHIND_THRESHOLD) {
    return t("aiCoach.insightWaterBehind", { ml: Math.round(Math.max(0, context.waterTargetMl - context.waterMl)) });
  }
  if (context.streak >= STREAK_CALLOUT_MIN) {
    return t("aiCoach.insightStreak", { days: context.streak });
  }
  return t("aiCoach.insightOnTrack", { left: Math.round(Math.max(0, context.caloriesLeft)) });
}

// key: used to look up both the chip's own label (aiCoach.q<Key>) and drives
// nothing else — answer() is the zero-cost local reply, run at tap time (not
// memoized) so it always reflects whatever's currently in `context`.
export const QUESTIONS = [
  {
    key: "caloriesLeft",
    answer: () =>
      t("aiCoach.aCaloriesLeft", { left: Math.round(Math.max(0, context.caloriesLeft)), target: Math.round(context.targetCalories) }),
  },
  {
    key: "streak",
    answer: () => (context.streak > 0 ? t("aiCoach.aStreakActive", { days: context.streak }) : t("aiCoach.aStreakNone")),
  },
  {
    key: "weekProgress",
    answer: () =>
      context.weekLoggedDays > 0
        ? t("aiCoach.aWeekProgress", { adherent: context.weekAdherentDays, logged: context.weekLoggedDays })
        : t("aiCoach.aWeekProgressNone"),
  },
  {
    key: "water",
    answer: () =>
      t("aiCoach.aWater", { ml: Math.round(context.waterMl).toLocaleString(), target: Math.round(context.waterTargetMl).toLocaleString() }),
  },
  {
    key: "topFood",
    answer: () =>
      context.topFoodName
        ? t("aiCoach.aTopFood", { name: context.topFoodName, calories: Math.round(context.topFoodCalories) })
        : t("aiCoach.aTopFoodNone"),
  },
  {
    key: "weightForecast",
    // A straight-line projection of the logged trend, not a guarantee — see
    // nutritionMath.js's computeWeightForecast for why this is trend-based
    // rather than a calorie-balance model, and its own honesty framing.
    answer: () => {
      const forecast = context.weightForecast;
      if (!forecast) return t("aiCoach.aWeightForecastNone");
      const in30 = forecast.projections.find((p) => p.days === 30);
      if (Math.abs(forecast.ratePerWeek) < 0.05) return t("aiCoach.aWeightForecastFlat");
      return t("aiCoach.aWeightForecast", {
        direction: forecast.ratePerWeek > 0 ? t("aiCoach.forecastUp") : t("aiCoach.forecastDown"),
        rate: Math.abs(forecast.ratePerWeek),
        weight: in30.weightKg,
      });
    },
  },
];

// The one real network call in this module — cached server-side per the
// module comment above, so this is cheap even on a repeat tap within the
// same week. Returns the recap text directly (or throws); coachChat.js
// handles the loading/error UI around it, same as it does for a real chat
// turn, so this reads as just another reply rather than a special case.
export async function fetchWeeklyRecap() {
  const res = await api.getWeeklyRecap();
  return res.recap_text;
}

// A one-shot wave — reused for both the header tap and (from coachChat.js)
// a new reply landing, so Ollie's greeting gesture always looks the same.
// Removed after it plays, not left with `animation-fill-mode: forwards`, so
// it can replay on the very next trigger (a still-present class wouldn't
// restart its own animation).
export function waveOllie() {
  const btn = el("ai-coach-btn");
  btn.classList.remove("waving");
  void btn.offsetWidth;
  btn.classList.add("waving");
  setTimeout(() => btn.classList.remove("waving"), 700);
}
