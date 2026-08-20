// The 3D Ollie mascot inside the AI Coach sheet (index.html's #ollie-3d-model
// <model-viewer>, rendering assets/ollie_model.glb). Kept in its own module
// rather than folded into coachChat.js/aiCoach.js since it owns a genuinely
// different concern (a WebGL element and its own animation clips) from the
// chat feed those two already own — see index.html's comment on the
// immersive sheet for how the two halves stay visually separate.
const el = (id) => document.getElementById(id);
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Same one-shot-class idiom as aiCoach.js's waveOllie() — removed after it
// plays (not left with animation-fill-mode: forwards) so it can replay on
// the very next tap.
const TAP_REACTION_CLASS = "ollie-3d-tapped";
const TAP_REACTION_MS = 500;

// If the glb ever ships baked clips, prefer whichever one reads as a
// deliberate "reaction" over whatever happens to be first in the file (often
// an idle/rest pose) — matched case-insensitively against the animation
// names glTF authoring tools conventionally use. Falls back to the first
// available clip when nothing matches, so this never leaves an available
// animation unplayed just because it wasn't named one of these.
const REACTION_NAME_HINTS = ["tap", "react", "greet", "wave", "happy", "bounce", "nod"];

let modelViewer = null;
let availableAnimations = [];

function pickReactionAnimation() {
  if (availableAnimations.length === 0) return null;
  const hinted = availableAnimations.find((name) =>
    REACTION_NAME_HINTS.some((hint) => name.toLowerCase().includes(hint))
  );
  return hinted || availableAnimations[0];
}

// Flexible on purpose: any clip name actually present in the glb can be
// requested, not just the auto-picked reaction above — a future caller (a
// specific coach message, a milestone celebration) can play a specific named
// clip without this module needing a new export per animation.
export function playOllieAnimation(name) {
  if (!modelViewer || !availableAnimations.includes(name)) return false;
  modelViewer.animationName = name;
  modelViewer.currentTime = 0;
  modelViewer.play({ repetitions: 1 });
  return true;
}

// The tap/open reaction. Plays a baked clip when the glb actually has one;
// ollie_model.glb currently ships with none, so this transparently falls
// back to a CSS scale/rotate bounce on the element itself (see style.css's
// .ollie-3d-model.ollie-3d-tapped) rather than silently doing nothing —
// swapping in an animated glb later needs no change here, this already
// prefers a real clip the moment one exists.
export function triggerOllieReaction() {
  if (!modelViewer) return;
  const clip = pickReactionAnimation();
  if (clip) {
    playOllieAnimation(clip);
    return;
  }
  if (prefersReducedMotion) return;
  modelViewer.classList.remove(TAP_REACTION_CLASS);
  void modelViewer.offsetWidth; // reflow, so a class already present can replay
  modelViewer.classList.add(TAP_REACTION_CLASS);
  setTimeout(() => modelViewer.classList.remove(TAP_REACTION_CLASS), TAP_REACTION_MS);
}

export function initOllie3D() {
  modelViewer = el("ollie-3d-model");
  if (!modelViewer) return;

  // auto-rotate is otherwise-continuous motion, exactly what
  // prefers-reduced-motion asks sites to avoid — can't be gated in CSS since
  // it's a model-viewer content attribute, not a CSS animation.
  if (prefersReducedMotion) modelViewer.removeAttribute("auto-rotate");

  // customElements.whenDefined resolves once index.html's SRI-pinned
  // <script type="module"> for model-viewer has actually registered the
  // element — reading .availableAnimations any earlier would just see the
  // plain HTMLElement prototype, not model-viewer's real API.
  customElements.whenDefined("model-viewer").then(() => {
    modelViewer.addEventListener("load", () => {
      availableAnimations = modelViewer.availableAnimations || [];
    });
  });

  // "click" rather than a raw touchstart/pointerdown: model-viewer's own
  // camera-controls already disambiguates a tap from an orbit-drag
  // internally and only fires click for the former, so this never fires
  // mid-drag or hijacks the rotate gesture.
  modelViewer.addEventListener("click", triggerOllieReaction);
}
