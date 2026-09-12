// ---------------------------------------------------------------------------
// The auth landing "stage" — the intro choreography, the light cone's
// self-demo, and Ollie's live reactions to what the user is doing on the form.
//
// Kept out of auth.js on the same split that separates petHud.js from
// ollie3d.js: auth.js owns credentials, Supabase calls and error mapping, and
// none of that should have to be read around a pile of animation timing.
// auth.js calls into this module at the eight points where it already knows
// something happened worth reacting to; this module never reads auth state,
// never touches Supabase, and every one of its exports is a safe no-op if the
// landing markup is absent (the `stage` guard below), so nothing here can
// take a login down with it.
//
// The character itself is composed from the <symbol> set at the top of
// index.html. Read that block's comment before touching any selector here:
// <use> content lives in a shadow tree, so the ONLY elements this module can
// style are the <use> elements themselves.
// ---------------------------------------------------------------------------
import { t } from "./i18n.js";

const stage = document.getElementById("auth-ollie");
const authScreen = document.getElementById("auth-screen");
const ollieSvg = stage?.querySelector(".auth-ollie-svg");
const bubble = document.getElementById("auth-ollie-bubble");
const bubbleText = document.getElementById("auth-ollie-bubble-text");
const lampToggle = document.getElementById("lamp-toggle");

// Per-browser, not per-account — the same shape as LAMP_HINT_SEEN_KEY and
// TUTORIAL_SEEN_KEY. "Has this device seen the full opening?" is a property of
// the install, and an account that signs in on a new phone has genuinely not
// seen it there.
const INTRO_SEEN_KEY = "ironlog_auth_intro_seen";

const reduceMotion =
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let introTimers = [];
let bubbleTimer = 0;
let introFinished = false;

function after(ms, fn) {
  introTimers.push(setTimeout(fn, ms));
}

function clearIntroTimers() {
  introTimers.forEach(clearTimeout);
  introTimers = [];
}

// ---------------------------------------------------------------------------
// Speech bubble. Every path that writes content funnels through here so a new
// line can never be hidden out from under itself by the previous line's
// still-pending auto-hide timer — the same bug PetController._showBubble()
// exists to prevent on the 3D Ollie, and the same fix.
// ---------------------------------------------------------------------------
const BUBBLE_MS_PER_CHAR = 55;
const BUBBLE_MIN_MS = 2200;
const BUBBLE_MAX_MS = 5200;

export function say(key, { hold = true } = {}) {
  if (!bubble || !bubbleText) return;
  clearTimeout(bubbleTimer);
  bubbleText.textContent = t(key);
  bubble.hidden = false;
  // One frame between `hidden = false` and the class: a transition cannot run
  // from a display:none starting state, so setting both together would snap.
  requestAnimationFrame(() => bubble.classList.add("is-visible"));
  if (!hold) return;
  const life = Math.min(
    BUBBLE_MAX_MS,
    Math.max(BUBBLE_MIN_MS, bubbleText.textContent.length * BUBBLE_MS_PER_CHAR),
  );
  bubbleTimer = setTimeout(hush, life);
}

export function hush() {
  if (!bubble) return;
  clearTimeout(bubbleTimer);
  bubble.classList.remove("is-visible");
  // Matches .auth-ollie-bubble's own 0.26s opacity transition — hiding it
  // outright any sooner would cut the fade off mid-way.
  bubbleTimer = setTimeout(() => {
    bubble.hidden = true;
  }, 300);
}

// ---------------------------------------------------------------------------
// Mood + one-shot reactions
// ---------------------------------------------------------------------------
export function setMood(mood) {
  if (stage) stage.dataset.mood = mood;
}

// A one-shot hop. Guarded against re-entry rather than restarted, so a user
// hammering the tabs gets one clean hop per landing instead of a stutter —
// same cooldown reasoning as PetController.react().
let reacting = false;
export function react() {
  if (!stage || reduceMotion || reacting) return;
  reacting = true;
  stage.classList.add("is-reacting");
  const done = () => {
    stage.classList.remove("is-reacting");
    reacting = false;
  };
  ollieSvg?.addEventListener("animationend", done, { once: true });
  // Failsafe: animationend does not fire on a backgrounded tab, and without
  // this the class would stick and block every later reaction. Same guard
  // progress.js uses on its own reactOllie timer.
  setTimeout(done, 900);
}

// Wings up over the eyes while a password field has focus.
export function hideEyes(hiding) {
  if (!stage) return;
  stage.classList.toggle("is-hiding", hiding);
  if (hiding) say("auth.olliePassword");
  else hush();
}

export function celebrate() {
  setMood("happy");
  react();
  say("auth.ollieSuccess", { hold: false });
}

// Used on a successful sign-in: he leaves the frame with the card rather than
// vanishing when the section is hidden. Best-effort and deliberately not
// awaited — auth.js must never hold a sign-in open waiting on an animation.
export function leave() {
  if (!stage || reduceMotion) return;
  stage.classList.add("is-leaving");
}

export function reset() {
  if (!stage) return;
  stage.classList.remove("is-leaving", "is-hiding", "is-reacting");
  reacting = false;
  setMood("content");
  hush();
}

// ---------------------------------------------------------------------------
// The intro
// ---------------------------------------------------------------------------

// Fast-forward. The finished state of every intro animation is the element's
// own natural state, so cancelling them all IS the completed screen — there is
// nothing to seek to and no per-element bookkeeping. Idempotent: called by the
// first input, by a restored session landing mid-flight, and by the tail of
// the sequence itself.
export function finishIntro() {
  if (introFinished) return;
  introFinished = true;
  clearIntroTimers();
  authScreen?.classList.add("intro-done");
  lampToggle?.classList.remove("lamp-flare", "pulling");
}

export function playIntro() {
  if (!authScreen) return;
  // A returning visit still plays the same sequence in the same order, just
  // at ~27% of the duration (see .is-fast in style.css) — recognisable, never
  // something to wait through. Written on the FIRST play, not at the end, so
  // an interrupted first run does not re-arm the long version next launch.
  const seen = (() => {
    try {
      return !!localStorage.getItem(INTRO_SEEN_KEY);
    } catch {
      return false; // private mode / blocked storage — degrade to the full intro
    }
  })();
  try {
    localStorage.setItem(INTRO_SEEN_KEY, "1");
  } catch {
    /* nothing to do — the intro simply plays long every time */
  }

  introFinished = false;
  clearIntroTimers();
  authScreen.classList.remove("intro-done");
  reset();

  if (reduceMotion) {
    // No stagger at all: the screen is simply present, and Ollie still greets
    // without motion. .has-intro is never added, so every rule in the intro
    // block stays unmatched and the natural state is what renders.
    // No beats will run, so wake him here or he stays asleep for good.
    setMood("awake");
    say(seen ? "auth.ollieWelcomeBack" : "auth.ollieWelcome");
    introFinished = true;
    return;
  }

  authScreen.classList.toggle("is-fast", seen);
  authScreen.classList.add("has-intro");

  const beat = seen ? 170 : 620;

  // The lamp performs its own pull. This is the whole reason the "Try me ✨"
  // hint can eventually go: a control that demonstrates itself needs no label.
  // It deliberately does NOT toggle the theme — app.js owns that, on a real
  // tap, and flipping a persisted preference to show off an animation would be
  // a hostile trade for a moment of delight.
  after(beat * 0.55, () => {
    if (!lampToggle) return;
    lampToggle.classList.remove("pulling");
    void lampToggle.offsetWidth; // same replay idiom app.js's own tap handler uses
    lampToggle.classList.add("pulling");
    lampToggle.classList.add("lamp-flare");
    after(beat * 1.5, () => lampToggle.classList.remove("lamp-flare", "pulling"));
  });

  // Ollie blinks awake under the light: he rises with his eyes still closed
  // (the "content" arcs), then they pop open, then settle.
  // He rises with his eyes still shut (the "content" arcs reset() left him
  // in), then they open and STAY open: big open eyes are the resting pose for
  // the landing screen, where this drawing is the app's first impression.
  // "awake" deliberately matches none of the data-mood expression rules, which
  // is exactly what leaves the default open eyes showing.
  after(beat * 1.45, () => setMood("awake"));
  after(beat * 2.0, () => say(seen ? "auth.ollieWelcomeBack" : "auth.ollieWelcome"));

  // Nothing after this point is still animating, so hand control back.
  after(beat * 2.6, finishIntro);
}

// ---------------------------------------------------------------------------
// Wiring that belongs to the stage itself rather than to any auth event
// ---------------------------------------------------------------------------
export function initStage() {
  if (!authScreen) return;

  // Any input at all fast-forwards. Capture phase + passive so this can never
  // delay or swallow the real interaction underneath it — the user's first tap
  // lands on whatever they aimed at, and the screen simply stops performing.
  const opts = { capture: true, passive: true };
  const onFirstInput = () => finishIntro();
  authScreen.addEventListener("pointerdown", onFirstInput, opts);
  authScreen.addEventListener("keydown", onFirstInput, opts);

  // Poke. .auth-ollie is pointer-events: none precisely so it can never eat a
  // tap meant for the card; the SVG alone opts back in, and it sits entirely
  // above the card's top edge where there is nothing behind it to steal from.
  if (ollieSvg) {
    ollieSvg.style.pointerEvents = "auto";
    ollieSvg.addEventListener("pointerdown", () => {
      react();
      say("auth.olliePoke");
    });
  }

  // Keyboard survival. The media query in style.css catches the phones that
  // shrink the layout viewport; this catches the ones that only shrink the
  // visual viewport, where that query never fires and a full-size owl would
  // push the submit button under the keyboard.
  authScreen.addEventListener("focusin", (e) => {
    if (e.target.matches("input, select, textarea")) authScreen.dataset.focused = "1";
  });
  authScreen.addEventListener("focusout", () => {
    // One frame of slack so tabbing between two fields does not flicker the
    // owl back to full size and down again between blur and focus.
    setTimeout(() => {
      if (!authScreen.contains(document.activeElement) || !document.activeElement?.matches("input, select, textarea")) {
        delete authScreen.dataset.focused;
      }
    }, 60);
  });
}
