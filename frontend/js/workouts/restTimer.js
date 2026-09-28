// Rest timer — lifted VERBATIM out of workoutDiary.js (Phase 0.3). Nothing in
// here changed: it was already self-contained (its own DOM subtree, its own
// private `restTimer` handle, no dependency on session or calendar state) and
// its absolute-end-timestamp design is deliberately correct about a phone
// screen locking mid-rest. The only additions are the import and the exports.
import { vibrate } from "../ui.js";

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Rest timer — a lightweight countdown, auto-started after every logged set.
// Ticks once a second via setInterval rather than requestAnimationFrame: the
// displayed second only changes once a second, so anything faster (rAF fires
// ~60x/sec) is wasted wake-ups against a phone's CPU/battery for zero visible
// benefit. Tracks an absolute end timestamp instead of decrementing a
// counter, so a tick delayed by a throttled background tab (the phone screen
// locking mid-rest is the common case) self-corrects on its next fire rather
// than drifting permanently. The progress fill is a CSS `transform: scaleX()`
// with a 1s linear transition doing the visual smoothing between those
// once-a-second writes — compositor-only, no layout or paint triggered per
// tick, and the only two DOM writes each second are a textContent swap and a
// single inline style, never a re-render of any list.
// ---------------------------------------------------------------------------
const REST_TIMER_SECONDS = 90;
let restTimer = null; // { endAt, totalMs, intervalId }

function formatRestClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function tickRestTimer() {
  if (!restTimer) return;
  const remainingMs = restTimer.endAt - Date.now();
  if (remainingMs <= 0) {
    finishRestTimer();
    return;
  }
  el("wd-rest-timer-time").textContent = formatRestClock(Math.ceil(remainingMs / 1000));
  el("wd-rest-timer-fill").style.transform = `scaleX(${Math.min(1, remainingMs / restTimer.totalMs)})`;
}

export function startRestTimer(seconds = REST_TIMER_SECONDS) {
  clearRestTimer();
  restTimer = { endAt: Date.now() + seconds * 1000, totalMs: seconds * 1000, intervalId: null };
  el("wd-rest-timer").hidden = false;
  tickRestTimer();
  restTimer.intervalId = setInterval(tickRestTimer, 1000);
}

export function adjustRestTimer(deltaSeconds) {
  if (!restTimer) return;
  restTimer.endAt += deltaSeconds * 1000;
  tickRestTimer();
}

export function clearRestTimer() {
  if (restTimer?.intervalId) clearInterval(restTimer.intervalId);
  restTimer = null;
}

function finishRestTimer() {
  clearRestTimer();
  el("wd-rest-timer").hidden = true;
  vibrate(20);
}

export function skipRestTimer() {
  clearRestTimer();
  el("wd-rest-timer").hidden = true;
}
