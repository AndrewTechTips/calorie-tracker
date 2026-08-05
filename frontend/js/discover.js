// The Discover tab — recipes (curated static catalog), workout plans
// (curated static catalog) + a live exercise-library search (wger.de), and
// a live product search (Open Food Facts). See backend/routers/discover.py
// and backend/data/discover_data.py for the server side of all four.
import { api } from "./api.js?v=20260805y";
import { closeSheet, escapeHtml, openSheet, showToast, wirePillTabs } from "./ui.js?v=20260805y";
import { t } from "./i18n.js?v=20260805y";
import { openProductResult } from "./scan.js?v=20260805y";
import { openWorkoutSheet } from "./progress.js?v=20260805y";

const el = (id) => document.getElementById(id);

const RECIPE_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M6 4h12v16l-6-4-6 4V4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const PLAN_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M4 10v4M2.5 9v6M7 8v8M17 8v8M19.5 9v6M21.5 10v4M7 12h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let currentTab = "recipes";
let activeRecipeTag = null;
let onDataChanged = null;

// ---------------------------------------------------------------------------
// Recommended for you — client-side ranking against today's remaining
// macros, the exact same scoring shape as the dashboard's Smart Suggestions
// card (js/suggestions.js's computeFoodSuggestions), just pointed at the
// Discover recipe catalog instead of the user's own saved meals. Fed by
// app.js on every render (see setDiscoverContext), same pattern as
// aiCoach.js's setContext / progress.js's weight-forecast context push.
// ---------------------------------------------------------------------------
let remainingMacros = null;
const MEANINGFUL_PROTEIN_GAP_G = 5;
const CALORIE_OVER_BUDGET_RATIO = 1.2;

export function setDiscoverContext(remaining) {
  remainingMacros = remaining;
  if (!el("view-discover").hidden) renderRecommended();
}

async function renderRecommended() {
  const container = el("discover-recommended");
  const strip = el("discover-recommended-strip");
  if (!remainingMacros || remainingMacros.calories <= 0) {
    container.hidden = true;
    return;
  }
  let recipes;
  try {
    recipes = await api.getRecipes({});
  } catch {
    container.hidden = true;
    return;
  }
  const proteinRemaining = Math.max(remainingMacros.protein, 0);
  const proteinIsGap = proteinRemaining > MEANINGFUL_PROTEIN_GAP_G;
  const picks = recipes
    .filter((r) => r.calories > 0 && r.calories <= remainingMacros.calories * CALORIE_OVER_BUDGET_RATIO)
    .sort((a, b) => (proteinIsGap ? b.protein - a.protein : b.calories - a.calories))
    .slice(0, 4);
  if (!picks.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  strip.replaceChildren(
    ...picks.map((r) =>
      buildCard({
        placeholderIcon: RECIPE_ICON,
        name: r.name,
        meta: t("discover.recipeMeta", { calories: Math.round(r.calories), minutes: r.prep_minutes }),
        onClick: () => openRecipeDetail(r),
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Shared card builder — recipes/workout plans use a placeholder icon (no
// external photo source for hand-authored content); exercises/products use
// their real photo when the upstream API has one, falling back to the same
// placeholder treatment when it doesn't.
// ---------------------------------------------------------------------------
function buildCard({ imageUrl, placeholderIcon, name, meta, tags, onClick }) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "discover-card";
  const imageHtml = imageUrl
    ? `<img class="discover-card-image" src="${imageUrl}" alt="" loading="lazy" />`
    : `<div class="discover-card-image-placeholder">${placeholderIcon}</div>`;
  const tagsHtml = tags?.length
    ? `<div class="discover-card-tags">${tags
        .slice(0, 2)
        .map((tg) => `<span class="discover-card-tag">${escapeHtml(tg)}</span>`)
        .join("")}</div>`
    : "";
  card.innerHTML = `
    ${imageHtml}
    <div class="discover-card-body">
      <span class="discover-card-name">${escapeHtml(name)}</span>
      <span class="discover-card-meta">${escapeHtml(meta)}</span>
      ${tagsHtml}
    </div>
  `;
  card.addEventListener("click", onClick);
  return card;
}

function tagPill(tagText) {
  const span = document.createElement("span");
  span.className = "discover-card-tag";
  span.textContent = tagText;
  return span;
}

function macroGridHtml(item) {
  const rows = [
    [Math.round(item.calories), t("discover.macroCalories")],
    [`${Math.round(item.protein)}g`, t("dashboard.protein")],
    [`${Math.round(item.carbs)}g`, t("dashboard.carbs")],
    [`${Math.round(item.fats)}g`, t("dashboard.fats")],
  ];
  return rows
    .map(
      ([value, label]) => `
      <div class="discover-detail-macro">
        <span class="discover-detail-macro-value mono">${value}</span>
        <span class="discover-detail-macro-label">${escapeHtml(label)}</span>
      </div>
    `,
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------
async function loadRecipes() {
  const grid = el("discover-recipes-grid");
  const empty = el("discover-recipes-empty");
  const search = el("discover-recipes-search").value.trim();
  try {
    const params = {};
    if (activeRecipeTag) params.tag = activeRecipeTag;
    if (search) params.search = search;
    const recipes = await api.getRecipes(params);
    if (!recipes.length) {
      grid.replaceChildren();
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    grid.replaceChildren(
      ...recipes.map((r) =>
        buildCard({
          placeholderIcon: RECIPE_ICON,
          name: r.name,
          meta: t("discover.recipeMeta", { calories: Math.round(r.calories), minutes: r.prep_minutes }),
          tags: r.tags,
          onClick: () => openRecipeDetail(r),
        }),
      ),
    );
  } catch (err) {
    showToast(err.message || t("discover.loadFailed"), "error");
  }
}

function openRecipeDetail(recipe) {
  el("recipe-detail-name").textContent = recipe.name;
  el("recipe-detail-tags").replaceChildren(...recipe.tags.map(tagPill));
  el("recipe-detail-macros").innerHTML = macroGridHtml(recipe);
  el("recipe-detail-ingredients").replaceChildren(
    ...recipe.ingredients.map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }),
  );
  el("recipe-detail-instructions").replaceChildren(
    ...recipe.instructions.map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }),
  );
  el("recipe-detail-log-btn").onclick = () => logRecipe(recipe);
  openSheet("recipe-detail-sheet");
}

async function logRecipe(recipe) {
  const btn = el("recipe-detail-log-btn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("discover.loggingRecipe");
  try {
    const saved = await api.saveMeal({
      name: recipe.name,
      weight_g: recipe.weight_g,
      calories: recipe.calories,
      protein: recipe.protein,
      carbs: recipe.carbs,
      fats: recipe.fats,
      fiber: recipe.fiber,
    });
    await api.logSavedMeal(saved.id);
    showToast(t("discover.recipeLogged"), "success");
    closeSheet("recipe-detail-sheet");
    await onDataChanged?.();
  } catch (err) {
    showToast(err.message || t("discover.recipeLogFailed"), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------------------------------------------------------------------------
// Workout plans (curated, static) + exercise library (live wger.de search)
// ---------------------------------------------------------------------------
async function loadWorkoutPlans() {
  const grid = el("discover-plans-grid");
  try {
    const plans = await api.getWorkoutPlans();
    grid.replaceChildren(
      ...plans.map((p) =>
        buildCard({
          placeholderIcon: PLAN_ICON,
          name: p.name,
          meta: t("discover.planMeta", { days: p.days.length, level: p.level }),
          tags: p.tags,
          onClick: () => openWorkoutPlanDetail(p),
        }),
      ),
    );
  } catch (err) {
    showToast(err.message || t("discover.loadFailed"), "error");
  }
}

function openWorkoutPlanDetail(plan) {
  el("workout-plan-detail-name").textContent = plan.name;
  el("workout-plan-detail-tags").replaceChildren(...plan.tags.map(tagPill));
  el("workout-plan-detail-days").innerHTML = plan.days
    .map(
      (day) => `
      <div class="discover-plan-day">
        <div class="discover-plan-day-label">${escapeHtml(day.label)}</div>
        ${day.exercises
          .map(
            (ex) => `
          <div class="discover-plan-exercise-row">
            <span class="discover-plan-exercise-name">${escapeHtml(ex.name)}</span>
            <span class="discover-plan-exercise-scheme">${ex.sets} &times; ${escapeHtml(ex.reps)}</span>
          </div>
        `,
          )
          .join("")}
      </div>
    `,
    )
    .join("");
  openSheet("workout-plan-detail-sheet");
}

let exerciseSearchTimeout = null;

function scheduleExerciseSearch() {
  clearTimeout(exerciseSearchTimeout);
  exerciseSearchTimeout = setTimeout(loadExercises, 350);
}

async function loadExercises() {
  const grid = el("discover-exercises-grid");
  const empty = el("discover-exercises-empty");
  const q = el("discover-exercises-search").value.trim();
  try {
    const exercises = await api.searchExercises(q ? { q } : {});
    if (!exercises.length) {
      grid.replaceChildren();
      empty.hidden = false;
      empty.querySelector("span:last-child").textContent = q ? t("discover.exercisesNoResults") : t("discover.exercisesEmpty");
      return;
    }
    empty.hidden = true;
    grid.replaceChildren(
      ...exercises.map((ex) =>
        buildCard({
          imageUrl: ex.image_url,
          placeholderIcon: PLAN_ICON,
          name: ex.name,
          meta: ex.category,
          onClick: () => openExerciseDetail(ex),
        }),
      ),
    );
  } catch (err) {
    showToast(err.message || t("discover.loadFailed"), "error");
  }
}

function openExerciseDetail(exercise) {
  const img = el("exercise-detail-image");
  if (exercise.image_url) {
    img.src = exercise.image_url;
    img.hidden = false;
  } else {
    img.hidden = true;
  }
  el("exercise-detail-name").textContent = exercise.name;
  el("exercise-detail-category").textContent = exercise.category;
  el("exercise-detail-muscles").replaceChildren(...exercise.muscles.map(tagPill));
  el("exercise-detail-equipment").replaceChildren(...exercise.equipment.map(tagPill));
  el("exercise-detail-attribution").textContent = exercise.license_author
    ? t("discover.exerciseAttribution", { author: exercise.license_author })
    : "";
  el("exercise-detail-log-btn").onclick = () => {
    closeSheet("exercise-detail-sheet");
    openWorkoutSheet(null, exercise.name);
  };
  openSheet("exercise-detail-sheet");
}

// ---------------------------------------------------------------------------
// Products (live Open Food Facts search) — tapping a result reuses the
// existing scan-result-review form (scan.js's openProductResult) instead of
// a separate confirm UI, since this is already-verified label data exactly
// like a barcode scan.
// ---------------------------------------------------------------------------
let productSearchTimeout = null;

function scheduleProductSearch() {
  clearTimeout(productSearchTimeout);
  productSearchTimeout = setTimeout(loadProducts, 400);
}

async function loadProducts() {
  const grid = el("discover-products-grid");
  const empty = el("discover-products-empty");
  const q = el("discover-products-search").value.trim();
  const country = el("discover-products-country").value;
  if (!q) {
    grid.replaceChildren();
    empty.hidden = false;
    empty.querySelector("span:last-child").textContent = t("discover.productsEmpty");
    return;
  }
  try {
    const products = await api.searchProducts({ q, ...(country ? { country } : {}) });
    if (!products.length) {
      grid.replaceChildren();
      empty.hidden = false;
      empty.querySelector("span:last-child").textContent = t("discover.productsNoResults");
      return;
    }
    empty.hidden = true;
    grid.replaceChildren(
      ...products.map((p) =>
        buildCard({
          imageUrl: p.image_url,
          placeholderIcon: RECIPE_ICON,
          name: p.food_name,
          meta: p.brand ? `${p.brand} · ${Math.round(p.calories)} kcal/100g` : `${Math.round(p.calories)} kcal/100g`,
          onClick: () => openProductResult(p),
        }),
      ),
    );
  } catch (err) {
    showToast(err.message || t("discover.loadFailed"), "error");
  }
}

// ---------------------------------------------------------------------------
export function initDiscover({ onDataChanged: onChanged } = {}) {
  onDataChanged = onChanged;

  wirePillTabs("discover-type-tabs", (type) => {
    currentTab = type;
    ["recipes", "workouts", "products"].forEach((t) => (el(`discover-panel-${t}`).hidden = t !== type));
    if (type === "recipes" && !el("discover-recipes-grid").children.length) loadRecipes();
    if (type === "workouts" && !el("discover-plans-grid").children.length) {
      loadWorkoutPlans();
      loadExercises();
    }
  });

  el("discover-recipes-search").addEventListener("input", loadRecipes);
  el("discover-recipes-filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".discover-chip");
    if (!chip) return;
    const tag = chip.dataset.tag;
    activeRecipeTag = activeRecipeTag === tag ? null : tag;
    el("discover-recipes-filters")
      .querySelectorAll(".discover-chip")
      .forEach((c) => c.classList.toggle("active", c.dataset.tag === activeRecipeTag));
    loadRecipes();
  });

  el("discover-exercises-search").addEventListener("input", scheduleExerciseSearch);
  el("discover-products-search").addEventListener("input", scheduleProductSearch);
  el("discover-products-country").addEventListener("change", loadProducts);

  // First real load happens when the Discover tab is actually opened (see
  // app.js's switchView), not here at boot — same lazy-load-on-first-visit
  // convention progress.js's data already follows, most sessions may never
  // open this tab at all.
}

export function onDiscoverTabOpened() {
  if (!el("discover-recipes-grid").children.length) loadRecipes();
  renderRecommended();
}
