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
function randomKey(keys) {
  return keys[Math.floor(Math.random() * keys.length)];
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
  _mood: "happy",
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
    this._mood = mood || this._mood;
    if (typeof max_hearts === "number") this._maxHearts = max_hearts;
    PetController.setMood(this._mood);
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
    this._renderMood();
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
  // target, already clamped by the caller.
  render({ caloriesPct, waterPct }) {
    if (this.hungerFillEl) this.hungerFillEl.style.width = `${caloriesPct}%`;
    if (this.hydrationFillEl) this.hydrationFillEl.style.width = `${waterPct}%`;
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

  _burst(isHydrate) {
    if (!this.burstLayerEl) return;
    const particle = document.createElement("span");
    particle.className = isHydrate ? "ollie-pet-burst-particle is-hydrate" : "ollie-pet-burst-particle";
    particle.textContent = isHydrate ? "+💧" : "+🍽";
    particle.addEventListener("animationend", () => particle.remove(), { once: true });
    this.burstLayerEl.appendChild(particle);
  },
};
