// Pure nutrition-math helpers shared by app.js (editing an existing log, and
// fiber auto-fill on a brand-new manual entry) and scan.js (live rescale in
// the AI-scan/barcode result-review form) — factored out so every call site
// uses the exact same formulas instead of duplicating them.

export const roundTo1 = (n) => Math.round(n * 10) / 10;

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
  };
}

// Formula-based fiber estimate for a brand-new manual entry, where there's
// no AI/barcode source to pull a real fiber value from and no prior snapshot
// to scale from. A single flat percentage of carbs is a common rough
// heuristic, but it's wrong at both ends of real usage — refined carbs
// (sugar, white bread/rice/pasta) run roughly 1-5% fiber-of-carbs, while
// legumes and vegetables run roughly 25-40%. This uses a small
// keyword-bucketed lookup on the food name instead — still zero-AI, still an
// instant synchronous calculation, just meaningfully more accurate than one
// constant. First matching bucket wins; falls back to a population-average
// default for anything unrecognized.
const FIBER_FRACTION_RULES = [
  { keywords: ["bean", "lentil", "chickpea", "legume"], fraction: 0.28 },
  { keywords: ["broccoli", "spinach", "kale", "cabbage", "carrot", "vegetable", "salad", "asparagus"], fraction: 0.22 },
  { keywords: ["apple", "banana", "orange", "berry", "pear", "fruit", "mango"], fraction: 0.14 },
  { keywords: ["oat", "whole wheat", "whole grain", "brown rice", "quinoa"], fraction: 0.11 },
  { keywords: ["sugar", "candy", "soda", "juice", "white bread", "white rice", "pasta", "cake", "cookie"], fraction: 0.03 },
];
const DEFAULT_FIBER_FRACTION = 0.08;

export function estimateFiberFraction(foodName) {
  const name = (foodName || "").toLowerCase();
  const rule = FIBER_FRACTION_RULES.find((r) => r.keywords.some((kw) => name.includes(kw)));
  return rule ? rule.fraction : DEFAULT_FIBER_FRACTION;
}

export function estimateFiberFromCarbs(carbsG, foodName) {
  return roundTo1(Math.max(carbsG, 0) * estimateFiberFraction(foodName));
}

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
