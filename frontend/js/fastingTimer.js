// Intermittent Fasting timer — a fully client-side dashboard widget. State
// (which phase, when it started, the fasting goal) lives only in
// localStorage (STORAGE_KEY below): no backend route, no network call,
// works offline, and never waits on loadAll() the way every server-backed
// dashboard card does — it renders the instant the DOM exists.
//
// Two phases, one physical ring: "fasting" (the front face, violet->pink
// gradient, fills toward the selected goal) and "eating" (the back face,
// amber->rose gradient, fills toward the complementary window — 24 minus the
// fasting goal). Only one phase is ever "live" at a time; the other face
// shows a reset/idle ring rather than stale data, since it has no active
// session of its own to report (see render()'s fastingElapsedMs/
// eatingElapsedMs split).
import { onLanguageChange, t } from "./i18n.js?v=20260818b";
import { getActivePillType, openSheet, resetPillTabs, vibrate, wirePillTabs } from "./ui.js?v=20260818b";

const el = (id) => document.getElementById(id);
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const STORAGE_KEY = "ironlog_fasting_state";
const RING_CIRCUMFERENCE = 2 * Math.PI * 88; // matches r="88" in the SVG (same geometry as the main calorie ring)
const MS_PER_HOUR = 3600000;
const VALID_GOAL_HOURS = [16, 18, 20];
const DEFAULT_GOAL_HOURS = 16;

// Swapped on the toggle button's own icon (play triangle <-> stop square) —
// see render()'s btn wiring below.
const PLAY_ICON_PATH = "M8 5v14l11-7-11-7z";
const STOP_ICON_PATH = "M7 6h10a1 1 0 011 1v10a1 1 0 01-1 1H7a1 1 0 01-1-1V7a1 1 0 011-1z";

// How long the header button's tap flourish (style.css's #fasting-header-btn
// .pulse) gets to actually be seen before the sheet's slide-up covers it —
// same idiom and duration as app.js's own ICON_BTN_PRESS_ANIMATION_MS for
// #settings-btn.
const HEADER_BTN_PRESS_ANIMATION_MS = 220;

const pad2 = (n) => String(n).padStart(2, "0");
const clamp01 = (n) => Math.min(Math.max(n, 0), 1);

function formatDuration(ms) {
  const totalSeconds = Math.max(Math.floor(ms / 1000), 0);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function loadState() {
  let parsed;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    parsed = null;
  }
  const goalHours = VALID_GOAL_HOURS.includes(parsed?.goalHours) ? parsed.goalHours : DEFAULT_GOAL_HOURS;
  const phase = parsed?.phase === "fasting" ? "fasting" : "eating";
  // A corrupt/foreign value here would otherwise silently produce a NaN
  // elapsed-time everywhere downstream — startedAt is only ever trusted if
  // it's a real, past timestamp.
  const startedAt = Number.isFinite(parsed?.startedAt) && parsed.startedAt <= Date.now() ? parsed.startedAt : null;
  return { phase, startedAt, goalHours };
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage can throw in some locked-down/private-browsing contexts —
       the timer still works for the rest of this session, it just won't
       survive a reload. Same accepted gap as every other localStorage write
       in this app (see app.js's theme/auto-balance persistence). */
  }
}

let state = { phase: "eating", startedAt: null, goalHours: DEFAULT_GOAL_HOURS };

function setRingProgress(ringEl, pct) {
  ringEl.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  ringEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - pct));
}

function render() {
  const now = Date.now();
  const elapsedMs = state.startedAt ? Math.max(now - state.startedAt, 0) : 0;
  // Only the currently-live phase gets a real elapsed value — the other
  // face has no session of its own right now, so it stays at a clean,
  // reset-looking zero rather than showing a frozen number from whenever it
  // was last active (which would misleadingly look "live" while hidden
  // behind the flip, including for the instant it's edge-on mid-flip).
  const fastingElapsedMs = state.phase === "fasting" ? elapsedMs : 0;
  const eatingElapsedMs = state.phase === "eating" ? elapsedMs : 0;

  const goalMs = state.goalHours * MS_PER_HOUR;
  const windowHours = Math.max(24 - state.goalHours, 1);
  const windowMs = windowHours * MS_PER_HOUR;

  // Fasting face
  setRingProgress(el("fasting-ring-fasting"), clamp01(fastingElapsedMs / goalMs));
  el("fasting-time-fasting").textContent = formatDuration(fastingElapsedMs);
  const goalReached = state.phase === "fasting" && fastingElapsedMs >= goalMs;
  el("fasting-sub-fasting").textContent = goalReached
    ? t("fasting.goalReachedSub")
    : t("fasting.goalSub", { hours: state.goalHours });
  el("fasting-face-fasting").classList.toggle("goal-reached", goalReached);

  // Eating face
  setRingProgress(el("fasting-ring-eating"), clamp01(eatingElapsedMs / windowMs));
  el("fasting-time-eating").textContent = formatDuration(eatingElapsedMs);
  const isIdle = state.phase === "eating" && !state.startedAt;
  const windowClosed = state.phase === "eating" && state.startedAt && eatingElapsedMs >= windowMs;
  el("fasting-sub-eating").textContent = windowClosed
    ? t("fasting.windowClosedSub")
    : isIdle
      ? t("fasting.idleSub")
      : t("fasting.windowSub", { hours: windowHours });
  el("fasting-face-eating").classList.toggle("window-closed", windowClosed);

  // Toggle button — colored and iconed to match whichever face is CURRENTLY
  // showing (see .fasting-toggle-btn.phase-* in style.css), not the action
  // about to happen.
  const btn = el("fasting-toggle-btn");
  const isFasting = state.phase === "fasting";
  btn.classList.toggle("phase-fasting", isFasting);
  btn.classList.toggle("phase-eating", !isFasting);
  el("fasting-toggle-label").textContent = t(isFasting ? "fasting.endBtn" : "fasting.startBtn");
  el("fasting-toggle-icon-path").setAttribute("d", isFasting ? STOP_ICON_PATH : PLAY_ICON_PATH);

  // The header entry point's own "something's running" cue (see
  // .fasting-header-btn.fast-active in style.css) — deliberately only lit
  // for the fasting phase, not the eating window too, since an eating
  // window is the default/idle state most of the day and would make the
  // dot mean "almost always on" instead of "a fast is actively running".
  el("fasting-header-btn").classList.toggle("fast-active", isFasting);
}

// ---------------------------------------------------------------------------
// Tick lifecycle — THE fix for the "Stop doesn't actually stop" bug. There
// are two distinct problems this section solves, not one:
//
// 1. State: the old toggleFast() always wrote a fresh `startedAt: Date.now()`
//    on every toggle, fasting OR eating. So hitting "Stop" while fasting
//    didn't return to a neutral, inactive baseline — it silently *started* a
//    brand new live session for the eating phase instead, which is exactly
//    why the timer looked like it "restarted" or "kept running in the
//    background" after Stop. stopFast() below is the fix: it writes a clean
//    { phase: "eating", startedAt: null } baseline — no session of any kind
//    is live after Stop, full stop (pun intended). Only startFast() ever
//    writes a fresh startedAt now.
// 2. Interval: render() was on an unconditional setInterval for the module's
//    entire lifetime, ticking once a second forever regardless of whether
//    anything was actually running — harmless-looking (it's idempotent) but
//    exactly the "leftover active loop" pattern that makes this class of bug
//    easy to reintroduce, and pure waste while idle (the eating-idle face
//    never changes second to second, there's nothing to redraw). syncTick()
//    below starts/stops the interval based on live state instead, so it's
//    a hard invariant — not just a convention — that this widget "only ever
//    ticks when explicitly started".
// ---------------------------------------------------------------------------
let tickHandle = null;

function startTick() {
  if (tickHandle) return; // already ticking — never stack a second interval
  tickHandle = setInterval(render, 1000);
}

function stopTick() {
  if (!tickHandle) return;
  clearInterval(tickHandle);
  tickHandle = null;
}

// The single source of truth for "should the once-a-second loop be running
// right now" — called after every state change (start, stop, and on initial
// load) instead of each call site guessing independently.
function syncTick() {
  if (state.phase === "fasting" && state.startedAt) {
    startTick();
  } else {
    stopTick();
  }
}

// Small transform-only "pop" on the toggle button's own icon, retriggered on
// every start/stop — purely a visual confirmation that the tap actually
// registered a state change (the icon itself already swaps play<->stop), so
// the fix above is felt, not just correct. Skipped under reduced-motion,
// same as the header button's flourish below.
function popToggleIcon() {
  if (prefersReducedMotion) return;
  const icon = el("fasting-toggle-icon");
  icon.classList.remove("icon-pop");
  void icon.offsetWidth;
  icon.classList.add("icon-pop");
}

function startFast() {
  state = { phase: "fasting", startedAt: Date.now(), goalHours: state.goalHours };
  saveState(state);
  // The flip itself — .flipped rotates the whole card 180deg, revealing
  // whichever face matches the new phase. Set here (not inside render(),
  // which runs every second) so it only ever fires on a genuine phase
  // change, never gets re-applied redundantly on every tick.
  el("fasting-flip-inner").classList.remove("flipped"); // show the fasting (front) face
  syncTick();
  render();
}

function stopFast() {
  // The actual bug fix: a full reset to a clean, inactive baseline — NOT a
  // toggle into a freshly-"started" eating-window session. See the tick
  // lifecycle comment above for the full story.
  state = { phase: "eating", startedAt: null, goalHours: state.goalHours };
  saveState(state);
  el("fasting-flip-inner").classList.add("flipped"); // show the eating (back) face, idle
  syncTick(); // stops the interval — nothing left running to tick
  render();
}

export function initFastingTimer() {
  state = loadState();
  resetPillTabs("fasting-goal-tabs", String(state.goalHours));
  el("fasting-flip-inner").classList.toggle("flipped", state.phase === "eating");

  wirePillTabs("fasting-goal-tabs", () => {
    state.goalHours = Number(getActivePillType("fasting-goal-tabs", String(DEFAULT_GOAL_HOURS)));
    saveState(state);
    render();
  });

  el("fasting-toggle-btn").addEventListener("click", () => {
    vibrate(15);
    popToggleIcon();
    if (state.phase === "fasting") {
      stopFast();
    } else {
      startFast();
    }
  });

  // Same tap-flourish-before-sheet-opens pattern as #settings-btn (see
  // app.js's own settingsPressPending/ICON_BTN_PRESS_ANIMATION_MS) — held
  // here instead since this module already owns everything else about this
  // button. The sheet itself is otherwise fully generic (app.js already
  // wires its [data-close]/backdrop-click via the shared sheet plumbing, and
  // it's registered in ui.js's SHEET_IDS for drag-to-dismiss + scroll-lock).
  let headerPressPending = false;
  el("fasting-header-btn").addEventListener("click", () => {
    if (headerPressPending) return;
    const btn = el("fasting-header-btn");
    vibrate(10);
    if (prefersReducedMotion) {
      openSheet("fasting-sheet");
      return;
    }
    btn.classList.remove("pulse");
    void btn.offsetWidth;
    btn.classList.add("pulse");
    headerPressPending = true;
    setTimeout(() => {
      headerPressPending = false;
      openSheet("fasting-sheet");
    }, HEADER_BTN_PRESS_ANIMATION_MS);
  });

  render();
  // A newly-loaded, already-fasting session (app was closed/backgrounded
  // mid-fast and just reopened) needs its interval actually restarted here —
  // state came from loadState() above, not from startFast(), so nothing else
  // would otherwise turn the tick back on for it. elapsed time itself is
  // always correct regardless (computed from the absolute startedAt
  // timestamp, not accumulated tick-by-tick), so this only affects whether
  // the display keeps advancing live once the sheet is open.
  syncTick();
  onLanguageChange(render);

  // visibilitychange still forces an immediate refresh the moment the tab
  // wakes back up, independent of the tick loop above — a long-backgrounded
  // phone (interval throttled/suspended by the OS/browser while hidden)
  // never shows a stale time for even one extra second after becoming
  // visible again, whether or not a fast happens to be live.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") render();
  });
}
