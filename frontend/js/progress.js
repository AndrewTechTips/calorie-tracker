import { api } from "./api.js?v=20260725l";
import { reconcileList, showToast } from "./ui.js?v=20260725l";
import { getLocale, onLanguageChange, t } from "./i18n.js?v=20260725l";

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
    // Labeled by logical day number, not calendar weekday — two bars can
    // share the same real-world date (End Day pressed twice same day), so a
    // weekday letter would be ambiguous or duplicated. day_number is always
    // unique and always present, even for a not-yet-logged day.
    label.textContent = String(day.day_number);
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

// A readable, per-day list alongside the bar chart above — "Day 5 you had
// 2,140 kcal" is easier to scan than reading it off a bar's height. Reuses
// the trends data already fetched for the chart (no extra network call) and
// renders newest-first. Keyed by day.day_number (the logical day, not the
// calendar date — two rows can share a date if "End day" was pressed twice
// in one real day) and reconciled in place (see reconcileList in ui.js)
// rather than rebuilt from scratch on every tab switch, so reopening
// Progress doesn't replay every row's entrance animation each time.
function renderDayHistory(days, targetCalories) {
  const list = el("day-history-list");
  const pAbbr = t("dashboard.macroAbbrProtein");
  const cAbbr = t("dashboard.macroAbbrCarbs");
  const fAbbr = t("dashboard.macroAbbrFats");
  const reversedDays = [...days].reverse();

  reconcileList(list, reversedDays, {
    getId: (day) => day.day_number,
    extraClass: (day) => {
      const hasLogs = day.calories > 0 || day.protein > 0 || day.carbs > 0 || day.fats > 0;
      const statusClass = hasLogs ? (day.adherent ? "status-adherent" : "status-off") : "";
      return ["day-history-item", statusClass, day === reversedDays[0] ? "today" : ""].filter(Boolean).join(" ");
    },
    buildHtml: (day) => {
      const hasLogs = day.calories > 0 || day.protein > 0 || day.carbs > 0 || day.fats > 0;
      const isCurrent = day === reversedDays[0];
      const label = isCurrent ? t("progress.today") : t("dashboard.dayLabel", { n: day.day_number });
      const dateLabel = formatDayDate(day.date);
      const macroText = hasLogs
        ? `${pAbbr}${Math.round(day.protein)} ${cAbbr}${Math.round(day.carbs)} ${fAbbr}${Math.round(day.fats)}`
        : t("progress.noLogsShort");
      return `
      <div class="log-item-icon day-history-dot-wrap"><span class="day-history-dot"></span></div>
      <div class="log-item-body">
        <div class="log-item-name">${label}</div>
        <div class="log-item-meta">${dateLabel ? `${dateLabel} · ${macroText}` : macroText}</div>
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
  svg.innerHTML = "";

  // Entries arrive newest-first from the API; charted oldest-to-newest.
  const chronological = [...entries].reverse();
  const height = 140;
  const width = sizeSvgToContainer(svg, height);
  const pad = 10;
  const values = chronological.map((e) => e.weight_kg);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const span = maxV - minV || 1;

  const points = chronological.map((entry, i) => {
    const x = pad + (chronological.length > 1 ? (i / (chronological.length - 1)) * (width - pad * 2) : 0);
    const y = pad + (1 - (entry.weight_kg - minV) / span) * (height - pad * 2);
    return [x, y];
  });

  const pathData = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  svg.appendChild(svgEl("path", { d: pathData, class: "chart-line" }));
  points.forEach(([x, y]) => svg.appendChild(svgEl("circle", { cx: x, cy: y, r: 3, class: "chart-dot" })));
}

function renderFromCache() {
  if (!lastTrends) return;
  const targetCalories = currentTargets?.daily_calories || 2000;
  renderStreak(lastTrends.streak);
  renderCalorieChart(lastTrends.days, targetCalories);
  renderDayHistory(lastTrends.days, targetCalories);
  el("progress-retention-note").textContent = t("progress.retentionNote", { days: lastTrends.days.length });
  if (lastWeights) renderWeightSection(lastWeights);
}

export async function renderProgress(targets) {
  if (targets) currentTargets = targets;
  try {
    const [trends, weights] = await Promise.all([api.getTrends(), api.listWeight()]);
    lastTrends = trends;
    lastWeights = weights;
    renderFromCache();
  } catch (err) {
    showToast(err.message || t("toast.someDataFailed"), "error");
  }
}

export function initProgress() {
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

  el("weight-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action='delete-weight']");
    if (!btn) return;
    const id = btn.closest(".log-item").dataset.id;
    try {
      await api.deleteWeight(id);
      showToast(t("toast.removed"), "success");
      await renderProgress();
    } catch (err) {
      showToast(err.message || t("toast.couldNotDeleteEntryRestored"), "error");
    }
  });

  onLanguageChange(renderFromCache);
}
