import { api } from "./api.js";
import { initAuth, logOut } from "./auth.js";
import { initScan, openScanSheetFresh } from "./scan.js";
import {
  closeSheet,
  openSheet,
  renderDashboard,
  renderSavedMeals,
  setGreeting,
  showToast,
} from "./ui.js";

const el = (id) => document.getElementById(id);

let state = {
  targets: null,
  logs: [],
  water: { total_ml: 0, target_ml: 3000, entries: [] },
  savedMeals: [],
  editingLogId: null, // set when the manual sheet is being used to correct an existing entry
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
function todaysLogs(logs) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return logs.filter((log) => new Date(log.logged_at) >= startOfDay);
}

async function loadAll() {
  try {
    const [targets, logs, water, savedMeals] = await Promise.all([
      api.getTargets(),
      api.listLogs(),
      api.getTodayWater(),
      api.listSavedMeals(),
    ]);
    state = { ...state, targets, logs, water, savedMeals };
    render();
  } catch (err) {
    showToast(err.message || "Could not load your data", "error");
  }
}

async function refreshLogsAndWater() {
  const [logs, water] = await Promise.all([api.listLogs(), api.getTodayWater()]);
  state.logs = logs;
  state.water = water;
  render();
}

function render() {
  if (!state.targets) return;
  renderDashboard(state.targets, todaysLogs(state.logs), state.water);
  renderSavedMeals(state.savedMeals);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function switchView(view) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  el(`view-${view}`).hidden = false;
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

// Generic close-on-backdrop + [data-close] buttons
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeSheet(btn.dataset.close));
});
document.querySelectorAll(".sheet-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.hidden = true;
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

  try {
    if (state.editingLogId) {
      // Correction endpoint recalculates server-side (rescale, or a text-only
      // AI lookup if the food name changed) — we still send the full edited
      // values so the UI reflects exactly what the user typed immediately.
      await api.correctLog(state.editingLogId, {
        food_name: payload.food_name,
        weight_g: payload.weight_g,
      });
    } else {
      await api.createLog({ ...payload, source: "manual" });
      if (el("manual-save-favorite").checked) {
        await api.saveMeal({
          name: payload.food_name,
          weight_g: payload.weight_g,
          calories: payload.calories,
          protein: payload.protein,
          carbs: payload.carbs,
          fats: payload.fats,
        });
      }
    }
    showToast(state.editingLogId ? "Updated!" : "Logged!", "success");
    closeSheet("manual-sheet");
    await Promise.all([refreshLogsAndWater(), reloadSavedMeals()]);
  } catch (err) {
    showToast(err.message || "Could not save that entry", "error");
  }
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
    try {
      await api.deleteLog(id);
      await refreshLogsAndWater();
      showToast("Removed", "success");
    } catch (err) {
      showToast(err.message || "Could not delete that entry", "error");
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
    try {
      await api.logSavedMeal(id);
      await refreshLogsAndWater();
      showToast("Logged!", "success");
    } catch (err) {
      showToast(err.message || "Could not log that meal", "error");
    }
  } else if (btn.dataset.action === "delete-saved") {
    try {
      await api.deleteSavedMeal(id);
      await reloadSavedMeals();
      showToast("Removed", "success");
    } catch (err) {
      showToast(err.message || "Could not delete that meal", "error");
    }
  }
});

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------
el("water-add-btn").addEventListener("click", async () => {
  try {
    await api.addWater(250);
    const water = await api.getTodayWater();
    state.water = water;
    render();
  } catch (err) {
    showToast(err.message || "Could not log water", "error");
  }
});

// ---------------------------------------------------------------------------
// Settings / targets
// ---------------------------------------------------------------------------
el("settings-btn").addEventListener("click", () => {
  if (!state.targets) return;
  el("target-calories").value = state.targets.daily_calories;
  el("target-protein").value = state.targets.daily_protein;
  el("target-carbs").value = state.targets.daily_carbs;
  el("target-fats").value = state.targets.daily_fats;
  el("target-water").value = state.targets.daily_water_ml;
  openSheet("settings-sheet");
});

el("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
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
initScan({ onLogged: refreshLogsAndWater });
initAuth({
  onSignedIn: () => loadAll(),
  onSignedOut: () => {
    state = { targets: null, logs: [], water: { total_ml: 0, target_ml: 3000, entries: [] }, savedMeals: [], editingLogId: null };
  },
});
