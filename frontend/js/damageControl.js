// "Damage Control" — a calm "note about today" card (markup in index.html,
// deliberately NOT a .sheet-overlay: no backdrop, doesn't block the app,
// dismissible without losing where the user was) that slides up right after
// app.js logs a food entry that pushes today's calories well past target.
//
// 100% deterministic — no AI. This module decides WHEN to show the card and
// renders three things from server-computed numbers
// (api.getDamageControlPlan -> GET /coach/damage-control ->
// services/damage_control_service.py):
//   1. a "zoom-out" SVG: today's spike as one notch on a 14-day ribbon, with
//      the trailing average barely tilting — the reframe is SHOWN, not told;
//   2. a deflation line ("~100 kcal/day if you even it out over a week");
//   3. three locus-of-control actions — Coast / Trim tomorrow / Move it.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { showToast } from "./ui.js";

const el = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

// Two independent trigger conditions, OR'd — catches both "one blowout meal"
// and "a day that crept over then tipped hard" without firing on an
// ordinary, only-slightly-over day:
//   - this ONE meal is already >= 60% of the whole day's calorie target;
//   - today's RUNNING TOTAL (incl. this meal) is >= 140% of target.
// The single-meal condition can fire again later the same day; the
// daily-overage condition fires at most once per calendar day.
const SINGLE_MEAL_TARGET_FRACTION = 0.6;
const DAILY_OVERAGE_FRACTION = 1.4;

// Local fallback for "Move it" when the plan fetch failed (see
// services/damage_control_service.py::walk_minutes_for for the real version).
const BRISK_WALK_KCAL_PER_MIN = 5.3; // ~70 kg at MET 4.3
const MOVE_IT_MIN_MINUTES = 5;
const MOVE_IT_MAX_MINUTES = 60;

let openWorkoutForMoveIt = null;
let onTrimApplied = null;
let dailyOverageShownDate = null;

// Chosen once per card-show so a language switch or re-render can't swap the
// opener mid-view. 1..N must match the damageControl.openerN keys in i18n.js.
const OPENER_COUNT = 6;
let currentOpenerIndex = 1;
// The plan for the currently-shown card (null until the fetch resolves, or
// on failure). "Move it" / "Trim tomorrow" read from it.
let currentPlan = null;
let estimatedOverage = 0;

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function triggerReason(mealCalories, todayTotalCalories, targetCalories) {
  if (!targetCalories) return null;
  if (mealCalories >= targetCalories * SINGLE_MEAL_TARGET_FRACTION) return "single_meal";
  if (todayTotalCalories >= targetCalories * DAILY_OVERAGE_FRACTION && dailyOverageShownDate !== todayDateStr()) {
    return "daily_overage";
  }
  return null;
}

// Exported so app.js can skip the whole thing for a backdated past-day entry.
export function shouldTrigger(mealCalories, todayTotalCalories, targetCalories) {
  return triggerReason(mealCalories, todayTotalCalories, targetCalories) !== null;
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function showCard() {
  const card = el("damage-control-card");
  card.hidden = false;
  // Two rAFs: the browser needs a full frame with `hidden` gone (display:
  // block) before the .show transition has anything to animate FROM.
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add("show")));
}

function hideCard() {
  const card = el("damage-control-card");
  if (card.hidden) return;
  card.classList.remove("show");
  // Matches --damage-control-exit-ms in style.css.
  setTimeout(() => {
    card.hidden = true;
  }, 320);
}

// --- the "zoom-out" sparkline -------------------------------------------
// Builds the SVG from `points` ([{calories, target, is_today, logged}], oldest
// first) + the "before today" baseline. All geometry goes through
// setAttribute (element attributes, never inline style) so it's CSP-clean;
// colour comes from the .dc-spark-* classes in style.css.
function renderSparkline(points, trailingAvgExclToday) {
  const svg = el("dc-sparkline");
  svg.replaceChildren();
  if (!points || !points.length) {
    el("dc-sparkline-wrap").hidden = true;
    return;
  }
  el("dc-sparkline-wrap").hidden = false;

  const W = 320;
  const H = 88;
  const TOP = 8;
  const BASE = 80; // baseline y; bar area is TOP..BASE
  const chartH = BASE - TOP;

  const maxVal = Math.max(
    ...points.map((p) => p.calories),
    ...points.map((p) => p.target),
    1,
  ) * 1.08;

  const slot = W / points.length;
  const barW = slot * 0.6;

  points.forEach((p, i) => {
    const x = i * slot + (slot - barW) / 2;
    const rect = document.createElementNS(SVG_NS, "rect");
    let h;
    let cls;
    if (!p.logged) {
      h = 3;
      cls = "dc-spark-bar dc-spark-bar--empty";
    } else {
      h = Math.max(3, (p.calories / maxVal) * chartH);
      cls = p.is_today ? "dc-spark-bar dc-spark-bar--today" : "dc-spark-bar";
    }
    rect.setAttribute("x", x.toFixed(1));
    rect.setAttribute("y", (BASE - h).toFixed(1));
    rect.setAttribute("width", barW.toFixed(1));
    rect.setAttribute("height", h.toFixed(1));
    rect.setAttribute("rx", "1.5");
    rect.setAttribute("class", cls);
    svg.appendChild(rect);
  });

  // The "barely moves" line — the average the user was already running
  // before this meal. Skipped when there's no prior history to average.
  if (trailingAvgExclToday > 0) {
    const y = BASE - (trailingAvgExclToday / maxVal) * chartH;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", "0");
    line.setAttribute("x2", String(W));
    line.setAttribute("y1", y.toFixed(1));
    line.setAttribute("y2", y.toFixed(1));
    line.setAttribute("class", "dc-spark-avg");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(line);
  }

  // The pull-back: start zoomed in on today's spike, then ease out to the
  // full ribbon on the next frame. Skipped entirely for reduced motion.
  if (!prefersReducedMotion()) {
    svg.classList.add("dc-sparkline--intro");
    requestAnimationFrame(() => requestAnimationFrame(() => svg.classList.remove("dc-sparkline--intro")));
  }
}

function renderCaption(plan) {
  const caption = el("dc-sparkline-caption");
  caption.replaceChildren();
  if (!plan || plan.trailing_avg_excl_today <= 0) {
    caption.hidden = true;
    return;
  }
  caption.hidden = false;
  const label = document.createElement("span");
  label.textContent = t("damageControl.trailingAvgLabel", {
    before: Math.round(plan.trailing_avg_excl_today).toLocaleString(),
    after: Math.round(plan.trailing_avg).toLocaleString(),
  });
  caption.appendChild(label);

  const delta = Math.round(plan.trailing_avg - plan.trailing_avg_excl_today);
  if (delta !== 0) {
    const deltaEl = document.createElement("span");
    deltaEl.className = "dc-caption-delta";
    deltaEl.textContent = t("damageControl.trailingAvgDelta", {
      delta: (delta > 0 ? "+" : "") + delta.toLocaleString(),
    });
    caption.appendChild(deltaEl);
  }
}

function setActionsDisabled(disabled) {
  for (const id of ["dc-trim-btn", "dc-move-btn"]) {
    el(id).disabled = disabled;
  }
}

// The red "+N kcal over" chip — cleared (not shown as "0 kcal over") when
// the card fired on the single-big-meal trigger but the day isn't actually
// over target yet. The title alone reads fine in that case.
function setSubtitle(over) {
  const sub = el("damage-control-subtitle");
  sub.textContent = over > 0 ? t("damageControl.subtitleOver", { amount: Math.round(over).toLocaleString() }) : "";
}

function renderPlan(plan) {
  currentPlan = plan;
  setSubtitle(plan.calories_over || estimatedOverage);

  renderSparkline(plan.sparkline, plan.trailing_avg_excl_today);
  renderCaption(plan);

  const deflation = plan.deflation || {};
  el("damage-control-deflation").textContent = t("damageControl.deflationLine", {
    perDay: Math.round(deflation.per_day_kcal || 0).toLocaleString(),
    days: deflation.spread_days || 7,
  });
  el("damage-control-deflation").hidden = false;
  setActionsDisabled(false);
}

// Fetch failed / quota-less error path — never a dead end for a feature
// whose whole job is reassurance. Keep the opener + Coast + Move it (Move it
// falls back to a local estimate); Trim tomorrow still calls the backend.
function renderFallback() {
  currentPlan = null;
  setSubtitle(estimatedOverage);
  el("dc-sparkline-wrap").hidden = true;
  el("dc-sparkline-caption").hidden = true;
  el("damage-control-deflation").hidden = true;
  setActionsDisabled(false);
}

async function fetchAndRenderPlan() {
  try {
    renderPlan(await api.getDamageControlPlan());
  } catch {
    renderFallback();
  }
}

// --- the three actions --------------------------------------------------
function onCoast() {
  hideCard();
  showToast(t("damageControl.coastToast"), "default");
}

async function onTrimTomorrow() {
  const btn = el("dc-trim-btn");
  btn.disabled = true;
  try {
    const res = await api.trimTomorrow();
    onTrimApplied?.(res);
    showToast(
      t("damageControl.trimApplied", { target: Math.round(res.temp_calorie_override).toLocaleString() }),
      "success",
    );
    hideCard();
  } catch {
    btn.disabled = false;
    showToast(t("damageControl.trimError"), "error");
  }
}

function moveItMinutes() {
  if (currentPlan?.walk_minutes) return currentPlan.walk_minutes;
  const raw = Math.round(Math.max(0, estimatedOverage) / BRISK_WALK_KCAL_PER_MIN);
  return Math.max(MOVE_IT_MIN_MINUTES, Math.min(raw, MOVE_IT_MAX_MINUTES));
}

function onMoveIt() {
  const minutes = moveItMinutes();
  hideCard();
  openWorkoutForMoveIt?.({ activity: t("damageControl.moveItActivity"), durationMinutes: minutes });
}

// `openWorkout` — workoutDiary.js's opener, injected (same DI pattern
// scan.js/coachChat.js use). `onTrim` — app.js callback that folds the trim
// response into state.targets and re-renders the dashboard.
export function initDamageControl({ openWorkout, onTrim }) {
  openWorkoutForMoveIt = openWorkout;
  onTrimApplied = onTrim;
  el("damage-control-dismiss-btn").addEventListener("click", hideCard);
  el("dc-coast-btn").addEventListener("click", onCoast);
  el("dc-trim-btn").addEventListener("click", onTrimTomorrow);
  el("dc-move-btn").addEventListener("click", onMoveIt);
}

// The one entry point app.js calls right after a new food log. `mealCalories`
// describes THAT entry, `todayTotalCalories` today's running total incl. it,
// `targetCalories` this user's own (effective) target. `whenPersisted`
// (optional) is the create-log network promise — the card shows instantly,
// but the plan fetch waits on it so the backend's daily_calorie_summary /
// daily_logs both include the triggering meal by the time it reads them.
// No-ops silently when neither trigger condition is met.
export function maybeTriggerDamageControl({
  mealCalories,
  todayTotalCalories,
  targetCalories,
  whenPersisted,
}) {
  const reason = triggerReason(mealCalories, todayTotalCalories, targetCalories);
  if (!reason) return;
  if (reason === "daily_overage") dailyOverageShownDate = todayDateStr();

  currentPlan = null;
  estimatedOverage = todayTotalCalories - targetCalories || mealCalories;
  currentOpenerIndex = 1 + Math.floor(Math.random() * OPENER_COUNT);

  // Immediate: opener + estimated overage, actions disabled until the plan lands.
  el("damage-control-opener").textContent = t(`damageControl.opener${currentOpenerIndex}`);
  setSubtitle(estimatedOverage);
  el("dc-sparkline-wrap").hidden = true;
  el("dc-sparkline-caption").hidden = true;
  el("damage-control-deflation").hidden = true;
  setActionsDisabled(true);
  showCard();

  Promise.resolve(whenPersisted)
    .catch(() => {}) // an offline-queued / failed save still gets a best-effort fetch
    .then(fetchAndRenderPlan);
}
