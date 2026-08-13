// Custom progressive scroll indicator — a slim, glassmorphism-matched fill
// pinned to the right edge, replacing the native scrollbar (hidden globally
// in style.css, with extra hardening for installed PWA/standalone contexts —
// see that file's own note on why). The app scrolls at the document level
// (no dedicated app-wide scroll container — body.no-scroll's own comment in
// style.css explains why that's deliberate), so this tracks window.scrollY
// against the document's total scrollable height.
//
// Motion model: a single framerate-independent exponential "glide" toward
// the live scroll progress, applied via `transform: scaleY()` only (GPU-
// composited, no layout/paint work — critical on low-end Android as much as
// iOS). An earlier version drove velocity-based squash/stretch and a
// boundary-impact spring bounce here; both were removed for looking jittery
// and flying around unpredictably on a hard fling. A plain monotonic glide
// can't overshoot or oscillate by construction, so it stays smooth and
// stable at any scroll speed while still feeling premium, not robotic — the
// same principle behind Framer Motion's default transitions. The rAF loop
// starts on first scroll and stops itself once the fill has caught up to the
// true position, so an idle page costs nothing.

let track = null;
let fill = null;
let hideTimer = null;
let rafId = null;

let isScrolling = false;
let lastFrameTime = null;
let displayedProgress = 0;

const FADE_HOLD_MS = 900;
// Exponential-smoothing time constant, in ms — how quickly the fill glides
// to the true scroll position. Framerate-independent by construction (derived
// from dt each frame, not a fixed per-frame step), so it looks identical at
// 60Hz and 120Hz displays alike.
const GLIDE_TIME_CONSTANT = 140;
const SETTLE_EPSILON = 0.0015;

const REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function currentProgress() {
  const doc = document.documentElement;
  const scrollable = doc.scrollHeight - doc.clientHeight;
  return scrollable > 0 ? clamp01(window.scrollY / scrollable) : 0;
}

function tick(now) {
  const target = currentProgress();

  if (REDUCED_MOTION) {
    // Keep the functional progress readout, skip the decorative glide — no
    // persistent loop needed either, one write per scroll event is enough.
    fill.style.transform = `scaleY(${target.toFixed(4)})`;
    rafId = null;
    return;
  }

  const dt = lastFrameTime ? now - lastFrameTime : 16.67;
  lastFrameTime = now;

  const glideFactor = 1 - Math.exp(-dt / GLIDE_TIME_CONSTANT);
  displayedProgress += (target - displayedProgress) * glideFactor;
  fill.style.transform = `scaleY(${displayedProgress.toFixed(4)})`;

  const settled = Math.abs(target - displayedProgress) < SETTLE_EPSILON;
  if (isScrolling || !settled) {
    rafId = requestAnimationFrame(tick);
  } else {
    // Snap the last fraction of a percent so the fill lands exactly on the
    // true position instead of asymptotically approaching it forever.
    displayedProgress = target;
    fill.style.transform = `scaleY(${target.toFixed(4)})`;
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
    // `settled` check in tick) until the fill finishes gliding into place.
  }, FADE_HOLD_MS);
}

// A resize/content-height change with no active scroll still needs the
// fill's length to reflect the new document height immediately — without
// kicking off the full glide animation for a change the user didn't scroll
// to cause. The running loop, if any, already owns this.
function syncProgressStatic() {
  if (isScrolling || rafId !== null) return;
  displayedProgress = currentProgress();
  fill.style.transform = `scaleY(${displayedProgress.toFixed(4)})`;
}

export function initScrollProgress() {
  track = document.createElement("div");
  track.className = "scroll-progress";
  track.setAttribute("aria-hidden", "true");
  fill = document.createElement("div");
  fill.className = "scroll-progress-fill";
  track.appendChild(fill);
  document.body.appendChild(track);

  displayedProgress = currentProgress();
  fill.style.transform = `scaleY(${displayedProgress.toFixed(4)})`;

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", syncProgressStatic, { passive: true });
  if ("ResizeObserver" in window) {
    new ResizeObserver(syncProgressStatic).observe(document.body);
  }
}
