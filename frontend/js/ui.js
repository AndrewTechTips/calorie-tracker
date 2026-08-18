import { getLocale, t } from "./i18n.js?v=20260818b";
import { getCalorieStatus } from "./coach.js?v=20260818b";

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

// Shared by any lazy-load render that app.js's initTabSwipe (the
// Dashboard<->Progress<->Discover<->Saved drag gesture) can trigger mid-drag
// (progress.js's renderProgress, discover.js's loadRecipes/renderRecommended)
// — an async fetch that resolves WHILE the user is still actively dragging a
// view around the screen must not mutate that view's DOM mid-transform: the
// view is positioned via .view-dragging (position: absolute + a live
// transform) for the whole gesture, and app.js has already pinned body's
// min-height to the height it measured at drag-start, so a re-render that
// changes the view's real content height at that exact moment is both a
// visible flicker (cards rebuilding while sliding) and a stale, now-wrong
// height pin. Lives here (not app.js) for the same reason vibrate() does —
// so the modules that actually own these renders can guard themselves
// directly instead of app.js reaching into their internals. Deferred
// callbacks flush in the order they were queued, immediately once the drag
// that's currently live settles (committed or cancelled) — see app.js's
// initTabSwipe/settleTabSwipe.
let swipeActive = false;
let deferredDuringSwipe = [];
export function setTabSwipeActive(active) {
  swipeActive = active;
  if (!active && deferredDuringSwipe.length) {
    const queued = deferredDuringSwipe;
    deferredDuringSwipe = [];
    queued.forEach((fn) => fn());
  }
}
// Read-only counterpart to setTabSwipeActive above — lets a gesture's own
// pointerdown entry point (initTabSwipe, app.js) refuse to arm a NEW drag
// while a previous one is still live (dragging OR settling; setTabSwipeActive
// isn't flipped back to false until the settle transition genuinely finishes,
// see finishSettle there). Without this gate, a fast lift-and-swipe-again
// could start a second drag while the first gesture's finishSettle is still
// pending on a transitionend/timeout — and that stale callback unconditionally
// hides every `.view` element once it does fire, including whatever the
// second, still-in-flight gesture is actively dragging. That's the exact
// "stuck mid-transition / overlapping panes / desynced active tab" glitch
// this exists to prevent.
export function isTabSwipeActive() {
  return swipeActive;
}
export function runOrDeferDuringSwipe(fn) {
  if (swipeActive) deferredDuringSwipe.push(fn);
  else fn();
}

// Global numeric-input guard rail. This app has no shared/central place that
// validates typed numbers before they're used (grammage in ingredientsList.js,
// targets in app.js, etc. each just do their own `Number(input.value) || 0`)
// — the actual bug this closes: a mistyped extra digit (e.g. "100000" into a
// weight field) both (a) sends an absurd value into the reactive macro math
// and eventual API payload, and (b) can visibly stretch a flex/grid cell
// sized to a normal 2-4 digit value. Delegated once at the document level
// (capture phase — 'blur' doesn't bubble at all, and capture also guarantees
// this clamp runs and settles input.value BEFORE any other listener attached
// closer to the input, e.g. ingredientsList.js's own reactive-math handler,
// reads it for the same event) so every input[type=number] is covered
// automatically, including ones ingredientsList.js/mealSuggester.js render
// well after this runs — no per-call-site wiring needed anywhere else.
const BLOCKED_NUMERIC_KEYS = new Set(["e", "E", "+", "-"]);

function isNumberInput(target) {
  return target instanceof HTMLInputElement && target.type === "number";
}

// Live upper-bound-only clamp while typing: never fights the user downward
// (e.g. snapping a lone leading "0" up to a min="1" field's floor mid-type),
// just refuses to let the value climb past whatever ceiling the field itself
// declares. Fields with no max attribute are left alone here — deliberately
// not defaulted to some arbitrary global ceiling, since a handful of fields
// (e.g. daily calorie targets) have real, legitimately wide ranges and this
// guard should never silently override a bound a field owner chose not to
// set.
function clampNumberInputMax(input) {
  if (input.value === "" || input.max === "") return;
  const max = Number(input.max);
  const value = Number(input.value);
  if (!Number.isNaN(value) && value > max) input.value = String(max);
}

// Full correction once the user leaves the field: same max ceiling, plus
// snaps back up to min if left below it (covers paste, autofill, and browser
// quirks the live keydown/input guards above don't reach).
function clampNumberInputFull(input) {
  if (input.value === "") return;
  let value = Number(input.value);
  if (Number.isNaN(value)) return;
  if (input.max !== "") value = Math.min(value, Number(input.max));
  if (input.min !== "") value = Math.max(value, Number(input.min));
  if (String(value) !== input.value) input.value = String(value);
}

export function initNumericInputGuards() {
  // 'e'/'E'/'+'/'-' are the only characters a native type="number" input
  // still accepts that this app never has a legitimate use for (scientific
  // notation, explicit sign) — everything else non-numeric is already
  // rejected natively by the input type itself.
  document.addEventListener(
    "keydown",
    (e) => {
      if (isNumberInput(e.target) && BLOCKED_NUMERIC_KEYS.has(e.key)) e.preventDefault();
    },
    true
  );
  document.addEventListener(
    "input",
    (e) => {
      if (isNumberInput(e.target)) clampNumberInputMax(e.target);
    },
    true
  );
  document.addEventListener(
    "blur",
    (e) => {
      if (isNumberInput(e.target)) clampNumberInputFull(e.target);
    },
    true
  );
}

// Shared by #dashboard-skeleton/#progress-skeleton's own first-real-render
// hide (app.js's render(), progress.js's renderFromCache) — a plain
// `el.hidden = true` cuts straight to `display: none`, an instant hard cut
// the instant real data is ready. On a tab that was mid-swipe when that
// data arrived (see runOrDeferDuringSwipe above), the skeleton had already
// slid fully into view before settling, so an instant cut right after is
// exactly what reads as "the page popped a beat after the slide finished."
// A brief opacity fade first — still ending in the same real `hidden = true`
// (so it's fully out of layout/the accessibility tree once done, not just
// invisible) — makes that handoff read as one continuous reveal instead of
// two separate steps, for every tab that has one of these, consistently.
export function fadeOutSkeleton(id) {
  const node = el(id);
  if (node.hidden || node.classList.contains("skeleton-hiding")) return; // already gone or already fading — never restart/double-fire
  node.classList.add("skeleton-hiding");
  setTimeout(() => {
    node.hidden = true;
    node.classList.remove("skeleton-hiding");
  }, 220);
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
// `flip` (opt-in, off by default — see renderJournal for the one caller that
// turns it on) applies the FLIP technique (First/Last/Invert/Play) to every
// row that survives this reconciliation: its on-screen position is recorded
// before the DOM is touched, and if reordering/removal above leaves it
// somewhere else afterward, it's snapped there invisibly via an inverted
// `transform` and then eased back to identity — reading as the row gliding
// to its new spot instead of the whole list snapping the instant a deleted
// row's gap closes. Skipped for brand-new rows (no prior position exists to
// glide from) — those already get their own entrance animation. `transform`
// is the only property touched, so this stays on the compositor thread
// (hardware-accelerated) instead of forcing layout on every frame the way
// animating `top`/`left` would.
export function reconcileList(listEl, items, { getId, buildHtml, extraClass, itemClass = "log-item", flip = false }) {
  const existing = new Map();
  listEl.querySelectorAll(`:scope > .${itemClass}`).forEach((li) => existing.set(li.dataset.id, li));

  const firstRects = flip ? new Map([...existing].map(([id, li]) => [id, li.getBoundingClientRect()])) : null;

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
    // Skip the innerHTML write entirely when this row's markup hasn't
    // actually changed since it was last built — comparing against the
    // browser's own re-serialized li.innerHTML is unreliable (attribute
    // order/quoting can differ from what was written even when nothing
    // meaningful changed), so the exact string this function last wrote is
    // cached on the node itself instead. Without this, deleting or
    // reordering ONE row rebuilt every other row's entire DOM subtree from
    // scratch on the very next render (reconcileList runs unconditionally
    // for the whole list, not just the changed row) — needless work, and the
    // very thing that read as "the whole list re-renders" on every deletion.
    const html = buildHtml(item);
    if (li._reconcileHtml !== html) {
      li.innerHTML = html;
      li._reconcileHtml = html;
    }

    // Keep DOM order in sync with `items`' order — insertBefore on a node
    // that's already exactly where it belongs is skipped, so an unchanged
    // list touches the DOM zero times here.
    const wantedNext = prevNode ? prevNode.nextSibling : listEl.firstChild;
    if (wantedNext !== li) listEl.insertBefore(li, wantedNext);
    prevNode = li;
  });

  existing.forEach((li) => li.remove());

  if (firstRects) {
    listEl.querySelectorAll(`:scope > .${itemClass}`).forEach((li) => {
      const first = firstRects.get(li.dataset.id);
      if (!first) return; // brand-new row — reconcileList's caller already animates its entrance
      const last = li.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return; // didn't actually move — nothing to animate
      li.style.transition = "none";
      li.style.transform = `translate(${dx}px, ${dy}px)`;
      li.offsetHeight; // force the Invert step above to commit before Play re-enables the transition below
      requestAnimationFrame(() => {
        li.style.transition = "transform 0.32s var(--ease)";
        li.style.transform = "";
        li.addEventListener("transitionend", function cleanup(e) {
          if (e.target !== li) return;
          li.style.transition = "";
          li.removeEventListener("transitionend", cleanup);
        });
      });
    });
  }
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
// renderJournal below, and progress.js's own render functions) — cheap
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

// Deliberately offsetHeight, NOT getBoundingClientRect(): this is what fixes
// the "Today's Journal collapses to nothing when a meal is added" bug.
// getBoundingClientRect() reports an item's position/size AFTER CSS
// transforms are applied, and every .journal-card plays a `journal-card-in`
// entrance animation (`transform: translateY(16px) scale(0.97)` settling to
// normal) on insert. Logging a meal inserts an optimistic temp-id card, then
// — usually within the same render burst, once the real API response lands —
// reconcileLog() in app.js swaps that temp id for the server's real id,
// which reconcileList (above) can't match against the existing <li>, so it
// throws the old node away and creates a genuinely NEW one, restarting the
// entrance animation from scratch. If updateCollapsibleList's synchronous
// measurement lands while that card (or the one after it — reconcileList's
// insertBefore reshuffles siblings too) is still mid-transform, the
// collapsed max-height gets computed from a shrunk, offset, not-yet-settled
// rect instead of the card's real resting geometry — compounding across
// every card still animating in a fast multi-item add. offsetHeight is the
// element's plain layout-box height: transform is a paint/compositing-only
// property that never touches layout, so this reads the correct, animation-
// immune size on every call regardless of what's mid-transition. Summing the
// first N items' own heights plus the real gaps between them (read from the
// list's own CSS, not a guessed constant — this function is shared by both
// .log-list's flex column, where `gap` acts as row-gap, and .milestones-list's
// CSS grid) sidesteps getBoundingClientRect() entirely, so it's also immune
// to the list's own position ever being mid-transform (e.g. mid tab-swipe).
function measureCollapsedHeight(list, items, collapsedCount) {
  const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
  let height = 0;
  for (let i = 0; i < collapsedCount; i++) {
    if (i > 0) height += gap;
    height += items[i].offsetHeight;
  }
  return Math.ceil(height);
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
  el(`bar-${key}`).style.transform = `scaleX(${pct / 100})`;
  animateNumber(`${key}-current`, current);
  el(`${key}-target`).textContent = Math.round(target);

  const row = document.querySelector(`.macro-row[data-macro="${key}"]`);
  row?.classList.toggle("over-target", over && !isBonus);
  row?.classList.toggle("bonus-target", over && isBonus);

  // `.is-visible` (visibility, not the `hidden` attribute) so this icon
  // always keeps reserving its own layout space — toggling `hidden` used to
  // remove it from the flex row entirely, which shifted .macro-figure's
  // margin-left:auto position left/right depending on which macros happened
  // to be over target that render, so the four rows' numbers never lined up
  // at a shared right edge. See the CSS comment on .macro-warning.
  const warning = el(`${key}-warning`);
  warning.classList.toggle("is-visible", over);
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

// Larger, more prominent than FOOD_ICON's small icon-in-circle above — same
// "no meaningless letter avatar" reasoning, just scaled up and centered as a
// Journal card's own photo placeholder. Reuses the exact concentric-circles
// "plate" glyph #log-empty's own empty-state icon already shows, rather than
// inventing a second one for the same "no photo" concept.
const JOURNAL_PLACEHOLDER_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/></svg>';
// A small corner badge on the placeholder — only ever shown when there's no
// photo to speak for itself — naming *how* this entry was logged. Reuses
// icons already established elsewhere in the app for the same concepts
// (sparkle = AI, from aiCoach's own insight icon; bookmark = saved meal,
// from the favorite action itself) rather than inventing new glyphs. Plain
// "manual" entries get no badge at all — the placeholder alone already says
// enough, and a third badge would be visual noise for the single most common
// case. There's no separate "barcode" badge because the backend's own log
// model has only three source values (ai/manual/saved_meal) — a barcode
// result is stored as source: "ai" like any other AI-assisted entry (see
// scan.js's confirm handler), so it already gets the sparkle here too.
const JOURNAL_BADGE_ICONS = {
  ai: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2.5l2.4 5.9 6.1.9-4.5 4.2 1.2 6-5.2-3-5.2 3 1.2-6-4.5-4.2 6.1-.9L12 2.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  saved_meal: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 4h12v16l-6-4-6 4V4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};
const JOURNAL_DELETE_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

// The meal-period heuristic behind the Journal's own filter chips (app.js)
// and each card's small period tag below — kept in one place so both always
// agree on the exact same bucketing. There's no meal-type/category column on
// the log model at all (see backend/models.py's DailyLogCreate) — a light
// time-of-day heuristic is the honest way to offer this without a schema
// change, the same zero-backend-cost tradeoff the AI Coach's own rule-based
// insights elsewhere in this app already make.
export function journalPeriodOf(log) {
  const hour = new Date(log.logged_at).getHours();
  if (hour < 11) return "breakfast";
  if (hour < 16) return "lunch";
  if (hour < 21) return "dinner";
  return "snacks";
}

// Today's Journal — dashboard.todaysLog's own #log-list, upgraded from the
// old compact single-row .log-item into a bigger, photo-forward card per
// entry. `getThumbnailUrl` is scan.js's getScanThumbnailUrl, passed in
// rather than imported directly so this module keeps pointing its
// dependencies only at api/i18n/coach — the same "orchestrator (app.js)
// passes data down" pattern highlightId already follows here.
//
// Swipe-to-delete/tap-to-edit both live in app.js (initJournalInteractions),
// not here, wired via event delegation on #log-list itself: reconcileList
// below replaces each card's innerHTML on every re-render (see its own
// comment on why), which would silently detach any listener attached
// directly to a card's own children — delegation on the stable parent is the
// only pattern that survives that.
// Small pill marking a Pre-/Post-Workout tagged entry (see backend/models.py's
// DailyLogCreate.workout_tag) — shared by Today's Journal cards and the Daily
// History day-detail list below. "regular" (the default/untagged case) never
// gets a badge at all, so an ordinary meal's row looks completely unchanged.
function workoutTagBadge(tag) {
  if (tag !== "pre_workout" && tag !== "post_workout") return "";
  const label = t(tag === "pre_workout" ? "workoutTag.preShort" : "workoutTag.postShort");
  return `<span class="workout-tag-badge workout-tag-badge-${tag}">${escapeHtml(label)}</span>`;
}

export function renderJournal(logs, highlightId, getThumbnailUrl) {
  const list = el("log-list");
  const empty = el("log-empty");

  if (!logs.length) {
    empty.hidden = false;
    list.querySelectorAll(".journal-card").forEach((n) => n.remove());
    updateJournalScrollFade(list);
    return;
  }
  empty.hidden = true;

  const pAbbr = t("dashboard.macroAbbrProtein");
  const cAbbr = t("dashboard.macroAbbrCarbs");
  const fAbbr = t("dashboard.macroAbbrFats");

  reconcileList(list, logs, {
    itemClass: "journal-card",
    flip: true,
    // _domKey (app.js's insertOptimisticLog/reconcileLog) is a stable id
    // that survives the temp-id → real-id swap on the network round trip —
    // falls back to the plain id for logs that never went through that
    // optimistic path (e.g. loaded fresh from the server on initial page
    // load), so this is fully backward compatible. See app.js's own comment
    // for why this specifically fixes the "adding a meal collapses/glitches
    // the journal" bug: without it, every reconciled log looked like a
    // brand-new item to reconcileList.
    getId: (log) => log._domKey || log.id,
    extraClass: (log) =>
      [log.id === highlightId ? "journal-card-new" : "", log._pending ? "journal-card-pending" : ""].filter(Boolean).join(" "),
    buildHtml: (log) => {
      const thumbUrl = getThumbnailUrl?.(log.id);
      const media = thumbUrl
        ? `<img class="journal-card-photo" src="${thumbUrl}" alt="" loading="lazy" />`
        : `<span class="journal-card-placeholder">${JOURNAL_PLACEHOLDER_ICON}</span>`;
      const badgeIcon = !thumbUrl && JOURNAL_BADGE_ICONS[log.source];
      const badge = badgeIcon ? `<span class="journal-card-badge" aria-hidden="true">${badgeIcon}</span>` : "";
      const time = new Date(log.logged_at).toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" });
      const pendingDot = log._pending
        ? `<span class="pending-sync-dot" role="img" aria-label="${t("sync.pendingLabel")}" title="${t("sync.pendingLabel")}"></span>`
        : "";
      return `
        <button type="button" class="journal-card-delete-bg" data-action="swipe-delete" aria-label="${t("common.delete")}">
          ${JOURNAL_DELETE_ICON}
        </button>
        <div class="journal-card-content">
          <div class="journal-card-media">${media}${badge}</div>
          <div class="journal-card-body">
            <div class="journal-card-top">
              <span class="journal-card-name">${escapeHtml(log.food_name)}${pendingDot}</span>
              <span class="journal-card-time">${escapeHtml(time)}</span>
            </div>
            <div class="journal-card-macros">
              ${workoutTagBadge(log.workout_tag)}
              <span class="journal-card-cal">${Math.round(log.calories)} kcal</span>
              <span class="journal-card-macro journal-card-macro-p">${pAbbr}${Math.round(log.protein)}</span>
              <span class="journal-card-macro journal-card-macro-c">${cAbbr}${Math.round(log.carbs)}</span>
              <span class="journal-card-macro journal-card-macro-f">${fAbbr}${Math.round(log.fats)}</span>
            </div>
          </div>
          <div class="journal-card-actions">
            <button class="favorite-icon-btn" data-action="save-favorite" aria-label="${t("saved.saveAction")}"><svg viewBox="0 0 24 24" fill="none"><path d="M6 4h12v16l-6-4-6 4V4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
            <button data-action="delete" aria-label="${t("common.delete")}">${JOURNAL_DELETE_ICON}</button>
          </div>
        </div>
      `;
    },
  });

  // Today's Journal is a fixed-height, internally-scrolling list now (see
  // .journal-scroll in style.css), not a collapse/expand toggle — a log that
  // sorts outside the currently-scrolled-to position still needs to actually
  // be visible to the user who just added/edited it. This isn't a rare edge
  // case: Today's Journal defaults to newest-first (so a fresh log usually
  // lands at index 0, already in view), but journal-sort-btn (app.js) lets
  // the user flip to oldest-first, where every new log sorts to the very
  // end — past the fold on any list long enough to scroll. `.journal-card-new`
  // (set via extraClass above whenever `log.id === highlightId`) is used
  // instead of re-deriving the row from `highlightId` directly, since a
  // freshly-reconciled card's own `data-id` is its `_domKey` (see getId
  // above), not necessarily `highlightId` itself.
  if (highlightId != null) {
    list.querySelector(".journal-card-new")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  updateJournalScrollFade(list);
}

// Toggles the bottom fade cue (see .journal-scroll.has-more-below in
// style.css) on or off based on real, live scroll geometry — present only
// while there's actual overflow content below the current scroll position,
// gone once scrolled to the very bottom (nothing left to hint at) or if the
// whole list is short enough to never scroll at all. Called after every
// render (content height can change) and, once per list via the listener
// wired below, on every scroll (position changes without content changing).
function updateJournalScrollFade(list) {
  // Deliberately NOT list.scrollHeight for the overflow check — same
  // transform-vs-layout distinction measureCollapsedHeight (above) was
  // written around. A brand-new card plays journal-card-in (opacity/
  // transform only) on insert, and this runs synchronously right after
  // reconcileList — before that animation has had a chance to progress even
  // one frame. Confirmed directly: at that instant, a still-mid-animation
  // card's scrollable overflow (which browsers compute over the painted,
  // transformed extent, not just the plain layout box) can read as taller
  // than its real resting height, which was enough to flag a short list
  // (content well under the 320px cap) as "has more below" for one render.
  // offsetHeight is the plain layout-box height — animation-immune — so
  // summing it across the real cards gives the list's true resting content
  // height regardless of what's mid-transition.
  const cards = collapsibleListItems(list);
  const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
  const contentHeight = cards.reduce((sum, li, i) => sum + li.offsetHeight + (i > 0 ? gap : 0), 0);
  const hasOverflow = contentHeight - list.clientHeight > 1;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 1;
  list.classList.toggle("has-more-below", hasOverflow && !nearBottom);

  if (!list.dataset.scrollFadeWired) {
    list.dataset.scrollFadeWired = "1";
    list.addEventListener("scroll", () => updateJournalScrollFade(list), { passive: true });
  }
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

const PDF_ARCHIVE_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M7 3.5h7l4 4V20a1 1 0 01-1 1H7a1 1 0 01-1-1V4.5a1 1 0 011-1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9.5 12.5h5M9.5 16h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const PDF_ARCHIVE_SHARE_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><circle cx="18" cy="5" r="2.3" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="12" r="2.3" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="19" r="2.3" stroke="currentColor" stroke-width="1.6"/><path d="M8.1 10.8l7.8-4.4M8.1 13.2l7.8 4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
// Download, not "open in a new tab" (a plain external-link glyph used to sit
// here) — see app.js's downloadArchivedReport for why viewing the PDF inline
// via a blob: URL doesn't work in this app: it inherits this page's own
// strict CSP, which blocks the browser's built-in PDF viewer's own inline
// styles and collapses it to an unusable sliver. A real download sidesteps
// that entirely.
const PDF_ARCHIVE_DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M12 4v11m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

// Human-readable file size for the archive list/usage hint below — no
// existing helper for this anywhere else in the app (nothing else surfaces a
// byte count to the user).
export function formatFileSize(bytes) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// PDF Archive sheet (see pdfArchiveStore.js) — one row per on-device saved
// report. Share is only rendered when the browser actually supports sharing
// a file (feature-detected here, not just in app.js's click handler) — not
// because the fallback is bad (Download always works), just so the button
// set matches what each browser can actually do. See app.js's
// shareArchivedReport for the Download fallback on browsers where
// canShare({files}) specifically (not just navigator.share) is unsupported.
export function renderPdfArchive(entries) {
  const list = el("pdf-archive-list");
  const empty = el("pdf-archive-empty");

  if (!entries.length) {
    empty.hidden = false;
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    return;
  }
  empty.hidden = true;

  const canShareFiles = typeof navigator.canShare === "function";
  const rangeLabelKey = (days) => (days === 2 ? "export.range2days" : days === 3 ? "export.range3days" : "export.rangeAll");

  reconcileList(list, entries, {
    getId: (r) => r.id,
    buildHtml: (r) => {
      const date = new Date(r.createdAt).toLocaleDateString(getLocale(), { year: "numeric", month: "short", day: "numeric" });
      const meta = `${date} · ${t(rangeLabelKey(r.days))} · ${formatFileSize(r.sizeBytes)}`;
      return `
      <div class="log-item-icon history-item-icon">${PDF_ARCHIVE_ICON}</div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(r.filename)}</div>
        <div class="log-item-meta">${escapeHtml(meta)}</div>
      </div>
      <div class="log-item-actions">
        ${canShareFiles ? `<button data-action="share-report" aria-label="${t("pdfArchive.share")}">${PDF_ARCHIVE_SHARE_ICON}</button>` : ""}
        <button data-action="download-report" aria-label="${t("pdfArchive.download")}">${PDF_ARCHIVE_DOWNLOAD_ICON}</button>
        <button data-action="delete-report" aria-label="${t("common.delete")}">${JOURNAL_DELETE_ICON}</button>
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

// The Daily History "edit a past day" sheet's entry list — the plain
// .log-item row anatomy (icon / name+macros / calorie figure), not Today's
// Journal's bigger photo card (renderJournal above) — edit/delete only, no
// favorite-bookmark action (out of scope for backdating a forgotten entry —
// see app.js's day-detail-sheet handler).
// `highlightId` (optional): same purpose as renderJournal's own param below
// — the id of whichever log a caller wants to call out as "just added".
export function renderDayDetailList(logs, highlightId) {
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
    // _domKey (app.js's insertOptimisticLog/reconcileLog) is a stable id
    // that survives the temp-id → real-id swap on the network round trip —
    // same fix renderJournal above already needed for the exact same
    // symptom ("adding a meal collapses/glitches the list"). Without it,
    // backdating a meal from this sheet (Daily History → day-detail → +Add
    // / +From Saved) looked fine on the optimistic insert, then a moment
    // later — once the real server id arrived — reconcileList couldn't
    // match the reconciled log back to the node it just animated in, so it
    // deleted that node and created a brand-new one in its place, replaying
    // the entrance animation a second time right after the first (the
    // "double animation" this was built to fix). Falls back to the plain id
    // for logs that never went through that optimistic path (e.g. this
    // day's list as first loaded from the server).
    getId: (log) => log._domKey || log.id,
    // `.log-item-new` (style.css) is the plain-.log-item counterpart of
    // renderJournal's `.journal-card-new` above — same one-shot "just
    // added" highlight pulse, sized for this sheet's compact row instead of
    // the bigger journal card.
    extraClass: (log) => (log.id === highlightId ? "log-item-new" : ""),
    buildHtml: (log) => `
      <div class="log-item-icon">${FOOD_ICON}</div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(log.food_name)}</div>
        <div class="log-item-meta">${workoutTagBadge(log.workout_tag)}${Math.round(log.weight_g)}g · ${pAbbr}${Math.round(log.protein)} ${cAbbr}${Math.round(log.carbs)} ${fAbbr}${Math.round(log.fats)}</div>
      </div>
      <div class="log-item-cal">${Math.round(log.calories)}</div>
      <div class="log-item-actions">
        <button data-action="edit" aria-label="${t("common.edit")}"><svg viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <button data-action="delete" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `,
  });
}

// The Daily History day-detail sheet's own totals bar (#day-detail-cal and
// its three siblings) — a backdated add/edit/delete used to leave this sheet
// showing only a bare item list with no running total anywhere, so there was
// no way to tell "did my numbers actually move" without closing the sheet
// and finding this day's row back in Daily History. Reuses computeDailyTotals
// (same helper renderDashboard uses for today) and the same animateNumber
// ticker every other stat in the app settles with, instead of a flat instant
// overwrite.
export function renderDayDetailTotals(logs) {
  const totals = computeDailyTotals(logs);
  animateNumber("day-detail-cal", totals.calories);
  animateNumber("day-detail-protein", totals.protein, (n) => `${Math.round(n)}g`);
  animateNumber("day-detail-carbs", totals.carbs, (n) => `${Math.round(n)}g`);
  animateNumber("day-detail-fats", totals.fats, (n) => `${Math.round(n)}g`);
}

// The Daily History "From Saved" picker (#day-detail-saved-sheet) — same
// .log-item anatomy as renderDayDetailList/renderSavedMeals above, but no
// per-row action buttons: the whole row is the tap target (see
// .day-detail-saved-item:active in style.css), since there's exactly one
// thing a row here can do — log itself into the date named by the sheet's
// own date-context-pill (app.js owns that click handling; this only builds
// the list markup, same division as every other render* function here).
export function renderDaySavedPickerList(meals) {
  const list = el("day-detail-saved-list");
  const empty = el("day-detail-saved-empty");

  if (!meals.length) {
    empty.hidden = false;
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    return;
  }
  empty.hidden = true;

  const pAbbr = t("dashboard.macroAbbrProtein");
  const cAbbr = t("dashboard.macroAbbrCarbs");
  const fAbbr = t("dashboard.macroAbbrFats");

  reconcileList(list, meals, {
    getId: (meal) => meal.id,
    extraClass: () => "day-detail-saved-item",
    buildHtml: (meal) => {
      const servings = meal.servings > 0 ? meal.servings : 1;
      const servingsCaption =
        servings > 1
          ? `<div class="log-item-meta log-item-servings">${escapeHtml(
              t("saved.servingsCaption", { servings, perServing: Math.round(meal.calories / servings) }),
            )}</div>`
          : "";
      return `
      <div class="log-item-icon">${FOOD_ICON}</div>
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(meal.name)}</div>
        <div class="log-item-meta">${Math.round(meal.weight_g)}g · ${pAbbr}${Math.round(meal.protein)} ${cAbbr}${Math.round(meal.carbs)} ${fAbbr}${Math.round(meal.fats)}</div>
        ${servingsCaption}
      </div>
      <div class="log-item-cal">${Math.round(meal.calories)}</div>
    `;
    },
  });
}

// Plays the "removing" exit transition on a list item before it's actually
// deleted from the server, instead of it just vanishing when the list
// re-renders — resolves once the animation has had time to play out.
// `className` defaults to "removing" (the compact .log-item lists — saved
// meals, day detail, water, ...); Today's Journal passes "exiting" for its
// own taller .journal-card exit treatment (see .journal-card.exiting in
// style.css) since it needs a distinct animation, not because the mechanism
// itself differs. Resolves on the row's own `transitionend` — not a fixed
// delay — so the caller's next step (removing the DOM node / syncing state)
// starts the instant the animation actually finishes, never before it visibly
// completes and never waiting longer than it needs to; `timeoutMs` is a
// safety net only (prefers-reduced-motion, or any other reason a transition
// might not fire), never the normal path. Resolves with the animated node
// itself (or null if it was already gone) so a caller doing its own surgical
// `node.remove()` afterward — see deleteJournalEntry in app.js — doesn't need
// a second DOM query to re-find it.
export function animateItemRemoval(listId, itemId, { className = "removing", timeoutMs = 260, transitionProperty = null, snapHeight = false } = {}) {
  const list = el(listId);
  // Matches on data-id alone, not a specific item class — reused by every
  // list this way (saved meals, day detail, Today's Journal, ...).
  const item = [...list.children].find((node) => node.dataset.id === itemId);
  if (!item) return Promise.resolve(null);
  // Clears any inline transform/transition reconcileList's FLIP step (above)
  // may have left on this exact node from a still-in-flight glide triggered
  // by an earlier, different deletion — those are set as inline styles
  // (higher specificity than any class), so left in place they'd silently
  // override this class's own `transform` (e.g. .journal-card.exiting's
  // scale-down) instead of letting it apply.
  item.style.transform = "";
  item.style.transition = "";
  // `snapHeight` (Today's Journal — see .journal-card.exiting in style.css):
  // that class's own `max-height` starts from a generous fixed 240px (needed
  // so max-height has a real number to transition FROM at all — see that
  // class's own comment), but a normal one-line card only renders ~84px
  // tall. Letting the CSS transition animate 240px → 0 unmodified meant the
  // first chunk of the transition (240 down to the card's real height) had
  // no visible effect at all — the box is still sized by its actual content,
  // not the still-oversized max-height cap — so opacity/scale visibly
  // finished fading while the layout hadn't moved yet, then the row's real
  // height collapse (and the resulting slide-up of every card below it)
  // happened abruptly in whatever time was left. That's the reported
  // "stutter"/"staircase" double-motion. Snapping max-height to the card's
  // own measured height right before the transition starts — then forcing a
  // layout flush so the browser treats that as the real starting value, not
  // the class's oversized one — makes the height collapse begin on frame
  // one, in step with the fade, instead of lagging behind it.
  if (snapHeight) {
    item.style.maxHeight = `${item.offsetHeight}px`;
    item.offsetHeight; // eslint-disable-line no-unused-expressions -- force the layout flush above to commit before the class below changes the target value
  }
  item.classList.add(className);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      item.removeEventListener("transitionend", onTransitionEnd);
      clearTimeout(fallback);
      resolve(item);
    };
    // A row can be transitioning several properties at once (opacity,
    // transform, max-height, ...), each dispatching its own transitionend —
    // `transitionProperty`, when given, waits specifically for the named one
    // instead of resolving on whichever fires first. Today's Journal passes
    // "max-height" (see .journal-card.exiting in style.css): that's the
    // property that actually governs when the row's layout box — and so the
    // gap it leaves for siblings to close into — has genuinely finished
    // collapsing, not just when it became invisible. Every property on that
    // class now shares identical duration/easing/delay, so in practice they
    // all fire in the same frame regardless — this just removes any
    // ambiguity about which one JS is synced to. Left unset (default) for
    // callers that don't need that precision (the compact .log-item lists),
    // which just resolve on the row's own first transitionend, from any
    // property, same as before.
    const onTransitionEnd = (e) => {
      if (e.target !== item) return;
      if (transitionProperty && e.propertyName !== transitionProperty) return;
      finish();
    };
    item.addEventListener("transitionend", onTransitionEnd);
    const fallback = setTimeout(finish, timeoutMs);
  });
}

// Every .sheet-overlay in index.html that carries a .sheet-handle — kept in
// sync with the DOM by hand (there's no build step to derive this list
// automatically). This is the single list that drives BOTH the no-scroll
// bookkeeping in closeSheet() AND universal swipe-to-dismiss in
// initSheetDragToDismiss() below, so a sheet left off here silently loses
// both: it stays draggable-less (no drag-down-to-close) and, if it's the
// last one open, can leave #app stuck in its no-scroll lock.
const SHEET_IDS = [
  "add-sheet",
  "scan-sheet",
  "manual-sheet",
  "meal-suggester-sheet",
  "fasting-sheet",
  "settings-sheet",
  "water-sheet",
  "ai-coach-sheet",
  "measurement-sheet",
  "end-day-sheet",
  "day-detail-sheet",
  "save-favorite-choice-sheet",
  "calculator-sheet",
  "recipe-sheet",
  "recipe-detail-sheet",
  "workout-plan-detail-sheet",
  "exercise-detail-sheet",
  "milestone-detail-sheet",
  "reset-progress-sheet",
  "delete-account-sheet",
  "legal-sheet",
];

// Scroll lock on #app (the app's own scroll container — see its CSS comment)
// backing openSheet()/closeSheet() below. Guarded against double-lock/
// double-unlock (not a bare classList toggle) specifically for sheet
// stacking (day-detail-sheet → edit → manual-sheet, or the calculator
// opening on top of Settings): a second openSheet() while one is already
// open must be a no-op, same as before. Unlike the old body-level version of
// this lock, no scroll-offset save/restore is needed — toggling `overflow`
// on a plain nested scroller (unlike the document root) freezes/resumes it
// at whatever scrollTop it already had, so #app simply stays put on its own.
export function lockAppScroll() {
  el("app").classList.add("no-scroll");
}
export function unlockAppScroll() {
  el("app").classList.remove("no-scroll");
}

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
  // Guarded, not a bare unconditional call: appendChild on a node that's
  // ALREADY the last child is a genuine no-op (browsers special-case it),
  // but most sheets — settings-sheet included, which has six more sheets
  // after it in index.html's own markup order — are NOT already last, so an
  // unconditional call silently detaches and reinserts the node on every
  // single open. That's a real synchronous DOM mutation landing in the same
  // task as unhiding the overlay, right as its CSS entrance animation needs
  // to compute its first frame — exactly the kind of avoidable work the
  // "occasional stutter right at the start" symptom pointed at. Still safe
  // to move when actually needed: this never recreates the node, so event
  // listeners already attached to it (including initSheetDragToDismiss's)
  // stay attached either way.
  if (document.body.lastElementChild !== overlay) document.body.appendChild(overlay);
  lockAppScroll();
}
export function closeSheet(id) {
  el(id).hidden = true;
  if (SHEET_IDS.every((sid) => el(sid).hidden)) {
    unlockAppScroll();
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
// alone; this only follows the finger with an indicator while #app (the
// app's scroll container) is already at scrollTop 0 and the user is
// dragging down, then calls onRefresh() if released past the commit
// distance. Gated to view-dashboard specifically (via viewId) since that's
// the one screen with data worth manually refreshing outside the normal
// optimistic-update flow.
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
    if (refreshing || view.hidden || el("app").scrollTop > 0) return;
    startY = e.clientY;
    pulling = true;
  });

  view.addEventListener("pointermove", (e) => {
    if (!pulling || refreshing) return;
    const deltaY = e.clientY - startY;
    if (deltaY <= 0 || el("app").scrollTop > 0) {
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
  unlockAppScroll();
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
