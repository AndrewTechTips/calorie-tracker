// Predictive Analytics card (Progress tab) — thin rendering layer over
// GET /analytics/insights / POST /analytics/apply-adaptive-goal (see
// backend/services/analytics_service.py for the actual math: Mifflin-St
// Jeor, an empirical TDEE regression against the user's own weight trend, a
// dynamic day-by-day energy-balance simulation, and a Goldberg-EI:BMR-style
// under-logging heuristic). This module does no math of its own — it only
// renders whatever the backend already computed, and handles the two
// user-initiated writes (locking a macro, applying a suggested target).
import { api } from "./api.js?v=20260818g";
import { resetPillTabs, showToast, wirePillTabs } from "./ui.js?v=20260818g";
import { onLanguageChange, t } from "./i18n.js?v=20260818g";

const el = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

// Fed by app.js (same "plain stashed primitives, independent of app.js's own
// state object" pattern as aiCoach.js's setContext) — this module never
// imports app.js directly, avoiding a circular import.
let context = {
  // Builds the full PUT /targets payload app.js already knows how to send
  // (daily_calories/protein/carbs/fats/fiber/water_ml/goal_type) — reused
  // here so a macro-lock change round-trips the rest of the user's existing
  // targets unchanged, same as the avatar/display-name instant-apply saves
  // in app.js itself.
  getTargetsPayload: () => null,
  // Called with the fresh TargetsResponse after either write below succeeds,
  // so app.js can sync its own state.targets/UI the same way it does after
  // any other settings save.
  onTargetsUpdated: () => {},
};
export function setContext(next) {
  context = { ...context, ...next };
}

let lastInsights = null;

const REASON_TONE = {
  on_track: "success",
  stalled_no_progress: "warning",
  stalled_wrong_direction: "danger",
  drifting: "warning",
  insufficient_data: "info",
};
const REASON_ICONS = {
  on_track: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stalled_no_progress: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5L22 20H2L12 3.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 9.5v4.2M12 16.7v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  stalled_wrong_direction: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5L22 20H2L12 3.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 9.5v4.2M12 16.7v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  drifting: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5L22 20H2L12 3.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 9.5v4.2M12 16.7v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  insufficient_data: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 8v5M12 16v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
const REASON_TEXT_KEYS = {
  on_track: "analytics.reasonOnTrack",
  stalled_no_progress: "analytics.reasonStalledNoProgress",
  stalled_wrong_direction: "analytics.reasonStalledWrongDirection",
  drifting: "analytics.reasonDrifting",
  insufficient_data: "analytics.reasonInsufficientData",
};

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function sizeSvgToContainer(svg, height) {
  const width = Math.round(svg.getBoundingClientRect().width) || 320;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return width;
}

// Draws current weight + the 30/60/90-day projections as one line — same
// visual language as progress.js's own weight trend chart (chart-line/
// chart-dot classes), just a self-contained draw here since progress.js
// doesn't export its own svg helpers.
function drawForecastChart(svg, currentWeightKg, projections) {
  svg.innerHTML = "";
  const height = 130;
  const width = sizeSvgToContainer(svg, height);
  const pad = 24;
  const series = [{ x: 0, y: currentWeightKg }, ...projections.map((p) => ({ x: p.days, y: p.weight_kg }))];
  const values = series.map((p) => p.y);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const span = maxV - minV || 1;
  const maxX = series[series.length - 1].x || 1;

  const points = series.map((p) => [
    pad + (p.x / maxX) * (width - pad * 2),
    pad / 2 + (1 - (p.y - minV) / span) * (height - pad * 1.5),
  ]);

  const pathData = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  svg.appendChild(svgEl("path", { d: pathData, class: "chart-line" }));
  points.forEach(([x, y], i) => {
    svg.appendChild(svgEl("circle", { cx: x, cy: y, r: i === 0 ? 3.5 : 3, class: "chart-dot" }));
  });
  series.forEach((p, i) => {
    const [x] = points[i];
    const label = i === 0 ? t("analytics.chartToday") : t("analytics.chartDayLabel", { days: p.x });
    const labelNode = svgEl("text", { x, y: height - 4, "text-anchor": i === 0 ? "start" : i === series.length - 1 ? "end" : "middle", class: "chart-label" });
    labelNode.textContent = label;
    svg.appendChild(labelNode);
  });
  // Plain `svg.hidden = false` doesn't reliably clear the underlying
  // `hidden` content attribute on SVGElement in every browser (verified live
  // here — see progress.js's own setSvgHidden() for the same fix and a
  // fuller explanation); toggleAttribute writes the attribute directly,
  // which is what style.css's `[hidden] { display: none }` actually keys off.
  svg.toggleAttribute("hidden", false);
}

function renderForecast(forecast, avgDailyCaloriesBurned) {
  el("analytics-forecast-empty").hidden = forecast.data_sufficient;
  el("analytics-forecast-content").hidden = !forecast.data_sufficient;
  if (!forecast.data_sufficient) return;

  el("analytics-current-weight").textContent = `${forecast.current_weight_kg} kg`;
  el("analytics-bmr").textContent = `${Math.round(forecast.bmr_estimate)} kcal`;
  el("analytics-tdee").textContent = `${Math.round(forecast.tdee_estimate)} kcal`;

  // Always shown once there's ANY logged workout history, even when this
  // forecast used the regression method and the figure therefore had no
  // influence on tdee_estimate above — see
  // analytics_service.calculate_tdee_with_logged_activity's docstring for
  // why it's only ever applied on the "formula" method.
  const hasWorkoutData = avgDailyCaloriesBurned > 0;
  el("analytics-training-burn-stat").hidden = !hasWorkoutData;
  el("analytics-training-burn-note").hidden = !hasWorkoutData;
  if (hasWorkoutData) {
    el("analytics-training-burn").textContent = `${Math.round(avgDailyCaloriesBurned)} kcal`;
    el("analytics-training-burn-note").textContent = t(
      forecast.method === "formula" ? "analytics.trainingBurnUsed" : "analytics.trainingBurnNotUsed"
    );
  }

  const list = el("analytics-projection-list");
  list.replaceChildren();
  forecast.projections.forEach((p) => {
    const tile = document.createElement("div");
    tile.className = "analytics-projection-tile";
    const days = document.createElement("span");
    days.className = "analytics-projection-days";
    days.textContent = t("analytics.projectionDays", { days: p.days });
    const weight = document.createElement("span");
    weight.className = "analytics-projection-weight mono";
    weight.textContent = `${p.weight_kg} kg`;
    tile.append(days, weight);
    list.appendChild(tile);
  });

  drawForecastChart(el("analytics-forecast-chart"), forecast.current_weight_kg, forecast.projections);

  el("analytics-method-note").textContent =
    forecast.method === "regression"
      ? t("analytics.methodRegression", { days: forecast.anomaly_window_days })
      : t("analytics.methodFormula");

  const anomalyNote = el("analytics-anomaly-note");
  const count = forecast.anomalies.length;
  anomalyNote.hidden = count === 0;
  if (count > 0) {
    el("analytics-anomaly-note-text").textContent = t("analytics.anomalyNote", { count });
  }
}

function renderAdaptiveGoal(adaptiveGoal) {
  el("analytics-adaptive-empty").hidden = !!adaptiveGoal;
  el("analytics-adaptive-content").hidden = !adaptiveGoal;
  if (!adaptiveGoal) return;

  const banner = el("analytics-adaptive-banner");
  const tone = REASON_TONE[adaptiveGoal.reason] || "info";
  // Tone styling is keyed off the .tone-* CLASS (see style.css's
  // .status-banner.tone-success etc.), not the data-tone attribute alone —
  // that attribute is kept in sync too since every other status-banner in
  // this app sets both together.
  banner.className = `status-banner tone-${tone}`;
  banner.dataset.tone = tone;
  el("analytics-adaptive-banner-icon").innerHTML = REASON_ICONS[adaptiveGoal.reason] || "";
  el("analytics-adaptive-banner-text").textContent = t(REASON_TEXT_KEYS[adaptiveGoal.reason] || "analytics.reasonOnTrack");

  el("analytics-suggested-calories").textContent = `${Math.round(adaptiveGoal.suggested_daily_calories)} kcal`;
  el("analytics-suggested-protein").textContent = `${adaptiveGoal.suggested_protein} g`;
  el("analytics-suggested-carbs").textContent = `${adaptiveGoal.suggested_carbs} g`;
  el("analytics-suggested-fats").textContent = `${adaptiveGoal.suggested_fats} g`;

  resetPillTabs("analytics-lock-tabs", adaptiveGoal.locked_macro || "");
}

export async function renderAnalyticsInsights() {
  try {
    lastInsights = await api.getAnalyticsInsights();
  } catch {
    // A passive dashboard card, not a blocking action — fail quietly into
    // the existing "log your weight" empty states rather than a toast, same
    // as suggestions.js's own soft-fail philosophy for non-critical cards.
    el("analytics-forecast-empty").hidden = false;
    el("analytics-forecast-content").hidden = true;
    el("analytics-adaptive-empty").hidden = false;
    el("analytics-adaptive-content").hidden = true;
    return;
  }
  renderForecast(lastInsights.forecast, lastInsights.avg_daily_calories_burned);
  renderAdaptiveGoal(lastInsights.adaptive_goal);
}

// Guards against the pill-selection race that produced the reported
// "selecting none or looping" glitch: wirePillTabs already flips the tapped
// pill active synchronously (see ui.js), but the actual save is async, and
// nothing stopped a second tap from firing a second, overlapping request
// before the first one resolved. Two in-flight requests can settle in
// EITHER order, so a stale response arriving last would call
// resetPillTabs() with an old macro and visually revert/flicker the user's
// newer choice. lockRequestSeq makes only the most recently *initiated* call
// allowed to touch the DOM — an outdated response is a no-op instead.
let lockRequestSeq = 0;

async function saveLockedMacro(macro) {
  const payload = context.getTargetsPayload();
  if (!payload) return;
  const seq = ++lockRequestSeq;
  const tabs = el("analytics-lock-tabs");
  tabs.classList.add("pill-tabs-pending");
  try {
    const updated = await api.updateTargets({ ...payload, locked_macro: macro || null });
    if (seq !== lockRequestSeq) return;
    context.onTargetsUpdated(updated);
    await renderAnalyticsInsights();
  } catch (err) {
    if (seq !== lockRequestSeq) return;
    // Revert the optimistic pill selection to the last known-good server
    // state rather than leaving it showing a lock that never actually saved.
    resetPillTabs("analytics-lock-tabs", lastInsights?.adaptive_goal?.locked_macro || "");
    showToast(err.message || t("toast.couldNotUpdateTargets"), "error");
  } finally {
    if (seq === lockRequestSeq) tabs.classList.remove("pill-tabs-pending");
  }
}

export function initAnalytics() {
  wirePillTabs("analytics-lock-tabs", (macro) => saveLockedMacro(macro));

  el("analytics-apply-btn").addEventListener("click", async () => {
    const btn = el("analytics-apply-btn");
    btn.disabled = true;
    try {
      const updated = await api.applyAdaptiveGoal();
      context.onTargetsUpdated(updated);
      showToast(t("analytics.applySuccess"), "success");
      await renderAnalyticsInsights();
    } catch (err) {
      showToast(err.message || t("analytics.applyError"), "error");
    } finally {
      btn.disabled = false;
    }
  });

  onLanguageChange(() => {
    if (lastInsights) {
      renderForecast(lastInsights.forecast, lastInsights.avg_daily_calories_burned);
      renderAdaptiveGoal(lastInsights.adaptive_goal);
    }
  });
}
