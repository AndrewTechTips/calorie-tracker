import { api } from "./api.js?v=20260729d";
import { closeSheet, deleteWithUndo, escapeHtml, openSheet, reconcileList, showToast } from "./ui.js?v=20260729d";
import { getLocale, onLanguageChange, t } from "./i18n.js?v=20260729d";

const el = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

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

// A readable, per-day list alongside the bar chart above — "Jul 22 you had
// 2,140 kcal" is easier to scan than reading it off a bar's height. Reuses
// the trends data already fetched for the chart (no extra network call) and
// renders newest-first. Keyed by day.date — a real calendar date, unique by
// construction (see backend/services/trends_service.py) — and reconciled in
// place (see reconcileList in ui.js) rather than rebuilt from scratch on
// every tab switch, so reopening Progress doesn't replay every row's
// entrance animation each time. Tapping a row opens that day's individual
// entries (see onDayClick, initProgress below) — the "edit a past day" flow.
function renderDayHistory(days, targetCalories) {
  const list = el("day-history-list");
  const pAbbr = t("dashboard.macroAbbrProtein");
  const cAbbr = t("dashboard.macroAbbrCarbs");
  const fAbbr = t("dashboard.macroAbbrFats");
  const reversedDays = [...days].reverse();

  reconcileList(list, reversedDays, {
    getId: (day) => day.date,
    extraClass: (day) => {
      const hasLogs = day.calories > 0 || day.protein > 0 || day.carbs > 0 || day.fats > 0;
      const statusClass = hasLogs ? (day.adherent ? "status-adherent" : "status-off") : "";
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
      return `
      <div class="log-item-icon day-history-dot-wrap"><span class="day-history-dot"></span></div>
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
}

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
    return;
  }
  const delta = Math.round((latest.weight_kg - entries[1].weight_kg) * 10) / 10;
  deltaEl.className = "weight-current-delta mono" + (delta > 0 ? " trend-up" : delta < 0 ? " trend-down" : "");
  deltaEl.textContent = delta === 0 ? t("progress.noChange") : `${delta > 0 ? "+" : ""}${delta} kg ${t("progress.vsLast")}`;
}

function renderWeightSection(entries) {
  renderWeightCurrentStat(entries);

  const svg = el("weight-trend-chart");
  const list = el("weight-list");
  const empty = el("weight-empty");

  if (!entries.length) {
    empty.hidden = false;
    svg.hidden = true;
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
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

  if (entries.length < 2) {
    svg.hidden = true;
    return;
  }
  svg.hidden = false;
  // Entries arrive newest-first from the API; charted oldest-to-newest.
  drawTrendLine(svg, [...entries].reverse(), "weight_kg");
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
    svg.hidden = true;
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
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

  // A trend line only means something once narrowed to a single measurement
  // name (mixing e.g. "Waist" and "Bicep" values on one line would be
  // meaningless) with at least two points to draw a line between.
  if (activeFilter && entries.length >= 2) {
    svg.hidden = false;
    drawTrendLine(svg, [...entries].reverse(), "value");
  } else {
    svg.hidden = true;
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
}

function openWorkoutSheet(existing = null) {
  editingWorkoutId = existing?.id || null;
  el("workout-sheet-title").textContent = existing ? t("workouts.editTitle") : t("workouts.addTitle");
  const when = existing ? new Date(existing.logged_at) : new Date();
  el("workout-exercise").value = existing?.exercise_name || "";
  el("workout-sets").value = existing?.sets ?? "";
  el("workout-reps").value = existing?.reps ?? "";
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
    totals.set(log.food_name, (totals.get(log.food_name) || 0) + log.calories);
  });
  const items = [...totals.entries()]
    .map(([name, calories]) => ({ name, calories, pct: grandTotal > 0 ? (calories / grandTotal) * 100 : 0 }))
    .sort((a, b) => b.calories - a.calories)
    .slice(0, TOP_FOODS_LIMIT);
  return items;
}

function renderTopFoods(logs) {
  const list = el("top-foods-list");
  const empty = el("top-foods-empty");
  if (!logs || !logs.length) {
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const items = computeTopFoods(logs);
  list.innerHTML = items
    .map(
      (item) => `
      <li class="top-food-item">
        <div class="top-food-row">
          <span class="top-food-name">${escapeHtml(item.name)}</span>
          <span class="top-food-value mono">${Math.round(item.calories).toLocaleString()} kcal · ${Math.round(item.pct)}%</span>
        </div>
        <div class="top-food-bar-track"><div class="top-food-bar-fill" style="width:${Math.round(item.pct)}%"></div></div>
      </li>
    `,
    )
    .join("");
}

// Milestone badges — deliberately built only from data this app can
// actually, honestly compute. Streak tiers stop at 7 because the streak
// itself is mathematically capped at retention_days (see
// backend/services/trends_service.py) — there's no "30-day streak" possible
// with a 7-day rolling window, so this doesn't pretend otherwise. Weigh-ins
// and measurements are the two entities kept indefinitely (not subject to
// that retention window — see sql/schema.sql), so their counts are real
// lifetime totals, not just "this week".
const MILESTONE_DEFINITIONS = [
  { key: "streak3", icon: "🔥", check: (s) => s.streak >= 3 },
  { key: "streak7", icon: "🏆", check: (s) => s.streak >= 7 },
  { key: "firstWeighIn", icon: "⚖️", check: (s) => s.weighInsCount >= 1 },
  { key: "trackingPro", icon: "📈", check: (s) => s.weighInsCount >= 20 },
  { key: "bodyTracker", icon: "📏", check: (s) => s.measurementsCount >= 5 },
  { key: "mealPrepper", icon: "⭐", check: (s) => s.savedMealsCount >= 5 },
  { key: "firstWorkout", icon: "🏋️", check: (s) => s.workoutsCount >= 1 },
  { key: "consistentLifter", icon: "💪", check: (s) => s.workoutsCount >= 10 },
];

function renderMilestones(stats) {
  el("milestones-list").innerHTML = MILESTONE_DEFINITIONS.map((m) => {
    const earned = m.check(stats);
    return `
      <li class="milestone-badge${earned ? " earned" : ""}">
        <span class="milestone-badge-icon" aria-hidden="true">${m.icon}</span>
        <span>${t(`milestones.${m.key}`)}</span>
      </li>
    `;
  }).join("");
}

function renderFromCache() {
  if (!lastTrends) return;
  const targetCalories = currentTargets?.daily_calories || 2000;
  renderStreak(lastTrends.streak);
  renderCalorieChart(lastTrends.days, targetCalories);
  renderDayHistory(lastTrends.days, targetCalories);
  el("progress-retention-note").textContent = t("progress.retentionNote", { days: lastTrends.days.length });
  if (lastWeights) renderWeightSection(lastWeights);
  if (lastMeasurements) renderMeasurementsSection(lastMeasurements);
  if (lastWorkouts) renderWorkoutsSection(lastWorkouts);
  if (lastLogs) renderTopFoods(lastLogs);
  renderMilestones({
    streak: lastTrends.streak,
    weighInsCount: lastWeights?.length || 0,
    measurementsCount: lastMeasurements?.length || 0,
    savedMealsCount: lastSavedMeals?.length || 0,
    workoutsCount: lastWorkouts?.length || 0,
  });
}

// `logs`/`savedMeals` (optional): the dashboard's own already-fetched state
// (app.js's state.logs / state.savedMeals) — passed through here instead of
// this module doing its own redundant GET requests, since app.js already has
// exactly what "what's driving your calories" and the milestone badges need.
export async function renderProgress(targets, logs, savedMeals) {
  if (targets) currentTargets = targets;
  if (logs) lastLogs = logs;
  if (savedMeals) lastSavedMeals = savedMeals;
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
    renderFromCache();
  } catch (err) {
    showToast(err.message || t("toast.someDataFailed"), "error");
  }
}

export function initProgress({ onDayClick } = {}) {
  el("day-history-list").addEventListener("click", (e) => {
    const item = e.target.closest(".day-history-item");
    if (!item || !onDayClick) return;
    const day = (lastTrends?.days || []).find((d) => String(d.date) === item.dataset.id);
    if (day) onDayClick(day);
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
