import { api } from "./api.js";
import { logOut } from "./auth.js";
import {
  closeSheet,
  getActivePillType,
  isRingPaceEnabled,
  openSheet,
  resetPillTabs,
  setGreeting,
  setRingPaceEnabled,
  showToast,
  vibrate,
} from "./ui.js";
import { getLanguage, onLanguageChange, setLanguage, t } from "./i18n.js";
import { calculateTargets } from "./nutritionMath.js";
import { fileToAvatarDataUrl, isImageFile } from "./avatar.js";
import { renderAIUsage } from "./aiUsage.js";
// Circular on paper (app.js is the one that dynamically import()s this file
// in the first place), but safe in practice: nothing below reads any of
// these at module-evaluation time, only from inside functions that can't
// run until well after a user has clicked the gear icon — by which point
// app.js's own top-level code has long since finished running. `state` is a
// live binding (ES module semantics, not a snapshot) — see app.js's own
// `export let state` for why that matters across the one place it's ever
// wholesale-reassigned (sign-out).
import { computeSimpleStreak, currentTargetsPayload, getStoredTheme, moveToggleThumb, render, state, syncProfileUi } from "./app.js";

const el = (id) => document.getElementById(id);

// Every .settings-accordion section (Preferences/App/Your data/Daily
// targets/Danger zone) collapses back to its default state on every open,
// not just once at page load — see index.html's own comment on the
// accordion markup for why this needs to be real JS rather than relying on
// whatever classes happened to be baked into the initial HTML: the sheet's
// DOM node is only ever hidden/unhidden (never recreated), so without this,
// whatever a user last expanded/collapsed would still be sitting that way
// the next time they open Settings, which is exactly the "opens on some
// half-random section" feel this fixes. Called from openSettingsSheet()
// before openSheet() unhides it, so there's nothing visible to animate —
// the sheet is already fully collapsed by the time it's first painted.
function resetSettingsAccordionDefaults() {
  document.querySelectorAll("#settings-sheet .settings-accordion").forEach((group) => {
    group.classList.remove("expanded");
    const header = group.querySelector(".settings-accordion-header");
    const panel = document.getElementById(header?.getAttribute("aria-controls"));
    header?.setAttribute("aria-expanded", "false");
    if (panel) panel.inert = true;
  });
}

// Seeded from the saved profile (openSettingsSheet below) so a plain "Save
// targets" — without ever reopening the calculator — still round-trips
// whatever biometrics were already known, and updated again every time the
// calculator itself is submitted (see its own submit handler below). null
// fields (never-set biometrics) are sent through untouched: the backend's
// TargetsUpdate treats age/height_cm/biological_sex as independently
// optional, so a partial or entirely empty set here is fine.
let lastCalculatorBiometrics = null;

// Set false in openSettingsSheet() on every open; flipped true the first
// time the "AI Limits" section is expanded that open, so a re-collapse/
// re-expand of the same section doesn't re-fetch — see that flag's own
// comment further down for why this is deferred at all.
let aiUsageLoadedForThisOpen = false;

const THEME_LABEL_KEYS = {
  system: "settings.themeSystem",
  light: "settings.themeLight",
  dark: "settings.themeDark",
  amoled: "settings.themeAmoled",
};

// Bento-style collapsed-header stats — today's live calorie target on Daily
// Targets, the current Language · Theme pair on Preferences (see
// .accordion-header-stat/.accordion-header-trail in style.css). Exported:
// app.js's own theme-switcher-buttons handler calls this too (theme itself
// has to stay in app.js, not here — it must also work on the pre-login lamp
// toggle, see that section's own comment there), through the same nullable
// settingsModuleRef?. bridge the goal-type-tabs callback already uses.
export function updateAccordionHeaderStats() {
  const targetsStat = el("accordion-targets-stat");
  if (targetsStat) {
    // effective_daily_calories, not the raw saved daily_calories — this is
    // "what today's target actually is", which is the number a "Trim
    // tomorrow" override changes; the Daily Targets FORM below still edits
    // the persistent daily_calories goal untouched.
    const cal = state.targets ? (state.targets.effective_daily_calories ?? state.targets.daily_calories) : null;
    targetsStat.textContent = cal != null ? t("settings.targetsHeaderStat", { calories: Math.round(cal).toLocaleString() }) : "";
  }
  const prefStat = el("accordion-preferences-stat");
  if (prefStat) {
    const langShort = getLanguage() === "ro" ? "RO" : "EN";
    const themeLabel = t(THEME_LABEL_KEYS[getStoredTheme()] || THEME_LABEL_KEYS.system);
    prefStat.textContent = `${langShort} · ${themeLabel}`;
  }
}

// "Wrapped"-style profile card stats — see .profile-stats-row in style.css.
// daysHere/streak are pure client-side computations (created_at is already
// on state.targets; computeSimpleStreak() is the exact same function the
// dashboard/AI Coach status banner already use, not a second streak
// definition that could disagree with them); daysLogged is server-computed
// (TargetsResponse.days_logged) since daily_logs itself only retains 7 days
// — see that field's own comment in backend/models.py for why. Starts
// [hidden] in the markup and is only ever revealed here, once real numbers
// are actually in hand — same "never show a stale/wrong flash" discipline
// syncProfileUi's own member-since badge already follows.
function updateProfileStats() {
  const row = el("profile-stats-row");
  if (!row || !state.targets) return;
  const created = state.targets.created_at ? new Date(state.targets.created_at) : null;
  const daysHere =
    created && !Number.isNaN(created.getTime()) ? Math.max(1, Math.floor((Date.now() - created.getTime()) / 86400000) + 1) : null;
  el("profile-stat-days-here").textContent = daysHere != null ? daysHere.toLocaleString() : "—";
  el("profile-stat-streak").textContent = computeSimpleStreak().toLocaleString();
  el("profile-stat-days-logged").textContent = (state.targets.days_logged ?? 0).toLocaleString();
  row.hidden = false;
}

export async function openSettingsSheet() {
  // Never a silent no-op: if targets hasn't loaded yet (still loading, or the
  // initial load failed), retry the fetch right here instead of the button
  // just doing nothing — that dead-click is what read as "frozen".
  if (!state.targets) {
    showToast(t("toast.loadingData"), "default");
    try {
      state.targets = await api.getTargets();
    } catch (err) {
      showToast(err.message || t("toast.couldNotLoadTargets"), "error");
      return;
    }
  }
  el("account-display-name").value = state.targets.display_name || "";
  el("target-calories").value = state.targets.daily_calories;
  el("target-protein").value = state.targets.daily_protein;
  el("target-carbs").value = state.targets.daily_carbs;
  el("target-fats").value = state.targets.daily_fats;
  el("target-fiber").value = state.targets.daily_fiber;
  el("target-water").value = state.targets.daily_water_ml;
  el("target-auto-balance-toggle").checked = isAutoBalanceEnabled();
  el("ring-pace-toggle").checked = isRingPaceEnabled();
  // Seeds both the calculator's own inputs (so a returning user isn't
  // retyping height/age/sex/activity every time) and the payload the
  // settings-form submit below sends — see lastCalculatorBiometrics' own
  // comment. Only overwrites fields the profile actually has a saved value
  // for, leaving the calculator's plain HTML defaults in place otherwise.
  lastCalculatorBiometrics = {
    age: state.targets.age ?? null,
    height_cm: state.targets.height_cm ?? null,
    biological_sex: state.targets.biological_sex ?? null,
    activity_level: state.targets.activity_level || "moderate",
  };
  if (state.targets.height_cm) el("calc-height").value = state.targets.height_cm;
  if (state.targets.age) el("calc-age").value = state.targets.age;
  if (state.targets.biological_sex) el("calc-sex").value = state.targets.biological_sex;
  el("calc-activity").value = state.targets.activity_level || "moderate";
  el("settings-timezone-note").textContent = t("settings.timezoneNote", { tz: state.targets.timezone || "UTC" });
  syncProfileUi(state.targets);
  updateProfileStats();
  updateAccordionHeaderStats();
  updateLangButtons();
  resetPillTabs("export-lang-tabs", getLanguage());
  resetPillTabs("goal-type-tabs", state.targets.goal_type || "maintain");
  updateSettingsGoalSummary();
  resetSettingsAccordionDefaults();
  // NOT fetched here — GET /ai-usage + building its 6 rows is real work
  // (network round trip, DOM node creation with its own stagger animation,
  // see aiUsage.js) that only ever pays off if the user actually opens the
  // "AI Limits" accordion, which resetSettingsAccordionDefaults() above just
  // collapsed. Most Settings visits never touch that section, so eagerly
  // running it on every single open was pure wasted work landing in the
  // same critical window as the sheet's own entrance animation. Deferred to
  // the accordion header handler below instead — first expand per open,
  // via aiUsageLoadedForThisOpen.
  aiUsageLoadedForThisOpen = false;
  openSheet("settings-sheet");
  // Resets scroll position every open — otherwise this is the one piece of
  // "state" openSheet() itself never touches (it clears leftover inline
  // transform/transition/animation from a drag-to-dismiss, but never
  // scrollTop): the sheet's DOM node is only ever hidden/unhidden, never
  // recreated, so scrolling down into Daily targets, closing, and reopening
  // left you exactly where you scrolled to last time instead of back at the
  // top — not how a native settings screen behaves. Deliberately set AFTER
  // openSheet(), not before: scrollTop writes on a still-[hidden]
  // (display:none) element are silently discarded rather than retained —
  // verified directly — so setting it while still hidden looks correct in
  // the code but has no actual effect once the sheet becomes visible again.
  // Still no visible jump: this runs synchronously right after openSheet's
  // own unhide, in the same task, before the browser paints anything.
  const settingsSheetPanel = el("settings-sheet").querySelector(".sheet");
  if (settingsSheetPanel) settingsSheetPanel.scrollTop = 0;
  // The toggle thumbs above are positioned from real measured button
  // geometry (moveToggleThumb) — while the sheet still carries [hidden],
  // every button reports 0 for offsetWidth/offsetLeft, so re-measuring only
  // makes sense once openSheet has actually made it visible. #goal-type-tabs
  // itself now lives in the calculator sheet, not this one — its thumb is
  // re-measured when that sheet actually opens instead (open-calculator-btn's
  // own handler below), for the exact same reason.
  // Deferred one rAF, not called synchronously right here: each
  // moveToggleThumb() call forces a real layout (reading offsetWidth/
  // offsetLeft right after openSheet's own DOM writes) — two forced reflows
  // landing in the exact same tick the sheet's CSS slide-in/backdrop-blur
  // entrance animation is trying to kick off is real main-thread contention,
  // and it's the browser's very FIRST animation frame that pays for it —
  // which is exactly what a "stutter when opening Settings" is. Hopping one
  // frame lets that first frame paint uncontested; the thumbs snapping into
  // place a frame later is imperceptible, but a blocked first frame isn't.
  requestAnimationFrame(() => {
    moveToggleThumb(el("lang-switcher-buttons"));
    moveToggleThumb(el("theme-switcher-buttons"));
  });
}

// ---------------------------------------------------------------------------
// Profile photo — upload applies immediately (its own PUT /targets call),
// not gated behind the "Daily targets" form's Save button below: a photo
// change is its own action, same instant-apply convention as the
// Language/Theme toggles elsewhere in this sheet. currentTargetsPayload()
// itself lives in app.js, not here — see its own comment there for why
// (analytics.js's macro-lock feature needs it too, independent of Settings).
// ---------------------------------------------------------------------------
async function saveAvatar(avatarUrl, successMessageKey) {
  const errorEl = el("profile-avatar-error");
  errorEl.hidden = true;
  const wrap = el("profile-avatar-img").closest(".profile-avatar-wrap");
  wrap.classList.add("uploading");
  el("profile-avatar-spinner").hidden = false;
  try {
    const updated = await api.updateTargets({ ...currentTargetsPayload(), avatar_url: avatarUrl });
    state.targets = updated;
    syncProfileUi(state.targets);
    showToast(t(successMessageKey), "success");
  } catch (err) {
    errorEl.textContent = err.message || t("settings.avatarError");
    errorEl.hidden = false;
  } finally {
    wrap.classList.remove("uploading");
    el("profile-avatar-spinner").hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Target calculator (Settings → "Calculate my targets") — a Mifflin-St Jeor
// + activity-multiplier + goal-offset estimate (see nutritionMath.js for the
// actual formulas/citations). Always a starting point: "Use these targets"
// only fills in the settings form's own fields, still unsaved — the user
// still has to review and hit the form's real Save button, this never
// writes to the server on its own.
// ---------------------------------------------------------------------------
// #goal-type-tabs itself now lives inside this sheet (see index.html) — read
// live off it the same way regardless, since getActivePillType is a plain id
// lookup, independent of which sheet an element visually sits in. Settings
// shows a read-only reflection of the same choice (updateSettingsGoalSummary
// below) rather than a second editable copy, which is what let the numbers
// this calculator suggests and the goal the rest of the app thinks you're on
// silently disagree in a much older version of this screen.
const GOAL_LABEL_KEYS = { cut: "settings.goalCutShort", maintain: "settings.goalMaintainShort", bulk: "settings.goalBulkShort" };

// Exported: app.js's own eager wiring for #goal-type-tabs (shared with the
// dashboard's live goal-type change, registered at boot via wirePillTabs)
// calls this through a nullable module reference, the same
// load-then-call-through-a-ref pattern already used for progress.js/
// analytics.js elsewhere in this app — see app.js's settingsModuleRef.
export function updateSettingsGoalSummary() {
  const goal = getActivePillType("goal-type-tabs", "maintain");
  el("settings-goal-summary-value").textContent = t(GOAL_LABEL_KEYS[goal]);
}

function readCalculatorInputs() {
  return {
    weightKg: Number(el("calc-weight").value),
    heightCm: Number(el("calc-height").value),
    age: Number(el("calc-age").value),
    sex: el("calc-sex").value,
    activityLevel: el("calc-activity").value,
    goal: getActivePillType("goal-type-tabs", "maintain"),
  };
}

// Exported for the same reason updateSettingsGoalSummary is — app.js's eager
// #goal-type-tabs wiring calls this through settingsModuleRef too, since a
// goal change should refresh the calculator's live preview immediately even
// if the calculator sheet was opened before this exact change.
export function updateCalculatorPreview() {
  const { weightKg, heightCm, age } = readCalculatorInputs();
  const valid = weightKg > 0 && heightCm > 0 && age > 0;
  el("calc-apply-btn").disabled = !valid;
  el("calculator-preview").hidden = !valid;
  if (!valid) return;

  const targets = calculateTargets(readCalculatorInputs());
  el("calc-preview-calories").textContent = targets.calories.toLocaleString();
  el("calc-preview-protein").textContent = `${targets.protein} g`;
  el("calc-preview-carbs").textContent = `${targets.carbs} g`;
  el("calc-preview-fats").textContent = `${targets.fats} g`;
}

// ---------------------------------------------------------------------------
// Auto-balance calories (Settings target fields) — a lighter-weight sibling
// to the full calculator above: no weight/height/age needed, just keeps
// total calories consistent with whatever protein/carbs/fats are currently
// typed, using the standard 4/4/9 kcal-per-gram conversion. One-directional
// (macros drive calories, never the reverse) so there's no feedback loop to
// guard against, and editing calories directly still works exactly as a
// plain manual value when the toggle is off. Fiber/water are untouched here,
// same as the calculator above.
// ---------------------------------------------------------------------------
const AUTO_BALANCE_KEY = "ironlog_target_auto_balance";
const isAutoBalanceEnabled = () => localStorage.getItem(AUTO_BALANCE_KEY) !== "0"; // on by default

function recalculateCaloriesFromMacros() {
  const protein = Number(el("target-protein").value) || 0;
  const carbs = Number(el("target-carbs").value) || 0;
  const fats = Number(el("target-fats").value) || 0;
  el("target-calories").value = Math.round(protein * 4 + carbs * 4 + fats * 9);
}

const AUTO_BALANCE_FIELD_IDS = new Set(["target-protein", "target-carbs", "target-fats"]);

// ---------------------------------------------------------------------------
// Language switcher (settings sheet) — English/Romanian only, by design.
// ---------------------------------------------------------------------------
function updateLangButtons() {
  // Scoped to this one switcher's own buttons — the theme switcher (kept in
  // app.js, not this module, since it must also work on the pre-login lamp
  // toggle) reuses the same .pref-toggle-btn class for identical styling,
  // and its buttons carry no data-lang at all, so a bare ".pref-toggle-btn"
  // query here would otherwise also visit (and incorrectly de-activate) the
  // theme buttons.
  el("lang-switcher-buttons").querySelectorAll(".pref-toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === getLanguage());
  });
  moveToggleThumb(el("lang-switcher-buttons"));
}

// Type-to-confirm — the button stays disabled until the typed text matches
// the localized confirm word exactly (case-insensitive: this is a deliberate
// friction/attention check, not a precision test). Reset every time the
// sheet opens so a stale confirmation from a previous visit can never carry
// forward.
const DELETE_CONFIRM_WORD_KEY = "settings.deleteAccountConfirmWord";

function updateDeleteAccountButtonState() {
  const typed = el("delete-account-confirm-input").value.trim().toUpperCase();
  const expected = t(DELETE_CONFIRM_WORD_KEY).trim().toUpperCase();
  el("delete-account-confirm-btn").disabled = !typed || typed !== expected;
}

// Everything below wires up the listeners that only ever matter once
// Settings is actually reachable — called exactly once, the first time this
// module is loaded (app.js's loadSettingsModule dynamic-import()s this file
// the first time the gear icon is tapped, then calls this), same "init
// function wired by the loader, not at module top-level" convention every
// other feature module in this app already uses (initNotifications,
// initWorkoutDiary, initPhotoStore, ...).
export function initSettings() {
  // ---------------------------------------------------------------------------
  // Settings accordion — Preferences/App/Your data/Daily targets/Danger zone
  // each collapse behind their own header tap. Pure CSS drives the animation
  // (see .settings-accordion-panel's grid-template-rows 0fr/1fr transition in
  // style.css) — this listener only ever flips a class and two a11y-related
  // attributes; there is deliberately no JS height measurement, no inline
  // style, and nothing to keep in sync with the CSS transition's own timing.
  // A rapid re-tap just re-triggers the class toggle, and the browser's own
  // transition engine reverses whatever was mid-flight correctly on its own —
  // that's the actual robustness win of staying pure-CSS here, on top of it
  // being one less thing to get wrong on the performance side.
  // One delegated listener on the sheet itself rather than one per header: the
  // set of accordion sections is fixed in the markup, never rebuilt at
  // runtime, so there's nothing that would leave a freshly-added header
  // unwired the way there would be for dynamically-rendered content.
  // `panel.inert` (not just the CSS collapse) is what keeps a collapsed
  // section's controls out of the tab order and un-clickable while visually
  // clipped to zero height — without it, keyboard/assistive-tech focus could
  // still land on a theme button or a danger-zone action that isn't visibly
  // open, which both reads as broken and, for the danger-zone case
  // specifically, would be a real way to reach "Delete account" without ever
  // seeing the section that contextualizes it.
  // ---------------------------------------------------------------------------
  el("settings-sheet").addEventListener("click", (e) => {
    const header = e.target.closest(".settings-accordion-header");
    if (!header) return;
    const group = header.closest(".settings-accordion");
    const panel = document.getElementById(header.getAttribute("aria-controls"));
    const expanding = !group.classList.contains("expanded");
    group.classList.toggle("expanded", expanding);
    header.setAttribute("aria-expanded", String(expanding));
    if (panel) panel.inert = !expanding;
    vibrate(8);
    if (expanding && group.id === "accordion-ai-limits" && !aiUsageLoadedForThisOpen) {
      aiUsageLoadedForThisOpen = true;
      renderAIUsage();
    }
  });

  el("profile-avatar-edit-btn").addEventListener("click", () => el("profile-avatar-input").click());

  el("profile-avatar-input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // always reset, so re-picking the exact same file still fires 'change' next time
    if (!file) return;
    if (!isImageFile(file)) {
      const errorEl = el("profile-avatar-error");
      errorEl.textContent = t("settings.avatarInvalidType");
      errorEl.hidden = false;
      return;
    }
    const dataUrl = await fileToAvatarDataUrl(file);
    await saveAvatar(dataUrl, "settings.avatarUpdated");
  });

  // "" not null: the backend's PUT /targets drops None fields entirely
  // (model_dump(exclude_none=True)) so a real clear needs a falsy-but-present
  // value — same convention the display name field already relies on.
  el("profile-avatar-remove-btn").addEventListener("click", () => saveAvatar("", "settings.avatarRemoved"));

  el("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = el("settings-form").querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = t("settings.saving");
    try {
      const updated = await api.updateTargets({
        daily_calories: Number(el("target-calories").value),
        daily_protein: Number(el("target-protein").value),
        daily_carbs: Number(el("target-carbs").value),
        daily_fats: Number(el("target-fats").value),
        daily_fiber: Number(el("target-fiber").value),
        daily_water_ml: Number(el("target-water").value),
        goal_type: getActivePillType("goal-type-tabs", "maintain"),
        // Preserved as-is — this form has no macro-lock control of its own
        // (that lives on the Predictive Analytics card, analytics.js); without
        // resending it, an omitted field would reset to unlocked (see
        // currentTargetsPayload's own comment on why PUT /targets applies
        // defaults to anything left out, not just anything explicitly null).
        locked_macro: state.targets.locked_macro ?? null,
        // See lastCalculatorBiometrics' own comment — seeded from the saved
        // profile on open, refreshed by the calculator on submit, sent as
        // whatever it currently holds (possibly still null/unset fields).
        ...(lastCalculatorBiometrics || {}),
      });
      state.targets = updated;
      render();
      setGreeting(state.targets.display_name);
      closeSheet("settings-sheet");
      showToast(t("toast.targetsUpdated"), "success");
    } catch (err) {
      showToast(err.message || t("toast.couldNotUpdateTargets"), "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = t("settings.save");
    }
  });

  // ---------------------------------------------------------------------------
  // Account Settings — display name (moved out of the Daily targets form:
  // saving your name has nothing to do with saving calorie/macro numbers) now
  // instant-applies on blur, the same convention as the avatar/Language/Theme
  // controls above, instead of requiring a trip to the targets form's own Save
  // button. Only fires a request when the value actually changed, and reverts
  // the field to the last-known-good value on failure so the input never shows
  // something that didn't actually save.
  // ---------------------------------------------------------------------------
  el("account-display-name").addEventListener("blur", async () => {
    const input = el("account-display-name");
    const name = input.value.trim();
    if (!state.targets || name === (state.targets.display_name || "")) return;
    input.disabled = true;
    try {
      const updated = await api.updateTargets({ ...currentTargetsPayload(), display_name: name });
      state.targets = updated;
      syncProfileUi(state.targets);
      setGreeting(state.targets.display_name);
      showToast(t("settings.nameSaved"), "success");
    } catch (err) {
      input.value = state.targets.display_name || "";
      showToast(err.message || t("toast.couldNotUpdateTargets"), "error");
    } finally {
      input.disabled = false;
    }
  });
  // Enter shouldn't insert a newline in a single-line field or do nothing
  // silently — blurring is what actually triggers the save above, so this just
  // makes the keyboard's own "done"/"go" affordance act on it immediately
  // instead of requiring a separate tap elsewhere to dismiss focus first.
  el("account-display-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      el("account-display-name").blur();
    }
  });

  // Danger zone — Reset Progress / Delete Account. Both open their own
  // confirmation sheet rather than acting on the first tap (see
  // reset-progress-sheet/delete-account-sheet in index.html for why each one's
  // gate is shaped the way it is); the buttons here only ever open that sheet,
  // never call the API directly.
  // ---------------------------------------------------------------------------
  // Layers on top of settings-sheet rather than closing it first — same
  // stacked-sheet convention as open-calculator-btn above (openSheet moves the
  // newly-opened sheet to the end of <body> so it paints above whatever's
  // already open) — so cancelling lands right back in Settings instead of
  // needing a second tap to reopen it.
  el("reset-progress-btn").addEventListener("click", () => {
    openSheet("reset-progress-sheet");
  });

  el("reset-progress-confirm-btn").addEventListener("click", async () => {
    const btn = el("reset-progress-confirm-btn");
    btn.disabled = true;
    try {
      await api.resetProgress();
      closeSheet("reset-progress-sheet");
      showToast(t("settings.resetProgressSuccessToast"), "success");
      // A full reload, not a local state patch: Reset Progress also wipes
      // weight/measurement/workout history, which live in progress.js's own
      // lazily-fetched module state (never touched by this file's `state`
      // object) plus the IndexedDB dashboard snapshot — reloading is the one
      // way to guarantee every one of those caches gets re-fetched clean
      // instead of quietly drifting stale until their next natural refresh.
      // The short delay just lets the success toast actually be seen before
      // the reload wipes the DOM out from under it.
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      btn.disabled = false;
      showToast(err.message || t("settings.resetProgressError"), "error");
    }
  });

  el("delete-account-confirm-input").addEventListener("input", updateDeleteAccountButtonState);

  el("delete-account-btn").addEventListener("click", () => {
    el("delete-account-confirm-input").value = "";
    updateDeleteAccountButtonState();
    openSheet("delete-account-sheet");
  });

  el("delete-account-confirm-btn").addEventListener("click", async () => {
    const btn = el("delete-account-confirm-btn");
    btn.disabled = true;
    try {
      await api.deleteAccount();
      closeSheet("delete-account-sheet");
      showToast(t("settings.deleteAccountSuccessToast"), "success");
      // The account (and its Supabase auth.users row) no longer exists, so the
      // current session's access token is already dead — signOut()'s own
      // network leg may itself fail against a now-gone user, hence the catch,
      // but calling it regardless still clears the locally-persisted session
      // synchronously on this end, which is what actually matters here. The
      // reload after it is a deliberate belt-and-suspenders: it guarantees a
      // fully clean app boot (no lingering in-memory module state anywhere)
      // regardless of exactly how signOut() behaved against a deleted account.
      await logOut().catch(() => {});
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      // Re-enables the button (the typed confirmation text is still valid —
      // only the request itself failed) instead of leaving it stuck disabled
      // after the one-shot `btn.disabled = true` above.
      updateDeleteAccountButtonState();
      showToast(err.message || t("settings.deleteAccountError"), "error");
    }
  });

  el("open-calculator-btn").addEventListener("click", () => {
    el("calculator-preview").hidden = true;
    el("calc-apply-btn").disabled = true;
    openSheet("calculator-sheet");
    // Same reasoning as the lang/theme thumbs in the settings-btn handler:
    // #goal-type-tabs was already given the right .active button back when
    // Settings populated the form (resetPillTabs, unaffected by visibility),
    // but its sliding thumb needs a real measured geometry, which only exists
    // once this sheet is actually visible.
    moveToggleThumb(el("goal-type-tabs"));
  });

  // Delegated on the form, not per-field: covers every number input and select
  // with one listener, and modern browsers fire "input" for <select> changes
  // too (not just the older "change"), so this stays in sync live as any
  // field changes rather than only after the field loses focus.
  el("calculator-form").addEventListener("input", updateCalculatorPreview);

  el("calculator-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const inputs = readCalculatorInputs();
    const targets = calculateTargets(inputs);
    el("target-calories").value = targets.calories;
    el("target-protein").value = targets.protein;
    el("target-carbs").value = targets.carbs;
    el("target-fats").value = targets.fats;
    // Piggybacks the calculator's own weight/height/age/sex/activity inputs
    // into the next Save-targets call (see settings-form's submit handler
    // below) — this is the same data services/analytics_service.py's BMR
    // estimate wants for a more accurate forecast, and the calculator already
    // collects it every time it's used, so this captures it for free with no
    // new onboarding UI. Still just fills the form (never saved on its own,
    // same as the calorie/macro fields above) until the user hits Save.
    lastCalculatorBiometrics = {
      age: inputs.age,
      height_cm: inputs.heightCm,
      biological_sex: inputs.sex,
      activity_level: inputs.activityLevel,
    };
    closeSheet("calculator-sheet");
    showToast(t("calculator.appliedToast"), "success");
  });

  el("target-auto-balance-toggle").addEventListener("change", () => {
    const enabled = el("target-auto-balance-toggle").checked;
    localStorage.setItem(AUTO_BALANCE_KEY, enabled ? "1" : "0");
    if (enabled) recalculateCaloriesFromMacros();
  });

  el("ring-pace-toggle").addEventListener("change", () => {
    // setRingPaceEnabled re-renders just the marker itself (ui.js) — no need
    // to wait for the next full render() to see the change take effect.
    setRingPaceEnabled(el("ring-pace-toggle").checked);
  });

  el("settings-form").addEventListener("input", (e) => {
    if (isAutoBalanceEnabled() && AUTO_BALANCE_FIELD_IDS.has(e.target.id)) recalculateCaloriesFromMacros();
  });

  el("lang-switcher-buttons").addEventListener("click", (e) => {
    const btn = e.target.closest(".pref-toggle-btn");
    if (!btn || btn.dataset.lang === getLanguage()) return;
    setLanguage(btn.dataset.lang);
    updateLangButtons();
    vibrate(15);
  });

  // Preferences' bento header stat shows a translated theme label ("Dark" /
  // "Întunecat") alongside the language code — keeps it correct on ANY
  // language change (this switcher, or the pre-login flag button before
  // this module was even loaded), same "register a listener, don't chase
  // every call site that could change the language" discipline every other
  // module with dynamic translated text in this app already follows (see
  // CLAUDE.md's i18n section). setLanguage() calls every registered
  // listener synchronously before returning, so this also covers the click
  // handler right above — no separate manual call needed there.
  onLanguageChange(() => updateAccordionHeaderStats());

  el("logout-btn").addEventListener("click", async () => {
    closeSheet("settings-sheet");
    await logOut();
  });
}
