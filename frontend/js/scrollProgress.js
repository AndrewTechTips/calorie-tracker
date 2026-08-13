// Custom progressive scroll indicator — replaces the native scrollbar
// (hidden globally in style.css) with a slim, glassmorphism-matched fill
// pinned to the right edge. The app scrolls at the document level (no
// dedicated app-wide scroll container), so this tracks window.scrollY
// against the document's total scrollable height.

let track = null;
let fill = null;
let hideTimer = null;
let rafPending = false;

const FADE_HOLD_MS = 900;

function updateProgress() {
  rafPending = false;
  const doc = document.documentElement;
  const scrollable = doc.scrollHeight - doc.clientHeight;
  const progress = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
  // transform only (never height/top) — compositor-only work, stays 60fps
  // even while the journal list is mid-reflow from an add/remove.
  fill.style.transform = `scaleY(${progress})`;
}

function requestUpdate() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(updateProgress);
}

function onScroll() {
  // Single class drives both the CSS "breathing" width (2px -> 5px) and the
  // fill's fade-in — see .scroll-progress.is-scrolling in style.css.
  track.classList.add("is-scrolling");
  requestUpdate();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => track.classList.remove("is-scrolling"), FADE_HOLD_MS);
}

export function initScrollProgress() {
  track = document.createElement("div");
  track.className = "scroll-progress";
  track.setAttribute("aria-hidden", "true");
  fill = document.createElement("div");
  fill.className = "scroll-progress-fill";
  track.appendChild(fill);
  document.body.appendChild(track);

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", requestUpdate, { passive: true });

  // Catches page-height changes that aren't accompanied by a resize or a
  // scroll event of their own (e.g. logging/deleting a meal shortens the
  // journal list while the user is sitting still at the top) so the fill's
  // proportions never drift stale until the next manual scroll.
  if ("ResizeObserver" in window) {
    new ResizeObserver(requestUpdate).observe(document.body);
  }
}
