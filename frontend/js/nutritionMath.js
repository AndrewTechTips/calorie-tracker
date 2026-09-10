// Pure nutrition-math helpers shared by app.js (editing an existing log, and
// fiber auto-fill on a brand-new manual entry) and scan.js (live rescale in
// the AI-scan/barcode result-review form) — factored out so every call site
// uses the exact same formulas instead of duplicating them.

export const roundTo1 = (n) => Math.round(n * 10) / 10;

// Standard Atwater energy-density factors (kcal per gram) — the same
// textbook conversion nutrition labels themselves are built from. Used by
// the ingredients editor (ingredientsList.js) to keep a row's own calories
// field reactive to its protein/carbs/fats: editing a macro by hand
// recomputes calories from this formula instantly, instead of leaving a
// user to do kcal = protein*4 + carbs*4 + fats*9 in their head every time.
// Fiber is deliberately excluded — this app already tracks it as its own
// separate field throughout (see e.g. progress.js's macro consistency rows),
// not folded into the calorie total the way total/net-carb-labeling
// conventions sometimes do.
const KCAL_PER_G = { protein: 4, carbs: 4, fats: 9 };

export function caloriesFromMacros({ protein, carbs, fats }) {
  return Math.round((Number(protein) || 0) * KCAL_PER_G.protein + (Number(carbs) || 0) * KCAL_PER_G.carbs + (Number(fats) || 0) * KCAL_PER_G.fats);
}

// Proportionally rescales calories/protein/carbs/fats/fiber from `original`
// (a {weight_g, calories, protein, carbs, fats, fiber} snapshot) to a new
// weight — a simple linear ratio, no AI needed. The app already did this for
// log edits; this makes it reusable and extends the same convenience to the
// scan-review form, which never had it (editing weight there used to leave
// the other fields stale).
export function scaleMacrosByWeight(original, newWeightG) {
  const ratio = newWeightG / original.weight_g;
  return {
    calories: Math.round(original.calories * ratio),
    protein: roundTo1(original.protein * ratio),
    carbs: roundTo1(original.carbs * ratio),
    fats: roundTo1(original.fats * ratio),
    fiber: roundTo1((original.fiber || 0) * ratio),
    sugar: roundTo1((original.sugar || 0) * ratio),
    // Milligrams, not grams (matches backend/models.py's IngredientItem.sodium)
    // — rounded to a whole number rather than roundTo1's one-decimal, since a
    // fractional milligram isn't a meaningful reading for anyone.
    sodium: Math.round((original.sodium || 0) * ratio),
  };
}

// The keyword-bucketed fiber estimator that used to live here (
// estimateFiberFraction / estimateFiberFromCarbs) was deleted 2026-09-10.
// Its only caller was ingredientsList.js's weight-edit handler, where it
// filled in a fiber value whenever the original ingredient had none — which
// meant guessing a number the BACKEND had deliberately declined to guess.
// nutrition_db_service.lookup() omits fiber/sugar/sodium when the winning
// source is silent on them, specifically so "unverified" stays
// distinguishable from "verified zero"; re-deriving it from a keyword match
// on the food name collapsed that distinction and rendered the invented
// figure through the same UI as a USDA-sourced one. A missing fiber value
// now stays zero and scales as zero.

// ---------------------------------------------------------------------------
// Target calculator — suggests daily calorie/macro targets from bodyweight,
// height, age, sex, activity level, and goal (cut/maintain/bulk), for the
// Settings "Calculate my targets" flow (app.js). Every number here is a
// well-established estimate, not a measurement — the app always shows this
// as a starting point the user reviews/adjusts in the normal targets form
// before saving, never applies it silently.
// ---------------------------------------------------------------------------

// Mifflin-St Jeor — the most widely validated resting-metabolic-rate formula
// for the general population (supersedes the older Harris-Benedict equation
// on accuracy). It needs a biological-sex constant specifically because body
// composition at a given weight/height shifts the equation's intercept —
// there's no sex-neutral version of this particular formula.
export function calculateBMR({ weightKg, heightCm, age, sex }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === "female" ? base - 161 : base + 5;
}

// Standard activity multipliers — Mifflin-St Jeor is always paired with one
// of these, never used alone. "Activity" means overall daily movement plus
// training, not just gym sessions.
export const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2, // little/no exercise, desk job
  light: 1.375, // light exercise 1-3 days/week
  moderate: 1.55, // moderate exercise 3-5 days/week
  active: 1.725, // hard exercise 6-7 days/week
  very_active: 1.9, // physical job, or training ~2x/day
};

export function calculateTDEE(bmr, activityLevel) {
  return bmr * (ACTIVITY_MULTIPLIERS[activityLevel] || ACTIVITY_MULTIPLIERS.moderate);
}

// Calorie offset per goal — a moderate, sustainable rate rather than an
// aggressive crash-diet or maximum-lean-bulk number, since this is a
// starting daily suggestion, not a competition-prep plan. Not hypertrophy-
// specific: cut/maintain/bulk covers fat loss, maintenance, and muscle gain
// equally, since that's the actual range of goals this app supports.
const GOAL_CALORIE_OFFSET = {
  cut: -0.2, // ~20% deficit
  maintain: 0,
  bulk: 0.12, // ~12% surplus — a lean bulk, not "eat everything"
};

// Protein target scales with bodyweight, not total calories — the standard
// evidence-based range for resistance-trained individuals is roughly
// 1.6-2.2 g/kg. Cutting uses the top of that range specifically to help
// protect lean mass at a deficit, which is also why this doesn't just use
// one flat protein-per-kg number for every goal.
const GOAL_PROTEIN_PER_KG = {
  cut: 2.2,
  maintain: 1.8,
  bulk: 1.8,
};

// Fat floor as a fraction of total calories — below ~20% risks essential
// fatty acid and hormone-production shortfalls regardless of goal, so this
// is applied as a share of total calories, with protein computed first from
// bodyweight and carbs simply filling whatever calories remain.
const FAT_FRACTION_OF_CALORIES = 0.25;

export function calculateTargets({ weightKg, heightCm, age, sex, activityLevel, goal }) {
  const bmr = calculateBMR({ weightKg, heightCm, age, sex });
  const tdee = calculateTDEE(bmr, activityLevel);
  const calories = Math.round(tdee * (1 + (GOAL_CALORIE_OFFSET[goal] ?? 0)));

  const protein = Math.round(weightKg * (GOAL_PROTEIN_PER_KG[goal] ?? GOAL_PROTEIN_PER_KG.maintain));
  const fatCalories = calories * FAT_FRACTION_OF_CALORIES;
  const fats = Math.round(fatCalories / 9);
  const proteinCalories = protein * 4;
  const remainingCalories = Math.max(calories - proteinCalories - fatCalories, 0);
  const carbs = Math.round(remainingCalories / 4);

  return { calories, protein, carbs, fats };
}

// ---------------------------------------------------------------------------
// Weight-trend smoothing — progress.js's weight chart used to plot raw
// weigh-ins only, which is noisy day to day (water/sodium/glycogen/bowel
// timing can easily swing 0.5-1.5kg with zero actual fat/muscle change).
// An exponential moving average is the standard fix real weight-trend tools
// use for exactly this: each smoothed point blends the new raw value with
// the previous smoothed value, so a single outlier weigh-in nudges the line
// instead of yanking it.
// ---------------------------------------------------------------------------

// alpha (0-1): how much weight the newest raw point gets. Lower = smoother
// but slower to reflect a real, sustained change; 0.25 is a common default
// for daily-ish weigh-in cadences (roughly a ~7-day effective window).
const DEFAULT_EMA_ALPHA = 0.25;

// `entries` must already be chronological (oldest first) — mirrors every
// other chart helper in this app (see progress.js's drawTrendLine). Returns
// one smoothed value per input entry, first point seeded at the first raw
// value (nothing to blend with yet).
export function computeEMA(entries, valueKey, alpha = DEFAULT_EMA_ALPHA) {
  if (!entries?.length) return [];
  let prev = entries[0][valueKey];
  return entries.map((entry, i) => {
    prev = i === 0 ? entry[valueKey] : alpha * entry[valueKey] + (1 - alpha) * prev;
    return prev;
  });
}

// Ordinary-least-squares slope of value-over-time — a more stable "rate of
// change" than naively diffing the first and last weigh-in, since it uses
// every point instead of being at the mercy of whichever two happen to be
// the endpoints (each of which is itself subject to the same daily noise
// the EMA above exists to smooth out). `entries` chronological, same as
// computeEMA. Returns kg/week (or whatever `valueKey`'s unit is, per week)
// so it reads as a familiar "rate" figure; null if fewer than 2 points.
export function computeLinearTrendRate(entries, valueKey) {
  if (!entries || entries.length < 2) return null;
  const first = new Date(entries[0].logged_at).getTime();
  // x in days since the first entry — keeps the slope's units directly
  // interpretable (per day, then scaled to per week below) regardless of
  // how the entries happen to be spaced.
  const points = entries.map((entry) => ({
    x: (new Date(entry.logged_at).getTime() - first) / 86400000,
    y: entry[valueKey],
  }));
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return 0; // all entries logged at the exact same timestamp
  const slopePerDay = (n * sumXY - sumX * sumY) / denominator;
  return roundTo1(slopePerDay * 7);
}

// A one-line plain-word read of where the weight trend is actually heading,
// for the Progress tab's weight card (Phase 3). Computed off the EMA-smoothed
// series (computeEMA above), NOT raw weigh-ins, so a single noisy day can't
// flip the verdict — it exists to pull attention off the daily number and
// onto the trajectory. `entries` chronological (oldest first). Returns
// { kind: "steady" | "down" | "up" | "insufficient", ratePerWeek } where
// ratePerWeek is a positive magnitude (the direction is in `kind`).
export const WEIGHT_VERDICT_STEADY_KG_PER_WK = 0.15; // |rate| under this reads as maintenance
const WEIGHT_VERDICT_MIN_ENTRIES = 3;
const WEIGHT_VERDICT_RECENT_DAYS = 21; // judge the *current* trajectory, not months-old history

export function computeWeightVerdict(entries) {
  if (!entries || entries.length < WEIGHT_VERDICT_MIN_ENTRIES) {
    return { kind: "insufficient", ratePerWeek: 0 };
  }
  const lastMs = new Date(entries[entries.length - 1].logged_at).getTime();
  let window = entries.filter((e) => lastMs - new Date(e.logged_at).getTime() <= WEIGHT_VERDICT_RECENT_DAYS * 86400000);
  if (window.length < WEIGHT_VERDICT_MIN_ENTRIES) window = entries.slice(-Math.max(WEIGHT_VERDICT_MIN_ENTRIES, 4));
  // Re-seed the EMA on just the recent window: a plateau after an earlier
  // losing/gaining phase then reads as flat, instead of the smoothed line
  // inheriting the old slope as multi-week catch-up lag.
  const ema = computeEMA(window, "weight_kg");
  const smoothed = window.map((e, i) => ({ logged_at: e.logged_at, ema: ema[i] }));
  const rate = computeLinearTrendRate(smoothed, "ema"); // OLS slope of the smoothed line, kg/week
  if (rate === null) return { kind: "insufficient", ratePerWeek: 0 };
  if (Math.abs(rate) < WEIGHT_VERDICT_STEADY_KG_PER_WK) return { kind: "steady", ratePerWeek: 0 };
  return { kind: rate < 0 ? "down" : "up", ratePerWeek: roundTo1(Math.abs(rate)) };
}

// Minimum logged weigh-ins before a forecast is shown — matches
// WEIGHT_TREND_RATE_MIN_ENTRIES in progress.js (same reasoning: a 2-point
// "trend" is just the raw delta between two weigh-ins, not a real regression).
const WEIGHT_FORECAST_MIN_ENTRIES = 3;
const FORECAST_HORIZONS_DAYS = [30, 60, 90];

// A straight-line projection of the CURRENT logged trend (via
// computeLinearTrendRate above), not a calorie-balance/TDEE model — this app
// already knows the real observed rate of change from actual weigh-ins,
// which is more direct evidence than back-deriving one from average calorie
// intake would be, and avoids needing profile fields (height/age/activity)
// this call site doesn't have on hand. Deliberately framed as "if this
// trend continues", never as a guarantee — trends shift with real behavior
// change, and this app is explicit elsewhere (CLAUDE.md, the calculator
// sheet) that every estimate here is a starting point, not medical advice.
// `entries` chronological (oldest first), same convention as computeEMA/
// computeLinearTrendRate. Returns null when there isn't enough history yet.
export function computeWeightForecast(entries) {
  if (!entries || entries.length < WEIGHT_FORECAST_MIN_ENTRIES) return null;
  const ratePerWeek = computeLinearTrendRate(entries, "weight_kg");
  if (ratePerWeek === null) return null;
  const current = entries[entries.length - 1].weight_kg;
  const ratePerDay = ratePerWeek / 7;
  return {
    ratePerWeek,
    projections: FORECAST_HORIZONS_DAYS.map((days) => ({
      days,
      weightKg: roundTo1(current + ratePerDay * days),
    })),
  };
}
