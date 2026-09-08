import { api } from "./api.js";
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
} from "./ui.js";
import { getLanguage, getLocale, onLanguageChange, t } from "./i18n.js";
import { computeStreakWithFreeze } from "./streakFreeze.js";
import { computeMomentum } from "./momentumMath.js";
import * as weekHistory from "./weekHistory.js";
import { computeEMA, computeLinearTrendRate, computeWeightForecast, computeWeightVerdict } from "./nutritionMath.js";
import { initSuggestions } from "./suggestions.js";
import { getCachedSessions, getCachedSets, loadWorkoutSessions } from "./workoutDiary.js";
import { MUSCLE_GROUPS } from "./exerciseI18n.js";
import { setContext as setAiCoachContext } from "./aiCoach.js";
import { fireConfetti } from "./confetti.js";
import { drawTrendLine, setSvgHidden, sizeSvgToContainer, svgEl } from "./charts.js";

const el = (id) => document.getElementById(id);
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

// Cached so a language switch or a weight add/delete can re-render instantly
// from what we already have, instead of re-fetching from the server.
let currentTargets = null;
let lastTrends = null;
let lastWeights = null;
let lastMeasurements = null;
let lastLogs = null;
let lastSavedMeals = null;
let lastMilestoneStats = null;
let editingMeasurementId = null; // set while the sheet is editing an existing entry rather than adding a new one

// ---------------------------------------------------------------------------
// Zone 1 — Momentum + the 7-day week row (Progress tab redesign, Phase 1);
// Zone 2 (below) — the Sunday check-in card + the "Past weeks" rack (Phase 2).
//
// Momentum replaces the brittle calorie day-streak: a 0–100 score that
// speeds up with adherent days and only ever coasts down, never resetting.
// The scoring math lives in js/momentumMath.js (shared with weekHistory.js);
// this file just renders it. The week-history data layer is js/weekHistory.js
// — past weeks are snapshotted client-side because the server only keeps a
// trailing 7-day window.
// ---------------------------------------------------------------------------

// Localized single-letter weekday for a "YYYY-MM-DD" day, matching the
// {weekday:"short"} calls elsewhere in this file — the retention window is a
// trailing 7 days ending today, not a fixed Mon–Sun, so each cell is
// labelled by its own real weekday.
function weekdayNarrow(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(getLocale(), { weekday: "narrow" });
}

// 2 * PI * r, r = 32 — must match .momentum-dial-value's stroke-dasharray in style.css.
const MOMENTUM_DIAL_CIRCUMFERENCE = 201.06;

// --- The Pulse (Progress redesign, Phase 1) -------------------------------
// The hero's one orchestrated entrance — dial arc sweep + score count-up + a
// left-to-right stagger of the 7 day cells, ~700ms of motion — plays once
// each time the Progress tab is opened.
//
// Two pieces cooperate so there's never a frame of the resting hero before
// the entrance:
//   * syncPulseState(), called at the end of every renderMomentumZone, holds
//     the hero in its un-transitioned "from" state (.is-entering, empty arc,
//     0) for as long as an entrance is armed. Because that runs synchronously
//     inside the same renderFromCache() that paints the tab on open — before
//     switchView un-hides the view — the hero's very first visible paint is
//     already the from-state.
//   * an IntersectionObserver on #momentum-hero (initPulse) fires the actual
//     Play the moment the hero is on screen, on every entry path (tap, swipe,
//     back), and re-arms only when the tab is navigated away from — not on a
//     plain scroll-past inside an already-open tab. If its callback is ever
//     delayed (a backgrounded tab), the hero just holds the from-state a beat
//     longer instead of flickering.
//
// Once the entrance is done, the number counts from wherever it sits up to
// the new value whenever renderMomentumZone re-runs with a changed score —
// app.js's render() -> syncLiveTotals() already calls that on every food log,
// so logging from the dashboard visibly ticks Momentum up and swells today's
// fill (immediately if Progress is the visible tab, otherwise on the next
// open via the entrance) with no reload. Everything collapses to an instant
// set under prefers-reduced-motion.
let pulseEntranceArmed = true;
let pulseEntrancePlaying = false;
let pulseEntranceCleanupTimer = 0;
let pulseEntranceRaf = 0;
let pulseObserver = null;
let latestScore = 0; // newest computeMomentum score — the count-up's live target
let pulseRestingOffset = String(MOMENTUM_DIAL_CIRCUMFERENCE); // dial dashoffset for latestScore
let lastDisplayedScore = null; // what #momentum-score currently reads (null = never painted)
let lastTodayPct = null; // today's fill fraction at the last paint, to detect a fresh log
let countUpRaf = 0;

// Counts #momentum-score from `from` toward whatever `latestScore` is at each
// frame (so a score that changes mid-count retargets instead of finishing on
// a stale value), easing out over `ms`. Cancels any in-flight count first.
// Straight set under reduced motion.
function animateScore(from, ms) {
  cancelAnimationFrame(countUpRaf);
  const scoreEl = el("momentum-score");
  if (!scoreEl) return;
  if (prefersReducedMotion) {
    scoreEl.textContent = String(latestScore);
    lastDisplayedScore = latestScore;
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    const shown = Math.round(from + (latestScore - from) * eased);
    scoreEl.textContent = String(shown);
    lastDisplayedScore = shown;
    if (p < 1) {
      countUpRaf = requestAnimationFrame(step);
    } else {
      scoreEl.textContent = String(latestScore);
      lastDisplayedScore = latestScore;
    }
  };
  countUpRaf = requestAnimationFrame(step);
}

// The un-transitioned "from" state: empty arc, cells/text hidden, number 0.
// Idempotent — safe to call on every render while armed. The resting arc
// offset is derived from latestScore (not read back off the DOM) so Play
// always animates toward the right value even if this ran many times first.
function primePulseFromState() {
  const hero = el("momentum-hero");
  const dial = el("momentum-dial-value");
  const scoreEl = el("momentum-score");
  if (!hero || !dial || !scoreEl) return;
  pulseRestingOffset = String(MOMENTUM_DIAL_CIRCUMFERENCE * (1 - latestScore / 100));
  hero.classList.remove("is-entered");
  hero.classList.add("is-entering");
  dial.style.transition = "none";
  dial.style.strokeDashoffset = String(MOMENTUM_DIAL_CIRCUMFERENCE);
  scoreEl.textContent = "0";
  lastDisplayedScore = 0;
}

// Forces the hero to its final resting state (no classes, real number, real
// arc) and clears the playing flag. Called both as the entrance's normal
// tail and as its failsafe: if the Play rAF is ever paused (the tab gets
// backgrounded the instant Progress opens), this still lands a correct — if
// un-animated — hero rather than leaving it stuck in the from-state.
function finishPulseEntrance() {
  clearTimeout(pulseEntranceCleanupTimer);
  cancelAnimationFrame(pulseEntranceRaf);
  const hero = el("momentum-hero");
  const dial = el("momentum-dial-value");
  const scoreEl = el("momentum-score");
  if (hero) hero.classList.remove("is-entering", "is-entered");
  if (dial) {
    dial.style.transition = "";
    dial.style.strokeDashoffset = pulseRestingOffset;
  }
  if (scoreEl) {
    scoreEl.textContent = String(latestScore);
    lastDisplayedScore = latestScore;
  }
  pulseEntrancePlaying = false;
}

// The Play: flip transitions on (.is-entered) so the compositor carries the
// arc, the staggered cells and the two text blocks home, and count the
// number up. Per-property timing/stagger lives in style.css. Under reduced
// motion it just clears to the resting values with no animation.
function playPulseEntrance() {
  if (pulseEntrancePlaying) return;
  const hero = el("momentum-hero");
  const dial = el("momentum-dial-value");
  if (!hero || !dial) return;
  pulseEntranceArmed = false;

  if (prefersReducedMotion) {
    finishPulseEntrance();
    return;
  }

  pulseEntrancePlaying = true;
  primePulseFromState(); // covers a Play fired straight from a live render, not a prior prime
  void hero.offsetWidth; // commit the from-state before Play

  cancelAnimationFrame(pulseEntranceRaf);
  pulseEntranceRaf = requestAnimationFrame(() => {
    hero.classList.remove("is-entering");
    hero.classList.add("is-entered");
    dial.style.transition = ""; // hand the arc back to .is-entered's shorter sweep rule
    dial.style.strokeDashoffset = pulseRestingOffset;
    animateScore(0, 700);
  });

  // Settle ~500ms after the sweep + count-up finish: drop .is-entered (so
  // later live feeds use the base dial transition and carry no stagger) and,
  // as the failsafe above, guarantee a correct hero even if the rAF never ran.
  clearTimeout(pulseEntranceCleanupTimer);
  pulseEntranceCleanupTimer = setTimeout(finishPulseEntrance, 1200);
}

// Run at the end of every renderMomentumZone. Holds the from-state while an
// entrance is pending; the IntersectionObserver plays it once on screen.
function syncPulseState() {
  if (pulseEntrancePlaying || !pulseEntranceArmed) return;
  // No entrance under reduced motion — land straight on the resting state
  // (also clears any stale from-state class).
  if (prefersReducedMotion) {
    finishPulseEntrance();
    return;
  }
  primePulseFromState();
}

// Plays the entrance the first time the hero is on screen, then re-arms each
// time the Progress tab is left (#view-progress goes hidden) — so it replays
// on the next open but not when the hero is merely scrolled past inside an
// already-open tab.
function initPulse() {
  const hero = el("momentum-hero");
  if (!hero || typeof IntersectionObserver === "undefined") return;
  pulseObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          if (pulseEntranceArmed) playPulseEntrance();
        } else if (el("view-progress")?.hidden) {
          pulseEntranceArmed = true;
        }
      }
    },
    { root: el("app") || null, threshold: 0.35 },
  );
  pulseObserver.observe(hero);
}

// Paints the Momentum hero (#momentum-hero). Everything is set via
// textContent / dataset / style — never innerHTML — so there's no
// markup-injection path even though none of this copy is user-supplied.
// The 7 day cells are created once and then updated in place, so the
// today-cell CSS pulse never restarts on a re-render (renderFromCache runs
// on every tab visit and every optimistic log).
function renderMomentumZone(days, targets, frozenDate) {
  const targetCalories = targets?.daily_calories || 2000;
  const { score, tier, onTrackDays, judgedDays, anyActivity } = computeMomentum(days, targetCalories);

  latestScore = score;
  pulseRestingOffset = String(MOMENTUM_DIAL_CIRCUMFERENCE * (1 - score / 100));
  // The arc is always set straight to its resting offset — its own CSS
  // transition animates the move (the entrance sweep via .is-entered, or the
  // base rule on a live feed after a log). primePulseFromState overrides this
  // to the empty arc while an entrance is armed.
  el("momentum-dial-value").style.strokeDashoffset = pulseRestingOffset;
  // The number is owned by the entrance machinery while one is armed or
  // playing (syncPulseState below holds it at 0; playPulseEntrance counts it
  // up). Otherwise it counts from the last shown value on a real change (a
  // dashboard food log re-runs this via app.js render() -> syncLiveTotals),
  // or is set straight when the hero isn't on screen yet / reduced motion.
  if (!pulseEntranceArmed && !pulseEntrancePlaying) {
    if (lastDisplayedScore === null || prefersReducedMotion || el("view-progress")?.hidden) {
      el("momentum-score").textContent = String(score);
      lastDisplayedScore = score;
    } else if (score !== lastDisplayedScore) {
      animateScore(lastDisplayedScore, 480);
    }
  }

  el("momentum-tier").textContent = t(`progress.momentumTier${tier.key}`);
  el("momentum-sub").textContent = anyActivity
    ? t("progress.momentumOnTrack", { on: onTrackDays, total: judgedDays })
    : t("progress.momentumNoData");

  const weekEl = el("momentum-week");
  if (weekEl.childElementCount !== days.length) {
    weekEl.replaceChildren(
      ...days.map((_, i) => {
        const cell = document.createElement("div");
        cell.className = "momentum-day";
        cell.style.setProperty("--cell-i", String(i)); // entrance stagger index (see style.css)
        const fill = document.createElement("span");
        fill.className = "momentum-day-fill";
        const label = document.createElement("span");
        label.className = "momentum-day-label";
        cell.append(fill, label);
        return cell;
      }),
    );
  }

  const cells = weekEl.children;
  const counts = { on: 0, off: 0, none: 0 };
  days.forEach((day, i) => {
    const cell = cells[i];
    const isToday = i === days.length - 1;
    const hasLogs = day.calories > 0;
    let state;
    if (isToday) {
      state = "today";
      const pct = Math.max(0, Math.min(1, day.calories / targetCalories));
      const fillEl = cell.querySelector(".momentum-day-fill");
      fillEl.style.height = `${(pct * 100).toFixed(1)}%`;
      // The visible half of the live-feed loop: a one-shot swell when today's
      // fill grows from a log landing while the hero is on screen. Never on
      // the first paint, mid-entrance, or under reduced motion.
      if (
        !prefersReducedMotion &&
        !pulseEntranceArmed &&
        !pulseEntrancePlaying &&
        lastTodayPct !== null &&
        pct > lastTodayPct + 0.0005 &&
        !el("view-progress")?.hidden
      ) {
        fillEl.classList.remove("is-feeding");
        void fillEl.offsetWidth;
        fillEl.classList.add("is-feeding");
        fillEl.addEventListener("animationend", () => fillEl.classList.remove("is-feeding"), { once: true });
      }
      lastTodayPct = pct;
    } else if (day.date === frozenDate) {
      state = "grace";
    } else if (day.adherent) {
      state = "on";
      counts.on += 1;
    } else if (hasLogs) {
      state = "off";
      counts.off += 1;
    } else {
      state = "none";
      counts.none += 1;
    }
    cell.dataset.state = state;
    cell.querySelector(".momentum-day-label").textContent = weekdayNarrow(day.date);
  });

  const todayPct = Math.round(Math.max(0, Math.min(1, (days[days.length - 1]?.calories || 0) / targetCalories)) * 100);
  weekEl.setAttribute(
    "aria-label",
    t("progress.momentumWeekAria", { on: counts.on, off: counts.off, none: counts.none, todayPct }),
  );

  const insightKey = anyActivity ? `momentumInsight${tier.key}` : "momentumInsightZero";
  el("momentum-insight-text").textContent = t(`progress.${insightKey}`);

  // Keep the hero pinned to its pre-entrance "from" state for as long as an
  // entrance is armed — runs synchronously inside the open-time render, so
  // the first visible paint is never the resting hero. The IntersectionObserver
  // (initPulse) plays it once on screen.
  syncPulseState();
}

// ---------------------------------------------------------------------------
// Zone 2 — the Sunday check-in card (#sunday-checkin) + the "Past weeks" rack
// (#past-weeks-group). Data comes entirely from js/weekHistory.js (localStorage
// snapshots — the server can't hand back a week that's rolled out of its
// 7-day window). All text is set via textContent / t(); the strip cells are
// built with createElement — no innerHTML, no injection surface.
// ---------------------------------------------------------------------------

// One .momentum-day cell per snapshot day ({date, adherent, logged}). No fill
// span and no "today" state — a finished week has no live day. The .is-mini
// container class hides the weekday letters where the cells are too small.
function renderWeekStrip(containerEl, days) {
  containerEl.replaceChildren(
    ...days.map((day) => {
      const cell = document.createElement("div");
      cell.className = "momentum-day";
      cell.dataset.state = day.adherent ? "on" : day.logged ? "off" : "none";
      const label = document.createElement("span");
      label.className = "momentum-day-label";
      label.textContent = weekdayNarrow(day.date);
      cell.append(label);
      return cell;
    }),
  );
}

function weekStripAria(days) {
  const on = days.filter((d) => d.adherent).length;
  const off = days.filter((d) => d.logged && !d.adherent).length;
  return t("progress.pastWeekStripAria", { on, off, none: days.length - on - off });
}

// "Sep 1 – 7" within one month, "Aug 31 – Sep 6" across a boundary.
function formatWeekRange(startDate, endDate) {
  const loc = getLocale();
  const s = new Date(`${startDate}T00:00:00`);
  const e = new Date(`${endDate}T00:00:00`);
  const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  const sStr = s.toLocaleDateString(loc, { month: "short", day: "numeric" });
  const eStr = e.toLocaleDateString(loc, sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" });
  return `${sStr} – ${eStr}`;
}

// Guards a re-render's worth of DOM churn on every renderFromCache pass
// (twice per tab visit + once per optimistic log) down to "only when the
// pending week or the language actually changed".
let lastCheckinKey = "";
let checkinDismissing = false;

function renderSundayCheckin() {
  if (checkinDismissing) return; // the dismiss animation owns the card until it settles
  const card = el("sunday-checkin");
  const w = weekHistory.getPendingCheckin();
  const key = w ? `${w.key}|${getLanguage()}` : "";
  if (key === lastCheckinKey && card.hidden === !w) return;
  lastCheckinKey = key;

  if (!w) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  card.classList.remove("is-dismissing");
  el("sunday-checkin-headline").textContent = t(w.headline.key, w.headline.vars);
  renderWeekStrip(el("sunday-checkin-week"), w.days);
  el("sunday-checkin-week").setAttribute("aria-label", weekStripAria(w.days));
  el("sunday-checkin-nudge-text").textContent = t(w.nudgeKey);
}

let lastPastWeeksKey = "";
function renderPastWeeks() {
  const group = el("past-weeks-group");
  // The still-pending week lives in the check-in card, not the rack — it
  // only joins the list once dismissed, so "dismiss" reads as it dropping in.
  const weeks = weekHistory.getWeeks().filter((w) => w.dismissed);
  if (!weeks.length) {
    group.hidden = true;
    lastPastWeeksKey = "";
    return;
  }
  const key = weeks.map((w) => w.key).join(",") + "|" + getLanguage();
  if (key === lastPastWeeksKey && !group.hidden) return;
  lastPastWeeksKey = key;
  group.hidden = false;

  el("past-weeks-list").replaceChildren(
    ...weeks.map((w) => {
      const headlineText = t(w.headline.key, w.headline.vars);
      const rangeText = formatWeekRange(w.startDate, w.endDate);
      const tierText = t(`progress.momentumTier${w.tierKey}`);

      const row = document.createElement("div");
      row.className = "past-week-row";
      row.setAttribute("aria-label", t("progress.pastWeekRowAria", { headline: headlineText, range: rangeText, tier: tierText }));

      const strip = document.createElement("div");
      strip.className = "momentum-week is-set is-mini";
      strip.setAttribute("aria-hidden", "true");
      renderWeekStrip(strip, w.days);

      const main = document.createElement("div");
      main.className = "past-week-row-main";
      const headline = document.createElement("span");
      headline.className = "past-week-row-headline";
      headline.textContent = headlineText;
      const range = document.createElement("span");
      range.className = "past-week-row-date mono";
      range.textContent = rangeText;
      main.append(headline, range);

      const tier = document.createElement("span");
      tier.className = "past-week-tier";
      tier.textContent = tierText;

      row.append(strip, main, tier);
      return row;
    }),
  );
}

// Wired once from initProgress. Marks the pending week dismissed, then
// collapses the card downward (transform + opacity + max-height, all
// compositor-friendly) into where the rack begins. Every listener/timer it
// creates is torn down in finalize() — no leaks even if transitionend never
// fires (backgrounded tab) thanks to the fallback timeout.
function dismissSundayCheckin() {
  const card = el("sunday-checkin");
  if (checkinDismissing || card.hidden) return;

  weekHistory.dismissPendingCheckin();
  renderPastWeeks();

  const finalize = () => {
    checkinDismissing = false;
    card.classList.remove("is-dismissing");
    card.hidden = true;
    renderSundayCheckin();
    const firstRow = el("past-weeks-list").firstElementChild;
    if (firstRow) {
      firstRow.classList.add("is-fresh");
      setTimeout(() => firstRow.classList.remove("is-fresh"), 1500);
    }
  };

  if (prefersReducedMotion) {
    finalize();
    return;
  }

  checkinDismissing = true;
  card.classList.add("is-dismissing");
  let settled = false;
  const onEnd = (e) => {
    if (settled || e.target !== card || e.propertyName !== "opacity") return;
    settled = true;
    card.removeEventListener("transitionend", onEnd);
    clearTimeout(fallback);
    finalize();
  };
  const fallback = setTimeout(() => {
    if (settled) return;
    settled = true;
    card.removeEventListener("transitionend", onEnd);
    finalize();
  }, 650);
  card.addEventListener("transitionend", onEnd);
  vibrate(8);
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
//
// renderFromCache() (this chart's only caller) runs twice on every Progress
// tab visit: once synchronously from cache the instant the tab is opened,
// then again once the background GET /trends refetch resolves (see
// renderProgress). Most of the time that refetch comes back with the exact
// same days/target the cache already had — nothing actually changed since
// the last visit — but svg.innerHTML = "" below unconditionally tore every
// bar/label out and recreated them anyway, which both cost a reflow and
// restarted the bars' CSS height/y transition (style.css's .chart-bar rule)
// from scratch, reading as the whole chart "reloading" on every tab switch.
// Skipping the rebuild when the data is byte-identical to what's already on
// screen leaves the existing bars (and this session's real, already-settled
// sizeSvgToContainer width) completely undisturbed.
//
// The data signature alone isn't quite enough to gate this, though: the
// very first time this chart is EVER drawn in a session is usually the
// boot-time silent warm-up (app.js's initial renderProgress(..., {silent:
// true}) call), which runs while the Progress view is still hidden — no
// measurable width yet, so it draws with whatever sizeSvgToContainer's
// fallback returns. If the data-only signature were the sole check, that
// first (possibly wrong-width) draw would satisfy every later "same data"
// visit forever, since real usage rarely changes a whole week's trends
// between visits — the chart would stay wrong-width for the rest of the
// session instead of ever self-correcting once real layout is measurable.
// Folding the *currently rendered* viewBox width into the comparison means
// a redraw is still forced the moment a real measurement disagrees with
// whatever width the last draw used (whether that was a guess or genuinely
// stale), and only truly settles into "skip" once a draw has actually
// happened at the real, visible container width.
let lastRenderedCalorieChart = null;
function renderCalorieChart(days, targetCalories) {
  const svg = el("calorie-trend-chart");
  const measuredWidth = Math.round(svg.getBoundingClientRect().width);
  const renderedViewBoxWidth = Number((svg.getAttribute("viewBox") || "").split(" ")[2]) || 0;
  const widthStable = !measuredWidth || measuredWidth === renderedViewBoxWidth;
  const signature = JSON.stringify([days.map((d) => [d.date, d.calories]), targetCalories]);
  if (signature === lastRenderedCalorieChart && widthStable && svg.childElementCount) return;
  lastRenderedCalorieChart = signature;
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
// Same skip-if-unchanged guard as renderCalorieChart's own
// lastRenderedCalorieChart (see that function's comment) — unlike the
// calorie chart, whose `days` array is capped at retention_days (7),
// weight_logs is explicitly NOT retention-windowed (kept indefinitely, see
// CLAUDE.md's own note on that table), so `chronological` only ever grows
// over a user's lifetime with the app. Without this guard, renderFromCache()
// — which reruns on every single Progress-tab visit, cache-first, even when
// nothing has actually changed since the last visit — was wiping and fully
// rebuilding this SVG (map/min/max/EMA over the WHOLE weigh-in history, plus
// one DOM node per point) unconditionally every time, twice per visit (the
// synchronous cache-first pass and the reconciling pass once the background
// refetch resolves). Cheap for a new user with a handful of entries;
// measurably not cheap any more for a long-time user with months of
// weigh-ins, which is exactly the kind of cost that reads as "switching to
// Progress feels slow" without ever showing up as a single long task on a
// fresh/empty test account.
let lastRenderedWeightChart = null;
function drawWeightTrendChart(svg, chronological) {
  const height = 140;
  // Same widthStable reasoning as renderCalorieChart: the very first draw
  // can land while .view-progress is still `hidden` (0 measured width,
  // sizeSvgToContainer falls back to its last-known/guessed width), so a
  // signature match alone isn't enough to skip — this still has to redraw
  // once the container's real width is known, even with unchanged data.
  const measuredWidth = Math.round(svg.getBoundingClientRect().width);
  const renderedViewBoxWidth = Number((svg.getAttribute("viewBox") || "").split(" ")[2]) || 0;
  const widthStable = !measuredWidth || measuredWidth === renderedViewBoxWidth;
  const signature = JSON.stringify(chronological.map((e) => [e.id, e.weight_kg, e.logged_at]));
  if (signature === lastRenderedWeightChart && widthStable && svg.childElementCount) return;
  lastRenderedWeightChart = signature;
  svg.innerHTML = "";
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

// Plain-word trend verdict (Phase 3), sitting under the current-weight number
// and always visible (outside the collapsible panel) — the whole point is to
// be the thing a user sees instead of fixating on today's raw figure.
// `chronological` = entries oldest-first. Hidden until there's enough history
// for a real trend (computeWeightVerdict returns "insufficient").
function renderWeightVerdict(chronological) {
  const verdictEl = el("weight-verdict");
  const v = computeWeightVerdict(chronological);
  if (v.kind === "insufficient") {
    verdictEl.hidden = true;
    return;
  }
  verdictEl.hidden = false;
  verdictEl.dataset.kind = v.kind;
  verdictEl.textContent =
    v.kind === "steady"
      ? t("progress.weightVerdictSteady")
      : t(v.kind === "down" ? "progress.weightVerdictDown" : "progress.weightVerdictUp", { rate: v.ratePerWeek });
}

function renderWeightSection(entries) {
  renderWeightCurrentStat(entries);
  // Entries arrive newest-first from the API; computeWeightForecast/
  // computeWeightVerdict expect chronological (oldest-first), same convention
  // as computeEMA/computeLinearTrendRate above.
  const chronological = [...entries].reverse();
  setAiCoachContext({ weightForecast: computeWeightForecast(chronological) });
  renderWeightVerdict(chronological);

  const svg = el("weight-trend-chart");
  const list = el("weight-list");
  const empty = el("weight-empty");

  if (!entries.length) {
    empty.hidden = false;
    el("weight-verdict").hidden = true;
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

// Training log (sets/reps/weight/RPE, the Workout Diary) has moved to its
// own module — see js/workoutDiary.js. progress.js just calls
// loadWorkoutSessions() during its own boot (loadAll below) and reads back
// the flattened set list for the achievements grid, same thin-context
// pattern as suggestions.js/analytics.js.

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
// firstLog deliberately reads s.logsCount, NOT s.streak: streak (and each
// day's `adherent` flag it's built from — see ADHERENCE_TOLERANCE in
// backend/services/trends_service.py) requires that day's *total* calories
// land within ±10% of the daily target, not just "a log exists". That made
// this specific badge silently unreachable for the exact case its own
// description promises ("Log your first meal or snack") — logging one
// modest snack against a full day's calorie target fails the ±10% check by
// design (it's meant to, for the adherence-streak use case), so streak
// stayed 0 and the badge never unlocked even though a first log genuinely
// happened. logsCount (see lastMilestoneStats below) is a plain count of
// logs in the retention window with no calorie-accuracy condition attached,
// so this now fires the moment any first food/snack is logged, immediately
// (syncLiveTotals below re-renders milestones on every log mutation).
// `tier` (bronze/silver/gold/platinum) is a purely presentational rarity
// ranking — mirrors a mobile-game trophy case so the grid isn't a flat wall
// of identical chips: bronze for the low-effort/first-time badges, silver
// for genuine but attainable consistency, gold for the long-haul ones, and
// platinum reserved for wellRounded alone since it's the only badge that
// demands every tracked category at once rather than depth in just one.
// Styling keys off this via each card's [data-tier] attribute (style.css) —
// it never affects earn logic, only which glow/gradient an earned card gets.
// Ollie's "Perfect Caretaker" milestone mirrors backend/services/
// pet_service.py's evaluate_day() day-by-day, purely client-side against the
// same lastTrends.days array every other streak milestone above already
// reads. Ollie's actual hearts value is a single current number with no
// persisted daily history (pet_state only stores hearts +
// last_evaluated_date — hearts move by exactly ±1 per judged day, but which
// past days were "good" is never kept, see that table's own schema comment),
// so there's no server-side streak to simply read back for this badge.
// Re-deriving the same day judgment client-side (a food log exists, calories
// land within TARGET_TOLERANCE of target — the same ±10% figure
// pet_service.evaluate_day itself uses via ADHERENCE_TOLERANCE — and water is
// at or above target) gives an honest count of "how many days in a row would
// have kept Ollie's hearts climbing/maxed", without adding a new backend
// table just for one milestone — same "computed at read time" principle
// fiberStreak/countBalancedDays above already use.
function computePetCareStreak(days, targets) {
  const targetCalories = targets?.daily_calories || 0;
  const targetWater = targets?.daily_water_ml || 0;
  if (!targetCalories || !targetWater || !days?.length) return 0;
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    const isToday = i === days.length - 1;
    const hasLog = day.calories > 0;
    if (isToday && !hasLog) continue;
    if (!hasLog) break;
    const withinCalories = Math.abs(day.calories - targetCalories) <= targetCalories * TARGET_TOLERANCE;
    const metWater = day.water_ml >= targetWater;
    if (withinCalories && metWater) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// Lifetime Ollie tap count, written by ollie3d.js's own pointerdown handler
// into this same localStorage key (kept in sync via the shared key rather
// than a direct import — see that module's own comment on
// OLLIE_TAP_COUNT_KEY for why) — powers ollieFirstHello/ollieDevotedFriend
// below.
const OLLIE_TAP_COUNT_KEY = "ollieTapCount";
function getOllieTapCount() {
  return Number(localStorage.getItem(OLLIE_TAP_COUNT_KEY) || "0");
}

const MILESTONE_DEFINITIONS = [
  { key: "firstLog", icon: "🌱", tier: "bronze", value: (s) => s.logsCount, target: 1 },
  { key: "streak3", icon: "🔥", tier: "bronze", value: (s) => s.streak, target: 3 },
  { key: "streak7", icon: "🏆", tier: "silver", value: (s) => s.streak, target: 7 },
  { key: "firstWeighIn", icon: "⚖️", tier: "bronze", value: (s) => s.weighInsCount, target: 1 },
  { key: "trackingPro", icon: "📈", tier: "silver", value: (s) => s.weighInsCount, target: 20 },
  { key: "weightVeteran", icon: "🎯", tier: "gold", value: (s) => s.weighInsCount, target: 50 },
  { key: "bodyTracker", icon: "📏", tier: "bronze", value: (s) => s.measurementsCount, target: 5 },
  { key: "precisionTracker", icon: "🧭", tier: "silver", value: (s) => s.measurementsCount, target: 20 },
  { key: "mealPrepper", icon: "⭐", tier: "bronze", value: (s) => s.savedMealsCount, target: 5 },
  { key: "mealPrepMaster", icon: "👨‍🍳", tier: "silver", value: (s) => s.savedMealsCount, target: 15 },
  { key: "firstWorkout", icon: "🏋️", tier: "bronze", value: (s) => s.workoutsCount, target: 1 },
  { key: "consistentLifter", icon: "💪", tier: "silver", value: (s) => s.workoutsCount, target: 10 },
  { key: "ironVeteran", icon: "🦾", tier: "gold", value: (s) => s.workoutsCount, target: 50 },
  // Total training volume (sets x reps x weight) summed across every logged
  // workout entry — a second, complementary way to recognize effort besides
  // raw entry count, fitting for a hypertrophy-tracking app named Iron Log.
  { key: "heavyHitter", icon: "🏔️", tier: "gold", value: (s) => Math.round(s.totalVolumeKg), target: 10000 },
  // The only combined milestone: rewards actually using every tracked
  // category together (nutrition streak + weight + measurements + workouts),
  // not just going deep on one. value() counts how many of the 4 are active.
  {
    key: "wellRounded",
    icon: "🌟",
    tier: "platinum",
    value: (s) => [s.streak >= 3, s.weighInsCount >= 1, s.measurementsCount >= 1, s.workoutsCount >= 1].filter(Boolean).length,
    target: 4,
  },
  // Rewards exactly the "protein hit, fats still in check" combination
  // coach.js's status.dialedIn message already praises for a single day —
  // this counts how many days in the retained window pulled it off.
  { key: "balancedWeek", icon: "🥗", tier: "bronze", value: (s) => s.balancedDaysCount, target: 5 },
  // Fiber has no "too much" ceiling (see ui.js's BONUS_OVERAGE_MACROS) — a
  // running streak of fiber-target days is a genuine win worth its own badge.
  { key: "fiberStreak", icon: "🌾", tier: "silver", value: (s) => s.fiberStreak, target: 3 },
  // Ollie-themed badges — reuse the exact same event data every badge above
  // already reads (food logs, the water streak, targets); only
  // ollieFirstHello/ollieDevotedFriend need a new signal at all (a plain tap
  // counter — see getOllieTapCount above), since "feeding"/"hydrating" Ollie
  // already IS logging food/water (see CLAUDE.md's Ollie module docstring:
  // hunger/hydration are today's already-logged totals, not a second tracked
  // thing), so grounding these in the same stats keeps them honest instead of
  // inventing a parallel definition of "fed"/"hydrated" that could disagree
  // with what the pet HUD itself shows.
  { key: "ollieFirstHello", icon: "🦉", tier: "bronze", value: (s) => s.ollieTapCount, target: 1 },
  { key: "ollieChef", icon: "🥣", tier: "bronze", value: (s) => s.logsCount, target: 1 },
  { key: "ollieHydration", icon: "💧", tier: "silver", value: (s) => s.waterStreak, target: 3 },
  { key: "ollieDevotedFriend", icon: "🐾", tier: "silver", value: (s) => s.ollieTapCount, target: 25 },
  // "days in a row that would have kept Ollie's hearts climbing/maxed" — see
  // computePetCareStreak's own comment above for why this is re-derived
  // client-side rather than read from a hearts-history table that doesn't
  // exist.
  { key: "olliePerfectCaretaker", icon: "💖", tier: "gold", value: (s) => s.petCareStreak, target: 5 },
];

const MILESTONE_TIER_ICONS = { bronze: "🥉", silver: "🥈", gold: "🥇", platinum: "💎" };

// Logical grouping for the trophy case — restores the "what area is this
// about" structure while keeping every badge visible in one place. Every
// MILESTONE_DEFINITIONS key belongs to exactly one group; order within a
// group is roughly easy→hard so a column reads as a progression. `labelKey`
// reuses the Progress view's own "Body"/"Training" group strings where they
// already say the right thing.
const MILESTONE_GROUPS = [
  {
    labelKey: "milestones.groupNutrition",
    keys: ["firstLog", "streak3", "streak7", "balancedWeek", "fiberStreak", "wellRounded", "mealPrepper", "mealPrepMaster"],
  },
  { labelKey: "progress.groupBody", keys: ["firstWeighIn", "trackingPro", "weightVeteran", "bodyTracker", "precisionTracker"] },
  { labelKey: "progress.groupTraining", keys: ["firstWorkout", "consistentLifter", "ironVeteran", "heavyHitter"] },
  {
    labelKey: "milestones.groupOllie",
    keys: ["ollieFirstHello", "ollieChef", "ollieHydration", "ollieDevotedFriend", "olliePerfectCaretaker"],
  },
];

// Tracks which milestones were earned as of the *last* render, so a badge
// that flips false→true gets a one-off "just earned" animation + haptic
// instead of every already-earned badge replaying it on every re-render (or,
// worse, on every fresh page load — see the initialized guard below, which
// exists specifically so the very first render of a session only seeds this
// set silently instead of "congratulating" the user for milestones they
// earned days ago).
let previousEarnedKeys = null;

function milestoneBadgeHtml(m, { earned, justEarned, entering, progress, i }) {
  const name = t(`milestones.${m.key}`);
  const status = earned
    ? t("milestones.earned")
    : `${t("milestones.notYetEarned")} — ${progress.shown}/${m.target}`;
  return `
    <li class="milestone-badge${earned ? " earned" : ""}${!earned && progress.frac > 0.001 ? " has-progress" : ""}${justEarned ? " just-earned" : ""}${entering ? " entering" : ""}" data-key="${m.key}" data-tier="${m.tier}" style="--i:${i};--progress:${progress.frac.toFixed(3)}" role="button" tabindex="0" aria-label="${name}, ${status}">
      <span class="milestone-badge-medallion"><span class="milestone-badge-icon" aria-hidden="true">${m.icon}</span></span>
      <span class="milestone-badge-label">${name}</span>
    </li>`;
}

// The whole "trophy case" — every badge, earned and locked, grouped by area
// (Nutrition / Body / Training / Ollie). Earned badges get the full
// tier-tinted glow; locked ones stay visible but desaturated with a corner
// 🔒 and a thin tier-coloured progress ring (--progress 0–1) so you can see
// which locked ones you're close to. Tapping any badge opens its
// requirement + exact progress (renderMilestoneDetail). The staggered
// entrance only plays on this session's first paint; the unlock celebration
// only on a real locked→earned transition.
//
// A paint-key guard skips the whole innerHTML rebuild when nothing that
// affects the grid actually changed — renderFromCache runs twice per tab
// visit plus once per optimistic log, and a rebuild mid-accordion-expand is
// exactly what made the slide-down flicker/double-render.
let lastMilestonesSig = "";
function renderMilestones(stats) {
  const isFirstRender = previousEarnedKeys === null;
  const withVal = MILESTONE_DEFINITIONS.map((m) => {
    const val = m.value(stats);
    const earned = val >= m.target;
    return { m, val, earned, frac: earned || m.target <= 0 ? 0 : Math.min(val / m.target, 1) };
  });

  const sig =
    withVal.map((x) => `${x.m.key}:${x.earned ? "E" : Math.round(x.frac * 1000)}`).join(",") + "|" + getLanguage();
  if (sig === lastMilestonesSig && el("milestones-groups").childElementCount) return;
  lastMilestonesSig = sig;

  const earnedKeys = new Set(withVal.filter((x) => x.earned).map((x) => x.m.key));
  const justEarnedKeys = previousEarnedKeys
    ? new Set([...earnedKeys].filter((key) => !previousEarnedKeys.has(key)))
    : new Set();
  const byKey = new Map(withVal.map((x) => [x.m.key, x]));

  let i = 0; // running index across all groups so the entrance stagger cascades
  el("milestones-groups").innerHTML = MILESTONE_GROUPS.map((group) => {
    const rows = group.keys.map((key) => byKey.get(key)).filter(Boolean);
    const earnedCount = rows.filter((x) => x.earned).length;
    const badges = rows
      .map((x) =>
        milestoneBadgeHtml(x.m, {
          earned: x.earned,
          justEarned: justEarnedKeys.has(x.m.key),
          entering: isFirstRender,
          progress: { frac: x.frac, shown: Math.min(x.val, x.m.target) },
          i: i++,
        }),
      )
      .join("");
    return `
      <section class="milestone-group">
        <p class="milestone-group-label"><span>${t(group.labelKey)}</span><span class="milestone-group-count mono">${earnedCount}/${rows.length}</span></p>
        <ul class="milestones-list">${badges}</ul>
      </section>`;
  }).join("");

  // Fire the full "achievement unlocked" moment — confetti from the badge, a
  // toast, a celebratory vibration — only for real locked→earned transitions
  // this render (justEarnedKeys is empty on isFirstRender).
  if (justEarnedKeys.size > 0) {
    vibrate([20, 60, 20]);
    const firstKey = MILESTONE_DEFINITIONS.find((m) => justEarnedKeys.has(m.key))?.key;
    if (firstKey) showToast(t("milestones.unlockedToast", { name: t(`milestones.${firstKey}`) }), "success");
    justEarnedKeys.forEach((key) => {
      const badgeEl = el("milestones-groups").querySelector(`.milestone-badge[data-key="${key}"]`);
      if (badgeEl) fireConfetti(badgeEl);
    });
  }
  previousEarnedKeys = earnedKeys;
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
  el("milestone-detail-icon").dataset.tier = m.tier;
  const tierEl = el("milestone-detail-tier");
  tierEl.textContent = `${MILESTONE_TIER_ICONS[m.tier]} ${t(`milestones.tier${m.tier[0].toUpperCase()}${m.tier.slice(1)}`)}`;
  tierEl.dataset.tier = m.tier;
  el("milestone-detail-title").textContent = t(`milestones.${m.key}`);
  el("milestone-detail-desc").textContent = t(`milestones.${m.key}Desc`);
  el("milestone-detail-status").textContent = earned ? t("milestones.earned") : t("milestones.notYetEarned");
  el("milestone-detail-status").classList.toggle("earned", earned);
  const capped = Math.min(value, m.target);
  el("milestone-detail-progress-label").textContent = `${capped.toLocaleString()} / ${m.target.toLocaleString()}`;
  el("milestone-detail-progress-fill").style.transform = `scaleX(${capped / m.target})`;
  openSheet("milestone-detail-sheet");
}

// 3D tilt on the milestone grid — delegated on the list container (not one
// listener per card) since renderMilestones fully replaces the list's
// innerHTML on every re-render (every log/water/weight mutation via
// syncLiveTotals), which would silently drop any per-card listener.
//
// Mouse/pen get a smooth, continuous tilt that tracks the live pointer
// position. Touch deliberately does NOT track live finger position mid-
// gesture the same way: doing that would require preventDefault on
// touchmove to stop the browser from also scrolling the page underneath
// the tilting finger, trading a real usability regression (a broken
// vertical swipe on a grid that lives inside a normally-scrolling tab) for
// a cosmetic flourish. Touch instead gets one fixed "pressed" tilt applied
// for the duration of the touch (pointerdown -> pointerup/cancel), which
// bubbles normally and never needs preventDefault — same 3D depth cue,
// none of the scroll hijacking.
function initMilestoneTilt() {
  const TILT_MAX_DEG = 9;
  // Delegated on the groups container — it survives every re-render (the
  // per-group <ul>s inside it are what get rebuilt), and one listener covers
  // every badge in every group.
  const list = el("milestones-groups");
  let activeCard = null;

  const resetTilt = (card) => {
    card.style.transform = "";
    card.classList.remove("tilting");
  };

  list.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    const card = e.target.closest(".milestone-badge");
    if (card !== activeCard) {
      if (activeCard) resetTilt(activeCard);
      activeCard = card;
    }
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    card.classList.add("tilting");
    card.style.transform = `perspective(700px) rotateX(${(-py * TILT_MAX_DEG).toFixed(2)}deg) rotateY(${(px * TILT_MAX_DEG).toFixed(2)}deg) scale3d(1.04, 1.04, 1.04)`;
  });
  list.addEventListener("pointerleave", () => {
    if (activeCard) resetTilt(activeCard);
    activeCard = null;
  });

  list.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    const card = e.target.closest(".milestone-badge");
    if (!card) return;
    // Fixed tilt direction (there's no live finger position to track — see
    // this function's own comment above) so every touched card pops the
    // same visible amount regardless of exactly where it was touched.
    card.classList.add("tilting");
    card.style.transform = "perspective(700px) rotateX(-6deg) rotateY(6deg) scale3d(1.05, 1.05, 1.05)";
  });
  const releaseTouch = (e) => {
    if (e.pointerType !== "touch") return;
    const card = e.target.closest(".milestone-badge");
    if (card) resetTilt(card);
  };
  list.addEventListener("pointerup", releaseTouch);
  list.addEventListener("pointercancel", releaseTouch);
}

// ---------------------------------------------------------------------------
// Muscle Heatmap (Phase 3) — a 7-day set-count per training category, read
// straight off workout_sets.category (the same coarse Chest/Back/Legs/
// Shoulders/Arms/Core vocabulary backend/services/workout_service.py's
// BASE_MET_BY_CATEGORY already keys off, snapshotted onto each set at log
// time). Sets, not tonnage (weight x reps), are the volume proxy — the same
// choice openGym's own muscle map makes, and the only one that still counts
// bodyweight work (weight_kg=0) as real training instead of zero volume.
// Cardio/full-body sets exist in the data but aren't a muscle-group signal,
// so they're simply not in this list — excluded, not zeroed.
// ---------------------------------------------------------------------------
// The 6 categories themselves now live in exerciseI18n.js's MUSCLE_GROUPS —
// the same list exerciseSearch.js's custom-exercise muscle-group picker
// offers, so a custom exercise's chosen category always lands on one of
// this heatmap's own bars instead of silently falling outside it.
const MUSCLE_HEATMAP_CATEGORIES = MUSCLE_GROUPS;
const MUSCLE_HEATMAP_WINDOW_DAYS = 7;

// Pure and synchronous — at the data sizes this app ever sees (a few
// hundred cached sets at most), one O(n) pass is sub-millisecond, nowhere
// near enough to justify an async chunking or worker-based split that would
// only add complexity without a measurable frame-budget win.
function computeMuscleHeatmap(sets) {
  const cutoff = Date.now() - MUSCLE_HEATMAP_WINDOW_DAYS * 86400000;
  const counts = Object.fromEntries(MUSCLE_HEATMAP_CATEGORIES.map((c) => [c, 0]));
  for (const s of sets || []) {
    if (new Date(s.logged_at).getTime() < cutoff) continue;
    const cat = MUSCLE_HEATMAP_CATEGORIES.find((c) => c.toLowerCase() === (s.category || "").toLowerCase());
    if (cat) counts[cat]++;
  }
  const max = Math.max(0, ...Object.values(counts));
  return { counts, max };
}

function renderMuscleHeatmap(sets) {
  const { counts, max } = computeMuscleHeatmap(sets);
  const empty = el("muscle-heatmap-empty");
  const bars = el("muscle-heatmap-bars");
  const hint = el("muscle-heatmap-hint");
  if (max === 0) {
    empty.hidden = false;
    bars.hidden = true;
    hint.hidden = true;
    return;
  }
  empty.hidden = true;
  bars.hidden = false;
  // One replaceChildren batch, not per-row appendChild calls — the whole
  // list is at most 6 rows and changes at most once per Progress-tab
  // render, so there's no meaningful cost difference either way, but this
  // matches the reconciliation shape the rest of this app's list renders
  // already use.
  bars.replaceChildren(
    ...MUSCLE_HEATMAP_CATEGORIES.map((cat) => {
      const count = counts[cat];
      const pct = max ? count / max : 0;
      const row = document.createElement("div");
      row.className = count === 0 ? "muscle-heatmap-row is-zero" : "muscle-heatmap-row";
      row.innerHTML = `
        <span class="muscle-heatmap-name">${escapeHtml(t(`progress.muscleGroup${cat}`))}</span>
        <div class="bar-track"><div class="bar-fill fill-workout" style="transform:scaleX(${pct})"></div></div>
        <span class="muscle-heatmap-count mono">${escapeHtml(t("progress.muscleHeatmapSets", { count }))}</span>
      `;
      return row;
    }),
  );
  const neglected = MUSCLE_HEATMAP_CATEGORIES.filter((c) => counts[c] === 0);
  if (neglected.length) {
    hint.hidden = false;
    hint.textContent = t("progress.muscleHeatmapNeglected", {
      names: neglected.map((c) => t(`progress.muscleGroup${c}`)).join(", "),
    });
  } else {
    hint.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — the bento + the shared detail sheet.
//
// Four glanceable .glass-strong tiles below the hero (renderBento): the
// resting tile answers "am I on track for <domain>?" with no tap. Tapping a
// tile opens #progress-detail-sheet (openProgressDetail) and renders that
// domain's full charts/lists (renderDetailSection) — the ONLY place the
// heavy SVG charts draw, and only once they're on screen at a real width.
// Everything reads the same module caches renderFromCache keeps fresh, so a
// tile and its sheet can't disagree.
// ---------------------------------------------------------------------------

// 7 thin bars into #bento-cal-spark (viewBox 0 0 112 30). Under/over target
// tinting mirrors the full calorie chart; an unlogged day is a 2px stub so
// the week still reads as seven days.
function drawBentoSparkline(svg, days, targetCalories) {
  const n = days.length || 1;
  const gap = 3;
  const w = (112 - gap * (n - 1)) / n;
  const maxVal = Math.max(targetCalories, ...days.map((d) => d.calories), 1) * 1.1;
  svg.replaceChildren(
    ...days.map((d, i) => {
      const h = d.calories > 0 ? Math.max((d.calories / maxVal) * 30, 2) : 2;
      return svgEl("rect", {
        x: (i * (w + gap)).toFixed(2),
        y: (30 - h).toFixed(2),
        width: Math.max(w, 1).toFixed(2),
        height: h.toFixed(2),
        rx: 1.5,
        class: d.calories > targetCalories ? "bento-spark-bar over" : d.calories > 0 ? "bento-spark-bar" : "bento-spark-bar empty",
      });
    }),
  );
}

function renderBento() {
  if (!lastTrends) return;
  const days = lastTrends.days;
  const targets = currentTargets;
  const targetCalories = targets?.daily_calories || 2000;
  const loggedDays = days.filter((d) => d.calories > 0);

  // --- Calories: weekly average of logged days + a 7-bar sparkline ---
  const calMain = el("bento-cal-value").parentElement;
  const calSpark = el("bento-cal-spark");
  if (loggedDays.length) {
    const avg = Math.round(loggedDays.reduce((s, d) => s + d.calories, 0) / loggedDays.length);
    el("bento-cal-value").textContent = avg.toLocaleString();
    el("bento-cal-unit").textContent = t("progress.bentoCalUnit", { target: Math.round(targetCalories).toLocaleString() });
    drawBentoSparkline(calSpark, days, targetCalories);
    el("bento-cal-empty").hidden = true;
    calMain.hidden = false;
    calSpark.hidden = false;
  } else {
    el("bento-cal-empty").hidden = false;
    calMain.hidden = true;
    calSpark.hidden = true;
  }

  // --- Macros: 4 mini bars, avg % of target this week ---
  const macroRows = el("bento-macro-rows");
  if (loggedDays.length && targets) {
    const stats = computeMacroWeeklyStats(days, targets, lastLogs);
    const letters = { protein: "P", carbs: "C", fats: "F", fiber: "Fb" };
    macroRows.replaceChildren(
      ...stats.map((row) => {
        const r = document.createElement("span");
        r.className = "bento-macro-row";
        const lab = document.createElement("span");
        lab.className = "bento-macro-letter mono";
        lab.textContent = letters[row.key] || row.key;
        const track = document.createElement("span");
        track.className = "bento-macro-track";
        const fill = document.createElement("span");
        fill.className = "bento-macro-fill";
        fill.dataset.macro = row.key;
        fill.style.transform = `scaleX(${Math.max(0, Math.min(1, row.pct / 100)).toFixed(3)})`;
        track.appendChild(fill);
        const pct = document.createElement("span");
        pct.className = "bento-macro-pct mono";
        pct.textContent = row.loggedCount > 0 ? `${row.pct}%` : "—";
        r.append(lab, track, pct);
        return r;
      }),
    );
    el("bento-macro-empty").hidden = true;
    macroRows.hidden = false;
  } else {
    macroRows.replaceChildren();
    el("bento-macro-empty").hidden = false;
    macroRows.hidden = true;
  }

  // --- Weight: latest weigh-in + smoothed trend direction ---
  const wMain = el("bento-weight-value").parentElement;
  const wSub = el("bento-weight-sub");
  if (lastWeights && lastWeights.length) {
    el("bento-weight-value").textContent = `${lastWeights[0].weight_kg} kg`;
    const v = computeWeightVerdict([...lastWeights].reverse());
    if (v.kind === "insufficient") {
      wSub.textContent = "";
      wSub.dataset.dir = "none";
    } else if (v.kind === "steady") {
      wSub.textContent = t("progress.noChange");
      wSub.dataset.dir = "steady";
    } else {
      const sign = v.ratePerWeek > 0 ? "+" : "";
      wSub.textContent = `${v.kind === "down" ? "↓" : "↑"} ${t("progress.weightTrendRate", { rate: `${sign}${v.ratePerWeek}` })}`;
      wSub.dataset.dir = v.kind;
    }
    el("bento-weight-empty").hidden = true;
    wMain.hidden = false;
    wSub.hidden = false;
  } else {
    el("bento-weight-empty").hidden = false;
    wMain.hidden = true;
    wSub.hidden = true;
  }

  // --- Training: sessions this week + least-trained muscle group ---
  const tMain = el("bento-training-value").parentElement;
  const tSub = el("bento-training-sub");
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 6);
  const weekAgoIso = `${weekAgo.getFullYear()}-${String(weekAgo.getMonth() + 1).padStart(2, "0")}-${String(weekAgo.getDate()).padStart(2, "0")}`;
  const weekSessions = getCachedSessions().filter((s) => s.session_date >= weekAgoIso).length;
  if (weekSessions > 0) {
    el("bento-training-value").textContent = t("progress.bentoTrainingWeek", { count: weekSessions });
    const { counts } = computeMuscleHeatmap(getCachedSets());
    const neglected = MUSCLE_HEATMAP_CATEGORIES.filter((c) => counts[c] === 0);
    tSub.textContent = neglected.length
      ? t("progress.bentoTrainingFocus", { name: t(`progress.muscleGroup${neglected[0]}`) })
      : t("progress.bentoTrainingBalanced");
    el("bento-training-empty").hidden = true;
    tMain.hidden = false;
    tSub.hidden = false;
  } else {
    el("bento-training-empty").hidden = false;
    tMain.hidden = true;
    tSub.hidden = true;
  }
}

// Which detail sheet section (if any) is on screen right now — used by
// renderFromCache to keep an open sheet live after a food log.
function detailSheetOpenKey() {
  if (el("progress-detail-sheet").hidden) return null;
  const shown = document.querySelector("#progress-detail-sheet .progress-detail-section:not([hidden])");
  return shown ? shown.dataset.section : null;
}

const DETAIL_CONFIG = {
  calories: { titleKey: "progress.calorieTrendTitle", infoKey: "calories" },
  macros: { titleKey: "progress.macroHeatmapTitle", infoKey: "macros" },
  weight: { titleKey: "progress.weightSectionTitle", infoKey: "weight" },
  training: { titleKey: "progress.groupTraining", infoKey: "workout" },
};

// Draws one detail section's real charts/lists. Idempotent and cheap to
// re-call (every chart fn here self-skips when its data + width are
// unchanged). Runs synchronously on sheet-open (openSheet un-hides + lays
// out the sheet in the same task, so a getBoundingClientRect read here
// already sees a real width), again on the next frame once layout settles,
// and again from renderFromCache for as long as the sheet stays open so a
// live food log keeps it current.
function renderDetailSection(key) {
  if (!lastTrends) return;
  const targetCalories = currentTargets?.daily_calories || 2000;
  const { freezeAppliedDate } = computeStreakWithFreeze(lastTrends.days);
  if (key === "calories") {
    renderCalorieChart(lastTrends.days, targetCalories);
    renderDayHistory(lastTrends.days, targetCalories, freezeAppliedDate);
  } else if (key === "macros") {
    renderMacroConsistency(lastTrends.days, currentTargets, lastLogs);
    if (lastLogs) renderTopFoods(lastLogs);
  } else if (key === "weight") {
    if (lastWeights) renderWeightSection(lastWeights);
    if (lastMeasurements) renderMeasurementsSection(lastMeasurements);
  } else if (key === "training") {
    renderMuscleHeatmap(getCachedSets());
  }
}

// Wired in app.js to refresh the analytics blocks (Adaptive goals in the
// Calories sheet, Weight forecast in the Weight sheet) when their sheet opens.
let onDetailSheetOpenCb = null;

function openProgressDetail(key) {
  const cfg = DETAIL_CONFIG[key];
  if (!cfg) return;
  document.querySelectorAll("#progress-detail-sheet .progress-detail-section").forEach((s) => {
    s.hidden = s.dataset.section !== key;
  });
  el("progress-detail-title").textContent = t(cfg.titleKey);
  el("progress-detail-info-btn").dataset.infoKey = cfg.infoKey;
  openSheet("progress-detail-sheet");
  renderDetailSection(key); // sync — the sheet is already laid out at a real width
  requestAnimationFrame(() => renderDetailSection(key)); // re-measure once settled
  onDetailSheetOpenCb?.(key); // analytics (adaptive / forecast) refresh — once per open
}

function initBento() {
  initProgressScrollBlurPause();
  el("progress-bento").addEventListener("click", (e) => {
    const tile = e.target.closest(".bento-tile");
    if (!tile) return;
    openProgressDetail(tile.dataset.detail);
    vibrate(8);
  });
  el("progress-detail-info-btn").addEventListener("click", () => {
    const key = el("progress-detail-info-btn").dataset.infoKey;
    if (key) openCardInfo(key);
  });
}

function renderFromCache() {
  if (!lastTrends) return;
  // First real paint (from cache or from a fresh fetch) — drop the skeleton
  // shown until now (a brief fade, not an instant cut — see fadeOutSkeleton's
  // own comment in ui.js). Idempotent (safe to call again on every later
  // call), mirrors app.js's render()/#dashboard-skeleton.
  fadeOutSkeleton("progress-skeleton");
  const targetCalories = currentTargets?.daily_calories || 2000;
  // The server streak is still computed — milestones (streak3/streak7/
  // wellRounded), the consistency score, and Daily History's frozen-day
  // marker all still read it — it just no longer has a card of its own.
  // Momentum (the new hero) is a separate, more forgiving read of the same
  // days array; see computeMomentum above.
  const { streak, freezeAppliedDate } = computeStreakWithFreeze(lastTrends.days);
  renderMomentumZone(lastTrends.days, currentTargets, freezeAppliedDate);
  // Zone 2 — record the week if a new one has begun, then paint the check-in
  // card + the rack. maybeSnapshotWeek is a cheap no-op except once a week.
  weekHistory.maybeSnapshotWeek(lastTrends.days, currentTargets);
  renderSundayCheckin();
  renderPastWeeks();
  const waterStreak = computeConsecutiveStreak(lastTrends.days, "water_ml", currentTargets?.daily_water_ml);
  el("progress-retention-note").textContent = t("progress.retentionNote", { days: lastTrends.days.length });
  // Phase 2 — the heavy per-domain views (calorie / weight / measurement
  // charts, macro rows, daily history, muscle heatmap, top foods, analytics)
  // render inside #progress-detail-sheet only, on tile tap — see
  // openProgressDetail / renderDetailSection. They cost nothing on a plain
  // tab paint now. renderBento() paints the always-visible glanceable
  // summary tiles; renderDetailSection re-runs for whichever detail sheet is
  // open so a live food log still updates it.
  const cachedWorkoutSessions = getCachedSessions();
  const cachedWorkoutSets = getCachedSets();
  lastMilestoneStats = {
    streak,
    logsCount: lastLogs?.length || 0,
    weighInsCount: lastWeights?.length || 0,
    measurementsCount: lastMeasurements?.length || 0,
    savedMealsCount: lastSavedMeals?.length || 0,
    workoutsCount: cachedWorkoutSessions.length,
    totalVolumeKg: cachedWorkoutSets.reduce((sum, s) => sum + (s.weight_kg || 0) * (s.reps || 0), 0),
    balancedDaysCount: countBalancedDays(lastTrends.days, currentTargets),
    fiberStreak: computeConsecutiveStreak(alignDailyFiberTotals(lastTrends.days, lastLogs), "fiber", currentTargets?.daily_fiber, FIBER_TOLERANCE),
    waterStreak,
    ollieTapCount: getOllieTapCount(),
    petCareStreak: computePetCareStreak(lastTrends.days, currentTargets),
  };
  renderMilestones(lastMilestoneStats);
  el("consistency-score-stat").textContent = t("progress.consistencyScore", {
    score: computeConsistencyScore(lastTrends.days, streak),
  });
  renderTargetReviewBanner(lastTrends.days, targetCalories);
  renderBento();
  // Keep the AI Coach's weight-forecast context fresh even when the user
  // never opens the Weight detail sheet (renderWeightSection sets the same
  // thing, but that only runs on sheet-open now).
  if (lastWeights?.length) setAiCoachContext({ weightForecast: computeWeightForecast([...lastWeights].reverse()) });
  // A live food log (app.js render() -> syncLiveTotals) re-runs this — if a
  // detail sheet is open, re-render its section so the chart/list inside
  // stays in sync too.
  const openDetail = detailSheetOpenKey();
  if (openDetail) renderDetailSection(openDetail);
  // Food suggestions are no longer driven from here — see suggestions.js's
  // own module docstring for why sourcing "remaining budget" from GET
  // /trends (a separate, laggy network round trip) instead of the app's
  // already-live state.logs was the root cause of that card going stale.
  // app.js's render() now pushes it fresh via setSuggestionsContext on every
  // relevant state change instead, so there's nothing to do here for that
  // half.
}

// Keeps Daily History's per-day totals — and everything else derived from
// lastTrends.days below (the calorie chart, macro consistency, streak,
// milestones) — in sync with a food log add/edit/delete for ANY date in the
// retention window, not just today. Previously this only refreshed on the
// next full Progress-tab visit (a real GET /trends round trip triggered by
// renderProgress below), so backdating a meal from Daily History's own
// day-detail sheet left that day's rolled-up card — and everything computed
// from it — visibly stale until the user left and re-entered the tab.
// `logs` is app.js's own state.logs, already the full retention window (see
// GET /logs' own doc comment in CLAUDE.md), so this re-runs the exact same
// per-date aggregation compute_trends does server-side
// (backend/services/trends_service.py) against data already sitting in
// memory, instead of waiting on a network fetch to learn something the app
// already knows — same read-time-aggregation philosophy as that function,
// just client-side. A no-op until the Progress tab has been visited at
// least once (lastTrends starts null) — nothing cached yet to patch.
export function syncLiveTotals(logs) {
  lastLogs = logs;
  if (!lastTrends) return;
  const targetCalories = currentTargets?.daily_calories || 0;
  const byDate = new Map();
  logs.forEach((log) => {
    const acc = byDate.get(log.log_date) || { calories: 0, protein: 0, carbs: 0, fats: 0 };
    acc.calories += log.calories;
    acc.protein += log.protein;
    acc.carbs += log.carbs;
    acc.fats += log.fats;
    byDate.set(log.log_date, acc);
  });
  lastTrends.days.forEach((day) => {
    const acc = byDate.get(day.date);
    day.calories = acc?.calories || 0;
    day.protein = acc?.protein || 0;
    day.carbs = acc?.carbs || 0;
    day.fats = acc?.fats || 0;
    // Mirrors ADHERENCE_TOLERANCE exactly (backend/services/trends_service.py)
    // via this file's own TARGET_TOLERANCE above, so a locally patched day
    // never disagrees with what a real GET /trends would compute for the
    // same underlying rows.
    day.adherent = byDate.has(day.date) && Math.abs(day.calories - targetCalories) <= targetCalories * TARGET_TOLERANCE;
  });
  renderFromCache();
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
    const [trends, weights, measurements] = await Promise.all([
      api.getTrends(),
      api.listWeight(),
      api.listMeasurements(),
      loadWorkoutSessions(),
    ]);
    lastTrends = trends;
    lastWeights = weights;
    lastMeasurements = measurements;
    // Deferred (not called directly) — this fetch is started the instant
    // app.js's initTabSwipe knows a drag is heading toward this tab, so it
    // can resolve at any point during a slow drag, including while the view
    // is still being live-dragged around the screen (position: absolute +
    // a per-frame transform). Rewriting its DOM at that exact moment would
    // be a visible flicker mid-gesture and would invalidate the height
    // already pinned for the drag. runOrDeferDuringSwipe (ui.js) queues
    // this to run the instant the drag settles instead, or right away if
    // there's no drag in progress at all (the normal tap-to-switch path).
    //
    // syncLiveTotals(lastLogs), NOT a bare renderFromCache: GET /trends is
    // the server's snapshot and it can lag an optimistic add/delete the
    // client already applied (log food, immediately open Progress → the POST
    // may not have landed yet). Re-applying the app's live state.logs onto
    // the fresh trends here means the Momentum hero / calorie chart / macro
    // rows / daily history reflect what the user just did, and never get
    // stuck showing the pre-log numbers until the next mutation. Same
    // reconciliation render() already runs on every mutation — it patches
    // calories/protein/carbs/fats/adherent per day and leaves the server's
    // weight/water/burned values untouched. Falls back to a plain
    // renderFromCache the rare time no logs have been handed in yet.
    runOrDeferDuringSwipe(() => (lastLogs ? syncLiveTotals(lastLogs) : renderFromCache()));
  } catch (err) {
    // A cache hit already means the user is looking at the last-known-good
    // data; a background refresh that fails silently (e.g. a flaky
    // connection) shouldn't interrupt that with an error toast over content
    // that's still perfectly valid. Only surface the error when there was
    // nothing to fall back to, and never for a silent boot-time warm-up.
    if (!hadCache && !silent) showToast(err.message || t("toast.someDataFailed"), "error");
  }
}

// Pauses this tab's `.glass` backdrop-filter blur (see style.css's
// `#view-progress.progress-scrolling` rule) for the real, short window this
// tab is actually being scrolled. Independent of the accordion FLIP above —
// this is ongoing per-scroll-frame cost from resampling ~9 stacked blur
// surfaces against content moving underneath them, not a one-off toggle
// cost. `#app` (not `#view-progress`) is the app's one real scroll
// container — see scrollProgress.js's identical note — so the listener has
// to live there; the `view.hidden` check is what keeps it a no-op on every
// other tab.
let progressScrollSettleTimer = null;
function initProgressScrollBlurPause() {
  const app = document.getElementById("app");
  const view = el("view-progress");
  app.addEventListener(
    "scroll",
    () => {
      if (view.hidden) return;
      view.classList.add("progress-scrolling");
      clearTimeout(progressScrollSettleTimer);
      progressScrollSettleTimer = setTimeout(() => view.classList.remove("progress-scrolling"), 150);
    },
    { passive: true },
  );
}

// "About this card" info sheet — one shared sheet (#card-info-sheet-overlay
// in index.html), populated per metric from this dictionary rather than one
// sheet per card, so adding a new metric's explanation is a content-only
// change. Each entry's icon SVG mirrors that same metric's own
// .card-icon-badge markup on its card header, and `accent` matches the
// data-accent value already used there (.card-icon-badge[data-accent=...]
// in style.css), so the sheet's icon reads as a continuation of the card
// that opened it rather than a generic popup. The actual English/Romanian
// copy lives in i18n.js under `cardInfo.<key>.title` / `.body`.
const CARD_INFO = {
  streak: {
    accent: "streak",
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5c1.2 3 4.3 4.8 4.3 8.7a4.3 4.3 0 01-8.6 0c0-1.7.9-2.6 1.7-3.5-.1 1.4.7 2 1.5 1.5-.8-2.1.2-4.7 1.1-6.7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  },
  calories: {
    accent: "calories",
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5c1.2 3 4.3 4.8 4.3 8.7a4.3 4.3 0 01-8.6 0c0-1.7.9-2.6 1.7-3.5-.1 1.4.7 2 1.5 1.5-.8-2.1.2-4.7 1.1-6.7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  },
  macros: {
    accent: "macros",
    icon: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M12 4v8h8" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  },
  history: {
    accent: "history",
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 12a8 8 0 118 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 6v4.5h4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8v4.5l3 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  adaptive: {
    accent: "adaptive",
    icon: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3.5" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>',
  },
  foods: {
    accent: "foods",
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 19V10M12 19V5M19 19v-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  },
  workout: {
    accent: "workout",
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 10v4M2.5 9v6M7 8v8M17 8v8M19.5 9v6M21.5 10v4M7 12h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  muscleHeatmap: {
    accent: "workout",
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5c1.2 3 4.3 4.8 4.3 8.7a4.3 4.3 0 01-8.6 0c0-1.7.9-2.6 1.7-3.5-.1 1.4.7 2 1.5 1.5-.8-2.1.2-4.7 1.1-6.7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  },
  forecast: {
    accent: "forecast",
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 19l5-6 4 3 6-8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 8h4v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  weight: {
    accent: "weight",
    icon: '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" stroke-width="1.6"/><path d="M12 9v3l2 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  measurements: {
    accent: "measurements",
    icon: '<svg viewBox="0 0 24 24" fill="none"><rect x="8" y="3" width="8" height="18" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M8 7.5h3M8 11.5h4M8 15.5h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  },
  achievements: {
    accent: "achievements",
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l1.8 5.6L19.5 10l-5.7 1.4L12 17l-1.8-5.6L4.5 10l5.7-1.4L12 3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  },
};

// Tracked so a language switch (Settings) made while this sheet happens to
// be open re-renders its copy immediately, same as every other module that
// registers onLanguageChange() for its own dynamic (non data-i18n) text.
let openCardInfoKey = null;

function renderCardInfoSheet() {
  if (!openCardInfoKey) return;
  el("card-info-sheet-title").textContent = t(`cardInfo.${openCardInfoKey}.title`);
  el("card-info-sheet-body").textContent = t(`cardInfo.${openCardInfoKey}.body`);
}

// Opens the shared "About this card" sheet for one CARD_INFO key. Called
// both by the delegated .card-info-btn listener inside #view-progress (the
// Milestones ⓘ) and directly by the detail sheet's own ⓘ (#progress-detail-
// info-btn, wired in initBento) — that button lives outside #view-progress.
function openCardInfo(key) {
  if (!CARD_INFO[key]) return;
  openCardInfoKey = key;
  const iconEl = el("card-info-sheet-icon");
  iconEl.className = "card-info-sheet-icon card-icon-badge";
  iconEl.dataset.accent = CARD_INFO[key].accent;
  iconEl.innerHTML = CARD_INFO[key].icon;
  renderCardInfoSheet();
  openSheet("card-info-sheet-overlay");
  vibrate(8);
}

function initCardInfoSheets() {
  el("view-progress").addEventListener("click", (e) => {
    const btn = e.target.closest(".card-info-btn");
    if (!btn) return;
    e.stopPropagation();
    openCardInfo(btn.dataset.infoKey);
  });
  onLanguageChange(renderCardInfoSheet);
}

// `onLogSuggestedMeal(meal)`: app.js owns the optimistic saved-meal logger
// (logSavedMealOptimistic) — this module only looks the meal up by id from
// its own lastSavedMeals cache and hands the object off, same dependency-
// injection pattern as onDayClick above and initScan's logNewFood in app.js.
export function initProgress({ onDayClick, onLogSuggestedMeal, onDetailSheetOpen } = {}) {
  onDetailSheetOpenCb = onDetailSheetOpen || null;
  initBento();
  initPulse();
  initCardInfoSheets();

  initSuggestions({
    onLogFood: (mealId) => {
      const meal = (lastSavedMeals || []).find((m) => m.id === mealId);
      if (meal) onLogSuggestedMeal?.(meal);
    },
  });

  initCollapsibleListToggles([
    ["top-foods-list", "top-foods-list-toggle"],
    ["day-history-list", "day-history-list-toggle"],
    ["weight-list", "weight-list-toggle"],
    ["measurement-list", "measurement-list-toggle"],
  ]);

  el("sunday-checkin-dismiss").addEventListener("click", dismissSundayCheckin);

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

  // Tap (or keyboard-activate, since badges are role="button") any milestone —
  // earned or locked — to see its requirement, earned state, and exact
  // progress toward it.
  const openMilestoneFromEvent = (e) => {
    const badge = e.target.closest(".milestone-badge");
    if (!badge || !lastMilestoneStats) return;
    renderMilestoneDetail(badge.dataset.key, lastMilestoneStats);
  };
  el("milestones-groups").addEventListener("click", openMilestoneFromEvent);
  el("milestones-groups").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openMilestoneFromEvent(e);
  });
  initMilestoneTilt();

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

  onLanguageChange(renderFromCache);
}
