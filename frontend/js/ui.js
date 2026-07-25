import { getLocale, t } from "./i18n.js?v=20260725n";
import { getCalorieStatus } from "./coach.js?v=20260725n";

const RING_CIRCUMFERENCE = 2 * Math.PI * 88; // matches r="88" in the SVG
const CAPSULE_HEIGHT = 84; // matches .water-capsule's fixed height in style.css

const el = (id) => document.getElementById(id);

// Static, non-user-derived SVG markup — safe to set via innerHTML since no
// dynamic data is ever interpolated into these strings.
const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5v5.5M12 16.3v.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  default: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5.5M12 7.7v.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
};

export function showToast(message, variant = "default") {
  const toast = el("toast");
  el("toast-message").textContent = message;
  el("toast-icon").innerHTML = TOAST_ICONS[variant] || TOAST_ICONS.default;
  toast.className = "toast show" + (variant !== "default" ? ` ${variant}` : "");
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => (toast.hidden = true), 300);
  }, 2600);
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
      return acc;
    },
    { calories: 0, protein: 0, carbs: 0, fats: 0 }
  );
}

// `logs` is day_boundary-scoped (see todaysLogs() in app.js) — it drives
// everything below: ring, macro bars, status banner, and the visible log
// list. That's deliberate: pressing "End day" moves the boundary forward, so
// the whole dashboard (not just the list) reads as a genuinely fresh day
// immediately, instead of the ring/macros still showing the full calendar
// day's food until real midnight.
export function renderDashboard(targets, logs, water, highlightId) {
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

  renderStatusBanner(totals, targets);

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
      <div class="log-item-icon">${(log.food_name || "?").slice(0, 1).toUpperCase()}</div>
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
      <div class="log-item-icon">${(meal.name || "?").slice(0, 1).toUpperCase()}</div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(meal.name)}</div>
        <div class="log-item-meta">${Math.round(meal.weight_g)}g · ${pAbbr}${Math.round(meal.protein)} ${cAbbr}${Math.round(meal.carbs)} ${fAbbr}${Math.round(meal.fats)}</div>
      </div>
      <div class="log-item-cal">${Math.round(meal.calories)}</div>
      <div class="log-item-actions">
        <button class="saved-log-icon-btn" data-action="log-saved" aria-label="${t("saved.logBtn")}"><svg viewBox="0 0 24 24" fill="none"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <button data-action="delete-saved" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
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

const SHEET_IDS = ["add-sheet", "scan-sheet", "manual-sheet", "settings-sheet", "water-sheet", "end-day-sheet"];

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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
