// Ollie's Tamagotchi HUD — hearts (health) + hunger/hydration meters, floating
// over the 3D scene inside #ai-coach-sheet (index.html's .ollie-pet-hud).
// Hearts are deliberately shown ONLY inside the sheet, never as a persistent
// badge on the collapsed header mascot button — a red number sitting on an
// avatar universally reads as an unread-notification count to users
// regardless of what it's actually measuring, which is exactly the confusion
// that shape caused. The collapsed avatar's only badge is the transient
// "new logged action" notify pip below (#ollie-mascot-notify-badge).
//
// Kept in its own module, separate from ollie3d.js's PetController — this
// owns the HUD's own DOM and the hunger/hydration math, PetController stays
// scoped to the 3D model/animation state machine. This module only ever
// reaches into PetController through its public methods (celebrate() on a
// successful log, setMood() when hearts change, setPokeResponder() below) —
// same coachChat.js already calls elsewhere — never its internals directly.
//
// "Recall" (init() below): this module also owns _lastAction, the most
// recent food/water log this session, and hands PetController a
// pokeResponder callback that recalls it — so tapping Ollie later reacts to
// and mentions what was actually just logged instead of a generic poke.
// PetController stays domain-agnostic (it just calls the callback and shows
// whatever string comes back); the "what should Ollie say" judgment lives
// entirely here, next to the feed/hydrate copy it's built from.
//
// Hearts come from GET /pet/state (app.js, once at boot) — a persistent,
// server-judged value, never computed here. Hunger/hydration are NOT
// fetched from the backend at all: they're today's already-loaded
// calories/water totals expressed as a percent of target, recomputed inline
// every time app.js's own render() runs (see CLAUDE.md's Ollie section for
// why this avoids a second, driftable source of truth).
import { PetController } from "./ollie3d.js";
import { onLanguageChange, t } from "./i18n.js";

const el = (id) => document.getElementById(id);
// "worried" fills the middle rung backend/services/pet_service.py's 5-tier
// mood map (0..MAX_HEARTS=4) added for the new 4th heart — see that file's
// _MOOD_BY_HEARTS comment.
const MOOD_KEYS = {
  happy: "petMoodHappy",
  content: "petMoodContent",
  hungry: "petMoodHungry",
  worried: "petMoodWorried",
  sick: "petMoodSick",
};

// ---------------------------------------------------------------------------
// Mood is TWO signals, not one — this is the fix for "Ollie says Happy while
// he's starving".
//
// `hearts` (server-judged, GET /pet/state) is a slow, multi-day health
// reading: pet_scheduler.py moves it by at most one per calendar day, so it
// cannot possibly know that you have eaten nothing since waking up. It was
// the ONLY input to the mood string, which is why a user with a full 4 hearts
// and an empty log read as "Happy" all day.
//
// The second signal is today's own hunger/hydration — the same two
// percentages the meters already draw, so there is still no third source of
// truth and nothing new to fetch. The two are combined by taking the WORSE of
// the two (highest rank below), never an average and never the better one:
// good hearts must not paper over a day with no food in it, and one bad day
// must not be allowed to look like failing health either — it just pulls the
// face down to match what is actually true right now.
const MOOD_RANK = { happy: 0, content: 1, hungry: 2, worried: 3, sick: 4 };
function worseMood(a, b) {
  if (!a) return b || "happy";
  if (!b) return a;
  return MOOD_RANK[a] >= MOOD_RANK[b] ? a : b;
}

// How much of today's target a person would plausibly have hit by a given
// local hour. Without this, EVERY morning would open on "Not doing great" —
// 0% of target at 08:00 is completely normal, not a problem, and an app that
// scolds you before breakfast is one you stop opening. Judgment therefore
// starts at NEED_JUDGMENT_START_HOUR and ramps linearly to
// NEED_EXPECTED_BY_END at NEED_JUDGMENT_FULL_HOUR (roughly: "by 9pm you would
// expect to be near your target"). Before the start hour this returns 0 and
// the need signal is skipped entirely, leaving hearts alone to speak.
const NEED_JUDGMENT_START_HOUR = 10;
const NEED_JUDGMENT_FULL_HOUR = 21;
const NEED_EXPECTED_BY_END = 0.95;
function expectedFractionForHour(hoursDecimal) {
  if (hoursDecimal < NEED_JUDGMENT_START_HOUR) return 0;
  const span = NEED_JUDGMENT_FULL_HOUR - NEED_JUDGMENT_START_HOUR;
  const t = Math.min(1, (hoursDecimal - NEED_JUDGMENT_START_HOUR) / span);
  // Floored well above zero so the very first judged minutes can't divide by
  // something near-zero and read a single sip of water as "on track".
  return Math.max(0.08, t * NEED_EXPECTED_BY_END);
}

// The hunger/hydration half of the mood, as one of MOOD_RANK's own keys.
// Deliberately driven by the WORSE of the two meters (a perfectly hydrated
// person who has not eaten is still hungry), scored as a ratio against what
// the hour above says to expect rather than against the raw target — at 11am,
// 25% of your calories is fine; at 9pm it is not, and the same number has to
// be able to mean both.
// Returns null when it is too early in the day to judge at all.
const NEED_RATIO_TIERS = [
  [0.85, "happy"],
  [0.6, "content"],
  [0.35, "hungry"],
  [0.15, "worried"],
];

// Severity ceiling by hour — the ratio above is scale-free, so an empty log
// divides to 0 and hits the bottom tier the very minute judgment opens. That
// is technically consistent and emotionally wrong: "Not doing great" at
// 10:01am because you haven't had breakfast yet is the same scolding-before-
// noon problem NEED_JUDGMENT_START_HOUR exists to avoid, just moved an hour
// later. Capping how bad he is ALLOWED to look until the day has actually
// had a chance to go wrong keeps the signal honest in both directions: by
// late afternoon nothing is capped and an empty day reads as exactly what it
// is. Entries are [hour the cap applies BELOW, worst mood reachable].
const NEED_SEVERITY_CAPS = [
  [13, "hungry"],
  [17, "worried"],
];
function capNeedMood(mood, hoursDecimal) {
  const cap = NEED_SEVERITY_CAPS.find(([hour]) => hoursDecimal < hour);
  if (!cap) return mood;
  return MOOD_RANK[mood] > MOOD_RANK[cap[1]] ? cap[1] : mood;
}
// `caloriesPct`/`waterPct` are 0-100, or null for "there is no target set, so
// this meter measures nothing" — a user with no water target must not read as
// permanently dehydrated because a missing goal divides to a flat 0%. A null
// is dropped from the comparison entirely rather than defaulted either way;
// if BOTH are null there is nothing to judge and hearts speak alone.
function needMoodFor(caloriesPct, waterPct, now = new Date()) {
  const measurable = [caloriesPct, waterPct].filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!measurable.length) return null;
  const hoursDecimal = now.getHours() + now.getMinutes() / 60;
  const expected = expectedFractionForHour(hoursDecimal);
  if (expected <= 0) return null;
  const ratio = Math.min(...measurable) / 100 / expected;
  const tier = NEED_RATIO_TIERS.find(([floor]) => ratio >= floor);
  return capNeedMood(tier ? tier[1] : "sick", hoursDecimal);
}
// Randomized reaction lines for the "Ollie noticed what you just logged"
// celebration (see pulseFeed/pulseHydrate below) — picking from a few
// variants each time keeps back-to-back logs from reading as a canned,
// robotic single response.
const FEED_LINE_KEYS = ["petFeedLine1", "petFeedLine2", "petFeedLine3", "petFeedLine4"];
const HYDRATE_LINE_KEYS = ["petHydrateLine1", "petHydrateLine2", "petHydrateLine3", "petHydrateLine4"];
// Dish-specific reaction for a Discover recipe log (pulseRecipe below) —
// deliberately a distinct set from FEED_LINE_KEYS: "you cooked this" earns
// a warmer, chef-flavoured beat than a plain "you logged a food".
const COOK_LINE_KEYS = ["petCookLine1", "petCookLine2", "petCookLine3", "petCookLine4"];
// Tap-to-interact's fallback when nothing's been logged yet this session
// (see _recallLine below) — randomized the same way the feed/hydrate lines
// are, so repeated pokes don't all land on the same line.
const POKE_GREETING_KEYS = ["petPokeGreeting1", "petPokeGreeting2", "petPokeGreeting3"];
// Escalating tap copy. Spamming Ollie used to replay the identical line the
// instant the animation cooldown allowed it, which reads as a broken loop
// rather than a character. Past POKE_SPAM_THRESHOLD taps inside
// POKE_SPAM_WINDOW_MS he acknowledges the spamming itself, and past
// POKE_SILENCE_AFTER he stops answering entirely (the bubble is left alone;
// PetController still bounces him on every tap, so the tap always registers).
const POKE_SPAM_KEYS = ["petPokeSpam1", "petPokeSpam2", "petPokeSpam3"];
const POKE_SPAM_WINDOW_MS = 6000;
const POKE_SPAM_THRESHOLD = 3;
const POKE_SILENCE_AFTER = 7;

// Never the same line twice in a row. A 1-in-3 or 1-in-4 uniform pick repeats
// far more often than people expect it to, and an immediate repeat is exactly
// what makes a character read as canned — so the previous pick is remembered
// per key-set and excluded while there is anything else to say.
const lastPicked = new Map();
function randomKey(keys) {
  if (keys.length < 2) return keys[0];
  const previous = lastPicked.get(keys);
  const pool = keys.filter((k) => k !== previous);
  const key = pool[Math.floor(Math.random() * pool.length)];
  lastPicked.set(keys, key);
  return key;
}

export const PetHud = {
  heartsEl: null,
  moodEl: null,
  hungerFillEl: null,
  hydrationFillEl: null,
  burstLayerEl: null,
  notifyBadgeEl: null,
  // Whether a food/water log has landed that the user hasn't yet seen
  // acknowledged (opened the sheet since). Drives notifyBadgeEl's "1" — a
  // plain boolean, not a counter, since rapid successive logs never stack a
  // count (see _lastAction's own comment: only the LATEST action is ever
  // tracked at all).
  _hasUnseenAction: false,
  _hearts: 4,
  _maxHearts: 4,
  // The server's hearts-only verdict, and the live hunger/hydration verdict,
  // kept apart so either can change without the other being re-derived from
  // stale inputs — _mood below is always the worse of the two (see
  // worseMood/needMoodFor above, and _syncMood).
  _heartsMood: "happy",
  _needMood: null,
  _mood: "happy",
  // Last percentages render() was given, so _syncMood can re-derive the need
  // half on a hearts change or a language switch without app.js having to
  // re-run a full render just to keep Ollie's face honest.
  _caloriesPct: null,
  _waterPct: null,
  // False until render() has been handed real totals at least once. Without
  // it, the very first setHearts() (loadAll resolves GET /pet/state before
  // the first render) would judge 0% of everything as "starving" and flash
  // the sick face for a frame on every cold boot — 0 here means "not loaded
  // yet", not "you have eaten nothing".
  _hasTotals: false,
  // Spam-tap bookkeeping for _recallLine (see POKE_SPAM_* above).
  _pokeCount: 0,
  _lastPokeAt: 0,
  // The most recent food/water log this session — { kind: "feed"|"hydrate",
  // food, amountMl } or null before anything's been logged yet. Powers the
  // "Recall" feature: tapping Ollie later reacts to and mentions THIS,
  // instead of a generic poke, for as long as it's the freshest thing he
  // knows about (deliberately session-only, not persisted — same "no second
  // driftable source of truth" reasoning the hunger/hydration meters
  // already use, just for "what happened most recently" instead of
  // "today's totals").
  _lastAction: null,

  init() {
    this.heartsEl = el("ollie-pet-hearts");
    this.moodEl = el("ollie-pet-mood");
    this.hungerFillEl = el("ollie-pet-hunger-fill");
    this.hydrationFillEl = el("ollie-pet-hydration-fill");
    this.burstLayerEl = el("ollie-pet-burst-layer");
    this.notifyBadgeEl = el("ollie-mascot-notify-badge");
    onLanguageChange(() => this._renderMood());
    this._renderMood();
    PetController.setPokeResponder(() => this._recallLine());
  },

  // Called once at app boot when GET /pet/state resolves (app.js) — hearts
  // only change once a day server-side, so there's no reason to call this
  // more than once per session. max_hearts comes straight from the backend
  // (services/pet_service.MAX_HEARTS) rather than being a second
  // frontend-hardcoded 4 — see the help modal's use of getMaxHearts() below
  // for why that one shared source matters.
  setHearts({ hearts, mood, max_hearts } = {}) {
    if (typeof hearts !== "number") return;
    const previous = this._hearts;
    this._hearts = hearts;
    this._heartsMood = mood || this._heartsMood;
    if (typeof max_hearts === "number") this._maxHearts = max_hearts;
    this._syncMood();
    if (this.heartsEl) {
      [...this.heartsEl.children].forEach((node, i) => {
        node.classList.toggle("is-full", i < hearts);
        node.classList.remove("heart-lost");
      });
      // A real drop (not the very first paint, which would otherwise replay
      // this on every fresh page load) gets a brief flourish on the hearts
      // actually lost, not a blanket replay of every heart node.
      if (hearts < previous) {
        [...this.heartsEl.children].forEach((node, i) => {
          if (i >= hearts && i < previous) {
            void node.offsetWidth;
            node.classList.add("heart-lost");
          }
        });
      }
    }
  },

  // The one place _mood is written. Recombines the two halves (server hearts
  // + today's real hunger/hydration), and only pushes downstream when the
  // result actually changed — setMood writes a data attribute that CSS keys
  // filters and animation-duration off, and rewriting it every render would
  // restart those animations on every single keystroke-level state change.
  // Returns true when the mood moved, so callers can forward it on.
  _syncMood() {
    this._needMood = this._hasTotals ? needMoodFor(this._caloriesPct, this._waterPct) : null;
    const next = worseMood(this._heartsMood, this._needMood);
    if (next === this._mood) return false;
    this._mood = next;
    PetController.setMood(next);
    this._renderMood();
    return true;
  },

  // The current effective mood — read by app.js so the Progress tab's 2D
  // Ollie shows the SAME face as the 3D one instead of the hearts-only
  // string straight off GET /pet/state (which is what let one Ollie look
  // happy while the other looked hungry).
  getMood() {
    return this._mood;
  },

  _renderMood() {
    if (!this.moodEl) return;
    const key = MOOD_KEYS[this._mood] || MOOD_KEYS.happy;
    this.moodEl.textContent = t(`aiCoach.${key}`);
  },

  // Read by coachChat.js's help modal so its "he has {{max}} hearts" copy
  // never hardcodes a second 4 — one shared number, sourced from the
  // backend at boot (see setHearts above).
  getMaxHearts() {
    return this._maxHearts;
  },

  // Called from app.js's own render(), every time it already recomputes
  // today's totals — caloriesPct/waterPct are plain 0-100 percentages of
  // target, already clamped by the caller, or null when that target isn't
  // set at all (see needMoodFor for why null and 0 must not be conflated).
  render({ caloriesPct, waterPct }) {
    this._caloriesPct = Number.isFinite(caloriesPct) ? caloriesPct : null;
    this._waterPct = Number.isFinite(waterPct) ? waterPct : null;
    this._hasTotals = true;
    // A meter with no target behind it draws empty (there is nothing honest
    // to fill it to) but is excluded from the mood — see needMoodFor.
    if (this.hungerFillEl) this.hungerFillEl.style.width = `${this._caloriesPct ?? 0}%`;
    if (this.hydrationFillEl) this.hydrationFillEl.style.width = `${this._waterPct ?? 0}%`;
    // Deliberately here and not only in setHearts: these two percentages are
    // the half of the mood that moves during the day, so every add, delete,
    // undo and rollback that reaches render() re-judges the face too.
    return this._syncMood();
  },

  // One-shot celebratory feedback for a successful food/water log — a
  // floating "+" burst over the HUD plus PetController.celebrate(), which
  // plays a one-shot (never looping) reaction clip AND puts a contextual
  // line about what was just logged in Ollie's speech bubble, self-fading a
  // few seconds later. Safe to call whether or not the AI Coach sheet is
  // currently open: PetController's own methods already guard on the
  // model-viewer element being present, so this just quietly primes the
  // bubble/animation state for whenever the sheet is next opened.
  // `log` is the same optimistic log object app.js's insertOptimisticLog
  // already has in hand (food_name is always present on it); a missing name
  // falls back to a generic line rather than rendering "undefined".
  pulseFeed(log) {
    this._burst(false);
    const foodName = log?.food_name;
    this._lastAction = { kind: "feed", food: foodName || null };
    this._markUnseenAction();
    const key = randomKey(FEED_LINE_KEYS);
    PetController.celebrate(foodName ? t(`aiCoach.${key}`, { food: foodName }) : t("aiCoach.petFedGeneric"));
  },
  // Discover "closing the loop" (Phase 2): a recipe logged from the detail
  // sheet or Cook Mode (discover.js::persistRecipeLog). Same one-shot
  // burst + PetController.celebrate() shape as pulseFeed, but a
  // cooking-specific line referencing the dish — and, crucially, it does
  // NOT touch hearts or any streak state: a Discover cook earns a reaction,
  // never a heart move (the adherence streak stays sacred; hearts are still
  // judged only by pet_scheduler.py against real daily adherence). Treated
  // as a "feed" action for recall purposes so a later Ollie poke can still
  // mention it. Safe no-op if the AI Coach sheet isn't open.
  pulseRecipe(recipeName) {
    this._burst(false);
    this._lastAction = { kind: "feed", food: recipeName || null };
    this._markUnseenAction();
    PetController.celebrate(
      recipeName ? t(`aiCoach.${randomKey(COOK_LINE_KEYS)}`, { dish: recipeName }) : t("aiCoach.petFedGeneric"),
    );
  },

  // `amountMl` is the same water amount app.js's addWaterOptimistic already
  // has in hand.
  pulseHydrate(amountMl) {
    this._burst(true);
    this._lastAction = { kind: "hydrate", amountMl: Math.round(amountMl || 0) };
    this._markUnseenAction();
    const key = randomKey(HYDRATE_LINE_KEYS);
    PetController.celebrate(t(`aiCoach.${key}`, { amount: Math.round(amountMl || 0).toLocaleString() }));
  },

  // The mirror image of pulseFeed/pulseHydrate/pulseRecipe: a food log
  // deleted, a water entry removed, or an optimistic insert rolled back after
  // a failed write. Ollie used to be entirely blind to all three — he
  // celebrated an added meal and then went on recalling it fondly after it
  // had been deleted, with the hunger meter still showing its calories,
  // because every removal path either skipped render() (the journal
  // fast-path) or simply had nothing wired to it.
  //
  // Three things have to come undone, and they are genuinely separate:
  //  - the meters/mood, which app.js re-syncs by calling render() (the
  //    caller's job, since only it knows the new totals);
  //  - _lastAction, so a later poke can't recall food that no longer exists —
  //    cleared only when the removal IS the remembered action, since deleting
  //    yesterday's breakfast shouldn't wipe the memory of the snack just
  //    logged;
  //  - the unseen-action pip, for the same reason: an unseen action that has
  //    since been undone is nothing to go look at.
  // `entry` is { kind: "feed"|"hydrate", food?, amountMl? }. `quiet` skips the
  // speech/burst entirely — used for a rollback, where the user is already
  // getting an error toast and a chirpy owl on top of it would be noise.
  pulseUndo(entry = {}, { quiet = false } = {}) {
    const { kind, food, amountMl } = entry;
    const wasRemembered =
      this._lastAction &&
      this._lastAction.kind === kind &&
      (kind === "hydrate"
        ? Math.round(this._lastAction.amountMl || 0) === Math.round(amountMl || 0)
        : (this._lastAction.food || null) === (food || null));
    if (wasRemembered) {
      this._lastAction = null;
      this.clearUnseenAction();
    }
    if (quiet) return;
    this._burst(kind === "hydrate", true);
    let text;
    if (kind === "hydrate") text = t("aiCoach.petUndoHydrateLine", { amount: Math.round(amountMl || 0).toLocaleString() });
    else if (food) text = t("aiCoach.petUndoFeedLine", { food });
    else text = t("aiCoach.petUndoGeneric");
    PetController.celebrate(text);
  },

  // Fires the "1" pip on the collapsed header mascot button — a plain
  // boolean flag, not a counter: logging 3 things in a row still shows "1",
  // never "3", since only the latest action is ever recalled (see
  // _lastAction/_recallLine below). Safe to call whether or not the sheet is
  // currently open.
  _markUnseenAction() {
    this._hasUnseenAction = true;
    if (this.notifyBadgeEl) this.notifyBadgeEl.textContent = "1";
  },

  // Called from coachChat.js the moment the sheet actually shows the recall
  // reaction (sheet opened — see PetController.greet()) AND, as a
  // belt-and-suspenders safety net, whenever the sheet is closed by any path
  // (button, swipe, backdrop tap) — covers "the user left the view without
  // ever tapping Ollie" too, so a badge from an earlier session never lingers
  // into the next time the sheet opens. Idempotent: clearing an already-clear
  // badge is a harmless no-op.
  clearUnseenAction() {
    this._hasUnseenAction = false;
    if (this.notifyBadgeEl) this.notifyBadgeEl.textContent = "";
  },

  // Tap-to-interact's contextual line (PetController.pokeResponder, wired in
  // init() above) — recalls _lastAction if there is one, otherwise a
  // generic friendly greeting. A missing food name (rare — see pulseFeed)
  // falls back to the same generic "thanks for feeding me" line the
  // celebration itself uses, rather than interpolating an empty {{food}}.
  _recallLine() {
    // Spam pacing lives here, not in ollie3d.js: PetController deliberately
    // knows nothing about what Ollie should say, and returning null is
    // already its documented "say nothing" (_showReactionBubble no-ops on
    // falsy text). It still bounces him on every tap, so a silent poke reads
    // as him ignoring you rather than as the app dropping the input.
    const now = Date.now();
    this._pokeCount = now - this._lastPokeAt > POKE_SPAM_WINDOW_MS ? 1 : this._pokeCount + 1;
    this._lastPokeAt = now;
    if (this._pokeCount > POKE_SILENCE_AFTER) return null;
    if (this._pokeCount > POKE_SPAM_THRESHOLD) return t(`aiCoach.${randomKey(POKE_SPAM_KEYS)}`);
    if (this._lastAction?.kind === "feed") {
      return this._lastAction.food
        ? t("aiCoach.petRecallFeedLine", { food: this._lastAction.food })
        : t("aiCoach.petFedGeneric");
    }
    if (this._lastAction?.kind === "hydrate") {
      return t("aiCoach.petRecallHydrateLine", { amount: this._lastAction.amountMl.toLocaleString() });
    }
    return t(`aiCoach.${randomKey(POKE_GREETING_KEYS)}`);
  },

  _burst(isHydrate, isUndo = false) {
    if (!this.burstLayerEl) return;
    const particle = document.createElement("span");
    particle.className = `ollie-pet-burst-particle${isHydrate ? " is-hydrate" : ""}${isUndo ? " is-undo" : ""}`;
    // A removal falls instead of rising (see .is-undo in style.css) and is
    // signed accordingly — the direction alone reads as "that came back off"
    // without any copy at all.
    particle.textContent = `${isUndo ? "−" : "+"}${isHydrate ? "💧" : "🍽"}`;
    particle.addEventListener("animationend", () => particle.remove(), { once: true });
    this.burstLayerEl.appendChild(particle);
  },
};
