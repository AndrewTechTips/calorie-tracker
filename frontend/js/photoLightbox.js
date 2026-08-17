// Full-screen viewer for a Today's Journal meal photo — tap a journal card's
// thumbnail (see ui.js's renderJournal / app.js's #log-list click handler)
// to open it here instead of the edit sheet. Opens instantly against the
// already-loaded thumbnail (zero network/storage wait), then swaps in the
// higher-quality "hero" photo from photoStore.js once it resolves — a photo
// that was never captured with this feature, or whose hero write failed/was
// skipped (storage full, unsupported browser), simply never swaps and the
// thumbnail stays on screen. That degradation is silent by design: a slightly
// softer full-screen photo is never worth surfacing as an error.
import { getHeroPhoto } from "./photoStore.js?v=20260817e";
import { lockAppScroll, unlockAppScroll } from "./ui.js?v=20260817e";

const el = (id) => document.getElementById(id);

const DRAG_CLOSE_PX = 110;
const DRAG_CLOSE_VELOCITY_PX_MS = 0.55; // a fast downward flick commits even under the distance threshold
const SETTLE_MS = 280;

let activeLogId = null;
let activeObjectUrl = null;

function revokeActiveObjectUrl() {
  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  }
}

// Loads the hero photo in the background and swaps it in — guarded by
// `activeLogId` so a slow load for a photo the user has since closed (or
// closed and reopened for a DIFFERENT log) can never clobber what's on
// screen now.
async function loadHeroPhoto(logId, imgEl) {
  const spinner = el("photo-lightbox-spinner");
  spinner.hidden = false;
  try {
    const blob = await getHeroPhoto(logId);
    if (activeLogId !== logId || !blob) return;
    const url = URL.createObjectURL(blob);
    const preload = new Image();
    preload.src = url;
    await preload.decode().catch(() => {}); // best-effort — a decode failure still swaps in below, just possibly not pre-decoded
    if (activeLogId !== logId) {
      URL.revokeObjectURL(url);
      return;
    }
    revokeActiveObjectUrl();
    activeObjectUrl = url;
    imgEl.src = url;
  } catch {
    /* thumbnail stays on screen — never an error worth surfacing */
  } finally {
    if (activeLogId === logId) spinner.hidden = true;
  }
}

export function openPhotoLightbox(log, thumbImgEl) {
  const overlay = el("photo-lightbox");
  const stage = el("photo-lightbox-stage");
  const img = el("photo-lightbox-img");

  activeLogId = log.id;
  revokeActiveObjectUrl();

  img.src = thumbImgEl.src; // instant paint from the already-loaded thumbnail
  el("photo-lightbox-name").textContent = log.food_name;
  el("photo-lightbox-cal").textContent = `${Math.round(log.calories)} kcal`;
  el("photo-lightbox-spinner").hidden = true;

  // Zoom-toward-tap-point entrance: anchor the scale transform's origin at
  // the tapped thumbnail's own screen position, so the photo visibly grows
  // out from where the user tapped rather than fading in from a fixed
  // center. transform/opacity only (never layout properties), matching this
  // codebase's other entrance animations (see ui.js's reconcileList FLIP
  // step) — cheap and stays on the compositor thread.
  const rect = thumbImgEl.getBoundingClientRect();
  const originX = ((rect.left + rect.width / 2) / window.innerWidth) * 100;
  const originY = ((rect.top + rect.height / 2) / window.innerHeight) * 100;
  stage.style.transformOrigin = `${originX}% ${originY}%`;

  overlay.hidden = false;
  overlay.style.transition = "none";
  stage.style.transition = "none";
  overlay.style.opacity = "0";
  stage.style.transform = "scale(0.35)";
  overlay.offsetHeight; // force reflow so the transition below actually animates from this starting frame
  requestAnimationFrame(() => {
    overlay.style.transition = "opacity 0.32s var(--ease)";
    stage.style.transition = "transform 0.38s var(--ease-bounce)";
    overlay.style.opacity = "1";
    stage.style.transform = "scale(1)";
  });

  lockAppScroll();
  loadHeroPhoto(log.id, img);
}

function closePhotoLightbox() {
  const overlay = el("photo-lightbox");
  if (overlay.hidden) return;
  overlay.hidden = true;
  activeLogId = null;
  revokeActiveObjectUrl();
  el("photo-lightbox-img").src = "";
  // Only this module's own scroll lock is ours to release — a sheet opened
  // from elsewhere (not possible today, since journal cards only render on
  // the dashboard itself, but cheap to guard against regardless) should keep
  // the app locked until it closes itself.
  if (!document.querySelector(".sheet-overlay:not([hidden])")) unlockAppScroll();
}

// Swipe-down-anywhere-on-the-stage to dismiss — same live 1:1 finger
// tracking + distance/velocity commit thresholds as ui.js's sheet
// drag-to-dismiss and app.js's journal swipe-to-delete, just vertical and
// scoped to the whole stage (not a small handle) since this is a full-bleed
// media viewer, not a sheet with its own scrollable content to protect.
function initDragToDismiss() {
  const overlay = el("photo-lightbox");
  const stage = el("photo-lightbox-stage");
  let startY = 0;
  let startTime = 0;
  let dragging = false;

  const onPointerMove = (e) => {
    if (!dragging) return;
    const deltaY = Math.max(0, e.clientY - startY); // downward only — no rubber-band the other way
    stage.style.transform = `translateY(${deltaY}px) scale(${Math.max(1 - deltaY / 1400, 0.9)})`;
    overlay.style.opacity = String(Math.max(1 - deltaY / 500, 0.3));
  };

  const endDrag = (committed) => {
    stage.style.transition = `transform ${SETTLE_MS}ms var(--ease)`;
    overlay.style.transition = `opacity ${SETTLE_MS}ms var(--ease)`;
    if (committed) {
      closePhotoLightbox();
    } else {
      stage.style.transform = "";
      overlay.style.opacity = "1";
    }
  };

  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    const deltaY = Math.max(0, e.clientY - startY);
    const velocity = deltaY / Math.max(performance.now() - startTime, 1);
    endDrag(deltaY > DRAG_CLOSE_PX || velocity > DRAG_CLOSE_VELOCITY_PX_MS);
  };

  stage.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = e.clientY;
    startTime = performance.now();
    stage.style.transition = "none";
    overlay.style.transition = "none";
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  });
}

// Called once at boot (app.js) — wires close button, backdrop tap, and Esc,
// on top of the drag-to-dismiss gesture above.
export function initPhotoLightbox() {
  const overlay = el("photo-lightbox");
  const stage = el("photo-lightbox-stage");

  el("photo-lightbox-close").addEventListener("click", closePhotoLightbox);
  overlay.addEventListener("click", (e) => {
    // Only a tap on the dimmed backdrop itself (not the image/caption/close
    // button) closes — matches every other overlay's backdrop-tap convention
    // in this app, and a tap directly on the photo is otherwise a no-op
    // rather than an accidental close.
    if (e.target === overlay || e.target === stage) closePhotoLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closePhotoLightbox();
  });
  initDragToDismiss();
}
