// The 3D Ollie mascot inside the AI Coach sheet (index.html's #ollie-3d-model
// <model-viewer>, rendering assets/ollie_model.glb — WildPoly3D's "Owl -
// Animated Low Poly"). Kept in its own module rather than folded into
// coachChat.js/aiCoach.js since it owns a genuinely different concern (a
// WebGL element, its own baked animation clips, and its own "virtual pet"
// state machine) from the chat feed those two already own — see index.html's
// comment on the immersive sheet for how the two halves stay visually
// separate.
//
// PetController owns EVERY piece of pet state: the model element, the 3D
// hotspot speech bubble, which animation clip is playing, and the
// spam-click cooldown. coachChat.js never reaches into the bubble DOM or
// calls model-viewer directly — it only ever calls PetController's methods
// (speak/showTyping/hideTyping/react/reset), so there is exactly one place
// that can put the pet's visuals in an inconsistent state.
const el = (id) => document.getElementById(id);
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Verified directly from assets/ollie_model.glb's own glTF animations array
// (5 baked clips, all real skeletal animation — this asset is NOT the old
// zero-animation placeholder some earlier code in this file's history was
// written against). Exact names, matched first; PetController.init()'s own
// console.log of availableAnimations on 'load' is the source of truth to
// re-verify/update this map after any future model swap — see that log
// before touching these strings.
const ANIMATION_CLIPS = {
  idle: "EagleOwl_Rig|EagleOwl_Rig|idle",
  thinking: "EagleOwl_Rig|EagleOwl_Rig|headtwist",
  talking: "EagleOwl_Rig|EagleOwl_Rig|headtwist",
  reaction: "EagleOwl_Rig|EagleOwl_Rig|fly",
};
// Deliberately NOT "landing" for talking, even though it reads as more of an
// "active" flourish: verified live that it drives real root-bone motion (the
// whole body drops/settles, not just the head), which drags the model out
// from under the hotspot's fixed 3D anchor point mid-sentence — the bubble
// would visibly drift off Ollie's head. "headtwist" only moves the
// head/neck, so the body stays put and the bubble stays correctly anchored
// for as long as TALKING/THINKING hold. "fly" is reserved for the one-shot
// tap reaction below, where a bigger flourish is fine — no bubble is ever
// shown during a bare reaction.
//
// Substring fallback — only reached if a future glb swap ships clips under
// different exact names, so state playback degrades gracefully to "closest
// named match" instead of going silent.
const STATE_NAME_HINTS = {
  idle: ["idle", "breath", "rest"],
  thinking: ["headtwist", "think", "look", "curious"],
  talking: ["headtwist", "talk", "chat", "active"],
  reaction: ["fly", "flap", "react", "jump", "greet", "wave"],
};
const VALID_STATES = ["idle", "thinking", "talking"];

// Fixed 2-3s pulse back to idle, not "as long as the bubble holds text" —
// TALKING is a momentary beat tied to a reply landing, never a lingering
// mode.
const TALKING_PULSE_MS = 2500;

// The center the restricted orbit (index.html's min/max-camera-orbit) snaps
// back to once the user lets go — keeps Ollie facing the user by default
// (this is a Virtual Pet, not a spinning product-viewer artifact) while
// still letting a curious tap-and-drag peek at his side.
const DEFAULT_CAMERA_ORBIT = "0deg 80deg 170%";
const CAMERA_SNAP_BACK_DELAY_MS = 650;

function replayAnimation(node, className) {
  node.classList.remove(className);
  void node.offsetWidth; // reflow, so a class already present can replay
  node.classList.add(className);
}

export const PetController = {
  modelViewer: null,
  bubbleEl: null,
  bubbleTextEl: null,
  bubbleTypingEl: null,
  availableAnimations: [],
  currentState: "idle",
  // Spam-click prevention: while true, react() drops further pokes until
  // the current reaction clip finishes and crossfades back to idle.
  isAnimating: false,
  _talkTimer: null,
  _cameraTimer: null,

  init() {
    this.modelViewer = el("ollie-3d-model");
    if (!this.modelViewer) return;
    this.bubbleEl = el("ollie-speech-bubble");
    this.bubbleTextEl = el("ollie-speech-bubble-text");
    this.bubbleTypingEl = el("ollie-speech-bubble-typing");

    // customElements.whenDefined resolves once index.html's SRI-pinned
    // <script type="module"> for model-viewer has actually registered the
    // element — reading .model/.availableAnimations any earlier would just
    // see the plain HTMLElement prototype, not model-viewer's real API.
    customElements.whenDefined("model-viewer").then(() => {
      this.modelViewer.addEventListener("load", () => this._onLoad());
      this._initCameraSnapBack();
    });

    // pointerdown, not click — Ollie should react the instant he's poked,
    // not only once a full click gesture resolves. model-viewer's own
    // camera-controls still gets the same pointerdown to start an orbit
    // drag in parallel; disable-tap (index.html) stops that drag-start from
    // also registering as a camera nudge, so a poke and an orbit nudge never
    // fight each other.
    this.modelViewer.addEventListener("pointerdown", () => this.react());
  },

  _onLoad() {
    this.availableAnimations = this.modelViewer.availableAnimations || [];
    // The ground truth for mapping clip names to states — check this log
    // after any future asset swap instead of assuming ANIMATION_CLIPS above
    // still applies.
    console.log("[Ollie] available animations:", this.availableAnimations);
    this.setState("idle");
  },

  _clipFor(stateKey) {
    const exact = ANIMATION_CLIPS[stateKey];
    if (exact && this.availableAnimations.includes(exact)) return exact;
    const hints = STATE_NAME_HINTS[stateKey] || [];
    return (
      this.availableAnimations.find((name) => hints.some((hint) => name.toLowerCase().includes(hint))) || null
    );
  },

  // The Virtual Pet state machine's core transition. Loops whichever real
  // baked clip maps to this state; if the state truly can't be resolved to
  // any available clip, the model simply holds its last pose rather than
  // fighting model-viewer's own camera-controls transform with a CSS one (a
  // real bug in an earlier version of this file — CSS transforms applied
  // directly to the same element camera-controls drives read as the model
  // "jumping" whenever the two collided).
  setState(state) {
    if (!this.modelViewer || !VALID_STATES.includes(state)) return;
    this.currentState = state;
    const clip = this._clipFor(state);
    if (!clip) return;
    this.modelViewer.animationName = clip;
    this.modelViewer.currentTime = 0;
    this.modelViewer.play({ repetitions: Infinity });
  },

  getState() {
    return this.currentState;
  },

  // The tap/poke reaction — a one-shot clip, cooldown-locked against
  // spam-clicking. A poke arriving while `isAnimating` is true is simply
  // dropped: the pet finishes its current reaction and returns to idle
  // before it can react again, rather than visually stacking interruptions.
  // Skipped entirely under prefers-reduced-motion — the flap/jump reaction
  // is a flourish, unlike idle/thinking/talking which communicate real
  // state and stay on regardless.
  react() {
    if (!this.modelViewer || this.isAnimating || prefersReducedMotion) return;
    const clip = this._clipFor("reaction");
    if (!clip) return;
    this.isAnimating = true;
    this.modelViewer.animationName = clip;
    this.modelViewer.currentTime = 0;
    this.modelViewer.play({ repetitions: 1 });
    this.modelViewer.addEventListener(
      "finished",
      () => {
        this.isAnimating = false;
        this.setState("idle");
      },
      { once: true }
    );
  },

  // The single entry point for "Ollie says something" — owns writing the
  // text into the 3D hotspot bubble AND the TALKING animation pulse, so
  // callers (coachChat.js) never touch bubble internals or the animation
  // state directly; they just call speak(text).
  speak(text, { isError = false } = {}) {
    if (!this.bubbleEl) return;
    this.bubbleTypingEl.hidden = true;
    this.bubbleTextEl.hidden = false;
    this.bubbleTextEl.textContent = text;
    this.bubbleEl.hidden = false;
    this.bubbleEl.classList.toggle("ollie-speech-bubble-error", isError);
    replayAnimation(this.bubbleEl, "ollie-bubble-pop");
    this.setState("talking");
    clearTimeout(this._talkTimer);
    this._talkTimer = setTimeout(() => {
      // Only revert if nothing else has moved the state machine on since
      // this pulse started — e.g. a fresh showTyping() already switched to
      // THINKING for the next exchange by the time this fires.
      if (this.currentState === "talking") this.setState("idle");
    }, TALKING_PULSE_MS);
  },

  // Swaps the bubble into its typing-dots state — same bubble, same
  // position, just its content — and moves the pet into THINKING while a
  // reply (real or local-simulated) is in flight.
  showTyping() {
    if (!this.bubbleEl) return;
    this.bubbleTextEl.hidden = true;
    this.bubbleTypingEl.hidden = false;
    this.bubbleEl.hidden = false;
    this.bubbleEl.classList.remove("ollie-speech-bubble-error");
    replayAnimation(this.bubbleEl, "ollie-bubble-pop");
    this.setState("thinking");
  },

  hideTyping() {
    if (this.bubbleTypingEl) this.bubbleTypingEl.hidden = true;
  },

  // Full reset for a fresh conversation (coachChat.js's resetConversation) —
  // hides the bubble outright and returns to idle, clearing any in-flight
  // talking-pulse timer so it can't fire later and reopen a bubble nobody
  // asked for.
  reset() {
    clearTimeout(this._talkTimer);
    if (this.bubbleEl) {
      this.bubbleEl.hidden = true;
      this.bubbleEl.classList.remove("ollie-bubble-pop", "ollie-speech-bubble-error");
    }
    if (this.bubbleTypingEl) this.bubbleTypingEl.hidden = true;
    this.setState("idle");
  },

  _initCameraSnapBack() {
    this.modelViewer.addEventListener("camera-change", (event) => {
      if (event.detail?.source !== "user-interaction") return;
      clearTimeout(this._cameraTimer);
      this._cameraTimer = setTimeout(() => {
        this.modelViewer.cameraOrbit = DEFAULT_CAMERA_ORBIT;
      }, CAMERA_SNAP_BACK_DELAY_MS);
    });
  },
};

export function initOllie3D() {
  PetController.init();
}
