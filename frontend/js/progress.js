import { api } from "./api.js?v=20260723h";
import { showToast } from "./ui.js?v=20260723h";
import { getLocale, onLanguageChange, t } from "./i18n.js?v=20260723h";

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

// A small inline-SVG bar chart — deliberately not a charting library/CDN
// dependency, to keep the app's strict CSP untouched (see index.html).
function renderCalorieChart(days, targetCalories) {
  const svg = el("calorie-trend-chart");
  svg.innerHTML = "";

  const height = 152;
  const width = sizeSvgToContainer(svg, height);
  const topPad = 14;
  const bottomPad = 20;
  const chartHeight = height - topPad - bottomPad;
  const gap = 6;
  const barWidth = (width - gap * (days.length + 1)) / days.length;
  const maxVal = Math.max(targetCalories * 1.15, ...days.map((d) => d.calories), 1);

  // A faint full-height track behind every day, so a day with nothing logged
  // still reads as "a day", not an empty gap in the chart.
  days.forEach((day, i) => {
    const x = gap + i * (barWidth + gap);
    svg.appendChild(svgEl("rect", { x, y: topPad, width: barWidth, height: chartHeight, rx: 3, class: "chart-bar-bg" }));
  });

  const targetY = topPad + chartHeight * (1 - Math.min(targetCalories / maxVal, 1));
  svg.appendChild(svgEl("line", { x1: 0, x2: width, y1: targetY, y2: targetY, class: "chart-target" }));
  const targetLabel = svgEl("text", {
    x: width - 2,
    y: Math.max(targetY - 4, 9),
    "text-anchor": "end",
    class: "chart-target-label",
  });
  targetLabel.textContent = Math.round(targetCalories).toLocaleString();
  svg.appendChild(targetLabel);

  const todayIndex = days.length - 1;
  days.forEach((day, i) => {
    const barHeight = day.calories > 0 ? Math.max((day.calories / maxVal) * chartHeight, 3) : 0;
    const x = gap + i * (barWidth + gap);
    const y = topPad + chartHeight - barHeight;
    const over = day.calories > targetCalories;
    if (barHeight > 0) {
      svg.appendChild(
        svgEl("rect", { x, y, width: barWidth, height: barHeight, rx: 3, class: over ? "chart-bar over" : "chart-bar" })
      );
    }

    const label = svgEl("text", {
      x: x + barWidth / 2,
      y: height - 5,
      "text-anchor": "middle",
      class: i === todayIndex ? "chart-label today" : "chart-label",
    });
    label.textContent = new Date(`${day.date}T00:00:00`).toLocaleDateString(getLocale(), { weekday: "narrow" });
    svg.appendChild(label);
  });

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
  list.querySelectorAll(".log-item").forEach((n) => n.remove());

  if (!entries.length) {
    empty.hidden = false;
    svg.hidden = true;
    return;
  }
  empty.hidden = true;

  entries.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "log-item";
    li.dataset.id = entry.id;
    const dateStr = new Date(entry.logged_at).toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
    li.innerHTML = `
      <div class="log-item-body">
        <div class="log-item-name">${entry.weight_kg} kg</div>
        <div class="log-item-meta">${dateStr}</div>
      </div>
      <div class="log-item-actions">
        <button data-action="delete-weight" aria-label="${t("common.delete")}"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
    `;
    list.appendChild(li);
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
  renderStreak(lastTrends.streak);
  renderCalorieChart(lastTrends.days, currentTargets?.daily_calories || 2000);
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
