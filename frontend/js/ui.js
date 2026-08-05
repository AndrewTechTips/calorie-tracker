import { getLocale, t } from "./i18n.js?v=20260805n";
import { getCalorieStatus } from "./coach.js?v=20260805n";

const RING_CIRCUMFERENCE = 2 * Math.PI * 88; // matches r="88" in the SVG
const CAPSULE_HEIGHT = 112; // matches .water-capsule's fixed height in style.css

const el = (id) => document.getElementById(id);

// A short, silent-if-unsupported haptic tick on the interactions that matter
// most on a phone (this ships as a mobile app first) — cheap, native-feeling
// confirmation that costs nothing when the API isn't there (desktop/Safari).
// Lives here (not app.js) so progress.js can use it too, e.g. for the
// milestone-just-earned moment, without duplicating this one-liner.
export function vibrate(ms) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported — ignore */
  }
}

// Static, non-user-derived SVG markup — safe to set via innerHTML since no
// dynamic data is ever interpolated into these strings.
const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5v5.5M12 16.3v.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  default: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5.5M12 7.7v.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
};

// Macros where going past the daily number is a good outcome, not something
// to flag — right now just fiber (more fiber than the target is still
// healthy; there's no "too much" ceiling the way there is for calories).
// setMacroBar() below swaps the shared warning-icon slot to this checkmark
// and skips the danger styling entirely for any macro in this set.
const BONUS_OVERAGE_MACROS = new Set(["fiber"]);
const BONUS_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

// Which foods drove today's total for one specific macro — the tap-to-expand
// detail under a dashboard macro row (app.js). Ranked by that macro's own
// grams, not calories (contrast with progress.js's computeTopFoods, which
// ranks by calorie contribution across all macros for the Progress tab's
// "What's driving your calories" list) — a different question ("what gave me
// my protein today") deserves its own ranking, not a reuse of the calorie one.
export function computeMacroContributions(logs, macroKey) {
  const totals = new Map();
  let grandTotal = 0;
  logs.forEach((log) => {
    const value = log[macroKey] || 0;
    grandTotal += value;
    totals.set(log.food_name, (totals.get(log.food_name) || 0) + value);
  });
  return [...totals.entries()]
    .map(([name, value]) => ({ name, value, pct: grandTotal > 0 ? (value / grandTotal) * 100 : 0 }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);
}

// ---------------------------------------------------------------------------
// Ring pace marker — see its call site in renderDashboard below for the full
// "why waking hours, not midnight-to-midnight" reasoning. Fixed constants
// rather than a per-user setting: the ask was a way to turn the marker off
// entirely (see RING_PACE_KEY below), not to fine-tune exactly when each
// individual user wakes/sleeps — these two numbers cover the large majority
// of real schedules well enough for an at-a-glance pace check.
// ---------------------------------------------------------------------------
const PACE_WAKE_HOUR = 7;
const PACE_SLEEP_HOUR = 23;
const RING_PACE_KEY = "ironlog_ring_pace_enabled";

export function isRingPaceEnabled() {
  return localStorage.getItem(RING_PACE_KEY) !== "0"; // on by default
}

export function setRingPaceEnabled(enabled) {
  localStorage.setItem(RING_PACE_KEY, enabled ? "1" : "0");
  renderPaceMarker();
}

// Split out from renderDashboard (which still calls this on every render) so
// the Settings toggle can also re-run just this piece instantly on change,
// without needing a full dashboard re-render.
export function renderPaceMarker() {
  const paceMarker = el("ring-pace-marker");
  // Plain `.hidden = true/false` (the IDL property) is what every other
  // toggle in this app relies on, but it doesn't reliably reflect to the
  // actual `hidden` content attribute on an SVG element the way it does on
  // a normal HTML element in every browser — the reflection is defined on
  // HTMLElement, and support for it on SVGElement is inconsistent. Since the
  // global `[hidden] { display: none !important; }` rule (see near the top
  // of style.css) matches the ATTRIBUTE, not the property, that mismatch
  // left this specific marker visibly stuck on-screen even though `.hidden`
  // itself correctly read back `true` — driving the attribute explicitly
  // sidesteps the inconsistency entirely.
  if (!isRingPaceEnabled()) {
    paceMarker.setAttribute("hidden", "");
    return;
  }
  paceMarker.removeAttribute("hidden");

  const now = new Date();
  const nowHour = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  const paceFraction = (nowHour - PACE_WAKE_HOUR) / (PACE_SLEEP_HOUR - PACE_WAKE_HOUR);
  const paceAngle = Math.min(Math.max(paceFraction, 0), 1) * 2 * Math.PI;
  const PACE_INNER_R = 75;
  const PACE_OUTER_R = 99;
  paceMarker.setAttribute("x1", (100 + PACE_INNER_R * Math.cos(paceAngle)).toFixed(2));
  paceMarker.setAttribute("y1", (100 + PACE_INNER_R * Math.sin(paceAngle)).toFixed(2));
  paceMarker.setAttribute("x2", (100 + PACE_OUTER_R * Math.cos(paceAngle)).toFixed(2));
  paceMarker.setAttribute("y2", (100 + PACE_OUTER_R * Math.sin(paceAngle)).toFixed(2));
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

  // Pace marker: a tick at "expected consumption by this point in your day"
  // if calories were spread evenly across your WAKING hours — lets the ring
  // answer "am I ahead or behind pace" at a glance, not just "how much so
  // far." Anchored to a waking-hours window rather than the full midnight-
  // to-midnight clock: spreading the day's target evenly across all 24 hours
  // put the marker meaningfully "behind" the moment you wake up (you're
  // asleep for a third of the denominator), which read as an odd, faintly
  // accusatory start to the day rather than a useful pace check. Before
  // PACE_WAKE_HOUR the marker sits at the very start (you haven't started
  // your eating day yet — no pace to be behind on); after PACE_SLEEP_HOUR it
  // sits at the very end (the day's over, judge the whole thing, not "pace").
  // The marker is a child of the same rotated <svg> as the ring itself (see
  // .ring's transform: rotate(-90deg) in style.css), so plain unrotated
  // circle math here still lands at the correct clock position.
  renderPaceMarker();

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
    setStatusBannerTone(el("status-banner"), el("status-banner-icon"), el("status-banner-text"), "info", "info", t("day.endedBanner"));
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

// One icon per *kind* of thing coach.js is actually saying, not just one
// generic circle-i for every tone — a goal genuinely hit reads as a trophy,
// an early-day on-pace nudge as a flame, a perfectly balanced day as a leaf,
// routine logging as a plate, and an over-target caution as an alert
// triangle. Same safe static-SVG-map pattern as TOAST_ICONS above.
export const STATUS_ICONS = {
  info: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 8v5M12 15.9v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  trophy:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M8 4h8v4a4 4 0 01-8 0V4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 5H5a3 3 0 003 3M16 5h3a3 3 0 01-3 3M10 14v3M14 14v3M8 20h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  flame:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3s-5 5.5-5 9.5a5 5 0 0010 0c0-1.5-.7-2.8-1.5-3.8.2 1-.2 2-1 2.3C15 9 14 6.5 12 3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  leaf: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 19c8 0 14-6 14-14-8 0-14 6-14 14z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M5 19c3-3 6-6 9-11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  plate: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5L22 20H2L12 3.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 9.5v4.2M12 16.7v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

export function setStatusBannerTone(bannerEl, iconEl, textEl, tone, icon, text) {
  bannerEl.dataset.tone = tone;
  bannerEl.classList.remove(...STATUS_TONES.map((toneName) => `tone-${toneName}`));
  bannerEl.classList.add(`tone-${tone}`);
  iconEl.innerHTML = STATUS_ICONS[icon] || STATUS_ICONS.info;
  textEl.textContent = text;
}

function renderStatusBanner(totals, targets) {
  const { tone, icon, text } = getCalorieStatus(totals, targets);
  setStatusBannerTone(el("status-banner"), el("status-banner-icon"), el("status-banner-text"), tone, icon, text);
}

const WATER_DROP_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3s7 7.5 7 12a7 7 0 11-14 0c0-4.5 7-12 7-12z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

// Replaces the old "first letter of the food name in a circle" avatar (S/M/R/
// whatever the name happened to start with) — a random letter carries no
// meaning and reads as an unfinished placeholder, not a real icon. A single
// consistent fork-and-knife glyph reads as "this is a food entry" at a glance
// regardless of what the item is named, matching the water drop's icon used
// for water entries in the same list.
const FOOD_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M3 2v7a2 2 0 002 2h4a2 2 0 002-2V2M7 2v20M21 15V2a5 5 0 00-5 5v6a2 2 0 002 2h3zm0 0v7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

// ---------------------------------------------------------------------------
// Collapsible lists — today's log and the Progress tab's weight/measurement/
// workout history all default to showing only the first few entries, with a
// toggle below to reveal the rest, instead of every list running to full
// length on screen by default. Pure max-height (not display:none on the
// extra items) so the collapse/expand itself animates smoothly rather than
// snapping. Measured off real rendered item heights rather than one guessed
// pixel constant, since different lists use different row heights.
//
// Called at the end of whichever render function owns each list (see
// renderLogList below, and progress.js's own render functions) — cheap
// (just DOM measurement, no re-render of its own) and idempotent, so calling
// it after every data refresh is the simplest way to keep the toggle's
// visibility/label in sync with the current item count without a separate
// "did the count change" check.
// ---------------------------------------------------------------------------
const DEFAULT_COLLAPSED_COUNT = 3;
// Per-list override — everything else collapses to 3 (roughly "a glance's
// worth" for a single-column list), but Milestones is a multi-column grid
// (2/3/4 columns depending on viewport — see .milestones-list in style.css),
// where 3 raw items can be less than one full row. 6 reads as "about two
// rows" across that whole range instead of cutting off mid-row.
const COLLAPSED_COUNT_OVERRIDES = { "milestones-list": 6 };
const collapsedCountFor = (listId) => COLLAPSED_COUNT_OVERRIDES[listId] || DEFAULT_COLLAPSED_COUNT;

function collapsibleListItems(list) {
  return Array.from(list.children).filter((n) => n.tagName === "LI" && !n.classList.contains("empty-state"));
}

function measureCollapsedHeight(list, items, collapsedCount) {
  const last = items[collapsedCount - 1];
  return Math.ceil(last.getBoundingClientRect().bottom - list.getBoundingClientRect().top);
}

export function updateCollapsibleList(listId, toggleId) {
  const list = el(listId);
  const toggle = el(toggleId);
  const items = collapsibleListItems(list);
  const collapsedCount = collapsedCountFor(listId);

  if (items.length <= collapsedCount) {
    toggle.hidden = true;
    list.classList.remove("collapsible", "expanded");
    list.style.maxHeight = "";
    return;
  }

  toggle.hidden = false;
  list.classList.add("collapsible");
  const expanded = list.classList.contains("expanded");
  list.style.maxHeight = expanded ? `${list.scrollHeight}px` : `${measureCollapsedHeight(list, items, collapsedCount)}px`;
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.querySelector(".list-collapse-toggle-label").textContent = expanded
    ? t("common.showLess")
    : t("common.showMoreCount", { count: items.length - collapsedCount });
}

// Wired once per toggle button (see initCollapsibleListToggles below) rather
// than re-wired on every render — the button element itself is static
// markup, only the list contents it controls are re-rendered.
export function initCollapsibleListToggles(pairs) {
  pairs.forEach(([listId, toggleId]) => {
    el(toggleId).addEventListener("click", () => {
      const list = el(listId);
      list.classList.toggle("expanded");
      updateCollapsibleList(listId, toggleId);
      if (!list.classList.contains("expanded")) list.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });
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
    extraClass: (entry) => (entry._pending ? "log-item-pending" : ""),
    buildHtml: (entry) => {
      const time = new Date(entry.logged_at).toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" });
      return `
      <div class="log-item-icon water-item-icon">${WATER_DROP_ICON}</div>
      <div class="log-item-body">
        <div class="log-item-name">${Math.round(entry.amount_ml).toLocaleString()} ml${entry._pending ? `<span class="pending-sync-dot" role="img" aria-label="${t("sync.pendingLabel")}" title="${t("sync.pendingLabel")}"></span>` : ""}</div>
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
  const isBonus = BONUS_OVERAGE_MACROS.has(key);
  el(`bar-${key}`).style.width = `${pct}%`;
  animateNumber(`${key}-current`, current);
  el(`${key}-target`).textContent = Math.round(target);

  const row = document.querySelector(`.macro-row[data-macro="${key}"]`);
  row?.classList.toggle("over-target", over && !isBonus);
  row?.classList.toggle("bonus-target", over && isBonus);

  const warning = el(`${key}-warning`);
  warning.hidden = !over;
  warning.classList.toggle("macro-warning-bonus", isBonus);
  if (over) {
    if (isBonus) {
      warning.innerHTML = BONUS_ICON;
      warning.setAttribute("aria-label", t("dashboard.fiberBonusLabel", { amount: Math.round(current - target) }));
    } else {
      warning.setAttribute("aria-label", t("dashboard.overByLabel", { amount: Math.round(current - target) }));
    }
  }
}

export function renderLogList(logs, highlightId) {
  const list = el("log-list");
  const empty = el("log-empty");

  if (!logs.length) {
    empty.hidden = false;
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    updateCollapsibleList("log-list", "log-list-toggle");
    return;
  }
  empty.hidden = true;

  const pAbbr = t("dashboard.macroAbbrProtein");
  const cAbbr = t("dashboard.macroAbbrCarbs");
  const fAbbr = t("dashboard.macroAbbrFats");

  reconcileList(list, logs, {
    getId: (log) => log.id,
    extraClass: (log) => [log.id === highlightId ? "log-item-new" : "", log._pending ? "log-item-pending" : ""]
      .filter(Boolean)
      .join(" "),
    buildHtml: (log) => `
      <div class="log-item-icon">${FOOD_ICON}</div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(log.food_name)}${log._pending ? `<span class="pending-sync-dot" role="img" aria-label="${t("sync.pendingLabel")}" title="${t("sync.pendingLabel")}"></span>` : ""}</div>
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
  updateCollapsibleList("log-list", "log-list-toggle");
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
    buildHtml: (meal) => {
      const servings = meal.servings > 0 ? meal.servings : 1;
      // Multi-serving recipes get an extra caption (the whole-batch numbers
      // above already read like a single portion otherwise) and the log
      // action's label makes clear it logs one serving, not the whole batch
      // — see app.js's log-saved handler for the actual scaling logic.
      const servingsCaption =
        servings > 1
          ? `<div class="log-item-meta log-item-servings">${escapeHtml(
              t("saved.servingsCaption", { servings, perServing: Math.round(meal.calories / servings) }),
            )}</div>`
          : "";
      const logLabel = servings > 1 ? t("saved.logsOneServing") : t("saved.logBtn");
      return `
      <div class="log-item-icon">${FOOD_ICON}</div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(meal.name)}</div>
        <div class="log-item-meta">${Math.round(meal.weight_g)}g · ${pAbbr}${Math.round(meal.protein)} ${cAbbr}${Math.round(meal.carbs)} ${fAbbr}${Math.round(meal.fats)}</div>
        ${servingsCaption}
      </div>
      <div class="log-item-cal">${Math.round(meal.calories)}</div>
      <div class="log-item-actions">
        <button class="saved-log-icon-btn" data-action="log-saved" aria-label="${logLabel}"><svg viewBox="0 0 24 24" fill="none"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <button data-action="edit-saved" aria-label="${t("common.edit")}"><svg viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <button data-action="delete-saved" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `;
    },
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
      <div class="log-item-icon">${FOOD_ICON}</div>
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

// Pull-to-refresh on the dashboard — purely visual (never calls
// preventDefault), so native scrolling/overscroll is always left completely
// alone; this only follows the finger with an indicator while the page is
// already at scrollY 0 and the user is dragging down, then calls onRefresh()
// if released past the commit distance. Gated to view-dashboard specifically
// (via viewId) since that's the one screen with data worth manually
// refreshing outside the normal optimistic-update flow.
const PULL_COMMIT_PX = 70;
const PULL_MAX_PX = 90;
const PULL_DAMPING = 0.5;

export function initPullToRefresh(viewId, onRefresh) {
  const view = el(viewId);
  const indicator = el("pull-refresh-indicator");
  const spinner = indicator.querySelector(".pull-refresh-spinner");
  let startY = 0;
  let pulling = false;
  let refreshing = false;

  function reset() {
    pulling = false;
    indicator.style.transform = "";
    spinner.style.opacity = "0";
    spinner.style.transform = "";
    spinner.classList.remove("spinning");
  }

  view.addEventListener("pointerdown", (e) => {
    if (refreshing || view.hidden || window.scrollY > 0) return;
    startY = e.clientY;
    pulling = true;
  });

  view.addEventListener("pointermove", (e) => {
    if (!pulling || refreshing) return;
    const deltaY = e.clientY - startY;
    if (deltaY <= 0 || window.scrollY > 0) {
      reset();
      return;
    }
    const damped = Math.min(deltaY * PULL_DAMPING, PULL_MAX_PX);
    const commitFraction = Math.min(damped / PULL_COMMIT_PX, 1);
    indicator.style.transform = `translateY(${damped}px)`;
    spinner.style.opacity = String(commitFraction);
    spinner.style.transform = `scale(${0.6 + 0.4 * commitFraction}) rotate(${damped * 3}deg)`;
  });

  const finish = async (e) => {
    if (!pulling || refreshing) return;
    const deltaY = (e.clientY ?? startY) - startY;
    const damped = Math.min(Math.max(deltaY, 0) * PULL_DAMPING, PULL_MAX_PX);
    pulling = false;
    if (damped < PULL_COMMIT_PX * 0.9) {
      reset();
      return;
    }
    refreshing = true;
    spinner.classList.add("spinning");
    indicator.style.transform = `translateY(${PULL_COMMIT_PX}px)`;
    spinner.style.opacity = "1";
    try {
      await onRefresh();
    } finally {
      refreshing = false;
      reset();
    }
  };

  view.addEventListener("pointerup", finish);
  view.addEventListener("pointercancel", reset);
}

// Called on sign-out (and defensively on sign-in) so a sheet left open in one
// session can never render on top of the auth screen or a different user's data.
export function closeAllSheets() {
  SHEET_IDS.forEach((id) => (el(id).hidden = true));
  document.body.classList.remove("no-scroll");
}

// Click-to-select behavior for a segmented-choice container — the plain
// .pill-tabs style (Saved view's Meals/Products tabs, the favorite-type
// toggles in the manual/scan forms) and the animated .pref-toggle-buttons
// style (Language/Theme/Goal in Settings) both qualify: both mark their
// options with [data-type], so this reads that attribute rather than either
// component's own class name, and works identically for whichever one a
// given container uses. Purely visual/selection state; callers read the
// active value back via getActivePillType() when they actually need it
// (e.g. at submit).
export function wirePillTabs(containerId, onChange) {
  el(containerId).addEventListener("click", (e) => {
    const btn = e.target.closest("[data-type]");
    if (!btn) return;
    el(containerId)
      .querySelectorAll("[data-type]")
      .forEach((b) => b.classList.toggle("active", b === btn));
    onChange?.(btn.dataset.type);
  });
}

export function getActivePillType(containerId, fallback = "meal") {
  return el(containerId).querySelector("[data-type].active")?.dataset.type || fallback;
}

export function resetPillTabs(containerId, defaultType = "meal") {
  el(containerId)
    .querySelectorAll("[data-type]")
    .forEach((b) => b.classList.toggle("active", b.dataset.type === defaultType));
}

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
