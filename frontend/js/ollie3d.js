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
// written against). Exact names, matched first; re-verify/update this map
// against `modelViewer.availableAnimations` after any future model swap.
const ANIMATION_CLIPS = {
  idle: "EagleOwl_Rig|EagleOwl_Rig|idle",
  thinking: "EagleOwl_Rig|EagleOwl_Rig|headtwist",
  talking: "EagleOwl_Rig|EagleOwl_Rig|headtwist",
  // celebrate()'s flourish used to point at "fly" for a bigger beat than a
  // casual poke. Switched to the same "headtwist" clip "poke" already uses:
  // "fly"/"landing" both drive real root-bone motion (the whole body
  // drops/moves, not just the head), which drags the 3D speech-bubble
  // hotspot (a real model-viewer hotspot tracking a point on the rig, not a
  // screen-fixed element) around with it. That was tolerable back when the
  // bubble was deferred until the clip fully finished, but the bubble now
  // shows THE INSTANT react() is called (see react()'s own comment) — text
  // co-occurring with "fly"'s root motion would visibly drift off Ollie's
  // head instead. "headtwist" has zero root-bone motion, so the hotspot
  // stays put no matter when the bubble appears.
  reaction: "EagleOwl_Rig|EagleOwl_Rig|headtwist",
  // The tap-to-interact clip. Same clip as "reaction" above for the same
  // no-root-motion reason — "he noticed you" reads fine at either size.
  poke: "EagleOwl_Rig|EagleOwl_Rig|headtwist",
};
// Substring fallback — only reached if a future glb swap ships clips under
// different exact names, so state playback degrades gracefully to "closest
// named match" instead of going silent.
const STATE_NAME_HINTS = {
  idle: ["idle", "breath", "rest"],
  thinking: ["headtwist", "think", "look", "curious"],
  talking: ["headtwist", "talk", "chat", "active"],
  reaction: ["headtwist", "look", "curious", "greet", "wave"],
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

// Pure debounce on the tap listener — ignores a second tap landing within
// this many ms of the last ACCEPTED one, full stop, regardless of whether a
// reaction clip is still playing. This is the only thing standing between a
// real finger and a flood of restarted reactions; it does not gate the
// bubble or wait for anything to finish (see react()'s own comment: every
// accepted tap interrupts whatever's running and starts fresh immediately).
// Short enough to be imperceptible as a delay, long enough to absorb a
// double-fired pointerdown on touch hardware.
const TAP_DEBOUNCE_MS = 220;

// Safety-net bound for _playOneShot's race against `modelViewer.updateComplete`
// — see that method's own comment for why a bare, unbounded await there
// would be a genuine hang risk, not just a theoretical one.
const PLAY_SAFETY_TIMEOUT_MS = 120;

// Bounds how long a one-shot reaction POSE is held before forcing the model
// back to idle — completely independent of the bubble/text, which react()
// now shows synchronously at call time (see its own comment). This only
// exists because model-viewer's 'finished' event doesn't fire until a
// clip's full declared duration elapses, and that duration can't be trusted:
// live-measured against this app's real assets/ollie_model.glb, "headtwist"
// (reused for both "poke" and "reaction", see ANIMATION_CLIPS) is 9.8s long.
// Left unbounded, the model would visibly hold a non-idle pose for that
// entire real duration after every tap/celebration. Whichever of 'finished'
// or this timer fires first returns the model to idle; the other is a no-op
// once `_reactionFinishedHandler` has already been cleared.
const REACTION_POSE_HOLD_MS = 900;

// Lifetime tap-interaction count, persisted to localStorage purely for the
// Badges tab's Ollie-themed milestones (progress.js's MILESTONE_DEFINITIONS:
// ollieFirstHello/ollieDevotedFriend) to read back. This module deliberately
// does NOT import progress.js (or know the badge system exists at all) — it
// just writes one plain counter, the same loosely-coupled,
// shared-localStorage-substrate pattern already used elsewhere in this app
// (e.g. tutorial.js and app.js coordinate the same way, never importing each
// other). Counts every raw poke, including ones react() itself drops for
// being mid-cooldown (see react()'s spam guard below) — a rapid-fire spam tap
// still reflects genuine interaction with Ollie, which is exactly what this
// is meant to reward.
const OLLIE_TAP_COUNT_KEY = "ollieTapCount";
function recordOllieTap() {
  const count = Number(localStorage.getItem(OLLIE_TAP_COUNT_KEY) || "0") + 1;
  localStorage.setItem(OLLIE_TAP_COUNT_KEY, String(count));
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
  // True while a one-shot reaction clip is playing — purely a POSE-tracking
  // flag now (see REACTION_POSE_HOLD_MS), never gates the bubble.
  isAnimating: false,
  // A timestamp (performance.now()-scale) — the pure debounce window on the
  // tap listener (see TAP_DEBOUNCE_MS). 0 means "no debounce pending."
  _pokeDebounceUntil: 0,
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
  // Tracked so it can be cleared the moment the real 'finished' handler (or
  // setState()'s dangling-listener cleanup, or reset()) runs first — see
  // REACTION_POSE_HOLD_MS's own comment for why this exists at all.
  _reactionSafetyTimer: null,
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
      recordOllieTap();
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
    // still playing. Abandon that clip cleanly rather than letting this
    // call silently race it (see _interruptReaction()'s own comment).
    this._interruptReaction();
    this.modelViewer.animationName = clip;
    this.modelViewer.currentTime = 0;
    this.modelViewer.play({ repetitions: Infinity });
  },

  // Tears down whatever one-shot reaction is currently in flight — the
  // 'finished' listener (removeEventListener needs the exact same
  // reference, which is why it's tracked), the pose-hold safety timer, and
  // the isAnimating flag. Shared by setState() (a conversational state
  // taking the model over mid-reaction), react() itself (a fresh tap/
  // celebration always wins immediately over whatever was already playing —
  // see react()'s own comment), and reset(). Without this teardown anywhere
  // it's needed, a dangling listener/timer would eventually fire against a
  // reaction nothing is waiting on anymore — harmless by construction (the
  // caller re-checks `_reactionFinishedHandler` before acting) but pointless
  // work, and historically the exact shape of bug that left `isAnimating`
  // stuck true forever when the teardown was missing from a given call site.
  _interruptReaction() {
    if (this._reactionFinishedHandler && this.modelViewer) {
      this.modelViewer.removeEventListener("finished", this._reactionFinishedHandler);
    }
    this._reactionFinishedHandler = null;
    clearTimeout(this._reactionSafetyTimer);
    this.isAnimating = false;
  },

  // The tap/poke reaction (clip: "poke") and the log-celebration flourish
  // (clip: "reaction", celebrate()'s default) share this one one-shot
  // player. Two guarantees, both load-bearing:
  //
  // 1. The bubble/text (`onSettled`) fires SYNCHRONOUSLY, right here, before
  //    any animation work even starts — never deferred until a clip
  //    finishes. Feedback for a real action (a poke registering, a log
  //    landing) must never wait on a 3D animation's own timing, which can't
  //    be trusted anyway (see REACTION_POSE_HOLD_MS: a "quick" clip on this
  //    app's real asset can genuinely run 9.8s). The flourish clip is
  //    decorative and plays independently in the background.
  //
  // 2. A new call always wins immediately. `spamGuard: true` (only the
  //    tap-to-interact pointerdown handler passes this) is a pure
  //    TAP_DEBOUNCE_MS debounce — a tap landing within that short window of
  //    the last ACCEPTED one gets only the tiny CSS tactile bounce, nothing
  //    else. Once past that debounce, and for every non-spam-guarded caller
  //    (celebrate()/greet(), which represent a real distinct event, not a
  //    possible double-fire) a call NEVER queues behind whatever's already
  //    playing — it interrupts it immediately (_interruptReaction()) and
  //    starts fresh. This is what guarantees a stale reaction can never pop
  //    up a delayed message after the user's stopped interacting: there is
  //    no deferred completion left to fire one.
  react({ onSettled, clip: clipKey = "reaction", spamGuard = false } = {}) {
    const now = performance.now();
    if (spamGuard && now < this._pokeDebounceUntil) {
      this._pokeBounce();
      return;
    }
    if (spamGuard) this._pokeDebounceUntil = now + TAP_DEBOUNCE_MS;
    this._interruptReaction();
    if (onSettled) onSettled();
    if (!this.modelViewer || prefersReducedMotion) return;
    this._pokeBounce();
    const clip = this._clipFor(clipKey);
    if (!clip) return;
    this.isAnimating = true;
    this._playOneShot(clip).then((started) => {
      if (!started) {
        // Superseded mid-flight by a fresher state change (e.g. setState()
        // or another react() call reassigning the model) — that call
        // already owns state via its own _interruptReaction(); nothing left
        // to do here.
        return;
      }
      this._reactionFinishedHandler = () => {
        clearTimeout(this._reactionSafetyTimer);
        this.isAnimating = false;
        this._reactionFinishedHandler = null;
        // Don't stomp a fresher conversational state that already took over
        // while this reaction was playing (e.g. a real reply landed and
        // called speak(), switching to "talking") — only settle back to
        // idle if nothing else has claimed the model since.
        if (this.currentState !== "talking" && this.currentState !== "thinking") {
          this.setState("idle");
        }
      };
      this.modelViewer.addEventListener("finished", this._reactionFinishedHandler, { once: true });
      // Race 'finished' against a hard bound — see REACTION_POSE_HOLD_MS's
      // own comment. Forces the exact same completion path 'finished' would
      // have taken, just without waiting out the clip's full real duration.
      this._reactionSafetyTimer = setTimeout(() => {
        if (!this._reactionFinishedHandler) return;
        this.modelViewer.removeEventListener("finished", this._reactionFinishedHandler);
        this._reactionFinishedHandler();
      }, REACTION_POSE_HOLD_MS);
    }).catch(() => {
      // Belt-and-suspenders: _playOneShot's own updateComplete race already
      // swallows a rejection there, so this only guards against something
      // unexpected throwing synchronously inside .play() itself (e.g. the
      // sheet closing and the element being torn down mid-flight).
      clearTimeout(this._reactionSafetyTimer);
      this.isAnimating = false;
      this._reactionFinishedHandler = null;
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
  // brief. Safe to call while the AI Coach sheet is closed (a Dashboard log
  // fires this regardless) — the bubble text shows instantly via react()'s
  // synchronous onSettled, so it's already correct by the time the sheet
  // (if any) opens; the flourish clip itself, if the sheet is later opened
  // mid-flight, gets immediately interrupted and replaced by whatever
  // reaction the sheet-open moment triggers next (see react()'s own
  // comment on why a fresh call always wins over a stale one).
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
  // the user happens to poke him too. Because react() always interrupts
  // whatever's currently playing (see its own comment), this unconditionally
  // takes over the model the instant the sheet opens — including cutting
  // off a still-in-flight celebrate() flourish left over from a Dashboard
  // log made while the sheet was closed, so opening Ollie never shows him
  // stuck mid-reaction from something the user isn't even looking at anymore.
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
    this._interruptReaction();
    this._pokeDebounceUntil = 0;
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

// lazyLoadModelViewer() itself now lives in modelViewerLoader.js and is
// deliberately NOT re-exported from here (a re-export is still a static
// import as far as Rollup's chunking is concerned) — coachChat.js and
// app.js's idle-time warm-up both import it directly, dynamically, from
// modelViewerLoader.js instead, which is what lets that file split into
// its own small chunk rather than merging into this module's (and, via
// coachChat.js/petHud.js's own static imports of THIS file, the rest of
// the AI Coach feature's) chunk. See modelViewerLoader.js's own comment
// for the full Rollup chunking reasoning.
//
// PetController.init() (above) doesn't need to know or care when — or
// whether — the model-viewer library has loaded yet: it already does
// `customElements.whenDefined("model-viewer").then(...)` before touching
// any real model-viewer API, specifically to tolerate the element
// registering later than init() itself runs (see that method's own
// comment on the whenDefined race). That guarantee is what makes calling
// lazyLoadModelViewer() from anywhere, at any time, safe.
