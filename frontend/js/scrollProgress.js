// Custom progressive scroll indicator with Framer-tier physics — replaces
// the native scrollbar (hidden globally in style.css) with a slim,
// glassmorphism-matched fill pinned to the right edge. The app scrolls at
// the document level (no dedicated app-wide scroll container), so this
// tracks window.scrollY against the document's total scrollable height.
//
// Physics layer, all applied via `transform` only (GPU-composited, no
// layout/paint work — critical on low-end Android as much as iOS):
//   - Squash & stretch: fast scrolling elongates the fill (scaleY) and
//     thins it (scaleX), derived from a smoothed scroll velocity.
//   - Boundary impact: hitting scrollY 0 or max kicks a damped spring
//     (compress along the direction of travel, bulge perpendicular — the
//     same squash-and-stretch principle, just triggered by a stop instead
//     of by speed) rather than playing a fixed-duration canned animation,
//     so a hard fling produces a bigger bounce than a gentle one for free.
// Both simulations run inside one rAF loop that starts on first scroll and
// stops itself once fully settled, so an idle page costs nothing.

let track = null;
let fill = null;
let hideTimer = null;
let rafId = null;

let isScrolling = false;
let lastScrollY = 0;
let lastFrameTime = null;
let velocityEMA = 0; // px/ms, smoothed
let impactPos = 0; // damped-spring "bulge" displacement, decays to 0
let impactVel = 0;
let wasAtTop = true;
let wasAtBottom = false;

const FADE_HOLD_MS = 900;
const VELOCITY_EMA_ALPHA = 0.25; // higher = snappier velocity tracking, lower = smoother
const VELOCITY_REF = 3; // px/ms treated as "fully squashed/stretched" (~3000px/s hard flick) — tune against real devices
const MAX_SQUASH_X = 0.28; // fast scroll thins the fill down to 72% width
const MAX_STRETCH_Y = 0.1; // fast scroll elongates the fill up to 110% of its progress length
const IMPACT_KICK = 0.9; // spring velocity injected the instant a boundary is hit
const IMPACT_STIFFNESS = 0.3;
const IMPACT_DAMPING = 0.72; // per-16.67ms-frame velocity multiplier
const IMPACT_Y_FACTOR = 0.45; // compress along the direction of travel...
const IMPACT_X_FACTOR = 0.35; // ...bulge perpendicular to it
const SETTLE_EPSILON = 0.01;

const REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function currentProgress() {
  const doc = document.documentElement;
  const scrollable = doc.scrollHeight - doc.clientHeight;
  return { scrollable, progress: scrollable > 0 ? clamp01(window.scrollY / scrollable) : 0 };
}

function tick(now) {
  const { scrollable, progress } = currentProgress();
  const scrollY = window.scrollY;

  if (REDUCED_MOTION) {
    // Keep the functional progress readout, skip every decorative motion —
    // no persistent loop needed either, one write per scroll event is enough.
    fill.style.transform = `scaleY(${progress.toFixed(4)}) scaleX(1)`;
    rafId = null;
    return;
  }

  const dt = lastFrameTime ? now - lastFrameTime : 16.67;
  lastFrameTime = now;
  // A stalled/backgrounded tab can hand back one huge dt on resume — clamp
  // the *spring integration* step (not the raw velocity sample below) so it
  // can't get flung by a fake multi-second "frame".
  const dtFactor = Math.min(dt, 48) / 16.67;

  const instVelocity = (scrollY - lastScrollY) / Math.max(dt, 1);
  lastScrollY = scrollY;
  velocityEMA += (instVelocity - velocityEMA) * VELOCITY_EMA_ALPHA;
  const speed = Math.min(Math.abs(velocityEMA) / VELOCITY_REF, 1);

  const atTop = scrollY <= 0.5;
  const atBottom = scrollable > 0 && scrollY >= scrollable - 0.5;
  if (atTop && !wasAtTop) impactVel += IMPACT_KICK * Math.max(speed, 0.3);
  if (atBottom && !wasAtBottom) impactVel += IMPACT_KICK * Math.max(speed, 0.3);
  wasAtTop = atTop;
  wasAtBottom = atBottom;

  // Damped harmonic oscillator (semi-implicit Euler) driving the impact
  // bulge back toward 0 — a fixed CSS transition can't do this: the
  // bounce's size and settle time need to depend on how hard the boundary
  // was actually hit, which is exactly what impactVel above carries in.
  impactVel += -impactPos * IMPACT_STIFFNESS * dtFactor;
  impactVel *= Math.pow(IMPACT_DAMPING, dtFactor);
  impactPos += impactVel * dtFactor;

  const scaleY = progress * (1 + speed * MAX_STRETCH_Y) * (1 - impactPos * IMPACT_Y_FACTOR);
  const scaleX = (1 - speed * MAX_SQUASH_X) * (1 + impactPos * IMPACT_X_FACTOR);
  fill.style.transform = `scaleY(${Math.max(0, scaleY).toFixed(4)}) scaleX(${Math.max(0.1, scaleX).toFixed(4)})`;

  const settled =
    speed < SETTLE_EPSILON && Math.abs(impactVel) < SETTLE_EPSILON && Math.abs(impactPos) < SETTLE_EPSILON;
  if (isScrolling || !settled) {
    rafId = requestAnimationFrame(tick);
  } else {
    rafId = null;
    lastFrameTime = null; // next start gets a clean dt instead of a stale timestamp
  }
}

function ensureLoopRunning() {
  if (rafId === null) rafId = requestAnimationFrame(tick);
}

function onScroll() {
  // Single class drives the path's dot->full-length morph, thickness
  // breathing, and opacity together — see .scroll-progress.is-scrolling.
  track.classList.add("is-scrolling");
  isScrolling = true;
  ensureLoopRunning();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    isScrolling = false;
    track.classList.remove("is-scrolling");
    // The loop keeps itself alive past this point on its own (see the
    // `settled` check in tick) until the impact spring finishes bouncing.
  }, FADE_HOLD_MS);
}

// A resize/content-height change with no active scroll still needs the
// fill's length to reflect the new document height immediately — without
// kicking off the full velocity/impact simulation for a change the user
// didn't scroll to cause. The running loop, if any, already owns this.
function syncProgressStatic() {
  if (isScrolling || rafId !== null) return;
  const { progress } = currentProgress();
  fill.style.transform = `scaleY(${progress.toFixed(4)}) scaleX(1)`;
}

export function initScrollProgress() {
  track = document.createElement("div");
  track.className = "scroll-progress";
  track.setAttribute("aria-hidden", "true");
  fill = document.createElement("div");
  fill.className = "scroll-progress-fill";
  track.appendChild(fill);
  document.body.appendChild(track);

  const { scrollable } = currentProgress();
  lastScrollY = window.scrollY;
  wasAtTop = lastScrollY <= 0.5;
  wasAtBottom = scrollable > 0 && lastScrollY >= scrollable - 0.5;

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", syncProgressStatic, { passive: true });
  if ("ResizeObserver" in window) {
    new ResizeObserver(syncProgressStatic).observe(document.body);
  }
}
