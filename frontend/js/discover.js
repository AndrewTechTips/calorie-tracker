// The Discover tab — recipes (curated static catalog), workout plans
// (curated static catalog) + a live exercise-library search (wger.de), and
// a live product search (Open Food Facts). See backend/routers/discover.py
// and backend/data/discover_data.py for the server side of all four.
import { api } from "./api.js?v=20260807s";
import { closeSheet, escapeHtml, openSheet, runOrDeferDuringSwipe, showToast, wirePillTabs } from "./ui.js?v=20260807s";
import { getLanguage, onLanguageChange, t } from "./i18n.js?v=20260807s";
import { openProductResult } from "./scan.js?v=20260807s";
import { openWorkoutSheet } from "./progress.js?v=20260807s";
import { cacheDiscoverList, getCachedDiscoverList } from "./db.js?v=20260807s";
import { asImplicitIngredient, createIngredientsEditor } from "./ingredientsList.js?v=20260807s";

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// A distinct pictogram + accent tint per category, instead of one placeholder
// icon repeated across every card — the backend tags each recipe/plan with an
// `icon` key (see backend/data/discover_data.py's module docstring), this
// just maps that key to real app-native artwork. Same stroke-based,
// currentColor line-icon style already used everywhere else in this app
// (header/nav icons etc.) rather than inventing a second visual language, and
// the accent colors reuse the existing macro-ring palette (--c-*-rgb, see
// style.css) rather than adding new brand colors.
// ---------------------------------------------------------------------------
const ICONS = {
  soup: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 11h16a7 7 0 01-7 7h-2a7 7 0 01-7-7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 4c-1 1-1 2 0 3M12 3c-1 1-1 2 0 3M15 4c-1 1-1 2 0 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  grill: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 9h18M3 15h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 5v14M12 5v14M17 5v14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.7"/></svg>',
  stew: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 11h16v3a6 6 0 01-6 6h-4a6 6 0 01-6-6v-3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M2 11h20M9 11V8a3 3 0 016 0v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  mash: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 12h11a5.5 5.5 0 01-5.5 5.5A5.5 5.5 0 014 12z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M17 5v6M19 5v4M21 5v4M19 9v8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  salad: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 11h16a7 7 0 01-7 7h-2a7 7 0 01-7-7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 11c-1-3 1-5 4-5 0 3-2 5-4 5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  bowl: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 11h16a7 7 0 01-7 7h-2a7 7 0 01-7-7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 11v7M8 12.5c0 2 .8 3.8 2 5M16 12.5c0 2-.8 3.8-2 5" stroke="currentColor" stroke-width="1.2" opacity="0.7"/></svg>',
  parfait: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 4h10l-1.5 15a1 1 0 01-1 .9h-5a1 1 0 01-1-.9L7 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.6 10h8.8M8.2 15h7.6" stroke="currentColor" stroke-width="1.3"/></svg>',
  oats: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 12h13a5.5 5.5 0 01-5.5 5.5A5.5 5.5 0 014 12z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><ellipse cx="18.5" cy="6" rx="2" ry="2.7" stroke="currentColor" stroke-width="1.4"/><path d="M18.5 8.7V17" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  fish: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 12c3-4 8-6 13-4 2 .8 4 2.3 5 4-1 1.7-3 3.2-5 4-5 2-10 0-13-4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M16 9l3-3M16 15l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8.5" cy="11.2" r="0.9" fill="currentColor"/></svg>',
  stirfry: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 12c0 3.3 4 6 9 6s9-2.7 9-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3 12h18M20 9l2.5-1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  curry: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 11h16v2a6 6 0 01-6 6h-4a6 6 0 01-6-6v-2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 4.5c1.2.5 1.2 1.5 0 2s-1.2 1.5 0 2M13 4.5c1.2.5 1.2 1.5 0 2s-1.2 1.5 0 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  omelette: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 13c0 4 4 6 9 6s9-2 9-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3 13h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M8 9.5c1.5-2 6.5-2 8 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  dessert: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/><path d="M7 8c1 1 2 1 3 0M14 8c1 1 2 1 3 0M7 16c1-1 2-1 3 0M14 16c1-1 2-1 3 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  sandwich: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 10l8-6 8 6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 10h16v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M5 17h14M6 20h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  pizza: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l9 16H3L12 3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="10" cy="15.5" r="1" fill="currentColor"/><circle cx="14" cy="15.5" r="1" fill="currentColor"/></svg>',
  smoothie: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 8h10l-1.3 10.5a1.5 1.5 0 01-1.5 1.3h-4.4a1.5 1.5 0 01-1.5-1.3L7 8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M15 8l1.5-4.5M9 3.5L10.5 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  pasta: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 12h13a5.5 5.5 0 01-5.5 5.5A5.5 5.5 0 014 12z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 7c1.5 1 1.5 2.5 0 3.5M11 6.5c1.5 1 1.5 2.5 0 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M17 5v6M19 5v4M21 5v4M19 9v8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 10v4M2.5 9v6M7 8v8M17 8v8M19.5 9v6M21.5 10v4M7 12h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fullbody: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M4 9l3-3M20 15l-3 3M8 8l8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.4"/><circle cx="18" cy="18" r="2" stroke="currentColor" stroke-width="1.4"/></svg>',
  bodyweight: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="4.5" r="1.8" stroke="currentColor" stroke-width="1.5"/><path d="M5 18c0-4 1-6 3-7-1-2 0-4 2-4.5 2.5-.6 4 1 4 3 0 1.5-.8 2-1.5 2.5 2 .3 3.5 2 3.5 4.5v2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  upperlower: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v7M9 7l3 3 3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 21v-7M9 17l3-3 3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  brosplit: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="9" r="4" stroke="currentColor" stroke-width="1.6"/><path d="M9.5 12.5L7 20M14.5 12.5L17 20M8 20h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  hiit: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="13" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M10 2h4M12 5v2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13 9l-4 5h3l-1 4 4-5h-3l1-4z" fill="currentColor"/></svg>',
  dumbbell: '<svg viewBox="0 0 24 24" fill="none"><rect x="10" y="9" width="4" height="6" rx="1" stroke="currentColor" stroke-width="1.6"/><path d="M10 11H6M14 11h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 9.5v3M6 8.5v5M18 8.5v5M20 9.5v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  mobility: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="4.5" r="1.8" stroke="currentColor" stroke-width="1.5"/><path d="M12 6.5v6M8 9l4-1.5 4 1.5M9 20l3-7 3 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
// Thematic accent per icon — reuses the app's existing macro-ring palette
// (--c-*-rgb custom properties) rather than inventing new brand colors, just
// like the Settings profile card's decorative pattern already does.
const ICON_COLOR = {
  soup: "calories", grill: "calories", stew: "calories", curry: "calories", brosplit: "calories", hiit: "calories",
  mash: "fiber", salad: "fiber", sandwich: "fiber", bodyweight: "fiber",
  bowl: "protein", stirfry: "protein", omelette: "protein", split: "protein", fullbody: "protein", upperlower: "protein", dumbbell: "protein",
  parfait: "carbs", oats: "carbs", pizza: "carbs", pasta: "carbs",
  fish: "water", smoothie: "water",
  dessert: "fats", mobility: "fats",
};
const DEFAULT_RECIPE_ICON = "bowl";
const DEFAULT_PLAN_ICON = "split";

// Recipe/workout-plan photos are hotlinked from Wikimedia Commons (see
// backend/data/discover_data.py) via its Special:FilePath redirect, which by
// default serves the ORIGINAL uploaded file — often several megabytes for a
// real photo. Special:FilePath also supports a documented `width` query
// param that redirects to a pre-generated thumbnail instead (a 480px-wide
// thumbnail of a ~2MB original was measured at ~28KB — a ~70x reduction),
// which is what actually made the Discover tab feel slow to load. Card
// thumbnails and the bigger detail-sheet hero image request different
// widths; exercise/product photos (wger.de/Open Food Facts) already come
// pre-sized from their own APIs, so this is a deliberate no-op for any URL
// that isn't a Commons one.
const CARD_IMAGE_WIDTH = 480;
const DETAIL_IMAGE_WIDTH = 960;
function wikimediaThumb(url, width) {
  if (!url || !url.includes("commons.wikimedia.org")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}width=${width}`;
}

// Shared by every detail-sheet hero image (recipe/workout-plan/exercise) —
// hides the <img> entirely rather than showing a broken-image glyph if the
// hotlinked third-party photo 404s, same "never show a broken image" rule
// buildCard's own onerror handling applies to grid cards.
function setDetailImage(img, url) {
  img.onerror = null;
  img.onload = null;
  if (!url) {
    img.hidden = true;
    return;
  }
  img.hidden = false;
  img.classList.add("discover-card-image-loading");
  img.onload = () => img.classList.remove("discover-card-image-loading");
  img.onerror = () => {
    img.hidden = true;
  };
  img.src = url;
}

let currentTab = "recipes";
let activeRecipeTag = null;
let activePlanTag = null;
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
    recipes = await getBaselineRecipes();
  } catch {
    // Past the `await` above — same runOrDeferDuringSwipe reasoning as
    // loadRecipes(), so this can't land mid-drag either.
    runOrDeferDuringSwipe(() => (container.hidden = true));
    return;
  }
  const proteinRemaining = Math.max(remainingMacros.protein, 0);
  const proteinIsGap = proteinRemaining > MEANINGFUL_PROTEIN_GAP_G;
  const picks = recipes
    .filter((r) => r.calories > 0 && r.calories <= remainingMacros.calories * CALORIE_OVER_BUDGET_RATIO)
    .sort((a, b) => (proteinIsGap ? b.protein - a.protein : b.calories - a.calories))
    .slice(0, 4);
  if (!picks.length) {
    runOrDeferDuringSwipe(() => (container.hidden = true));
    return;
  }
  runOrDeferDuringSwipe(() => {
    container.hidden = false;
    strip.replaceChildren(
      ...picks.map((r) =>
        buildCard({
          imageUrl: wikimediaThumb(r.image_url, CARD_IMAGE_WIDTH),
          icon: r.icon,
          name: r.name,
          meta: t("discover.recipeMeta", { calories: Math.round(r.calories), minutes: r.prep_minutes }),
          onClick: () => openRecipeDetail(r),
        }),
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Shared card builder — recipes/workout plans use a placeholder icon (no
// external photo source for hand-authored content); exercises/products use
// their real photo when the upstream API has one, falling back to the same
// placeholder treatment when it doesn't.
// ---------------------------------------------------------------------------
function placeholderHtml(iconKey) {
  return `<div class="discover-card-image-placeholder discover-icon-${ICON_COLOR[iconKey] || "protein"}">${ICONS[iconKey]}</div>`;
}

function buildCard({ imageUrl, icon, name, meta, tags, onClick }) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "discover-card";
  const iconKey = icon && ICONS[icon] ? icon : DEFAULT_RECIPE_ICON;
  const imageHtml = imageUrl
    ? `<img class="discover-card-image discover-card-image-loading" src="${imageUrl}" alt="" loading="lazy" decoding="async" />`
    : placeholderHtml(iconKey);
  const tagsHtml = tags?.length
    ? `<div class="discover-card-tags">${tags
        .slice(0, 2)
        .map((tg) => `<span class="discover-card-tag">${escapeHtml(tagLabel(tg))}</span>`)
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
  // A skeleton-shimmer background (discover-card-image-loading, CSS-only)
  // shows until the image actually paints, then fades in — smoother than
  // the previous abrupt pop-in against a flat placeholder color. A 404/
  // broken upstream photo (Wikimedia/wger URLs are hotlinked third-party
  // content this app doesn't control) swaps to the same icon-placeholder
  // treatment used for content with no photo at all, instead of the
  // browser's default broken-image glyph.
  const img = card.querySelector(".discover-card-image");
  if (img) {
    img.addEventListener("load", () => img.classList.remove("discover-card-image-loading"), { once: true });
    img.addEventListener(
      "error",
      () => {
        img.outerHTML = placeholderHtml(iconKey);
      },
      { once: true },
    );
  }
  card.addEventListener("click", onClick);
  return card;
}

// Tags/levels are stored as fixed English filter keys (see discover_data.py)
// so filtering logic never depends on the current UI language — only the
// *displayed* label is translated, via a lookup that falls back to the raw
// key for anything not in the dictionary (t() itself returns the key
// unchanged on a miss, so comparing against the key is how a miss is
// detected here).
function tagLabel(tagKey) {
  const translated = t(`discover.tag.${tagKey}`);
  return translated === `discover.tag.${tagKey}` ? tagKey : translated;
}
function levelLabel(levelKey) {
  const translated = t(`discover.level.${levelKey}`);
  return translated === `discover.level.${levelKey}` ? levelKey : translated;
}

function tagPill(tagText) {
  const span = document.createElement("span");
  span.className = "discover-card-tag";
  span.textContent = tagLabel(tagText);
  return span;
}

// ---------------------------------------------------------------------------
// Language-aware fetch + local cache — every recipe/workout-plan request
// carries the current UI language (backend/routers/discover.py localizes
// server-side, see its module docstring), and the unfiltered baseline list
// per (type, language) is mirrored into IndexedDB (js/db.js) so reopening
// Discover — including offline or on a slow connection — can paint instantly
// from the last known copy while a fresh network fetch runs underneath.
// ---------------------------------------------------------------------------
async function fetchRecipes(params = {}, signal) {
  const language = getLanguage();
  const list = await api.getRecipes({ ...params, language }, { signal });
  if (!params.tag && !params.search) cacheDiscoverList("recipes", language, list);
  return list;
}

// ---------------------------------------------------------------------------
// In-memory dedupe for the unfiltered baseline recipe list specifically —
// separate from the IndexedDB cache above, which persists across sessions
// but still means a real network round-trip on first touch each session.
// renderRecommended() (called from setDiscoverContext, which fires on every
// dashboard state change while Discover is open) and loadRecipes()'s own
// baseline path both want this exact same list; without this they'd each
// fire their own independent GET /discover/recipes. A single in-flight
// promise, keyed by language, means every caller within the same language
// session shares one real request.
// ---------------------------------------------------------------------------
let baselineRecipesLanguage = null;
let baselineRecipesPromise = null;

function getBaselineRecipes() {
  const language = getLanguage();
  if (language !== baselineRecipesLanguage) {
    baselineRecipesLanguage = language;
    baselineRecipesPromise = null;
  }
  if (!baselineRecipesPromise) {
    baselineRecipesPromise = fetchRecipes({}).catch((err) => {
      // Don't cache a failure — the next caller should get a fresh attempt.
      baselineRecipesPromise = null;
      throw err;
    });
  }
  return baselineRecipesPromise;
}

async function fetchWorkoutPlans(params = {}) {
  const language = getLanguage();
  const list = await api.getWorkoutPlans({ ...params, language });
  if (!params.level && !params.tag) cacheDiscoverList("workoutPlans", language, list);
  return list;
}

function renderRecipeGrid(recipes) {
  const grid = el("discover-recipes-grid");
  const empty = el("discover-recipes-empty");
  if (!recipes.length) {
    grid.replaceChildren();
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  grid.replaceChildren(
    ...recipes.map((r) =>
      buildCard({
        imageUrl: wikimediaThumb(r.image_url, CARD_IMAGE_WIDTH),
        icon: r.icon,
        name: r.name,
        meta: t("discover.recipeMeta", { calories: Math.round(r.calories), minutes: r.prep_minutes }),
        tags: r.tags,
        onClick: () => openRecipeDetail(r),
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------
let recipeSearchTimeout = null;
// Debounced the same way products/exercises search already are — recipe
// search used to fire loadRecipes() on every keystroke with nothing to throttle
// it, which was enough on its own to trip the backend's 10-request/10-second
// burst limit (backend/routers/discover.py) during completely normal fast
// typing. Tag-chip taps below stay undebounced (a single deliberate click,
// not a rapid-fire stream).
function scheduleRecipeSearch() {
  clearTimeout(recipeSearchTimeout);
  recipeSearchTimeout = setTimeout(loadRecipes, 400);
}

let recipesAbortController = null;

async function loadRecipes() {
  const search = el("discover-recipes-search").value.trim();
  const params = {};
  if (activeRecipeTag) params.tag = activeRecipeTag;
  if (search) params.search = search;

  // Cache-first instant paint, baseline (unfiltered) view only — a filtered
  // query always goes straight to the network below, same as any other
  // search box in this app. Both this and the network-resolved paint below
  // are past an `await`, so — unlike a plain synchronous call — nothing
  // guarantees either one lands before app.js's initTabSwipe has already
  // unhidden and started transforming this view mid-drag (see
  // runOrDeferDuringSwipe's own comment in ui.js); wrapping the actual DOM
  // mutation is what lets onDiscoverTabOpened() below be safely triggered
  // the instant a drag arms toward this tab instead of only once it commits.
  if (!activeRecipeTag && !search) {
    const cached = await getCachedDiscoverList("recipes", getLanguage());
    if (cached?.length) runOrDeferDuringSwipe(() => renderRecipeGrid(cached));
  }

  // Cancel a still-in-flight previous call so a slow response to an older
  // keystroke can't land after (and overwrite) a newer one's results. Not
  // applicable to the shared baseline request below — there's only ever one
  // "no tag, no search" query, so there's nothing for a newer one to race.
  recipesAbortController?.abort();
  recipesAbortController = new AbortController();
  try {
    const list = !activeRecipeTag && !search ? await getBaselineRecipes() : await fetchRecipes(params, recipesAbortController.signal);
    runOrDeferDuringSwipe(() => renderRecipeGrid(list));
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a newer search — not a real failure
    // A cached render above already gave the user something to look at —
    // only surface the error toast if this was a genuinely empty grid.
    if (!el("discover-recipes-grid").children.length) showToast(err.message || t("discover.loadFailed"), "error");
  }
}

// Recipes are one fixed nutritional total (not a per-ingredient breakdown
// like an AI scan/product result), so this mounts the same shared ingredient
// editor (js/ingredientsList.js, otherwise used for scan/barcode/manual
// entry) seeded with exactly one row — "the whole recipe as logged" — rather
// than a full multi-row editor. That single row's weight_g/calories/protein/
// carbs/fats stay fully editable (weight changes auto-rescale the rest, same
// convenience as everywhere else this editor is mounted), so "I ate more/less
// than a standard serving" is a real edit, not a fixed one-click log.
const recipePortionEditor = createIngredientsEditor({
  listEl: el("recipe-detail-portion-list"),
  totalsEl: el("recipe-detail-totals"),
});

function openRecipeDetail(recipe) {
  setDetailImage(el("recipe-detail-image"), wikimediaThumb(recipe.image_url, DETAIL_IMAGE_WIDTH));
  el("recipe-detail-name").textContent = recipe.name;
  el("recipe-detail-tags").replaceChildren(...recipe.tags.map(tagPill));
  recipePortionEditor.setIngredients([asImplicitIngredient({ ...recipe, food_name: recipe.name })]);
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
    const portion = recipePortionEditor.getAggregate();
    const saved = await api.saveMeal({
      name: recipe.name,
      weight_g: portion.weight_g,
      calories: portion.calories,
      protein: portion.protein,
      carbs: portion.carbs,
      fats: portion.fats,
      fiber: portion.fiber,
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
function renderPlanGrid(plans) {
  el("discover-plans-grid").replaceChildren(
    ...plans.map((p) =>
      buildCard({
        imageUrl: wikimediaThumb(p.image_url, CARD_IMAGE_WIDTH),
        icon: p.icon,
        name: p.name,
        meta: t("discover.planMeta", { days: p.days.length, level: levelLabel(p.level) }),
        tags: p.tags,
        onClick: () => openWorkoutPlanDetail(p),
      }),
    ),
  );
}

async function loadWorkoutPlans() {
  if (!activePlanTag) {
    const cached = await getCachedDiscoverList("workoutPlans", getLanguage());
    if (cached?.length) renderPlanGrid(cached);
  }
  try {
    renderPlanGrid(await fetchWorkoutPlans(activePlanTag ? { tag: activePlanTag } : {}));
  } catch (err) {
    if (!el("discover-plans-grid").children.length) showToast(err.message || t("discover.loadFailed"), "error");
  }
}

// A plan's reps scheme is a display string ("8-10", "AMRAP", "30-45s") — the
// actual workout-log form's reps field is a plain single-number input, so
// this pulls out a sensible starting number (the low end of a range) to
// prefill with rather than leaving it unparsed; schemes with no number at
// all (e.g. "AMRAP") just leave the field blank for the user to fill in.
function firstNumberFrom(text) {
  const match = String(text).match(/\d+/);
  return match ? Number(match[0]) : "";
}

let currentPlanExercises = [];

function openWorkoutPlanDetail(plan) {
  setDetailImage(el("workout-plan-detail-image"), wikimediaThumb(plan.image_url, DETAIL_IMAGE_WIDTH));
  el("workout-plan-detail-name").textContent = plan.name;
  el("workout-plan-detail-tags").replaceChildren(...plan.tags.map(tagPill));
  currentPlanExercises = plan.days.flatMap((day) => day.exercises);
  el("workout-plan-detail-days").innerHTML = plan.days
    .map(
      (day) => `
      <div class="discover-plan-day">
        <div class="discover-plan-day-label">${escapeHtml(day.label)}</div>
        ${day.exercises
          .map(
            (ex, idx) => `
          <div class="discover-plan-exercise-row">
            <div class="discover-plan-exercise-row-main">
              <span class="discover-plan-exercise-name">${escapeHtml(ex.name)}</span>
              <span class="discover-plan-exercise-scheme">${ex.sets} &times; ${escapeHtml(ex.reps)}</span>
              <button type="button" class="discover-plan-exercise-log-btn" data-plan-exercise="${currentPlanExercises.indexOf(ex)}" aria-label="${t("discover.logExerciseAriaLabel", { name: ex.name })}">
                <svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
              </button>
            </div>
            ${ex.description ? `<p class="discover-plan-exercise-howto">${escapeHtml(ex.description)}</p>` : ""}
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

let exercisesAbortController = null;

async function loadExercises() {
  const grid = el("discover-exercises-grid");
  const empty = el("discover-exercises-empty");
  const q = el("discover-exercises-search").value.trim();
  exercisesAbortController?.abort();
  exercisesAbortController = new AbortController();
  try {
    const exercises = await api.searchExercises(q ? { q } : {}, { signal: exercisesAbortController.signal });
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
          imageUrl: wikimediaThumb(ex.image_url, CARD_IMAGE_WIDTH),
          icon: DEFAULT_PLAN_ICON,
          name: ex.name,
          meta: ex.category,
          onClick: () => openExerciseDetail(ex),
        }),
      ),
    );
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a newer search
    showToast(err.message || t("discover.loadFailed"), "error");
  }
}

function openExerciseDetail(exercise) {
  setDetailImage(el("exercise-detail-image"), wikimediaThumb(exercise.image_url, DETAIL_IMAGE_WIDTH));
  el("exercise-detail-name").textContent = exercise.name;
  el("exercise-detail-category").textContent = exercise.category;
  el("exercise-detail-muscles").replaceChildren(...exercise.muscles.map(tagPill));
  el("exercise-detail-equipment").replaceChildren(...exercise.equipment.map(tagPill));
  const descriptionEl = el("exercise-detail-description");
  descriptionEl.textContent = exercise.description || "";
  descriptionEl.hidden = !exercise.description;
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

let productsAbortController = null;

async function loadProducts() {
  const grid = el("discover-products-grid");
  const empty = el("discover-products-empty");
  const loading = el("discover-products-loading");
  const q = el("discover-products-search").value.trim();
  const country = el("discover-products-country").value;
  productsAbortController?.abort();
  if (!q) {
    loading.hidden = true;
    grid.replaceChildren();
    empty.hidden = false;
    empty.querySelector("span:last-child").textContent = t("discover.productsEmpty");
    return;
  }
  productsAbortController = new AbortController();
  // A live external search (Open Food Facts) can take a moment to answer —
  // recipes/exercises paint instantly from cache/local data, products has
  // nothing to show until the network responds, so this fills that gap
  // instead of the grid just looking frozen between the debounce firing and
  // the response landing.
  empty.hidden = true;
  loading.hidden = false;
  try {
    const products = await api.searchProducts(
      { q, language: getLanguage(), ...(country ? { country } : {}) },
      { signal: productsAbortController.signal },
    );
    loading.hidden = true;
    if (!products.length) {
      grid.replaceChildren();
      empty.hidden = false;
      empty.querySelector("span:last-child").textContent = t("discover.productsNoResults");
      return;
    }
    grid.replaceChildren(
      ...products.map((p) =>
        buildCard({
          imageUrl: p.image_url,
          icon: DEFAULT_RECIPE_ICON,
          name: p.food_name,
          meta: p.brand ? `${p.brand} · ${Math.round(p.calories)} kcal/100g` : `${Math.round(p.calories)} kcal/100g`,
          onClick: () => openProductResult(p),
        }),
      ),
    );
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a newer search — loading state left for the newer call to resolve
    loading.hidden = true;
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

  el("discover-recipes-search").addEventListener("input", scheduleRecipeSearch);
  // Two chip rows (goal-phase, and cuisine/diet/speed tags) both drive the
  // same `tag` query param — the backend only filters by one tag at a time,
  // so picking a chip in either row clears any active selection in the
  // other, rather than the two silently fighting over which one "wins".
  el("discover-recipes-filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".discover-chip");
    if (!chip) return;
    const tag = chip.dataset.tag;
    activeRecipeTag = activeRecipeTag === tag ? null : tag;
    el("discover-recipes-filters")
      .querySelectorAll(".discover-chip")
      .forEach((c) => c.classList.toggle("active", c.dataset.tag === activeRecipeTag));
    el("discover-recipes-goal-filters")
      .querySelectorAll(".discover-chip")
      .forEach((c) => c.classList.remove("active"));
    loadRecipes();
  });
  el("discover-recipes-goal-filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".discover-chip");
    if (!chip) return;
    const tag = chip.dataset.tag;
    activeRecipeTag = activeRecipeTag === tag ? null : tag;
    el("discover-recipes-goal-filters")
      .querySelectorAll(".discover-chip")
      .forEach((c) => c.classList.toggle("active", c.dataset.tag === activeRecipeTag));
    el("discover-recipes-filters")
      .querySelectorAll(".discover-chip")
      .forEach((c) => c.classList.remove("active"));
    loadRecipes();
  });

  el("discover-plans-goal-filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".discover-chip");
    if (!chip) return;
    const tag = chip.dataset.tag;
    activePlanTag = activePlanTag === tag ? null : tag;
    el("discover-plans-goal-filters")
      .querySelectorAll(".discover-chip")
      .forEach((c) => c.classList.toggle("active", c.dataset.tag === activePlanTag));
    loadWorkoutPlans();
  });

  el("discover-exercises-search").addEventListener("input", scheduleExerciseSearch);
  el("discover-products-search").addEventListener("input", scheduleProductSearch);
  el("discover-products-country").addEventListener("change", loadProducts);

  el("workout-plan-detail-days").addEventListener("click", (e) => {
    const btn = e.target.closest(".discover-plan-exercise-log-btn");
    if (!btn) return;
    const ex = currentPlanExercises[Number(btn.dataset.planExercise)];
    if (!ex) return;
    closeSheet("workout-plan-detail-sheet");
    openWorkoutSheet(null, ex.name, { sets: ex.sets, reps: firstNumberFrom(ex.reps) });
  });

  // Recipes/plans are localized server-side (see fetchRecipes/
  // fetchWorkoutPlans) — a language switch means whatever's already
  // rendered is now in the wrong language, so force a re-fetch rather than
  // relying on the usual "only load if empty" lazy-load check. Exercise
  // names are never translated (universal gym vocabulary), so that panel is
  // left alone here. Product *results* aren't translated either, but the
  // `language` param now also steers which OFF fields get searched (see
  // loadProducts/search_products's `langs` param) — a stale active query
  // should re-run against the newly-active language too, not just redraw.
  onLanguageChange(() => {
    if (!el("discover-recipes-grid").children.length && !el("discover-plans-grid").children.length) return;
    loadRecipes();
    if (el("discover-plans-grid").children.length) loadWorkoutPlans();
    if (!el("discover-recommended").hidden) renderRecommended();
    if (el("discover-products-search").value.trim()) loadProducts();
  });

  // First real load happens when the Discover tab is actually opened (see
  // app.js's switchView), not here at boot — same lazy-load-on-first-visit
  // convention progress.js's data already follows, most sessions may never
  // open this tab at all.
}

export function onDiscoverTabOpened() {
  // The grid's static skeleton placeholders (index.html's own
  // #discover-recipes-grid) count as "children" too, so an empty-check
  // alone would never fire — loadRecipes() itself always replaces them
  // (grid.replaceChildren(...)) the first time it actually runs, so this
  // only needs to detect "still showing the skeleton, never loaded for
  // real yet," not "currently empty."
  if (el("discover-recipes-grid").querySelector(".discover-card-skeleton")) loadRecipes();
  renderRecommended();
}
