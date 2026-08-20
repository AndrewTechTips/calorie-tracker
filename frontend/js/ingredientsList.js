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
import { caloriesFromMacros, estimateFiberFromCarbs, roundTo1, scaleMacrosByWeight } from "./nutritionMath.js?v=20260820j";
import { t } from "./i18n.js?v=20260820j";
import { escapeHtml } from "./ui.js?v=20260820j";

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

// Same tag glyph the old (removed) label-mode toggle used — kept for visual
// continuity, it's the one icon in this file's history that's already been
// vetted against the app's palette for "this row has label-style scaling
// available" at a glance.
const SCALE_ICON = `<svg viewBox="0 0 24 24" fill="none"><path d="M11.3 3.5H6a2.5 2.5 0 00-2.5 2.5v5.3c0 .53.21 1.04.59 1.41l8.3 8.3a2 2 0 002.82 0l5.3-5.3a2 2 0 000-2.82l-8.3-8.3a2 2 0 00-1.41-.59z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/></svg>`;

// Creates a self-contained editor bound to a list container + (optional)
// totals strip container. Callers only ever need setIngredients() (to seed
// from an AI/barcode result, an existing log, or a blank new entry) and
// getIngredients() (to read the current rows back out at submit time) — all
// row add/remove/edit/rescale/re-render logic lives here so every mount site
// behaves identically.
// enableScaleTool gates the "Scale from label" mini-calculator (see
// renderScaleSection/applyScale below). It only belongs in the purely manual
// entry flow: the AI scan/describe/barcode review sheet (scan.js) and the
// recipe portion editor (discover.js) already auto-rescale macros
// proportionally from their own AI/recipe baseline whenever weight_g
// changes (see the plain `originals`-based rescale further down in the
// input listener), so a second, conflicting scaling tool there would be
// redundant at best and confusing at worst. Defaults to off; only app.js's
// manual-entry mount opts in.
export function createIngredientsEditor({ listEl, totalsEl, addBtnEl, onTotalsChange, enableScaleTool = false }) {
  let ingredients = [blankIngredient()];
  // Parallel array: the snapshot each row had when it was first seeded (from
  // an AI/barcode/saved source), or last had its weight scaled from — lets a
  // plain weight edit auto-rescale the rest of that row proportionally (e.g.
  // "I actually ate 250g of what the AI scanned, not 200g"). A brand new
  // manually-added row has no known per-gram density to scale from, so its
  // slot here is null and weight edits on it are accepted as-is with no
  // auto-rescale. Ignored for a row whose "Scale from label" tool is open
  // (see scaleTool below) — that tool drives the rescale instead, from its
  // own basis, while it's active.
  let originals = [null];
  // Parallel array: null when row idx's "Scale from label" mini-tool is
  // collapsed. When open: { basis, referenceWeight }. `basis` is a one-time
  // snapshot — {calories, protein, carbs, fats, fiber, sugar, sodium} — of
  // this row's fields taken the instant the tool was opened, i.e. "the
  // label's own numbers, at referenceWeight grams". `referenceWeight` is
  // whatever the user has typed into the tool's own "Label says" field.
  // Every time referenceWeight or this row's weight_g changes while the tool
  // is open, applyScale() below recomputes calories/protein/carbs/fats/
  // fiber/sugar/sodium as basis*ratio and writes the result straight into
  // the SAME fields the plain grid shows and getIngredients() reads — there
  // is no second "resolve at read time" step the way the old per-100g
  // checkbox mode had, so nothing about what's on screen can ever diverge
  // from what gets submitted.
  let scaleTool = [null];

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

  // Recomputes row idx's calories/protein/carbs/fats/fiber/sugar/sodium from
  // its scale-tool basis at the current ratio (actual weight ÷ reference
  // weight) and writes the results directly into that row's own visible
  // inputs — the one place this tool ever touches those fields. A ratio that
  // isn't resolvable yet (reference weight not typed, or weight_g still 0)
  // leaves the fields exactly as they are: still showing whatever the user
  // last typed, never a guessed or blanked value.
  function applyScale(idx, row) {
    const tool = scaleTool[idx];
    if (!tool) return;
    const ref = Number(tool.referenceWeight) || 0;
    const actual = Number(ingredients[idx].weight_g) || 0;
    if (ref > 0 && actual > 0) {
      const ratio = actual / ref;
      const b = tool.basis;
      ingredients[idx] = {
        ...ingredients[idx],
        calories: Math.round(b.calories * ratio),
        protein: roundTo1(b.protein * ratio),
        carbs: roundTo1(b.carbs * ratio),
        fats: roundTo1(b.fats * ratio),
        fiber: roundTo1(b.fiber * ratio),
        sugar: roundTo1(b.sugar * ratio),
        sodium: Math.round(b.sodium * ratio),
      };
      FIELD_DEFS.forEach((f) => {
        if (f.key === "weight_g") return;
        const fieldInput = row?.querySelector(`.ingredient-input[data-field="${f.key}"]`);
        if (fieldInput) fieldInput.value = ingredients[idx][f.key];
      });
    }
    updateScaleStatus(idx, row, ref, actual);
    renderTotals();
  }

  // Surgical update of the panel's one line of live feedback — either the
  // resolved "×N, from Xg to Yg" readout or, before both weights are known,
  // a plain instruction. Never a full re-render, so it can run on every
  // keystroke in either weight field without disturbing focus.
  function updateScaleStatus(idx, row, ref, actual) {
    const statusEl = row?.querySelector(".ingredient-scale-status");
    if (!statusEl) return;
    if (ref > 0 && actual > 0) {
      statusEl.textContent = t("ingredients.scaleApplied", { ratio: roundTo1(actual / ref), ref, actual });
      statusEl.classList.remove("is-hint");
    } else {
      statusEl.textContent = t("ingredients.scaleHint");
      statusEl.classList.add("is-hint");
    }
  }

  // The "Scale from label" toggle + (when open) its panel, rendered above
  // the plain field grid. Collapsed by default on every row — a user who
  // just wants to type final numbers never sees this at all, per the brief's
  // "no friction for direct typers" requirement.
  function renderScaleSection(idx) {
    if (!enableScaleTool) return "";
    const tool = scaleTool[idx];
    const ing = ingredients[idx];
    const toggle = `
      <button type="button" class="ingredient-scale-toggle${tool ? " active" : ""}" data-idx="${idx}"
              aria-pressed="${tool ? "true" : "false"}">
        ${SCALE_ICON}<span>${t("ingredients.scaleToggle")}</span>
      </button>`;
    if (!tool) return toggle;
    const ref = Number(tool.referenceWeight) || 0;
    const actual = Number(ing.weight_g) || 0;
    const hasRatio = ref > 0 && actual > 0;
    return `
      ${toggle}
      <div class="ingredient-scale-panel">
        <div class="ingredient-scale-inputs">
          <label class="ingredient-scale-field">
            <span>${t("ingredients.scaleRefLabel")}</span>
            <div class="ingredient-scale-field-row">
              <input type="number" class="ingredient-input ingredient-scale-ref" data-idx="${idx}" data-field="reference_weight"
                     step="1" min="1" max="10000" inputmode="numeric" pattern="[0-9]*" placeholder="100"
                     value="${tool.referenceWeight || ""}" />
              <span class="ingredient-scale-unit">g</span>
            </div>
          </label>
          <span class="ingredient-scale-arrow" aria-hidden="true">→</span>
          <label class="ingredient-scale-field">
            <span>${t("ingredients.scaleActualLabel")}</span>
            <div class="ingredient-scale-field-row">
              <input type="number" class="ingredient-input ingredient-scale-actual" data-idx="${idx}" data-field="weight_g"
                     step="1" min="0" max="3000" inputmode="numeric" pattern="[0-9]*" placeholder="0"
                     value="${actual || ""}" />
              <span class="ingredient-scale-unit">g</span>
            </div>
          </label>
        </div>
        <p class="ingredient-scale-status${hasRatio ? "" : " is-hint"}">${
          hasRatio ? t("ingredients.scaleApplied", { ratio: roundTo1(actual / ref), ref, actual }) : t("ingredients.scaleHint")
        }</p>
      </div>`;
  }

  function renderFieldGrid(idx) {
    const ing = ingredients[idx];
    return `
      ${renderScaleSection(idx)}
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

    // The scale-tool's own "Label says" field — never touches a macro field
    // itself, only feeds applyScale, which does.
    if (field === "reference_weight") {
      if (scaleTool[idx]) scaleTool[idx].referenceWeight = input.value;
      applyScale(idx, row);
      return;
    }

    // Weight — edited from either the main grid's own input or the scale
    // tool's mirrored "You ate" input (same data-field, two DOM nodes while
    // the tool is open; see renderScaleSection). Whichever one fired, sync
    // the other one to match (never touching the node that's actually being
    // typed into, so a mid-keystroke edit is never fought), then rescale:
    // from the scale-tool's basis if it's open, otherwise from `originals`
    // exactly as before.
    if (field === "weight_g") {
      ingredients[idx].weight_g = value;
      row?.querySelectorAll('.ingredient-input[data-field="weight_g"]').forEach((node) => {
        if (node !== input) node.value = input.value;
      });
      if (scaleTool[idx]) {
        applyScale(idx, row);
      } else if (originals[idx]?.weight_g) {
        const scaled = scaleMacrosByWeight(originals[idx], value);
        ingredients[idx] = {
          ...ingredients[idx],
          weight_g: value,
          calories: scaled.calories,
          protein: scaled.protein,
          carbs: scaled.carbs,
          fats: scaled.fats,
          fiber: originals[idx].fiber ? scaled.fiber : estimateFiberFromCarbs(scaled.carbs, ingredients[idx].food_name),
          sugar: scaled.sugar,
          sodium: scaled.sodium,
        };
        FIELD_DEFS.forEach((f) => {
          if (f.key === "weight_g") return;
          const fieldInput = row?.querySelector(`.ingredient-input[data-field="${f.key}"]`);
          if (fieldInput) fieldInput.value = ingredients[idx][f.key];
        });
      }
      renderTotals();
      return;
    }

    // A direct hand-edit to calories/protein/carbs/fats/fiber while the
    // scale tool is open means the user is overriding its output — collapse
    // the tool now rather than silently clobbering that edit the next time
    // a weight field changes (applyScale would otherwise overwrite it from
    // the tool's now-stale basis).
    if (scaleTool[idx]) {
      scaleTool[idx] = null;
      row?.querySelector(".ingredient-scale-panel")?.remove();
      const toggleBtn = row?.querySelector(".ingredient-scale-toggle");
      toggleBtn?.classList.remove("active");
      toggleBtn?.setAttribute("aria-pressed", "false");
    }

    ingredients[idx][field] = value;
    // Reactive math: tweaking protein/carbs/fats recomputes THIS row's own
    // calories from the standard energy-density formula (see
    // nutritionMath.js's caloriesFromMacros), live — a user editing a macro
    // by hand should never have to separately go work out and retype the
    // new calorie total themselves. Calories itself (and fiber, which this
    // app doesn't fold into the calorie total — see caloriesFromMacros' own
    // comment) stays a plain directly-editable field with no reverse
    // cascade: a single calorie number can't be un-mixed back into a
    // protein/carb/fat split.
    if (field === "protein" || field === "carbs" || field === "fats") {
      ingredients[idx].calories = caloriesFromMacros(ingredients[idx]);
      const calInput = row?.querySelector('.ingredient-input[data-field="calories"]');
      if (calInput) calInput.value = ingredients[idx].calories;
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
  // since an "input" event only ever fires from an actual keystroke). Every
  // numeric input in this editor — including the scale tool's own reference/
  // actual-weight fields — shares the one ".ingredient-input" class, so this
  // behavior covers all of them automatically with no special-casing.
  listEl.addEventListener("focusin", (e) => {
    const input = e.target.closest(".ingredient-input");
    if (input && input.value === "0") input.value = "";
  });
  listEl.addEventListener("focusout", (e) => {
    const input = e.target.closest(".ingredient-input");
    if (input && input.value.trim() === "") input.value = "0";
  });

  listEl.addEventListener("click", (e) => {
    const scaleToggle = enableScaleTool ? e.target.closest(".ingredient-scale-toggle") : null;
    if (scaleToggle) {
      const idx = Number(scaleToggle.dataset.idx);
      if (scaleTool[idx]) {
        scaleTool[idx] = null;
      } else {
        const ing = ingredients[idx];
        // Snapshot whatever's currently in the row's own fields as the
        // basis — "the label's numbers, at referenceWeight grams". This is
        // deliberately taken once, at open time, not kept live-synced to
        // further hand-edits (see the input listener's auto-close above) —
        // otherwise a user typing the label's macro numbers AFTER opening
        // the tool, then adjusting the reference/actual weight, could end up
        // scaling a half-typed number mid-keystroke.
        scaleTool[idx] = {
          basis: {
            calories: ing.calories,
            protein: ing.protein,
            carbs: ing.carbs,
            fats: ing.fats,
            fiber: ing.fiber,
            sugar: ing.sugar,
            sodium: ing.sodium,
          },
          referenceWeight: null,
        };
      }
      renderRows();
      if (scaleTool[idx]) {
        listEl.querySelector(`.ingredient-row[data-idx="${idx}"] .ingredient-scale-ref`)?.focus();
      }
      return;
    }

    const removeBtn = e.target.closest(".ingredient-remove");
    if (removeBtn) {
      const idx = Number(removeBtn.dataset.idx);
      ingredients.splice(idx, 1);
      originals.splice(idx, 1);
      scaleTool.splice(idx, 1);
      if (ingredients.length === 0) {
        ingredients.push(blankIngredient());
        originals.push(null);
        scaleTool.push(null);
      }
      renderRows();
      return;
    }

    const duplicateBtn = e.target.closest(".ingredient-duplicate");
    if (duplicateBtn) {
      const idx = Number(duplicateBtn.dataset.idx);
      // A shallow copy, right after the source row — including its
      // weight-scaling snapshot (if any), so the clone behaves like the row
      // it came from instead of resetting to a brand-new manually-typed row.
      // Its scale tool always starts collapsed, even if the source row's was
      // open — a basis snapshot is specific to the moment it was taken, not
      // something that should silently carry over to a second row.
      ingredients.splice(idx + 1, 0, { ...ingredients[idx] });
      originals.splice(idx + 1, 0, originals[idx] ? { ...originals[idx] } : null);
      scaleTool.splice(idx + 1, 0, null);
      renderRows();
      return;
    }
  });

  if (addBtnEl) {
    addBtnEl.addEventListener("click", () => {
      ingredients.push(blankIngredient());
      originals.push(null);
      scaleTool.push(null);
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
      // Always starts every row's scale tool collapsed, even when
      // re-seeding: a caller supplying a real source (AI scan, saved meal,
      // existing log) already has absolute numbers, so there's nothing to
      // scale from until the user explicitly opens it.
      scaleTool = ingredients.map(() => null);
      renderRows();
    },
    getIngredients() {
      // Every row's fields are always the real, final absolute numbers —
      // applyScale() already wrote the scaled totals straight into them, so
      // there's no separate resolve-at-read-time step here. Drop fully-empty
      // trailing rows a user added then abandoned (no name, no weight)
      // rather than submitting a junk zero-value ingredient.
      const cleaned = ingredients.filter((ing, idx) => idx === 0 || ing.food_name.trim() || ing.weight_g > 0);
      return cleaned.map((ing) => ({ ...ing, food_name: ing.food_name.trim() || t("ingredients.unnamed") }));
    },
    getAggregate() {
      return computeAggregate(this.getIngredients());
    },
  };
}
