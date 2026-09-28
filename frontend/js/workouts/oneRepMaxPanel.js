// The per-exercise estimated-1RM card and its new-PR celebration. Lifted
// verbatim out of workoutDiary.js (Phase 0.3). The pure estimator math stays
// where it already was, in js/oneRepMax.js — this module is only the panel.
import { showToast, vibrate } from "../ui.js";
import { t } from "../i18n.js";
import { drawTrendLine, setSvgHidden } from "../charts.js";
import { oneRepMaxSeries } from "../oneRepMax.js";
import { fireConfetti } from "../confetti.js";
import { state } from "./workoutState.js";

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Estimated 1RM (Phase 3) — a per-exercise trend, not a per-set one: reads
// every session already cached in state.sessions (same zero-network-cost
// posture as the ghost values above) and reduces it to one best-estimate
// point per session via oneRepMax.js's pure functions. `getCachedSessions()`
// is already sorted newest-first for the calendar's own use; oneRepMaxSeries
// re-sorts to oldest-first, which is what a left-to-right progression chart
// needs.
// ---------------------------------------------------------------------------
export function renderOneRepMax(exerciseName) {
  const card = el("wd-onerm-card");
  const series = exerciseName ? oneRepMaxSeries(state.sessions, exerciseName) : [];
  if (!series.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const best = Math.max(...series.map((p) => p.est));
  el("wd-onerm-value").textContent = `${best} kg`;

  const chart = el("wd-onerm-chart");
  if (series.length >= 2) {
    setSvgHidden(chart, false);
    drawTrendLine(chart, series, "est");
  } else {
    setSvgHidden(chart, true);
  }
}

// Fired only on a genuine improvement (see submitSet()'s own guard: there
// must already have been a prior best to beat) — reuses this app's existing
// "achievement unlocked" vocabulary exactly (confetti + haptic pattern +
// toast, see progress.js's renderMilestones) rather than inventing a
// second celebration language for the same kind of moment.
export function celebratePr(newEst) {
  vibrate([20, 60, 20]);
  showToast(t("workoutDiary.newPrToast", { est: newEst }), "success");
  const badge = el("wd-onerm-pr-badge");
  fireConfetti(badge);
  badge.classList.remove("wd-onerm-pr-shine");
  void badge.offsetWidth; // restart the CSS animation — a deliberate one-off reflow for a rare, user-triggered celebration, not a per-frame cost
  badge.classList.add("wd-onerm-pr-shine");
}
