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
import { openSheet } from "./ui.js?v=20260805k";
import { onLanguageChange, t } from "./i18n.js?v=20260805k";
import { api } from "./api.js?v=20260805k";

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
};
export function setContext(next) {
  context = { ...context, ...next };
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
  const errorEl = el("ai-coach-recap-error");
  errorEl.hidden = true;
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = t("aiCoach.recapLoading");
  try {
    const res = await api.getWeeklyRecap();
    el("ai-coach-recap-text").textContent = res.recap_text;
    el("ai-coach-recap-card").hidden = false;
    btn.hidden = true;
    recapShown = true;
  } catch (err) {
    errorEl.textContent = err.message || t("aiCoach.recapError");
    errorEl.hidden = false;
    btn.textContent = originalLabel;
  } finally {
    btn.disabled = false;
  }
}

function refreshForLanguage() {
  renderQuestions();
  el("ai-coach-answer").hidden = true; // a shown answer would now be in the old language
  if (recapShown) {
    recapShown = false;
    el("ai-coach-recap-card").hidden = true;
    const btn = el("ai-coach-recap-btn");
    btn.hidden = false;
    btn.textContent = t("aiCoach.viewRecapBtn");
  }
}

export function initAiCoach() {
  renderQuestions();
  onLanguageChange(refreshForLanguage);

  el("ai-coach-btn").addEventListener("click", () => {
    el("ai-coach-answer").hidden = true;
    openSheet("ai-coach-sheet");
  });

  el("ai-coach-recap-btn").addEventListener("click", loadRecap);
}
