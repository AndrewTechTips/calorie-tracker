// Shared per-ingredient breakdown editor — mounted identically wherever a
// meal is created or edited (AI scan/describe/barcode result review in
// scan.js, manual entry / edit log / edit saved meal / new saved meal in
// app.js, and the "log a suggested recipe" portion editor in discover.js).
// Pure DOM + pure functions, no framework, following the same
// dependency-free pattern as nutritionMath.js.
//
// The aggregate (top-level weight/calories/protein/carbs/fats/fiber) is
// ALWAYS the computed sum of the ingredient rows — never an independently
// editable field — so there's never an ambiguity about which number is
// authoritative. This mirrors exactly how the backend finalizes an AI scan
// response (see gemini_service.py::_finalize_ingredients).
import { caloriesFromMacros, estimateFiberFromCarbs, roundTo1, scaleMacrosByWeight } from "./nutritionMath.js?v=20260817e";
import { t } from "./i18n.js?v=20260817e";
import { escapeHtml } from "./ui.js?v=20260817e";

// Every entry always has >= 1 ingredient — a plain single-food log is just a
// one-row list. Wraps a flat {food_name, weight_g, calories, protein, carbs,
// fats, fiber} result (an AI scan with no ingredients array, a legacy log/
// saved meal from before this feature, etc.) into that shape.
export function asImplicitIngredient(source) {
  return {
    food_name: source?.food_name || "",
    weight_g: Number(source?.weight_g) || 0,
    calories: Number(source?.calories) || 0,
    protein: Number(source?.protein) || 0,
    carbs: Number(source?.carbs) || 0,
    fats: Number(source?.fats) || 0,
    fiber: Number(source?.fiber) || 0,
    sugar: Number(source?.sugar) || 0,
    sodium: Number(source?.sodium) || 0,
  };
}

function blankIngredient() {
  return { food_name: "", weight_g: 0, calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0, sugar: 0, sodium: 0 };
}

export function computeAggregate(ingredients) {
  const sum = (field, rounder) =>
    rounder(ingredients.reduce((total, i) => total + (Number(i[field]) || 0), 0));
  return {
    weight_g: sum("weight_g", roundTo1),
    calories: sum("calories", Math.round),
    protein: sum("protein", roundTo1),
    carbs: sum("carbs", roundTo1),
    fats: sum("fats", roundTo1),
    fiber: sum("fiber", roundTo1),
    // Not shown in the ingredient rows or the default totals chip strip below
    // (that grid is already dense on mobile) — summed here so callers (see
    // onTotalsChange) can surface them in their own separate "more nutrients"
    // detail view instead, per the same "don't clutter the macro row"
    // principle the dashboard follows.
    sugar: sum("sugar", roundTo1),
    sodium: sum("sodium", Math.round),
  };
}

// Per-100g mode's entire scaling logic: when isPer100 is true, `ing`'s own
// calories/protein/carbs/fats/fiber/sugar/sodium fields are interpreted as
// "per 100g" (whatever the user typed off a nutrition label) rather than as
// absolute totals — this derives the real totals for ing.weight_g grams.
// Deliberately divides by the fixed constant 100, never by a second
// user-editable field, so there's no divide-by-zero/empty-base edge case to
// guard against the way an editable "base amount" would need. Called only at
// read time (the totals strip, getIngredients()) — never mutates `ing`
// itself, so the fields on screen always show exactly what the user typed,
// unaffected by toggling the checkbox on/off.
function resolveIngredient(ing, isPer100) {
  if (!isPer100) return ing;
  const ratio = (Number(ing.weight_g) || 0) / 100;
  return {
    ...ing,
    calories: Math.round((Number(ing.calories) || 0) * ratio),
    protein: roundTo1((Number(ing.protein) || 0) * ratio),
    carbs: roundTo1((Number(ing.carbs) || 0) * ratio),
    fats: roundTo1((Number(ing.fats) || 0) * ratio),
    fiber: roundTo1((Number(ing.fiber) || 0) * ratio),
    sugar: roundTo1((Number(ing.sugar) || 0) * ratio),
    sodium: Math.round((Number(ing.sodium) || 0) * ratio),
  };
}

// max values mirror this app's own backend bounds for a single ingredient
// (backend/models.py::IngredientItem — weight_g le=10000, calories le=20000,
// protein/carbs/fats le=2000, fiber le=500), except weight_g which is
// additionally tightened to 3000g client-side: that field is what a mistyped
// extra digit (e.g. "100000") turns into an absurd flex-row width, and no
// realistic single ingredient weighs anywhere near even 3000g, let alone the
// full backend ceiling. inputmode/pattern steer mobile keyboards to numeric
// entry and, for the integer fields, block a decimal-point keyboard key that
// step="1" would reject anyway.
const FIELD_DEFS = [
  { key: "weight_g", labelKey: "field.weight", step: "1", min: "0", max: "3000", inputmode: "numeric", pattern: "[0-9]*" },
  { key: "calories", labelKey: "field.calories", step: "1", min: "0", max: "20000", inputmode: "numeric", pattern: "[0-9]*" },
  { key: "protein", labelKey: "field.protein", step: "0.1", min: "0", max: "2000", inputmode: "decimal" },
  { key: "carbs", labelKey: "field.carbs", step: "0.1", min: "0", max: "2000", inputmode: "decimal" },
  { key: "fats", labelKey: "field.fats", step: "0.1", min: "0", max: "2000", inputmode: "decimal" },
  { key: "fiber", labelKey: "field.fiber", step: "0.1", min: "0", max: "500", inputmode: "decimal" },
];

// Weight keeps its plain label in per-100g mode too (it always means "how
// much you're eating", never "the label's base amount" — that base is a
// fixed 100g, not a field at all) — only the macro fields' labels pick up a
// "(per 100g)" suffix while the checkbox is checked, so the user always
// knows what a field currently means without needing a second explanatory
// block anywhere on the row.
function fieldLabel(f, isPer100) {
  if (!isPer100 || f.key === "weight_g") return t(f.labelKey);
  return `${t(f.labelKey)} ${t("ingredients.per100Suffix")}`;
}

// Creates a self-contained editor bound to a list container + (optional)
// totals strip container. Callers only ever need setIngredients() (to seed
// from an AI/barcode result, an existing log, or a blank new entry) and
// getIngredients() (to read the current rows back out at submit time) — all
// row add/remove/edit/rescale/re-render logic lives here so every mount site
// behaves identically.
export function createIngredientsEditor({ listEl, totalsEl, addBtnEl, onTotalsChange }) {
  let ingredients = [blankIngredient()];
  // Parallel array: the snapshot each row had when it was first seeded (from
  // an AI/barcode/saved source), or last had its weight scaled from — lets a
  // plain weight edit auto-rescale the rest of that row proportionally (e.g.
  // "I actually ate 250g of what the AI scanned, not 200g"). A brand new
  // manually-added row has no known per-gram density to scale from, so its
  // slot here is null and weight edits on it are accepted as-is with no
  // auto-rescale. Ignored entirely for a row in per-100g mode (see
  // resolveIngredient above) — that mode derives its totals straight from
  // the row's own fields instead.
  let originals = [null];
  // Parallel array: whether row idx's calories/protein/carbs/fats/fiber
  // fields are currently being entered "per 100g" (a nutrition label's own
  // numbers) rather than as this row's absolute totals. Always starts false
  // for a freshly-seeded row.
  let per100Mode = [false];

  function resolvedList() {
    return ingredients.map((ing, idx) => resolveIngredient(ing, per100Mode[idx]));
  }

  function renderTotals() {
    const agg = computeAggregate(resolvedList());
    if (totalsEl) {
      totalsEl.innerHTML = `
        <span class="ingredient-total-chip chip-calories">${agg.calories} ${t("field.calories")}</span>
        <span class="ingredient-total-chip chip-protein">${agg.protein}g ${t("dashboard.macroAbbrProtein")}</span>
        <span class="ingredient-total-chip chip-carbs">${agg.carbs}g ${t("dashboard.macroAbbrCarbs")}</span>
        <span class="ingredient-total-chip chip-fats">${agg.fats}g ${t("dashboard.macroAbbrFats")}</span>
        <span class="ingredient-total-chip chip-fiber">${agg.fiber}g ${t("dashboard.fiber")}</span>
        <span class="ingredient-total-chip chip-weight">${agg.weight_g}g</span>
      `;
    }
    // Lets a caller (scan.js's "More nutrients" section) stay in sync with
    // sugar/sodium live, without this module needing to know anything about
    // where/how those are displayed.
    onTotalsChange?.(agg);
  }

  // The field grid + the "Enter values per 100g" checkbox above it — the one
  // set of inputs every row has, in every mode. Checking the box never
  // touches these fields' values, only how they're read at totals/submit
  // time (resolveIngredient) and how their labels read (fieldLabel).
  function renderFieldGrid(idx) {
    const ing = ingredients[idx];
    const isPer100 = per100Mode[idx];
    return `
      <label class="ingredient-per100-toggle">
        <input type="checkbox" class="ingredient-per100-checkbox" data-idx="${idx}" ${isPer100 ? "checked" : ""} />
        <span>${t("ingredients.per100Label")}</span>
      </label>
      <div class="ingredient-row-fields">
        ${FIELD_DEFS.map(
          (f) => `
          <label class="ingredient-field">
            <span>${fieldLabel(f, isPer100)}</span>
            <input type="number" class="ingredient-input" data-idx="${idx}" data-field="${f.key}"
                   step="${f.step}" min="${f.min}" max="${f.max}" inputmode="${f.inputmode}"
                   ${f.pattern ? `pattern="${f.pattern}"` : ""} value="${ing[f.key]}" />
          </label>`
        ).join("")}
      </div>
    `;
  }

  // A single-ingredient entry (the overwhelming majority of manual logs) is
  // the default and renders completely flat — no card border/background, no
  // per-ingredient name field (the caller's own top-level food-name field
  // already names it — see app.js/scan.js syncing that into this sole row's
  // food_name at submit time), no duplicate/remove icons. It's only once a
  // second ingredient exists — "+ Add ingredient", or an AI/barcode scan
  // that genuinely found multiple foods — that every row switches to the
  // full bordered-card treatment with its own name/duplicate/remove, since a
  // real composite meal needs those. This is what keeps the common case
  // reading as a plain simple form instead of a "builder".
  function renderRows() {
    const isFlat = ingredients.length === 1;
    listEl.innerHTML = ingredients
      .map(
        (ing, idx) => `
      <div class="ingredient-row${isFlat ? " ingredient-row-flat" : ""}" data-idx="${idx}">
        ${
          isFlat
            ? ""
            : `
        <div class="ingredient-row-head">
          <input type="text" class="ingredient-name" data-idx="${idx}" maxlength="100"
                 placeholder="${t("ingredients.namePlaceholder")}" value="${escapeHtml(ing.food_name)}" />
          <button type="button" class="ingredient-duplicate" data-idx="${idx}"
                  aria-label="${t("ingredients.duplicateAriaLabel")}">
            <svg viewBox="0 0 24 24" fill="none"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" stroke="currentColor" stroke-width="1.6"/></svg>
          </button>
          <button type="button" class="ingredient-remove" data-idx="${idx}"
                  aria-label="${t("ingredients.removeAriaLabel")}">&times;</button>
        </div>`
        }
        ${renderFieldGrid(idx)}
      </div>`
      )
      .join("");
    renderTotals();
  }

  listEl.addEventListener("input", (e) => {
    const input = e.target.closest(".ingredient-input, .ingredient-name");
    if (!input) return;
    const idx = Number(input.dataset.idx);
    if (input.classList.contains("ingredient-name")) {
      ingredients[idx].food_name = input.value;
      return;
    }
    const field = input.dataset.field;
    const value = Number(input.value) || 0;
    const row = listEl.querySelector(`.ingredient-row[data-idx="${idx}"]`);

    // Editing weight rescales every other field from this row's known
    // original snapshot, if it has one (an AI/barcode/saved source) — but
    // only outside per-100g mode, where the macro fields are the label's own
    // per-100g numbers and don't change just because the eaten weight did
    // (resolveIngredient derives the real totals from them live instead).
    if (field === "weight_g" && !per100Mode[idx] && originals[idx]?.weight_g) {
      const scaled = scaleMacrosByWeight(originals[idx], value);
      ingredients[idx] = {
        ...ingredients[idx],
        weight_g: value,
        calories: scaled.calories,
        protein: scaled.protein,
        carbs: scaled.carbs,
        fats: scaled.fats,
        fiber: originals[idx].fiber ? scaled.fiber : estimateFiberFromCarbs(scaled.carbs, ingredients[idx].food_name),
        // No estimate-from-carbs fallback for sugar/sodium the way fiber has
        // (there's no comparably reliable food-name heuristic for either) —
        // an original snapshot with no sugar/sodium tracked just scales to 0,
        // same as scaleMacrosByWeight's own (original.X || 0) fallback.
        sugar: scaled.sugar,
        sodium: scaled.sodium,
      };
      // Re-render this one row's number inputs in place (not the whole list,
      // which would drop focus out of the field the user is actively typing
      // in) — the weight input itself is left alone since it already holds
      // what the user typed.
      FIELD_DEFS.forEach((f) => {
        if (f.key === "weight_g") return;
        const fieldInput = row?.querySelector(`.ingredient-input[data-field="${f.key}"]`);
        if (fieldInput) fieldInput.value = ingredients[idx][f.key];
      });
    } else {
      ingredients[idx][field] = value;
      // Reactive math, the other direction from the weight-driven rescale
      // above: tweaking protein/carbs/fats recomputes THIS row's own
      // calories from the standard energy-density formula (see
      // nutritionMath.js's caloriesFromMacros), live — a user editing a
      // macro by hand should never have to separately go work out and
      // retype the new calorie total themselves. Works identically in
      // per-100g mode too, since the formula is scale-invariant (it's just
      // as true per 100g as it is for an absolute total). Calories itself
      // (and fiber, which this app doesn't fold into the calorie total —
      // see caloriesFromMacros' own comment) stays a plain directly-editable
      // field with no reverse cascade: a single calorie number can't be
      // un-mixed back into a protein/carb/fat split.
      if (field === "protein" || field === "carbs" || field === "fats") {
        ingredients[idx].calories = caloriesFromMacros(ingredients[idx]);
        const calInput = row?.querySelector('.ingredient-input[data-field="calories"]');
        if (calInput) calInput.value = ingredients[idx].calories;
      }
    }
    renderTotals();
  });

  // Zero-clear focus UX: a field showing exactly "0" (the common resting
  // state for an untouched macro field) clears itself the moment it's
  // focused, so the user can start typing the real number immediately
  // instead of having to select-all/backspace the placeholder zero first. A
  // field left empty on blur reverts to "0" — never any other value is ever
  // touched by this, and no state update is needed for either direction
  // (the underlying ingredients[idx] value was already 0 the whole time,
  // since an "input" event only ever fires from an actual keystroke).
  listEl.addEventListener("focusin", (e) => {
    const input = e.target.closest(".ingredient-input");
    if (input && input.value === "0") input.value = "";
  });
  listEl.addEventListener("focusout", (e) => {
    const input = e.target.closest(".ingredient-input");
    if (input && input.value.trim() === "") input.value = "0";
  });

  listEl.addEventListener("change", (e) => {
    const checkbox = e.target.closest(".ingredient-per100-checkbox");
    if (!checkbox) return;
    const idx = Number(checkbox.dataset.idx);
    // Purely an interpretation flag — never touches ingredients[idx]'s own
    // field values, so nothing typed is ever cleared or converted by
    // checking/unchecking this. A full re-render is safe here (unlike the
    // "input" listener above) since a checkbox click never has mid-keystroke
    // focus to preserve.
    per100Mode[idx] = checkbox.checked;
    renderRows();
  });

  listEl.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".ingredient-remove");
    if (removeBtn) {
      const idx = Number(removeBtn.dataset.idx);
      ingredients.splice(idx, 1);
      originals.splice(idx, 1);
      per100Mode.splice(idx, 1);
      if (ingredients.length === 0) {
        ingredients.push(blankIngredient());
        originals.push(null);
        per100Mode.push(false);
      }
      renderRows();
      return;
    }

    const duplicateBtn = e.target.closest(".ingredient-duplicate");
    if (duplicateBtn) {
      const idx = Number(duplicateBtn.dataset.idx);
      // A shallow copy, right after the source row — including its
      // weight-scaling snapshot (if any) and its per-100g state, so the
      // clone behaves exactly like the row it came from instead of
      // resetting to a brand-new manually-typed row.
      ingredients.splice(idx + 1, 0, { ...ingredients[idx] });
      originals.splice(idx + 1, 0, originals[idx] ? { ...originals[idx] } : null);
      per100Mode.splice(idx + 1, 0, per100Mode[idx]);
      renderRows();
      return;
    }
  });

  if (addBtnEl) {
    addBtnEl.addEventListener("click", () => {
      ingredients.push(blankIngredient());
      originals.push(null);
      per100Mode.push(false);
      renderRows();
      // Focus the newly added row's name field — this can be a multi-step
      // add-several-ingredients flow, so the next keystroke should land
      // straight in the field the user needs, not require an extra tap.
      // (Also the point where the *first* row grows its own name field for
      // the first time, now that there are 2+ ingredients — see isFlat.)
      const lastRow = listEl.querySelector(`.ingredient-row[data-idx="${ingredients.length - 1}"]`);
      lastRow?.querySelector(".ingredient-name")?.focus();
    });
  }

  return {
    setIngredients(list) {
      ingredients = (list?.length ? list : [blankIngredient()]).map((ing) => ({ ...ing }));
      originals = ingredients.map((ing) => (ing.weight_g > 0 ? { ...ing } : null));
      // Always starts every row unchecked, even when re-seeding: a caller
      // supplying a real source (AI scan, saved meal, existing log) already
      // has absolute numbers, so there's nothing per-100g mode would add
      // here.
      per100Mode = ingredients.map(() => false);
      renderRows();
    },
    getIngredients() {
      // Resolve per-100g rows to their real totals, then drop fully-empty
      // trailing rows a user added then abandoned (no name, no weight)
      // rather than submitting a junk zero-value ingredient — this is the
      // "calculates the final totals under the hood before submitting" step,
      // and the only place resolveIngredient's output is ever actually used
      // for a submission (the fields on screen are never overwritten by it).
      const resolved = resolvedList();
      const cleaned = resolved.filter((ing, idx) => idx === 0 || ing.food_name.trim() || ing.weight_g > 0);
      return cleaned.map((ing) => ({ ...ing, food_name: ing.food_name.trim() || t("ingredients.unnamed") }));
    },
    getAggregate() {
      return computeAggregate(this.getIngredients());
    },
  };
}
