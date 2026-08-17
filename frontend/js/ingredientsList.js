// Shared per-ingredient breakdown editor — mounted identically wherever a
// meal is created or edited (AI scan/describe/barcode result review in
// scan.js, and manual entry / edit log / edit saved meal / new saved meal in
// app.js). Pure DOM + pure functions, no framework, following the same
// dependency-free pattern as nutritionMath.js.
//
// The aggregate (top-level weight/calories/protein/carbs/fats/fiber) is
// ALWAYS the computed sum of the ingredient rows — never an independently
// editable field — so there's never an ambiguity about which number is
// authoritative. This mirrors exactly how the backend finalizes an AI scan
// response (see gemini_service.py::_finalize_ingredients).
import { caloriesFromMacros, estimateFiberFromCarbs, roundTo1, scaleMacrosByWeight } from "./nutritionMath.js?v=20260817d";
import { t } from "./i18n.js?v=20260817d";
import { escapeHtml } from "./ui.js?v=20260817d";

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

// A fresh "nutrition label" snapshot for label-mode's base fields, default
// base amount 100g (the single most common label convention) — the user
// overtypes this to whatever amount their label actually uses (many show
// "per serving (30g)" instead of per-100g), see renderLabelFields below.
function blankLabelBase() {
  return { weight_g: 100, calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0, sugar: 0, sodium: 0 };
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

// A soft, non-blocking "these numbers don't add up" nudge — shown under a
// calories field whenever the typed calories diverge meaningfully from what
// the standard 4/4/9 Atwater formula would give for that same row's
// protein/carbs/fats. Never a validation error (labels round unpredictably,
// alcohol/net-carb labeling conventions genuinely do shift the real number),
// just a tap-to-fix suggestion. Floor of 15 kcal + 12% relative threshold
// keeps it quiet for ordinary label-rounding noise and only fires on a
// genuine mismatch (wrong digit, wrong macro typed, stale calories left over
// from an edited macro).
const CALORIE_MISMATCH_FLOOR = 15;
const CALORIE_MISMATCH_FRACTION = 0.12;

// Common label/serving amounts, offered as one-tap chips on the "amount
// you're eating" field in label mode — the whole point of this mode is
// removing mental math, and most real-world portions cluster around a
// handful of round numbers.
const QUICK_WEIGHTS = [50, 100, 150, 200, 300];

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
// Same fields, minus weight — label mode's base grid asks for macros "as
// printed", with the base amount itself broken out into its own dedicated
// field above (see renderLabelFields) rather than living in this grid.
const LABEL_BASE_FIELD_DEFS = FIELD_DEFS.filter((f) => f.key !== "weight_g");

// Creates a self-contained editor bound to a list container + (optional)
// totals strip container. Callers only ever need setIngredients() (to seed
// from an AI/barcode result, an existing log, or a blank new entry) and
// getIngredients() (to read the current rows back out at submit time) — all
// row add/remove/edit/rescale/re-render logic lives here so every mount site
// behaves identically.
export function createIngredientsEditor({ listEl, totalsEl, addBtnEl, onTotalsChange }) {
  let ingredients = [blankIngredient()];
  // Parallel array: the snapshot each row had when it was first seeded (from
  // an AI/barcode/saved source), last had its weight scaled from, or — new
  // here — the "as printed on the label" base a user typed in label mode. A
  // brand new manually-added row that's never used label mode has no known
  // per-gram density to scale from (same reasoning manual entry's flat form
  // already applied), so its slot here is null and weight edits on it are
  // accepted as-is with no auto-rescale.
  let originals = [null];
  // Parallel array: whether row idx is currently showing the "nutrition
  // label" entry mode (base amount + per-base macros + a separately editable
  // eaten weight, auto-rescaled) instead of the plain absolute-values grid.
  // Always starts false for a freshly-seeded row — an AI/barcode/saved
  // source already has real absolute numbers, no reason to force this mode.
  let labelMode = [false];

  function renderTotals() {
    const agg = computeAggregate(ingredients);
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

  // Recomputes ingredients[idx]'s absolute weight/macros from originals[idx]
  // (the label-mode base) + the currently-set eaten weight — the one
  // rescale path both a base-field edit and an eaten-weight edit funnel
  // through, so they can never drift out of sync with each other.
  function rescaleFromBase(idx) {
    const base = originals[idx];
    const eatenWeight = ingredients[idx].weight_g || 0;
    if (base?.weight_g > 0) {
      const scaled = scaleMacrosByWeight(base, eatenWeight);
      ingredients[idx] = { ...ingredients[idx], weight_g: eatenWeight, ...scaled };
    } else {
      // No usable base yet (label amount not entered/zero) — nothing to
      // scale from, so just record the eaten weight as typed and leave
      // macros at whatever they last were until a base is provided.
      ingredients[idx] = { ...ingredients[idx], weight_g: eatenWeight };
    }
    updateLabelRowLiveUI(idx);
    renderTotals();
  }

  // Shows/hides + fills the tap-to-fix "doesn't add up" hint for row idx's
  // calorie field, comparing `source.calories` (the value currently in that
  // field) against what protein/carbs/fats in that same `source` object
  // implies. `scope` selects which of the row's two possible hint elements
  // (label-mode base, or plain absolute-values mode) to update — a row only
  // ever renders one of the two at a time.
  function updateCalorieHint(idx, row, source, scope) {
    const hintEl = row?.querySelector(`.ingredient-calorie-hint[data-scope="${scope}"]`);
    if (!hintEl || !source) return;
    const expected = caloriesFromMacros(source);
    const actual = Number(source.calories) || 0;
    const mismatch = expected > 0 && Math.abs(actual - expected) >= Math.max(CALORIE_MISMATCH_FLOOR, expected * CALORIE_MISMATCH_FRACTION);
    hintEl.hidden = !mismatch;
    if (mismatch) {
      hintEl.dataset.expected = expected;
      hintEl.textContent = t("ingredients.calorieHint", { value: expected });
    }
  }

  // Surgical (non-full-rerender) DOM sync for label mode after a base-field
  // or eaten-weight edit: updates the base calories field (which may have
  // just cascaded from a protein/carbs/fats edit), the eaten-weight field
  // (mirrors ingredients[idx].weight_g, but skipped while that's literally
  // the field being typed in — a full-value overwrite mid-keystroke would
  // fight the user's own cursor), the live multiplier badge, and the
  // mismatch hint. Mirrors the existing plain-mode "re-render this one row's
  // fields in place" pattern below rather than calling renderRows(), which
  // would drop focus out of whichever field is mid-edit.
  function updateLabelRowLiveUI(idx) {
    const row = listEl.querySelector(`.ingredient-row[data-idx="${idx}"]`);
    if (!row) return;
    const base = originals[idx];
    const eaten = ingredients[idx].weight_g || 0;

    const baseCalInput = row.querySelector('.ingredient-input[data-scope="base"][data-field="calories"]');
    if (baseCalInput && document.activeElement !== baseCalInput && base) baseCalInput.value = base.calories;

    const eatenInput = row.querySelector('.ingredient-input[data-scope="eaten"]');
    if (eatenInput && document.activeElement !== eatenInput) eatenInput.value = eaten || "";

    const badge = row.querySelector(".ingredient-multiplier-badge");
    if (badge) {
      const multiplier = base?.weight_g > 0 ? eaten / base.weight_g : null;
      badge.textContent = multiplier != null ? `×${roundTo1(multiplier)}` : "—";
    }

    updateCalorieHint(idx, row, base, "base");
  }

  function renderNormalFields(idx) {
    const ing = ingredients[idx];
    return `
      <div class="ingredient-row-fields">
        ${FIELD_DEFS.map(
          (f) => `
          <label class="ingredient-field">
            <span>${t(f.labelKey)}</span>
            <input type="number" class="ingredient-input" data-idx="${idx}" data-field="${f.key}"
                   step="${f.step}" min="${f.min}" max="${f.max}" inputmode="${f.inputmode}"
                   ${f.pattern ? `pattern="${f.pattern}"` : ""} value="${ing[f.key]}" />
          </label>`
        ).join("")}
      </div>
      <button type="button" class="ingredient-calorie-hint" data-idx="${idx}" data-scope="normal" hidden></button>
    `;
  }

  function renderLabelFields(idx) {
    const base = originals[idx] || blankLabelBase();
    const eaten = ingredients[idx].weight_g || 0;
    const multiplier = base.weight_g > 0 ? eaten / base.weight_g : null;
    return `
      <div class="ingredient-label-block">
        <div class="ingredient-label-heading">
          <span>${t("ingredients.labelHeading")}</span>
          <label class="ingredient-label-amount">
            <input type="number" class="ingredient-input ingredient-label-amount-input" data-idx="${idx}" data-scope="base" data-field="weight_g"
                   step="1" min="1" max="3000" inputmode="numeric" pattern="[0-9]*" value="${base.weight_g || ""}" />
            <span>${t("ingredients.labelAmountUnit")}</span>
          </label>
        </div>
        <div class="ingredient-row-fields">
          ${LABEL_BASE_FIELD_DEFS.map(
            (f) => `
            <label class="ingredient-field">
              <span>${t(f.labelKey)}</span>
              <input type="number" class="ingredient-input" data-idx="${idx}" data-scope="base" data-field="${f.key}"
                     step="${f.step}" min="${f.min}" max="${f.max}" inputmode="${f.inputmode}"
                     ${f.pattern ? `pattern="${f.pattern}"` : ""} value="${base[f.key] || 0}" />
            </label>`
          ).join("")}
        </div>
        <button type="button" class="ingredient-calorie-hint" data-idx="${idx}" data-scope="base" hidden></button>
        <div class="ingredient-eaten-row">
          <label class="ingredient-field ingredient-eaten-field">
            <span>${t("ingredients.eatenWeightLabel")}</span>
            <input type="number" class="ingredient-input" data-idx="${idx}" data-scope="eaten" data-field="weight_g"
                   step="1" min="0" max="3000" inputmode="numeric" pattern="[0-9]*" value="${eaten || ""}" />
          </label>
          <span class="ingredient-multiplier-badge">${multiplier != null ? `×${roundTo1(multiplier)}` : "—"}</span>
        </div>
        <div class="ingredient-weight-chips" role="group" aria-label="${t("ingredients.quickWeightAriaLabel")}">
          ${QUICK_WEIGHTS.map((w) => `<button type="button" class="ingredient-weight-chip" data-idx="${idx}" data-weight="${w}">${w}g</button>`).join("")}
        </div>
      </div>
    `;
  }

  function renderRows() {
    const canRemove = ingredients.length > 1;
    listEl.innerHTML = ingredients
      .map(
        (ing, idx) => `
      <div class="ingredient-row" data-idx="${idx}">
        <div class="ingredient-row-head">
          <input type="text" class="ingredient-name" data-idx="${idx}" maxlength="100"
                 placeholder="${t("ingredients.namePlaceholder")}" value="${escapeHtml(ing.food_name)}" />
          <button type="button" class="ingredient-label-toggle${labelMode[idx] ? " active" : ""}" data-idx="${idx}"
                  aria-pressed="${labelMode[idx] ? "true" : "false"}" aria-label="${t("ingredients.labelToggleAriaLabel")}"
                  title="${t("ingredients.labelToggleAriaLabel")}">
            <svg viewBox="0 0 24 24" fill="none"><path d="M11.3 3.5H6a2.5 2.5 0 00-2.5 2.5v5.3c0 .53.21 1.04.59 1.41l8.3 8.3a2 2 0 002.82 0l5.3-5.3a2 2 0 000-2.82l-8.3-8.3a2 2 0 00-1.41-.59z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/></svg>
          </button>
          <button type="button" class="ingredient-duplicate" data-idx="${idx}"
                  aria-label="${t("ingredients.duplicateAriaLabel")}">
            <svg viewBox="0 0 24 24" fill="none"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" stroke="currentColor" stroke-width="1.6"/></svg>
          </button>
          <button type="button" class="ingredient-remove" data-idx="${idx}" ${canRemove ? "" : "hidden"}
                  aria-label="${t("ingredients.removeAriaLabel")}">&times;</button>
        </div>
        ${labelMode[idx] ? renderLabelFields(idx) : renderNormalFields(idx)}
      </div>`
      )
      .join("");
    renderTotals();
    // Hints depend on live DOM nodes that innerHTML just replaced, so they're
    // (re)computed in a second pass after the markup above lands.
    ingredients.forEach((_, idx) => {
      const row = listEl.querySelector(`.ingredient-row[data-idx="${idx}"]`);
      if (labelMode[idx]) updateCalorieHint(idx, row, originals[idx], "base");
      else updateCalorieHint(idx, row, ingredients[idx], "normal");
    });
  }

  listEl.addEventListener("input", (e) => {
    const input = e.target.closest(".ingredient-input, .ingredient-name");
    if (!input) return;
    const idx = Number(input.dataset.idx);
    if (input.classList.contains("ingredient-name")) {
      ingredients[idx].food_name = input.value;
      return;
    }
    const scope = input.dataset.scope; // undefined (plain mode), "base", or "eaten"
    const field = input.dataset.field;
    const value = Number(input.value) || 0;

    // Label mode — base ("as printed on the label") field edit: updates the
    // base snapshot, cascades protein/carbs/fats into the base's own
    // calories exactly like plain mode already does for the row's real
    // values, then re-derives the row's absolute weight/macros from the
    // (possibly still-unset) eaten weight.
    if (scope === "base") {
      if (!originals[idx]) originals[idx] = blankLabelBase();
      originals[idx][field] = value;
      if (field === "protein" || field === "carbs" || field === "fats") {
        originals[idx].calories = caloriesFromMacros(originals[idx]);
      }
      rescaleFromBase(idx);
      return;
    }

    // Label mode — "amount you're eating" edit: the whole point of this
    // mode, re-derives the row's absolute weight/macros from the base at
    // this new weight.
    if (scope === "eaten") {
      ingredients[idx].weight_g = value;
      rescaleFromBase(idx);
      return;
    }

    // Plain mode (unchanged): editing weight rescales every other field from
    // this row's known original snapshot, if it has one (an AI/barcode/saved
    // source, or a row that's previously used label mode); editing a macro
    // recomputes this row's own calories reactively.
    const row = listEl.querySelector(`.ingredient-row[data-idx="${idx}"]`);
    if (field === "weight_g" && originals[idx]?.weight_g) {
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
      // retype the new calorie total themselves. Calories itself (and
      // fiber, which this app doesn't fold into the calorie total — see
      // caloriesFromMacros' own comment) stays a plain directly-editable
      // field with no reverse cascade: a single calorie number can't be
      // un-mixed back into a protein/carb/fat split, so editing it is
      // always taken as entered, verbatim (surfaced instead via the
      // tap-to-fix mismatch hint below when it disagrees with the macros).
      if (field === "protein" || field === "carbs" || field === "fats") {
        ingredients[idx].calories = caloriesFromMacros(ingredients[idx]);
        const calInput = row?.querySelector('.ingredient-input[data-field="calories"]');
        if (calInput) calInput.value = ingredients[idx].calories;
      }
    }
    updateCalorieHint(idx, row, ingredients[idx], "normal");
    renderTotals();
  });

  listEl.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".ingredient-remove");
    if (removeBtn) {
      const idx = Number(removeBtn.dataset.idx);
      ingredients.splice(idx, 1);
      originals.splice(idx, 1);
      labelMode.splice(idx, 1);
      if (ingredients.length === 0) {
        ingredients.push(blankIngredient());
        originals.push(null);
        labelMode.push(false);
      }
      renderRows();
      return;
    }

    const duplicateBtn = e.target.closest(".ingredient-duplicate");
    if (duplicateBtn) {
      const idx = Number(duplicateBtn.dataset.idx);
      // A shallow copy, right after the source row — including its
      // weight-scaling snapshot (if any) and its label-mode state, so the
      // clone behaves exactly like the row it came from (still independently
      // rescalable by weight/label-eaten-amount) instead of resetting to a
      // brand-new manually-typed row.
      ingredients.splice(idx + 1, 0, { ...ingredients[idx] });
      originals.splice(idx + 1, 0, originals[idx] ? { ...originals[idx] } : null);
      labelMode.splice(idx + 1, 0, labelMode[idx]);
      renderRows();
      return;
    }

    const toggleBtn = e.target.closest(".ingredient-label-toggle");
    if (toggleBtn) {
      const idx = Number(toggleBtn.dataset.idx);
      labelMode[idx] = !labelMode[idx];
      // Turning label mode ON for a row with no usable base yet (a brand new
      // row, or one whose weight was never scaled from anything) seeds a
      // blank 100g base to fill in — turning it OFF leaves originals[idx]
      // exactly as last edited, so a plain weight edit afterward keeps
      // auto-rescaling from that same base rather than losing it.
      if (labelMode[idx] && !(originals[idx]?.weight_g > 0)) {
        originals[idx] = blankLabelBase();
        if (!ingredients[idx].weight_g) ingredients[idx].weight_g = 100;
      }
      renderRows();
      const row = listEl.querySelector(`.ingredient-row[data-idx="${idx}"]`);
      if (labelMode[idx]) row?.querySelector('.ingredient-input[data-scope="base"][data-field="calories"]')?.focus();
      return;
    }

    const hintBtn = e.target.closest(".ingredient-calorie-hint");
    if (hintBtn && !hintBtn.hidden) {
      const idx = Number(hintBtn.dataset.idx);
      const scope = hintBtn.dataset.scope;
      const expected = Number(hintBtn.dataset.expected);
      if (scope === "base") {
        if (!originals[idx]) return;
        originals[idx].calories = expected;
        rescaleFromBase(idx);
      } else {
        ingredients[idx].calories = expected;
        const row = listEl.querySelector(`.ingredient-row[data-idx="${idx}"]`);
        const calInput = row?.querySelector('.ingredient-input[data-field="calories"]:not([data-scope])');
        if (calInput) calInput.value = expected;
        updateCalorieHint(idx, row, ingredients[idx], "normal");
        renderTotals();
      }
      return;
    }

    const chip = e.target.closest(".ingredient-weight-chip");
    if (chip) {
      const idx = Number(chip.dataset.idx);
      ingredients[idx].weight_g = Number(chip.dataset.weight);
      rescaleFromBase(idx);
      return;
    }
  });

  if (addBtnEl) {
    addBtnEl.addEventListener("click", () => {
      ingredients.push(blankIngredient());
      originals.push(null);
      labelMode.push(false);
      renderRows();
      // Focus the newly added row's name field — this can be a multi-step
      // add-several-ingredients flow, so the next keystroke should land
      // straight in the field the user needs, not require an extra tap.
      const lastRow = listEl.querySelector(`.ingredient-row[data-idx="${ingredients.length - 1}"]`);
      lastRow?.querySelector(".ingredient-name")?.focus();
    });
  }

  return {
    setIngredients(list) {
      ingredients = (list?.length ? list : [blankIngredient()]).map((ing) => ({ ...ing }));
      originals = ingredients.map((ing) => (ing.weight_g > 0 ? { ...ing } : null));
      // Always starts every row in plain mode, even when re-seeding: a
      // caller supplying a real source (AI scan, saved meal, existing log)
      // already has absolute numbers, so there's nothing label mode would
      // add here.
      labelMode = ingredients.map(() => false);
      renderRows();
    },
    getIngredients() {
      // Drop fully-empty trailing rows a user added then abandoned (no name,
      // no weight) rather than submitting a junk zero-value ingredient.
      const cleaned = ingredients.filter((ing, idx) => idx === 0 || ing.food_name.trim() || ing.weight_g > 0);
      return cleaned.map((ing) => ({ ...ing, food_name: ing.food_name.trim() || t("ingredients.unnamed") }));
    },
    getAggregate() {
      return computeAggregate(this.getIngredients());
    },
  };
}
