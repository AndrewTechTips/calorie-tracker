// Ollie's Tamagotchi HUD — hearts (health) + hunger/hydration meters, floating
// over the 3D scene inside #ai-coach-sheet (index.html's .ollie-pet-hud), plus
// a small heart-count badge on the collapsed header mascot button
// (#ollie-mascot-badge) so Ollie's health is glanceable without opening the
// sheet at all.
//
// Kept in its own module, separate from ollie3d.js's PetController — this
// owns the HUD's own DOM and the hunger/hydration math, PetController stays
// scoped to the 3D model/animation state machine. This module only ever
// reaches into PetController through its public methods (celebrate() on a
// successful log, setMood() when hearts change) — same coachChat.js already
// calls elsewhere — never its internals directly.
//
// Hearts come from GET /pet/state (app.js, once at boot) — a persistent,
// server-judged value, never computed here. Hunger/hydration are NOT
// fetched from the backend at all: they're today's already-loaded
// calories/water totals expressed as a percent of target, recomputed inline
// every time app.js's own render() runs (see CLAUDE.md's Ollie section for
// why this avoids a second, driftable source of truth).
import { PetController } from "./ollie3d.js?v=20260822j";
import { onLanguageChange, t } from "./i18n.js?v=20260822j";

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
function randomKey(keys) {
  return keys[Math.floor(Math.random() * keys.length)];
}

export const PetHud = {
  heartsEl: null,
  moodEl: null,
  hungerFillEl: null,
  hydrationFillEl: null,
  burstLayerEl: null,
  badgeEl: null,
  _hearts: 4,
  _maxHearts: 4,
  _mood: "happy",

  init() {
    this.heartsEl = el("ollie-pet-hearts");
    this.moodEl = el("ollie-pet-mood");
    this.hungerFillEl = el("ollie-pet-hunger-fill");
    this.hydrationFillEl = el("ollie-pet-hydration-fill");
    this.burstLayerEl = el("ollie-pet-burst-layer");
    this.badgeEl = el("ollie-mascot-badge");
    onLanguageChange(() => this._renderMood());
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
    if (this.badgeEl) this.badgeEl.textContent = String(hearts);
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
    const key = randomKey(FEED_LINE_KEYS);
    PetController.celebrate(foodName ? t(`aiCoach.${key}`, { food: foodName }) : t("aiCoach.petFedGeneric"));
  },
  // `amountMl` is the same water amount app.js's addWaterOptimistic already
  // has in hand.
  pulseHydrate(amountMl) {
    this._burst(true);
    const key = randomKey(HYDRATE_LINE_KEYS);
    PetController.celebrate(t(`aiCoach.${key}`, { amount: Math.round(amountMl || 0).toLocaleString() }));
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
