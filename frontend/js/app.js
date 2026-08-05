import { api, warmBackend } from "./api.js?v=20260805y";
import { initAuth, logOut } from "./auth.js?v=20260805y";
import { clearDraft as clearScanDraft, initScan, openScanSheetFresh, renderScansGrid, wasScanSheetOpenBeforeReload } from "./scan.js?v=20260805y";
import { initProgress, renderProgress } from "./progress.js?v=20260805y";
import { initReminders, setContext as setReminderContext } from "./reminders.js?v=20260805y";
import { initAiCoach, setContext as setAiCoachContext } from "./aiCoach.js?v=20260805y";
import { initCoachChat } from "./coachChat.js?v=20260805y";
import { initDiscover, onDiscoverTabOpened, setDiscoverContext } from "./discover.js?v=20260805y";
import { initTutorial, maybeAutoStartTutorial, setTutorialContext } from "./tutorial.js?v=20260805y";
import {
  animateItemRemoval,
  closeAllSheets,
  closeSheet,
  computeDailyTotals,
  computeMacroContributions,
  deleteWithUndo,
  escapeHtml,
  getActivePillType,
  initCollapsibleListToggles,
  initPullToRefresh,
  initSheetDragToDismiss,
  isRingPaceEnabled,
  openSheet,
  renderDashboard,
  renderDayDetailList,
  renderRecipeIngredientList,
  renderSavedMeals,
  resetPillTabs,
  setGreeting,
  setRingPaceEnabled,
  setStatusBannerTone,
  showToast,
  vibrate,
  wirePillTabs,
} from "./ui.js?v=20260805y";
import { getLanguage, getLocale, initI18n, onLanguageChange, setLanguage, t } from "./i18n.js?v=20260805y";
import { getCalorieStatus } from "./coach.js?v=20260805y";
import { calculateTargets, roundTo1 } from "./nutritionMath.js?v=20260805y";
import { asImplicitIngredient, createIngredientsEditor } from "./ingredientsList.js?v=20260805y";
import { NOTO_SANS_BOLD_B64, NOTO_SANS_REGULAR_B64 } from "./pdfFonts.js?v=20260805y";
import {
  cacheFoodNames,
  countQueuedWrites,
  enqueueWrite,
  getCachedFoodNames,
  getDashboardSnapshot,
  listQueuedWrites,
  removeQueuedWrite,
  saveDashboardSnapshot,
} from "./db.js?v=20260805y";
import { fireConfetti } from "./confetti.js?v=20260805y";
import { fileToAvatarDataUrl, isImageFile, resolveAvatarUrl } from "./avatar.js?v=20260805y";

const el = (id) => document.getElementById(id);

// Fired immediately on script load, well before sign-in — see api.js for why
// this returns a promise instead of being pure fire-and-forget.
const backendWarmup = warmBackend();

let state = {
  targets: null,
  logs: [],
  water: { total_ml: 0, target_ml: 3000, entries: [] },
  savedMeals: [],
  savedMealsTab: "meal", // which pill-tab is active in the Saved view — "meal" | "product"
  dayState: null, // { date, ended } — see backend/routers/day.py
  editingLogId: null, // set when the manual sheet is being used to correct an existing entry
};

// Set only while the save-favorite choice sheet (tapping the bookmark icon
// on a today's-log row) is open — that row has no form context to attach a
// meal/product toggle to, unlike the manual-entry and scan-result forms.
let pendingFavoriteLog = null;

// Snapshot of the log being edited, captured when the sheet opens — lets a
// weight-only edit compute the same rescale the backend would (see
// backend/routers/logs.py) and apply it instantly, instead of waiting on a
// round trip for what's ultimately just arithmetic.
let editingLogSnapshot = null;

// Set (to a YYYY-MM-DD date string) only when the manual sheet is being used
// to add a *new*, backdated entry from the day-detail sheet (Daily History →
// tap a past day → "+ Add") — see openManualSheet()/openDayDetailSheet()
// below. null in every other case, including while editing an existing log
// (edits never change which day an entry belongs to).
let manualTargetDate = null;

// Set while the day-detail sheet (Daily History → tap a day) is open, to the
// date it's showing — render() keeps that list in sync with state.logs for
// free, the same way it already keeps the dashboard and saved-meals list in
// sync after any mutation.
let dayDetailDate = null;

// Set when the manual sheet is being used to edit an existing SAVED meal
// (Saved tab → edit icon) rather than a daily log — mutually exclusive with
// state.editingLogId. Shares the same weight-rescale/fiber-formula handling
// as editing a daily log (see openManualSheet below), since a saved meal has
// the identical {weight_g, calories, protein, carbs, fats, fiber} shape.
let editingSavedMealId = null;

// Set (to "meal" | "product") only when the manual sheet is being used to
// create a brand-new saved meal directly from the Saved tab's "+ New"/"+ Add"
// button — as opposed to logging food for today. Submitting in this mode
// calls api.saveMeal() only: it never touches daily_logs/today's calories,
// and never shows the "also save as favorite" checkbox (saving as a
// favorite/template *is* the whole point already, in this mode). Defaults to
// whichever Saved-tab pill is currently active (state.savedMealsTab), so the
// new item lands in "that specific zone" the user was actually looking at.
let creatingSavedMealType = null;

// ---------------------------------------------------------------------------
// In-progress draft persistence for a brand-new manual entry — same
// underlying issue and same sessionStorage-based fix as scan.js's scan-sheet
// draft (see its own comment for why: an installed PWA backgrounded for a
// while can get fully discarded and reloaded by the OS, not just suspended,
// silently losing whatever was mid-typed). Deliberately scoped to ONLY the
// genuinely-fresh "+ Add food" case, never editing an existing log/saved meal
// or creating a saved-meal template — restoring a stale draft on top of real
// data being edited would silently clobber it, which is a strictly worse bug
// than the one this is fixing.
// ---------------------------------------------------------------------------
const MANUAL_DRAFT_KEY = "ironlog_manual_draft";
let manualDraftModeActive = false;

function saveManualDraft() {
  if (!manualDraftModeActive) return;
  const draft = { name: el("manual-name").value, ingredients: manualIngredientsEditor.getIngredients() };
  const hasContent = draft.name.trim() || draft.ingredients.some((i) => i.food_name?.trim() || i.weight_g > 0);
  try {
    if (hasContent) sessionStorage.setItem(MANUAL_DRAFT_KEY, JSON.stringify(draft));
    else sessionStorage.removeItem(MANUAL_DRAFT_KEY);
  } catch {
    /* sessionStorage can throw in some locked-down/private-browsing contexts
       — losing the draft-recovery convenience is fine, the sheet still works */
  }
}

function clearManualDraft() {
  try {
    sessionStorage.removeItem(MANUAL_DRAFT_KEY);
  } catch {
    /* see saveManualDraft's comment */
  }
}

// Called from openManualSheet only in the fresh-entry case, after it's
// already seeded the form with its normal blank starting state.
function restoreManualDraftIfAny() {
  let raw;
  try {
    raw = sessionStorage.getItem(MANUAL_DRAFT_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let draft;
  try {
    draft = JSON.parse(raw);
  } catch {
    clearManualDraft();
    return;
  }
  if (draft.name) el("manual-name").value = draft.name;
  if (draft.ingredients?.length) manualIngredientsEditor.setIngredients(draft.ingredients);
}

const makeTempId = () => `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const pad2 = (n) => String(n).padStart(2, "0");
const localDateStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const formatShortDate = (dateStr) =>
  new Date(`${dateStr}T00:00:00`).toLocaleDateString(getLocale(), { month: "short", day: "numeric" });


// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
// Drives the whole live dashboard (ring, macro bars, status banner, visible
// log list) — see renderDashboard() in ui.js. "Today" is whatever local date
// GET /day resolved (backend/routers/day.py, timezone-aware — see
// daytime_service.py), matched against each log's own log_date. Ending the
// day no longer clears this: there's no forward-moving boundary anymore, so
// the list keeps showing everything logged today for the rest of the real
// day — "End day" only blocks *new* logging (see the 409 handling baked into
// the optimistic-insert rollback below), it doesn't hide what's already
// there. Falls back to the browser's own local date before the first
// successful /day fetch resolves.
function todaysLogs(logs) {
  const targetDate = state.dayState?.date || localDateStr();
  return logs.filter((log) => log.log_date === targetDate);
}

// Feeds reminders.js's weekly-recap notification — deliberately reuses
// state.logs (already the full retention window, not just today) instead of
// a separate GET /trends call, so the recap works even in a session that
// never opened the Progress tab. 10% tolerance matches
// backend/services/trends_service.py's own ADHERENCE_TOLERANCE exactly, so
// "on target" here means the same thing it does in Progress.
const WEEK_ADHERENCE_TOLERANCE = 0.1;

function computeWeekAdherence() {
  const targetCalories = state.targets?.daily_calories || 0;
  if (!targetCalories) return { adherentDays: 0, loggedDays: 0 };
  const caloriesByDate = new Map();
  state.logs.forEach((log) => {
    caloriesByDate.set(log.log_date, (caloriesByDate.get(log.log_date) || 0) + log.calories);
  });
  let adherentDays = 0;
  caloriesByDate.forEach((calories) => {
    if (Math.abs(calories - targetCalories) <= targetCalories * WEEK_ADHERENCE_TOLERANCE) adherentDays++;
  });
  return { adherentDays, loggedDays: caloriesByDate.size };
}

// A lightweight, always-available streak for the AI coach (aiCoach.js) —
// deliberately NOT the freeze-aware one progress.js computes
// (streakFreeze.js::computeStreakWithFreeze), because that one only exists
// once Progress has been opened at least once this session (it's derived
// from GET /trends, fetched lazily — see progress.js's renderProgress). The
// coach's avatar lives on the dashboard and must answer "what's my streak"
// correctly even in a session that never visits Progress, so this mirrors
// the same reversed-loop/skip-today algorithm directly against state.logs
// (already the full retention window) instead. The two can rarely disagree
// by one day, exactly when a freeze is actively bridging a gap — an
// accepted, minor inconsistency in exchange for not requiring a Progress
// visit (or a speculative extra /trends fetch on every dashboard load)
// before the coach can answer this question at all.
function computeSimpleStreak() {
  const targetCalories = state.targets?.daily_calories || 0;
  if (!targetCalories) return 0;
  const caloriesByDate = new Map();
  state.logs.forEach((log) => {
    caloriesByDate.set(log.log_date, (caloriesByDate.get(log.log_date) || 0) + log.calories);
  });
  const cursor = new Date(`${state.dayState?.date || localDateStr()}T00:00:00`);
  let streak = 0;
  for (let i = 0; i < 30; i++) {
    const calories = caloriesByDate.get(localDateStr(cursor)) || 0;
    if (i === 0 && calories === 0) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    if (calories <= 0 || Math.abs(calories - targetCalories) > targetCalories * WEEK_ADHERENCE_TOLERANCE) break;
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// "What's driving my calories today" — the single highest-calorie entry
// among today's logs, not an aggregate across duplicate names (today's list
// is short enough that this is a fine reading of "top food" without needing
// progress.js's own by-name aggregation, computeTopFoods, which looks across
// the whole retention window for a different purpose).
function computeTopFoodToday(logs) {
  if (!logs.length) return null;
  return logs.reduce((top, log) => (log.calories > (top?.calories || 0) ? log : top), null);
}

const LAST_SYNCED_TZ_KEY = "ironlog_synced_timezone";

// Pushes the browser's detected IANA timezone to the backend (PUT
// /day/timezone) once per session, and only when it's actually different
// from the last value we know we sent — everything server-side that means
// "today"/"midnight" for this user is computed from this (see
// backend/services/daytime_service.py). Best-effort: a failure here just
// means "today" keeps using whatever timezone the profile already has
// (defaults to UTC for a brand-new account) until this succeeds later.
async function syncTimezoneIfNeeded() {
  let detected;
  try {
    detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return; // no Intl support — extremely rare, just keep whatever's already stored
  }
  if (!detected || localStorage.getItem(LAST_SYNCED_TZ_KEY) === detected) return;
  try {
    await api.updateTimezone(detected);
    localStorage.setItem(LAST_SYNCED_TZ_KEY, detected);
  } catch {
    /* try again next load */
  }
}

// Turns a saved snapshot's epoch-ms timestamp into "5m ago"/"2h ago"/"3d ago"
// for the offline-snapshot toast below — deliberately coarse (no seconds
// granularity), since the point is "roughly how stale is this", not a precise
// duration.
function formatRelativeSnapshotAge(savedAt) {
  const minutes = Math.max(0, Math.round((Date.now() - savedAt) / 60000));
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { count: hours });
  return t("time.daysAgo", { count: Math.round(hours / 24) });
}

async function loadAll() {
  // Wait for the same cold-start ping fired at script load (see api.js's
  // warmBackend()) before firing the real batch below. On an already-warm
  // backend this resolves immediately, so it costs nothing; on a cold one it
  // avoids racing the batch's own 15s per-request timeout against a 30-60s
  // wake-up. Only surface a toast if the wait is actually noticeable, so the
  // warm-instance common case never flashes an explanation nobody needed.
  const wakeToastTimer = setTimeout(() => showToast(t("toast.wakingServer"), "default"), 3000);
  await backendWarmup;
  clearTimeout(wakeToastTimer);

  // No-ops (a single localStorage read) once already synced, so this never
  // adds perceptible latency to a normal load — only the first load ever, or
  // right after the device's timezone actually changes, does a real PUT.
  // Awaited before the batch below so this load's own GET /day already
  // reflects the right timezone instead of one stale load behind.
  await syncTimezoneIfNeeded();

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

  // Fully offline on a cold start — the three core calls all failed AND
  // there's no in-memory data from an earlier successful load this session
  // either (so this only fires on a genuine cold/offline boot, never on a
  // pull-to-refresh that transiently fails while good data is already
  // showing). Falls back to the last successfully-synced snapshot
  // (db.js::saveDashboardSnapshot, written below on every successful load)
  // instead of leaving the dashboard blank.
  const allCoreCallsFailed = [targetsR, logsR, waterR].every((r) => r.status === "rejected");
  let snapshotAge = null;
  if (allCoreCallsFailed && !state.targets) {
    const snapshot = await getDashboardSnapshot();
    if (snapshot) {
      state.targets = snapshot.targets;
      state.logs = snapshot.logs;
      state.water = snapshot.water;
      state.dayState = snapshot.dayState;
      snapshotAge = formatRelativeSnapshotAge(snapshot.savedAt);
    }
  }

  render();
  renderDayHeader();
  if (state.targets) setGreeting(state.targets.display_name);

  if (snapshotAge) {
    showToast(t("toast.showingOfflineSnapshot", { time: snapshotAge }), "default");
  } else {
    const firstFailure = [targetsR, logsR, waterR, savedMealsR].find((r) => r.status === "rejected");
    if (firstFailure) {
      showToast(firstFailure.reason?.message || t("toast.someDataFailed"), "error");
    }
  }

  // Best-effort cache of the latest good state for the offline fallback
  // above — fire-and-forget, never blocks rendering on IndexedDB latency.
  // Only written when the three core calls actually succeeded (a partial
  // load, e.g. savedMeals failing alone, still isn't worth overwriting a
  // previously-complete snapshot with).
  if (targetsR.status === "fulfilled" && logsR.status === "fulfilled" && waterR.status === "fulfilled") {
    saveDashboardSnapshot({
      targets: state.targets,
      logs: todaysLogs(state.logs),
      water: state.water,
      dayState: state.dayState,
      savedAt: Date.now(),
    });
  }
}

// The Saved view's active pill-tab filter — savedMeals.type defaults to
// "meal" client-side too (matches the backend's SavedMealResponse default)
// so a saved item written before the type column existed still lands
// somewhere sensible instead of vanishing from both tabs.
// Sorted by how often each one has actually been logged in the retention
// window (state.logs, matched by name since logs don't carry a saved-meal
// id — a reasonable proxy, not exact per-id counts) rather than insertion
// order, so real favorites surface above whatever was saved first. Ties
// (most commonly "nothing logged from either yet") keep their original
// relative order — Array.prototype.sort is a stable sort — so a saved-meals
// list with no logging history yet looks completely unchanged from before.
function savedMealsForActiveTab() {
  const meals = state.savedMeals.filter((m) => (m.type || "meal") === state.savedMealsTab);
  const frequency = new Map();
  state.logs.forEach((log) => {
    if (log.source !== "saved_meal") return;
    frequency.set(log.food_name, (frequency.get(log.food_name) || 0) + 1);
  });
  return [...meals].sort((a, b) => (frequency.get(b.name) || 0) - (frequency.get(a.name) || 0));
}

// Smart food-name suggestions for the manual-entry and scan-result-review
// name fields (see their shared #food-name-options datalist in index.html) —
// still a plain free-text field, this only offers what's already known to be
// relevant: saved-meal names plus the last 7 days of distinct logged names
// (state.logs is already the full retention window, not just today — see
// todaysLogs() below for the narrower one), merged with any global
// popular-foods suggestions already fetched (see syncPopularFoodOptions in
// the Phase 5 backend section). Capped so a heavy user's datalist doesn't
// balloon to hundreds of entries.
const FOOD_NAME_OPTIONS_LIMIT = 40;
let popularFoodNames = [];

// IndexedDB-backed fallback source (db.js's foodNames store) — hydrated once
// near boot (see the call below) so a cold OFFLINE start still has real
// suggestions before any of the network sources above have ever resolved,
// e.g. a fresh app open with no signal at all. Lowest-priority merge input:
// live sources (saved meals, recent logs, popular foods) always take the
// same-name slot first since Map.set() below is first-occurrence-wins.
let cachedFoodNames = [];
getCachedFoodNames().then((names) => {
  cachedFoodNames = names;
  syncFoodNameOptions();
});

function syncFoodNameOptions() {
  const names = new Map(); // lowercase key -> original casing (first occurrence wins)
  const add = (raw) => {
    const trimmed = (raw || "").trim();
    const key = trimmed.toLowerCase();
    if (key && !names.has(key)) names.set(key, trimmed);
  };
  state.savedMeals.forEach((m) => add(m.name));
  state.logs.forEach((log) => add(log.food_name));
  popularFoodNames.forEach(add);
  cachedFoodNames.forEach(add);

  const allNames = [...names.values()];
  const datalist = el("food-name-options");
  datalist.replaceChildren(
    ...allNames.slice(0, FOOD_NAME_OPTIONS_LIMIT).map((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      return opt;
    }),
  );

  // Fire-and-forget: keeps the offline fallback source above fresh for next
  // time, capped to the same visible set so the cache doesn't grow unbounded
  // with names that would never make the datalist's own limit anyway.
  cacheFoodNames(allNames.slice(0, FOOD_NAME_OPTIONS_LIMIT));
}

function render(highlightId) {
  if (!state.targets) return;
  // First successful render with real data — reveal the dashboard and drop
  // the skeleton shimmer shown until now. Idempotent (setting hidden = true
  // again on every later render is harmless), so no extra "have we already
  // done this" flag is needed.
  el("dashboard-skeleton").hidden = true;
  const logs = todaysLogs(state.logs);
  renderDashboard(state.targets, logs, state.water, highlightId, state.dayState?.ended);
  renderSavedMeals(savedMealsForActiveTab());
  syncFoodNameOptions();
  // Keeps the day-detail sheet (Daily History → tap a past day) in sync with
  // state.logs after any mutation, the same way the dashboard/saved-meals
  // list above already are — no separate refresh path needed for it.
  if (dayDetailDate && !el("day-detail-sheet").hidden) {
    renderDayDetailList(state.logs.filter((l) => l.log_date === dayDetailDate));
  }
  const weekAdherence = computeWeekAdherence();
  setReminderContext({
    waterMl: state.water.total_ml,
    waterTargetMl: state.water.target_ml,
    hasLoggedFoodToday: logs.length > 0,
    weekAdherentDays: weekAdherence.adherentDays,
    weekLoggedDays: weekAdherence.loggedDays,
  });
  setTutorialContext({
    hasExistingData: state.logs.length > 0 || state.savedMeals.length > 0,
    waterLoggedToday: state.water.total_ml > 0,
  });
  const topFood = computeTopFoodToday(logs);
  const todayTotals = computeDailyTotals(logs);
  setAiCoachContext({
    caloriesLeft: (state.targets.daily_calories || 0) - todayTotals.calories,
    targetCalories: state.targets.daily_calories || 0,
    streak: computeSimpleStreak(),
    weekAdherentDays: weekAdherence.adherentDays,
    weekLoggedDays: weekAdherence.loggedDays,
    waterMl: state.water.total_ml,
    waterTargetMl: state.water.target_ml,
    topFoodName: topFood?.food_name || null,
    topFoodCalories: topFood?.calories || 0,
    proteinLeft: (state.targets.daily_protein || 0) - todayTotals.protein,
    proteinTarget: state.targets.daily_protein || 0,
    loggedToday: logs.length > 0,
  });
  setDiscoverContext({
    calories: (state.targets.daily_calories || 0) - todayTotals.calories,
    protein: (state.targets.daily_protein || 0) - todayTotals.protein,
    carbs: (state.targets.daily_carbs || 0) - todayTotals.carbs,
    fats: (state.targets.daily_fats || 0) - todayTotals.fats,
  });
  syncProfileUi(state.targets);
}

// "Thursday, Jul 23" in the header, next to the greeting. No day-number
// prefix anymore — there's no longer a logical "Day N" separate from the
// calendar date (see backend/services/daytime_service.py).
function renderDayHeader() {
  el("greeting-date").textContent = new Date().toLocaleDateString(getLocale(), {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Live midnight rollover — "today" is computed server-side from the user's
// stored timezone (backend/services/daytime_service.py), but a tab left open
// across a real local midnight won't see the new date until something
// re-fetches /day. A 60s interval (cheap: one date-string check, no network
// call unless the browser's own local date changed too) plus a
// visibilitychange listener for the "phone was locked overnight" case catch
// it without waiting on the user to act. This is a heuristic trigger, not
// the source of correctness — log_date/the day-lock are enforced
// server-side regardless of whether this fires.
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
    // Keep showing what we have — todaysLogs() still falls back to the
    // browser's own local date even without a fresh /day response, and the
    // next successful check (interval or focus) will catch up.
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

// Reward-aware log toast: instead of a flat "Logged!" every time, call out
// the moment a log actually pushes today's protein or fiber from under its
// target to at/over it — celebrating the specific action that earned it
// rather than just confirming the save happened, so hitting a macro goal
// feels like progress, not a pass/fail check. Checked in this order
// (protein, then fiber) since only one reward toast should ever show per
// log — whichever crosses first wins, instead of stacking two at once.
// Computed against today's totals *before* this item is added, so it only
// fires on the log that actually crosses the line, not every one after.
function loggedFoodToastMessage(macros) {
  const totals = computeDailyTotals(todaysLogs(state.logs));
  const targets = state.targets || {};

  const proteinTarget = targets.daily_protein || 0;
  if (proteinTarget > 0 && totals.protein < proteinTarget && totals.protein + (macros.protein || 0) >= proteinTarget) {
    fireConfetti(el("bar-protein"));
    return t("toast.proteinGoalReached");
  }

  const fiberTarget = targets.daily_fiber || 0;
  if (fiberTarget > 0 && totals.fiber < fiberTarget && totals.fiber + (macros.fiber || 0) >= fiberTarget) {
    fireConfetti(el("bar-fiber"));
    return t("toast.fiberGoalReached");
  }

  return t("toast.loggedSuccess");
}

async function submitNewLog(payload, { favoriteName, favoriteType } = {}) {
  const tempId = makeTempId();
  // The backend defaults log_date to today when omitted, but the optimistic
  // local copy needs it set explicitly right now — todaysLogs()/the
  // day-detail sheet both filter on log_date, not logged_at, so without this
  // a freshly-added entry wouldn't show up until the real response reconciles.
  const fullPayload = { ...payload, log_date: payload.log_date || state.dayState?.date || localDateStr() };
  insertOptimisticLog({ id: tempId, ...fullPayload, image_url: null, logged_at: new Date().toISOString() });
  vibrate(12);

  const createPromise = api
    .createLog(fullPayload)
    .then((saved) => {
      reconcileLog(tempId, saved);
      return saved;
    })
    .catch((err) => {
      if (isConnectivityError(err)) {
        enqueueWrite({ type: "createLog", payload: fullPayload, tempId });
        setLogPending(tempId, true);
        showToast(t("toast.queuedOffline"), "default");
        updateQueueIndicator();
        return;
      }
      rollbackNewLog(tempId, err.status === 409 ? t("day.loggingLockedToast") : err.message || t("toast.couldNotSaveEntryRemoved"));
    });

  const favoritePromise = favoriteName
    ? api
        .saveMeal({
          name: favoriteName,
          weight_g: payload.weight_g,
          calories: payload.calories,
          protein: payload.protein,
          carbs: payload.carbs,
          fats: payload.fats,
          fiber: payload.fiber,
          ingredients: payload.ingredients || undefined,
          type: favoriteType || "meal",
        })
        .then(() => reloadSavedMeals())
        .catch((err) => showToast(err.message || t("toast.loggedButFavoriteFailed"), "error"))
    : Promise.resolve();

  // `createPromise` resolves to the real saved log (or `undefined` on
  // failure/offline-queue — its own .catch above never re-throws, it handles
  // rollback/queueing itself) — returned here purely so callers that care
  // (scan.js's recent-scans thumbnail linking) can get at the real backend
  // id once it's known; every existing caller that ignores this return value
  // is completely unaffected.
  const [createdLog] = await Promise.all([createPromise, favoritePromise]);
  return createdLog;
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
    fiber: meal.fiber,
    source: "saved_meal",
    log_date: state.dayState?.date || localDateStr(),
    image_url: null,
    logged_at: new Date().toISOString(),
  });
  vibrate(12);
  try {
    const saved = await api.logSavedMeal(meal.id);
    reconcileLog(tempId, saved);
  } catch (err) {
    rollbackNewLog(tempId, err.status === 409 ? t("day.loggingLockedToast") : err.message || t("toast.couldNotLogMealRemoved"));
  }
}

// ---------------------------------------------------------------------------
// Offline write queue — a genuine connectivity failure (err.status ===
// undefined: see api.js's request(), where a network-level throw or a
// client-side timeout never sets .status, only a real HTTP error response
// from the backend does) queues the mutation in IndexedDB instead of rolling
// the optimistic update back, so a log/water entry made offline still shows
// up immediately and is retried automatically once connectivity returns.
// Deliberately scoped to just createLog/addWater — the two mutations someone
// actually reaches for while genuinely offline (mid-workout, gym basement,
// etc.). Editing/deleting/scanning still require a live connection outright
// (a scan needs the Gemini call itself; queuing edits/deletes would need
// their own conflict-resolution against whatever changed server-side in the
// meantime, which isn't worth the complexity for how rarely that's hit
// offline).
// ---------------------------------------------------------------------------
function isConnectivityError(err) {
  return err?.status === undefined;
}

function setLogPending(tempId, pending) {
  state.logs = state.logs.map((l) => (l.id === tempId ? { ...l, _pending: pending } : l));
  render();
}

function setWaterEntryPending(tempId, pending) {
  state.water = {
    ...state.water,
    entries: state.water.entries.map((e) => (e.id === tempId ? { ...e, _pending: pending } : e)),
  };
  render();
}

async function updateQueueIndicator() {
  const count = await countQueuedWrites();
  const banner = el("offline-banner");
  const countEl = el("offline-queue-count");
  if (!banner || !countEl) return;
  if (count > 0) {
    countEl.textContent = t("offline.queuedCount", { count });
    countEl.hidden = false;
    // A non-empty queue stays worth surfacing even if navigator.onLine
    // briefly flips back true before a drain has actually succeeded (e.g. a
    // captive-portal reconnect that isn't really online yet) — keep the
    // banner up until the queue is actually empty, not just until the
    // browser thinks it's online.
    banner.hidden = false;
  } else {
    countEl.hidden = true;
    banner.hidden = navigator.onLine;
  }
}

let drainInProgress = false;

async function drainWriteQueue() {
  if (drainInProgress) return;
  drainInProgress = true;
  try {
    const items = await listQueuedWrites();
    if (items.length > 0) console.log(`[IndexedDB] Draining ${items.length} queued offline write(s)`);
    let syncedCount = 0;
    for (const item of items) {
      try {
        if (item.type === "createLog") {
          const saved = await api.createLog(item.payload);
          await removeQueuedWrite(item.id);
          reconcileLog(item.tempId, saved);
          syncedCount += 1;
        } else if (item.type === "addWater") {
          const saved = await api.addWater(item.payload.amount);
          await removeQueuedWrite(item.id);
          state.water = { ...state.water, entries: state.water.entries.map((e) => (e.id === item.tempId ? saved : e)) };
          render();
          syncedCount += 1;
        } else {
          await removeQueuedWrite(item.id); // unrecognized shape — drop rather than loop on it forever
        }
      } catch (err) {
        if (isConnectivityError(err)) break; // still offline — stop here, the rest retry next time
        // A genuine business-logic rejection on replay (e.g. the day ended in
        // the meantime) — this entry can never succeed as-is, so drop it and
        // roll back the optimistic row instead of retrying it forever.
        await removeQueuedWrite(item.id);
        if (item.type === "createLog") {
          rollbackNewLog(item.tempId, t("toast.couldNotSyncQueuedRemoved"));
        } else if (item.type === "addWater") {
          state.water = { ...state.water, entries: state.water.entries.filter((e) => e.id !== item.tempId) };
          render();
          showToast(t("toast.couldNotSyncQueuedRemoved"), "error");
        }
      }
    }
    if (syncedCount > 0) showToast(t("toast.syncedOfflineChanges", { count: syncedCount }), "success");
  } finally {
    drainInProgress = false;
    updateQueueIndicator();
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
// View Transitions API for tab switching (Dashboard/Progress/Saved) — a
// cross-fade + slight vertical drift between the old and new view instead of
// a hard cut (see the ::view-transition-*(root) rules in style.css for the
// actual animation). Feature-detected (Safari/Firefox don't support this
// yet) and skipped outright under prefers-reduced-motion, in which case this
// just falls back to the exact plain DOM swap that always ran here before —
// never a requirement for the tab switch itself to work.
function switchView(view) {
  const applyViewChange = () => {
    document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    el(`view-${view}`).hidden = false;
    updateNavIndicator();
    // Lazy-loaded, not fetched on every app load — most sessions never open
    // this tab, so there's no point spending a request on it up front.
    if (view === "progress") renderProgress(state.targets, state.logs, state.savedMeals);
    if (view === "discover") onDiscoverTabOpened();
  };

  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    applyViewChange();
    return;
  }
  // A transition can be superseded by a newer one (e.g. a fast double-tap
  // between nav tabs before the first finishes), or skipped if the document
  // becomes hidden mid-transition — both expected, harmless per spec: the
  // UI still ends up in the right state either way. A ViewTransition has
  // THREE independently-rejectable promises (ready/updateCallbackDone/
  // finished), not just one — leaving any of them uncaught surfaces its own
  // spurious "InvalidStateError" exception in the console, so all three
  // need a no-op catch, not just .finished.
  const transition = document.startViewTransition(applyViewChange);
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
  transition.finished.catch(() => {});
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
// Held long enough for the FAB's own flourish (style.css's fab-shockwave/
// fab-icon-flourish/fab-ring-burst, ~0.7s total) to actually be *watched*
// before the sheet's slide-up covers the corner it lives in — previously the
// sheet opened in the same tick as the tap, so the animation was firing
// directly underneath it and was never visible at all. This is deliberately
// long enough to register as "a moment," not just barely long enough to not
// be clipped — the FAB is the single most-used control in the app, so its
// one flourish is allowed to actually be seen. Skipped entirely under
// prefers-reduced-motion, where the CSS side of this (see style.css's global
// override) is already collapsing the animation to ~0s — no reason to hold
// the sheet back from an effect that isn't playing.
const FAB_PRESS_ANIMATION_MS = 260;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let fabPressPending = false;

el("fab-add").addEventListener("click", () => {
  if (fabPressPending) return; // a second tap mid-flourish shouldn't stack another delayed open
  const fab = el("fab-add");
  // Re-triggered by removing then re-adding the class with a forced reflow in
  // between (offsetWidth read), since re-adding an already-present class is a
  // no-op and wouldn't restart the animation on a second rapid tap. Same "one
  // clear moment of feedback" language as the milestone-just-earned pulse
  // elsewhere in this app.
  fab.classList.remove("pulse");
  void fab.offsetWidth;
  fab.classList.add("pulse");
  vibrate(15);
  if (prefersReducedMotion) {
    openSheet("add-sheet");
    return;
  }
  fabPressPending = true;
  setTimeout(() => {
    fabPressPending = false;
    openSheet("add-sheet");
  }, FAB_PRESS_ANIMATION_MS);
});

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

// "+ New"/"+ Add" from the Saved tab creates a saved meal directly — it must
// never log anything to today, regardless of which macro fields are filled
// in (see openManualSheet's creatingSavedMealType handling and the submit
// handler below). Defaults the type to whichever pill (Meals/Products) is
// currently active, so the new item lands in the same "zone" the user was
// actually looking at.
el("new-saved-meal-btn").addEventListener("click", () => openManualSheet(null, null, null, state.savedMealsTab));

// ---------------------------------------------------------------------------
// Manual entry sheet (also reused for editing an existing log, editing an
// existing saved meal, and — via newSavedMealType — creating a brand-new
// saved meal that's never logged to today at all).
// ---------------------------------------------------------------------------
function openManualSheet(existingLog = null, targetDate = null, existingSavedMeal = null, newSavedMealType = null) {
  state.editingLogId = existingLog?.id || null;
  editingSavedMealId = existingSavedMeal?.id || null;
  creatingSavedMealType = existingLog || existingSavedMeal ? null : newSavedMealType;
  const source = existingLog || existingSavedMeal;
  editingLogSnapshot = source;
  const isEditing = Boolean(source);
  // Only meaningful for a brand-new entry — editing an existing log/saved
  // meal never changes which day it belongs to, regardless of what's passed
  // in here.
  manualTargetDate = isEditing ? null : targetDate;
  const isBackdating = Boolean(manualTargetDate);
  el("manual-sheet-title").textContent = existingSavedMeal
    ? t("saved.editTitle")
    : existingLog
      ? t("manual.titleEdit")
      : creatingSavedMealType
        ? t("saved.newSavedTitle")
        : isBackdating
          ? t("manual.titleBackdate", { date: formatShortDate(manualTargetDate) })
          : t("manual.titleNew");
  el("manual-submit-btn").textContent = isEditing
    ? t("manual.submitEdit")
    : creatingSavedMealType
      ? t("saved.saveAction")
      : t("manual.submitNew");
  // Hidden whenever creatingSavedMealType is set: saving as a favorite/
  // template *is* the entire point of this mode already, so a second,
  // redundant "also save as favorite" checkbox would just be confusing (and
  // could never legitimately be unchecked — there'd be nothing left to log).
  el("manual-save-favorite-row").hidden = isEditing || Boolean(creatingSavedMealType);

  // Saved meals use `name`, daily logs use `food_name` — everything else
  // (weight_g/calories/protein/carbs/fats/fiber) is the same shape either
  // way, and is now driven entirely by the ingredients editor below rather
  // than flat fields: a source with its own breakdown is seeded as-is, a
  // source with only aggregate fields (a pre-ingredients-feature log/saved
  // meal) becomes a single implicit ingredient, and a brand-new entry starts
  // from one blank row.
  el("manual-name").value = (existingSavedMeal ? existingSavedMeal.name : existingLog?.food_name) || "";
  manualIngredientsEditor.setIngredients(
    source?.ingredients?.length ? source.ingredients : source ? [asImplicitIngredient(source)] : []
  );
  el("manual-save-favorite").checked = false;
  el("manual-favorite-type").hidden = true;
  resetPillTabs("manual-favorite-type");

  manualDraftModeActive = !isEditing && !creatingSavedMealType;
  if (manualDraftModeActive) restoreManualDraftIfAny();

  openSheet("manual-sheet");
}

const manualIngredientsEditor = createIngredientsEditor({
  listEl: el("manual-ingredients-list"),
  totalsEl: el("manual-ingredients-totals"),
  addBtnEl: el("manual-ingredients-add-btn"),
});

el("manual-save-favorite").addEventListener("change", () => {
  el("manual-favorite-type").hidden = !el("manual-save-favorite").checked;
});
// Delegated: covers the name field and every dynamically added/removed
// ingredient-row input with one listener (see saveManualDraft's own guard —
// a no-op outside the fresh-entry case, so this is harmless while editing).
el("manual-form").addEventListener("input", saveManualDraft);
// Same "clear on deliberate dismissal" reasoning as scan.js's stopAllCameras
// — draft recovery should survive an accidental app-switch/reload, not
// outlive an explicit Cancel or backdrop tap.
el("manual-sheet").querySelectorAll("[data-close='manual-sheet']").forEach((btn) => {
  btn.addEventListener("click", clearManualDraft);
});
el("manual-sheet").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) clearManualDraft(); // backdrop click
});
wirePillTabs("manual-favorite-type");
wirePillTabs("export-lang-tabs");
// The calculator's own live preview reads goal off these pills (see
// readCalculatorInputs), and Settings shows a read-only reflection of the
// same choice (updateSettingsGoalSummary) — both need to react immediately to
// a change here, not just the next time their sheet is opened fresh.
wirePillTabs("goal-type-tabs", () => {
  moveToggleThumb(el("goal-type-tabs"));
  updateSettingsGoalSummary();
  updateCalculatorPreview();
  vibrate(15);
});

el("manual-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    food_name: el("manual-name").value.trim(),
    ...manualIngredientsEditor.getAggregate(),
    ingredients: manualIngredientsEditor.getIngredients(),
  };
  // The backend requires weight_g > 0 (DailyLogCreate/SavedMealCreate) —
  // previously enforced by the flat form's own `required min="1"` weight
  // input, which the per-ingredient editor replaced. Guard it here instead,
  // with a friendly localized message, rather than letting an all-zero
  // ingredient list reach the server and bounce back as a raw validation
  // error after the optimistic UI has already shown (and then has to undo)
  // the entry.
  if (payload.weight_g <= 0) {
    showToast(t("toast.needsWeight"), "error");
    return;
  }
  const submitBtn = el("manual-submit-btn");

  if (editingSavedMealId) {
    const mealId = editingSavedMealId;
    submitBtn.disabled = true;
    submitBtn.textContent = t("manual.submitUpdating");
    try {
      // type is carried over from the snapshot, unchanged — this form
      // doesn't expose a meal/product re-categorize control, only the macro
      // fields (saved_meals uses `name`, not `food_name`, for the label).
      const savedMealPayload = {
        name: payload.food_name,
        weight_g: payload.weight_g,
        calories: payload.calories,
        protein: payload.protein,
        carbs: payload.carbs,
        fats: payload.fats,
        fiber: payload.fiber,
        ingredients: payload.ingredients,
        type: editingLogSnapshot?.type || "meal",
      };
      const updated = await api.updateSavedMeal(mealId, savedMealPayload);
      state.savedMeals = state.savedMeals.map((m) => (m.id === mealId ? updated : m));
      renderSavedMeals(savedMealsForActiveTab());
      showToast(t("toast.updated"), "success");
      closeSheet("manual-sheet");
    } catch (err) {
      showToast(err.message || t("toast.couldNotUpdateEntry"), "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = t("manual.submitEdit");
    }
    return;
  }

  // Creating a brand-new saved meal from the Saved tab's "+ New" button —
  // this must NEVER create a daily_logs row / touch today's calories, only
  // ever a saved_meals row. Reuses saveFavoriteAs() (the same "save an
  // existing log as a favorite" flow) by feeding it this form's payload
  // directly — the two shapes already match exactly.
  if (creatingSavedMealType) {
    const type = creatingSavedMealType;
    submitBtn.disabled = true;
    submitBtn.textContent = t("settings.saving");
    pendingFavoriteLog = payload;
    const succeeded = await saveFavoriteAs(type);
    creatingSavedMealType = null;
    submitBtn.disabled = false;
    submitBtn.textContent = t("saved.saveAction");
    // Only close on success — same as every other form here, a failed save
    // must leave the sheet open with what the user already typed still in
    // it, not silently discard it behind an error toast.
    if (succeeded) closeSheet("manual-sheet");
    return;
  }

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
  const newLogPayload = { ...payload, source: "manual" };
  if (manualTargetDate) newLogPayload.log_date = manualTargetDate;
  showToast(loggedFoodToastMessage(newLogPayload), "success");
  closeSheet("manual-sheet");
  clearManualDraft();
  submitNewLog(newLogPayload, {
    favoriteName: wantsFavorite ? payload.food_name : undefined,
    favoriteType: getActivePillType("manual-favorite-type"),
  });
});

// ---------------------------------------------------------------------------
// Today's log list — edit / delete via event delegation
// ---------------------------------------------------------------------------
el("log-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest(".log-item").dataset.id;
  const log = state.logs.find((l) => l.id === id);

  if (btn.dataset.action === "save-favorite") {
    pendingFavoriteLog = log;
    openSheet("save-favorite-choice-sheet");
  } else if (btn.dataset.action === "edit") {
    openManualSheet(log);
  } else if (btn.dataset.action === "delete") {
    const previousLogs = state.logs;
    await animateItemRemoval("log-list", id);
    vibrate(10);
    deleteWithUndo({
      removeNow: () => {
        state.logs = state.logs.filter((l) => l.id !== id);
        render();
      },
      restore: () => {
        state.logs = previousLogs;
        render();
      },
      callDelete: () => api.deleteLog(id),
      removedToastKey: "toast.removed",
      revertToastKey: "toast.couldNotDeleteEntryRestored",
    });
  }
});

// ---------------------------------------------------------------------------
// Save-favorite choice sheet — the meal/product pick for the log-list
// bookmark action above (pendingFavoriteLog set there), also reused directly
// by the manual-entry sheet's creatingSavedMealType flow. Returns whether it
// actually succeeded so a caller that owns its own sheet/form (like that one)
// can decide whether to close it — never close-on-failure, same as every
// other form in this app: a failed save must leave the form open with the
// user's input intact, not silently discard it behind a toast.
// ---------------------------------------------------------------------------
async function saveFavoriteAs(type) {
  const log = pendingFavoriteLog;
  if (!log) return false;
  closeSheet("save-favorite-choice-sheet");
  try {
    await api.saveMeal({
      name: log.food_name,
      weight_g: log.weight_g,
      calories: log.calories,
      protein: log.protein,
      carbs: log.carbs,
      fats: log.fats,
      fiber: log.fiber,
      ingredients: log.ingredients || undefined,
      type,
    });
    await reloadSavedMeals();
    showToast(t("toast.savedAsFavorite"), "success");
    return true;
  } catch (err) {
    showToast(err.message || t("toast.couldNotSaveFavorite"), "error");
    return false;
  } finally {
    pendingFavoriteLog = null;
  }
}

el("save-favorite-as-meal-btn").addEventListener("click", () => saveFavoriteAs("meal"));
el("save-favorite-as-product-btn").addEventListener("click", () => saveFavoriteAs("product"));

// ---------------------------------------------------------------------------
// Day detail sheet (Daily History → tap a day) — shows that day's individual
// entries; edit/delete work exactly like today's log list above (edits and
// deletes are never date-locked), and "+ Add" opens the manual sheet
// pre-targeted at this date to backdate something the user forgot.
// ---------------------------------------------------------------------------
function openDayDetailSheet(day) {
  dayDetailDate = day.date;
  el("day-detail-title").textContent = formatShortDate(day.date);
  renderDayDetailList(state.logs.filter((l) => l.log_date === day.date));
  openSheet("day-detail-sheet");
}

el("day-detail-add-btn").addEventListener("click", () => {
  if (!dayDetailDate) return;
  openManualSheet(null, dayDetailDate);
});

el("day-detail-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest(".log-item").dataset.id;
  const log = state.logs.find((l) => l.id === id);
  if (!log) return;

  if (btn.dataset.action === "edit") {
    openManualSheet(log);
  } else if (btn.dataset.action === "delete") {
    const previousLogs = state.logs;
    await animateItemRemoval("day-detail-list", id);
    vibrate(10);
    deleteWithUndo({
      removeNow: () => {
        state.logs = state.logs.filter((l) => l.id !== id);
        render();
      },
      restore: () => {
        state.logs = previousLogs;
        render();
      },
      callDelete: () => api.deleteLog(id),
      removedToastKey: "toast.removed",
      revertToastKey: "toast.couldNotDeleteEntryRestored",
    });
  }
});

// ---------------------------------------------------------------------------
// End Day — shows the day's recap, then locks it: POST /day/end sets
// day_ended_date to today (backend/routers/day.py), which blocks *new*
// logging for today (see the 409 responses handled by the existing
// optimistic-insert rollback paths above) until real local midnight passes
// and a new date naturally begins. Nothing is deleted or reset — every log
// made today stays visible, and editing/deleting an existing entry is still
// allowed — this only stops *adding more*.
// ---------------------------------------------------------------------------
el("end-day-btn").addEventListener("click", () => {
  if (!state.targets) return;
  const totals = computeDailyTotals(todaysLogs(state.logs));
  const targets = state.targets;

  el("end-day-calories").textContent = `${Math.round(totals.calories).toLocaleString()} / ${Math.round(targets.daily_calories).toLocaleString()}`;
  el("end-day-protein").textContent = `${Math.round(totals.protein)} / ${Math.round(targets.daily_protein)}g`;
  el("end-day-carbs").textContent = `${Math.round(totals.carbs)} / ${Math.round(targets.daily_carbs)}g`;
  el("end-day-fats").textContent = `${Math.round(totals.fats)} / ${Math.round(targets.daily_fats)}g`;
  el("end-day-fiber").textContent = `${Math.round(totals.fiber)} / ${Math.round(targets.daily_fiber)}g`;
  el("end-day-water").textContent = `${state.water.total_ml.toLocaleString()} / ${state.water.target_ml.toLocaleString()} ml`;

  // Same humanized status logic as the dashboard's own banner (coach.js) —
  // the recap should agree with what they already saw all day, not invent a
  // second opinion.
  const status = getCalorieStatus(totals, targets);
  setStatusBannerTone(
    el("end-day-message-wrap"),
    el("end-day-message-icon"),
    el("end-day-message"),
    status.tone,
    status.icon,
    status.text,
  );

  openSheet("end-day-sheet");
});

el("end-day-done-btn").addEventListener("click", async () => {
  const btn = el("end-day-done-btn");
  btn.disabled = true;
  try {
    // Ending the day changes nothing about today's totals (no boundary jump
    // anymore) — logs/water need no re-fetch, only the ended flag changes,
    // which render() picks up as the locked banner.
    state.dayState = await api.endDay();
    render();
    renderDayHeader();
    closeSheet("end-day-sheet");
    showToast(t("endDay.startedToast"), "success");
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
  renderSavedMeals(savedMealsForActiveTab());
}

// The "Scans" pill shows a completely different data source (local photo
// history, not state.savedMeals) — hide the saved-meals list and its
// "+ New"/"+ Recipe" header actions (neither applies to a scan photo) rather
// than trying to force it through savedMealsForActiveTab()'s type filter,
// which would just silently render an empty list.
wirePillTabs("saved-type-tabs", (type) => {
  state.savedMealsTab = type;
  const onScans = type === "scans";
  el("saved-meals-list").hidden = onScans;
  el("new-saved-meal-btn").hidden = onScans;
  el("new-recipe-btn").hidden = onScans;
  if (onScans) {
    renderScansGrid();
  } else {
    el("scans-grid").hidden = true;
    el("scans-empty").hidden = true;
    renderSavedMeals(savedMealsForActiveTab());
  }
});

el("scans-grid").addEventListener("click", (e) => {
  const card = e.target.closest("[data-log-date]");
  if (!card) return;
  openDayDetailSheet({ date: card.dataset.logDate });
});

el("saved-meals-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest(".log-item").dataset.id;

  if (btn.dataset.action === "log-saved") {
    const meal = state.savedMeals.find((m) => m.id === id);
    if (!meal) return;
    if (meal.servings > 1) {
      // A multi-serving recipe: "Log" means one portion, not the whole
      // stored batch (see the saved.logsOneServing label on this same
      // button) — scaled client-side and logged through the regular
      // optimistic path, same as a manual entry, since the fast
      // POST /meals/{id}/log endpoint always logs the full stored snapshot.
      const oneServing = {
        food_name: meal.name,
        weight_g: roundTo1(meal.weight_g / meal.servings),
        calories: Math.round(meal.calories / meal.servings),
        protein: roundTo1(meal.protein / meal.servings),
        carbs: roundTo1(meal.carbs / meal.servings),
        fats: roundTo1(meal.fats / meal.servings),
        fiber: roundTo1((meal.fiber || 0) / meal.servings),
        source: "saved_meal",
      };
      showToast(loggedFoodToastMessage(oneServing), "success");
      submitNewLog(oneServing);
    } else {
      showToast(loggedFoodToastMessage(meal), "success");
      logSavedMealOptimistic(meal);
    }
  } else if (btn.dataset.action === "edit-saved") {
    const meal = state.savedMeals.find((m) => m.id === id);
    if (meal) openManualSheet(null, null, meal);
  } else if (btn.dataset.action === "delete-saved") {
    const previousSavedMeals = state.savedMeals;
    await animateItemRemoval("saved-meals-list", id);
    vibrate(10);
    deleteWithUndo({
      removeNow: () => {
        state.savedMeals = state.savedMeals.filter((m) => m.id !== id);
        renderSavedMeals(savedMealsForActiveTab());
      },
      restore: () => {
        state.savedMeals = previousSavedMeals;
        renderSavedMeals(savedMealsForActiveTab());
      },
      callDelete: () => api.deleteSavedMeal(id),
      removedToastKey: "toast.removed",
      revertToastKey: "toast.couldNotDeleteMealRestored",
    });
  }
});

// ---------------------------------------------------------------------------
// Recipe builder (Saved meals → "+ Recipe") — combines two or more existing
// saved meals/products into one new saved meal whose macros are the simple
// sum of its ingredients'. Reuses api.saveMeal() exactly as-is: a recipe's
// numbers are just a sum, the backend has no idea (or need to know) how
// they were derived, so this needed zero backend changes.
// ---------------------------------------------------------------------------
let recipeSelectedIds = new Set();

function recipeSelectedMeals() {
  return state.savedMeals.filter((m) => recipeSelectedIds.has(m.id));
}

function computeRecipeTotals(selected) {
  return selected.reduce(
    (acc, m) => ({
      weight_g: acc.weight_g + m.weight_g,
      calories: acc.calories + m.calories,
      protein: acc.protein + m.protein,
      carbs: acc.carbs + m.carbs,
      fats: acc.fats + m.fats,
      fiber: acc.fiber + (m.fiber || 0),
    }),
    { weight_g: 0, calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
  );
}

// Requires 2+ ingredients, not just 1 — combining exactly one saved meal into
// a "new" one would just be a redundant copy of an existing favorite, not a
// recipe.
function updateRecipeState() {
  const selected = recipeSelectedMeals();
  const hasName = el("recipe-name").value.trim().length > 0;
  el("recipe-save-btn").disabled = selected.length < 2 || !hasName;
  el("recipe-preview").hidden = selected.length === 0;
  if (!selected.length) return;

  const totals = computeRecipeTotals(selected);
  el("recipe-preview-calories").textContent = Math.round(totals.calories).toLocaleString();
  el("recipe-preview-protein").textContent = `${Math.round(totals.protein)} g`;
  el("recipe-preview-carbs").textContent = `${Math.round(totals.carbs)} g`;
  el("recipe-preview-fats").textContent = `${Math.round(totals.fats)} g`;

  // "Per serving" is purely informational here — the stored recipe always
  // keeps the whole-batch numbers above as its source of truth (same as
  // every other saved meal); servings only changes how *logging* it behaves
  // later (see app.js's log-saved handler).
  const servings = Math.max(Number(el("recipe-servings").value) || 1, 1);
  el("recipe-preview-per-serving-row").hidden = servings <= 1;
  if (servings > 1) {
    el("recipe-preview-per-serving").textContent = `${Math.round(totals.calories / servings)} kcal`;
  }
}

el("new-recipe-btn").addEventListener("click", () => {
  recipeSelectedIds = new Set();
  el("recipe-name").value = "";
  el("recipe-servings").value = "1";
  renderRecipeIngredientList(state.savedMeals, recipeSelectedIds);
  updateRecipeState();
  openSheet("recipe-sheet");
});

el("recipe-ingredient-list").addEventListener("change", (e) => {
  const checkbox = e.target.closest("input[type='checkbox']");
  if (!checkbox) return;
  if (checkbox.checked) recipeSelectedIds.add(checkbox.dataset.id);
  else recipeSelectedIds.delete(checkbox.dataset.id);
  updateRecipeState();
});

el("recipe-name").addEventListener("input", updateRecipeState);
el("recipe-servings").addEventListener("input", updateRecipeState);

el("recipe-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const selected = recipeSelectedMeals();
  if (selected.length < 2) return;
  const totals = computeRecipeTotals(selected);
  const saveBtn = el("recipe-save-btn");
  saveBtn.disabled = true;
  try {
    await api.saveMeal({
      name: el("recipe-name").value.trim(),
      weight_g: Math.round(totals.weight_g),
      calories: Math.round(totals.calories),
      protein: roundTo1(totals.protein),
      carbs: roundTo1(totals.carbs),
      fats: roundTo1(totals.fats),
      fiber: roundTo1(totals.fiber),
      // Each combined saved meal becomes its own ingredient row on the new
      // recipe, rather than a single opaque aggregate — the breakdown is
      // already known (it's exactly the source meals being combined), so
      // this is free: no extra estimation needed.
      ingredients: selected.map((m) => ({
        food_name: m.name,
        weight_g: m.weight_g,
        calories: m.calories,
        protein: m.protein,
        carbs: m.carbs,
        fats: m.fats,
        fiber: m.fiber || 0,
      })),
      type: "meal",
      servings: Math.max(Number(el("recipe-servings").value) || 1, 1),
    });
    await reloadSavedMeals();
    closeSheet("recipe-sheet");
    showToast(t("recipe.savedToast"), "success");
  } catch (err) {
    showToast(err.message || t("recipe.couldNotSave"), "error");
  } finally {
    saveBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------
const MAX_WATER_ENTRY_ML = 5000; // matches WaterLogCreate's amount_ml le=5000 in backend/models.py
const MAX_DAILY_WATER_ML = 10000; // matches MAX_DAILY_WATER_ML in backend/routers/water.py

function addWaterOptimistic(amount) {
  if (state.water.total_ml + amount > MAX_DAILY_WATER_ML) {
    playWaterOverflowFeedback();
    showToast(t("toast.waterLimitReached", { max: MAX_DAILY_WATER_ML / 1000 }), "error");
    vibrate(12);
    return;
  }

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
      if (isConnectivityError(err)) {
        enqueueWrite({ type: "addWater", payload: { amount }, tempId });
        setWaterEntryPending(tempId, true);
        showToast(t("toast.queuedOffline"), "default");
        updateQueueIndicator();
        return;
      }
      state.water = previousWater;
      render();
      // Backend 409s here are either "day ended" or the daily water cap (the
      // client already pre-checks the cap above, so reaching it server-side
      // only happens on a genuine race, e.g. another tab). Both have a
      // friendly, localized message already — state.dayState is what
      // disambiguates them, since the raw backend detail text is English-only.
      if (err.status === 409) {
        showToast(
          state.dayState?.ended ? t("day.loggingLockedToast") : t("toast.waterLimitReached", { max: MAX_DAILY_WATER_ML / 1000 }),
          "error",
        );
      } else {
        showToast(err.message || t("toast.couldNotLogWaterReverted"), "error");
      }
    });
}

el("water-add-btn").addEventListener("click", () => addWaterOptimistic(250));

el("water-quick-amounts").addEventListener("click", (e) => {
  const btn = e.target.closest(".quick-amount-btn");
  if (!btn) return;
  addWaterOptimistic(Number(btn.dataset.amount));
});

// ---------------------------------------------------------------------------
// Tap-to-expand macro rows — tapping a macro row's top area (protein/carbs/
// fats/fiber) reveals which of today's logged foods actually drove that
// number, instead of that breakdown only being visible in the Progress tab's
// "What's driving your calories" card. Each row's detail list is toggled
// independently and (re)populated fresh from state.logs every time it opens,
// so it can never show stale data from before the day's latest log.
// ---------------------------------------------------------------------------
function renderMacroRowDetail(macro) {
  const list = el(`${macro}-detail`);
  const items = computeMacroContributions(todaysLogs(state.logs), macro);
  if (!items.length) {
    list.innerHTML = `<li class="macro-row-detail-empty">${t("dashboard.macroDetailEmpty")}</li>`;
    return;
  }
  list.innerHTML = items
    .slice(0, 6)
    .map(
      (item) => `
      <li class="macro-row-detail-item">
        <span class="macro-row-detail-name">${escapeHtml(item.name)}</span>
        <span class="macro-row-detail-value mono">${Math.round(item.value)}g · ${Math.round(item.pct)}%</span>
      </li>
    `,
    )
    .join("");
}

document.querySelectorAll(".macro-row-top").forEach((top) => {
  const macro = top.closest(".macro-row").dataset.macro;
  const detail = el(`${macro}-detail`);
  const toggle = () => {
    const opening = detail.hidden;
    if (opening) renderMacroRowDetail(macro);
    detail.hidden = !opening;
    top.setAttribute("aria-expanded", String(opening));
  };
  top.addEventListener("click", toggle);
  top.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
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

// Retriggers a one-shot CSS animation class on `el` (forced-reflow trick —
// removing then re-adding the same class in one tick wouldn't otherwise
// restart it) and, critically, removes the class again once every animation
// it triggered (including on ::before/::after pseudo-elements, via
// getAnimations({subtree:true})) has actually finished playing.
//
// That removal is the fix for a real bug: every one-shot water effect below
// used to leave its trigger class sitting on the element forever after the
// animation played once. CSS animations don't just "stay finished" when their
// element is later removed from the render tree (e.g. switchView() hiding
// #view-dashboard via the `hidden` attribute, i.e. display:none) — they reset
// and replay from 0% the next time that element re-enters the tree. So
// switching to Progress/Saved and back to Dashboard was silently replaying
// whatever water animation had last fired (bump/splash/droplet, or even the
// overflow spill), reading exactly like "the app thinks I just added water"
// even though nothing happened. Stripping the class back off once its
// animation genuinely completes means there's nothing left for a later
// display:none/block cycle to replay.
//
// getAnimations() (not a fixed setTimeout) is deliberate: it stays correct
// automatically no matter how the CSS durations above are tuned, and it
// naturally respects the prefers-reduced-motion override (near-zero
// durations still resolve `finished` quickly, so cleanup still happens).
// The per-element generation counter guards against a rapid second trigger
// on the same element racing the first trigger's cleanup and stripping the
// class out from under it.
// FALLBACK_CLEANUP_MS comfortably covers the longest animation chain any
// caller below actually uses (the overflow/pour puddle-land sequence tops
// out around 1.3s) — only ever used on a browser old enough to lack
// getAnimations(), as a safety net so the class still can't get stuck.
const FALLBACK_CLEANUP_MS = 1500;

function playOneShot(target, className) {
  const gen = (target._animGen = (target._animGen || 0) + 1);
  target.classList.remove(className);
  void target.offsetWidth;
  target.classList.add(className);

  if (typeof target.getAnimations !== "function") {
    setTimeout(() => {
      if (target._animGen === gen) target.classList.remove(className);
    }, FALLBACK_CLEANUP_MS);
    return;
  }

  // getAnimations() only reflects animations the browser has actually
  // created for the current style, which happens during the rendering
  // pipeline's own "update animations" step — NOT synchronously the instant
  // classList.add() returns. Querying on this same tick reliably found
  // nothing yet (an empty list), which would've skipped scheduling any
  // cleanup at all and reintroduced the exact bug this helper exists to fix.
  // Deferring one animation frame guarantees the animation(s) already exist
  // by the time we ask for them.
  requestAnimationFrame(() => {
    if (target._animGen !== gen) return; // superseded by a newer trigger before this frame ran
    let animations = [];
    try {
      // {subtree:true} is needed for callers like the splash-crown, whose
      // 6 fling droplets are real child elements, not just this element's
      // own ::before/::after — a very old engine that throws on the options
      // object falls back to the plain setTimeout net below instead of
      // leaving the class stuck forever.
      animations = target.getAnimations({ subtree: true });
    } catch {
      setTimeout(() => {
        if (target._animGen === gen) target.classList.remove(className);
      }, FALLBACK_CLEANUP_MS);
      return;
    }
    if (!animations.length) {
      // Nothing (still) running — either prefers-reduced-motion collapsed
      // the whole animation to ~0.01ms and it already finished within this
      // one frame, or nothing ever animated for this class at all. Either
      // way it's safe (and necessary) to strip the class right now rather
      // than leaving it stuck with no `finished` promise left to await.
      target.classList.remove(className);
      return;
    }
    Promise.all(animations.map((a) => a.finished.catch(() => {}))).then(() => {
      if (target._animGen === gen) target.classList.remove(className);
    });
  });
}

// Briefly overrides the wave layers' idle drift (see .water-wave in
// style.css) with a bigger, faster wobble right as a drop lands, then lets
// the idle animation resume once it's done — the "surface actually gets
// disturbed by the drop" cue, not just a droplet appearing and the water
// level silently ticking up. `strong` is used for the over-target/pour
// case, where the disturbance should read as more significant.
function disturbWaveSurface(strong) {
  const activeClass = strong ? "disturbed-strong" : "disturbed";
  const waveBack = el("water-wave-back");
  const waveFront = el("water-wave-front");
  waveBack.classList.remove("disturbed", "disturbed-strong");
  waveFront.classList.remove("disturbed", "disturbed-strong");
  playOneShot(waveBack, activeClass);
  playOneShot(waveFront, activeClass);
}

// Re-triggers the capsule "bump", splash-ripple, splash-crown, and
// droplet-fall CSS animations even on back-to-back clicks, and always
// cleans each one back up afterward via playOneShot() above.
function playWaterFeedback() {
  playOneShot(el("water-capsule"), "bump");
  playOneShot(el("water-splash"), "pulse");
  playOneShot(el("water-splash-crown"), "burst");
  playOneShot(el("water-droplet"), "drop");

  // On top of the normal fill feedback above: every add that lands over the
  // user's own daily target (not the hard cap — see MAX_DAILY_WATER_ML
  // below) also plays a "pouring over the rim" burst (see .pour in
  // style.css, which also drives the floor-puddle marks), repeating on each
  // add past target alongside the steady glow .at-target already applies
  // (toggled in ui.js's renderDashboard) — and gets the *strong* surface
  // disturbance instead of the normal one.
  const overTarget = state.water.total_ml > state.water.target_ml;
  disturbWaveSurface(overTarget);
  const visual = el("water-visual");
  visual.classList.remove("overflow"); // in case a hard-cap shake from a rapid prior tap is still finishing
  if (overTarget) playOneShot(visual, "pour");
}

// Plays instead of playWaterFeedback() above when an add would exceed the
// daily cap — a distinct "spilling over" animation (see .overflow in
// style.css) rather than the normal bump/splash/droplet fill feedback, so
// hitting the limit reads as a clear, deliberate stop rather than a silent
// no-op.
function playWaterOverflowFeedback() {
  const visual = el("water-visual");
  visual.classList.remove("pour"); // in case a target-crossed pour burst from a rapid prior tap is still finishing
  playOneShot(visual, "overflow");
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
  vibrate(10);
  deleteWithUndo({
    removeNow: () => {
      state.water = {
        ...state.water,
        total_ml: Math.max(state.water.total_ml - entry.amount_ml, 0),
        entries: state.water.entries.filter((w) => w.id !== id),
      };
      render();
    },
    restore: () => {
      state.water = previousWater;
      render();
    },
    callDelete: () => api.deleteWaterEntry(id),
    removedToastKey: "toast.removed",
    revertToastKey: "toast.couldNotDeleteEntryRestored",
  });
});

// ---------------------------------------------------------------------------
// Settings / targets
// ---------------------------------------------------------------------------
// Keeps every avatar <img> in the app (header + Settings profile card) and
// the profile card's name/email text in sync with state.targets — called
// from render() on every mutation, and again below right before the
// Settings sheet opens (covers the rare case it's opened before this
// session's first render() has run at all, e.g. targets just fetched fresh
// in the fallback branch below).
function syncProfileUi(targets) {
  if (!targets) return;
  const src = resolveAvatarUrl({ avatar_url: targets.avatar_url, email: targets.email, display_name: targets.display_name });
  el("header-avatar-img").src = src;
  el("profile-avatar-img").src = src;
  el("profile-name-display").textContent = targets.display_name || t("settings.noNameSet");
  el("profile-email-display").textContent = targets.email || "";
  el("profile-avatar-remove-btn").hidden = !targets.avatar_url;
}

async function openSettingsSheet() {
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
  el("target-display-name").value = state.targets.display_name || "";
  el("target-calories").value = state.targets.daily_calories;
  el("target-protein").value = state.targets.daily_protein;
  el("target-carbs").value = state.targets.daily_carbs;
  el("target-fats").value = state.targets.daily_fats;
  el("target-fiber").value = state.targets.daily_fiber;
  el("target-water").value = state.targets.daily_water_ml;
  el("target-auto-balance-toggle").checked = isAutoBalanceEnabled();
  el("ring-pace-toggle").checked = isRingPaceEnabled();
  el("settings-timezone-note").textContent = t("settings.timezoneNote", { tz: state.targets.timezone || "UTC" });
  syncProfileUi(state.targets);
  updateLangButtons();
  resetPillTabs("export-lang-tabs", getLanguage());
  resetPillTabs("goal-type-tabs", state.targets.goal_type || "maintain");
  updateSettingsGoalSummary();
  openSheet("settings-sheet");
  // The toggle thumbs above are positioned from real measured button
  // geometry (moveToggleThumb) — while the sheet still carries [hidden],
  // every button reports 0 for offsetWidth/offsetLeft, so re-measuring only
  // makes sense once openSheet has actually made it visible. #goal-type-tabs
  // itself now lives in the calculator sheet, not this one — its thumb is
  // re-measured when that sheet actually opens instead (open-calculator-btn's
  // own handler below), for the exact same reason.
  moveToggleThumb(el("lang-switcher-buttons"));
  moveToggleThumb(el("theme-switcher-buttons"));
}

// The gear icon is the ONLY entry point into Settings now — the header
// avatar used to open the identical sheet too, which read as a confusing
// second/duplicate settings button rather than a helpful shortcut (the two
// controls looked unrelated at a glance, so finding Settings via the avatar
// felt like an accident rather than a designed shortcut). The avatar is now
// a pure identity glance (see its plain <div>, not <button>, in index.html).
el("settings-btn").addEventListener("click", openSettingsSheet);

// ---------------------------------------------------------------------------
// Profile photo — upload applies immediately (its own PUT /targets call),
// not gated behind the "Daily targets" form's Save button below: a photo
// change is its own action, same instant-apply convention as the
// Language/Theme toggles elsewhere in this sheet.
// ---------------------------------------------------------------------------
// The backend requires the daily_* target fields on every PUT /targets
// (only display_name/avatar_url/daily_fiber/goal_type are optional/
// defaulted — see backend/models.py's TargetsUpdate), so an avatar-only
// change still has to resend the rest of the currently-known targets
// alongside it. Shared by both handlers below instead of duplicated twice.
function currentTargetsPayload() {
  return {
    daily_calories: state.targets.daily_calories,
    daily_protein: state.targets.daily_protein,
    daily_carbs: state.targets.daily_carbs,
    daily_fats: state.targets.daily_fats,
    daily_fiber: state.targets.daily_fiber,
    daily_water_ml: state.targets.daily_water_ml,
    goal_type: state.targets.goal_type,
  };
}

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
      display_name: el("target-display-name").value.trim(),
      daily_calories: Number(el("target-calories").value),
      daily_protein: Number(el("target-protein").value),
      daily_carbs: Number(el("target-carbs").value),
      daily_fats: Number(el("target-fats").value),
      daily_fiber: Number(el("target-fiber").value),
      daily_water_ml: Number(el("target-water").value),
      goal_type: getActivePillType("goal-type-tabs", "maintain"),
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

function updateSettingsGoalSummary() {
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

function updateCalculatorPreview() {
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
  const targets = calculateTargets(readCalculatorInputs());
  el("target-calories").value = targets.calories;
  el("target-protein").value = targets.protein;
  el("target-carbs").value = targets.carbs;
  el("target-fats").value = targets.fats;
  closeSheet("calculator-sheet");
  showToast(t("calculator.appliedToast"), "success");
});

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

const AUTO_BALANCE_FIELD_IDS = new Set(["target-protein", "target-carbs", "target-fats"]);
el("settings-form").addEventListener("input", (e) => {
  if (isAutoBalanceEnabled() && AUTO_BALANCE_FIELD_IDS.has(e.target.id)) recalculateCaloriesFromMacros();
});

// ---------------------------------------------------------------------------
// Shared by both segmented controls below: slides each group's own
// .pref-toggle-thumb behind whichever button is currently .active, using its
// real measured position/width (offsetLeft/offsetWidth) rather than a
// percentage guess — buttons are natural-width (icon + label), not equal
// fractions of the track, so only a real measurement lines the pill up
// exactly. Applied via direct style property assignment, never baked into an
// HTML string, per this app's CSP (no 'unsafe-inline' for style-src) — same
// pattern as every other dynamically-sized bar/ring in this app. `--thumb-rgb`
// is set from the active button's own data-thumb-var (e.g. --c-carbs-rgb for
// Light) so each choice's pill picks up a distinct color; buttons with no
// data-thumb-var (Language) leave it unset and the CSS's own fallback
// (var(--c-water-rgb)) applies instead.
function moveToggleThumb(containerEl) {
  const thumb = containerEl.querySelector(".pref-toggle-thumb");
  const active = containerEl.querySelector(".pref-toggle-btn.active");
  if (!thumb || !active) return;
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.transform = `translateX(${active.offsetLeft}px)`;
  if (active.dataset.thumbVar) {
    thumb.style.setProperty("--thumb-rgb", `var(${active.dataset.thumbVar})`);
  } else {
    thumb.style.removeProperty("--thumb-rgb");
  }
}

// Re-measures both toggles on resize (button widths can change if the sheet
// itself resizes, e.g. rotating the device) — cheap, so no debounce needed.
window.addEventListener("resize", () => {
  moveToggleThumb(el("lang-switcher-buttons"));
  moveToggleThumb(el("theme-switcher-buttons"));
});

// ---------------------------------------------------------------------------
// Language switcher (settings sheet) — English/Romanian only, by design.
// ---------------------------------------------------------------------------
function updateLangButtons() {
  // Scoped to this one switcher's own buttons — the theme switcher below
  // reuses the same .pref-toggle-btn class for identical styling, and its
  // buttons carry no data-lang at all, so a bare ".pref-toggle-btn" query
  // here would otherwise also visit (and incorrectly de-activate) the theme
  // buttons.
  el("lang-switcher-buttons").querySelectorAll(".pref-toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === getLanguage());
  });
  moveToggleThumb(el("lang-switcher-buttons"));
}

el("lang-switcher-buttons").addEventListener("click", (e) => {
  const btn = e.target.closest(".pref-toggle-btn");
  if (!btn || btn.dataset.lang === getLanguage()) return;
  setLanguage(btn.dataset.lang);
  updateLangButtons();
  vibrate(15);
});

// ---------------------------------------------------------------------------
// Theme switcher (settings sheet) — System / Light / Dark, persisted the
// same way the language choice is (localStorage), independent of it.
// "System" means "no explicit override" — removing data-theme entirely lets
// the CSS's own @media (prefers-color-scheme) decide, so it also stays live
// if the OS theme changes later without the user ever touching this toggle.
//
// Dark, not System, is the default for anyone who has never touched this
// toggle at all (no key in localStorage yet) — most users here prefer it,
// and it's what the app should look like on first open rather than
// following the OS. This is distinct from a user who has explicitly tapped
// "System" themselves: that choice is stored as the literal string
// "system" (see the click handler below) and is respected exactly as
// before — only the untouched/first-run case changes.
// ---------------------------------------------------------------------------
const THEME_STORAGE_KEY = "ironlog_theme";
const THEME_COLOR_DARK = "#0a0c10";
const THEME_COLOR_LIGHT = "#f3f5fa";
const THEME_COLOR_AMOLED = "#000000";

function getStoredTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "amoled" || stored === "system") return stored;
  return "dark";
}

// "system" is the only choice that isn't a literal theme name — it resolves
// to whichever the OS prefers, and only ever between light/dark (there's no
// "prefers AMOLED" media feature), same as before amoled existed.
function resolvedTheme(choice) {
  if (choice === "light" || choice === "dark" || choice === "amoled") return choice;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function updateThemeColorMeta(choice) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const resolved = resolvedTheme(choice);
  meta.setAttribute("content", resolved === "light" ? THEME_COLOR_LIGHT : resolved === "amoled" ? THEME_COLOR_AMOLED : THEME_COLOR_DARK);
}

function applyTheme(choice) {
  if (choice === "light" || choice === "dark" || choice === "amoled") {
    document.documentElement.dataset.theme = choice;
  } else {
    delete document.documentElement.dataset.theme;
  }
  updateThemeColorMeta(choice);
}

function updateThemeButtons() {
  el("theme-switcher-buttons").querySelectorAll(".pref-toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeChoice === getStoredTheme());
  });
  moveToggleThumb(el("theme-switcher-buttons"));
}

applyTheme(getStoredTheme());
updateThemeButtons();

el("theme-switcher-buttons").addEventListener("click", (e) => {
  const btn = e.target.closest(".pref-toggle-btn");
  if (!btn) return;
  const choice = btn.dataset.themeChoice;
  if (choice === getStoredTheme()) return;
  localStorage.setItem(THEME_STORAGE_KEY, choice);
  applyTheme(choice);
  updateThemeButtons();
  vibrate(15);
});

// Keeps the status-bar/chrome color correct if the OS theme changes while
// the user is on "System" — a no-op (resolvedTheme reads the same choice)
// whenever an explicit Light/Dark override is active.
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (getStoredTheme() === "system") updateThemeColorMeta("system");
});

// Static labels (data-i18n) are handled by setLanguage() itself; anything
// computed from live app state needs its own resync here so a language
// switch never leaves stale English/Romanian text sitting next to freshly
// translated labels.
onLanguageChange(() => {
  setGreeting(state.targets?.display_name);
  renderDayHeader();
  render();
  el("manual-sheet-title").textContent = editingSavedMealId
    ? t("saved.editTitle")
    : state.editingLogId
      ? t("manual.titleEdit")
      : manualTargetDate
        ? t("manual.titleBackdate", { date: formatShortDate(manualTargetDate) })
        : t("manual.titleNew");
  el("manual-submit-btn").textContent =
    state.editingLogId || editingSavedMealId ? t("manual.submitEdit") : t("manual.submitNew");
  if (state.targets) el("settings-timezone-note").textContent = t("settings.timezoneNote", { tz: state.targets.timezone || "UTC" });
  // The Theme and Goal button labels are themselves translated ("System" /
  // "Sistem", "Bulk" / "Masă", ...), and even the Language row's own label
  // ("Language" / "Limbă") changes width — every one of those changes how
  // much room .pref-toggle-buttons has to divide up, which means all three
  // sliding thumbs were sized/positioned for the *previous* language's
  // layout the moment this fires. Left uncorrected, a thumb would sit
  // wherever the old layout put it — visibly off-center, sometimes even
  // overflowing past the button it's supposed to be exactly covering — until
  // the user tapped a button in that group again and force-refreshed it.
  // Resyncing all three here, every time, means the language switch itself
  // is what keeps them honest instead of relying on an unrelated future
  // click to paper over it.
  moveToggleThumb(el("lang-switcher-buttons"));
  moveToggleThumb(el("theme-switcher-buttons"));
  moveToggleThumb(el("goal-type-tabs"));
  // Same reasoning as the three thumbs just above, for the bottom nav's own
  // sliding indicator: "Progress"/"Progres" etc. aren't the same width in
  // both languages, so the active tab's button geometry changes the instant
  // the label swaps — left uncorrected, the indicator stays sized/positioned
  // for the previous language's label (visibly off / not fully covering the
  // new, wider-or-narrower button) until the next tab tap forces a recompute.
  updateNavIndicator();
});

el("logout-btn").addEventListener("click", async () => {
  closeSheet("settings-sheet");
  await logOut();
});

// ---------------------------------------------------------------------------
// PWA install prompt — Chrome/Edge/Android support the real programmatic
// prompt (captured here and replayed on button click); Safari/iOS has no such
// API at all, so that path just shows the manual "Add to Home Screen" steps.
// Hidden entirely once already running standalone (installed), on either
// platform, since there's nothing left to offer at that point.
// ---------------------------------------------------------------------------
let deferredInstallPrompt = null;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function updateInstallUi() {
  const section = el("install-app-section");
  section.hidden = isStandalone() ? true : !(deferredInstallPrompt || isIOS());
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // stop Chrome's own mini-infobar; we drive the prompt from our own button instead
  deferredInstallPrompt = e;
  updateInstallUi();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  updateInstallUi();
  showToast(t("install.installedToast"), "success");
});

el("install-app-btn").addEventListener("click", async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice; // one-shot — Chrome invalidates the event either way
    deferredInstallPrompt = null;
    updateInstallUi();
    return;
  }
  if (isIOS()) showToast(t("install.iosInstructions"), "default");
});

updateInstallUi(); // covers desktop/Android browsers that never fire beforeinstallprompt (already installed, unsupported, etc.)

// ---------------------------------------------------------------------------
// Data export — a PDF (replacing the previous CSV) of whatever's still in
// the retained window (or a shorter slice of it), plus the user's full
// measurement history (not subject to that retention window — see
// sql/schema.sql's table comment). Client-side file generation only, via
// jsPDF + jspdf-autotable (SRI-pinned CDN scripts — see index.html); no
// backend endpoint needed beyond the list endpoints that already exist.
//
// Laid out as several distinct, independently-headed tables (one autoTable()
// call per section) rather than one merged table with a `type` column and
// mostly-empty cells depending on that type — every column in a given
// section is actually relevant, instead of blank weight_g/amount_ml/
// weight_kg cells on every row. The trailing Daily Summary section is one
// rolled-up row per calendar day (food totals + fiber + water), since "what
// did I average this week" is the thing this export mostly gets used to
// answer, and every input for it is already in hand from the same fetch
// below. Food/water rows use each entry's own `log_date` (the tz-aware,
// server-computed date — see backend/services/daytime_service.py) rather
// than re-deriving a date from `logged_at` in the browser's local time,
// which could disagree on a borrowed/shared device.
//
// The export has its OWN language toggle (English/Română, next to the range
// picker in Settings), independent of the app's own display language — so a
// report can be generated in either language regardless of what the UI is
// currently showing. Every string below is looked up from PDF_STRINGS by
// that choice, not from i18n.js's t().
//
// Font: jsPDF's built-in standard fonts (Helvetica etc.) only cover the
// WinAnsi/Latin-1 codepage, which is missing Romanian's comma-below
// diacritics (ș/ț) entirely and ă too — those render as blank space with the
// default font, not a fallback glyph. registerPdfFonts() embeds a small,
// hand-subsetted Noto Sans (frontend/js/pdfFonts.js, OFL-licensed) that
// covers the full range this export can ever need, and every doc.text()/
// autoTable() call below explicitly uses it.
// ---------------------------------------------------------------------------
const PDF_FONT = "NotoSans";

function registerPdfFonts(doc) {
  // addFont/addFileToVFS calls are per-jsPDF-instance state, not global —
  // every new export creates a fresh doc, so this always runs. The
  // (small, already-in-memory) base64 constants themselves are only ever
  // parsed once by the module system regardless of how many exports run.
  doc.addFileToVFS("NotoSans-Regular.ttf", NOTO_SANS_REGULAR_B64);
  doc.addFont("NotoSans-Regular.ttf", PDF_FONT, "normal");
  doc.addFileToVFS("NotoSans-Bold.ttf", NOTO_SANS_BOLD_B64);
  doc.addFont("NotoSans-Bold.ttf", PDF_FONT, "bold");
  doc.setFont(PDF_FONT, "normal");
}

const PDF_MONTHS = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  // Standard Romanian month abbreviations (DEX-style, lowercase) — dates
  // read like "21 iul. 2026", matching how Romanian normally abbreviates
  // months (with a trailing period), rather than reusing the English forms.
  ro: ["ian.", "feb.", "mar.", "apr.", "mai", "iun.", "iul.", "aug.", "sep.", "oct.", "noi.", "dec."],
};

// Deliberately NOT toLocaleDateString: that formats month-vs-day order by
// locale convention (en-US gives "Jul 21, 2026", month first), and the ask
// here is a single explicit order — day, abbreviated month, year — regardless
// of language, e.g. "21 Jul 2026" / "21 iul. 2026".
function formatPdfDate(dateStr, lang) {
  const d = dateStr.length === 10 ? new Date(`${dateStr}T00:00:00`) : new Date(dateStr);
  return `${d.getDate()} ${PDF_MONTHS[lang][d.getMonth()]} ${d.getFullYear()}`;
}

function formatTimeOfDay(isoString) {
  const d = new Date(isoString);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Weight/measurements aren't part of the log_date/day-lock system at all
// (see sql/schema.sql's weight_logs comment) — they only ever have
// logged_at, so this is the one place export still derives a date from it.
function formatCalendarDate(isoString) {
  return localDateStr(new Date(isoString));
}

function buildDailySummaryRows(logs, water) {
  const byDate = new Map();
  const dayFor = (dateStr) => {
    if (!byDate.has(dateStr)) {
      byDate.set(dateStr, { date: dateStr, calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0, water_ml: 0 });
    }
    return byDate.get(dateStr);
  };
  logs.forEach((l) => {
    const day = dayFor(l.log_date);
    day.calories += l.calories;
    day.protein += l.protein;
    day.carbs += l.carbs;
    day.fats += l.fats;
    day.fiber += l.fiber || 0;
  });
  water.forEach((w) => {
    dayFor(w.log_date).water_ml += w.amount_ml;
  });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Every piece of export copy, keyed by the export's own language toggle —
// not i18n.js's t(), which reflects the app's display language instead.
const PDF_STRINGS = {
  en: {
    subtitle: "Data export",
    generated: "Generated",
    range2: "Last 2 days",
    range3: "Last 3 days",
    range7: "Whole week",
    overview: (days, entries) => `${days}-day report · ${entries} food ${entries === 1 ? "entry" : "entries"} logged`,
    page: (i, n) => `Page ${i} of ${n}`,
    source: { ai: "AI", manual: "Manual", saved_meal: "Saved meal" },
    reportSummary: {
      title: "Report Summary",
      avgCalories: "Avg. Calories",
      avgProtein: "Avg. Protein",
      totalWater: "Water Logged",
      weightChange: "Weight Change",
      workoutsLogged: "Workouts",
      daysActive: "Active Days",
      noData: "No data",
      setsLabel: "sets",
    },
    sections: {
      food: { title: "Food Log", head: ["Date", "Time", "Food", "Weight (g)", "Calories", "Protein (g)", "Carbs (g)", "Fats (g)", "Fiber (g)", "Source"] },
      summary: { title: "Daily Summary", head: ["Date", "Calories", "Protein (g)", "Carbs (g)", "Fats (g)", "Fiber (g)", "Water (ml)"] },
      weight: { title: "Body Weight", head: ["Date", "Weight (kg)"] },
      measurements: { title: "Body Measurements", head: ["Date", "Time", "Measurement", "Value", "Unit"] },
      workouts: { title: "Training Log", head: ["Date", "Time", "Exercise", "Sets", "Reps", "Weight (kg)"] },
    },
  },
  ro: {
    subtitle: "Export de date",
    generated: "Generat",
    range2: "Ultimele 2 zile",
    range3: "Ultimele 3 zile",
    range7: "Toată săptămâna",
    overview: (days, entries) => `Raport pe ${days} zile · ${entries} ${entries === 1 ? "aliment înregistrat" : "alimente înregistrate"}`,
    page: (i, n) => `Pagina ${i} din ${n}`,
    source: { ai: "AI", manual: "Manual", saved_meal: "Masă salvată" },
    reportSummary: {
      title: "Rezumatul raportului",
      avgCalories: "Media calorii",
      avgProtein: "Media proteine",
      totalWater: "Apă înregistrată",
      weightChange: "Schimbare greutate",
      workoutsLogged: "Antrenamente",
      daysActive: "Zile active",
      noData: "Fără date",
      setsLabel: "seturi",
    },
    sections: {
      food: { title: "Jurnal alimentar", head: ["Data", "Ora", "Aliment", "Greutate (g)", "Calorii", "Proteine (g)", "Carbohidrați (g)", "Grăsimi (g)", "Fibre (g)", "Sursă"] },
      summary: { title: "Rezumat zilnic", head: ["Data", "Calorii", "Proteine (g)", "Carbohidrați (g)", "Grăsimi (g)", "Fibre (g)", "Apă (ml)"] },
      weight: { title: "Greutate corporală", head: ["Data", "Greutate (kg)"] },
      measurements: { title: "Măsurători corporale", head: ["Data", "Ora", "Măsurătoare", "Valoare", "Unitate"] },
      workouts: { title: "Jurnal de antrenament", head: ["Data", "Ora", "Exercițiu", "Seturi", "Repetări", "Greutate (kg)"] },
    },
  },
};

// One color per section, reused from the app's own chart/macro color
// language (see css/style.css's --c-* variables) for visual consistency with
// the rest of the app — not emoji: the standard PDF fonts jsPDF draws text
// with have no emoji glyph coverage, so those would render as blank boxes
// rather than icons. Instead, each section gets a colored circular badge
// with a small hand-drawn vector icon (drawIcon below) using jsPDF's own
// line/circle/triangle/rect primitives — no font/emoji risk, no image asset,
// nothing to embed.
const EXPORT_SECTION_COLORS = {
  food: [255, 107, 74], // --c-calories
  // No "water" entry: water no longer gets its own raw per-entry section
  // (see downloadExportPdf/buildExportPdf) — its per-day totals live inside
  // the "summary" section's own Water (ml) column instead.
  summary: [255, 194, 75], // --c-carbs
  weight: [51, 214, 166], // --c-protein
  measurements: [140, 158, 255], // --c-fats
  workouts: [139, 195, 74], // --c-fiber
};

// Every icon is drawn in white, centered at (cx, cy), sized to sit
// comfortably inside the badge circle (BADGE_RADIUS below) with a clear
// margin on every side. Verified by actually rendering each one and
// zooming in — the workouts "dumbbell" specifically went through two
// iterations because the first pass (thick bar, small plates) just read as
// a rounded pill, not two weights joined by a bar.
function drawIcon(doc, colorKey, cx, cy) {
  doc.setDrawColor(255, 255, 255);
  doc.setFillColor(255, 255, 255);
  const s = 1.9;
  switch (colorKey) {
    case "food": {
      // A simple fork: three tines merging into one handle line.
      doc.setLineWidth(0.45);
      [-0.85, 0, 0.85].forEach((dx) => doc.line(cx + dx, cy - s, cx + dx, cy + s * 0.15));
      doc.line(cx - 0.85, cy + s * 0.15, cx + 0.85, cy + s * 0.15);
      doc.line(cx, cy + s * 0.15, cx, cy + s);
      break;
    }
    case "summary": {
      // A tiny bar chart: three bars of increasing height.
      doc.rect(cx - s * 0.95, cy + s * 0.15, s * 0.5, s * 0.65, "F");
      doc.rect(cx - s * 0.2, cy - s * 0.45, s * 0.5, s * 1.25, "F");
      doc.rect(cx + s * 0.55, cy - s * 0.95, s * 0.5, s * 1.75, "F");
      break;
    }
    case "weight": {
      // An upward trend arrow.
      doc.setLineWidth(0.55);
      doc.line(cx - s, cy + s * 0.8, cx + s * 0.9, cy - s * 0.7);
      doc.line(cx + s * 0.9, cy - s * 0.7, cx + s * 0.15, cy - s * 0.7);
      doc.line(cx + s * 0.9, cy - s * 0.7, cx + s * 0.9, cy + s * 0.05);
      break;
    }
    case "measurements": {
      // A ruler: an outlined rectangle with a few tick marks.
      doc.setLineWidth(0.4);
      doc.rect(cx - s, cy - s * 0.55, s * 2, s * 1.1, "S");
      [-0.62, -0.2, 0.22, 0.64].forEach((dx) => doc.line(cx + dx * s, cy - s * 0.55, cx + dx * s, cy - s * 0.05));
      break;
    }
    case "workouts": {
      // A dumbbell: two filled circles (plates) joined by a thin bar.
      doc.setLineWidth(0.5);
      doc.line(cx - s * 0.55, cy, cx + s * 0.55, cy);
      doc.circle(cx - s * 0.95, cy, s * 0.58, "F");
      doc.circle(cx + s * 0.95, cy, s * 0.58, "F");
      break;
    }
  }
}

const BADGE_RADIUS = 3.4;

function drawSectionChip(doc, title, colorKey, y) {
  const [r, g, b] = EXPORT_SECTION_COLORS[colorKey];
  const cx = 14 + BADGE_RADIUS;
  const cy = y - 2.6;
  doc.setFillColor(r, g, b);
  doc.circle(cx, cy, BADGE_RADIUS, "F");
  drawIcon(doc, colorKey, cx, cy);
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(12);
  doc.setTextColor(25, 25, 25);
  doc.text(title, 14 + BADGE_RADIUS * 2 + 4, y);
}

// Room a section's chip + heading + table header row + a few body rows
// actually needs. If less than this is left on the current page, the whole
// section starts fresh on a new page instead — this is what used to be able
// to strand a section's title alone at the bottom of a page with its table
// (autoTable does its own page-break math independently of the chip/heading
// drawn just above it) reflowing to the top of the next one.
const MIN_SECTION_SPACE_MM = 40;

// Draws one section's chip + heading + table, returning the y position the
// next section should start at. Skips sections with nothing to show (no
// empty "Food Log" table taking up space when the export range has no food
// logged, for instance) rather than rendering a header over a blank table.
function addExportSection(doc, { title, colorKey, head, rows, y }) {
  if (!rows.length) return y;
  const pageHeight = doc.internal.pageSize.getHeight();
  if (pageHeight - y < MIN_SECTION_SPACE_MM) {
    doc.addPage();
    y = 20;
  }
  drawSectionChip(doc, title, colorKey, y);
  doc.autoTable({
    startY: y + 4,
    head: [head],
    body: rows,
    theme: "striped",
    styles: { font: PDF_FONT, fontSize: 9, cellPadding: 3, textColor: [40, 40, 40] },
    headStyles: { font: PDF_FONT, fillColor: EXPORT_SECTION_COLORS[colorKey], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [246, 247, 250] },
    margin: { left: 14, right: 14, top: 20 },
    // Explicit, not just relying on autoTable's default: a long section
    // (e.g. a week of food logs) that spans multiple pages repeats its own
    // column header at the top of each continuation page, so no page ever
    // shows orphaned data rows with no header in sight above them.
    showHead: "everyPage",
    // autoTable's default ("auto") can still split an individual row right
    // at a page boundary when its tallest cell wraps to a second line (e.g.
    // a "26 Jul\n2026" date, or a long food/meal name) — the row's other
    // cells render on the earlier page while that one wrapped line spills
    // alone onto the next, with nothing else beside it (verified by
    // rendering a real multi-page export and inspecting the page break).
    // "avoid" keeps a wrapped row's lines together and moves the whole row
    // to the next page instead.
    rowPageBreak: "avoid",
  });
  return doc.lastAutoTable.finalY + 14;
}

// A plain stack of tables reads as a raw data dump, not a report — this is
// the "at a glance" card that turns it into one. Every stat here is derived
// entirely from data the export already fetched (see downloadExportPdf), so
// this adds zero extra network requests. Averages are computed over active
// days only (days with at least one food/water entry — dailySummaryRows is
// already exactly that set), same "average of days that actually happened"
// definition progress.js's own avg-calories stat uses, not an average over
// the whole calendar window including untouched days.
function computeReportStats(dailySummaryRows, water, weight, workouts, targetCalories) {
  const activeDays = dailySummaryRows.length;
  const avgCalories = activeDays ? dailySummaryRows.reduce((s, d) => s + d.calories, 0) / activeDays : 0;
  const avgProtein = activeDays ? dailySummaryRows.reduce((s, d) => s + d.protein, 0) / activeDays : 0;
  const totalWaterMl = water.reduce((s, w) => s + w.amount_ml, 0);
  // weight is fetched newest-first (backend/routers/weight.py's own
  // ordering) — sort chronologically first so "change" means latest minus
  // earliest in the window, not whatever order the rows happened to arrive.
  let weightChange = null;
  if (weight.length >= 2) {
    const sorted = [...weight].sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at));
    weightChange = sorted[sorted.length - 1].weight_kg - sorted[0].weight_kg;
  }
  const totalSets = workouts.reduce((s, w) => s + w.sets, 0);
  return { activeDays, avgCalories, avgProtein, totalWaterMl, weightChange, workoutsCount: workouts.length, totalSets, targetCalories };
}

// Tall enough for title + 2 rows of label/value pairs with real bottom
// padding — the previous 30mm put the second row's bold value baseline at
// y+31, 1mm *past* the card's own bottom edge (y+30), which is what actually
// rendered as text spilling out below the card (verified by rendering and
// measuring, not just eyeballing — see the row math in drawSummaryCard).
const SUMMARY_CARD_HEIGHT = 38;

function drawSummaryCard(doc, stats, S, y) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const cardX = 14;
  const cardW = pageWidth - 28;
  doc.setFillColor(247, 248, 250);
  doc.setDrawColor(230, 232, 236);
  doc.setLineWidth(0.3);
  doc.roundedRect(cardX, y, cardW, SUMMARY_CARD_HEIGHT, 3, 3, "FD");

  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(10.5);
  doc.setTextColor(25, 25, 25);
  doc.text(S.reportSummary.title, cardX + 8, y + 9);

  // 3 columns x 2 rows of small label/value stat pairs. Row 1's value
  // baseline (y+33.5) now sits a clear 4.5mm above the card's bottom edge
  // (y+38), instead of past it.
  const stat = (label, value, colIndex, rowIndex) => {
    const colW = (cardW - 16) / 3;
    const x = cardX + 8 + colIndex * colW;
    const rowY = y + 17 + rowIndex * 11;
    doc.setFont(PDF_FONT, "normal");
    doc.setFontSize(7.6);
    doc.setTextColor(120, 126, 138);
    doc.text(label, x, rowY);
    doc.setFont(PDF_FONT, "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(30, 32, 38);
    doc.text(value, x, rowY + 5.5);
  };

  const calValue = stats.targetCalories
    ? `${Math.round(stats.avgCalories).toLocaleString()} / ${Math.round(stats.targetCalories).toLocaleString()}`
    : `${Math.round(stats.avgCalories).toLocaleString()}`;
  const weightValue =
    stats.weightChange === null
      ? S.reportSummary.noData
      : `${stats.weightChange > 0 ? "+" : ""}${stats.weightChange.toFixed(1)} kg`;

  stat(S.reportSummary.avgCalories, calValue, 0, 0);
  stat(S.reportSummary.avgProtein, `${Math.round(stats.avgProtein)} g`, 1, 0);
  stat(S.reportSummary.totalWater, `${(stats.totalWaterMl / 1000).toFixed(1)} L`, 2, 0);
  stat(S.reportSummary.weightChange, weightValue, 0, 1);
  stat(S.reportSummary.workoutsLogged, `${stats.workoutsCount} · ${stats.totalSets} ${S.reportSummary.setsLabel}`, 1, 1);
  stat(S.reportSummary.daysActive, `${stats.activeDays}`, 2, 1);

  return y + SUMMARY_CARD_HEIGHT + 12;
}

function buildExportPdf(logs, water, weight, measurements, workouts, days, lang, targets) {
  const S = PDF_STRINGS[lang];
  const rangeLabel = { 2: S.range2, 3: S.range3, 7: S.range7 }[days] || S.range7;

  const { jsPDF } = window.jspdf;
  // Landscape, not portrait: the Food Log section alone has 10 columns
  // (Date/Time/Food/Weight/Calories/Protein/Carbs/Fats/Fiber/Source), and
  // Romanian's longer header words (Carbohidrați, Greutate) push portrait's
  // ~182mm usable width past the point where autoTable can lay out every
  // column on one line — headers AND data cells (dates, times) started
  // wrapping mid-word/mid-value, verified by actually rendering both language
  // variants. Landscape's ~269mm usable width fits every column on a single
  // line in both languages, which is what makes this read as a clean report
  // instead of a cramped spreadsheet screenshot.
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
  registerPdfFonts(doc);
  const pageWidth = doc.internal.pageSize.getWidth();

  // A little taller than the original single-line-of-context band, to fit a
  // third line summarizing the report at a glance (day count + entries
  // logged) — a plain stack of tables with no cover context read as raw data
  // dump rather than a report, so this gives the export an actual headline.
  const HEADER_HEIGHT = 34;
  doc.setFillColor(20, 22, 28);
  doc.rect(0, 0, pageWidth, HEADER_HEIGHT, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(18);
  doc.text("Iron Log", 14, 14);
  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(9);
  const generatedNow = new Date().toISOString();
  doc.text(`${S.generated} ${formatPdfDate(generatedNow, lang)}, ${formatTimeOfDay(generatedNow)}`, pageWidth - 14, 14, { align: "right" });

  doc.setFontSize(11);
  doc.text(`${S.subtitle} — ${rangeLabel}`, 14, 22);

  const dailySummaryRows = buildDailySummaryRows(logs, water);
  doc.setFontSize(9);
  doc.setTextColor(185, 190, 202);
  doc.text(S.overview(days, logs.length), 14, 28.5);

  let y = HEADER_HEIGHT + 12;

  // A stack of tables with no cover context reads as a raw data dump rather
  // than a report — this card gives it an actual "here's what matters"
  // headline before diving into row-level detail. Entirely derived from data
  // already fetched for this export (see downloadExportPdf) — zero extra
  // requests.
  const stats = computeReportStats(dailySummaryRows, water, weight, workouts, targets?.daily_calories);
  y = drawSummaryCard(doc, stats, S, y);

  y = addExportSection(doc, {
    ...S.sections.food,
    colorKey: "food",
    rows: logs.map((l) => [
      formatPdfDate(l.log_date, lang),
      formatTimeOfDay(l.logged_at),
      l.food_name,
      Math.round(l.weight_g),
      Math.round(l.calories),
      l.protein,
      l.carbs,
      l.fats,
      l.fiber || 0,
      S.source[l.source] || l.source,
    ]),
    y,
  });

  // Water is deliberately NOT a separate raw per-entry section here — for a
  // 7-day export that could mean dozens of individual "+250ml" rows, which
  // ate a disproportionate amount of report space for the least useful level
  // of detail. A per-day total (the "Water (ml)" column below) plus the
  // report-wide total in the summary card above already cover what anyone
  // reviewing this export actually wants to know.
  //
  // Wraps up the nutrition side (Food Log above) before moving on to
  // body/training data below — one rolled-up row per calendar day.
  y = addExportSection(doc, {
    ...S.sections.summary,
    colorKey: "summary",
    rows: dailySummaryRows.map((day) => [
      formatPdfDate(day.date, lang),
      Math.round(day.calories),
      Math.round(day.protein),
      Math.round(day.carbs),
      Math.round(day.fats),
      Math.round(day.fiber),
      day.water_ml,
    ]),
    y,
  });

  y = addExportSection(doc, {
    ...S.sections.weight,
    colorKey: "weight",
    rows: weight.map((w) => [formatPdfDate(formatCalendarDate(w.logged_at), lang), w.weight_kg]),
    y,
  });

  // Always the full history, unlike Food Log/Water/Daily Summary above:
  // measurements aren't part of the 7-day retention window (see
  // sql/schema.sql), so filtering them down to the same short range would
  // hide most of a user's actual measurement history for no reason.
  y = addExportSection(doc, {
    ...S.sections.measurements,
    colorKey: "measurements",
    rows: measurements.map((m) => [
      formatPdfDate(formatCalendarDate(m.logged_at), lang),
      formatTimeOfDay(m.logged_at),
      m.name,
      m.value,
      m.unit,
    ]),
    y,
  });

  // Same "always full history" reasoning as measurements above — training
  // history is also kept indefinitely (see sql/schema.sql's workout_logs
  // comment), capped server-side at MAX_WORKOUT_ROWS rather than day-ranged.
  addExportSection(doc, {
    ...S.sections.workouts,
    colorKey: "workouts",
    rows: workouts.map((w) => [
      formatPdfDate(formatCalendarDate(w.logged_at), lang),
      formatTimeOfDay(w.logged_at),
      w.exercise_name,
      w.sets,
      w.reps,
      w.weight_kg,
    ]),
    y,
  });

  const pageCount = doc.internal.getNumberOfPages();
  const pageHeight = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    // A thin rule + the brand name on the left turns a bare page number into
    // something that reads as a finished, designed document footer instead
    // of an afterthought stamped in the corner.
    doc.setDrawColor(225, 227, 232);
    doc.setLineWidth(0.2);
    doc.line(14, pageHeight - 13, pageWidth - 14, pageHeight - 13);
    doc.setFont(PDF_FONT, "normal");
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text("Iron Log", 14, pageHeight - 8);
    doc.text(S.page(i, pageCount), pageWidth - 14, pageHeight - 8, { align: "right" });
  }

  return doc;
}

function downloadExportPdf(logs, water, weight, measurements, workouts, days, lang, targets) {
  const doc = buildExportPdf(logs, water, weight, measurements, workouts, days, lang, targets);
  doc.save(`iron-log-export-${localDateStr()}.pdf`);
}

el("export-btn").addEventListener("click", async () => {
  const days = Number(el("export-range").value);
  const lang = getActivePillType("export-lang-tabs") === "ro" ? "ro" : "en";
  const btn = el("export-btn");
  btn.disabled = true;
  try {
    const [logs, water, weight, measurements, workouts] = await Promise.all([
      api.listLogs(days),
      api.listWaterHistory(days),
      api.listWeight(days),
      api.listMeasurements(),
      api.listWorkouts(),
    ]);
    downloadExportPdf(logs, water, weight, measurements, workouts, days, lang, state.targets);
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
initScan({ logNewFood: submitNewLog, getLoggedToastMessage: loggedFoodToastMessage });
initTutorial();
initProgress({ onDayClick: openDayDetailSheet, onLogSuggestedMeal: logSavedMealOptimistic });
initReminders();
initAiCoach();
initCoachChat();
initDiscover({ onDataChanged: loadAll });
initSheetDragToDismiss();
initCollapsibleListToggles([["log-list", "log-list-toggle"]]);
initPullToRefresh("view-dashboard", loadAll);

// ---------------------------------------------------------------------------
// Offline banner — a persistent connectivity indicator (see the HTML comment
// above #offline-banner). navigator.onLine can false-positive as "online" on
// some captive-portal setups, but it's still the right primary signal here:
// it's instant and free, and going online is exactly when a drain attempt is
// worth making. updateQueueIndicator() (called from drainWriteQueue's
// `finally`, and once here at boot) is what actually owns the banner's
// visibility once a queue exists — see its own comment for why a non-empty
// queue keeps the banner up even past a premature "online" flip.
// ---------------------------------------------------------------------------
function updateOfflineBanner() {
  el("offline-banner").hidden = navigator.onLine;
  if (navigator.onLine) drainWriteQueue();
}
window.addEventListener("online", updateOfflineBanner);
window.addEventListener("offline", updateOfflineBanner);
updateOfflineBanner();
updateQueueIndicator();

// Safety net for the rare case a real 'online' event never fires even though
// connectivity is back (some mobile OS/browser combinations are unreliable
// about it) — a queue is otherwise silently stuck until the user's next
// online action happens to succeed. Cheap enough to poll: countQueuedWrites()
// is a single IndexedDB read, and drainWriteQueue() itself no-ops instantly
// whenever the queue is already empty.
setInterval(() => {
  if (navigator.onLine) drainWriteQueue();
}, 30000);

initAuth({
  onSignedIn: () => {
    // Checked BEFORE closeAllSheets() below, since that call itself would
    // otherwise look identical to a real dismissal — see scan.js's
    // wasScanSheetOpenBeforeReload() docs for why a `hidden` flip alone can't
    // tell "the user closed it" apart from "the sheet was just never
    // reopened yet on this fresh boot".
    const reopenScanSheet = wasScanSheetOpenBeforeReload();
    closeAllSheets(); // guard against a sheet left open by a previous session
    switchView("dashboard");
    loadAll();
    maybeAutoStartTutorial();
    // Catches a queue left over from a previous offline session immediately
    // on sign-in, rather than waiting for the next 'online' event or the
    // 30s safety-net poll (see below) to notice it.
    if (navigator.onLine) drainWriteQueue();
    else updateQueueIndicator();
    // The "WhatsApp bug" fix: an installed PWA getting memory-discarded and
    // reloaded while the AI scan sheet was open (see scan.js's DRAFT_KEY
    // comment for the full mechanism) used to leave the user back on a plain
    // dashboard with no indication anything was in progress. Restoring it
    // here — rather than silently losing that context — is what makes the
    // sheet "remain fully intact and visible" across that kind of interruption,
    // not just across a normal open/close.
    if (reopenScanSheet) {
      openScanSheetFresh();
      openSheet("scan-sheet");
      showToast(t("scan.restoredInProgress"), "default");
    }
    // Fire-and-forget: a non-critical suggestion source for the food-name
    // datalist (syncFoodNameOptions), not worth blocking or slowing the
    // critical dashboard load in loadAll() above for, and fine to just skip
    // silently if it fails (autocomplete still works from saved meals/recent
    // logs alone).
    api
      .getPopularFoods()
      .then((res) => {
        popularFoodNames = res.names || [];
        syncFoodNameOptions();
      })
      .catch(() => {});
  },
  onSignedOut: () => {
    state = {
      targets: null,
      logs: [],
      water: { total_ml: 0, target_ml: 3000, entries: [] },
      savedMeals: [],
      savedMealsTab: "meal",
      dayState: null,
      editingLogId: null,
    };
    manualTargetDate = null;
    dayDetailDate = null;
    editingSavedMealId = null;
    closeAllSheets(); // nothing should render on top of the login screen
    clearScanDraft(); // don't let a stale "reopen the scan sheet" flag survive into the next sign-in
    switchView("dashboard");
  },
});
