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
// setMood/setPokeResponder/reset), so there is exactly one place that can
// put the pet's visuals in an inconsistent state.
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
  // The BIG one-shot flourish, reserved for celebrate() — a real logged
  // food/water action, i.e. something Ollie should genuinely make a fuss
  // about. Kept as its own key ("reaction") distinct from "poke" below so a
  // casual tap and a real accomplishment don't feel like the same event.
  reaction: "EagleOwl_Rig|EagleOwl_Rig|fly",
  // The tap-to-interact clip — deliberately NOT "fly". A full flap for every
  // idle poke reads as overkill (and, being a full flight cycle, is the
  // slowest of the five clips — a poke should feel instant, not like waiting
  // out a takeoff). "headtwist" is quick, has zero root-bone motion (unlike
  // "fly"/"landing" — see the comment below), and reads exactly like "he
  // noticed you and glanced over," which is the right size for a casual tap.
  poke: "EagleOwl_Rig|EagleOwl_Rig|headtwist",
};
// Deliberately NOT "landing" for talking, even though it reads as more of an
// "active" flourish: verified live that it drives real root-bone motion (the
// whole body drops/settles, not just the head), which drags the model out
// from under the hotspot's fixed 3D anchor point mid-sentence — the bubble
// would visibly drift off Ollie's head. "headtwist" only moves the
// head/neck, so the body stays put and the bubble stays correctly anchored
// for as long as TALKING/THINKING (or a "poke" reaction) hold. "fly" is
// reserved for celebrate()'s bigger flourish, which drives the same kind of
// root-bone motion as "landing" — react()'s own `onSettled` callback is what
// makes a reaction bubble safe regardless of which clip played: any text
// tied to a reaction is deferred until the clip finishes and the model is
// back in its calibrated idle pose, instead of showing (and dragging around
// the screen) while a root-motion clip is still playing.
//
// Substring fallback — only reached if a future glb swap ships clips under
// different exact names, so state playback degrades gracefully to "closest
// named match" instead of going silent.
const STATE_NAME_HINTS = {
  idle: ["idle", "breath", "rest"],
  thinking: ["headtwist", "think", "look", "curious"],
  talking: ["headtwist", "talk", "chat", "active"],
  reaction: ["fly", "flap", "react", "jump", "greet", "wave"],
  poke: ["headtwist", "look", "curious", "greet", "wave"],
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

// A one-shot reaction (a log celebration or a tap-to-interact poke) is a
// bigger, rarer beat than an ordinary chat reply — it deserves noticeably
// longer on screen than bubbleLifetimeFor's chat-tuned floor gives it, so
// the user actually has time to register both the flourish AND read what
// Ollie said about it before it fades.
const REACTION_BUBBLE_MIN_MS = 5500;

// How long AFTER a tap-to-interact reaction settles before another tap is
// allowed to start a new one. Without this, rapid/spam tapping was only
// guarded by `isAnimating` (true only while a clip is actually mid-flight),
// so a tap landing right as the previous one settled — or several taps
// queued up during a single quick reaction — each still called their own
// settle() and popped a fresh bubble, reading as messages stacking/
// overriding one another. This grace period makes a poke feel like a real,
// deliberate interaction rather than a machine-gun trigger.
const POKE_COOLDOWN_MS = 500;

// Safety-net bound for _playOneShot's race against `modelViewer.updateComplete`
// — see that method's own comment for why a bare, unbounded await there
// would be a genuine hang risk, not just a theoretical one.
const PLAY_SAFETY_TIMEOUT_MS = 120;

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
  // A timestamp (performance.now()-scale), not a boolean — the extra grace
  // window after a tap-reaction settles during which further taps are
  // silently ignored (see POKE_COOLDOWN_MS). 0 means "no cooldown pending."
  _pokeCooldownUntil: 0,
  // Injected by petHud.js (a plain () => string|null callback) — kept
  // domain-agnostic here on purpose, same separation as everything else in
  // this file: ollie3d.js owns the 3D/bubble mechanics, petHud.js owns what
  // Ollie should actually SAY (recalling the last logged action, or a
  // generic greeting when there isn't one yet).
  pokeResponder: null,
  _talkTimer: null,
  _bubbleHideTimer: null,
  _bubbleHideHandler: null,
  // The listener react() attaches to model-viewer's 'finished' event for the
  // in-flight one-shot clip — tracked so setState()/reset() can explicitly
  // tear it down when they need to abandon that clip early instead of
  // leaving it dangling (see setState's own comment on why that dangling
  // listener was a real bug: it left `isAnimating` stuck true forever).
  _reactionFinishedHandler: null,
  // Bumped on every _showBubble() call (from ANY source — speak/showTyping/
  // a reaction's own delayed bubble). A reaction's bubble text is shown only
  // if this hasn't moved since the reaction started, so a slow-to-settle
  // poke/celebration can never clobber fresher content (e.g. a real chat
  // reply that landed while the reaction was still mid-flight) — see
  // react()'s own comment.
  _bubbleGeneration: 0,
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
    this.modelViewer.addEventListener("pointerdown", () => {
      this.react({ clip: "poke", spamGuard: true, onSettled: () => this._speakPoke() });
    });

    // Fix for "stuck mid-fly-animation" / "tap-to-interact goes dead" on real
    // mobile devices: backgrounding the tab (app switch, screen lock) pauses
    // <model-viewer>'s internal render loop entirely, so a one-shot reaction
    // clip that's mid-flight at that moment never gets to fire its own
    // 'finished' event — the sheet-close MutationObserver in coachChat.js
    // only resets on the SHEET closing, not on the whole tab/app being
    // backgrounded while the sheet stays open. Left alone, that leaves
    // `isAnimating` stuck true forever, which is also why taps stop doing
    // anything afterward: react()'s own spam guard treats a stuck
    // `isAnimating` as "something's still mid-flight" and silently drops
    // every future poke. Resetting on the way OUT (before the render loop
    // actually pauses) guarantees a clean idle baseline is already committed
    // regardless of whether 'finished' ever gets to fire; resetting again on
    // the way back IN is a harmless, idempotent belt-and-suspenders in case
    // the model was disturbed some other way while backgrounded.
    document.addEventListener("visibilitychange", () => this.reset());
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
    // A one-shot reaction (react()) can still be mid-flight when a
    // conversational state needs to take over the model right now — e.g. a
    // real chat reply landing (speak()) while a tap's poke animation is
    // still playing. Abandon that clip cleanly here rather than letting
    // this call silently race it: explicitly tear down the 'finished'
    // listener react() is waiting on (removeEventListener needs the exact
    // same reference, which is why it's tracked) and clear isAnimating
    // ourselves. Without this, that listener would simply never fire (we're
    // about to overwrite animationName out from under it), leaving
    // isAnimating stuck true forever — every future tap/celebration would
    // silently no-op against that stale cooldown flag, reading as "Ollie
    // stopped reacting to anything," which is exactly what was happening.
    if (this.isAnimating) {
      if (this._reactionFinishedHandler) {
        this.modelViewer.removeEventListener("finished", this._reactionFinishedHandler);
        this._reactionFinishedHandler = null;
      }
      this.isAnimating = false;
    }
    this.modelViewer.animationName = clip;
    this.modelViewer.currentTime = 0;
    this.modelViewer.play({ repetitions: Infinity });
  },

  getState() {
    return this.currentState;
  },

  // The tap/poke reaction (clip: "poke") and the bigger log-celebration
  // flourish (clip: "reaction", celebrate()'s default) share this one
  // one-shot player. Cooldown-locked against spam-clicking two different
  // ways:
  //   - `isAnimating` blocks a genuinely overlapping request (something is
  //     already mid-flight) regardless of caller.
  //   - `spamGuard: true` (only the tap-to-interact pointerdown handler
  //     passes this) ALSO respects POKE_COOLDOWN_MS after the last reaction
  //     settled, and — critically — a tap dropped for either reason gets
  //     ONLY the tiny CSS tactile bounce, never a new bubble. Rapid/spam
  //     tapping used to still call settle() (and pop a fresh bubble) for
  //     every dropped tap, which is exactly what made messages visibly
  //     stack/override one another. `spamGuard: false` (celebrate()'s
  //     default) keeps the opposite guarantee instead: a REAL logged
  //     action's feedback must never be silently dropped just because a
  //     poke happens to be mid-flight, so it still calls settle() right
  //     away (minus the flourish) rather than being ignored outright.
  // Skipped entirely under prefers-reduced-motion — a flourish clip is
  // extra, unlike idle/thinking/talking which communicate real state and
  // stay on regardless.
  //
  // `onSettled`, if given, fires once Ollie is actually back in the idle
  // pose the speech-bubble hotspot is calibrated against — never while a
  // root-motion clip ("fly", used by celebrate()) is still mid-flight. That
  // clip drives real root-bone motion (a takeoff flap, not just a head
  // turn — the same category of motion this file's own ANIMATION_CLIPS
  // comment already flags for "landing"), which drags the hotspot's
  // projected screen position away from its calibrated spot. Showing bubble
  // text WHILE that's happening is what let a celebration's reply visibly
  // drift down the screen — far enough in practice to land near the bottom
  // dock's suggestion chips, reading as "stale suggestions glitching back
  // in." Deferring to onSettled instead means the bubble only ever appears
  // once the model has stopped moving. Also fired synchronously
  // (immediately) whenever no reaction can play at all — reduced motion, an
  // unresolved clip, or a non-spam-guarded caller finding the model
  // busy — so a real caller's feedback text is never silently dropped, just
  // shown without the flourish.
  react({ onSettled, clip: clipKey = "reaction", spamGuard = false } = {}) {
    const settle = () => { if (onSettled) onSettled(); };
    if (!this.modelViewer || prefersReducedMotion) {
      settle();
      return;
    }
    const now = performance.now();
    if (this.isAnimating || (spamGuard && now < this._pokeCooldownUntil)) {
      if (spamGuard) {
        // Still-cooling-down or already-mid-reaction spam tap — a tiny
        // tactile nudge so it doesn't feel completely unresponsive, but
        // deliberately no bubble/animation restart. This is the fix for
        // rapid tapping firing off a burst of overlapping messages.
        this._pokeBounce();
        return;
      }
      settle();
      return;
    }
    this._pokeBounce();
    const clip = this._clipFor(clipKey);
    if (!clip) {
      settle();
      return;
    }
    this.isAnimating = true;
    // Captured now, checked in the handler below — if something else shows
    // newer bubble content (a real chat reply, another reaction) before
    // this clip finishes, this stale settle() is dropped instead of
    // clobbering it. See _bubbleGeneration's own comment.
    const generationAtStart = this._bubbleGeneration;
    this._playOneShot(clip).then((started) => {
      if (!started) {
        // Superseded mid-flight by a fresher state change (e.g. setState()
        // reassigning the model to a real chat reply that landed) — that
        // call already reset isAnimating and owns the model now; nothing
        // left to settle here.
        return;
      }
      this._reactionFinishedHandler = () => {
        this.isAnimating = false;
        this._reactionFinishedHandler = null;
        this._pokeCooldownUntil = performance.now() + POKE_COOLDOWN_MS;
        // Don't stomp a fresher conversational state that already took over
        // while this reaction was playing (e.g. a real reply landed and
        // called speak(), switching to "talking") — only settle back to
        // idle if nothing else has claimed the model since.
        if (this.currentState !== "talking" && this.currentState !== "thinking") {
          this.setState("idle");
        }
        if (this._bubbleGeneration === generationAtStart) settle();
      };
      this.modelViewer.addEventListener("finished", this._reactionFinishedHandler, { once: true });
    }).catch(() => {
      // Belt-and-suspenders: _playOneShot's own updateComplete race already
      // swallows a rejection there, so this only guards against something
      // unexpected throwing synchronously inside .play() itself (e.g. the
      // sheet closing and the element being torn down mid-flight). Without
      // this, an uncaught rejection here would leave isAnimating stuck
      // true forever — the exact "stopped reacting to anything" failure
      // this whole mechanism exists to prevent.
      this.isAnimating = false;
      this._reactionFinishedHandler = null;
      settle();
    });
  },

  // CSS-only tactile feedback (scale/squash "pokeBounce" on the
  // .ollie-3d-stage wrapper, never on the model-viewer element itself — see
  // that class's own comment in style.css for why) — fires on every tap
  // regardless of whether a real skeletal reaction clip ends up playing, so
  // a poke always reads as registering, even a spam-guarded one.
  // replayAnimation's remove/reflow/re-add idiom makes rapid re-triggering
  // safe on its own.
  _pokeBounce() {
    if (!this.stageEl) return;
    replayAnimation(this.stageEl, "pet-reaction");
    setTimeout(() => this.stageEl.classList.remove("pet-reaction"), 300);
  },

  // Plays `clip` as a genuine one-shot (repetitions: 1) — the one place in
  // this file that has to work around a real <model-viewer> race, not just
  // one of our own. Setting the `animationName` PROPERTY schedules the
  // element's own internal Lit `updated()` lifecycle callback, which ALSO
  // restarts the animation — but always with model-viewer's own hardcoded
  // default (`{repetitions: Infinity}`), regardless of whatever options a
  // caller intends to use (verified directly in @google/model-viewer's own
  // source: `features/animation.ts`'s `updated()` calls `this[$changeAnimation]()`
  // with no arguments whenever `animationName` changed). That internal call
  // runs asynchronously, AFTER this function's own synchronous code — so
  // calling `.play({repetitions: 1})` synchronously right after setting
  // `animationName` loses the race almost every time: the internal default
  // silently overwrites it moments later and the clip loops forever instead
  // of stopping once. This is what made a SECOND tap-poke flap
  // indefinitely, even though the first one correctly played once and
  // returned to idle — awaiting `updateComplete` (a standard Lit API
  // `<model-viewer>` exposes) guarantees this function's own
  // `.play({repetitions: 1})` call runs strictly AFTER that internal
  // default has already applied, so ours is the one that actually sticks.
  //
  // Returns false (without calling play()) if something else reassigned
  // `animationName` while this was waiting on `updateComplete` — narrow, but
  // real: e.g. a fresher setState() call interrupting this same microtask
  // window. react() treats that as "superseded, not my clip to finish."
  //
  // `updateComplete` is raced against a short timeout rather than awaited
  // bare: Lit's own contract only promises it settles once every mixin's
  // update logic finishes cleanly, and model-viewer is a stack of several
  // mixins (loading, environment, annotation/hotspots, animation, ...) — if
  // any one of them ever throws or the promise otherwise never settles, a
  // bare `await` here would hang `react()` forever, permanently stuck with
  // `isAnimating` true and every future tap silently swallowed (exactly the
  // "he stopped reacting to anything" symptom this whole mechanism exists to
  // prevent). The timeout is a pure safety net for that failure mode, not
  // the expected path — normally `updateComplete` settles within a
  // microtask or two, far under this bound.
  async _playOneShot(clip) {
    this.modelViewer.animationName = clip;
    this.modelViewer.currentTime = 0;
    await Promise.race([
      this.modelViewer.updateComplete.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, PLAY_SAFETY_TIMEOUT_MS)),
    ]);
    if (this.modelViewer.animationName !== clip) return false;
    this.modelViewer.play({ repetitions: 1 });
    return true;
  },

  // Shared by react()'s tap-to-interact path and celebrate() below — writes
  // reaction-triggered bubble text with the longer REACTION_BUBBLE_MIN_MS
  // floor (these are rarer, bigger beats than an ordinary chat line, and
  // deserve more time on screen) rather than routing through speak(), which
  // also carries chat-specific "talking" state/TALKING_PULSE semantics this
  // path has no use for (react()'s own finished handler already owns
  // returning to idle).
  _showReactionBubble(text) {
    if (!text || !this.bubbleEl) return;
    this._showBubble(text, { isError: false });
    clearTimeout(this._bubbleHideTimer);
    this._bubbleHideTimer = setTimeout(
      () => this.dismissBubble(),
      Math.max(REACTION_BUBBLE_MIN_MS, bubbleLifetimeFor(text))
    );
  },

  // Tap-to-interact's own contextual line — petHud.js's pokeResponder
  // recalls the last logged action (or falls back to a generic greeting
  // when there isn't one yet this session). A no-op if nothing was
  // injected (pokeResponder never set) or it returns nothing to say.
  _speakPoke() {
    const text = typeof this.pokeResponder === "function" ? this.pokeResponder() : null;
    this._showReactionBubble(text);
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
    this._bubbleGeneration++;
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
  // The bubble text is deferred to react()'s onSettled (see its own comment
  // on why: showing it any earlier, while "fly"'s root-bone motion is still
  // dragging the hotspot around, is what let it drift toward the bottom
  // dock instead of sitting over Ollie's head) — still shown immediately if
  // the reaction itself can't play at all (cooldown/reduced-motion/no
  // clip), since the feedback that a log actually registered must never be
  // silently dropped just because the flourish was.
  celebrate(text) {
    if (!this.bubbleEl) return;
    this.react({ onSettled: () => this._showReactionBubble(text) });
  },

  // The AI Coach sheet's own open-moment greeting (coachChat.js's
  // openCoachSheet) — same flourish+recall-speech shape as a manual poke
  // (react() + pokeResponder, see _speakPoke above), just fired automatically
  // the instant the sheet opens instead of waiting for a tap. This is what
  // lets the badge/recall feature (petHud.js's _lastAction) actually surface
  // "here's what you just logged" the moment Ollie is opened, not only if
  // the user happens to poke him too.
  greet() {
    this.react({ onSettled: () => this._speakPoke() });
  },

  // Full reset for a fresh conversation (coachChat.js's resetConversation) —
  // hides the bubble outright and returns to idle, clearing every pending
  // timer (talk pulse AND auto-hide) so neither can fire later and reopen a
  // bubble nobody asked for.
  reset() {
    clearTimeout(this._talkTimer);
    clearTimeout(this._bubbleHideTimer);
    if (this.isAnimating && this._reactionFinishedHandler && this.modelViewer) {
      this.modelViewer.removeEventListener("finished", this._reactionFinishedHandler);
    }
    this._reactionFinishedHandler = null;
    this.isAnimating = false;
    this._pokeCooldownUntil = 0;
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

  // Lets petHud.js supply what Ollie should say when poked (recalling the
  // last logged action, or a generic greeting) without this file needing to
  // know anything about feeding/hydration/logging — keeps the
  // domain-agnostic split described at the top of this file intact.
  setPokeResponder(fn) {
    this.pokeResponder = typeof fn === "function" ? fn : null;
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
