import { api } from "./api.js?v=20260811g";
import {
  closeSheet,
  computeMacroContributions,
  deleteWithUndo,
  escapeHtml,
  fadeOutSkeleton,
  initCollapsibleListToggles,
  openSheet,
  reconcileList,
  runOrDeferDuringSwipe,
  showToast,
  updateCollapsibleList,
  vibrate,
} from "./ui.js?v=20260811g";
import { getLocale, onLanguageChange, t } from "./i18n.js?v=20260811g";
import { computeStreakWithFreeze, daysUntilNextFreeze } from "./streakFreeze.js?v=20260811g";
import { computeEMA, computeLinearTrendRate, computeWeightForecast } from "./nutritionMath.js?v=20260811g";
import { initSuggestions, renderSuggestions } from "./suggestions.js?v=20260811g";
import { setContext as setAiCoachContext } from "./aiCoach.js?v=20260811g";

const el = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

// One glyph per day-history status, replacing the old plain colored dot
// (adherent/off/none all looked like the same "dot", just tinted — easy to
// miss at a glance). A check for a day that hit target, a caution triangle
// for a day that missed it, and a hollow calendar mark for a day nothing was
// logged at all — each one legible on its own, no color-only signal.
const DAY_STATUS_ICONS = {
  adherent: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  off: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 4.5L21 19H3L12 4.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4M12 16.5v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  none: '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="15" rx="3" stroke="currentColor" stroke-width="1.6"/><path d="M4 9.5h16M8 3v3.5M16 3v3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  // A missed day the streak-freeze (js/streakFreeze.js) bridged — visually
  // distinct from "off" (this day didn't hurt the streak) but still not
  // "adherent" (nothing was actually logged/on-target that day).
  frozen: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 4v16M4.5 8l15 8M19.5 8l-15 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

// The `.hidden` IDL property doesn't reliably reflect to the underlying
// `hidden` content attribute on SVGElement in every browser the way it does
// on HTMLElement (SVGElement's spec support for the shared HTMLOrForeignElement
// mixin varies) — the property can silently read back `false` while the
// attribute (what the UA stylesheet's `[hidden] { display: none }` actually
// keys off) stays present, leaving the chart permanently invisible.
// toggleAttribute writes the attribute directly, sidestepping that gap
// entirely. Every el().hidden toggle on an <svg> in this file goes through
// this instead of a plain assignment.
function setSvgHidden(svg, hidden) {
  svg.toggleAttribute("hidden", hidden);
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// Sets the SVG's viewBox to exactly match its actual rendered pixel width
// (height is fixed by CSS). Without this, a hardcoded viewBox like "0 0 320
// 152" only matches the real box on whatever screen width happens to equal
// 320:152's ratio — on any other width the browser (with
// preserveAspectRatio="none", needed to fill the box responsively) stretches
// X and Y independently to fit, which distorts text glyphs into visibly
// squished/stretched shapes and turns round dots into ellipses. Matching the
// coordinate system to the real box 1:1 means there's never anything to
// stretch, on any screen size.
function sizeSvgToContainer(svg, height) {
  const width = Math.round(svg.getBoundingClientRect().width) || 320;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return width;
}

// Cached so a language switch or a weight add/delete can re-render instantly
// from what we already have, instead of re-fetching from the server.
let currentTargets = null;
let lastTrends = null;
let lastWeights = null;
let lastMeasurements = null;
let lastLogs = null;
let lastSavedMeals = null;
let lastWorkouts = null;
let lastMilestoneStats = null;
let editingMeasurementId = null; // set while the sheet is editing an existing entry rather than adding a new one
let editingWorkoutId = null; // same idea, for the workout-sheet

// Shared by the weight trend chart and the (per-name) measurement trend
// chart below — both are "one numeric value over time" line charts, just
// plotting a different field off a different entry list.
function drawTrendLine(svg, chronological, valueKey) {
  svg.innerHTML = "";
  const height = 140;
  const width = sizeSvgToContainer(svg, height);
  const pad = 10;
  const values = chronological.map((e) => e[valueKey]);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const span = maxV - minV || 1;

  const points = chronological.map((entry, i) => {
    const x = pad + (chronological.length > 1 ? (i / (chronological.length - 1)) * (width - pad * 2) : 0);
    const y = pad + (1 - (entry[valueKey] - minV) / span) * (height - pad * 2);
    return [x, y];
  });

  const pathData = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  svg.appendChild(svgEl("path", { d: pathData, class: "chart-line" }));
  points.forEach(([x, y]) => svg.appendChild(svgEl("circle", { cx: x, cy: y, r: 3, class: "chart-dot" })));
}

function renderStreak(streak) {
  el("streak-card").classList.toggle("inactive", streak <= 0);
  el("streak-number").textContent = streak;
  el("streak-label").textContent = streak > 0 ? t("progress.streakLabel") : t("progress.streakNone");
}

// freezeAppliedDate: the specific date (if any) the streak freeze is
// currently bridging, within the retention window shown right now —
// distinct from "a freeze was ever used", which could be an old date no
// longer even visible once it rolls out of the 7-day window. freezeReady:
// whether a fresh token is available for a *future* miss.
function renderStreakFreezeBadge(freezeAppliedDate, freezeReady) {
  const textEl = el("streak-freeze-text");
  if (freezeAppliedDate) {
    textEl.textContent = t("progress.streakFreezeActive");
  } else if (freezeReady) {
    textEl.textContent = t("progress.streakFreezeReady");
  } else {
    textEl.textContent = t("progress.streakFreezeCooldown", { days: daysUntilNextFreeze() });
  }
}

// Generic consecutive-day streak counter, mirroring trends_service.py's own
// calorie-streak algorithm exactly (reversed-loop, most-recent-day-first,
// "today" skipped rather than judged if it has no activity yet — since the
// day isn't over — otherwise breaking on the first day that misses target).
// Reused for both the water streak (below) and the Fiber Streak milestone,
// against whatever `valueKey` each of those cares about — no backend change
// needed for either, `days` already carries everything both need (or, for
// fiber, is pre-merged with it — see alignDailyFiberTotals below).
// `tolerance` defaults to 0 (exact `>=`, today's existing behavior) — water
// (the other caller below) stays exact, since "drank enough water" is
// genuinely all-or-nothing in a way a macro isn't. The fiber streak passes
// FIBER_TOLERANCE explicitly (see that constant's own comment, further down
// this file) so a day a few grams short of the target doesn't snap an
// otherwise-real streak — fiber is a soft recommendation, not a hard floor.
function computeConsecutiveStreak(days, valueKey, target, tolerance = 0) {
  if (!target || !days?.length) return 0;
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    const isToday = i === days.length - 1;
    const hasActivity = day.calories > 0;
    if (isToday && !hasActivity) continue;
    if (day[valueKey] >= target * (1 - tolerance)) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// lastTrends.days has no fiber field at all (trends_service.py's DayTrend
// only carries calories/protein/carbs/fats/water_ml/weight_kg/adherent) —
// so this builds a parallel {date, calories, fiber} array from the same
// logs already fetched for "What's driving your calories" (lastLogs),
// aligned to the exact same date range/order as `days`, for
// computeConsecutiveStreak above to use exactly like any other day-array.
function alignDailyFiberTotals(days, logs) {
  const fiberByDate = new Map();
  (logs || []).forEach((log) => {
    fiberByDate.set(log.log_date, (fiberByDate.get(log.log_date) || 0) + (log.fiber || 0));
  });
  return days.map((day) => ({ date: day.date, calories: day.calories, fiber: fiberByDate.get(day.date) || 0 }));
}

// "Balanced Week" milestone: how many complete days hit the protein target
// while keeping fats at/under 75% of theirs — the same "full protein, fats
// still in check" combination coach.js's status.dialedIn message already
// praises, just counted across the window instead of judged for one day.
const FATS_DISCIPLINE_THRESHOLD = 0.75;
function countBalancedDays(days, targets) {
  const proteinTarget = targets?.daily_protein || 0;
  const fatsTarget = targets?.daily_fats || 0;
  if (!proteinTarget || !fatsTarget) return 0;
  // Same ±10% "close enough is a hit" tolerance as macroOnTarget below —
  // 1g short of the protein target on an otherwise dialed-in day shouldn't
  // be the reason this milestone doesn't count it.
  return days.filter((day) => day.protein >= proteinTarget * (1 - TARGET_TOLERANCE) && day.fats <= fatsTarget * FATS_DISCIPLINE_THRESHOLD)
    .length;
}

function renderWaterStreak(streak) {
  const chip = el("water-streak-chip");
  chip.hidden = streak <= 1;
  if (streak > 1) el("water-streak-text").textContent = t("progress.waterStreakLabel", { days: streak });
}

// A single 0-100 blend of three already-known signals — how much of the
// retention window the current streak covers, what fraction of days were
// calorie-adherent, and what fraction had any logging at all — rather than
// a new metric needing its own storage or backend computation. Shown next
// to the Milestones heading (see renderFromCache).
function computeConsistencyScore(days, streak) {
  if (!days?.length) return 0;
  const streakRatio = Math.min(streak / days.length, 1);
  const adherentRatio = days.filter((d) => d.adherent).length / days.length;
  const loggingRatio = days.filter((d) => d.calories > 0).length / days.length;
  return Math.round(((streakRatio + adherentRatio + loggingRatio) / 3) * 100);
}

// Full target review — reuses the same trends `days` already fetched for
// the calorie chart to spot N consecutive complete days meaningfully over
// or under the calorie target, and suggests revisiting targets rather than
// silently saying nothing. Same simple-thresholds philosophy as coach.js —
// no AI call, no new backend endpoint. "Complete" days only: an empty past
// day breaks either streak (nothing to judge), and today itself is skipped
// entirely if it has no logs yet (the day isn't over).
const TARGET_REVIEW_OVER_RATIO = 1.1;
const TARGET_REVIEW_UNDER_RATIO = 0.85;
const TARGET_REVIEW_MIN_DAYS = 5;
const TARGET_REVIEW_DISMISS_KEY = "ironlog_target_review_dismissed";

function countConsecutiveDirection(days, targetCalories) {
  let overCount = 0;
  let underCount = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    const isToday = i === days.length - 1;
    if (day.calories <= 0) {
      if (isToday) continue; // today just hasn't started yet — not a break
      break; // a genuinely empty past day breaks either streak
    }
    const ratio = day.calories / (targetCalories || 1);
    if (ratio > TARGET_REVIEW_OVER_RATIO && underCount === 0) {
      overCount++;
    } else if (ratio < TARGET_REVIEW_UNDER_RATIO && overCount === 0) {
      underCount++;
    } else {
      break;
    }
  }
  if (overCount >= TARGET_REVIEW_MIN_DAYS) return { direction: "over", count: overCount };
  if (underCount >= TARGET_REVIEW_MIN_DAYS) return { direction: "under", count: underCount };
  return { direction: null, count: 0 };
}

function renderTargetReviewBanner(days, targetCalories) {
  const banner = el("target-review-banner");
  const { direction, count } = countConsecutiveDirection(days, targetCalories);
  if (!direction) {
    banner.hidden = true;
    return;
  }
  const today = days[days.length - 1]?.date || "";
  const dismissKey = `${TARGET_REVIEW_DISMISS_KEY}:${today}:${direction}`;
  if (localStorage.getItem(dismissKey)) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.dataset.dismissKey = dismissKey;
  el("target-review-text").textContent = t(direction === "over" ? "progress.targetReviewOver" : "progress.targetReviewUnder", {
    count,
  });
}

// Two vertical gradients (under/over target), redefined each render inside
// the chart's own <defs> and referenced by each bar's fill attribute —
// matches the gradient look of the macro bars/calorie ring elsewhere.
function appendBarGradients(svg) {
  const defs = svgEl("defs", {});
  const under = svgEl("linearGradient", { id: "barGradUnder", x1: "0", y1: "0", x2: "0", y2: "1" });
  under.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#6bffce" }));
  under.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#33d6a6" }));
  const over = svgEl("linearGradient", { id: "barGradOver", x1: "0", y1: "0", x2: "0", y2: "1" });
  over.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#ff8095" }));
  over.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#ff5470" }));
  defs.appendChild(under);
  defs.appendChild(over);
  svg.appendChild(defs);
}

// A small inline-SVG bar chart — deliberately not a charting library/CDN
// dependency, to keep the app's strict CSP untouched (see index.html).
function renderCalorieChart(days, targetCalories) {
  const svg = el("calorie-trend-chart");
  svg.innerHTML = "";
  appendBarGradients(svg);

  const height = 152;
  const width = sizeSvgToContainer(svg, height);
  const topPad = 22; // extra headroom above the tallest bar for its value label
  const bottomPad = 20;
  const chartHeight = height - topPad - bottomPad;
  const gap = 6;
  const barWidth = (width - gap * (days.length + 1)) / days.length;
  const maxVal = Math.max(targetCalories, ...days.map((d) => d.calories), 1) * 1.2;

  // A faint full-height track behind every day, so a day with nothing logged
  // still reads as "a day", not an empty gap in the chart.
  days.forEach((day, i) => {
    const x = gap + i * (barWidth + gap);
    svg.appendChild(svgEl("rect", { x, y: topPad, width: barWidth, height: chartHeight, rx: 4, class: "chart-bar-bg" }));
  });

  const todayIndex = days.length - 1;
  days.forEach((day, i) => {
    const barHeight = day.calories > 0 ? Math.max((day.calories / maxVal) * chartHeight, 3) : 0;
    const x = gap + i * (barWidth + gap);
    const y = topPad + chartHeight - barHeight;
    const over = day.calories > targetCalories;
    if (barHeight > 0) {
      const classes = ["chart-bar", over ? "over" : "", i === todayIndex ? "today-bar" : ""].filter(Boolean).join(" ");
      svg.appendChild(
        svgEl("rect", {
          x,
          y,
          width: barWidth,
          height: barHeight,
          rx: 4,
          class: classes,
          fill: over ? "url(#barGradOver)" : "url(#barGradUnder)",
        })
      );
      // The actual kcal figure for that day, sitting right above its bar —
      // previously the only number on this chart was the target line's, so
      // there was no way to read off how much any given day actually was.
      const valueLabel = svgEl("text", {
        x: x + barWidth / 2,
        y: Math.max(y - 4, 9),
        "text-anchor": "middle",
        class: ["chart-value-label", over ? "over" : "", i === todayIndex ? "today" : ""].filter(Boolean).join(" "),
      });
      valueLabel.textContent = Math.round(day.calories).toLocaleString();
      svg.appendChild(valueLabel);
    }

    const label = svgEl("text", {
      x: x + barWidth / 2,
      y: height - 5,
      "text-anchor": "middle",
      class: i === todayIndex ? "chart-label today" : "chart-label",
    });
    // Labeled by weekday — each day.date is now a real, always-unique
    // calendar date (see backend/services/trends_service.py), so within a
    // 7-day window a short weekday name is unambiguous and more readable
    // than a raw date string.
    label.textContent = new Date(`${day.date}T00:00:00`).toLocaleDateString(getLocale(), { weekday: "short" });
    svg.appendChild(label);
  });

  // Target line drawn last (on top of the bars) so it — and its label — are
  // always visible even when a day's bar goes above it, instead of a tall
  // "over" bar painting over and hiding the target figure underneath it.
  const targetY = topPad + chartHeight * (1 - Math.min(targetCalories / maxVal, 1));
  svg.appendChild(svgEl("line", { x1: 0, x2: width, y1: targetY, y2: targetY, class: "chart-target" }));
  const targetLabel = svgEl("text", { x: 2, y: Math.max(targetY - 4, 9), class: "chart-target-label" });
  targetLabel.textContent = Math.round(targetCalories).toLocaleString();
  svg.appendChild(targetLabel);

  // Weekly average is over days that actually have a log — an all-zero empty
  // day dragging the average down would be misleading, not informative.
  const loggedDays = days.filter((d) => d.calories > 0);
  const avgStat = el("calorie-avg-stat");
  if (!loggedDays.length) {
    avgStat.textContent = "";
    return;
  }
  const avgCalories = Math.round(loggedDays.reduce((sum, d) => sum + d.calories, 0) / loggedDays.length);
  avgStat.textContent = `${t("progress.avgLabel")}: ${avgCalories.toLocaleString()} / ${Math.round(targetCalories).toLocaleString()}`;
}

// "Jul 21" for a bucket that has a known calendar date (i.e. has at least
// one log); "" for a not-yet-logged day, which has no date to show yet.
function formatDayDate(dateStr) {
  if (!dateStr) return "";
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
}

// Weekly macro-consistency summary — replaces a previous per-day dot grid
// that just duplicated Daily History below it (tapping any square opened the
// exact same day-detail sheet a Daily History row already opens) without
// adding anything a weekly aggregate couldn't say more clearly. `direction`
// matters here: protein/fiber are "at least" targets (more is fine, there's
// no ceiling — see ui.js's BONUS_OVERAGE_MACROS for fiber specifically), but
// carbs/fats are budgets — coach.js already treats going over them as a
// caution, not a win, so "on target" has to mean *under*, not over, or this
// card would silently reward exactly the days coach.js is warning about.
const MACRO_CONSISTENCY_ROWS = [
  { key: "protein", nameKey: "dashboard.protein", target: (t) => t.daily_protein, direction: "min" },
  { key: "carbs", nameKey: "dashboard.carbs", target: (t) => t.daily_carbs, direction: "max" },
  { key: "fats", nameKey: "dashboard.fats", target: (t) => t.daily_fats, direction: "max" },
  { key: "fiber", nameKey: "dashboard.fiber", target: (t) => t.daily_fiber, direction: "min" },
];

// A human reads "1g short of my protein target" or "1g over my carb budget"
// as a day they basically nailed, not a miss — the old plain `>=`/`<=`
// comparison here didn't allow for that, so a day at 99% of a "min" target
// or 101% of a "max" one counted as a flat miss. TARGET_TOLERANCE mirrors
// the same 10% band app.js's WEEK_ADHERENCE_TOLERANCE (and the backend's own
// streak calc) already gives calories, applied here so "on target" means the
// same generous thing for every macro, not just calories.
const TARGET_TOLERANCE = 0.1; // ±10% still counts as "on target"
// Fiber is explicitly a soft recommendation, not a hard floor (see
// MACRO_CONSISTENCY_ROWS' own comment on why it shares protein's "min"
// direction but not its stakes) — going over is already always fine, and
// falling a bit short of "a reasonable amount" shouldn't read as a miss the
// way meaningfully under on protein does. A wider band reflects that.
const FIBER_TOLERANCE = 0.25;

function macroOnTarget(value, target, direction, key) {
  const tolerance = key === "fiber" ? FIBER_TOLERANCE : TARGET_TOLERANCE;
  return direction === "min" ? value >= target * (1 - tolerance) : value <= target * (1 + tolerance);
}

// One row per macro: this week's average as a % of target (the bar), plus
// how many of the days that actually had any logging landed "on target" by
// that macro's own direction. Only days with *some* logging count toward the
// average/hit-rate — an empty past day has nothing to average in, the same
// "none isn't a miss" rule the old heatmap used.
function computeMacroWeeklyStats(days, targets, logs) {
  const fiberByDate = new Map();
  (logs || []).forEach((log) => {
    fiberByDate.set(log.log_date, (fiberByDate.get(log.log_date) || 0) + (log.fiber || 0));
  });
  const loggedDays = (days || []).filter((d) => d.calories > 0);

  return MACRO_CONSISTENCY_ROWS.map((row) => {
    const target = row.target(targets) || 0;
    const values = loggedDays.map((d) => (row.key === "fiber" ? fiberByDate.get(d.date) || 0 : d[row.key] || 0));
    const avg = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
    const hitCount = target ? values.filter((v) => macroOnTarget(v, target, row.direction, row.key)).length : 0;
    return {
      key: row.key,
      name: t(row.nameKey),
      direction: row.direction,
      target,
      avg,
      pct: target ? Math.round((avg / target) * 100) : 0,
      hitCount,
      loggedCount: values.length,
    };
  });
}

// The single most useful thing this card can say in one sentence: which
// macro needs attention, and — specifically for carbs/fats (a budget that
// was *exceeded*, not a floor that was missed) — which logged food is
// actually driving that overage, reusing the exact same per-food ranking
// ui.js's dashboard macro-detail tap already computes (computeMacroContributions),
// just pointed at the whole retention window instead of just today. A floor
// macro (protein/fiber) coming up short doesn't have a single "culprit" food
// the same way, so that case just names the macro and its hit-rate instead.
function computeMacroInsight(rows, logs) {
  const scored = rows.filter((r) => r.loggedCount > 0 && r.target > 0).map((r) => ({ ...r, ratio: r.hitCount / r.loggedCount }));
  if (!scored.length) return null;
  const weakest = scored.reduce((min, r) => (r.ratio < min.ratio ? r : min));
  if (weakest.ratio >= 0.7) return { kind: "good" };
  if (weakest.direction === "max") {
    const top = computeMacroContributions(logs || [], weakest.key)[0];
    if (top) return { kind: "overTop", macro: weakest.name, food: top.name, hit: weakest.hitCount, total: weakest.loggedCount };
  }
  return { kind: "weak", macro: weakest.name, hit: weakest.hitCount, total: weakest.loggedCount };
}

function renderMacroConsistency(days, targets, logs) {
  const container = el("macro-consistency");
  const overallStat = el("macro-consistency-stat");
  const insightEl = el("macro-consistency-insight");
  if (!targets || !days?.length) {
    container.innerHTML = "";
    overallStat.textContent = "";
    insightEl.textContent = "";
    return;
  }

  const rows = computeMacroWeeklyStats(days, targets, logs);

  container.innerHTML = rows
    .map((row) => {
      const metaText = t("progress.macroAvgOfTarget", { avg: Math.round(row.avg), target: Math.round(row.target) });
      const hitText = row.loggedCount > 0 ? t("progress.macroHitDays", { hit: row.hitCount, total: row.loggedCount }) : t("progress.noLogsShort");
      return `
      <div class="mc-row">
        <div class="mc-row-top">
          <span class="mc-row-label"><span class="mc-row-dot" data-macro="${row.key}"></span>${escapeHtml(row.name)}</span>
          <span class="mc-row-pct mono" data-macro="${row.key}">${row.loggedCount > 0 ? `${row.pct}%` : "—"}</span>
        </div>
        <div class="mc-bar-track"><div class="mc-bar-fill" data-macro="${row.key}"></div></div>
        <div class="mc-row-meta">
          <span>${metaText}</span>
          <span class="mc-row-meta-dot" aria-hidden="true"></span>
          <span>${hitText}</span>
        </div>
      </div>
    `;
    })
    .join("");

  // Bar widths are a continuous percentage, set via real DOM style assignment
  // (never baked into the innerHTML string above) — same CSP-safety reason as
  // every other dynamically-sized bar in this app (see top-food-macro-bar
  // above, ring-calories in ui.js).
  const rowEls = container.querySelectorAll(".mc-row");
  rows.forEach((row, i) => {
    rowEls[i].querySelector(".mc-bar-fill").style.transform = `scaleX(${Math.max(Math.min(row.pct, 100), 0) / 100})`;
  });

  const avgPct = rows.length ? Math.round(rows.reduce((sum, r) => sum + Math.min(r.pct, 100), 0) / rows.length) : 0;
  overallStat.textContent = rows.some((r) => r.loggedCount > 0) ? t("progress.macroConsistencyStat", { pct: avgPct }) : "";

  const insight = computeMacroInsight(rows, logs);
  insightEl.textContent = insight
    ? insight.kind === "good"
      ? t("progress.macroInsightGood")
      : insight.kind === "overTop"
        ? t("progress.macroInsightOverTop", { macro: insight.macro, food: insight.food })
        : t("progress.macroInsightWeak", { macro: insight.macro, hit: insight.hit, total: insight.total })
    : "";
}

// A readable, per-day list alongside the bar chart above — "Jul 22 you had
// 2,140 kcal" is easier to scan than reading it off a bar's height. Reuses
// the trends data already fetched for the chart (no extra network call) and
// renders newest-first. Keyed by day.date — a real calendar date, unique by
// construction (see backend/services/trends_service.py) — and reconciled in
// place (see reconcileList in ui.js) rather than rebuilt from scratch on
// every tab switch, so reopening Progress doesn't replay every row's
// entrance animation each time. Tapping a row opens that day's individual
// entries (see onDayClick, initProgress below) — the "edit a past day" flow.
function renderDayHistory(days, targetCalories, frozenDate) {
  const list = el("day-history-list");
  const pAbbr = t("dashboard.macroAbbrProtein");
  const cAbbr = t("dashboard.macroAbbrCarbs");
  const fAbbr = t("dashboard.macroAbbrFats");
  const reversedDays = [...days].reverse();

  reconcileList(list, reversedDays, {
    getId: (day) => day.date,
    extraClass: (day) => {
      const hasLogs = day.calories > 0 || day.protein > 0 || day.carbs > 0 || day.fats > 0;
      const isFrozen = day.date === frozenDate;
      const statusClass = isFrozen ? "status-frozen" : hasLogs ? (day.adherent ? "status-adherent" : "status-off") : "";
      return ["day-history-item", statusClass, day === reversedDays[0] ? "today" : ""].filter(Boolean).join(" ");
    },
    buildHtml: (day) => {
      const hasLogs = day.calories > 0 || day.protein > 0 || day.carbs > 0 || day.fats > 0;
      const isCurrent = day === reversedDays[0];
      const dateLabel = formatDayDate(day.date);
      const label = isCurrent ? t("progress.today") : dateLabel;
      const macroText = hasLogs
        ? `${pAbbr}${Math.round(day.protein)} ${cAbbr}${Math.round(day.carbs)} ${fAbbr}${Math.round(day.fats)}`
        : t("progress.noLogsShort");
      const metaText = isCurrent ? `${dateLabel} · ${macroText}` : macroText;
      const status = day.date === frozenDate ? "frozen" : hasLogs ? (day.adherent ? "adherent" : "off") : "none";
      return `
      <div class="log-item-icon day-history-status-icon status-${status}" aria-hidden="true">${DAY_STATUS_ICONS[status]}</div>
      <div class="log-item-body">
        <div class="log-item-name">${label}</div>
        <div class="log-item-meta">${metaText}</div>
      </div>
      <div class="day-history-cal">
        <span class="day-history-cal-value">${hasLogs ? Math.round(day.calories).toLocaleString() : "—"}</span>
        ${hasLogs ? `<span class="day-history-cal-target">/ ${Math.round(targetCalories).toLocaleString()} kcal</span>` : ""}
      </div>
    `;
    },
  });
  updateCollapsibleList("day-history-list", "day-history-list-toggle");
}

// Minimum points before a linear-regression trend rate is shown — 2 is
// technically enough for computeLinearTrendRate, but a 2-point "rate" is
// just the same information weight-current-delta above already shows.
// Requiring 3+ is where the smoothing actually starts adding something new.
const WEIGHT_TREND_RATE_MIN_ENTRIES = 3;

function renderWeightCurrentStat(entries) {
  const stat = el("weight-current-stat");
  if (!entries.length) {
    stat.hidden = true;
    return;
  }
  stat.hidden = false;

  const latest = entries[0]; // API returns newest-first
  el("weight-current-value").textContent = `${latest.weight_kg} kg`;

  const deltaEl = el("weight-current-delta");
  if (entries.length < 2) {
    deltaEl.textContent = "";
    deltaEl.className = "weight-current-delta mono";
  } else {
    const delta = Math.round((latest.weight_kg - entries[1].weight_kg) * 10) / 10;
    deltaEl.className = "weight-current-delta mono" + (delta > 0 ? " trend-up" : delta < 0 ? " trend-down" : "");
    deltaEl.textContent = delta === 0 ? t("progress.noChange") : `${delta > 0 ? "+" : ""}${delta} kg ${t("progress.vsLast")}`;
  }

  const rateEl = el("weight-trend-rate");
  if (entries.length < WEIGHT_TREND_RATE_MIN_ENTRIES) {
    rateEl.hidden = true;
    return;
  }
  const rate = computeLinearTrendRate([...entries].reverse(), "weight_kg");
  rateEl.hidden = rate === null;
  if (rate !== null) {
    rateEl.className = "weight-current-delta weight-trend-rate mono" + (rate > 0 ? " trend-up" : rate < 0 ? " trend-down" : "");
    rateEl.textContent = t("progress.weightTrendRate", { rate: `${rate > 0 ? "+" : ""}${rate}` });
  }
}

// A dual-line chart: the faint dotted line is the raw weigh-ins (same data
// drawTrendLine's single line used to show), the solid line is an
// exponential-moving-average smoothing over the same points (see
// nutritionMath.js's computeEMA) — day-to-day water-weight noise averages
// out visually without hiding the actual raw data points underneath it.
function drawWeightTrendChart(svg, chronological) {
  svg.innerHTML = "";
  const height = 140;
  const width = sizeSvgToContainer(svg, height);
  const pad = 10;

  const rawValues = chronological.map((e) => e.weight_kg);
  const smoothedValues = computeEMA(chronological, "weight_kg");
  const minV = Math.min(...rawValues, ...smoothedValues);
  const maxV = Math.max(...rawValues, ...smoothedValues);
  const span = maxV - minV || 1;

  const toPoints = (values) =>
    values.map((v, i) => {
      const x = pad + (chronological.length > 1 ? (i / (chronological.length - 1)) * (width - pad * 2) : 0);
      const y = pad + (1 - (v - minV) / span) * (height - pad * 2);
      return [x, y];
    });
  const pathFor = (points) => points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  const rawPoints = toPoints(rawValues);
  svg.appendChild(svgEl("path", { d: pathFor(rawPoints), class: "chart-line chart-line-raw" }));

  const smoothedPoints = toPoints(smoothedValues);
  svg.appendChild(svgEl("path", { d: pathFor(smoothedPoints), class: "chart-line chart-line-smoothed" }));
  smoothedPoints.forEach(([x, y]) => svg.appendChild(svgEl("circle", { cx: x, cy: y, r: 3, class: "chart-dot" })));
}

function renderWeightSection(entries) {
  renderWeightCurrentStat(entries);
  // Entries arrive newest-first from the API; computeWeightForecast expects
  // chronological (oldest-first), same convention as computeEMA/
  // computeLinearTrendRate above.
  setAiCoachContext({ weightForecast: computeWeightForecast([...entries].reverse()) });

  const svg = el("weight-trend-chart");
  const list = el("weight-list");
  const empty = el("weight-empty");

  if (!entries.length) {
    empty.hidden = false;
    setSvgHidden(svg, true);
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    updateCollapsibleList("weight-list", "weight-list-toggle");
    return;
  }
  empty.hidden = true;

  reconcileList(list, entries, {
    getId: (entry) => entry.id,
    buildHtml: (entry) => {
      const dateStr = new Date(entry.logged_at).toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
      return `
      <div class="log-item-body">
        <div class="log-item-name">${entry.weight_kg} kg</div>
        <div class="log-item-meta">${dateStr}</div>
      </div>
      <div class="log-item-actions">
        <button data-action="delete-weight" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `;
    },
  });
  updateCollapsibleList("weight-list", "weight-list-toggle");

  const legend = el("weight-chart-legend");
  if (entries.length < 2) {
    setSvgHidden(svg, true);
    legend.hidden = true;
    return;
  }
  setSvgHidden(svg, false);
  legend.hidden = false;
  // Entries arrive newest-first from the API; charted oldest-to-newest.
  drawWeightTrendChart(svg, [...entries].reverse());
}

// ---------------------------------------------------------------------------
// Body measurements — a gym-manager upgrade on top of the calorie/water
// tracking above. Unlike weight_logs, the user names each measurement
// themselves (Waist, Left bicep, ...) and picks the day/time it was actually
// taken (see the measurement-sheet form), so there's no single "current
// value" the way weight has one — instead this renders one flat,
// newest-first list across every measurement name, with a dropdown filter
// to narrow it to one name at a time (and, once narrowed to 2+ points for
// that name, a trend line using the same drawTrendLine() as weight above).
// ---------------------------------------------------------------------------
function distinctMeasurementNames(entries) {
  return [...new Set(entries.map((e) => e.name))].sort((a, b) => a.localeCompare(b));
}

// Rebuilds the filter <select>'s options only when the distinct-name set
// actually changed, so an in-progress selection survives a render triggered
// by something else (e.g. adding a new entry for a different measurement).
function syncMeasurementFilterOptions(names) {
  const select = el("measurement-filter");
  const currentOptionNames = [...select.options].slice(1).map((o) => o.value);
  if (currentOptionNames.length === names.length && currentOptionNames.every((n, i) => n === names[i])) return;

  const previouslySelected = select.value;
  select.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = t("measurements.filterAll");
  select.appendChild(allOption);
  names.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
  select.value = names.includes(previouslySelected) ? previouslySelected : "";
}

// The add/edit sheet's name field offers previously-used names via a
// <datalist> — pure convenience (still a free-text field), so a user
// tracking "Waist" every week doesn't have to retype/remember the exact
// spelling each time.
function syncMeasurementNameOptions(names) {
  const datalist = el("measurement-name-options");
  datalist.replaceChildren(
    ...names.map((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      return opt;
    })
  );
}

function renderMeasurementsSection(allEntries) {
  const names = distinctMeasurementNames(allEntries);
  syncMeasurementFilterOptions(names);
  syncMeasurementNameOptions(names);

  const activeFilter = el("measurement-filter").value;
  const entries = activeFilter ? allEntries.filter((e) => e.name === activeFilter) : allEntries;

  const list = el("measurement-list");
  const empty = el("measurement-empty");
  const svg = el("measurement-trend-chart");

  if (!entries.length) {
    empty.hidden = false;
    setSvgHidden(svg, true);
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    updateCollapsibleList("measurement-list", "measurement-list-toggle");
    return;
  }
  empty.hidden = true;

  reconcileList(list, entries, {
    getId: (entry) => entry.id,
    buildHtml: (entry) => {
      const dt = new Date(entry.logged_at);
      const dateStr = dt.toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
      const timeStr = dt.toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" });
      return `
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(entry.name)}</div>
        <div class="log-item-meta">${dateStr}, ${timeStr}</div>
      </div>
      <div class="log-item-cal">${entry.value}${escapeHtml(entry.unit)}</div>
      <div class="log-item-actions">
        <button data-action="edit-measurement" aria-label="${t("common.edit")}"><svg viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <button data-action="delete-measurement" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `;
    },
  });
  updateCollapsibleList("measurement-list", "measurement-list-toggle");

  // A trend line only means something once narrowed to a single measurement
  // name (mixing e.g. "Waist" and "Bicep" values on one line would be
  // meaningless) with at least two points to draw a line between.
  if (activeFilter && entries.length >= 2) {
    setSvgHidden(svg, false);
    drawTrendLine(svg, [...entries].reverse(), "value");
  } else {
    setSvgHidden(svg, true);
  }
}

const pad2 = (n) => String(n).padStart(2, "0");
const dateInputValue = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const timeInputValue = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

function openMeasurementSheet(existing = null) {
  editingMeasurementId = existing?.id || null;
  el("measurement-sheet-title").textContent = existing ? t("measurements.editTitle") : t("measurements.addTitle");
  const when = existing ? new Date(existing.logged_at) : new Date();
  el("measurement-name").value = existing?.name || "";
  el("measurement-value").value = existing?.value ?? "";
  el("measurement-unit").value = existing?.unit || "cm";
  el("measurement-date").value = dateInputValue(when);
  el("measurement-time").value = timeInputValue(when);
  openSheet("measurement-sheet");
}

// ---------------------------------------------------------------------------
// Training log — same "user-named, user-dated, kept indefinitely" pattern as
// body measurements above, just with sets/reps/weight instead of a single
// value. Deliberately no trend chart here (unlike weight/measurements): a
// workout entry has no single plottable number the way a measurement's
// `value` or a weigh-in's `weight_kg` does, and building a meaningful
// per-exercise progression view (e.g. estimated 1RM over time) is a bigger
// feature than this pass — the filterable list is the useful part on its own.
// ---------------------------------------------------------------------------
function distinctExerciseNames(entries) {
  return [...new Set(entries.map((e) => e.exercise_name))].sort((a, b) => a.localeCompare(b));
}

function syncWorkoutFilterOptions(names) {
  const select = el("workout-filter");
  const currentOptionNames = [...select.options].slice(1).map((o) => o.value);
  if (currentOptionNames.length === names.length && currentOptionNames.every((n, i) => n === names[i])) return;

  const previouslySelected = select.value;
  select.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = t("workouts.filterAll");
  select.appendChild(allOption);
  names.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
  select.value = names.includes(previouslySelected) ? previouslySelected : "";
}

function syncWorkoutExerciseOptions(names) {
  const datalist = el("workout-exercise-options");
  datalist.replaceChildren(
    ...names.map((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      return opt;
    }),
  );
}

function renderWorkoutsSection(allEntries) {
  const names = distinctExerciseNames(allEntries);
  syncWorkoutFilterOptions(names);
  syncWorkoutExerciseOptions(names);

  const activeFilter = el("workout-filter").value;
  const entries = activeFilter ? allEntries.filter((e) => e.exercise_name === activeFilter) : allEntries;

  const list = el("workout-list");
  const empty = el("workout-empty");

  if (!entries.length) {
    empty.hidden = false;
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    updateCollapsibleList("workout-list", "workout-list-toggle");
    return;
  }
  empty.hidden = true;

  reconcileList(list, entries, {
    getId: (entry) => entry.id,
    buildHtml: (entry) => {
      const dt = new Date(entry.logged_at);
      const dateStr = dt.toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
      const timeStr = dt.toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" });
      const weightPart = entry.weight_kg > 0 ? ` @ ${entry.weight_kg}kg` : "";
      return `
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(entry.exercise_name)}</div>
        <div class="log-item-meta">${dateStr}, ${timeStr}</div>
      </div>
      <div class="log-item-cal">${entry.sets}×${entry.reps}${weightPart}</div>
      <div class="log-item-actions">
        <button data-action="edit-workout" aria-label="${t("common.edit")}"><svg viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <button data-action="delete-workout" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `;
    },
  });
  updateCollapsibleList("workout-list", "workout-list-toggle");
}

// `prefillExerciseName`/`prefill`: only meaningful when `existing` is null (a
// brand new entry) — fills the form from a suggestions.js workout suggestion
// or a Discover pick without pretending it's an edit of a real logged entry
// (see suggestions.js's onOpenWorkoutSheet callback, wired in initProgress
// below). Exported (in addition to being used internally) so discover.js's
// exercise-library "Add to my log" action and a workout-plan day's per-
// exercise "Log" action can both prefill the same sheet directly — one
// workout-sheet implementation, several callers. `prefill` additionally
// carries `{ sets, reps }` from a workout plan's prescribed scheme (e.g. "4
// sets x 8-10 reps") — still just a starting point the user can change before
// submitting, same as every other prefilled value here.
export function openWorkoutSheet(existing = null, prefillExerciseName = null, prefill = null) {
  editingWorkoutId = existing?.id || null;
  el("workout-sheet-title").textContent = existing ? t("workouts.editTitle") : t("workouts.addTitle");
  const when = existing ? new Date(existing.logged_at) : new Date();
  el("workout-exercise").value = existing?.exercise_name || prefillExerciseName || "";
  el("workout-sets").value = existing?.sets ?? prefill?.sets ?? "";
  el("workout-reps").value = existing?.reps ?? prefill?.reps ?? "";
  el("workout-weight").value = existing?.weight_kg ?? "";
  el("workout-date").value = dateInputValue(when);
  el("workout-time").value = timeInputValue(when);
  openSheet("workout-sheet");
}

// "What's driving your calories" — groups the retention window's food logs
// by name (exact match; this is an at-a-glance breakdown, not a precise
// nutrition audit) and ranks by total calories contributed. `logs` is the
// same full-window list app.js already holds for the dashboard (see
// renderProgress below) — no separate fetch needed for this.
const TOP_FOODS_LIMIT = 5;

function computeTopFoods(logs) {
  const totals = new Map();
  let grandTotal = 0;
  logs.forEach((log) => {
    grandTotal += log.calories;
    const entry = totals.get(log.food_name) || { calories: 0, protein: 0, carbs: 0, fats: 0, count: 0 };
    entry.calories += log.calories;
    entry.protein += log.protein || 0;
    entry.carbs += log.carbs || 0;
    entry.fats += log.fats || 0;
    entry.count += 1;
    totals.set(log.food_name, entry);
  });
  const items = [...totals.entries()]
    .map(([name, e]) => ({
      name,
      calories: e.calories,
      protein: e.protein,
      carbs: e.carbs,
      fats: e.fats,
      count: e.count,
      avgCalories: e.calories / e.count,
      pct: grandTotal > 0 ? (e.calories / grandTotal) * 100 : 0,
    }))
    .sort((a, b) => b.calories - a.calories)
    .slice(0, TOP_FOODS_LIMIT);
  return items;
}

// Each row's macro bar is weighted by *calorie* contribution (protein/carbs
// at 4 kcal/g, fat at 9 kcal/g), not gram counts — so a food that's mostly
// fat still shows a wide fat segment even though its gram number looks small
// next to protein/carbs. This is what actually drives the calorie total the
// row is ranked by, which is the point of this section.
function macroBarSegments(item) {
  const proteinCal = item.protein * 4;
  const carbsCal = item.carbs * 4;
  const fatsCal = item.fats * 9;
  const total = proteinCal + carbsCal + fatsCal;
  if (total <= 0) return { protein: 0, carbs: 0, fats: 0 };
  return {
    protein: (proteinCal / total) * 100,
    carbs: (carbsCal / total) * 100,
    fats: (fatsCal / total) * 100,
  };
}

function renderTopFoods(logs) {
  const list = el("top-foods-list");
  const empty = el("top-foods-empty");
  if (!logs || !logs.length) {
    list.innerHTML = "";
    empty.hidden = false;
    updateCollapsibleList("top-foods-list", "top-foods-list-toggle");
    return;
  }
  empty.hidden = true;
  const items = computeTopFoods(logs);
  // The macro-bar segment widths are a continuous percentage (not one of a
  // handful of fixed values an attribute-selector could cover), so they're
  // set via direct .style assignment on the real elements below, *after*
  // this markup is inserted — never as a `style="width:...%"` string baked
  // into the innerHTML itself. This app's CSP has no 'unsafe-inline' for
  // style-src, which silently drops inline style *attributes* parsed from
  // HTML (a real bug this project shipped with briefly); genuine DOM
  // CSSOM property assignment (element.style.width = ...) is a completely
  // different, unrestricted code path and is the only form used anywhere
  // else in this app (e.g. ui.js's bar-fill/ring-calories widths).
  list.innerHTML = items
    .map((item, i) => {
      const rank = i + 1;
      const macroBarLabel = t("progress.topFoodsMacroBarLabel", {
        protein: Math.round(item.protein),
        carbs: Math.round(item.carbs),
        fats: Math.round(item.fats),
      });
      return `
      <li class="top-food-item">
        <span class="top-food-rank rank-${rank}">${rank}</span>
        <div class="top-food-main">
          <div class="top-food-row">
            <span class="top-food-name">${escapeHtml(item.name)}</span>
            <span class="top-food-value mono">${Math.round(item.calories).toLocaleString()} kcal</span>
          </div>
          <div class="top-food-macro-bar" role="img" aria-label="${escapeHtml(macroBarLabel)}">
            <span class="seg seg-protein"></span>
            <span class="seg seg-carbs"></span>
            <span class="seg seg-fats"></span>
          </div>
          <div class="top-food-meta">
            <span>${t("progress.topFoodsPct", { pct: Math.round(item.pct) })}</span>
            <span class="top-food-meta-dot" aria-hidden="true"></span>
            <span>${t("progress.topFoodsCount", { count: item.count })}</span>
            <span class="top-food-meta-dot" aria-hidden="true"></span>
            <span>${t("progress.topFoodsAvg", { avg: Math.round(item.avgCalories) })}</span>
          </div>
        </div>
      </li>
    `;
    })
    .join("");

  // Index-matched against `items`, in the exact same order they were just
  // rendered above — simpler and safer than round-tripping each name through
  // a data-attribute and a CSS-selector match.
  const rows = list.querySelectorAll(".top-food-item");
  items.forEach((item, i) => {
    const seg = macroBarSegments(item);
    const row = rows[i];
    row.querySelector(".seg-protein").style.width = `${seg.protein}%`;
    row.querySelector(".seg-carbs").style.width = `${seg.carbs}%`;
    row.querySelector(".seg-fats").style.width = `${seg.fats}%`;
  });
  updateCollapsibleList("top-foods-list", "top-foods-list-toggle");
}

// Milestone badges — deliberately built only from data this app can
// actually, honestly compute (no second table, no server-side "earned at"
// tracking — see the module-level stats object in renderFromCache below,
// which is everything this needs). Streak tiers stop at 7 because the streak
// itself is mathematically capped at retention_days (see
// backend/services/trends_service.py) — there's no "30-day streak" possible
// with a 7-day rolling window, so this doesn't pretend otherwise. Weigh-ins,
// measurements, and workouts are entities kept indefinitely (not subject to
// that retention window — see sql/schema.sql), so their counts are real
// lifetime totals, not just "this week".
//
// Each definition is `value(stats) >= target` rather than a boolean check()
// — the numeric value/target pair is what powers the "3/7" progress readout
// in the tappable detail sheet (renderMilestoneDetail below), not just an
// earned/unearned flag.
const MILESTONE_DEFINITIONS = [
  { key: "firstLog", icon: "🌱", value: (s) => s.streak, target: 1 },
  { key: "streak3", icon: "🔥", value: (s) => s.streak, target: 3 },
  { key: "streak7", icon: "🏆", value: (s) => s.streak, target: 7 },
  { key: "firstWeighIn", icon: "⚖️", value: (s) => s.weighInsCount, target: 1 },
  { key: "trackingPro", icon: "📈", value: (s) => s.weighInsCount, target: 20 },
  { key: "weightVeteran", icon: "🎯", value: (s) => s.weighInsCount, target: 50 },
  { key: "bodyTracker", icon: "📏", value: (s) => s.measurementsCount, target: 5 },
  { key: "precisionTracker", icon: "🧭", value: (s) => s.measurementsCount, target: 20 },
  { key: "mealPrepper", icon: "⭐", value: (s) => s.savedMealsCount, target: 5 },
  { key: "mealPrepMaster", icon: "👨‍🍳", value: (s) => s.savedMealsCount, target: 15 },
  { key: "firstWorkout", icon: "🏋️", value: (s) => s.workoutsCount, target: 1 },
  { key: "consistentLifter", icon: "💪", value: (s) => s.workoutsCount, target: 10 },
  { key: "ironVeteran", icon: "🦾", value: (s) => s.workoutsCount, target: 50 },
  // Total training volume (sets x reps x weight) summed across every logged
  // workout entry — a second, complementary way to recognize effort besides
  // raw entry count, fitting for a hypertrophy-tracking app named Iron Log.
  { key: "heavyHitter", icon: "🏔️", value: (s) => Math.round(s.totalVolumeKg), target: 10000 },
  // The only combined milestone: rewards actually using every tracked
  // category together (nutrition streak + weight + measurements + workouts),
  // not just going deep on one. value() counts how many of the 4 are active.
  {
    key: "wellRounded",
    icon: "🌟",
    value: (s) => [s.streak >= 3, s.weighInsCount >= 1, s.measurementsCount >= 1, s.workoutsCount >= 1].filter(Boolean).length,
    target: 4,
  },
  // Rewards exactly the "protein hit, fats still in check" combination
  // coach.js's status.dialedIn message already praises for a single day —
  // this counts how many days in the retained window pulled it off.
  { key: "balancedWeek", icon: "🥗", value: (s) => s.balancedDaysCount, target: 5 },
  // Fiber has no "too much" ceiling (see ui.js's BONUS_OVERAGE_MACROS) — a
  // running streak of fiber-target days is a genuine win worth its own badge.
  { key: "fiberStreak", icon: "🌾", value: (s) => s.fiberStreak, target: 3 },
];

// Tracks which milestones were earned as of the *last* render, so a badge
// that flips false→true gets a one-off "just earned" animation + haptic
// instead of every already-earned badge replaying it on every re-render (or,
// worse, on every fresh page load — see the initialized guard below, which
// exists specifically so the very first render of a session only seeds this
// set silently instead of "congratulating" the user for milestones they
// earned days ago).
let previousEarnedKeys = null;

function renderMilestones(stats) {
  const earnedKeys = new Set(MILESTONE_DEFINITIONS.filter((m) => m.value(stats) >= m.target).map((m) => m.key));
  const justEarnedKeys = previousEarnedKeys
    ? new Set([...earnedKeys].filter((key) => !previousEarnedKeys.has(key)))
    : new Set();

  el("milestones-list").innerHTML = MILESTONE_DEFINITIONS.map((m) => {
    const earned = earnedKeys.has(m.key);
    const justEarned = justEarnedKeys.has(m.key);
    return `
      <li class="milestone-badge${earned ? " earned" : ""}${justEarned ? " just-earned" : ""}" data-key="${m.key}" role="button" tabindex="0" aria-label="${t(`milestones.${m.key}`)}">
        <span class="milestone-badge-icon" aria-hidden="true">${m.icon}</span>
        <span>${t(`milestones.${m.key}`)}</span>
      </li>
    `;
  }).join("");

  if (justEarnedKeys.size > 0) vibrate(20);
  previousEarnedKeys = earnedKeys;
  updateCollapsibleList("milestones-list", "milestones-list-toggle");
}

// Populates and opens the tappable detail sheet for one milestone — the
// "click on them and see the info" surface (title, description, and a
// progress readout capped at the target so an over-achieved count like
// "63/50" still just reads "50/50", the earned state already says the rest).
function renderMilestoneDetail(key, stats) {
  const m = MILESTONE_DEFINITIONS.find((def) => def.key === key);
  if (!m) return;
  const value = m.value(stats);
  const earned = value >= m.target;
  el("milestone-detail-icon").textContent = m.icon;
  el("milestone-detail-icon").classList.toggle("earned", earned);
  el("milestone-detail-title").textContent = t(`milestones.${m.key}`);
  el("milestone-detail-desc").textContent = t(`milestones.${m.key}Desc`);
  el("milestone-detail-status").textContent = earned ? t("milestones.earned") : t("milestones.notYetEarned");
  el("milestone-detail-status").classList.toggle("earned", earned);
  const capped = Math.min(value, m.target);
  el("milestone-detail-progress-label").textContent = `${capped.toLocaleString()} / ${m.target.toLocaleString()}`;
  el("milestone-detail-progress-fill").style.transform = `scaleX(${capped / m.target})`;
  openSheet("milestone-detail-sheet");
}

function renderFromCache() {
  if (!lastTrends) return;
  // First real paint (from cache or from a fresh fetch) — drop the skeleton
  // shown until now (a brief fade, not an instant cut — see fadeOutSkeleton's
  // own comment in ui.js). Idempotent (safe to call again on every later
  // call), mirrors app.js's render()/#dashboard-skeleton.
  fadeOutSkeleton("progress-skeleton");
  const targetCalories = currentTargets?.daily_calories || 2000;
  const { streak, freezeAppliedDate, freezeReady } = computeStreakWithFreeze(lastTrends.days);
  renderStreak(streak);
  renderStreakFreezeBadge(freezeAppliedDate, freezeReady);
  renderWaterStreak(computeConsecutiveStreak(lastTrends.days, "water_ml", currentTargets?.daily_water_ml));
  renderCalorieChart(lastTrends.days, targetCalories);
  renderMacroConsistency(lastTrends.days, currentTargets, lastLogs);
  renderDayHistory(lastTrends.days, targetCalories, freezeAppliedDate);
  el("progress-retention-note").textContent = t("progress.retentionNote", { days: lastTrends.days.length });
  if (lastWeights) renderWeightSection(lastWeights);
  if (lastMeasurements) renderMeasurementsSection(lastMeasurements);
  if (lastWorkouts) renderWorkoutsSection(lastWorkouts);
  if (lastLogs) renderTopFoods(lastLogs);
  lastMilestoneStats = {
    streak,
    weighInsCount: lastWeights?.length || 0,
    measurementsCount: lastMeasurements?.length || 0,
    savedMealsCount: lastSavedMeals?.length || 0,
    workoutsCount: lastWorkouts?.length || 0,
    totalVolumeKg: (lastWorkouts || []).reduce((sum, w) => sum + (w.sets || 0) * (w.reps || 0) * (w.weight_kg || 0), 0),
    balancedDaysCount: countBalancedDays(lastTrends.days, currentTargets),
    fiberStreak: computeConsecutiveStreak(alignDailyFiberTotals(lastTrends.days, lastLogs), "fiber", currentTargets?.daily_fiber, FIBER_TOLERANCE),
  };
  renderMilestones(lastMilestoneStats);
  el("consistency-score-stat").textContent = t("progress.consistencyScore", {
    score: computeConsistencyScore(lastTrends.days, streak),
  });
  renderTargetReviewBanner(lastTrends.days, targetCalories);
  renderSuggestions({
    remaining: computeRemainingMacros(lastTrends.days, currentTargets),
    savedMeals: lastSavedMeals || [],
    workouts: lastWorkouts || [],
  });
}

// Today's remaining calorie/protein/carb/fat budget, fed to suggestions.js's
// food-ranking algorithm. `days`'s last entry is always today (see
// backend/services/trends_service.py) — the same convention renderCalorieChart's
// todayIndex already relies on above.
function computeRemainingMacros(days, targets) {
  const today = days[days.length - 1] || { calories: 0, protein: 0, carbs: 0, fats: 0 };
  return {
    calories: (targets?.daily_calories || 0) - today.calories,
    protein: (targets?.daily_protein || 0) - today.protein,
    carbs: (targets?.daily_carbs || 0) - today.carbs,
    fats: (targets?.daily_fats || 0) - today.fats,
    proteinTarget: targets?.daily_protein || 0,
  };
}

// `logs`/`savedMeals` (optional): the dashboard's own already-fetched state
// (app.js's state.logs / state.savedMeals) — passed through here instead of
// this module doing its own redundant GET requests, since app.js already has
// exactly what "what's driving your calories" and the milestone badges need.
// `silent` (used by app.js's loadAll(), which now warms this tab's data at
// app boot instead of waiting for the user to actually open it — see that
// call site's own comment): suppresses the error toast on a totally-cold
// failure. A failure surfaced for a tab the user hasn't even looked at yet
// would read as a confusing, out-of-context error at the exact moment the
// app finishes loading; the normal tap/swipe-triggered call into this tab
// still shows it normally.
export async function renderProgress(targets, logs, savedMeals, { silent = false } = {}) {
  if (targets) currentTargets = targets;
  if (logs) lastLogs = logs;
  if (savedMeals) lastSavedMeals = savedMeals;

  // Cache-first: repaint immediately from whatever a previous visit already
  // fetched (a harmless no-op via renderFromCache's own `if (!lastTrends)
  // return` guard on the very first-ever visit, before any of the last*
  // caches exist). Every earlier version of this function awaited all 4
  // network calls below before writing a single DOM node, which meant
  // switchView's view-transition swap always revealed an empty shell that
  // then visibly popped in real content a beat later once the network
  // resolved — exactly the "jump after the nav animation finishes" this was
  // built to stop. #progress-skeleton (index.html) covers the equivalent
  // gap on that first-ever visit instead, the same way #dashboard-skeleton
  // already does for the Dashboard tab.
  const hadCache = !!lastTrends;
  renderFromCache();

  try {
    const [trends, weights, measurements, workouts] = await Promise.all([
      api.getTrends(),
      api.listWeight(),
      api.listMeasurements(),
      api.listWorkouts(),
    ]);
    lastTrends = trends;
    lastWeights = weights;
    lastMeasurements = measurements;
    lastWorkouts = workouts;
    // Deferred (not called directly) — this fetch is started the instant
    // app.js's initTabSwipe knows a drag is heading toward this tab, so it
    // can resolve at any point during a slow drag, including while the view
    // is still being live-dragged around the screen (position: absolute +
    // a per-frame transform). Rewriting its DOM at that exact moment would
    // be a visible flicker mid-gesture and would invalidate the height
    // already pinned for the drag. runOrDeferDuringSwipe (ui.js) queues
    // this to run the instant the drag settles instead, or right away if
    // there's no drag in progress at all (the normal tap-to-switch path).
    runOrDeferDuringSwipe(renderFromCache);
  } catch (err) {
    // A cache hit already means the user is looking at the last-known-good
    // data; a background refresh that fails silently (e.g. a flaky
    // connection) shouldn't interrupt that with an error toast over content
    // that's still perfectly valid. Only surface the error when there was
    // nothing to fall back to, and never for a silent boot-time warm-up.
    if (!hadCache && !silent) showToast(err.message || t("toast.someDataFailed"), "error");
  }
}

// `onLogSuggestedMeal(meal)`: app.js owns the optimistic saved-meal logger
// (logSavedMealOptimistic) — this module only looks the meal up by id from
// its own lastSavedMeals cache and hands the object off, same dependency-
// injection pattern as onDayClick above and initScan's logNewFood in app.js.
export function initProgress({ onDayClick, onLogSuggestedMeal } = {}) {
  initSuggestions({
    onLogFood: (mealId) => {
      const meal = (lastSavedMeals || []).find((m) => m.id === mealId);
      if (meal) onLogSuggestedMeal?.(meal);
    },
    onOpenWorkoutSheet: (exerciseName) => openWorkoutSheet(null, exerciseName),
  });

  initCollapsibleListToggles([
    ["milestones-list", "milestones-list-toggle"],
    ["top-foods-list", "top-foods-list-toggle"],
    ["day-history-list", "day-history-list-toggle"],
    ["weight-list", "weight-list-toggle"],
    ["measurement-list", "measurement-list-toggle"],
    ["workout-list", "workout-list-toggle"],
  ]);

  el("target-review-dismiss-btn").addEventListener("click", () => {
    const key = el("target-review-banner").dataset.dismissKey;
    if (key) localStorage.setItem(key, "1");
    el("target-review-banner").hidden = true;
  });
  // Reuses the existing Settings-open flow verbatim (same button a manual
  // tap on the header gear would trigger) rather than duplicating its
  // "targets not loaded yet" retry logic here.
  el("target-review-open-btn").addEventListener("click", () => {
    const key = el("target-review-banner").dataset.dismissKey;
    if (key) localStorage.setItem(key, "1");
    el("target-review-banner").hidden = true;
    el("settings-btn").click();
  });

  el("day-history-list").addEventListener("click", (e) => {
    const item = e.target.closest(".day-history-item");
    if (!item || !onDayClick) return;
    const day = (lastTrends?.days || []).find((d) => String(d.date) === item.dataset.id);
    if (day) onDayClick(day);
  });

  // Tap (or keyboard-activate, since badges are role="button") any milestone
  // to see its title/description/progress — works for both earned and
  // not-yet-earned badges, mobile and desktop alike.
  const openMilestoneFromEvent = (e) => {
    const badge = e.target.closest(".milestone-badge");
    if (!badge || !lastMilestoneStats) return;
    renderMilestoneDetail(badge.dataset.key, lastMilestoneStats);
  };
  el("milestones-list").addEventListener("click", openMilestoneFromEvent);
  el("milestones-list").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openMilestoneFromEvent(e);
  });

  el("weight-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = el("weight-input");
    const weightKg = Number(input.value);
    if (!weightKg || weightKg <= 0) return;

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await api.addWeight(weightKg);
      input.value = "";
      showToast(t("toast.weightLogged"), "success");
      await renderProgress();
    } catch (err) {
      showToast(err.message || t("toast.couldNotLogWeight"), "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  el("weight-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action='delete-weight']");
    if (!btn) return;
    const id = btn.closest(".log-item").dataset.id;
    const previousWeights = lastWeights;
    if (!previousWeights) return;
    deleteWithUndo({
      removeNow: () => {
        lastWeights = previousWeights.filter((w) => w.id !== id);
        renderWeightSection(lastWeights);
      },
      restore: () => {
        lastWeights = previousWeights;
        renderWeightSection(lastWeights);
      },
      callDelete: () => api.deleteWeight(id),
      removedToastKey: "toast.removed",
      revertToastKey: "toast.couldNotDeleteEntryRestored",
    });
  });

  el("new-measurement-btn").addEventListener("click", () => openMeasurementSheet());

  el("measurement-filter").addEventListener("change", renderFromCache);

  el("measurement-list").addEventListener("click", (e) => {
    const editBtn = e.target.closest("button[data-action='edit-measurement']");
    const deleteBtn = e.target.closest("button[data-action='delete-measurement']");
    if (editBtn) {
      const id = editBtn.closest(".log-item").dataset.id;
      const entry = (lastMeasurements || []).find((m) => m.id === id);
      if (entry) openMeasurementSheet(entry);
      return;
    }
    if (deleteBtn) {
      const id = deleteBtn.closest(".log-item").dataset.id;
      const previousMeasurements = lastMeasurements;
      if (!previousMeasurements) return;
      deleteWithUndo({
        removeNow: () => {
          lastMeasurements = previousMeasurements.filter((m) => m.id !== id);
          renderMeasurementsSection(lastMeasurements);
        },
        restore: () => {
          lastMeasurements = previousMeasurements;
          renderMeasurementsSection(lastMeasurements);
        },
        callDelete: () => api.deleteMeasurement(id),
        removedToastKey: "toast.removed",
        revertToastKey: "toast.couldNotDeleteEntryRestored",
      });
    }
  });

  el("measurement-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el("measurement-name").value.trim();
    const value = Number(el("measurement-value").value);
    const unit = el("measurement-unit").value.trim() || "cm";
    const dateVal = el("measurement-date").value;
    const timeVal = el("measurement-time").value;
    if (!name || !(value > 0) || !dateVal || !timeVal) return;

    const payload = { name, value, unit, logged_at: new Date(`${dateVal}T${timeVal}`).toISOString() };
    const submitBtn = el("measurement-submit-btn");
    submitBtn.disabled = true;
    try {
      if (editingMeasurementId) {
        await api.updateMeasurement(editingMeasurementId, payload);
        showToast(t("toast.updated"), "success");
      } else {
        await api.addMeasurement(payload);
        showToast(t("toast.measurementLogged"), "success");
      }
      closeSheet("measurement-sheet");
      await renderProgress();
    } catch (err) {
      showToast(err.message || t("toast.couldNotLogMeasurement"), "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  el("new-workout-btn").addEventListener("click", () => openWorkoutSheet());

  el("workout-filter").addEventListener("change", renderFromCache);

  el("workout-list").addEventListener("click", (e) => {
    const editBtn = e.target.closest("button[data-action='edit-workout']");
    const deleteBtn = e.target.closest("button[data-action='delete-workout']");
    if (editBtn) {
      const id = editBtn.closest(".log-item").dataset.id;
      const entry = (lastWorkouts || []).find((w) => w.id === id);
      if (entry) openWorkoutSheet(entry);
      return;
    }
    if (deleteBtn) {
      const id = deleteBtn.closest(".log-item").dataset.id;
      const previousWorkouts = lastWorkouts;
      if (!previousWorkouts) return;
      deleteWithUndo({
        removeNow: () => {
          lastWorkouts = previousWorkouts.filter((w) => w.id !== id);
          renderWorkoutsSection(lastWorkouts);
        },
        restore: () => {
          lastWorkouts = previousWorkouts;
          renderWorkoutsSection(lastWorkouts);
        },
        callDelete: () => api.deleteWorkout(id),
        removedToastKey: "toast.removed",
        revertToastKey: "toast.couldNotDeleteEntryRestored",
      });
    }
  });

  el("workout-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const exerciseName = el("workout-exercise").value.trim();
    const sets = Number(el("workout-sets").value);
    const reps = Number(el("workout-reps").value);
    const weightKg = el("workout-weight").value === "" ? 0 : Number(el("workout-weight").value);
    const dateVal = el("workout-date").value;
    const timeVal = el("workout-time").value;
    if (!exerciseName || !(sets > 0) || !(reps > 0) || !dateVal || !timeVal) return;

    const payload = {
      exercise_name: exerciseName,
      sets,
      reps,
      weight_kg: weightKg,
      logged_at: new Date(`${dateVal}T${timeVal}`).toISOString(),
    };
    const submitBtn = el("workout-submit-btn");
    submitBtn.disabled = true;
    try {
      if (editingWorkoutId) {
        await api.updateWorkout(editingWorkoutId, payload);
        showToast(t("toast.updated"), "success");
      } else {
        await api.addWorkout(payload);
        showToast(t("toast.workoutLogged"), "success");
      }
      closeSheet("workout-sheet");
      await renderProgress();
    } catch (err) {
      showToast(err.message || t("toast.couldNotLogWorkout"), "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  onLanguageChange(renderFromCache);
}
