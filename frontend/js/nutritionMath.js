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
