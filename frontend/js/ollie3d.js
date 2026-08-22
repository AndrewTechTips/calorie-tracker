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
// spam-click cooldown. coachChat.js/petHud.js never reach into the bubble
// DOM or call model-viewer directly — they only ever call PetController's
// methods (speak/showTyping/hideTyping/react/celebrate/dismissBubble/
// setMood/reset), so there is exactly one place that can put the pet's
// visuals in an inconsistent state.
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

// Speech-bubble lifetime is owned independently of TALKING_PULSE_MS above —
// that constant only times the model's animation pulse; the bubble's own
// visibility used to just ride along with whatever text was last written
// into it and never actually hid itself, which is the literal "stuck
// bubble" bug this fixes. floor/ceil bound a rough reading-speed estimate
// (~55ms/char) so a short "OK!" doesn't linger as long as a full sentence,
// and a long reply isn't yanked away before it can be read.
const BUBBLE_AUTO_HIDE_FLOOR_MS = 3800;
const BUBBLE_AUTO_HIDE_CEIL_MS = 9000;
const BUBBLE_MS_PER_CHAR = 55;
function bubbleLifetimeFor(text) {
  return Math.min(BUBBLE_AUTO_HIDE_CEIL_MS, Math.max(BUBBLE_AUTO_HIDE_FLOOR_MS, (text || "").length * BUBBLE_MS_PER_CHAR));
}

// The center the restricted orbit (index.html's min/max-camera-orbit) snaps
// back to once the user lets go — keeps Ollie facing the user by default
// (this is a Virtual Pet, not a spinning product-viewer artifact) while
// still letting a curious tap-and-drag peek at his side.
const DEFAULT_CAMERA_ORBIT = "0deg 80deg 170%";
const CAMERA_SNAP_BACK_DELAY_MS = 650;

// Max px offset the ambient backdrop (#ollie-ambient-bg) drifts toward the
// pointer — a depth cue, not a camera control, so it stays small/subtle.
const PARALLAX_MAX_PX = 14;

function replayAnimation(node, className) {
  node.classList.remove(className);
  void node.offsetWidth; // reflow, so a class already present can replay
  node.classList.add(className);
}

export const PetController = {
  modelViewer: null,
  stageEl: null,
  ambientEl: null,
  bubbleEl: null,
  bubbleTextEl: null,
  bubbleTypingEl: null,
  availableAnimations: [],
  currentState: "idle",
  // Spam-click prevention: while true, react() drops further pokes until
  // the current reaction clip finishes and crossfades back to idle.
  isAnimating: false,
  _talkTimer: null,
  _bubbleHideTimer: null,
  _bubbleHideHandler: null,
  _cameraTimer: null,
  _parallaxRaf: null,
  _parallaxTarget: { x: 0, y: 0 },

  init() {
    this.modelViewer = el("ollie-3d-model");
    if (!this.modelViewer) return;
    this.stageEl = el("ollie-3d-stage");
    this.ambientEl = el("ollie-ambient-bg");
    this.bubbleEl = el("ollie-speech-bubble");
    this.bubbleTextEl = el("ollie-speech-bubble-text");
    this.bubbleTypingEl = el("ollie-speech-bubble-typing");
    // Dismissible per the brief — tapping the bubble itself clears it
    // immediately rather than making the user wait out the auto-hide timer.
    // .ollie-speech-hotspot (the model-viewer-positioned ancestor) stays
    // pointer-events:none so it never intercepts the camera-controls drag;
    // only the bubble itself (style.css) re-enables hit-testing.
    if (this.bubbleEl) this.bubbleEl.addEventListener("click", () => this.dismissBubble());
    this._initAmbientParallax();

    // customElements.whenDefined resolves once index.html's SRI-pinned
    // <script type="module"> for model-viewer has actually registered the
    // element — reading .model/.availableAnimations any earlier would just
    // see the plain HTMLElement prototype, not model-viewer's real API.
    customElements.whenDefined("model-viewer").then(() => {
      // Race: on a fast/cached parse the model can finish loading (and fire
      // its own 'load' event) before this .then() callback ever runs, since
      // whenDefined's promise resolution is a separate microtask hop from
      // model-viewer's internal load pipeline. A listener attached after
      // that point would simply never fire, leaving availableAnimations
      // empty and setState() a no-op — observed live as Ollie stuck on
      // index.html's animation-name default (idle) never being confirmed by
      // _onLoad, harmless now that that default IS idle, but this is the
      // actual bug that let it silently ride out on whatever clip happened
      // to autoplay first before that attribute was added. Checking
      // .loaded synchronously here and calling _onLoad() immediately closes
      // that gap regardless of which side of the race wins.
      if (this.modelViewer.loaded) {
        this._onLoad();
      } else {
        this.modelViewer.addEventListener("load", () => this._onLoad());
      }
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
    // thinking and talking currently share the same baked clip
    // ("headtwist") — index.html's animation-crossfade-duration only smooths
    // a transition BETWEEN two different tracks, so re-assigning the SAME
    // clip name and forcing currentTime back to 0 has nothing to crossfade
    // against and reads as a hard snap-and-restart (this is what made mobile
    // touch interactions, which flip thinking->talking in quick succession,
    // feel robotic). Skip the restart when the requested clip is already the
    // one playing, so it just keeps flowing.
    if (this.modelViewer.animationName === clip && !this.modelViewer.paused) return;
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
    // CSS-only tactile feedback (scale/squash "pokeBounce" on the
    // .ollie-3d-stage wrapper, never on the model-viewer element itself —
    // see that class's own comment in style.css for why) — fires
    // regardless of whether a real skeletal reaction clip below resolves,
    // so a tap always reads as registering. replayAnimation's
    // remove/reflow/re-add idiom makes rapid re-triggering safe on its own;
    // isAnimating below is still the real cooldown once a clip is playing.
    if (this.stageEl) {
      replayAnimation(this.stageEl, "pet-reaction");
      setTimeout(() => this.stageEl.classList.remove("pet-reaction"), 300);
    }
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

  // Shared bubble-content writer — every path that puts text/typing-dots
  // into the bubble (speak/showTyping/celebrate) funnels through this, so
  // there is exactly one place that clears a pending auto-hide timer before
  // showing fresh content. Without that clear, a new message arriving while
  // an older auto-hide timer was still counting down would get hidden out
  // from under it moments later by the STALE timer — the "overlap" half of
  // the brief's bug report.
  _showBubble(text, { isTyping = false, isError = false } = {}) {
    if (!this.bubbleEl) return;
    clearTimeout(this._bubbleHideTimer);
    // A fresh message interrupting an in-flight fade-out removes the class
    // driving it BEFORE the browser fires 'animationend' for that instance
    // (canceling a running CSS animation never dispatches that event) — so
    // the dismissBubble() listener below is torn down explicitly here too,
    // not just left to fire later. Without this, every interrupted fade
    // left one more permanently-attached listener behind: a real leak, not
    // a hypothetical one, given how often a new line can land mid-fade.
    if (this._bubbleHideHandler) {
      this.bubbleEl.removeEventListener("animationend", this._bubbleHideHandler);
      this._bubbleHideHandler = null;
    }
    this.bubbleEl.classList.remove("ollie-bubble-out");
    this.bubbleTypingEl.hidden = !isTyping;
    this.bubbleTextEl.hidden = isTyping;
    if (!isTyping) this.bubbleTextEl.textContent = text;
    this.bubbleEl.hidden = false;
    this.bubbleEl.classList.toggle("ollie-speech-bubble-error", isError);
    replayAnimation(this.bubbleEl, "ollie-bubble-pop");
  },

  // Fades the bubble out and hides it — the fix for bubbles that used to sit
  // there forever once TALKING_PULSE_MS elapsed (that timer only ever reset
  // the ANIMATION state, never the bubble's own visibility). Safe to call
  // repeatedly/rapidly: idempotent on an already-hidden bubble, and the
  // tracked handler above is always torn down before a new one is attached,
  // so listeners can never pile up across calls.
  dismissBubble() {
    clearTimeout(this._bubbleHideTimer);
    if (!this.bubbleEl || this.bubbleEl.hidden) return;
    if (this._bubbleHideHandler) {
      this.bubbleEl.removeEventListener("animationend", this._bubbleHideHandler);
    }
    this.bubbleEl.classList.remove("ollie-bubble-pop");
    replayAnimation(this.bubbleEl, "ollie-bubble-out");
    this._bubbleHideHandler = () => {
      this.bubbleEl.hidden = true;
      this.bubbleEl.classList.remove("ollie-bubble-out");
      this._bubbleHideHandler = null;
    };
    this.bubbleEl.addEventListener("animationend", this._bubbleHideHandler, { once: true });
  },

  // The single entry point for "Ollie says something" — owns writing the
  // text into the 3D hotspot bubble, the TALKING animation pulse, AND now
  // scheduling its own auto-hide, so callers (coachChat.js) never touch
  // bubble internals or timers directly; they just call speak(text).
  // autoHide: false is for callers that manage the bubble's lifetime
  // themselves (none currently do, kept as an escape hatch rather than a
  // hardcoded assumption every caller wants the timer).
  speak(text, { isError = false, autoHide = true } = {}) {
    if (!this.bubbleEl) return;
    this._showBubble(text, { isError });
    this.setState("talking");
    clearTimeout(this._talkTimer);
    this._talkTimer = setTimeout(() => {
      // Only revert if nothing else has moved the state machine on since
      // this pulse started — e.g. a fresh showTyping() already switched to
      // THINKING for the next exchange by the time this fires.
      if (this.currentState === "talking") this.setState("idle");
    }, TALKING_PULSE_MS);
    if (autoHide) {
      this._bubbleHideTimer = setTimeout(() => this.dismissBubble(), bubbleLifetimeFor(text));
    }
  },

  // Swaps the bubble into its typing-dots state — same bubble, same
  // position, just its content — and moves the pet into THINKING while a
  // reply (real or local-simulated) is in flight. No auto-hide timer here:
  // this state is always superseded by a speak() call moments later, never
  // left showing on its own.
  showTyping() {
    if (!this.bubbleEl) return;
    this._showBubble("", { isTyping: true });
    this.setState("thinking");
  },

  hideTyping() {
    if (this.bubbleTypingEl) this.bubbleTypingEl.hidden = true;
  },

  // One-shot "I noticed what you just did" reaction — the tie between real
  // nutrition logging (app.js's insertOptimisticLog/addWaterOptimistic, via
  // petHud.js's pulseFeed/pulseHydrate) and Ollie feeling alive per the
  // brief. Deliberately reuses react()'s existing one-shot/cooldown-guarded
  // flourish rather than driving the animation state machine itself, so a
  // celebration can never get stuck looping: react() already plays its clip
  // exactly once and self-reverts to idle via its own 'finished' listener.
  // The bubble text is fully independent of that animation and manages its
  // own auto-hide the same way speak() does.
  celebrate(text) {
    if (!this.bubbleEl) return;
    this._showBubble(text, { isError: false });
    this.react();
    this._bubbleHideTimer = setTimeout(() => this.dismissBubble(), bubbleLifetimeFor(text));
  },

  // Full reset for a fresh conversation (coachChat.js's resetConversation) —
  // hides the bubble outright and returns to idle, clearing every pending
  // timer (talk pulse AND auto-hide) so neither can fire later and reopen a
  // bubble nobody asked for.
  reset() {
    clearTimeout(this._talkTimer);
    clearTimeout(this._bubbleHideTimer);
    if (this.bubbleEl) {
      if (this._bubbleHideHandler) {
        this.bubbleEl.removeEventListener("animationend", this._bubbleHideHandler);
        this._bubbleHideHandler = null;
      }
      this.bubbleEl.hidden = true;
      this.bubbleEl.classList.remove("ollie-bubble-pop", "ollie-bubble-out", "ollie-speech-bubble-error");
    }
    if (this.bubbleTypingEl) this.bubbleTypingEl.hidden = true;
    this.setState("idle");
  },

  // Ollie's resting look reacts to his own health — petHud.js calls this
  // with the same server-judged mood string that already drives its own HUD
  // caption (backend/services/pet_service.py's mood_for_hearts output is the
  // one shared source of truth). Purely a static CSS hook (a data attribute
  // read by style.css), never touched per-frame, so it costs nothing against
  // the 60fps budget the live 3D render already has to hit.
  setMood(mood) {
    if (this.stageEl) this.stageEl.dataset.mood = mood || "happy";
  },

  // Desktop-only ambient-backdrop parallax — the environment "reacting to
  // user input" half of the gamified-interactivity brief, kept strictly off
  // #ollie-3d-model itself (see that element's own comment on why nothing
  // but model-viewer's own camera-controls may ever set its transform).
  // Gated on `(hover: hover) and (pointer: fine)` so touch devices — where
  // the 60fps budget is tightest and pointermove is noisy/meaningless
  // during a touch-drag anyway — never attach the listener at all, i.e.
  // zero cost on mobile rather than a cost that's merely small. Also skips
  // under prefers-reduced-motion, same as the reaction flourish above.
  _initAmbientParallax() {
    if (!this.ambientEl || !this.stageEl || prefersReducedMotion) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    this.stageEl.addEventListener("pointermove", (event) => {
      const rect = this.stageEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nx = (event.clientX - rect.left) / rect.width - 0.5;
      const ny = (event.clientY - rect.top) / rect.height - 0.5;
      this._parallaxTarget.x = nx * PARALLAX_MAX_PX;
      this._parallaxTarget.y = ny * PARALLAX_MAX_PX;
      this._scheduleParallaxFrame();
    });
  },

  // Coalesces potentially many pointermove events into at most one DOM
  // write per animation frame.
  _scheduleParallaxFrame() {
    if (this._parallaxRaf) return;
    this._parallaxRaf = requestAnimationFrame(() => {
      this._parallaxRaf = null;
      this.ambientEl.style.transform = `translate3d(${this._parallaxTarget.x}px, ${this._parallaxTarget.y}px, 0)`;
    });
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
