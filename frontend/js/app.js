import { api, warmBackend } from "./api.js?v=20260723c";
import { initAuth, logOut } from "./auth.js?v=20260723c";
import { initScan, openScanSheetFresh } from "./scan.js?v=20260723c";
import {
  animateItemRemoval,
  closeAllSheets,
  closeSheet,
  openSheet,
  renderDashboard,
  renderSavedMeals,
  setGreeting,
  showToast,
} from "./ui.js?v=20260723c";

const el = (id) => document.getElementById(id);

warmBackend(); // fired immediately on script load — see api.js for why

let state = {
  targets: null,
  logs: [],
  water: { total_ml: 0, target_ml: 3000, entries: [] },
  savedMeals: [],
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
function todaysLogs(logs) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return logs.filter((log) => new Date(log.logged_at) >= startOfDay);
}

async function loadAll() {
  // Promise.allSettled (not .all): one flaky endpoint must not discard the
  // other three that succeeded. Previously any single rejection (e.g. a slow
  // /water/today) meant targets/logs/savedMeals were thrown away too, leaving
  // state.targets permanently null — which is exactly what made the settings
  // button look "frozen" (its click handler no-ops while targets is null).
  const [targetsR, logsR, waterR, savedMealsR] = await Promise.allSettled([
    api.getTargets(),
    api.listLogs(),
    api.getTodayWater(),
    api.listSavedMeals(),
  ]);

  if (targetsR.status === "fulfilled") state.targets = targetsR.value;
  if (logsR.status === "fulfilled") state.logs = logsR.value;
  if (waterR.status === "fulfilled") state.water = waterR.value;
  if (savedMealsR.status === "fulfilled") state.savedMeals = savedMealsR.value;

  render();

  const firstFailure = [targetsR, logsR, waterR, savedMealsR].find((r) => r.status === "rejected");
  if (firstFailure) {
    showToast(firstFailure.reason?.message || "Some data could not be loaded", "error");
  }
}

function render(highlightId) {
  if (!state.targets) return;
  renderDashboard(state.targets, todaysLogs(state.logs), state.water, highlightId);
  renderSavedMeals(state.savedMeals);
}

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
    .catch((err) => rollbackNewLog(tempId, err.message || "Could not save that entry — removed"));

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
        .catch((err) => showToast(err.message || "Logged, but couldn't save as a favorite", "error"))
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
    rollbackNewLog(tempId, err.message || "Could not log that meal — removed");
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
  el("manual-sheet-title").textContent = existingLog ? "Edit food" : "Manual entry";
  el("manual-submit-btn").textContent = existingLog ? "Save changes" : "Log food";
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
      submitBtn.textContent = "Updating…";
      try {
        const saved = await api.correctLog(editId, { food_name: payload.food_name, weight_g: payload.weight_g });
        showToast("Updated!", "success");
        closeSheet("manual-sheet");
        replaceLog(editId, saved);
      } catch (err) {
        showToast(err.message || "Could not update that entry", "error");
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save changes";
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
    showToast("Updated!", "success");
    vibrate(12);

    try {
      const saved = await api.correctLog(editId, payload);
      replaceLog(editId, saved);
    } catch (err) {
      replaceLog(editId, previous);
      showToast(err.message || "Could not update that entry — reverted", "error");
    }
    return;
  }

  // New manual entry — every value is already known client-side, so log it
  // immediately rather than waiting on the round trip.
  const wantsFavorite = el("manual-save-favorite").checked;
  showToast("Logged!", "success");
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
    showToast("Removed", "success");
    vibrate(10);
    try {
      await api.deleteLog(id);
    } catch (err) {
      state.logs = previousLogs;
      render();
      showToast(err.message || "Could not delete that entry — restored", "error");
    }
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
    showToast("Logged!", "success");
    logSavedMealOptimistic(meal);
  } else if (btn.dataset.action === "delete-saved") {
    const previousSavedMeals = state.savedMeals;
    await animateItemRemoval("saved-meals-list", id);
    state.savedMeals = state.savedMeals.filter((m) => m.id !== id);
    renderSavedMeals(state.savedMeals);
    showToast("Removed", "success");
    vibrate(10);
    try {
      await api.deleteSavedMeal(id);
    } catch (err) {
      state.savedMeals = previousSavedMeals;
      renderSavedMeals(state.savedMeals);
      showToast(err.message || "Could not delete that meal — restored", "error");
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
  showToast(`+${amount.toLocaleString()} ml logged`, "success");
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
      showToast(err.message || "Could not log water — reverted", "error");
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
    showToast("Enter an amount greater than 0", "error");
    return;
  }
  if (amount > MAX_WATER_ENTRY_ML) {
    showToast(`Max ${MAX_WATER_ENTRY_ML.toLocaleString()} ml per entry`, "error");
    return;
  }
  input.value = "";
  addWaterOptimistic(amount);
});

// Re-triggers the capsule "bump" and splash-ripple CSS animations even on
// back-to-back clicks (removing then re-adding the class in the same tick
// wouldn't restart it — the forced reflow via offsetWidth makes it restart).
function playWaterFeedback() {
  const capsule = document.querySelector(".water-capsule");
  const splash = el("water-splash");
  capsule.classList.remove("bump");
  void capsule.offsetWidth;
  capsule.classList.add("bump");
  splash.classList.remove("pulse");
  void splash.offsetWidth;
  splash.classList.add("pulse");
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
    showToast(err.message || "Could not delete that entry — restored", "error");
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
    showToast("Loading your data…", "default");
    try {
      state.targets = await api.getTargets();
    } catch (err) {
      showToast(err.message || "Could not load your targets — try again", "error");
      return;
    }
  }
  el("target-calories").value = state.targets.daily_calories;
  el("target-protein").value = state.targets.daily_protein;
  el("target-carbs").value = state.targets.daily_carbs;
  el("target-fats").value = state.targets.daily_fats;
  el("target-water").value = state.targets.daily_water_ml;
  openSheet("settings-sheet");
});

el("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = el("settings-form").querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";
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
    showToast("Targets updated", "success");
  } catch (err) {
    showToast(err.message || "Could not update targets", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save targets";
  }
});

el("logout-btn").addEventListener("click", async () => {
  closeSheet("settings-sheet");
  await logOut();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
setGreeting();
initScan({ logNewFood: submitNewLog });
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
