// The 3D Ollie mascot inside the AI Coach sheet (index.html's #ollie-3d-model
// <model-viewer>, rendering assets/ollie_model.glb). Kept in its own module
// rather than folded into coachChat.js/aiCoach.js since it owns a genuinely
// different concern (a WebGL element, its own animation clips, and its own
// "virtual pet" state machine) from the chat feed those two already own —
// see index.html's comment on the immersive sheet for how the two halves
// stay visually separate.
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

// The "Virtual Pet" state machine (coachChat.js drives the transitions —
// thinking while a reply is in flight, talking while the bubble holds text,
// idle otherwise). Each state maps to whichever baked animation clip name
// hints at that behavior; ollie_model.glb currently ships with none, so
// every state also has a plain CSS transform fallback (see style.css's
// .ollie-3d-model.ollie-state-* rules) that's never left silently unplayed.
const STATE_NAME_HINTS = {
  idle: ["idle", "breath", "breathing", "rest"],
  thinking: ["think", "look", "search", "ponder", "curious"],
  talking: ["talk", "flap", "speak", "chat", "active"],
};
const VALID_STATES = Object.keys(STATE_NAME_HINTS);

let modelViewer = null;
let availableAnimations = [];
let currentState = "idle";

function pickAnimationForHints(hints) {
  if (availableAnimations.length === 0) return null;
  return availableAnimations.find((name) =>
    hints.some((hint) => name.toLowerCase().includes(hint))
  );
}

function pickReactionAnimation() {
  return pickAnimationForHints(REACTION_NAME_HINTS) || availableAnimations[0] || null;
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

// Applies the given state's own CSS class (driving the transform fallback)
// and, when the glb actually has a matching baked clip, loops it — without
// touching `currentState`, so this can also be used to silently re-apply the
// current state's visuals (e.g. after a reaction finishes) without that
// counting as a fresh transition.
function applyState(state) {
  if (!modelViewer) return;
  modelViewer.classList.remove(...VALID_STATES.map((s) => `ollie-state-${s}`));
  modelViewer.classList.add(`ollie-state-${state}`);
  const clip = pickAnimationForHints(STATE_NAME_HINTS[state]);
  if (clip) {
    modelViewer.animationName = clip;
    modelViewer.currentTime = 0;
    modelViewer.play({ repetitions: Infinity });
  }
}

// The Virtual Pet state manager's single entry point — 'IDLE'/'THINKING'/
// 'TALKING' (case-insensitive). Ignored if the model isn't ready yet or the
// state name isn't one of the three above, so a stray call never throws.
export function setOllieState(state) {
  const normalized = String(state || "").toLowerCase();
  if (!modelViewer || !VALID_STATES.includes(normalized)) return;
  currentState = normalized;
  applyState(currentState);
}

export function getOllieState() {
  return currentState;
}

// Objective 3 — the "Lifeline" state machine's TALKING pulse. coachChat.js
// calls this (not setOllieState("talking") directly) every time a new AI
// message lands in the speech bubble: TALKING plays for a fixed window then
// seamlessly reverts to IDLE on its own, rather than lingering for as long
// as the bubble happens to hold text. 2.5s sits in the middle of the "2-3
// seconds" spec — a fixed value, not randomized, since this drives a
// user-visible animation state transition (unlike the local-reply typing
// delay in coachChat.js, which is randomized specifically because nobody is
// meant to notice its exact timing).
const TALKING_PULSE_MS = 2500;
let talkingRevertTimer = null;

export function triggerOllieTalk() {
  if (!modelViewer) return;
  setOllieState("talking");
  // Tracked or restarted, not fire-and-forget: a second message landing
  // before the first pulse finishes (a quick back-to-back exchange) should
  // extend the talking window, not have a stale timer yank the state back to
  // idle mid-reply.
  clearTimeout(talkingRevertTimer);
  talkingRevertTimer = setTimeout(() => {
    // Only revert if nothing else has moved the state machine on since this
    // pulse started — e.g. showTyping() already switched to THINKING for the
    // next exchange by the time this fires.
    if (currentState === "talking") setOllieState("idle");
  }, TALKING_PULSE_MS);
}

// The tap/poke reaction. Plays a baked clip when the glb actually has one;
// ollie_model.glb currently ships with none, so this transparently falls
// back to a CSS filter flash on the element itself (see style.css's
// .ollie-3d-model.ollie-3d-tapped — a filter, not a transform, specifically
// so it can never fight the transform model-viewer's own camera-controls is
// independently driving on this same element; see that rule's comment)
// rather than silently doing nothing —
// swapping in an animated glb later needs no change here, this already
// prefers a real clip the moment one exists. Always returns to IDLE once the
// reaction finishes, per the Virtual Pet spec — a poke is a momentary
// override, never a lasting state change.
let tapReactionTimer = null;

// State-lock against spam-clicking: without this, a burst of rapid pokes
// each called playOllieAnimation()/reset the CSS bounce mid-flight, which is
// what caused the jittering/position-resetting bug (a new clip restart or a
// class remove/reflow/re-add landing on top of one that hadn't finished
// yet). Now a poke arriving while `isAnimating` is true is simply dropped —
// the pet finishes its current reaction and returns to idle before it can
// react again, rather than visually stacking interruptions.
let isAnimating = false;

export function triggerOllieReaction() {
  if (!modelViewer || isAnimating) return;
  const clip = pickReactionAnimation();
  if (clip) {
    isAnimating = true;
    playOllieAnimation(clip);
    modelViewer.addEventListener(
      "finished",
      () => {
        isAnimating = false;
        setOllieState("idle");
      },
      { once: true }
    );
    return;
  }
  if (prefersReducedMotion) {
    setOllieState("idle");
    return;
  }
  isAnimating = true;
  clearTimeout(tapReactionTimer);
  modelViewer.classList.remove(TAP_REACTION_CLASS);
  void modelViewer.offsetWidth; // reflow, so a class already present can replay
  modelViewer.classList.add(TAP_REACTION_CLASS);
  tapReactionTimer = setTimeout(() => {
    modelViewer.classList.remove(TAP_REACTION_CLASS);
    isAnimating = false;
    setOllieState("idle");
  }, TAP_REACTION_MS);
}

// The center the restricted orbit (index.html's min/max-camera-orbit) snaps
// back to once the user lets go — keeps Ollie facing the user by default
// (Objective 2: this is a Virtual Pet, not a spinning product-viewer
// artifact) while still letting a curious tap-and-drag peek at his side.
const DEFAULT_CAMERA_ORBIT = "0deg 80deg 170%";
const CAMERA_SNAP_BACK_DELAY_MS = 650;
let cameraSnapBackTimer = null;

function initCameraSnapBack() {
  modelViewer.addEventListener("camera-change", (event) => {
    if (event.detail?.source !== "user-interaction") return;
    clearTimeout(cameraSnapBackTimer);
    cameraSnapBackTimer = setTimeout(() => {
      modelViewer.cameraOrbit = DEFAULT_CAMERA_ORBIT;
    }, CAMERA_SNAP_BACK_DELAY_MS);
  });
}

// Google's <model-viewer> scene-graph API: every material on the loaded glb
// gets walked and forced to OPAQUE + double-sided. Without this, a glb
// authored (or exported) with an alpha-blend/mask mode on its materials
// renders as hollow/see-through in model-viewer's three.js internals — the
// "hollow" bug was a material-blending problem, not missing/inverted
// geometry, so no amount of camera-orbit clamping alone fixes it (that only
// hides *some* of the resulting view-dependent artifacts). This has to run
// after 'load' — modelViewer.model is null before then.
function fixOpaqueMaterials() {
  const materials = modelViewer.model?.materials || [];
  materials.forEach((material) => {
    material.setAlphaMode("OPAQUE");
    material.setDoubleSided(true);
  });
}

export function initOllie3D() {
  modelViewer = el("ollie-3d-model");
  if (!modelViewer) return;

  // customElements.whenDefined resolves once index.html's SRI-pinned
  // <script type="module"> for model-viewer has actually registered the
  // element — reading .model/.availableAnimations any earlier would just see
  // the plain HTMLElement prototype, not model-viewer's real API.
  customElements.whenDefined("model-viewer").then(() => {
    modelViewer.addEventListener("load", () => {
      fixOpaqueMaterials();
      availableAnimations = modelViewer.availableAnimations || [];
      setOllieState("idle");
    });
    initCameraSnapBack();
  });

  // pointerdown, not click — Objective 4 wants Ollie to react the instant
  // he's poked, not only once a full click gesture resolves. model-viewer's
  // own camera-controls still gets the same pointerdown to start an orbit
  // drag in parallel; that's fine here since a poke reaction and an orbit
  // drag aren't mutually exclusive for a virtual pet (he can react AND get
  // turned in the same gesture).
  modelViewer.addEventListener("pointerdown", triggerOllieReaction);
}
