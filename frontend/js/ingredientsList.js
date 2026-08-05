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
import { estimateFiberFromCarbs, roundTo1, scaleMacrosByWeight } from "./nutritionMath.js?v=20260805n";
import { t } from "./i18n.js?v=20260805n";
import { escapeHtml } from "./ui.js?v=20260805n";

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
  };
}

function blankIngredient() {
  return { food_name: "", weight_g: 0, calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 };
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
  };
}

const FIELD_DEFS = [
  { key: "weight_g", labelKey: "field.weight", step: "1", min: "0" },
  { key: "calories", labelKey: "field.calories", step: "1", min: "0" },
  { key: "protein", labelKey: "field.protein", step: "0.1", min: "0" },
  { key: "carbs", labelKey: "field.carbs", step: "0.1", min: "0" },
  { key: "fats", labelKey: "field.fats", step: "0.1", min: "0" },
  { key: "fiber", labelKey: "field.fiber", step: "0.1", min: "0" },
];

// Creates a self-contained editor bound to a list container + (optional)
// totals strip container. Callers only ever need setIngredients() (to seed
// from an AI/barcode result, an existing log, or a blank new entry) and
// getIngredients() (to read the current rows back out at submit time) — all
// row add/remove/edit/rescale/re-render logic lives here so every mount site
// behaves identically.
export function createIngredientsEditor({ listEl, totalsEl, addBtnEl }) {
  let ingredients = [blankIngredient()];
  // Parallel array: the snapshot each row had when it was first seeded (from
  // an AI/barcode/saved source) or last had its weight scaled from. A brand
  // new manually-added row has no known per-gram density to scale from (same
  // reasoning manual entry's flat form already applies), so its slot here is
  // null and weight edits on it are accepted as-is with no auto-rescale.
  let originals = [null];

  function renderTotals() {
    if (!totalsEl) return;
    const agg = computeAggregate(ingredients);
    totalsEl.innerHTML = `
      <span class="ingredient-total-chip chip-calories">${agg.calories} ${t("field.calories")}</span>
      <span class="ingredient-total-chip chip-protein">${agg.protein}g ${t("dashboard.macroAbbrProtein")}</span>
      <span class="ingredient-total-chip chip-carbs">${agg.carbs}g ${t("dashboard.macroAbbrCarbs")}</span>
      <span class="ingredient-total-chip chip-fats">${agg.fats}g ${t("dashboard.macroAbbrFats")}</span>
      <span class="ingredient-total-chip chip-fiber">${agg.fiber}g ${t("dashboard.fiber")}</span>
      <span class="ingredient-total-chip chip-weight">${agg.weight_g}g</span>
    `;
  }

  function renderRows() {
    const canRemove = ingredients.length > 1;
    listEl.innerHTML = ingredients
      .map(
        (ing, idx) => `
      <div class="ingredient-row" data-idx="${idx}">
        <div class="ingredient-row-head">
          <input type="text" class="ingredient-name" data-idx="${idx}"
                 placeholder="${t("ingredients.namePlaceholder")}" value="${escapeHtml(ing.food_name)}" />
          <button type="button" class="ingredient-duplicate" data-idx="${idx}"
                  aria-label="${t("ingredients.duplicateAriaLabel")}">
            <svg viewBox="0 0 24 24" fill="none"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" stroke="currentColor" stroke-width="1.6"/></svg>
          </button>
          <button type="button" class="ingredient-remove" data-idx="${idx}" ${canRemove ? "" : "hidden"}
                  aria-label="${t("ingredients.removeAriaLabel")}">&times;</button>
        </div>
        <div class="ingredient-row-fields">
          ${FIELD_DEFS.map(
            (f) => `
            <label class="ingredient-field">
              <span>${t(f.labelKey)}</span>
              <input type="number" class="ingredient-input" data-idx="${idx}" data-field="${f.key}"
                     step="${f.step}" min="${f.min}" value="${ing[f.key]}" />
            </label>`
          ).join("")}
        </div>
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
      };
      // Re-render this one row's number inputs in place (not the whole list,
      // which would drop focus out of the field the user is actively typing
      // in) — the weight input itself is left alone since it already holds
      // what the user typed.
      const row = listEl.querySelector(`.ingredient-row[data-idx="${idx}"]`);
      FIELD_DEFS.forEach((f) => {
        if (f.key === "weight_g") return;
        const fieldInput = row.querySelector(`.ingredient-input[data-field="${f.key}"]`);
        if (fieldInput) fieldInput.value = ingredients[idx][f.key];
      });
    } else {
      ingredients[idx][field] = value;
    }
    renderTotals();
  });

  listEl.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".ingredient-remove");
    if (removeBtn) {
      const idx = Number(removeBtn.dataset.idx);
      ingredients.splice(idx, 1);
      originals.splice(idx, 1);
      if (ingredients.length === 0) {
        ingredients.push(blankIngredient());
        originals.push(null);
      }
      renderRows();
      return;
    }

    const duplicateBtn = e.target.closest(".ingredient-duplicate");
    if (duplicateBtn) {
      const idx = Number(duplicateBtn.dataset.idx);
      // A shallow copy, right after the source row — including its
      // weight-scaling snapshot (if any), so the clone can still be
      // independently rescaled by weight exactly like the row it came from,
      // instead of behaving like a brand-new manually-typed row.
      ingredients.splice(idx + 1, 0, { ...ingredients[idx] });
      originals.splice(idx + 1, 0, originals[idx] ? { ...originals[idx] } : null);
      renderRows();
      return;
    }
  });

  if (addBtnEl) {
    addBtnEl.addEventListener("click", () => {
      ingredients.push(blankIngredient());
      originals.push(null);
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
