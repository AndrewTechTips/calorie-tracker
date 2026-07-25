import { api, warmBackend } from "./api.js?v=20260725c";
import { initAuth, logOut } from "./auth.js?v=20260725c";
import { initScan, openScanSheetFresh } from "./scan.js?v=20260725c";
import { initProgress, renderProgress } from "./progress.js?v=20260725c";
import { initReminders } from "./reminders.js?v=20260725c";
import {
  animateItemRemoval,
  closeAllSheets,
  closeSheet,
  computeDailyTotals,
  openSheet,
  renderDashboard,
  renderSavedMeals,
  setGreeting,
  showToast,
} from "./ui.js?v=20260725c";
import { getLanguage, getLocale, initI18n, onLanguageChange, setLanguage, t } from "./i18n.js?v=20260725c";
import { getCalorieStatus } from "./coach.js?v=20260725c";

const el = (id) => document.getElementById(id);

warmBackend(); // fired immediately on script load — see api.js for why

let state = {
  targets: null,
  logs: [],
  water: { total_ml: 0, target_ml: 3000, entries: [] },
  savedMeals: [],
  dayState: null, // { day_number, day_boundary } — see backend/routers/day.py
  editingLogId: null, // set when the manual sheet is being used to correct an existing entry
};

// Snapshot of the log being edited, captured when the sheet opens — lets a
// weight-only edit compute the same rescale the backend would (see
// backend/routers/logs.py) and apply it instantly, instead of waiting on a
// round trip for what's ultimately just arithmetic.
let editingLogSnapshot = null;

const makeTempId = () => `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const roundTo1 = (n) => Math.round(n * 10) / 10;

// A short, silent-if-unsupported haptic tick on the interactions that matter
// most on a phone (this ships as a mobile app first) — cheap, native-feeling
// confirmation that costs nothing when the API isn't there (desktop/Safari).
function vibrate(ms) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported — ignore */
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
// "Today" isn't always literal midnight — day_boundary (from GET /day) moves
// forward the moment the user presses "End day" (see the end-day-btn handler
// below), so the dashboard reads as a fresh day immediately instead of
// waiting for real midnight. If day_boundary is stale (from a manual end-day
// on a *previous* calendar day), today's own midnight always wins instead —
// same max() rule the backend applies in services/day_service.py, so both
// sides of this in sync.
function effectiveCutoff(dayBoundaryIso) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const boundary = dayBoundaryIso ? new Date(dayBoundaryIso) : midnight;
  return boundary > midnight ? boundary : midnight;
}

function todaysLogs(logs) {
  const cutoff = effectiveCutoff(state.dayState?.day_boundary);
  return logs.filter((log) => new Date(log.logged_at) >= cutoff);
}

async function loadAll() {
  // Promise.allSettled (not .all): one flaky endpoint must not discard the
  // others that succeeded. Previously any single rejection (e.g. a slow
  // /water/today) meant targets/logs/savedMeals were thrown away too, leaving
  // state.targets permanently null — which is exactly what made the settings
  // button look "frozen" (its click handler no-ops while targets is null).
  const [targetsR, logsR, waterR, savedMealsR, dayStateR] = await Promise.allSettled([
    api.getTargets(),
    api.listLogs(),
    api.getTodayWater(),
    api.listSavedMeals(),
    api.getDayState(),
  ]);

  if (targetsR.status === "fulfilled") state.targets = targetsR.value;
  if (logsR.status === "fulfilled") state.logs = logsR.value;
  if (waterR.status === "fulfilled") state.water = waterR.value;
  if (savedMealsR.status === "fulfilled") state.savedMeals = savedMealsR.value;
  // A failed day-state fetch shouldn't break the whole dashboard — falling
  // back to "day 1, boundary now" just means today's totals show as-is
  // (equivalent to plain midnight-based filtering) until the next successful
  // load, same graceful-degradation spirit as the other endpoints here.
  if (dayStateR.status === "fulfilled") state.dayState = dayStateR.value;

  render();
  renderDayHeader();

  const firstFailure = [targetsR, logsR, waterR, savedMealsR].find((r) => r.status === "rejected");
  if (firstFailure) {
    showToast(firstFailure.reason?.message || t("toast.someDataFailed"), "error");
  }
}

function render(highlightId) {
  if (!state.targets) return;
  renderDashboard(state.targets, todaysLogs(state.logs), state.water, highlightId);
  renderSavedMeals(state.savedMeals);
}

// "Day N — Thursday, Jul 23" in the header, next to the greeting. Falls back
// to just the date (no day number) until the first successful /day fetch.
function renderDayHeader() {
  const dateText = new Date().toLocaleDateString(getLocale(), { weekday: "long", month: "short", day: "numeric" });
  el("greeting-date").textContent = state.dayState
    ? `${t("dashboard.dayLabel", { n: state.dayState.day_number })} — ${dateText}`
    : dateText;
}

// ---------------------------------------------------------------------------
// Live midnight rollover — the backend advances "Day N" lazily on its next
// request (backend/services/day_service.py), but a tab left open across a
// real midnight won't see that until something else triggers a re-render.
// A 60s interval (cheap: one date-string check, no network call unless the
// day changed) plus a visibilitychange listener for the "phone was locked
// overnight" case catch it without waiting on the user to act.
// ---------------------------------------------------------------------------
let lastSeenDateStr = new Date().toDateString();

async function checkForDayRollover() {
  const nowStr = new Date().toDateString();
  if (nowStr === lastSeenDateStr) return;
  lastSeenDateStr = nowStr;
  if (!state.targets) return; // not signed in / nothing loaded yet — nothing to refresh

  try {
    const [dayState, water] = await Promise.all([api.getDayState(), api.getTodayWater()]);
    state.dayState = dayState;
    state.water = water;
  } catch {
    // Keep showing what we have — todaysLogs() still falls back to plain
    // midnight-based filtering client-side even without a fresh day_boundary,
    // and the next successful check (interval or focus) will catch up.
  }
  render();
  renderDayHeader();
}

setInterval(checkForDayRollover, 60000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkForDayRollover();
});

// ---------------------------------------------------------------------------
// Optimistic log helpers — every food-logging path (manual, AI scan, saved
// meal quick-log, edits) shares this so the dashboard updates the instant the
// user acts, with the network call reconciling quietly in the background
// instead of gating the UI. On failure it rolls back and says so.
// ---------------------------------------------------------------------------
function insertOptimisticLog(optimisticLog) {
  state.logs = [optimisticLog, ...state.logs];
  render(optimisticLog.id);
}

function reconcileLog(tempId, realLog) {
  state.logs = state.logs.map((l) => (l.id === tempId ? realLog : l));
  render(realLog.id);
}

function rollbackNewLog(tempId, message) {
  state.logs = state.logs.filter((l) => l.id !== tempId);
  render();
  showToast(message, "error");
}

function replaceLog(id, updatedLog, highlightId) {
  state.logs = state.logs.map((l) => (l.id === id ? updatedLog : l));
  render(highlightId ?? id);
}

async function submitNewLog(payload, { favoriteName } = {}) {
  const tempId = makeTempId();
  insertOptimisticLog({ id: tempId, ...payload, image_url: null, logged_at: new Date().toISOString() });
  vibrate(12);

  const createPromise = api
    .createLog(payload)
    .then((saved) => reconcileLog(tempId, saved))
    .catch((err) => rollbackNewLog(tempId, err.message || t("toast.couldNotSaveEntryRemoved")));

  const favoritePromise = favoriteName
    ? api
        .saveMeal({
          name: favoriteName,
          weight_g: payload.weight_g,
          calories: payload.calories,
          protein: payload.protein,
          carbs: payload.carbs,
          fats: payload.fats,
        })
        .then(() => reloadSavedMeals())
        .catch((err) => showToast(err.message || t("toast.loggedButFavoriteFailed"), "error"))
    : Promise.resolve();

  await Promise.all([createPromise, favoritePromise]);
}

async function logSavedMealOptimistic(meal) {
  const tempId = makeTempId();
  insertOptimisticLog({
    id: tempId,
    food_name: meal.name,
    weight_g: meal.weight_g,
    calories: meal.calories,
    protein: meal.protein,
    carbs: meal.carbs,
    fats: meal.fats,
    source: "saved_meal",
    image_url: null,
    logged_at: new Date().toISOString(),
  });
  vibrate(12);
  try {
    const saved = await api.logSavedMeal(meal.id);
    reconcileLog(tempId, saved);
  } catch (err) {
    rollbackNewLog(tempId, err.message || t("toast.couldNotLogMealRemoved"));
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function switchView(view) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  el(`view-${view}`).hidden = false;
  updateNavIndicator();
  // Lazy-loaded, not fetched on every app load — most sessions never open
  // this tab, so there's no point spending a request on it up front.
  if (view === "progress") renderProgress(state.targets);
}

// Slides the pill highlight in the bottom nav under whichever tab is active,
// instead of just swapping a color — a small touch that makes navigation feel
// like one continuous motion rather than a hard cut.
function updateNavIndicator() {
  if (el("app").hidden) return; // getBoundingClientRect is meaningless while hidden
  const nav = document.querySelector(".bottom-nav");
  const active = document.querySelector(".nav-btn.active");
  const indicator = el("nav-indicator");
  if (!nav || !active || !indicator) return;
  const navRect = nav.getBoundingClientRect();
  const btnRect = active.getBoundingClientRect();
  indicator.style.width = `${btnRect.width}px`;
  indicator.style.transform = `translateX(${btnRect.left - navRect.left}px)`;
}

window.addEventListener("resize", updateNavIndicator);

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

// Generic close-on-backdrop + [data-close] buttons
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeSheet(btn.dataset.close));
});
document.querySelectorAll(".sheet-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    // Must go through closeSheet() (not overlay.hidden = true directly) — it
    // also clears the body's no-scroll lock. Dismissing via backdrop click
    // used to skip that, leaving page scroll stuck locked until some other
    // sheet was opened and closed "properly" through a button.
    if (e.target === overlay) closeSheet(overlay.id);
  });
});

// ---------------------------------------------------------------------------
// FAB + add-food sheet
// ---------------------------------------------------------------------------
el("fab-add").addEventListener("click", () => openSheet("add-sheet"));

el("opt-scan").addEventListener("click", () => {
  closeSheet("add-sheet");
  openScanSheetFresh();
  openSheet("scan-sheet");
});

el("opt-saved").addEventListener("click", () => {
  closeSheet("add-sheet");
  switchView("saved");
});

el("opt-manual").addEventListener("click", () => {
  closeSheet("add-sheet");
  openManualSheet();
});

el("new-saved-meal-btn").addEventListener("click", () => openManualSheet());

// ---------------------------------------------------------------------------
// Manual entry sheet (also reused for editing an existing log)
// ---------------------------------------------------------------------------
function openManualSheet(existingLog = null) {
  state.editingLogId = existingLog?.id || null;
  editingLogSnapshot = existingLog;
  el("manual-sheet-title").textContent = existingLog ? t("manual.titleEdit") : t("manual.titleNew");
  el("manual-submit-btn").textContent = existingLog ? t("manual.submitEdit") : t("manual.submitNew");
  el("manual-save-favorite-row").hidden = Boolean(existingLog);

  el("manual-name").value = existingLog?.food_name || "";
  el("manual-weight").value = existingLog ? Math.round(existingLog.weight_g) : "";
  el("manual-calories").value = existingLog ? Math.round(existingLog.calories) : "";
  el("manual-protein").value = existingLog?.protein ?? "";
  el("manual-carbs").value = existingLog?.carbs ?? "";
  el("manual-fats").value = existingLog?.fats ?? "";
  el("manual-save-favorite").checked = false;

  openSheet("manual-sheet");
}

// While editing, changing the weight live-rescales the macro fields from the
// original snapshot (visibly, in the form) — the same proportional scaling
// the app always did, just no longer hidden inside a server-side guess. The
// user can still hand-tweak any field afterward; whatever's in the form at
// submit time is what gets saved, verbatim.
el("manual-weight").addEventListener("input", () => {
  if (!state.editingLogId || !editingLogSnapshot?.weight_g) return;
  const newWeight = Number(el("manual-weight").value);
  if (!newWeight || newWeight <= 0) return;
  const ratio = newWeight / editingLogSnapshot.weight_g;
  el("manual-calories").value = Math.round(editingLogSnapshot.calories * ratio);
  el("manual-protein").value = roundTo1(editingLogSnapshot.protein * ratio);
  el("manual-carbs").value = roundTo1(editingLogSnapshot.carbs * ratio);
  el("manual-fats").value = roundTo1(editingLogSnapshot.fats * ratio);
});

el("manual-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    food_name: el("manual-name").value.trim(),
    weight_g: Number(el("manual-weight").value),
    calories: Number(el("manual-calories").value),
    protein: Number(el("manual-protein").value),
    carbs: Number(el("manual-carbs").value),
    fats: Number(el("manual-fats").value),
  };
  const submitBtn = el("manual-submit-btn");

  if (state.editingLogId) {
    const editId = state.editingLogId;
    const nameChanged = payload.food_name && payload.food_name !== editingLogSnapshot?.food_name;

    if (nameChanged) {
      // A food-name change needs the backend's text-only AI re-estimate (see
      // estimate_macros_for_food_name in gemini_service.py) — we genuinely
      // don't know the new macros client-side, so this can't be faked
      // optimistically. Show a clear "working on it" state instead of letting
      // the button just sit there for the second or two that call can take.
      submitBtn.disabled = true;
      submitBtn.textContent = t("manual.submitUpdating");
      try {
        const saved = await api.correctLog(editId, { food_name: payload.food_name, weight_g: payload.weight_g });
        showToast(t("toast.updated"), "success");
        closeSheet("manual-sheet");
        replaceLog(editId, saved);
      } catch (err) {
        showToast(err.message || t("toast.couldNotUpdateEntry"), "error");
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = t("manual.submitEdit");
      }
      return;
    }

    // Direct edit: whatever is in the form — weight, calories, protein,
    // carbs, fats — is exactly what gets saved, verbatim. (Previously this
    // only ever sent food_name/weight_g to the backend, silently discarding
    // any macro fields the user had actually changed by hand — editing
    // anything but the weight had no visible effect.) It's already fully
    // known client-side, so apply it immediately and reconcile in the
    // background.
    const previous = editingLogSnapshot;
    replaceLog(editId, { ...previous, ...payload });
    closeSheet("manual-sheet");
    showToast(t("toast.updated"), "success");
    vibrate(12);

    try {
      const saved = await api.correctLog(editId, payload);
      replaceLog(editId, saved);
    } catch (err) {
      replaceLog(editId, previous);
      showToast(err.message || t("toast.couldNotUpdateEntryReverted"), "error");
    }
    return;
  }

  // New manual entry — every value is already known client-side, so log it
  // immediately rather than waiting on the round trip.
  const wantsFavorite = el("manual-save-favorite").checked;
  showToast(t("toast.loggedSuccess"), "success");
  closeSheet("manual-sheet");
  submitNewLog({ ...payload, source: "manual" }, { favoriteName: wantsFavorite ? payload.food_name : undefined });
});

// ---------------------------------------------------------------------------
// Today's log list — edit / delete via event delegation
// ---------------------------------------------------------------------------
el("log-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest(".log-item").dataset.id;
  const log = state.logs.find((l) => l.id === id);

  if (btn.dataset.action === "edit") {
    openManualSheet(log);
  } else if (btn.dataset.action === "delete") {
    const previousLogs = state.logs;
    await animateItemRemoval("log-list", id);
    state.logs = state.logs.filter((l) => l.id !== id);
    render();
    showToast(t("toast.removed"), "success");
    vibrate(10);
    try {
      await api.deleteLog(id);
    } catch (err) {
      state.logs = previousLogs;
      render();
      showToast(err.message || t("toast.couldNotDeleteEntryRestored"), "error");
    }
  }
});

// ---------------------------------------------------------------------------
// End Day — shows today's recap, then genuinely closes it out: POST
// /day/end moves the server's day_boundary to this exact moment and bumps
// the day counter (backend/routers/day.py). Nothing is deleted — every log
// made today is still stored and still counted correctly by trends/streak
// (which key off each entry's own calendar date, not this boundary) — but
// todaysLogs() below now filters against the new boundary, so the very next
// render() shows a genuinely fresh, empty "Day N+1" immediately instead of
// waiting for real midnight.
// ---------------------------------------------------------------------------
el("end-day-btn").addEventListener("click", () => {
  if (!state.targets) return;
  const totals = computeDailyTotals(todaysLogs(state.logs));
  const targets = state.targets;

  el("end-day-calories").textContent = `${Math.round(totals.calories).toLocaleString()} / ${Math.round(targets.daily_calories).toLocaleString()}`;
  el("end-day-protein").textContent = `${Math.round(totals.protein)} / ${Math.round(targets.daily_protein)}g`;
  el("end-day-carbs").textContent = `${Math.round(totals.carbs)} / ${Math.round(targets.daily_carbs)}g`;
  el("end-day-fats").textContent = `${Math.round(totals.fats)} / ${Math.round(targets.daily_fats)}g`;
  el("end-day-water").textContent = `${state.water.total_ml.toLocaleString()} / ${state.water.target_ml.toLocaleString()} ml`;

  // Same humanized status logic as the dashboard's own banner (coach.js) —
  // the recap should agree with what they already saw all day, not invent a
  // second opinion.
  const status = getCalorieStatus(totals, targets);
  const messageWrap = el("end-day-message-wrap");
  messageWrap.dataset.tone = status.tone;
  messageWrap.classList.remove("tone-success", "tone-info", "tone-warning", "tone-danger");
  messageWrap.classList.add(`tone-${status.tone}`);
  el("end-day-message").textContent = status.text;

  openSheet("end-day-sheet");
});

el("end-day-done-btn").addEventListener("click", async () => {
  const btn = el("end-day-done-btn");
  btn.disabled = true;
  try {
    state.dayState = await api.endDay();
    // Water's total is computed server-side against day_boundary too
    // (routers/water.py) — re-fetch so it reflects the new cutoff. Food
    // logs need no re-fetch: nothing was deleted, todaysLogs() just
    // re-filters the same array against the new boundary on render().
    try {
      state.water = await api.getTodayWater();
    } catch {
      /* not critical — water total just stays stale until the next successful refresh */
    }
    render();
    renderDayHeader();
    closeSheet("end-day-sheet");
    showToast(t("endDay.startedToast", { n: state.dayState.day_number }), "success");
  } catch (err) {
    showToast(err.message || t("endDay.couldNotEnd"), "error");
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Saved meals list — instant log / delete
// ---------------------------------------------------------------------------
async function reloadSavedMeals() {
  state.savedMeals = await api.listSavedMeals();
  renderSavedMeals(state.savedMeals);
}

el("saved-meals-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest(".log-item").dataset.id;

  if (btn.dataset.action === "log-saved") {
    const meal = state.savedMeals.find((m) => m.id === id);
    if (!meal) return;
    showToast(t("toast.loggedSuccess"), "success");
    logSavedMealOptimistic(meal);
  } else if (btn.dataset.action === "delete-saved") {
    const previousSavedMeals = state.savedMeals;
    await animateItemRemoval("saved-meals-list", id);
    state.savedMeals = state.savedMeals.filter((m) => m.id !== id);
    renderSavedMeals(state.savedMeals);
    showToast(t("toast.removed"), "success");
    vibrate(10);
    try {
      await api.deleteSavedMeal(id);
    } catch (err) {
      state.savedMeals = previousSavedMeals;
      renderSavedMeals(state.savedMeals);
      showToast(err.message || t("toast.couldNotDeleteMealRestored"), "error");
    }
  }
});

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------
const MAX_WATER_ENTRY_ML = 5000; // matches WaterLogCreate's amount_ml le=5000 in backend/models.py

function addWaterOptimistic(amount) {
  const tempId = makeTempId();
  const previousWater = state.water;

  state.water = {
    ...state.water,
    total_ml: state.water.total_ml + amount,
    entries: [{ id: tempId, amount_ml: amount, logged_at: new Date().toISOString() }, ...state.water.entries],
  };
  render();
  playWaterFeedback();
  showToast(t("toast.waterLogged", { amount: amount.toLocaleString() }), "success");
  vibrate(12);

  api
    .addWater(amount)
    .then((saved) => {
      state.water = { ...state.water, entries: state.water.entries.map((e) => (e.id === tempId ? saved : e)) };
      render();
    })
    .catch((err) => {
      state.water = previousWater;
      render();
      showToast(err.message || t("toast.couldNotLogWaterReverted"), "error");
    });
}

el("water-add-btn").addEventListener("click", () => addWaterOptimistic(250));

el("water-quick-amounts").addEventListener("click", (e) => {
  const btn = e.target.closest(".quick-amount-btn");
  if (!btn) return;
  addWaterOptimistic(Number(btn.dataset.amount));
});

el("water-custom-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = el("water-custom-amount");
  const amount = Math.round(Number(input.value));
  if (!amount || amount <= 0) {
    showToast(t("toast.enterAmountGreaterThanZero"), "error");
    return;
  }
  if (amount > MAX_WATER_ENTRY_ML) {
    showToast(t("toast.maxAmountPerEntry", { max: MAX_WATER_ENTRY_ML.toLocaleString() }), "error");
    return;
  }
  input.value = "";
  addWaterOptimistic(amount);
});

// Re-triggers the capsule "bump" and splash-ripple CSS animations even on
// back-to-back clicks (removing then re-adding the class in the same tick
// wouldn't restart it — the forced reflow via offsetWidth makes it restart).
function playWaterFeedback() {
  const capsule = el("water-capsule");
  const splash = el("water-splash");
  const droplet = el("water-droplet");
  capsule.classList.remove("bump");
  void capsule.offsetWidth;
  capsule.classList.add("bump");
  splash.classList.remove("pulse");
  void splash.offsetWidth;
  splash.classList.add("pulse");
  droplet.classList.remove("drop");
  void droplet.offsetWidth;
  droplet.classList.add("drop");
}

// A user can fat-finger "+250 ml" more than they meant to — this lets them
// remove a specific entry rather than losing the whole day's water total.
el("water-manage-btn").addEventListener("click", async () => {
  openSheet("water-sheet");
  try {
    state.water = await api.getTodayWater(); // reconcile with the server while the sheet is open, in case of drift
    render();
  } catch {
    /* keep showing the locally-known entries if this fails — not worth an error toast for a background refresh */
  }
});

el("water-entries-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action='delete-water']");
  if (!btn) return;
  const id = btn.closest(".log-item").dataset.id;
  const entry = state.water.entries.find((w) => w.id === id);
  if (!entry) return;

  const previousWater = state.water;
  await animateItemRemoval("water-entries-list", id);
  state.water = {
    ...state.water,
    total_ml: Math.max(state.water.total_ml - entry.amount_ml, 0),
    entries: state.water.entries.filter((w) => w.id !== id),
  };
  render();
  vibrate(10);

  try {
    await api.deleteWaterEntry(id);
  } catch (err) {
    state.water = previousWater;
    render();
    showToast(err.message || t("toast.couldNotDeleteEntryRestored"), "error");
  }
});

// ---------------------------------------------------------------------------
// Settings / targets
// ---------------------------------------------------------------------------
el("settings-btn").addEventListener("click", async () => {
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
  el("target-calories").value = state.targets.daily_calories;
  el("target-protein").value = state.targets.daily_protein;
  el("target-carbs").value = state.targets.daily_carbs;
  el("target-fats").value = state.targets.daily_fats;
  el("target-water").value = state.targets.daily_water_ml;
  updateLangButtons();
  openSheet("settings-sheet");
});

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
      daily_water_ml: Number(el("target-water").value),
    });
    state.targets = updated;
    render();
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
// Language switcher (settings sheet) — English/Romanian only, by design.
// ---------------------------------------------------------------------------
function updateLangButtons() {
  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === getLanguage());
  });
}

el("lang-switcher-buttons").addEventListener("click", (e) => {
  const btn = e.target.closest(".lang-btn");
  if (!btn || btn.dataset.lang === getLanguage()) return;
  setLanguage(btn.dataset.lang);
  updateLangButtons();
});

// Static labels (data-i18n) are handled by setLanguage() itself; anything
// computed from live app state needs its own resync here so a language
// switch never leaves stale English/Romanian text sitting next to freshly
// translated labels.
onLanguageChange(() => {
  setGreeting();
  renderDayHeader();
  render();
  el("manual-sheet-title").textContent = state.editingLogId ? t("manual.titleEdit") : t("manual.titleNew");
  el("manual-submit-btn").textContent = state.editingLogId ? t("manual.submitEdit") : t("manual.submitNew");
});

el("logout-btn").addEventListener("click", async () => {
  closeSheet("settings-sheet");
  await logOut();
});

// ---------------------------------------------------------------------------
// Data export — CSV of whatever's still in the retained window (or a
// shorter slice of it). Client-side file generation only; no backend
// endpoint needed beyond the list endpoints that already exist.
// ---------------------------------------------------------------------------
function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadExportCsv(logs, water, weight) {
  const lines = ["type,logged_at,name,weight_g,amount_ml,weight_kg,calories,protein,carbs,fats"];
  logs.forEach((l) =>
    lines.push(
      ["food", l.logged_at, csvEscape(l.food_name), l.weight_g, "", "", l.calories, l.protein, l.carbs, l.fats].join(",")
    )
  );
  water.forEach((w) => lines.push(["water", w.logged_at, "", "", w.amount_ml, "", "", "", "", ""].join(",")));
  weight.forEach((w) => lines.push(["weight", w.logged_at, "", "", "", w.weight_kg, "", "", "", ""].join(",")));

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `iron-log-export-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

el("export-btn").addEventListener("click", async () => {
  const days = Number(el("export-range").value);
  const btn = el("export-btn");
  btn.disabled = true;
  try {
    const [logs, water, weight] = await Promise.all([
      api.listLogs(days),
      api.listWaterHistory(days),
      api.listWeight(days),
    ]);
    downloadExportCsv(logs, water, weight);
    showToast(t("export.exportSuccess"), "success");
  } catch (err) {
    showToast(err.message || t("export.exportFailed"), "error");
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// PWA — installable app shell caching (see sw.js). Registered after the
// page's own load event so it never competes with the initial render for
// bandwidth/CPU; feature-detected so browsers without service worker
// support (rare) just silently skip this.
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* offline-caching is a nice-to-have, never a requirement — fail silently */
    });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
initI18n(); // must run before anything else renders text, including the auth screen
setGreeting();
initScan({ logNewFood: submitNewLog });
initProgress();
initReminders();
initAuth({
  onSignedIn: () => {
    closeAllSheets(); // guard against a sheet left open by a previous session
    switchView("dashboard");
    loadAll();
  },
  onSignedOut: () => {
    state = { targets: null, logs: [], water: { total_ml: 0, target_ml: 3000, entries: [] }, savedMeals: [], editingLogId: null };
    closeAllSheets(); // nothing should render on top of the login screen
    switchView("dashboard");
  },
});
