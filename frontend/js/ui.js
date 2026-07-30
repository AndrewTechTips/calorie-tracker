import { getLocale, t } from "./i18n.js?v=20260730d";
import { getCalorieStatus } from "./coach.js?v=20260730d";

const RING_CIRCUMFERENCE = 2 * Math.PI * 88; // matches r="88" in the SVG
const CAPSULE_HEIGHT = 112; // matches .water-capsule's fixed height in style.css

const el = (id) => document.getElementById(id);

// Static, non-user-derived SVG markup — safe to set via innerHTML since no
// dynamic data is ever interpolated into these strings.
const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5v5.5M12 16.3v.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  default: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5.5M12 7.7v.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
};

// `action` (optional): { label, onClick } — renders a tappable action inside
// the toast itself (currently just "Undo" on delete toasts) and keeps the
// toast on screen longer (6s vs the normal 2.6s) so there's actually enough
// time to tap it. Clicking it (or the toast auto-hiding) both clear any
// previous action handler first, so a fast second toast can never end up
// accidentally wired to a stale one.
export function showToast(message, variant = "default", action = null) {
  const toast = el("toast");
  const actionBtn = el("toast-action");
  el("toast-message").textContent = message;
  el("toast-icon").innerHTML = TOAST_ICONS[variant] || TOAST_ICONS.default;
  toast.className = "toast show" + (variant !== "default" ? ` ${variant}` : "");
  toast.hidden = false;

  actionBtn.onclick = null;
  if (action) {
    actionBtn.textContent = action.label;
    actionBtn.hidden = false;
    actionBtn.onclick = () => {
      action.onClick();
      clearTimeout(showToast._t);
      toast.classList.remove("show");
      setTimeout(() => (toast.hidden = true), 300);
    };
  } else {
    actionBtn.hidden = true;
  }

  clearTimeout(showToast._t);
  showToast._t = setTimeout(
    () => {
      toast.classList.remove("show");
      setTimeout(() => (toast.hidden = true), 300);
    },
    action ? 6000 : 2600,
  );
}

const UNDO_WINDOW_MS = 5000;

// Shared by every delete flow in the app (food logs, saved meals, water,
// weight, measurements): removes the item from the UI immediately, but
// delays the actual DELETE request until the undo window passes, so tapping
// "Undo" on the toast can cancel it before it's ever sent — there's no
// undelete endpoint, so once the request actually goes out this can't be
// reversed anymore. `removeNow`/`restore` are the caller's own state+render
// mutation (each screen owns its own state shape); `callDelete` is the real
// API call, only ever invoked once the window has passed uncancelled.
export function deleteWithUndo({ removeNow, restore, callDelete, removedToastKey, revertToastKey }) {
  removeNow();
  let undone = false;
  const timer = setTimeout(async () => {
    if (undone) return;
    try {
      await callDelete();
    } catch (err) {
      restore();
      showToast(err.message || t(revertToastKey), "error");
    }
  }, UNDO_WINDOW_MS);

  showToast(t(removedToastKey), "success", {
    label: t("common.undo"),
    onClick: () => {
      undone = true;
      clearTimeout(timer);
      restore();
    },
  });
}

// Smoothly counts a displayed number from its last-rendered value to a new
// one instead of snapping instantly — used for every stat that can change
// from a user action (calories left, macro grams, water ml).
function animateNumber(id, to, formatter = (n) => Math.round(n).toLocaleString()) {
  const node = el(id);
  const from = node.dataset.rawValue !== undefined ? Number(node.dataset.rawValue) : 0;
  node.dataset.rawValue = String(to);

  if (node._animRaf) cancelAnimationFrame(node._animRaf);
  if (Math.abs(to - from) < 0.5) {
    node.textContent = formatter(to);
    return;
  }

  const duration = 650;
  const start = performance.now();
  const change = to - from;
  const step = (now) => {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    node.textContent = formatter(from + change * eased);
    if (progress < 1) {
      node._animRaf = requestAnimationFrame(step);
    } else {
      node.textContent = formatter(to);
    }
  };
  node._animRaf = requestAnimationFrame(step);
}

// `name` is optional and only known once targets have loaded — called
// without it at boot (before sign-in), then again with it once available.
export function setGreeting(name) {
  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour < 12 ? t("header.greetingMorning") : hour < 18 ? t("header.greetingAfternoon") : t("header.greetingEvening");
  el("greeting-date").textContent = now.toLocaleDateString(getLocale(), {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  document.querySelector(".greeting").textContent = name ? `${greeting}, ${name}` : greeting;
}

// Shared by the dashboard render below and the End Day summary (app.js) —
// both need "today's totals" from the same list of logs.
export function computeDailyTotals(logs) {
  return logs.reduce(
    (acc, log) => {
      acc.calories += log.calories;
      acc.protein += log.protein;
      acc.carbs += log.carbs;
      acc.fats += log.fats;
      acc.fiber += log.fiber || 0;
      return acc;
    },
    { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 }
  );
}

// `logs` is today's log_date-scoped entries (see todaysLogs() in app.js) —
// it drives everything below: ring, macro bars, status banner, and the
// visible log list. `dayEnded` (true once the user has pressed "End day" for
// today — backend/routers/day.py) overrides the status banner with a locked
// notice instead of the usual calorie-status message; it does NOT clear the
// ring/macros/list, since ending a day no longer starts a fresh one — it
// just blocks further logging until real local midnight.
export function renderDashboard(targets, logs, water, highlightId, dayEnded) {
  const totals = computeDailyTotals(logs);

  // Calorie ring
  const calProgress = Math.min(totals.calories / (targets.daily_calories || 1), 1);
  const offset = RING_CIRCUMFERENCE * (1 - calProgress);
  const overTarget = totals.calories > targets.daily_calories;
  const ring = el("ring-calories");
  ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  ring.style.strokeDashoffset = String(offset);
  ring.style.stroke = overTarget ? "var(--c-danger)" : "var(--c-calories)";
  el("ring-wrap").classList.toggle("over-target", overTarget);

  // Once over target, show how much has been exceeded (not a clamped-at-zero
  // "0 left", which hid the actual overage) and swap the ring's label to say
  // so instead of leaving a now-misleading "kcal left".
  const diff = targets.daily_calories - totals.calories;
  animateNumber("cal-remaining", Math.abs(Math.round(diff)));
  el("ring-label").textContent = overTarget ? t("dashboard.kcalOver") : t("dashboard.kcalLeft");
  el("cal-consumed-of-target").textContent = `${Math.round(totals.calories)} / ${Math.round(targets.daily_calories)} kcal`;

  // Macro bars
  setMacroBar("protein", totals.protein, targets.daily_protein);
  setMacroBar("carbs", totals.carbs, targets.daily_carbs);
  setMacroBar("fats", totals.fats, targets.daily_fats);
  setMacroBar("fiber", totals.fiber, targets.daily_fiber);

  renderStatusBanner(totals, targets);
  if (dayEnded) {
    const banner = el("status-banner");
    banner.dataset.tone = "info";
    banner.classList.remove(...STATUS_TONES.map((toneName) => `tone-${toneName}`));
    banner.classList.add("tone-info");
    el("status-banner-text").textContent = t("day.endedBanner");
  }

  // Water
  const waterPct = Math.min((water.total_ml / (water.target_ml || 1)) * 100, 100);
  el("water-liquid").style.height = `${waterPct}%`;
  const capsule = el("water-capsule");
  capsule.classList.toggle("has-water", water.total_ml > 0);
  // --surface-y/--drop-fall-distance drive the splash/droplet CSS (see
  // style.css) so those effects always land at the real water line instead
  // of a fixed height that only looked right at one particular fill level.
  // CAPSULE_HEIGHT matches .water-capsule's fixed height in style.css.
  const surfaceY = CAPSULE_HEIGHT * (1 - waterPct / 100);
  capsule.style.setProperty("--surface-y", `${surfaceY}px`);
  capsule.style.setProperty("--drop-fall-distance", `${Math.max(surfaceY - 4, 4)}px`);
  // How far above the surface the wave crest (see .water-wave in style.css)
  // is allowed to reach, in px. A fixed reach used to be a bigger and bigger
  // fraction of the shrinking headroom as the glass filled up, until a
  // ~90%-full glass had the crest visually touching the rim and reading as
  // completely full well before it was. Scaling this down as the remaining
  // headroom (surfaceY) itself shrinks keeps a full-size, clearly-visible
  // wave whenever there's room for one (anything below ~80% full) while
  // still tapering smoothly to a flat, barely-cresting surface right at
  // 100% — which is also just physically correct (a genuinely full glass
  // can't show much crest above its own rim).
  const waveReach = Math.min(12, surfaceY * 0.5);
  capsule.style.setProperty("--wave-reach", `${waveReach}px`);
  // Steady glow while over the user's own daily target — see .at-target in
  // style.css. Distinct from the hard-cap .overflow state (app.js), which
  // only fires momentarily when an add is actually rejected.
  el("water-visual").classList.toggle("at-target", water.total_ml > water.target_ml);
  animateNumber("water-current", water.total_ml);
  el("water-target").textContent = water.target_ml.toLocaleString();
  renderWaterEntries(water.entries || []);

  renderLogList(logs, highlightId);
}

const STATUS_TONES = ["success", "info", "warning", "danger"];

function renderStatusBanner(totals, targets) {
  const { tone, text } = getCalorieStatus(totals, targets);
  const banner = el("status-banner");
  banner.dataset.tone = tone;
  banner.classList.remove(...STATUS_TONES.map((toneName) => `tone-${toneName}`));
  banner.classList.add(`tone-${tone}`);
  el("status-banner-text").textContent = text;
}

const WATER_DROP_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3s7 7.5 7 12a7 7 0 11-14 0c0-4.5 7-12 7-12z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

// Updates a <ul> in place to match a new item list, instead of wiping and
// rebuilding every <li> on every render. That used to replay each row's
// one-shot entrance animation on every render — even ones triggered by
// something unrelated (e.g. logging water re-rendering the food log too) —
// which is what made lists look like they were reloading constantly.
// Reused nodes only animate in once, when they're genuinely new.
export function reconcileList(listEl, items, { getId, buildHtml, extraClass, itemClass = "log-item" }) {
  const existing = new Map();
  listEl.querySelectorAll(`:scope > .${itemClass}`).forEach((li) => existing.set(li.dataset.id, li));

  let prevNode = null;
  items.forEach((item) => {
    const id = String(getId(item));
    let li = existing.get(id);
    if (li) {
      existing.delete(id);
    } else {
      li = document.createElement("li");
      li.dataset.id = id;
    }
    li.className = [itemClass, extraClass?.(item)].filter(Boolean).join(" ");
    li.innerHTML = buildHtml(item);

    // Keep DOM order in sync with `items`' order — insertBefore on a node
    // that's already exactly where it belongs is skipped, so an unchanged
    // list touches the DOM zero times here.
    const wantedNext = prevNode ? prevNode.nextSibling : listEl.firstChild;
    if (wantedNext !== li) listEl.insertBefore(li, wantedNext);
    prevNode = li;
  });

  existing.forEach((li) => li.remove());
}

export function renderWaterEntries(entries) {
  const list = el("water-entries-list");
  const empty = el("water-entries-empty");

  if (!entries.length) {
    empty.hidden = false;
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    return;
  }
  empty.hidden = true;

  reconcileList(list, entries, {
    getId: (entry) => entry.id,
    buildHtml: (entry) => {
      const time = new Date(entry.logged_at).toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" });
      return `
      <div class="log-item-icon water-item-icon">${WATER_DROP_ICON}</div>
      <div class="log-item-body">
        <div class="log-item-name">${Math.round(entry.amount_ml).toLocaleString()} ml</div>
        <div class="log-item-meta">${time}</div>
      </div>
      <div class="log-item-actions">
        <button data-action="delete-water" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `;
    },
  });
}

function setMacroBar(key, current, target) {
  const pct = Math.min((current / (target || 1)) * 100, 100);
  const over = target > 0 && current > target;
  el(`bar-${key}`).style.width = `${pct}%`;
  animateNumber(`${key}-current`, current);
  el(`${key}-target`).textContent = Math.round(target);

  document.querySelector(`.macro-row[data-macro="${key}"]`)?.classList.toggle("over-target", over);
  const warning = el(`${key}-warning`);
  warning.hidden = !over;
  if (over) warning.setAttribute("aria-label", t("dashboard.overByLabel", { amount: Math.round(current - target) }));
}

export function renderLogList(logs, highlightId) {
  const list = el("log-list");
  const empty = el("log-empty");

  if (!logs.length) {
    empty.hidden = false;
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    return;
  }
  empty.hidden = true;

  const pAbbr = t("dashboard.macroAbbrProtein");
  const cAbbr = t("dashboard.macroAbbrCarbs");
  const fAbbr = t("dashboard.macroAbbrFats");

  reconcileList(list, logs, {
    getId: (log) => log.id,
    extraClass: (log) => (log.id === highlightId ? "log-item-new" : ""),
    buildHtml: (log) => `
      <div class="log-item-icon">${escapeHtml((log.food_name || "?").slice(0, 1).toUpperCase())}</div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(log.food_name)}</div>
        <div class="log-item-meta">${Math.round(log.weight_g)}g · ${pAbbr}${Math.round(log.protein)} ${cAbbr}${Math.round(log.carbs)} ${fAbbr}${Math.round(log.fats)}</div>
      </div>
      <div class="log-item-cal">${Math.round(log.calories)}</div>
      <div class="log-item-actions">
        <button class="favorite-icon-btn" data-action="save-favorite" aria-label="${t("saved.saveAction")}"><svg viewBox="0 0 24 24" fill="none"><path d="M6 4h12v16l-6-4-6 4V4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <button data-action="edit" aria-label="${t("common.edit")}"><svg viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <button data-action="delete" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `,
  });
}

export function renderSavedMeals(meals) {
  const list = el("saved-meals-list");
  const empty = el("saved-empty");

  if (!meals.length) {
    empty.hidden = false;
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    return;
  }
  empty.hidden = true;

  const pAbbr = t("dashboard.macroAbbrProtein");
  const cAbbr = t("dashboard.macroAbbrCarbs");
  const fAbbr = t("dashboard.macroAbbrFats");

  // Same row anatomy as the food log (icon / name+macros / calorie figure /
  // icon-button actions) rather than a one-off green text pill — reads as
  // part of the same system instead of a different component, and the bolt
  // icon (vs. edit/delete's pencil/trash) is what marks this as the
  // "instant log" action specific to saved meals.
  reconcileList(list, meals, {
    getId: (meal) => meal.id,
    buildHtml: (meal) => `
      <div class="log-item-icon">${escapeHtml((meal.name || "?").slice(0, 1).toUpperCase())}</div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(meal.name)}</div>
        <div class="log-item-meta">${Math.round(meal.weight_g)}g · ${pAbbr}${Math.round(meal.protein)} ${cAbbr}${Math.round(meal.carbs)} ${fAbbr}${Math.round(meal.fats)}</div>
      </div>
      <div class="log-item-cal">${Math.round(meal.calories)}</div>
      <div class="log-item-actions">
        <button class="saved-log-icon-btn" data-action="log-saved" aria-label="${t("saved.logBtn")}"><svg viewBox="0 0 24 24" fill="none"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <button data-action="edit-saved" aria-label="${t("common.edit")}"><svg viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <button data-action="delete-saved" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `,
  });
}

// Recipe builder (app.js's "+ Recipe" flow) — a checkable list of the
// user's existing saved meals/products, so a few of them can be combined
// into one new saved meal. `selectedIds` is a Set the caller owns; this just
// renders the checked state, app.js's own change listener updates the Set
// and calls this again to reflect it (same "re-render from state" pattern
// as everywhere else, not a form the DOM state can drift out of sync with).
export function renderRecipeIngredientList(savedMeals, selectedIds) {
  const list = el("recipe-ingredient-list");
  const empty = el("recipe-ingredient-empty");

  if (!savedMeals.length) {
    empty.hidden = false;
    list.querySelectorAll(".recipe-ingredient-item").forEach((n) => n.remove());
    return;
  }
  empty.hidden = true;

  reconcileList(list, savedMeals, {
    getId: (meal) => meal.id,
    itemClass: "recipe-ingredient-item",
    extraClass: () => "log-item",
    buildHtml: (meal) => `
      <label class="recipe-ingredient-checkbox">
        <input type="checkbox" data-id="${meal.id}" ${selectedIds.has(meal.id) ? "checked" : ""} />
      </label>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(meal.name)}</div>
        <div class="log-item-meta">${Math.round(meal.weight_g)}g · ${Math.round(meal.calories)} kcal</div>
      </div>
    `,
  });
}

// The Daily History "edit a past day" sheet's entry list — same row anatomy
// as renderLogList (icon / name+macros / calorie figure) but edit/delete
// only, no favorite-bookmark action (out of scope for backdating a
// forgotten entry — see app.js's day-detail-sheet handler).
export function renderDayDetailList(logs) {
  const list = el("day-detail-list");
  const empty = el("day-detail-empty");

  if (!logs.length) {
    empty.hidden = false;
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    return;
  }
  empty.hidden = true;

  const pAbbr = t("dashboard.macroAbbrProtein");
  const cAbbr = t("dashboard.macroAbbrCarbs");
  const fAbbr = t("dashboard.macroAbbrFats");

  reconcileList(list, logs, {
    getId: (log) => log.id,
    buildHtml: (log) => `
      <div class="log-item-icon">${escapeHtml((log.food_name || "?").slice(0, 1).toUpperCase())}</div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(log.food_name)}</div>
        <div class="log-item-meta">${Math.round(log.weight_g)}g · ${pAbbr}${Math.round(log.protein)} ${cAbbr}${Math.round(log.carbs)} ${fAbbr}${Math.round(log.fats)}</div>
      </div>
      <div class="log-item-cal">${Math.round(log.calories)}</div>
      <div class="log-item-actions">
        <button data-action="edit" aria-label="${t("common.edit")}"><svg viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <button data-action="delete" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `,
  });
}

// Plays the "removing" exit transition on a list item before it's actually
// deleted from the server, instead of it just vanishing when the list
// re-renders — resolves once the animation has had time to play out.
export function animateItemRemoval(listId, itemId) {
  const list = el(listId);
  const item = [...list.querySelectorAll(".log-item")].find((node) => node.dataset.id === itemId);
  if (!item) return Promise.resolve();
  item.classList.add("removing");
  return new Promise((resolve) => setTimeout(resolve, 220));
}

const SHEET_IDS = [
  "add-sheet",
  "scan-sheet",
  "manual-sheet",
  "settings-sheet",
  "water-sheet",
  "measurement-sheet",
  "end-day-sheet",
  "day-detail-sheet",
  "save-favorite-choice-sheet",
  "calculator-sheet",
  "recipe-sheet",
  "workout-sheet",
];

export function openSheet(id) {
  const overlay = el(id);
  // Always start from a clean slate, regardless of how initSheetDragToDismiss()
  // (below) may have left this sheet's inline styles from a previous drag —
  // otherwise a leftover inline transform/animation:none from an earlier
  // snap-back or close could silently break this sheet's next entrance.
  const sheet = overlay.querySelector(".sheet");
  if (sheet) {
    sheet.style.transform = "";
    sheet.style.transition = "";
    sheet.style.animation = "";
  }
  overlay.style.opacity = "";
  overlay.style.transition = "";
  overlay.hidden = false;
  // Every sheet shares the same z-index (see .sheet-overlay in style.css) —
  // stacking is otherwise just DOM order, which was never a problem until a
  // sheet could open *on top of* an already-open one (day-detail-sheet →
  // edit → manual-sheet). Moving the just-opened one to the very end of
  // <body> guarantees it paints above every other sheet regardless of where
  // it lives in the markup, without needing per-sheet z-index bookkeeping.
  // A no-op re-append when nothing else is open. Safe to move: this doesn't
  // recreate the node, so event listeners already attached to it (including
  // initSheetDragToDismiss's) stay attached.
  document.body.appendChild(overlay);
  document.body.classList.add("no-scroll");
}
export function closeSheet(id) {
  el(id).hidden = true;
  if (SHEET_IDS.every((sid) => el(sid).hidden)) {
    document.body.classList.remove("no-scroll");
  }
}

// Drag-down-to-dismiss — grab the small pill handle at the top of any sheet
// and drag down; past the threshold (distance or a fast enough flick) it
// closes, otherwise it snaps back. Deliberately scoped to just the handle
// (not the whole sheet) so it can never hijack scrolling a list inside the
// sheet or interfere with tapping any of its buttons — only that one small
// fixed area starts a drag. Pointer Events (not touch/mouse separately) so
// this works the same on mobile touch and desktop mouse. Only ever animates
// `transform`/`opacity`, so it's cheap and stays off the main thread's paint
// path beyond simple compositing; already covered by the global
// prefers-reduced-motion override (near the top of style.css) since that
// forces every transition/animation duration to ~0.
const DRAG_CLOSE_THRESHOLD_PX = 90;
const DRAG_CLOSE_VELOCITY_PX_MS = 0.5; // a fast flick commits even under the distance threshold
const DRAG_SETTLE_MS = 280;

export function initSheetDragToDismiss() {
  SHEET_IDS.forEach((id) => {
    const overlay = el(id);
    const sheet = overlay.querySelector(".sheet");
    const handle = overlay.querySelector(".sheet-handle");
    if (!sheet || !handle) return;

    let startY = 0;
    let startTime = 0;
    let dragging = false;

    const onPointerMove = (e) => {
      if (!dragging) return;
      const deltaY = Math.max(0, e.clientY - startY); // downward only — no rubber-band the other way
      sheet.style.transform = `translateY(${deltaY}px)`;
      overlay.style.opacity = String(Math.max(1 - deltaY / 400, 0.4));
    };

    const endDrag = (committed) => {
      sheet.style.transition = `transform ${DRAG_SETTLE_MS}ms var(--ease)`;
      overlay.style.transition = `opacity ${DRAG_SETTLE_MS}ms var(--ease)`;
      if (committed) {
        sheet.style.transform = "translateY(100%)";
        overlay.style.opacity = "0";
        setTimeout(() => closeSheet(id), DRAG_SETTLE_MS);
      } else {
        sheet.style.transform = "translateY(0)";
        overlay.style.opacity = "1";
      }
    };

    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);

      const deltaY = Math.max(0, e.clientY - startY);
      const velocity = deltaY / Math.max(performance.now() - startTime, 1);
      endDrag(deltaY > DRAG_CLOSE_THRESHOLD_PX || velocity > DRAG_CLOSE_VELOCITY_PX_MS);
    };

    handle.addEventListener("pointerdown", (e) => {
      dragging = true;
      startY = e.clientY;
      startTime = performance.now();
      handle.setPointerCapture(e.pointerId);
      sheet.style.animation = "none"; // takes over from any still-running entrance animation
      sheet.style.transition = "none"; // live 1:1 finger tracking, no easing lag while dragging
      overlay.style.transition = "none";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    });
  });
}

// Called on sign-out (and defensively on sign-in) so a sheet left open in one
// session can never render on top of the auth screen or a different user's data.
export function closeAllSheets() {
  SHEET_IDS.forEach((id) => (el(id).hidden = true));
  document.body.classList.remove("no-scroll");
}

// Click-to-select behavior for a .pill-tabs container (Saved view's
// Meals/Products tabs, the favorite-type toggles in the manual/scan forms) —
// toggles which .pill-tab has .active and reports the newly active one's
// data-type. Purely visual/selection state; callers read the active value
// back via getActivePillType() when they actually need it (e.g. at submit).
export function wirePillTabs(containerId, onChange) {
  el(containerId).addEventListener("click", (e) => {
    const btn = e.target.closest(".pill-tab");
    if (!btn) return;
    el(containerId)
      .querySelectorAll(".pill-tab")
      .forEach((b) => b.classList.toggle("active", b === btn));
    onChange?.(btn.dataset.type);
  });
}

export function getActivePillType(containerId) {
  return el(containerId).querySelector(".pill-tab.active")?.dataset.type || "meal";
}

export function resetPillTabs(containerId, defaultType = "meal") {
  el(containerId)
    .querySelectorAll(".pill-tab")
    .forEach((b) => b.classList.toggle("active", b.dataset.type === defaultType));
}

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
