// "Your week" — the Spotify-Wrapped-style Weekly Recap sheet.
//
// The recap used to be an AI-written paragraph shown as an Ollie chat
// bubble. It's now a designed sheet powered by a deterministic backend
// insights engine (backend/services/recap_service.py): a hero stat, a 7-day
// calorie sparkline, an optional 1-2 sentence AI *caption* (the only
// AI-written part, and the sheet works fine without it), the top 1-2 ranked
// insights, and a strip of metric cards with comparisons.
//
// Opened from the recap chip inside the AI Coach sheet (js/coachChat.js).
// This module owns the fetch + all rendering; every insight/metric string is
// localized here from i18n.js (recap.*) off the backend's stable
// kind/variant + numeric data — the backend never sends user-facing prose.
import { api } from "./api.js";
import { getLocale, onLanguageChange, t } from "./i18n.js";
import { openSheet, closeSheet } from "./ui.js";

const el = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

// The most recent successfully-fetched recap, kept so an in-sheet language
// switch re-renders from data instead of re-hitting the network.
let lastRecap = null;
let fetchToken = 0;

const fmt = (n) => Number(n || 0).toLocaleString(getLocale());
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n));

function fmtDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
}

// Insight `data` numbers formatted for display (thousands separators,
// locale-correct decimals) before going through t()'s {{var}} substitution.
function insightVars(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) out[k] = typeof v === "number" ? fmt(v) : v;
  return out;
}

// -------------------------------------------------------------------------
// Section builders
// -------------------------------------------------------------------------
function makeSection(className) {
  const div = document.createElement("div");
  div.className = `recap-section ${className}`;
  return div;
}

function renderEyebrow(recap) {
  const wrap = makeSection("recap-eyebrow-row");
  const eyebrow = document.createElement("span");
  eyebrow.className = "recap-eyebrow";
  eyebrow.textContent = t("recap.eyebrow");
  const range = document.createElement("span");
  range.className = "recap-daterange";
  range.textContent = `${fmtDate(recap.week_start)} – ${fmtDate(recap.week_end)}`;
  wrap.append(eyebrow, range);
  return wrap;
}

function renderHero(recap) {
  const { headline } = recap.metrics;
  const hero = makeSection("recap-hero");
  const value = document.createElement("div");
  value.className = "recap-hero-value";
  const label = document.createElement("div");
  label.className = "recap-hero-label";

  if (headline.kind === "streak") {
    value.textContent = fmt(headline.value);
    label.textContent = t("recap.hero.streakLabel");
  } else if (headline.kind === "onTarget") {
    const big = document.createElement("span");
    big.textContent = fmt(headline.value);
    const small = document.createElement("span");
    small.className = "recap-hero-of";
    small.textContent = `/${fmt(headline.of)}`;
    value.append(big, small);
    label.textContent = t("recap.hero.onTargetLabel");
  } else {
    value.textContent = fmt(headline.value);
    label.textContent = t("recap.hero.quietLabel");
  }

  hero.append(value, label);
  if (headline.kind === "quiet") {
    const sub = document.createElement("p");
    sub.className = "recap-hero-sub";
    sub.textContent = t("recap.hero.quietSub");
    hero.append(sub);
  }
  return hero;
}

function renderSpark(recap) {
  const { spark } = recap.metrics;
  const target = recap.metrics.target_calories;
  const section = makeSection("recap-spark-wrap");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "recap-spark");
  svg.setAttribute("viewBox", "0 0 300 64");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");

  const W = 300;
  const BASE = 58;
  const TOP = 6;
  const chartH = BASE - TOP;
  const maxVal = Math.max(target || 0, ...spark.map((p) => p.calories), 1) * 1.1;
  const slot = W / spark.length;
  const barW = slot * 0.56;

  spark.forEach((p, i) => {
    const x = i * slot + (slot - barW) / 2;
    const rect = document.createElementNS(SVG_NS, "rect");
    let h;
    let cls = "recap-spark-bar";
    if (!p.logged) {
      h = 3;
      cls += " recap-spark-bar--empty";
    } else {
      h = Math.max(3, (p.calories / maxVal) * chartH);
      if (p.adherent) cls += " recap-spark-bar--hit";
    }
    rect.setAttribute("x", x.toFixed(1));
    rect.setAttribute("y", (BASE - h).toFixed(1));
    rect.setAttribute("width", barW.toFixed(1));
    rect.setAttribute("height", h.toFixed(1));
    rect.setAttribute("rx", "1.5");
    rect.setAttribute("class", cls);
    svg.appendChild(rect);
  });

  if (target > 0) {
    const y = BASE - Math.min(target / maxVal, 1) * chartH;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", "0");
    line.setAttribute("x2", String(W));
    line.setAttribute("y1", y.toFixed(1));
    line.setAttribute("y2", y.toFixed(1));
    line.setAttribute("class", "recap-spark-target");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(line);
  }

  section.appendChild(svg);
  const cap = document.createElement("p");
  cap.className = "recap-spark-caption";
  cap.textContent = t("recap.spark.caption");
  section.appendChild(cap);
  return section;
}

function renderCaption(recap) {
  if (!recap.caption) return null;
  const section = makeSection("recap-caption-wrap");
  const p = document.createElement("p");
  p.className = "recap-caption";
  p.textContent = recap.caption;
  section.appendChild(p);
  return section;
}

function renderInsights(recap) {
  const section = makeSection("recap-insights");
  recap.insights.forEach((ins) => {
    const card = document.createElement("div");
    card.className = "recap-insight-card";
    card.dataset.family = ins.family;
    const text = document.createElement("p");
    text.className = "recap-insight-text";
    text.textContent = t(`recap.insights.${ins.kind}.${ins.variant}`, insightVars(ins.data));
    card.appendChild(text);
    section.appendChild(card);
  });
  return section;
}

function metricCard(label, value, sub) {
  const card = document.createElement("div");
  card.className = "recap-metric";
  const l = document.createElement("span");
  l.className = "recap-metric-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "recap-metric-value";
  v.textContent = value;
  card.append(l, v);
  if (sub) {
    const s = document.createElement("span");
    s.className = "recap-metric-sub";
    s.textContent = sub;
    card.appendChild(s);
  }
  return card;
}

function renderMetrics(recap) {
  const m = recap.metrics;
  const cards = [];

  if (m.days_logged > 0) {
    let sub = null;
    if (m.prev_week_avg_calories != null) {
      sub = t("recap.metrics.vsLastWeek", { delta: `${signed(m.avg_calories - m.prev_week_avg_calories)} kcal` });
    } else if (m.baseline_avg_calories != null) {
      sub = t("recap.metrics.vsBaseline", { delta: `${signed(m.avg_calories - m.baseline_avg_calories)} kcal` });
    } else {
      sub = t("recap.metrics.vsTarget", { delta: `${signed(m.avg_calories - m.target_calories)} kcal` });
    }
    cards.push(metricCard(t("recap.metrics.avgCalories"), `${fmt(m.avg_calories)}`, sub));
    cards.push(
      metricCard(
        t("recap.metrics.onTarget"),
        `${fmt(m.days_adherent)}/${fmt(m.days_logged)}`,
        t("recap.metrics.pct", { n: m.adherence_pct }),
      ),
    );
  }
  if (m.target_protein > 0 && m.days_logged > 0) {
    cards.push(
      metricCard(
        t("recap.metrics.protein"),
        `${fmt(m.protein_hit_days)}/${fmt(m.days_logged)}`,
        t("recap.metrics.avgG", { n: fmt(m.avg_protein) }),
      ),
    );
  }
  if (m.target_water_ml > 0) {
    cards.push(metricCard(t("recap.metrics.water"), `${fmt(m.water_hit_days)}/${fmt(m.window_days)}`, null));
  }
  if (m.streak > 0) {
    cards.push(metricCard(t("recap.metrics.streak"), fmt(m.streak), t("recap.metrics.days", { n: m.streak })));
  }
  if (m.weigh_ins > 0) {
    const sub = m.weight_change_kg != null ? t("recap.metrics.weightDelta", { delta: `${signed(m.weight_change_kg)} kg` }) : null;
    cards.push(metricCard(t("recap.metrics.weighIns"), fmt(m.weigh_ins), sub));
  }

  if (!cards.length) return null;
  const section = makeSection("recap-metrics");
  cards.slice(0, 4).forEach((c) => section.appendChild(c));
  return section;
}

// -------------------------------------------------------------------------
// Orchestration
// -------------------------------------------------------------------------
function renderRecap(recap) {
  const body = el("weekly-recap-body");
  const sections = [
    renderEyebrow(recap),
    renderHero(recap),
    renderSpark(recap),
    renderCaption(recap),
    renderInsights(recap),
    renderMetrics(recap),
  ].filter(Boolean);

  sections.forEach((s, i) => {
    if (!prefersReducedMotion) {
      s.classList.add("recap-reveal");
      s.style.animationDelay = `${i * 55}ms`;
    }
  });
  body.replaceChildren(...sections);
}

function renderLoading() {
  const body = el("weekly-recap-body");
  const wrap = document.createElement("div");
  wrap.className = "recap-loading";
  for (let i = 0; i < 4; i++) {
    const row = document.createElement("div");
    row.className = "recap-skeleton-row";
    wrap.appendChild(row);
  }
  const label = document.createElement("p");
  label.className = "recap-loading-label";
  label.textContent = t("recap.loading");
  wrap.appendChild(label);
  body.replaceChildren(wrap);
}

function renderError() {
  const body = el("weekly-recap-body");
  const wrap = document.createElement("div");
  wrap.className = "recap-error";
  const p = document.createElement("p");
  p.textContent = t("recap.error");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-ghost-sm";
  btn.textContent = t("recap.retry");
  btn.addEventListener("click", load);
  wrap.append(p, btn);
  body.replaceChildren(wrap);
}

async function load() {
  const token = ++fetchToken;
  renderLoading();
  try {
    const recap = await api.getWeeklyRecap();
    if (token !== fetchToken) return; // a newer open superseded this one
    lastRecap = recap;
    renderRecap(recap);
  } catch {
    if (token === fetchToken) renderError();
  }
}

export function openWeeklyRecapSheet() {
  initWeeklyRecap(); // idempotent — guarantees listeners are wired regardless of import order
  openSheet("weekly-recap-sheet");
  load();
}

// Wires the sheet's listeners exactly once. Reached from two independent
// entry points — the recap chip inside the AI Coach sheet, and app.js's
// notification deep-link (?view=weekly_recap / a SW message) — plus a
// best-effort self-call on first import. The `inited` guard makes every
// call after the first a no-op instead of double-wiring.
let inited = false;
function initWeeklyRecap() {
  if (inited || !el("weekly-recap-sheet")) return;
  inited = true;
  el("weekly-recap-close-btn").addEventListener("click", () => closeSheet("weekly-recap-sheet"));
  // Backdrop tap closes it (the shared drag-handle dismiss is wired by
  // ui.js's initSheetDragToDismiss via SHEET_IDS).
  el("weekly-recap-sheet").addEventListener("click", (e) => {
    if (e.target === el("weekly-recap-sheet")) closeSheet("weekly-recap-sheet");
  });
  // Re-render from the last fetched data on a language switch while the
  // sheet is open — no new network call.
  onLanguageChange(() => {
    if (!el("weekly-recap-sheet").hidden && lastRecap) renderRecap(lastRecap);
  });
}

initWeeklyRecap();
