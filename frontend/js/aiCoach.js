// The "Cheap but Smart" AI coach — two genuinely different halves, both
// reachable from the same avatar/sheet:
//
// 1. Preset "structural questions" (QUESTIONS below), each answered purely
//    from client-side math against data already in memory. Zero cost, zero
//    latency, works offline. Deliberately NOT a free-text chat box — an
//    open-ended chat would mean every message is a real Gemini call; a
//    fixed set of tappable questions keeps this genuinely free forever.
// 2. A weekly natural-language recap (GET /coach/weekly-recap), the one
//    part that does call Gemini — but cached server-side per (user,
//    language) for a rolling week (services/coach_cache_service.py), so
//    it's a real API cost at most once a week per user, not once per tap.
import { openSheet } from "./ui.js?v=20260805h{";
import { onLanguageChange, t } from "./i18n.js?v=20260805h{";
import { api } from "./api.js?v=20260805h{";

const el = (id) => document.getElementById(id);

// Fed by app.js on every render() (same pattern as reminders.js's
// setContext) — kept as plain stashed primitives, not a reference to
// app.js's own state object, so this module stays independent of it.
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
// Proactive "today's focus" insight — see the sheet's own comment in
// index.html. A single ranked waterfall (same shape as coach.js's dashboard
// banner, most-actionable-first) picked instantly from context already in
// memory, never a network call. Deliberately picks exactly ONE sentence
// rather than trying to summarize everything at once — a coach that leads
// with one clear observation reads as more confident than one hedging
// across five stats.
// ---------------------------------------------------------------------------
const PROTEIN_BEHIND_THRESHOLD = 0.5; // still missing >50% of protein target
const WATER_BEHIND_THRESHOLD = 0.4; // still missing >60% of water target
const STREAK_CALLOUT_MIN = 3;

function computeInsight() {
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

function renderInsight() {
  el("ai-coach-insight-text").textContent = computeInsight();
  // Re-triggers the CSS entrance (icon pop + body rise, both defined on the
  // children — see style.css) on every open, the same remove-reflow-readd
  // pattern the FAB's own tap flourish uses — otherwise re-opening the sheet
  // within the same page load wouldn't replay an animation that already ran
  // once.
  const card = el("ai-coach-insight");
  [card.querySelector(".ai-coach-insight-icon"), card.querySelector(".ai-coach-insight-body")].forEach((node) => {
    if (!node) return;
    node.style.animation = "none";
    void node.offsetWidth;
    node.style.animation = "";
  });
}

const QUESTIONS = [
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

function renderQuestions() {
  const container = el("ai-coach-questions");
  container.replaceChildren(
    ...QUESTIONS.map((q) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ai-coach-question-btn";
      btn.textContent = t(`aiCoach.q${q.key[0].toUpperCase()}${q.key.slice(1)}`);
      btn.addEventListener("click", () => {
        el("ai-coach-answer-text").textContent = q.answer();
        el("ai-coach-answer").hidden = false;
      });
      return btn;
    }),
  );
}

// True once a real recap (fresh or cached) has been shown this sheet-open —
// reset on language change so a stale-language recap can't linger visible.
let recapShown = false;

async function loadRecap() {
  const btn = el("ai-coach-recap-btn");
  // The button also carries a decorative star icon (see index.html) — every
  // state change below targets just this inner label span, never the
  // button's own textContent, which would silently wipe the icon out the
  // first time this ran (a real bug this replaced: textContent = "..." on
  // the button itself replaces ALL children, SVG included, not just the
  // words).
  const label = el("ai-coach-recap-btn-label");
  const errorEl = el("ai-coach-recap-error");
  errorEl.hidden = true;
  btn.disabled = true;
  const originalLabel = label.textContent;
  label.textContent = t("aiCoach.recapLoading");
  try {
    const res = await api.getWeeklyRecap();
    el("ai-coach-recap-text").textContent = res.recap_text;
    el("ai-coach-recap-card").hidden = false;
    btn.hidden = true;
    recapShown = true;
  } catch (err) {
    errorEl.textContent = err.message || t("aiCoach.recapError");
    errorEl.hidden = false;
    label.textContent = originalLabel;
  } finally {
    btn.disabled = false;
  }
}

function refreshForLanguage() {
  renderQuestions();
  // Only re-render the insight text if the sheet is actually open — while
  // closed, the next real open() call below does it fresh (and re-triggers
  // the entrance animation, which would be wasted work on a hidden sheet).
  if (!el("ai-coach-sheet").hidden) renderInsight();
  el("ai-coach-answer").hidden = true; // a shown answer would now be in the old language
  if (recapShown) {
    recapShown = false;
    el("ai-coach-recap-card").hidden = true;
    el("ai-coach-recap-btn").hidden = false;
    el("ai-coach-recap-btn-label").textContent = t("aiCoach.viewRecapBtn");
  }
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

function openCoachSheet() {
  el("ai-coach-answer").hidden = true;
  renderInsight();
  openSheet("ai-coach-sheet");
  waveOllie();
}

export function initAiCoach() {
  renderQuestions();
  onLanguageChange(refreshForLanguage);

  el("ai-coach-btn").addEventListener("click", openCoachSheet);

  // The dashboard status banner (coach.js's getCalorieStatus, rendered by
  // ui.js) used to be a dead-end read-only notice with no way to act on it —
  // it's really just a preview of the same coach, so tapping it opens the
  // real thing instead of the user having to separately notice/find the
  // header avatar. role="button"/tabindex here (not a <button> element,
  // since the banner's tone-colored left border and layout are shared with
  // the End Day sheet's static summary variant, which stays non-interactive)
  // needs its own keydown handling for keyboard activation.
  const banner = el("status-banner");
  if (banner) {
    banner.addEventListener("click", openCoachSheet);
    banner.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openCoachSheet();
    });
  }

  el("ai-coach-recap-btn").addEventListener("click", loadRecap);
}
