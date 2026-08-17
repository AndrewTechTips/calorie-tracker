// Guided mascot walkthrough ("Ollie the coach owl") — a first-run tour of
// the whole app: the calorie ring, all three ways to log food (scan/saved/
// manual), the scan modes themselves, water, saved meals, progress/streak/
// milestones, and the main settings. Auto-plays once for anyone who's never
// seen it (see TUTORIAL_SEEN_KEY), replayable anytime from Settings
// (#tutorial-replay-btn). Each step declares the real view/sheet it needs
// (see STEPS below) and the engine drives the app's OWN real buttons to get
// there — switchView()/openSheet() are never called directly, so every
// transition is exactly what a real tap would do (animations, data-population
// side effects, etc. included) instead of a second, parallel code path that
// could drift out of sync with the real one over time.
import { closeSheet } from "./ui.js?v=20260817i";
import { onLanguageChange, t } from "./i18n.js?v=20260817i";

const el = (id) => document.getElementById(id);

const TUTORIAL_SEEN_KEY = "ironlog_tutorial_seen";
// Written on every step change while the tour is running, cleared the moment
// it ends normally (Skip or the final Done) — see endTutorial()/goNext()/
// goBack(). Its mere presence on the next page load means the tour was
// abandoned mid-way (tab/browser closed, not deliberately dismissed), so
// maybeAutoStartTutorial() resumes from there instead of restarting at 0.
const TUTORIAL_RESUME_KEY = "ironlog_tutorial_resume_step";
// Confetti colors pulled from the app's own existing macro palette (see
// style.css's --c-* tokens) rather than inventing a separate confetti-only
// palette — it reads as "this app's colors celebrating," not a generic effect.
const CONFETTI_COLORS = ["var(--c-calories)", "var(--c-protein)", "var(--c-carbs)", "var(--c-fats)", "var(--c-water)"];

// Fed by app.js on every render() — same "a few stashed primitives, not a
// reference to app.js's own state object" pattern as reminders.js's own
// setContext, so this stays independent of app.js's internals. Lets the tour
// adapt in two small, deliberately narrow ways rather than assuming every
// run is a brand-new account's very first look at the app: the
// TUTORIAL_SEEN_KEY flag above is per-browser, not per-account, so a
// long-time user on a new device/browser (or after clearing site data) still
// auto-triggers the "first run" tour despite having real history — and the
// interactive water step (see STEPS below) would otherwise silently log a
// second real 250ml on top of whatever they'd already logged today.
let context = { hasExistingData: false, waterLoggedToday: false };
export function setTutorialContext(next) {
  context = { ...context, ...next };
}

// Each step highlights a real element (target) or is a plain center-style
// slide (target: null — intro/outro). `target` is an element id, or a
// function returning an element, for targets not reachable by a static id
// (a class-based list, or one of several same-class nav buttons). `view`
// defaults to "dashboard" when omitted; `sheet` (add-sheet/scan-sheet/
// settings-sheet) takes priority over `view` when both would otherwise
// apply, since a sheet is drawn on top of whichever view is behind it.
const STEPS = [
  // returningBodyKey: swapped in (renderStep, below) instead of bodyKey when
  // context.hasExistingData is true — someone with real saved meals/logs
  // already isn't brand new, even if this browser has never shown them the
  // tour before (see the comment on `context` above).
  { target: null, titleKey: "tutorial.introTitle", bodyKey: "tutorial.introBody", returningBodyKey: "tutorial.introBodyReturning" },
  { target: "ring-wrap", titleKey: "tutorial.ringTitle", bodyKey: "tutorial.ringBody" },
  { target: "fab-add", titleKey: "tutorial.foodTitle", bodyKey: "tutorial.foodBody" },
  {
    sheet: "add-sheet",
    // Scoped to #add-sheet specifically, not a bare ".add-options" —
    // #save-favorite-choice-sheet reuses the exact same class for its own
    // Meal/Product choice buttons. Both sheets' openSheet() call moves them
    // to the very end of <body> when opened (see ui.js — that's how it
    // keeps whichever sheet is currently open painting on top), which
    // reorders them relative to each other in the DOM. A bare class query
    // returns whichever matching element now comes first in that order —
    // not necessarily *this* one — so an unscoped selector here could
    // silently target the OTHER (hidden, zero-sized) sheet's version once
    // #add-sheet had been opened and reordered at least once.
    target: () => document.querySelector("#add-sheet .add-options"),
    radius: 20,
    titleKey: "tutorial.optionsTitle",
    bodyKey: "tutorial.optionsBody",
  },
  {
    sheet: "scan-sheet",
    target: "scan-mode-tabs",
    titleKey: "tutorial.scanModesTitle",
    bodyKey: "tutorial.scanModesBody",
  },
  {
    sheet: "scan-sheet",
    target: "scan-attach-btn",
    titleKey: "tutorial.attachBarcodeTitle",
    bodyKey: "tutorial.attachBarcodeBody",
  },
  {
    target: "water-add-btn",
    titleKey: "tutorial.waterTitle",
    bodyKey: "tutorial.waterBody",
    // A real, working tap — see celebrateAndAdvance/positionHitTarget below.
    // `interactive` names the same element this step already highlights;
    // the click is forwarded to it for real (so water actually gets
    // logged) before the tour reacts and auto-advances. Downgraded to a
    // plain, non-tappable highlight (see isStepGenuinelyInteractive) when
    // context.waterLoggedToday is true — someone replaying the tour after
    // already logging water today shouldn't have a second, unwanted 250ml
    // silently added on top of it just for looking at this step.
    interactive: "water-add-btn",
    reactionTitleKey: "tutorial.waterDoneTitle",
    reactionBodyKey: "tutorial.waterDoneBody",
    alreadyDoneBodyKey: "tutorial.waterBodyAlreadyLogged",
  },
  {
    view: "saved",
    target: "saved-meals-list",
    radius: 18,
    titleKey: "tutorial.savedTitle",
    bodyKey: "tutorial.savedBody",
  },
  {
    view: "discover",
    target: "discover-type-tabs",
    titleKey: "tutorial.discoverTitle",
    bodyKey: "tutorial.discoverBody",
  },
  { view: "progress", target: "streak-card", titleKey: "tutorial.streakTitle", bodyKey: "tutorial.streakBody" },
  {
    // Highlights the teaser card, not the fullscreen diary itself (see
    // index.html's own comment on #workout-diary-card: "deliberately not
    // itself the diary"). Kept as a plain highlight rather than an
    // `interactive` real-tap step (contrast the water-add-btn step above):
    // opening #workout-diary-view would mean driving a second, non-sheet
    // overlay type (.fullscreen-view, not .sheet-overlay — closeAllOpenSheets/
    // ensureContext's `sheet` handling doesn't know about it) through the
    // tour, for a payoff (seeing the calendar/session UI) that isn't worth
    // the added surface for a stuck tour to happen on.
    view: "progress",
    target: "workout-diary-card",
    titleKey: "tutorial.workoutTitle",
    bodyKey: "tutorial.workoutBody",
  },
  { view: "progress", target: "milestones-list", radius: 18, titleKey: "tutorial.milestonesTitle", bodyKey: "tutorial.milestonesBody" },
  {
    // No `view` — defaults to "dashboard" (see ensureContext above), which is
    // also where the header (and so #ai-coach-btn) lives; returning here from
    // the progress steps is the same implicit navigate-back every settings
    // step after this one already relies on.
    target: "ai-coach-btn",
    titleKey: "tutorial.aiCoachTitle",
    bodyKey: "tutorial.aiCoachBody",
  },
  {
    sheet: "settings-sheet",
    target: "open-calculator-btn",
    titleKey: "tutorial.targetsTitle",
    bodyKey: "tutorial.targetsBody",
  },
  {
    // Reaching the calculator sheet means opening Settings first — see
    // SHEET_OPENERS' own "calculator-sheet" entry below for the two-step
    // chain that handles it.
    sheet: "calculator-sheet",
    target: "goal-type-tabs",
    titleKey: "tutorial.goalTitle",
    bodyKey: "tutorial.goalBody",
  },
  {
    sheet: "settings-sheet",
    target: "theme-switcher-buttons",
    titleKey: "tutorial.themeLangTitle",
    bodyKey: "tutorial.themeLangBody",
  },
  {
    sheet: "settings-sheet",
    target: "export-btn",
    titleKey: "tutorial.exportTitle",
    bodyKey: "tutorial.exportBody",
  },
  { target: null, titleKey: "tutorial.outroTitle", bodyKey: "tutorial.outroBody", confetti: true },
];

// Opens each sheet via its OWN real trigger button rather than ui.js's
// openSheet() directly — that misses whatever setup a real tap does (the FAB's
// press flourish, the scan sheet's fresh-state reset, Settings populating its
// form fields from state.targets) and would show a blank/stale sheet.
const SHEET_OPENERS = {
  "add-sheet": () => el("fab-add").click(),
  "scan-sheet": () => el("opt-scan").click(), // closes add-sheet + opens scan-sheet itself, regardless of what's currently open
  "settings-sheet": () => el("settings-btn").click(),
  // The one sheet reachable only through another: the calculator's own
  // trigger (#open-calculator-btn) lives inside the settings sheet, so this
  // opens Settings first (unless it's already open) and waits for it via the
  // same polling helper used below, rather than a fixed delay — Settings'
  // own opener can genuinely take a couple of seconds the very first time
  // (see waitForSheetOpen's comment), and a fixed wait would click a button
  // that isn't on screen yet in that case.
  "calculator-sheet": () => {
    const settingsSheet = el("settings-sheet");
    const openCalculator = () => el("open-calculator-btn").click();
    if (settingsSheet && !settingsSheet.hidden) {
      openCalculator();
      return;
    }
    el("settings-btn").click();
    waitForSheetOpen("settings-sheet").then(openCalculator);
  },
};

// Polls for the sheet to actually become visible rather than a flat delay —
// the FAB's press flourish and every sheet's own slide-in are fixed, short
// animation timings, but Settings' opener is a real exception: if this is
// the very first time Settings has ever been opened this session,
// #settings-btn's own click handler awaits a live api.getTargets() call
// before it does anything else (see app.js), which can take anywhere from
// instant (already cached) to several seconds (a cold Render backend). A
// fixed short delay would measure a highlight target that isn't on screen
// yet in that case. Once the sheet itself is confirmed open, one more fixed
// wait covers its ~0.35-0.4s CSS slide-in (the sheet keeps animating its own
// transform briefly after `hidden` flips off, so content inside it is still
// moving for a moment).
function waitForSheetOpen(sheetId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const sheet = el(sheetId);
      if ((sheet && !sheet.hidden) || Date.now() >= deadline) {
        setTimeout(resolve, 380);
        return;
      }
      setTimeout(check, 80);
    };
    check();
  });
}

let currentStep = 0;
let active = false;
let transitioning = false;

function resolveTarget(step) {
  if (!step.target) return null;
  const found = typeof step.target === "function" ? step.target() : el(step.target);
  return found || null; // a target that doesn't exist right now degrades to a center slide, not a crash
}

// Sheets can legitimately stack (the calculator opens on top of Settings
// rather than closing it — see #open-calculator-btn's own comment in
// app.js), so "what's open right now" can be more than one sheet at once.
// Closing all of them, every time, is simpler and more robust than tracking
// "the" single current one and is still a no-op when only one (or zero) is
// actually open.
function closeAllOpenSheets() {
  document.querySelectorAll(".sheet-overlay:not([hidden])").forEach((overlay) => closeSheet(overlay.id));
}

// Two independent accordion systems now collapse content behind a tap:
// Settings' .settings-accordion cards (Preferences/Daily targets start
// expanded; App/Your data/Danger zone start collapsed — see index.html's own
// comment on #settings-sheet) and the Progress tab's .progress-card.accordion
// cards (Calories vs target, Macro consistency, Daily history, Milestones,
// etc. — see progress.js's initProgressAccordions; every card starts
// expanded but a returning user may have collapsed any of them, and that
// choice is remembered per-card via PROGRESS_ACCORDION_KEY). A step whose
// target lives inside a collapsed one (export-btn in Settings' "Your data",
// or milestones-list in Progress' "Milestones") would otherwise highlight a
// rectangle the user can't actually see: el()/resolveTarget() still finds
// the node (collapsing via grid-template-rows: 0fr + overflow:hidden on the
// panel clips PAINT, not the child's own layout box, so
// getBoundingClientRect() keeps returning the button's real size/position as
// if nothing were collapsed) — the ring would land right on top of the
// target's on-paper position while the actual pixels there are empty,
// clipped away by the still-collapsed ancestor. `inert` (also set on the
// collapsed panel in both systems) compounds it by making that same
// invisible spot genuinely un-clickable too. ACCORDION_GROUPS is generic
// over both systems (and any current or future accordion-nested target in
// either), rather than special-cased per step. Expands via the section's own
// real header button (same "drive it through the app's real controls" rule
// SHEET_OPENERS follows), and waits out the panel's own grid-template-rows
// transition (0.45s Settings / 0.4s Progress — 480ms covers either with
// margin) before resolving.
const ACCORDION_GROUPS = [
  { groupSelector: ".settings-accordion", headerSelector: ".settings-accordion-header" },
  { groupSelector: ".progress-card.accordion", headerSelector: ".progress-card-header" },
];

function ensureAccordionExpanded(step) {
  return new Promise((resolve) => {
    const targetEl = resolveTarget(step);
    for (const { groupSelector, headerSelector } of ACCORDION_GROUPS) {
      const group = targetEl?.closest(groupSelector);
      if (!group) continue;
      if (group.classList.contains("expanded")) {
        resolve();
        return;
      }
      group.querySelector(headerSelector)?.click();
      setTimeout(resolve, 480);
      return;
    }
    resolve(); // target isn't inside any known accordion system — nothing to expand
  });
}

// Gets the app into whatever view/sheet this step needs, via the app's own
// real buttons — see the SHEET_OPENERS comment above for why. Purely
// declarative (driven by what the *target* step requires, not a delta from
// the previous one), so this works identically whether the user just tapped
// Next or Back.
function ensureContext(step) {
  return new Promise((resolve) => {
    const finish = () => ensureAccordionExpanded(step).then(resolve);
    const wantSheet = step.sheet || null;

    if (wantSheet) {
      const target = el(wantSheet);
      // Not just "is the wanted sheet open" — with stacking, it can be open
      // yet buried under another one (e.g. arriving at a settings-sheet step
      // right after the calculator-sheet step, where both are still open).
      // Only skip the reopen when the wanted sheet is the ONLY thing open;
      // otherwise the leftover sheet(s) on top would keep covering it.
      const anyOtherSheetOpen = Array.from(document.querySelectorAll(".sheet-overlay:not([hidden])")).some(
        (overlay) => overlay.id !== wantSheet
      );
      if (target && !target.hidden && !anyOtherSheetOpen) {
        finish();
        return;
      }
      closeAllOpenSheets();
      SHEET_OPENERS[wantSheet]?.();
      waitForSheetOpen(wantSheet).then(finish);
      return;
    }

    const hadSheetOpen = document.querySelector(".sheet-overlay:not([hidden])") !== null;
    closeAllOpenSheets();
    const wantView = step.view || "dashboard";
    const activeBtn = document.querySelector(".nav-btn.active");
    if (activeBtn?.dataset.view !== wantView) {
      document.querySelector(`.nav-btn[data-view="${wantView}"]`)?.click();
    }
    // A view switch itself is synchronous — the only thing worth a beat here
    // is a sheet that was just closed above finishing its own close fade.
    setTimeout(finish, hadSheetOpen ? 250 : 0);
  });
}

function positionSpotlight(targetEl, radius) {
  const spotlight = el("tutorial-spotlight");
  if (!targetEl) {
    spotlight.classList.add("tutorial-spotlight-hidden");
    // .tutorial-spotlight-hidden's own top/left/width/height (see style.css)
    // never actually took effect without this: an inline style set directly
    // on an element always wins over a class's CSS rule, no matter the
    // class's specificity — so the leftover inline position/size from
    // whichever real target was highlighted last kept rendering right where
    // it was (e.g. still sitting over Export on the very next, targetless
    // outro slide) instead of the class collapsing it to the centered,
    // invisible point it was supposed to. Clearing these lets the CSS class
    // actually take over.
    spotlight.style.top = "";
    spotlight.style.left = "";
    spotlight.style.width = "";
    spotlight.style.height = "";
    spotlight.style.borderRadius = "";
    return;
  }
  spotlight.classList.remove("tutorial-spotlight-hidden");
  const pad = 8;
  const rect = targetEl.getBoundingClientRect();
  // Capped, not just measured — #saved-meals-list/#milestones-list are
  // plain unclamped lists (no max-height/scroll of their own), so a real
  // user with a lot of saved meals or a long-running account can make either
  // one meaningfully taller than the viewport. An uncapped ring would then
  // extend off-screen top/bottom instead of neatly framing a short list,
  // which reads as broken rather than just "a bigger list." 60% of the
  // viewport still comfortably frames the target without crowding out the
  // card below/above it.
  const height = Math.min(rect.height + pad * 2, window.innerHeight * 0.6);
  spotlight.style.top = `${rect.top - pad}px`;
  spotlight.style.left = `${rect.left - pad}px`;
  spotlight.style.width = `${rect.width + pad * 2}px`;
  spotlight.style.height = `${height}px`;
  // Reads the target's OWN real border-radius rather than trusting a
  // per-step guessed pixel value — STEPS used to hand-pick one for every
  // target, and several had quietly drifted out of sync with the actual CSS
  // (the water-add button, and every pill-shaped tab switcher — scan modes,
  // Discover type, Theme, Goal type — are all a true 999px stadium via
  // .btn-water/.pill-tabs/.pref-toggle-buttons, not the ~14-24px
  // rounded-rect several steps guessed; the streak card is --radius-lg
  // (26px), not 20px). That's exactly what read as "the highlight frame
  // doesn't match the real component." Deriving it straight from
  // getComputedStyle means it can never drift again, at any screen size —
  // `radius` is still honored as an explicit override for the few targets
  // (plain list/row containers) that have no border-radius of their own,
  // where a made-up soft corner is purely a visual nicety for the ring, not
  // something that needs to match anything real.
  spotlight.style.borderRadius = radius != null ? `${radius}px` : getComputedStyle(targetEl).borderRadius;
}

// The card is bottom-docked by default, but several real targets (the FAB,
// the Progress nav tab, anything low in a sheet) sit near the very bottom of
// the screen themselves — a fixed bottom card would cover the thing it's
// pointing at. Flip to a top dock whenever the current target's own rect
// would actually be covered, instead of hardcoding "these specific steps
// dock at the top" — this generalizes to any target, in any sheet, on any
// viewport, without a per-step override.
function pickCardDock(targetRect) {
  if (!targetRect) return "bottom";
  const card = el("tutorial-card");
  const cardHeight = card.offsetHeight || 220;
  const buffer = 24;
  return targetRect.bottom > window.innerHeight - cardHeight - buffer ? "top" : "bottom";
}

// Excited (bigger bounce, raised wings, twinkling sparkles) on the intro,
// outro, and a real-tap celebration; the plain attentive pose everywhere
// else — see the .mood-excited rules in style.css.
function setMascotMood(mood) {
  const mascot = el("tutorial-mascot");
  mascot.classList.toggle("mood-excited", mood === "excited");
  mascot.classList.toggle("mood-point", mood === "point");
  if (mood !== "point") mascot.classList.remove("point-left", "point-right");
}

// Rotates whichever wing sits on the target's side toward it — the angle is
// computed from two real, measured rects (the mascot's own and the target's),
// not a fixed per-step guess, so it stays correct across any card dock
// (top/bottom), any viewport size, and window resizes alike. Only the
// vertical steepness (up/down) is turned into a rotation; left/right just
// picks WHICH wing reaches, since the artwork only has the two fixed wing
// shapes to work with, not a free-rotating limb — a believable "point" here
// is a partial reach from the resting pose, not a literal aim-at-pixel.
function pointMascotAt(targetRect) {
  const mascot = el("tutorial-mascot");
  if (!targetRect) {
    mascot.classList.remove("point-left", "point-right");
    return;
  }
  const mascotRect = mascot.getBoundingClientRect();
  const dx = targetRect.left + targetRect.width / 2 - (mascotRect.left + mascotRect.width / 2);
  const dy = targetRect.top + targetRect.height / 2 - (mascotRect.top + mascotRect.height / 2);
  const vertical = Math.max(-55, Math.min(55, (Math.atan2(dy, Math.abs(dx)) * 180) / Math.PI));
  const pointingLeft = dx < 0;
  mascot.classList.toggle("point-left", pointingLeft);
  mascot.classList.toggle("point-right", !pointingLeft);
  // Each wing's existing "raised" pose (.mood-excited in style.css) already
  // fixed which rotation sign reads as "up" for that side — left wing
  // negative, right wing positive — so pointing down is the opposite sign
  // per wing rather than one raw angle shared by both.
  mascot.style.setProperty("--point-angle", `${pointingLeft ? vertical : -vertical}deg`);
}

// The decorative double-pulse ring, centered on the target — only ever
// shown alongside an actually-interactive step (see positionHitTarget below
// for the real clickable hotspot at the same spot).
function positionTapIndicator(targetEl, isInteractive) {
  const indicator = el("tutorial-tap-indicator");
  if (!targetEl || !isInteractive) {
    indicator.hidden = true;
    return;
  }
  indicator.hidden = false;
  const rect = targetEl.getBoundingClientRect();
  indicator.style.top = `${rect.top + rect.height / 2}px`;
  indicator.style.left = `${rect.left + rect.width / 2}px`;
}

// True for a step declared `interactive` UNLESS context (see setTutorialContext
// above) says the real action it would perform has effectively already
// happened — today, that's only the water step when water's already been
// logged today, but written generically in case a future interactive step
// needs the same treatment.
function isStepGenuinelyInteractive(step) {
  if (!step.interactive) return false;
  if (step.target === "water-add-btn" && context.waterLoggedToday) return false;
  return true;
}

// The real clickable hotspot for an interactive step, sized/positioned to
// exactly match the target's own rect — see the comment on
// #tutorial-hit-target in index.html for why this is a precise hole rather
// than making the whole background clickable during such a step.
function positionHitTarget(targetEl, interactive) {
  const hit = el("tutorial-hit-target");
  if (!targetEl || !interactive) {
    hit.hidden = true;
    return;
  }
  hit.hidden = false;
  const rect = targetEl.getBoundingClientRect();
  hit.style.top = `${rect.top}px`;
  hit.style.left = `${rect.left}px`;
  hit.style.width = `${rect.width}px`;
  hit.style.height = `${rect.height}px`;
}

// A small celebratory burst — the outro, and the water step's real-tap
// reaction. Plain DOM+CSS (a handful of <span> pieces, each animated once
// via a CSS keyframe and then discarded), not a canvas/library: cheap enough
// for any phone. Every piece's landing offset is computed here in JS as
// plain pixels (--dx/--dy custom properties), not via CSS trig functions —
// cos()/sin() in calc() isn't reliably supported on every mobile browser
// this app targets yet, so the actual math happens in JS where Math.cos/sin
// have always worked everywhere.
function triggerConfettiBurst() {
  const container = el("tutorial-confetti");
  container.innerHTML = "";
  const pieceCount = 18;
  for (let i = 0; i < pieceCount; i++) {
    const piece = document.createElement("span");
    piece.className = "tutorial-confetti-piece";
    const angle = (Math.random() * 360 * Math.PI) / 180;
    const distance = 50 + Math.random() * 70;
    piece.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
    piece.style.setProperty("--dy", `${Math.sin(angle) * distance}px`);
    piece.style.setProperty("--rotate", `${Math.round(Math.random() * 360)}deg`);
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.animationDelay = `${Math.random() * 0.12}s`;
    container.appendChild(piece);
  }
  setTimeout(() => {
    container.innerHTML = "";
  }, 1200);
}

function renderDots() {
  el("tutorial-dots").innerHTML = STEPS.map(
    (_, i) => `<span class="tutorial-dot${i === currentStep ? " active" : ""}"></span>`
  ).join("");
}

function updateNextButtonLabel() {
  const label =
    currentStep === 0 ? t("tutorial.startBtn") : currentStep === STEPS.length - 1 ? t("tutorial.doneBtn") : t("tutorial.nextBtn");
  el("tutorial-next-btn").textContent = label;
}

function updateBackButtonVisibility() {
  el("tutorial-back-btn").classList.toggle("tutorial-back-visible", currentStep > 0);
}

function positionForCurrentStep() {
  const step = STEPS[currentStep];
  const targetEl = resolveTarget(step);
  const interactive = isStepGenuinelyInteractive(step);
  const targetRect = targetEl ? targetEl.getBoundingClientRect() : null;
  positionSpotlight(targetEl, step.radius);
  positionTapIndicator(targetEl, interactive);
  positionHitTarget(targetEl, interactive);
  pointMascotAt(targetRect);
  const dock = pickCardDock(targetRect);
  el("tutorial-card").classList.toggle("tutorial-card-top", dock === "top");
}

async function renderStep() {
  const step = STEPS[currentStep];
  // Hide any leftover spotlight/tap-indicator/hit-target from the previous
  // step immediately — while ensureContext() is mid-transition (a sheet
  // sliding open/closed, a view switching), a stale ring (or worse, a stale
  // *clickable* hotspot) sitting over content that's about to change reads
  // as broken, not smooth. The dimmed backdrop itself stays up the whole
  // time (positionSpotlight(null) keeps the box-shadow scrim, just drops the
  // ring — see .tutorial-spotlight-hidden), so nothing flashes fully
  // undimmed either.
  positionSpotlight(null);
  el("tutorial-tap-indicator").hidden = true;
  el("tutorial-hit-target").hidden = true;

  await ensureContext(step);

  // Both are the same idea: swap in an alternate body copy when context says
  // the default copy doesn't quite fit — a "brand new here" greeting for
  // someone with real history already, or "give it a real tap" instructions
  // on a step that's just been downgraded to look-only (see
  // isStepGenuinelyInteractive above).
  const bodyKey =
    step.returningBodyKey && context.hasExistingData
      ? step.returningBodyKey
      : step.alreadyDoneBodyKey && !isStepGenuinelyInteractive(step)
        ? step.alreadyDoneBodyKey
        : step.bodyKey;
  el("tutorial-step-title").textContent = t(step.titleKey);
  el("tutorial-step-body").textContent = t(bodyKey);
  setMascotMood(step.target ? "point" : "excited");
  // Replays the bubble's own entrance animation (tutorial-bubble-in) on
  // every step, not just the first time the tour opens — a CSS animation
  // doesn't restart on its own just because the text inside changed. The
  // remove/reflow/reapply is the standard way to force that restart; reading
  // offsetWidth is what actually forces the reflow the removal needs to have
  // taken effect before the class goes back on.
  const bubble = el("tutorial-card").querySelector(".tutorial-bubble");
  bubble.style.animation = "none";
  void bubble.offsetWidth;
  bubble.style.animation = "";
  if (step.confetti) triggerConfettiBurst();
  updateNextButtonLabel();
  updateBackButtonVisibility();
  renderDots();

  const targetEl = resolveTarget(step);
  // Instant, not smooth: the ring itself already glides to its new spot via
  // its own CSS transition (see .tutorial-spotlight), so animating the
  // underlying page scroll too would just be two things moving at once —
  // and critically, an instant jump has no settling time to race against.
  // A *smooth* scroll inside a nested container (several Settings-sheet
  // targets sit well below that sheet's own fold) previously left the ring
  // measuring the target's pre-scroll position before the animation had
  // gone anywhere, since window-level scroll tracking doesn't see an inner
  // container scrolling — this sidesteps that class of bug entirely instead
  // of just timing around it.
  if (targetEl) targetEl.scrollIntoView({ behavior: "instant", block: "center" });
  requestAnimationFrame(() => requestAnimationFrame(positionForCurrentStep));
  // Belt-and-suspenders re-checks shortly after, independent of the scroll
  // listener below — cheap insurance (each call is idempotent, a no-op if
  // nothing moved) against any other reason layout could still be settling
  // (a font/webfont swap, an image loading in) rather than trusting one
  // single snapshot.
  [100, 300].forEach((delay) =>
    setTimeout(() => {
      if (active) positionForCurrentStep();
    }, delay)
  );
  watchForLateLayoutShift(step, targetEl);
}

// The Progress tab specifically can still grow taller ABOVE a below-the-fold
// target (workout-diary-card, milestones-list) well after the checks above,
// once its own async data (trends, workout sessions) resolves — the exact
// delay isn't predictable enough for a fixed setTimeout list to reliably
// cover (verified: it can land anywhere from under a second to several
// seconds depending on network timing), and that growth pushes the target
// further down with no scroll event of its own to fire the listener below —
// so positioning it without re-scrolling would leave the ring correctly
// tracking a target that's now off-screen. Most visible on a resumed tour
// (maybeAutoStartTutorial) landing directly on such a step without having
// passed through an earlier Progress step that would already have settled
// that data. A ResizeObserver reacts to the actual layout change whenever it
// happens, instead of guessing at a delay — observing the current `.view`
// itself, not `.app` (the scroll container): `.app` is pinned to 100vh with
// its own overflow-y: auto (see style.css), so ITS box never changes size as
// content inside it grows; `.view` has no height/overflow of its own, so it
// naturally resizes to fit its content. Auto-disconnects after 8s — the same
// bound waitForSheetOpen already uses above for a slow first Settings open
// (a cold Render backend) — so it doesn't keep fighting the user's own
// deliberate scrolling indefinitely once the step has had time to settle.
function watchForLateLayoutShift(step, initialTargetEl) {
  if (!initialTargetEl) return;
  const viewEl = el(`view-${step.view || "dashboard"}`);
  if (!viewEl) return;
  const observer = new ResizeObserver(() => {
    if (currentStep !== STEPS.indexOf(step) || !active) return;
    const lateTargetEl = resolveTarget(step);
    if (lateTargetEl) lateTargetEl.scrollIntoView({ behavior: "instant", block: "center" });
    positionForCurrentStep();
  });
  observer.observe(viewEl);
  setTimeout(() => observer.disconnect(), 8000);
}

// Always leaves the app on a clean, predictable dashboard view with nothing
// left open — regardless of which step (mid-Settings, mid-Saved-view, deep
// in the scan sheet) Skip/Escape/Done was pressed from.
function restoreCleanContext() {
  closeAllOpenSheets();
  const activeBtn = document.querySelector(".nav-btn.active");
  if (activeBtn?.dataset.view !== "dashboard") {
    document.querySelector('.nav-btn[data-view="dashboard"]')?.click();
  }
}

function endTutorial() {
  active = false;
  el("tutorial-overlay").hidden = true;
  localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
  localStorage.removeItem(TUTORIAL_RESUME_KEY); // finished (or deliberately skipped) — nothing left to resume
  // closeSheet() (called by restoreCleanContext -> closeAllOpenSheets) already
  // clears the body scroll lock on its own if a mid-tour step left a sheet
  // open — this overlay never takes its own lock (see initTutorial()'s own
  // comment on why: it needs the real page scrollable so scrollIntoView can
  // reach targets on the dashboard/saved/discover/progress views), so there's
  // nothing else to release here.
  restoreCleanContext();
}

// fromStep: where to (re)start — 0 for a fresh run (intro/replay), or a
// saved in-progress step when maybeAutoStartTutorial() is resuming one that
// got interrupted (tab/browser closed mid-tour, never reaching Skip/Done).
async function startTutorial(fromStep = 0) {
  active = true;
  currentStep = Math.min(Math.max(fromStep, 0), STEPS.length - 1);
  localStorage.setItem(TUTORIAL_RESUME_KEY, String(currentStep));
  el("tutorial-overlay").hidden = false;
  await renderStep();
}

async function goNext() {
  if (transitioning) return;
  if (currentStep >= STEPS.length - 1) {
    endTutorial();
    return;
  }
  transitioning = true;
  currentStep++;
  localStorage.setItem(TUTORIAL_RESUME_KEY, String(currentStep));
  await renderStep();
  transitioning = false;
}

async function goBack() {
  if (transitioning || currentStep === 0) return;
  transitioning = true;
  currentStep--;
  localStorage.setItem(TUTORIAL_RESUME_KEY, String(currentStep));
  await renderStep();
  transitioning = false;
}

// The reaction to a real tap on an interactive step's actual target (see
// STEPS' `interactive`/`reactionTitleKey`/`reactionBodyKey` fields, and
// #tutorial-hit-target's click handler in initTutorial() below). Swaps the
// bubble to a short congratulatory line, plays the excited mood + a confetti
// burst, then advances on a short delay — long enough for the moment to
// actually register, short enough not to stall the tour.
function celebrateAndAdvance(step) {
  if (transitioning) return;
  transitioning = true;
  el("tutorial-tap-indicator").hidden = true;
  el("tutorial-hit-target").hidden = true;
  setMascotMood("excited");
  triggerConfettiBurst();
  if (step.reactionTitleKey) el("tutorial-step-title").textContent = t(step.reactionTitleKey);
  if (step.reactionBodyKey) el("tutorial-step-body").textContent = t(step.reactionBodyKey);
  setTimeout(async () => {
    if (currentStep >= STEPS.length - 1) {
      endTutorial();
      transitioning = false;
      return;
    }
    currentStep++;
    localStorage.setItem(TUTORIAL_RESUME_KEY, String(currentStep));
    await renderStep();
    transitioning = false;
  }, 1200);
}

export function initTutorial() {
  el("tutorial-next-btn").addEventListener("click", goNext);
  el("tutorial-back-btn").addEventListener("click", goBack);
  el("tutorial-skip-btn").addEventListener("click", endTutorial);

  document.addEventListener("keydown", (e) => {
    if (active && e.key === "Escape") endTutorial();
  });

  // The background is intentionally still interactive-looking (nothing is
  // actually locked/blurred) — the overlay itself sits above it in the
  // stacking order and isn't pointer-events:none, so a tap anywhere outside
  // the card/spotlight just lands on the overlay and does nothing. Letting
  // the page scroll freely underneath (rather than locking it) means the
  // spotlight just needs to track the target's live position instead of
  // fighting a scroll lock — resize and scroll both funnel through the same
  // recompute already used for the initial placement and a step change.
  window.addEventListener("resize", () => {
    if (active) positionForCurrentStep();
  });
  // Capture phase, on document — NOT window (a plain window-level listener
  // only ever fires for the page's own scroll, never for a nested
  // overflow:auto container like .sheet scrolling internally, since scroll
  // events don't bubble). Several targets (the Settings-sheet steps
  // especially) live well below the fold of the sheet's own scroll box, so
  // scrollIntoView() there animates that inner scrollbar, not the window —
  // without capture:true here, the spotlight would just sit at the target's
  // pre-scroll position while the sheet scrolled right past it underneath.
  document.addEventListener(
    "scroll",
    () => {
      if (active) positionForCurrentStep();
    },
    { passive: true, capture: true }
  );

  onLanguageChange(() => {
    if (active) renderStep();
  });

  // The one real, functional interaction point (see #tutorial-hit-target's
  // comment in index.html) — forwards the tap to whatever it's currently
  // covering for real (so the underlying action, e.g. logging water, still
  // genuinely happens), then plays the tutorial's own reaction on top.
  el("tutorial-hit-target").addEventListener("click", () => {
    const step = STEPS[currentStep];
    if (!active || !isStepGenuinelyInteractive(step)) return;
    const targetEl = resolveTarget(step);
    targetEl?.click();
    celebrateAndAdvance(step);
  });

  el("tutorial-replay-btn").addEventListener("click", () => {
    closeSheet("settings-sheet");
    startTutorial(0);
  });
}

// Called once, right after a successful sign-in (including an already-
// remembered session resuming on page load — Supabase's onAuthStateChange
// fires onSignedIn either way, see app.js) — never at module-init time
// itself, since #app is still hidden behind the auth screen until then and
// getBoundingClientRect on any target would be meaningless.
export function maybeAutoStartTutorial() {
  if (active) return;
  // A resume step surviving in storage means a previous run got interrupted
  // (tab/browser closed) rather than deliberately finished or skipped —
  // endTutorial() clears this key in both of those normal-ending cases, so
  // its presence here specifically means "pick back up," even for someone
  // who has technically already seen (part of) the tour before.
  const resumeStep = localStorage.getItem(TUTORIAL_RESUME_KEY);
  if (resumeStep !== null) {
    setTimeout(() => startTutorial(Number(resumeStep) || 0), 900);
    return;
  }
  if (localStorage.getItem(TUTORIAL_SEEN_KEY)) return;
  // A beat after sign-in so this doesn't collide with the auth screen's own
  // exit transition — long enough to read as deliberate, not instant.
  setTimeout(() => {
    if (!localStorage.getItem(TUTORIAL_SEEN_KEY)) startTutorial(0);
  }, 900);
}
