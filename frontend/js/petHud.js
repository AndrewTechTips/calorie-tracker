// Ollie's Tamagotchi HUD — hearts (health) + hunger/hydration meters, floating
// over the 3D scene inside #ai-coach-sheet (index.html's .ollie-pet-hud), plus
// a small heart-count badge on the collapsed header mascot button
// (#ollie-mascot-badge) so Ollie's health is glanceable without opening the
// sheet at all.
//
// Kept in its own module, separate from ollie3d.js's PetController — this
// owns the HUD's own DOM and the hunger/hydration math, PetController stays
// scoped to the 3D model/animation state machine. The only thing this module
// reaches into PetController for is a brief react() call on a successful
// log, the same public method coachChat.js already calls — nothing here
// touches PetController's internals directly.
//
// Hearts come from GET /pet/state (app.js, once at boot) — a persistent,
// server-judged value, never computed here. Hunger/hydration are NOT
// fetched from the backend at all: they're today's already-loaded
// calories/water totals expressed as a percent of target, recomputed inline
// every time app.js's own render() runs (see CLAUDE.md's Ollie section for
// why this avoids a second, driftable source of truth).
import { PetController } from "./ollie3d.js?v=20260822i";
import { onLanguageChange, t } from "./i18n.js?v=20260822i";

const el = (id) => document.getElementById(id);
const MOOD_KEYS = { happy: "petMoodHappy", content: "petMoodContent", hungry: "petMoodHungry", sick: "petMoodSick" };

export const PetHud = {
  heartsEl: null,
  moodEl: null,
  hungerFillEl: null,
  hydrationFillEl: null,
  burstLayerEl: null,
  badgeEl: null,
  _hearts: 3,
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
  // more than once per session.
  setHearts({ hearts, mood } = {}) {
    if (typeof hearts !== "number") return;
    const previous = this._hearts;
    this._hearts = hearts;
    this._mood = mood || this._mood;
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

  // Called from app.js's own render(), every time it already recomputes
  // today's totals — caloriesPct/waterPct are plain 0-100 percentages of
  // target, already clamped by the caller.
  render({ caloriesPct, waterPct }) {
    if (this.hungerFillEl) this.hungerFillEl.style.width = `${caloriesPct}%`;
    if (this.hydrationFillEl) this.hydrationFillEl.style.width = `${waterPct}%`;
  },

  // One-shot celebratory feedback for a successful food/water log — a
  // floating "+" burst over the HUD plus a brief PetController.react() (a
  // safe no-op if the AI Coach sheet isn't currently open, since
  // PetController's own methods already guard on the model-viewer element
  // being present).
  pulseFeed() {
    this._burst(false);
    PetController.react();
  },
  pulseHydrate() {
    this._burst(true);
    PetController.react();
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
