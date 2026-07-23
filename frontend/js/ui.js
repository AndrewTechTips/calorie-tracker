import { getLocale, t } from "./i18n.js?v=20260723h";
import { getCalorieStatus } from "./coach.js?v=20260723h";

const RING_CIRCUMFERENCE = 2 * Math.PI * 88; // matches r="88" in the SVG

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

export function setGreeting() {
  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour < 12 ? t("header.greetingMorning") : hour < 18 ? t("header.greetingAfternoon") : t("header.greetingEvening");
  el("greeting-date").textContent = now.toLocaleDateString(getLocale(), {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  document.querySelector(".greeting").textContent = greeting;
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

export function renderDashboard(targets, todaysLogs, water, highlightId) {
  const totals = computeDailyTotals(todaysLogs);

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
  animateNumber("water-current", water.total_ml);
  el("water-target").textContent = water.target_ml.toLocaleString();
  renderWaterEntries(water.entries || []);

  renderLogList(todaysLogs, highlightId);
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

export function renderWaterEntries(entries) {
  const list = el("water-entries-list");
  const empty = el("water-entries-empty");
  list.querySelectorAll(".log-item").forEach((n) => n.remove());

  if (!entries.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  entries.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "log-item";
    li.dataset.id = entry.id;
    const time = new Date(entry.logged_at).toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" });
    li.innerHTML = `
      <div class="log-item-icon water-item-icon">${WATER_DROP_ICON}</div>
      <div class="log-item-body">
        <div class="log-item-name">${Math.round(entry.amount_ml).toLocaleString()} ml</div>
        <div class="log-item-meta">${time}</div>
      </div>
      <div class="log-item-actions">
        <button data-action="delete-water" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `;
    list.appendChild(li);
  });
}

function setMacroBar(key, current, target) {
  const pct = Math.min((current / (target || 1)) * 100, 100);
  el(`bar-${key}`).style.width = `${pct}%`;
  animateNumber(`${key}-current`, current);
  el(`${key}-target`).textContent = Math.round(target);
}

export function renderLogList(logs, highlightId) {
  const list = el("log-list");
  const empty = el("log-empty");
  list.querySelectorAll(".log-item").forEach((n) => n.remove());

  if (!logs.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  logs.forEach((log) => {
    const li = document.createElement("li");
    li.className = "log-item" + (log.id === highlightId ? " log-item-new" : "");
    li.dataset.id = log.id;
    const pAbbr = t("dashboard.macroAbbrProtein");
    const cAbbr = t("dashboard.macroAbbrCarbs");
    const fAbbr = t("dashboard.macroAbbrFats");
    li.innerHTML = `
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
    `;
    list.appendChild(li);
  });
}

export function renderSavedMeals(meals) {
  const list = el("saved-meals-list");
  const empty = el("saved-empty");
  list.querySelectorAll(".log-item").forEach((n) => n.remove());

  if (!meals.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  meals.forEach((meal) => {
    const li = document.createElement("li");
    li.className = "log-item";
    li.dataset.id = meal.id;
    li.innerHTML = `
      <div class="log-item-icon">${(meal.name || "?").slice(0, 1).toUpperCase()}</div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(meal.name)}</div>
        <div class="log-item-meta">${Math.round(meal.weight_g)}g · ${Math.round(meal.calories)} kcal</div>
      </div>
      <button class="saved-log-btn" data-action="log-saved">${t("saved.logBtn")}</button>
      <div class="log-item-actions">
        <button data-action="delete-saved" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `;
    list.appendChild(li);
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
  el(id).hidden = false;
  document.body.classList.add("no-scroll");
}
export function closeSheet(id) {
  el(id).hidden = true;
  if (SHEET_IDS.every((sid) => el(sid).hidden)) {
    document.body.classList.remove("no-scroll");
  }
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
