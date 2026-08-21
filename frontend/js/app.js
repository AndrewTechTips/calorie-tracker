import { api, warmBackend } from "./api.js?v=20260821g";
import { initAuth, logOut } from "./auth.js?v=20260821g";
import {
  clearDraft as clearScanDraft,
  getScanThumbnailUrl,
  initScan,
  openScanSheetFresh,
  refreshThumbnailCache,
  replaceScanThumbnail,
  setDayLockContext as setScanDayLockContext,
  wasScanSheetOpenBeforeReload,
} from "./scan.js?v=20260821g";
import { initProgress, renderProgress, syncLiveTotals } from "./progress.js?v=20260821g";
import { initWorkoutDiary } from "./workoutDiary.js?v=20260821g";
import { initAnalytics, renderAnalyticsInsights, setContext as setAnalyticsContext } from "./analytics.js?v=20260821g";
import { initNotifications } from "./notifications.js?v=20260821g";
import { setContext as setAiCoachContext } from "./aiCoach.js?v=20260821g";
import { initCoachChat } from "./coachChat.js?v=20260821g";
import { initDamageControl, maybeTriggerDamageControl } from "./damageControl.js?v=20260821g";
import { renderAIUsage } from "./aiUsage.js?v=20260821g";
import { initFastingTimer } from "./fastingTimer.js?v=20260821g";
import {
  initMealSuggester,
  openMealSuggesterSheet,
  setContext as setMealSuggesterContext,
  setDayLocked as setMealSuggesterDayLocked,
} from "./mealSuggester.js?v=20260821g";
import { initDiscover, onDiscoverTabOpened, setDiscoverContext } from "./discover.js?v=20260821g";
import { setSuggestionsContext } from "./suggestions.js?v=20260821g";
import { initTutorial, maybeAutoStartTutorial, setTutorialContext } from "./tutorial.js?v=20260821g";
import { initScrollProgress } from "./scrollProgress.js?v=20260821g";
import {
  animateItemRemoval,
  closeAllSheets,
  closeSheet,
  computeDailyTotals,
  computeMacroContributions,
  deleteWithUndo,
  escapeHtml,
  fadeOutSkeleton,
  formatFileSize,
  getActivePillType,
  initNumericInputGuards,
  initPullToRefresh,
  initSheetDragToDismiss,
  isRingPaceEnabled,
  isTabSwipeActive,
  journalPeriodOf,
  openSheet,
  renderDashboard,
  renderDayDetailList,
  renderDayDetailTotals,
  renderDaySavedPickerList,
  renderJournal,
  renderPdfArchive,
  renderRecipeIngredientList,
  renderSavedMeals,
  resetPillTabs,
  setGreeting,
  setRingPaceEnabled,
  setStatusBannerTone,
  setTabSwipeActive,
  showToast,
  vibrate,
  wirePillTabs,
} from "./ui.js?v=20260821g";
import { getLanguage, getLocale, initI18n, onLanguageChange, setLanguage, t } from "./i18n.js?v=20260821g";
import { getCalorieStatus } from "./coach.js?v=20260821g";
import { calculateTargets, roundTo1 } from "./nutritionMath.js?v=20260821g";
import { asImplicitIngredient, createIngredientsEditor } from "./ingredientsList.js?v=20260821g";
import {
  cacheFoodNames,
  countQueuedWrites,
  deleteRecentScanByLogId,
  enqueueWrite,
  getCachedFoodNames,
  getDashboardSnapshot,
  listQueuedWrites,
  removeQueuedWrite,
  saveDashboardSnapshot,
} from "./db.js?v=20260821g";
import { fireConfetti } from "./confetti.js?v=20260821g";
import { fileToAvatarDataUrl, isImageFile, resolveAvatarUrl } from "./avatar.js?v=20260821g";
import { getLastUpdated as getLegalLastUpdated, getLegalDoc, renderLegalSectionsHtml } from "./legalContent.js?v=20260821g";
import { initPhotoStore, purgeStalePhotos, removeHeroPhoto } from "./photoStore.js?v=20260821g";
import { initPhotoLightbox, openPhotoLightbox } from "./photoLightbox.js?v=20260821g";
import {
  archivePdfReport,
  deleteArchivedReport,
  getArchivedReportFile,
  getArchiveUsageSummary,
  initPdfArchiveStore,
  listArchivedReports,
} from "./pdfArchiveStore.js?v=20260821g";

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
  // A deliberate dismissal (Cancel/backdrop) of manual-sheet also abandons
  // any photo a Smart Tools detour captured but never got applied (see
  // pendingSmartToolPhoto's own comment) — otherwise a stale file reference
  // from an edit the user gave up on could wrongly attach itself to
  // whichever unrelated log/saved meal is edited and saved next.
  pendingSmartToolPhoto = null;
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

// Feeds the AI Coach's dashboard context (setAiCoachContext below) —
// deliberately reuses state.logs (already the full retention window, not
// just today) instead of a separate GET /trends call. The weekly-recap PUSH
// notification used to read this too (frontend/js/reminders.js, before it
// was rewritten into js/notifications.js) — that computation now lives
// server-side in backend/services/notification_service.py::compute_week_adherence,
// a deliberate line-for-line port of the logic below, so a background recap
// and this dashboard always agree. 10% tolerance matches
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

  // See PENDING_LOG_DELETES_KEY's own comment (above deleteJournalEntry) —
  // finishes off any delete a previous session's undo-window timer never got
  // to fire before the page went away. Awaited before the batch below so the
  // GET /logs it triggers already reflects the finished delete(s), instead
  // of this load's own render() briefly resurrecting them for one frame.
  await flushPendingLogDeletes();

  // Promise.allSettled (not .all): one flaky endpoint must not discard the
  // others that succeeded. Previously any single rejection (e.g. a slow
  // /water/today) meant targets/logs/savedMeals were thrown away too, leaving
  // state.targets permanently null — which is exactly what made the settings
  // button look "frozen" (its click handler no-ops while targets is null).
  // refreshThumbnailCache and purgeStalePhotos are both IndexedDB/OPFS-only
  // (no network), so they cost nothing extra here — by the time render()
  // runs below, Today's Journal's photo lookups already have real data
  // instead of falling back to placeholders for one frame and
  // self-correcting later via onThumbnailsUpdated. purgeStalePhotos is
  // internally guarded to do real work at most once per page load (see its
  // own comment), so calling it on every loadAll() (pull-to-refresh etc.),
  // not just the first boot, is still cheap.
  const [targetsR, logsR, waterR, savedMealsR, dayStateR] = await Promise.allSettled([
    api.getTargets(),
    api.listLogs(),
    api.getTodayWater(),
    api.listSavedMeals(),
    api.getDayState(),
    refreshThumbnailCache(),
    purgeStalePhotos(),
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

  // Fire-and-forget, not awaited — warms Progress's own data (trends/weight/
  // measurements/workouts) right here at boot, the same moment
  // targets/logs/water/savedMeals above load for Dashboard/Saved, instead of
  // waiting for the user to actually open or swipe to that tab for the
  // first time. Before this, Progress was the one tab that could still show
  // its skeleton-then-pop-in on a swipe even on an otherwise-instant, already-
  // warm session — jarring specifically because every OTHER tab is already
  // sitting there fully rendered by the time the user can react. By the time
  // a human actually navigates away from the dashboard they just landed on,
  // this has almost always long since resolved.
  renderProgress(state.targets, state.logs, state.savedMeals, { silent: true });
  // Same boot-time warm-up as renderProgress above — a passive card fetched
  // fresh every time (see analytics.js's own comment), never gated behind a
  // Progress-tab visit so it's already sitting there rendered by the time a
  // user actually navigates to it.
  renderAnalyticsInsights();
  // Discover gets the same boot-time warm-up now, for the same reason —
  // only its baseline (unfiltered) recipe grid + the remaining-macros
  // recommended strip, i.e. exactly what onDiscoverTabOpened() already
  // lazy-loads on first visit; a filtered/searched query still only ever
  // starts once the user actually types/taps one. This runs after
  // setDiscoverContext() above (inside render()), so remainingMacros is
  // already real by this point, not the pre-any-data null it'd be if this
  // ran earlier. onDiscoverTabOpened()'s own DOM-mutating renders route
  // through runOrDeferDuringSwipe (ui.js) same as always; here, at boot,
  // there's no swipe in progress so they just apply immediately — to a
  // still-`hidden` view, same as Progress's warm-up above.
  onDiscoverTabOpened();

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

// Same frequency-sort as savedMealsForActiveTab above, minus the Meals/
// Products tab filter — the day-detail "From Saved" picker (see
// openDaySavedPickerSheet below) isn't tied to whichever pill the main Saved
// tab happens to be on, so it offers every saved meal/product in one list.
function allSavedMealsSorted() {
  const frequency = new Map();
  state.logs.forEach((log) => {
    if (log.source !== "saved_meal") return;
    frequency.set(log.food_name, (frequency.get(log.food_name) || 0) + 1);
  });
  return [...state.savedMeals].sort((a, b) => (frequency.get(b.name) || 0) - (frequency.get(a.name) || 0));
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
  // the skeleton shimmer shown until now (a brief fade, not an instant cut —
  // see fadeOutSkeleton's own comment in ui.js). Idempotent (safe to call
  // again on every later render), so no extra "have we already done this"
  // flag is needed.
  fadeOutSkeleton("dashboard-skeleton");
  const logs = todaysLogs(state.logs);
  renderDashboard(state.targets, logs, state.water, highlightId, state.dayState?.ended);
  // Any card left revealed by an in-progress swipe (see initJournalSwipe)
  // can't survive reconcileList rebuilding every card's innerHTML below —
  // its class would just be silently dropped, leaving the tracked reference
  // stale. Closing it explicitly here, on every render regardless of what
  // triggered it, is simpler than trying to preserve a mid-gesture visual
  // state across an unrelated data refresh.
  journalRevealedCard = null;
  renderJournal(journalEntriesFor(logs), highlightId, getScanThumbnailUrl);
  renderSavedMeals(savedMealsForActiveTab());
  syncFoodNameOptions();
  // Keeps the day-detail sheet (Daily History → tap a past day) in sync with
  // state.logs after any mutation, the same way the dashboard/saved-meals
  // list above already are — no separate refresh path needed for it.
  if (dayDetailDate && !el("day-detail-sheet").hidden) {
    const dayLogs = state.logs.filter((l) => l.log_date === dayDetailDate);
    renderDayDetailList(dayLogs, highlightId);
    renderDayDetailTotals(dayLogs);
  }
  // Keeps Progress's own Daily History rollup (and everything derived from
  // it there — the calorie chart, macro consistency, streak, milestones) in
  // sync with every mutation here too, not just today's dashboard/day-detail
  // list above — see progress.js's syncLiveTotals for why this used to only
  // catch up on the next full Progress-tab visit.
  syncLiveTotals(state.logs);
  const weekAdherence = computeWeekAdherence();
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
  const remainingMacros = {
    calories: (state.targets.daily_calories || 0) - todayTotals.calories,
    protein: (state.targets.daily_protein || 0) - todayTotals.protein,
    carbs: (state.targets.daily_carbs || 0) - todayTotals.carbs,
    fats: (state.targets.daily_fats || 0) - todayTotals.fats,
  };
  setDiscoverContext(remainingMacros);
  // Pushed on every render (not just on a Progress-tab visit) — see
  // suggestions.js's own module docstring for why sourcing this from
  // already-live state.logs, right here where every other reactive surface
  // (AI Coach, Discover, Meal Suggester) already gets fed, replaced the old
  // network-fetch-driven path that made the Suggestions card go stale.
  setSuggestionsContext({ remaining: remainingMacros, savedMeals: state.savedMeals });
  setMealSuggesterContext({
    remainingCalories: (state.targets.daily_calories || 0) - todayTotals.calories,
    remainingProtein: (state.targets.daily_protein || 0) - todayTotals.protein,
    remainingCarbs: (state.targets.daily_carbs || 0) - todayTotals.carbs,
    remainingFats: (state.targets.daily_fats || 0) - todayTotals.fats,
  });
  syncProfileUi(state.targets);
  // Pushed on every render so scan.js/mealSuggester.js's own internal
  // day-lock guards (see their own comments) can never see a stale value —
  // same "fed by app.js, no direct state access" pattern as every other
  // setXContext call above.
  setScanDayLockContext(state.dayState);
  setMealSuggesterDayLocked(state.dayState?.ended);
  syncEndDayButton();
}

// Keeps the header's End day / Reopen day button in sync with
// state.dayState?.ended on every render — a plain `hidden` toggle on two
// permanent DOM buttons in the same flex slot, not a re-render of any kind,
// so it can never lag behind or diverge from whatever the rest of render()
// just drew (see the "Absolute Isolation" requirement this was built
// against: toggling the day's lock must never leave the button and the
// status banner disagreeing). Safe to call on every render regardless of
// what triggered it — the `hidden` check below is what makes it a no-op
// (and skips the pop-in replay) on the vast majority of calls where the day
// state hasn't actually changed.
function syncEndDayButton() {
  const ended = !!state.dayState?.ended;
  const showEl = el(ended ? "reopen-day-btn" : "end-day-btn");
  const hideEl = el(ended ? "end-day-btn" : "reopen-day-btn");
  hideEl.hidden = true;
  hideEl.classList.remove("pop-in");
  if (showEl.hidden) {
    showEl.hidden = false;
    // Force a reflow so re-adding the class restarts the animation even if
    // it was already applied and removed earlier in the same session.
    showEl.classList.remove("pop-in");
    void showEl.offsetWidth;
    showEl.classList.add("pop-in");
  }
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
// _domKey: a stable identity that survives reconcileLog's id swap below —
// this is the actual fix for Today's Journal collapsing/glitching when a
// meal is added. Every optimistic log starts life as `{ id: tempId, ... }`,
// then reconcileLog replaces it with the server's real object (a different
// `id`) once the API call resolves. renderJournal's reconcileList (ui.js)
// matches existing <li> elements against the array purely by id — without a
// stable key surviving that swap, the id change makes it treat the
// reconciled log as a brand-new item: it throws away the just-inserted,
// already-settled <li> and creates a fresh one, replaying its entrance
// animation and doing a full DOM node replacement for every single log,
// often within milliseconds of the original insert. `_domKey` is set once,
// at optimistic-insert time, and carried forward unchanged through
// reconciliation, so ui.js can key off it instead of the id — the SAME <li>
// persists across the whole optimistic → real lifecycle, so there's nothing
// left to restart or mismeasure.
function insertOptimisticLog(optimisticLog) {
  state.logs = [{ ...optimisticLog, _domKey: optimisticLog.id }, ...state.logs];
  render(optimisticLog.id);
}

function reconcileLog(tempId, realLog) {
  state.logs = state.logs.map((l) => (l.id === tempId ? { ...realLog, _domKey: tempId } : l));
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

// "Damage Control" trigger check — shared by every fresh-log path below
// (manual/scan/describe/barcode via submitNewLog, saved-meal quick-log via
// logSavedMealOptimistic, and a logged Meal Suggester idea, which itself
// goes through submitNewLog). Fires off `state.logs` as it stands the
// instant AFTER the optimistic insert, same "trust the optimistic update,
// don't wait on the network" philosophy every other post-log side effect in
// this app already follows (see loggedFoodToastMessage). Skipped entirely
// for a backdated entry (Daily History "add to a past day") — remaining
// macros "for the rest of today" is meaningless for a day that isn't today.
function checkDamageControl(loggedPayload) {
  const todayDate = state.dayState?.date || localDateStr();
  if (loggedPayload.log_date !== todayDate) return;
  const todayTotals = computeDailyTotals(todaysLogs(state.logs));
  maybeTriggerDamageControl({
    foodName: loggedPayload.food_name,
    mealCalories: loggedPayload.calories,
    todayTotalCalories: todayTotals.calories,
    targetCalories: state.targets?.daily_calories || 0,
  });
}

// ---------------------------------------------------------------------------
// End Day lock — interceptive guard, not a hidden/disabled button. Every
// entry point that can create a NEW log for today (FAB menu options, Saved
// Meals' instant-log action, Meal Suggester's "Log this Meal", and the two
// functions those all eventually funnel through below) calls this FIRST,
// before any optimistic UI update, toast, or network/AI call — see the
// individual call sites for why each one needed its own guard rather than
// relying solely on submitNewLog's (several show their own "Logged!" toast
// or start a camera/AI request before ever reaching submitNewLog). Mirrors
// the backend's own rule exactly (routers/day.py::get_day_context's `ended`
// flag only ever applies to today's date) — a backdated entry (Daily
// History "add to a past day", or a Smart Tools edit) is never blocked here,
// same as it's never blocked server-side.
function isDayLockedFor(logDate = state.dayState?.date || localDateStr()) {
  return Boolean(state.dayState?.ended) && logDate === state.dayState?.date;
}

function blockIfDayLocked(logDate) {
  if (!isDayLockedFor(logDate)) return false;
  showToast(t("day.addBlockedToast"), "error");
  return true;
}

async function submitNewLog(payload, { favoriteName, favoriteType } = {}) {
  if (blockIfDayLocked(payload.log_date)) return undefined;
  const tempId = makeTempId();
  // The backend defaults log_date to today when omitted, but the optimistic
  // local copy needs it set explicitly right now — todaysLogs()/the
  // day-detail sheet both filter on log_date, not logged_at, so without this
  // a freshly-added entry wouldn't show up until the real response reconciles.
  const fullPayload = { ...payload, log_date: payload.log_date || state.dayState?.date || localDateStr() };
  insertOptimisticLog({ id: tempId, ...fullPayload, image_url: null, logged_at: new Date().toISOString() });
  checkDamageControl(fullPayload);
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
  if (blockIfDayLocked()) return undefined;
  const tempId = makeTempId();
  const optimisticLog = {
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
  };
  insertOptimisticLog(optimisticLog);
  checkDamageControl(optimisticLog);
  vibrate(12);
  try {
    const saved = await api.logSavedMeal(meal.id);
    reconcileLog(tempId, saved);
  } catch (err) {
    rollbackNewLog(tempId, err.status === 409 ? t("day.loggingLockedToast") : err.message || t("toast.couldNotLogMealRemoved"));
  }
}

// Smart Meal Suggester's "Log this Meal" action (mealSuggester.js's
// logSuggestion callback) — a suggestion is already a complete, known
// {name, weight_g, calories, protein, carbs, fats, fiber, sugar, sodium,
// ingredients} snapshot (see backend/models.py's MealSuggestion), rescaled to
// whatever per-ingredient weights the user dialed in, so this is just
// submitNewLog with source "ai" (Gemini-originated data, same spirit as a
// photo scan) — no separate optimistic/rollback logic needed, it already
// gets that from submitNewLog itself.
function logMealSuggestion(suggestion) {
  // Guarded here too, not just inside submitNewLog: this function shows its
  // own "Logged!" toast BEFORE calling submitNewLog, which would otherwise
  // fire and immediately be contradicted by the day-locked toast.
  if (blockIfDayLocked()) return;
  const payload = {
    food_name: suggestion.name,
    weight_g: suggestion.weight_g,
    calories: suggestion.calories,
    protein: suggestion.protein,
    carbs: suggestion.carbs,
    fats: suggestion.fats,
    fiber: suggestion.fiber || 0,
    sugar: suggestion.sugar || 0,
    sodium: suggestion.sodium || 0,
    source: "ai",
    ingredients: suggestion.ingredients,
  };
  showToast(loggedFoodToastMessage(payload), "success");
  submitNewLog(payload);
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
// View Transitions API, shared by every DOM swap in this app that wants a
// cross-fade instead of a hard cut (tab switching below, and the Smart
// Tools row's sheet-to-sheet handoff — see openSmartTool further down).
// Feature-detected (Safari/Firefox don't support this yet) and skipped
// outright under prefers-reduced-motion, in which case `applyChange` just
// runs plainly — it's never a requirement for the swap itself to work, only
// for how it looks.
function runWithViewTransition(applyChange) {
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    applyChange();
    return null;
  }
  // A transition can be superseded by a newer one (e.g. a fast double-tap
  // before the first finishes), or skipped if the document becomes hidden
  // mid-transition — both expected, harmless per spec: the UI still ends up
  // in the right state either way. A ViewTransition has THREE independently-
  // rejectable promises (ready/updateCallbackDone/finished), not just one —
  // leaving any of them uncaught surfaces its own spurious
  // "InvalidStateError" exception in the console, so all three need a no-op
  // catch, not just .finished.
  const transition = document.startViewTransition(applyChange);
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
  transition.finished.catch(() => {});
  return transition;
}

// Measures a [hidden] view's real, final rendered height without ever
// letting the user see it — briefly unhidden-but-invisible (visibility, not
// display, so it stays in normal flow and gets its correct in-context width;
// see switchView's height-freeze below for why the width matters, e.g. for
// progress.js's chart sizing) and restored within the same synchronous tick,
// so no paint frame ever lands in between.
function measureNaturalHeight(view) {
  const wasHidden = view.hidden;
  if (wasHidden) {
    view.style.visibility = "hidden";
    view.hidden = false;
  }
  const height = view.getBoundingClientRect().height;
  if (wasHidden) {
    view.hidden = true;
    view.style.visibility = "";
  }
  return height;
}

// Tab switching (Dashboard/Progress/Saved/Discover) — a cross-fade + slight
// vertical drift between the old and new view (see the ::view-transition-*(root)
// rules in style.css for the actual animation).
// `skipTransition` (used by initTabSwipe's drag gesture below): the caller
// has already run its own live drag-driven slide and its own lazy-load
// trigger for the incoming tab, and just needs the real state applied
// (hidden toggling, active class, nav indicator/shape) instantly once that
// finishes — running the View Transition cross-fade too on top of an
// already-completed custom animation would double-animate the same swap.
function switchView(view, { skipTransition = false } = {}) {
  const outgoing = document.querySelector(".view:not([hidden])");
  const incoming = el(`view-${view}`);
  const isRealSwitch = incoming && incoming !== outgoing;

  // Lazy-loaded, not fetched on every app load — most sessions never open
  // these tabs, so there's no point spending a request on them up front.
  // Populated BEFORE the swap below (not after, like this used to be) so
  // the view-transition's "new" snapshot — and the height measurement right
  // after it — both see the tab's real, final content rather than an empty
  // shell that pops in a beat later once the network call resolves (see
  // renderProgress's cache-first fast path for why repeat visits render
  // synchronously here with no visible wait at all).
  if (!skipTransition) {
    // A plain tap — nothing pre-triggered this yet, so both fire here.
    if (view === "progress") {
      renderProgress(state.targets, state.logs, state.savedMeals);
      renderAnalyticsInsights();
    }
    if (view === "discover") onDiscoverTabOpened();
  }
  // A gesture-driven commit (initTabSwipe) needs nothing further here:
  // both Progress's and Discover's lazy-loads are triggered the instant the
  // drag arms toward them (see armDrag below), not on commit — repeating
  // either call here would just be a redundant round-trip. Both modules
  // guard their own DOM-mutating renders against landing mid-drag
  // (runOrDeferDuringSwipe, ui.js), so starting the fetch this early is safe
  // even though the visual commit/settle hasn't happened yet.

  const applyChange = () => {
    document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    el(`view-${view}`).hidden = false;
    updateNavChrome();
  };

  // Already on this tab (e.g. switchView("dashboard") from sign-in/sign-out,
  // which may already be showing it), or a gesture-driven commit that
  // already animated its own swap — either way, still apply (idempotent,
  // and updateNavIndicator may genuinely need to (re)run now that #app just
  // became visible), but skip the transition machinery entirely: there's no
  // transition-worthy visual swap left to do here.
  if (!isRealSwitch || skipTransition) {
    applyChange();
    return;
  }

  // Dashboard/Progress/Saved/Discover can differ hugely in total page height
  // (Progress alone easily runs 3-4x a fresh Dashboard). The View
  // Transitions API captures :root, so when the outgoing and incoming pages
  // are different heights the browser's own default cross-fade animates a
  // resize between the two captured sizes on top of our opacity/translateY
  // fade — a visible stretch/squish, and/or a scrollbar popping in/out
  // mid-transition as the page's own scrollability changes underneath it —
  // both of which are exactly the "jiggle" tab switching used to show.
  // Pinning body's min-height to whichever of the two views is taller, for
  // the duration of the transition only, makes the old and new capture
  // geometry (and scrollability) identical, so there's nothing left for the
  // browser to interpolate or for a scrollbar to react to.
  const incomingHeight = measureNaturalHeight(incoming);
  const outgoingHeight = outgoing ? outgoing.getBoundingClientRect().height : 0;
  const previousMinHeight = document.body.style.minHeight;
  document.body.style.minHeight = `${Math.max(incomingHeight, outgoingHeight)}px`;
  const releaseHeightPin = () => {
    document.body.style.minHeight = previousMinHeight;
  };

  const transition = runWithViewTransition(applyChange);
  if (transition) transition.finished.then(releaseHeightPin, releaseHeightPin);
  else releaseHeightPin();
}

// Slides the pill highlight in the bottom nav under whichever tab is active,
// instead of just swapping a color — a small touch that makes navigation feel
// like one continuous motion rather than a hard cut. Icon-only nav-btns are
// all a fixed, equal 44px now (see style.css), so .nav-indicator is a fixed
// 44px disc too — only `transform` ever needs to move, .style.width is gone.
function updateNavIndicator() {
  if (el("app").hidden) return; // getBoundingClientRect is meaningless while hidden
  const nav = document.querySelector(".bottom-nav");
  const active = document.querySelector(".nav-btn.active");
  const indicator = el("nav-indicator");
  if (!nav || !active || !indicator) return;
  const navRect = nav.getBoundingClientRect();
  const btnRect = active.getBoundingClientRect();
  indicator.style.transform = `translateX(${btnRect.left - navRect.left}px)`;
}

// The bottom nav's "cutout" notch that the FAB sits in — a real outline
// (clip-path: path(), applied to .bottom-nav::before, see that rule's own
// long comment in style.css for why it's on the pseudo-element and not the
// bar itself), not an SVG stretched to fit via preserveAspectRatio (which
// would ellipse the curve at narrow viewport widths) and not a bare circle
// tangent to the bar's top edge (a flat line meeting a circle head-on is a
// sharp, not smooth, corner — first-derivative-discontinuous at the seam).
// Two mirrored cubic beziers instead: each one starts and ends with a
// horizontal tangent (matching the flat bar edge on the outside, and its
// mirror twin at the bottom-center), so the whole outline — flat, into the
// notch, along the bottom, back out, flat again — is one continuous,
// nowhere-kinked curve. Path coordinates are plain CSS pixels in the
// element's own border box (that's what distinguishes clip-path: path()
// from an SVG viewBox), computed from the bar's and FAB's REAL measured
// size — so the notch always frames the actual rendered FAB exactly,
// including at --fab-diameter's own responsive clamp() sizes.
function updateNavShape() {
  if (el("app").hidden) return;
  const nav = document.querySelector(".bottom-nav");
  const fab = el("fab-add");
  if (!nav || !fab) return;
  const w = nav.getBoundingClientRect().width;
  const h = nav.getBoundingClientRect().height;
  if (!w || !h) return;
  const fabRadius = fab.getBoundingClientRect().width / 2 || 30;

  const capRadius = h / 2; // the bar's own left/right end-cap rounding (was border-radius: 999px)
  const cx = w / 2; // the notch is always dead-center, matching the FAB's own grid column
  const notchHalfWidth = fabRadius + 14; // clearance between the FAB's edge and the notch's opening
  const depth = Math.min(h * 0.42, 26); // how far the notch dips into the bar
  const shoulder = notchHalfWidth * 0.42; // bezier control-point offset — the "how gradual" knob for the curve's shoulders

  // Rounded to 2 decimal places, not left as raw floats — getBoundingClientRect
  // and the arithmetic above routinely produce long floating-point tails
  // (e.g. 16.379999999999995), and every coordinate here also gets a hairline
  // border painted along it (.bottom-nav::before). Keeping the path's own
  // numbers clean avoids ever asking the rasterizer to anti-alias a
  // razor-thin stroke against a sub-pixel-offset fill edge, which is what
  // reads as a stray colored seam right at the curve.
  const r = (n) => Math.round(n * 100) / 100;
  const d = [
    `M ${r(capRadius)} 0`,
    `L ${r(cx - notchHalfWidth)} 0`,
    `C ${r(cx - notchHalfWidth + shoulder)} 0, ${r(cx - shoulder)} ${r(depth)}, ${r(cx)} ${r(depth)}`,
    `C ${r(cx + shoulder)} ${r(depth)}, ${r(cx + notchHalfWidth - shoulder)} 0, ${r(cx + notchHalfWidth)} 0`,
    `L ${r(w - capRadius)} 0`,
    `A ${r(capRadius)} ${r(capRadius)} 0 0 1 ${r(w)} ${r(capRadius)}`,
    `L ${r(w)} ${r(h - capRadius)}`,
    `A ${r(capRadius)} ${r(capRadius)} 0 0 1 ${r(w - capRadius)} ${r(h)}`,
    `L ${r(capRadius)} ${r(h)}`,
    `A ${r(capRadius)} ${r(capRadius)} 0 0 1 0 ${r(h - capRadius)}`,
    `L 0 ${r(capRadius)}`,
    `A ${r(capRadius)} ${r(capRadius)} 0 0 1 ${r(capRadius)} 0`,
    "Z",
  ].join(" ");

  nav.style.setProperty("--nav-shape", `path("${d}")`);
}

function updateNavChrome() {
  updateNavIndicator();
  updateNavShape();
}

window.addEventListener("resize", updateNavChrome);

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

// Immediate press feedback for the bottom nav (icons) and the FAB,
// deliberately decoupled from the `click` handlers above/below — `click`
// (and, for the icons, everything switchView does after it: lazy-loading,
// the View Transition cross-fade, updateNavChrome) can take a real,
// variable amount of time, but the PRESS itself should never wait on any
// of that. pointerdown fires the instant a finger contacts the screen, so
// toggling a plain CSS class here is what makes the icon/FAB visibly react
// at that exact millisecond regardless of how long routing afterward
// takes — see .nav-btn-pressed/.fab-pressed's own comments in style.css
// for why this also has to exist as JS at all (iOS Safari's :active
// pseudo-class is unreliable on a quick tap unless a touch/pointer
// listener is already attached, which is exactly what this is).
function initPressFeedback(target, pressedClass) {
  const press = () => target.classList.add(pressedClass);
  const release = () => target.classList.remove(pressedClass);
  target.addEventListener("pointerdown", press);
  target.addEventListener("pointerup", release);
  target.addEventListener("pointercancel", release);
  // A finger/cursor that drags off the element before releasing (e.g. the
  // start of an accidental tab-swipe or scroll) shouldn't leave it stuck
  // looking pressed — pointerup alone wouldn't fire in that case.
  target.addEventListener("pointerleave", release);
}
document.querySelectorAll(".nav-btn").forEach((btn) => initPressFeedback(btn, "nav-btn-pressed"));
initPressFeedback(el("fab-add"), "fab-pressed");

// Generic close-on-backdrop + [data-close] buttons
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeSheet(btn.dataset.close));
});
document.querySelectorAll(".sheet-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    // Must go through closeSheet() (not overlay.hidden = true directly) — it
    // also clears #app's no-scroll lock. Dismissing via backdrop click used
    // to skip that, leaving page scroll stuck locked until some other sheet
    // was opened and closed "properly" through a button.
    if (e.target === overlay) closeSheet(overlay.id);
  });
  // Backdrop touch interception: #app's no-scroll lock (ui.js's
  // lockAppScroll(), engaged by openSheet()) already stops the page itself
  // from moving, but without this, a drag starting directly on the scrim
  // (not on the .sheet card) still gets treated as a touch gesture the
  // browser has to resolve, occasionally reading as a stray rubber-band
  // flash at the very edges of the viewport on iOS before the lock "wins".
  // Scoped to e.target === overlay exactly like the click handler
  // above, so it never touches drags that start on the sheet content
  // itself (which must stay perfectly scrollable) or on the drag-handle
  // (which has its own pointer-based drag-to-dismiss in ui.js).
  overlay.addEventListener(
    "touchmove",
    (e) => {
      if (e.target === overlay) e.preventDefault();
    },
    { passive: false }
  );
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

// .pulse's own animation (style.css's fab-shockwave, 0.7s) is never
// infinite, but the CLASS itself was never being removed once it finished —
// meaning .fab.pulse (higher specificity than plain .fab) kept permanently
// overriding the base .fab { animation: fab-breathe } idle glow loop for
// the rest of the session after the very first tap. Cleared here the
// instant the shockwave actually finishes (animationend, not a duplicated
// hardcoded setTimeout — this fires correctly whether the animation ran its
// full 0.7s or was flattened to ~0 under prefers-reduced-motion), so the
// breathing glow can resume between taps like it's supposed to.
el("fab-add").addEventListener("animationend", (e) => {
  if (e.animationName === "fab-shockwave") e.target.classList.remove("pulse");
});

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
  // Deferred one frame, not called synchronously right here — navigator.vibrate()
  // can itself cost a few ms of main-thread time on some Android WebViews,
  // and firing it in the very same tick as the class change that starts the
  // animation risks delaying that animation's first painted frame, which is
  // exactly what reads as "stutters right at the start." One rAF is enough
  // to let the browser paint that first frame before the vibration call's
  // own cost can compete with it — imperceptible as a haptic delay, but
  // enough to decouple the two.
  requestAnimationFrame(() => vibrate(15));
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

// Every FAB menu option below closes the radial menu first regardless of
// the day lock (so the toast below isn't left appearing behind it), then
// guards — see blockIfDayLocked's own comment for why this frontend
// interception exists at all instead of just letting the backend's 409
// handle it: no sheet opens, no camera/AI request ever gets a chance to
// start, and the button itself stays exactly as visible/tappable as always
// (no CSS hide/disable — see the End Day docs above).
el("opt-scan").addEventListener("click", () => {
  closeSheet("add-sheet");
  if (blockIfDayLocked()) return;
  if (!openScanSheetFresh()) return; // scan.js's own guard — see its own comment on why it re-checks
  openSheet("scan-sheet");
});

el("opt-suggest").addEventListener("click", () => {
  closeSheet("add-sheet");
  if (blockIfDayLocked()) return;
  openMealSuggesterSheet();
});

el("opt-saved").addEventListener("click", () => {
  closeSheet("add-sheet");
  if (blockIfDayLocked()) return;
  switchView("saved");
});

el("opt-manual").addEventListener("click", () => {
  closeSheet("add-sheet");
  if (blockIfDayLocked()) return;
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
  // Smart Tools (AI Photo/Describe/Barcode — see openSmartTool below) works
  // for both a genuinely new entry (today or backdated) AND editing an
  // existing Journal log/Saved Meal — appending a forgotten ingredient by
  // photo/voice/barcode merges into whatever's already there and returns
  // here for review (see openSmartTool's own comment), rather than creating
  // a second entry. Still hidden only while creating a brand-new saved-meal
  // template: scan.js's confirm flow always merges into (or creates) a real
  // entry, and there's nothing existing yet for a template-in-progress to
  // merge into.
  el("manual-smart-tools").hidden = Boolean(creatingSavedMealType);

  // Saved meals use `name`, daily logs use `food_name` — everything else
  // (weight_g/calories/protein/carbs/fats/fiber) is the same shape either
  // way. A source with its own multi-item breakdown (an AI scan/Smart Tools
  // merge, or a manually-composed multi-ingredient meal) is seeded as-is; a
  // source with only aggregate fields becomes a single implicit ingredient,
  // same as a brand-new entry starting from one blank row — both render flat
  // (no per-row name/card chrome) since there's only the one row, with this
  // top-level name field as the only place to name it (see the submit
  // handler below syncing this into that sole ingredient's own food_name).
  // Only once a second ingredient exists does the editor grow full per-row
  // cards — see ingredientsList.js's isFlat.
  el("manual-name").value = (existingSavedMeal ? existingSavedMeal.name : existingLog?.food_name) || "";
  manualIngredientsEditor.setIngredients(
    source?.ingredients?.length ? source.ingredients : source ? [asImplicitIngredient(source)] : []
  );
  el("manual-save-favorite").checked = false;
  el("manual-favorite-type").hidden = true;
  resetPillTabs("manual-favorite-type");
  // Meal-timing tag only makes sense for an actual logged entry — a saved
  // meal is a reusable template that could be logged pre- or post-workout
  // differently each time, so it never carries its own tag (hidden while
  // editing/creating one). A fresh or existing daily log seeds from its own
  // current tag, defaulting to "regular" same as the backend column default.
  el("manual-workout-tag-row").hidden = Boolean(editingSavedMealId) || Boolean(creatingSavedMealType);
  resetPillTabs("manual-workout-tag", existingLog?.workout_tag || "regular");

  manualDraftModeActive = !isEditing && !creatingSavedMealType;
  if (manualDraftModeActive) restoreManualDraftIfAny();

  openSheet("manual-sheet");
}

// Hands off from the manual-entry modal to #scan-sheet in one specific mode
// — see index.html's #manual-smart-tools comment for why this routes to the
// scan sheet's own mature camera/barcode/quota/voice logic rather than
// duplicating any of it here. manualTargetDate (set by openManualSheet when
// backdating a past day) carries over automatically via openScanSheetFresh's
// own targetDate param, so the eventual scan result logs to the same day the
// user was already adding to, not to today. runWithViewTransition gives this
// sheet-to-sheet swap the same cross-fade+drift switchView() uses for tab
// changes (see its own comment) instead of a hard cut between two sheets.
// Not a clearManualDraft() call: closeSheet() alone (unlike the sheet's own
// Cancel/backdrop handlers) leaves any in-progress manual draft recoverable,
// in case the user backs out of the scan sheet without submitting and wants
// to return to what they'd already typed.
// Built fresh on every Smart Tools tap from whatever manual-sheet is
// currently editing (state.editingLogId / editingSavedMealId /
// editingLogSnapshot — all set by openManualSheet) — null for a genuinely
// new entry (fresh or backdated), in which case scan.js's confirm handler
// falls back to its normal create-a-new-entry behavior unchanged. Existing
// ingredients always resolve to a real array (an implicit one-row wrap for
// an older entry that predates the ingredients feature — see
// asImplicitIngredient), never null/undefined, so scan.js's own merge
// (`[...existingIngredients, ...ingredients]`) never needs its own guard.
function buildScanEditContext() {
  const src = editingLogSnapshot;
  if (!src) return null;
  if (state.editingLogId) {
    return {
      kind: "log",
      id: state.editingLogId,
      existingFoodName: src.food_name,
      existingIngredients: src.ingredients?.length ? src.ingredients : [asImplicitIngredient(src)],
    };
  }
  if (editingSavedMealId) {
    return {
      kind: "savedMeal",
      id: editingSavedMealId,
      existingFoodName: src.name,
      existingIngredients: src.ingredients?.length ? src.ingredients : [asImplicitIngredient({ ...src, food_name: src.name })],
      type: src.type || "meal",
      servings: src.servings || 1,
    };
  }
  return null;
}

function openSmartTool(mode) {
  const targetDate = manualTargetDate;
  const editContext = buildScanEditContext();
  runWithViewTransition(() => {
    closeSheet("manual-sheet");
    if (!openScanSheetFresh(mode, targetDate, editContext)) return;
    openSheet("scan-sheet");
  });
}

// A NEW photo captured via the AI Photo tool while editing (see
// buildScanEditContext/returnToEditWithMergedIngredients below) — held here
// rather than applied immediately on return, since the user hasn't actually
// saved anything yet at that point and might still cancel out of manual-
// sheet without confirming. Consumed (the entry's thumbnail replaced, then
// this cleared) only once that edit actually succeeds — see the
// state.editingLogId submit branch further down. Describe/barcode edits (no
// new photo) and every saved-meal edit (saved meals have no photo concept
// in the Journal) leave this null, which is exactly what preserves an
// entry's existing hero photo completely untouched when no new one was
// captured — see index.html's #manual-smart-tools comment for the full
// "forgot to log Bread" scenario this exists for.
let pendingSmartToolPhoto = null;

// scan.js's onReturnToEdit — called once the user confirms a Smart Tools
// scan while editing an existing entry (see buildScanEditContext). Re-opens
// the exact same edit context manual-sheet was already in via
// openManualSheet's own existing log/saved-meal edit path (food name/type/
// servings unchanged), then overrides just the ingredient list with the
// merged one. The actual save afterward still goes through
// openManualSheet's completely unchanged submit handler below — this
// detour only ever changes what's pre-filled in the form, never how saving
// itself works, so there's no second, parallel "apply this update" code
// path that could drift out of sync with the real one.
function returnToEditWithMergedIngredients(editContext, mergedIngredients, photoFile) {
  pendingSmartToolPhoto = editContext.kind === "log" ? photoFile || null : null;
  runWithViewTransition(() => {
    if (editContext.kind === "log") {
      openManualSheet(state.logs.find((l) => l.id === editContext.id));
    } else {
      openManualSheet(null, null, state.savedMeals.find((m) => m.id === editContext.id));
    }
    manualIngredientsEditor.setIngredients(mergedIngredients);
  });
}

// Called right after a log edit actually succeeds (both the direct-edit and
// food-name-change submit branches below) — replaces that entry's Journal
// thumbnail with the just-captured photo, or does nothing at all if none was
// captured this round (the common case: a describe/barcode append, or a
// plain manual edit with no Smart Tools involved). See replaceScanThumbnail
// (scan.js) for why this always deletes the old thumbnail first rather than
// adding alongside it.
function consumePendingSmartToolPhoto(logId, foodName, calories) {
  if (!pendingSmartToolPhoto) return;
  const file = pendingSmartToolPhoto;
  pendingSmartToolPhoto = null;
  const loggedAt = state.logs.find((l) => l.id === logId)?.logged_at;
  replaceScanThumbnail(logId, file, foodName, calories, loggedAt, () => render());
}

el("manual-smart-tools").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-scan-mode]");
  if (!btn) return;
  openSmartTool(btn.dataset.scanMode);
});

const manualIngredientsEditor = createIngredientsEditor({
  listEl: el("manual-ingredients-list"),
  totalsEl: el("manual-ingredients-totals"),
  addBtnEl: el("manual-ingredients-add-btn"),
  // See scan.js's identical wiring for the Review Scan sheet — sugar/sodium
  // live in their own "More nutrients" disclosure rather than the totals
  // chip strip, but still need to track ingredient edits/rescales live.
  onTotalsChange: (agg) => {
    el("manual-detail-sugar").textContent = `${agg.sugar}g`;
    el("manual-detail-sodium").textContent = `${agg.sodium}mg`;
  },
  // The only mount site for this tool — see ingredientsList.js's own comment
  // on enableScaleTool. This sheet has no AI/recipe baseline to auto-rescale
  // from, so "Scale from label" is the only way to derive macros from a
  // nutrition label here rather than a redundant, conflicting second path.
  enableScaleTool: true,
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
wirePillTabs("manual-workout-tag");
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
  const foodName = el("manual-name").value.trim();
  const ingredients = manualIngredientsEditor.getIngredients();
  // A solo-ingredient entry (the flat/default case — see ingredientsList.js's
  // isFlat) never shows its own per-ingredient name field, only this form's
  // one top-level name field, so that field is authoritative for the sole
  // ingredient's name too — keeps them from ever silently diverging now that
  // there's only one name to type in the common case.
  if (ingredients.length === 1) ingredients[0] = { ...ingredients[0], food_name: foodName };
  const payload = {
    food_name: foodName,
    ...manualIngredientsEditor.getAggregate(),
    ingredients,
    // Harmless on the saved-meal branches below (editingSavedMealId's
    // savedMealPayload and saveFavoriteAs() both build their own explicit
    // field list and never read this key off `payload`) — only the new-log
    // and edit-existing-log branches actually forward it.
    workout_tag: el("manual-workout-tag-row").hidden ? undefined : getActivePillType("manual-workout-tag", "regular"),
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
      // type/servings are carried over from the snapshot, unchanged — this
      // form doesn't expose a meal/product re-categorize control or a
      // servings-count field, only the macro fields (saved_meals uses
      // `name`, not `food_name`, for the label). PUT /meals/{id} is a full
      // replace (see backend/routers/meals.py), so omitting servings here
      // would silently reset any multi-serving recipe back to 1 rather than
      // leaving it alone.
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
        servings: editingLogSnapshot?.servings || 1,
      };
      const updated = await api.updateSavedMeal(mealId, savedMealPayload);
      state.savedMeals = state.savedMeals.map((m) => (m.id === mealId ? updated : m));
      renderSavedMeals(savedMealsForActiveTab());
      // This edit can change exactly what the Suggestions card's food
      // ranking cares about (calories/macros) — bypasses render() (only the
      // saved-meals list itself needs a full repaint here), so it needs its
      // own push. `remaining` is omitted: it hasn't changed, and
      // setSuggestionsContext keeps whatever render() last set for it.
      setSuggestionsContext({ savedMeals: state.savedMeals });
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
        const saved = await api.correctLog(editId, {
          food_name: payload.food_name,
          weight_g: payload.weight_g,
          workout_tag: payload.workout_tag,
        });
        showToast(t("toast.updated"), "success");
        closeSheet("manual-sheet");
        replaceLog(editId, saved);
        consumePendingSmartToolPhoto(editId, saved.food_name, saved.calories);
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
      consumePendingSmartToolPhoto(editId, saved.food_name, saved.calories);
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
  // Guarded here too (not just inside submitNewLog): this form shows its
  // own "Logged!" toast below before ever calling it, and the sheet can
  // still be open from before a rapid End Day toggle in another tab.
  if (blockIfDayLocked(newLogPayload.log_date)) return;
  showToast(loggedFoodToastMessage(newLogPayload), "success");
  closeSheet("manual-sheet");
  clearManualDraft();
  submitNewLog(newLogPayload, {
    favoriteName: wantsFavorite ? payload.food_name : undefined,
    favoriteType: getActivePillType("manual-favorite-type"),
  });
});

// ---------------------------------------------------------------------------
// Today's Journal — tap a card to open the centralized edit modal (the same
// manual-sheet every other food-entry flow already uses, Smart Tools row and
// all — see openManualSheet), the favorite/delete icon buttons for their own
// actions, and swipe-left-to-delete (initJournalSwipe below) as the native-
// feeling alternative to the delete button. All delegated on #log-list
// itself rather than attached per-card, since reconcileList (ui.js) replaces
// each .journal-card's innerHTML on every re-render — a listener attached
// directly to a card's own children would be silently destroyed the next
// time anything else on the dashboard changed.
// ---------------------------------------------------------------------------
// Confirmed live (not assumed): tapping delete on the same card again while
// it's still mid-flight — a fast double-tap on the button, or a stray click
// landing during the swipe-to-delete auto-commit's own setTimeout below —
// used to start a SECOND, fully independent deleteJournalEntry/deleteWithUndo
// flow for the same id, each with its own 5s undo timer. Once both fired,
// the second api.deleteLog(id) 404'd against an already-deleted row, which
// deleteWithUndo's catch handler treated as a real failure: it called
// restore(), silently resurrecting the just-deleted entry back into the
// journal a few seconds after the user deleted it, alongside a console error
// from the failed request — exactly the reported "rapid taps throw errors
// and the list stops functioning" bug. Guarding on id here — the one thing
// every entry point (tap, swipe-commit) already funnels through — makes a
// second delete on an in-flight id a no-op instead of a second independent
// flow.
const journalDeletesInFlight = new Set();

// Confirmed live (not assumed): deleteWithUndo (ui.js) delays the real
// api.deleteLog() call behind an in-memory 5s setTimeout so tapping "Undo"
// can still cancel it — but an in-memory timer doesn't survive a reload,
// tab close, or navigation. Deleting an item and refreshing the page within
// that 5s window killed the pending timer before it ever fired, so the
// DELETE request was silently never sent — the item was gone from `state`
// and the DOM, but still present server-side, and reappeared the moment
// loadAll() re-fetched fresh data on the next load. That's the reported
// "delete the last item, refresh, it's back" bug — confirmed by direct DB
// inspection, not just UI observation, and not actually specific to the
// last item (any item deleted within 5s of a reload is equally affected);
// it's just that deleting the LAST item leaves a blank list with no
// feedback (see renderJournal's empty-state handling below), which is what
// prompts a user to refresh immediately in the first place. Persisting the
// pending id here — cleared the moment the real delete actually succeeds or
// the user explicitly undoes it — means a reload can never lose track of an
// in-flight delete: flushPendingLogDeletes() (called from loadAll on every
// boot) finishes off anything still listed here from a session that ended
// before its undo window ran out.
const PENDING_LOG_DELETES_KEY = "ironlog_pending_log_deletes";

function getPendingLogDeletes() {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_LOG_DELETES_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function addPendingLogDelete(id) {
  const ids = new Set(getPendingLogDeletes());
  ids.add(id);
  localStorage.setItem(PENDING_LOG_DELETES_KEY, JSON.stringify([...ids]));
}

function clearPendingLogDelete(id) {
  const ids = getPendingLogDeletes().filter((existingId) => existingId !== id);
  localStorage.setItem(PENDING_LOG_DELETES_KEY, JSON.stringify(ids));
}

// Called once per boot, before loadAll() fires its own GET /logs, so that
// fetch already reflects any delete a previous session never got to finish
// (see PENDING_LOG_DELETES_KEY's own comment above). DELETE /logs/{id} is
// idempotent server-side (backend/routers/logs.py deletes by id+user_id and
// never 404s on a missing row), so retrying an id that was actually already
// removed by an earlier flush attempt that died before clearing its own
// marker is harmless — it's still safe to clear here on success. Any other
// failure (offline, 5xx, ...) leaves the marker queued for the next boot.
async function flushPendingLogDeletes() {
  const ids = getPendingLogDeletes();
  if (!ids.length) return;
  await Promise.allSettled(
    ids.map(async (id) => {
      try {
        await api.deleteLog(id);
      } catch {
        return; // still not confirmed deleted — leave queued for the next boot
      }
      clearPendingLogDelete(id);
    }),
  );
}

// Today's Journal cards are keyed in the DOM by _domKey, not id (see
// renderJournal's getId in ui.js) — a card that was ever an optimistic
// insert keeps its original tempId as data-id forever, even after
// reconcileLog() has swapped the underlying log object over to its real
// server-assigned id, specifically so reconcileList doesn't treat the swap
// as "remove one card, insert a brand-new one" (see reconcileLog's own
// comment). Every handler below must resolve back through the actual log
// object to get the real id before calling the API or filtering state.logs
// — using card.dataset.id directly against api.deleteLog()/state.logs.find()
// sends the tempId instead, which either no-ops (nothing in state.logs has
// that id anymore) or hits the backend with a non-UUID id and 500s. This is
// what caused "delete a just-logged item and it errors on the first try":
// any item logged this session (scan, manual entry, a Discover product
// search result logged via the shared scan-result-review form, ...) goes
// through that optimistic tempId path, so its card's data-id is stale from
// the moment it's created — the very first delete tap on it hits this,
// not some rare edge case that only shows up on a retry. It "fixes itself"
// on a later attempt only because a full reload (loadAll) replaces
// state.logs with fresh, _domKey-less objects from the server.
function findLogByDomKey(domKey) {
  return state.logs.find((l) => l.id === domKey || l._domKey === domKey);
}

async function deleteJournalEntry(id, domKey = id) {
  if (journalDeletesInFlight.has(id)) return;
  journalDeletesInFlight.add(id);
  // See PENDING_LOG_DELETES_KEY's own comment above — recorded synchronously
  // here, before the animation await below, not after it resolves. The
  // animation itself can take up to its own 300ms timeoutMs, and a reload
  // landing inside THAT window (not just the later 5s undo window) needs to
  // already know this delete needs finishing too, or it's lost the exact
  // same way.
  addPendingLogDelete(id);

  const card = await animateItemRemoval("log-list", domKey, {
    className: "exiting",
    timeoutMs: 300,
    transitionProperty: "max-height",
    snapHeight: true,
  });
  vibrate(10);
  // Captured here, right before deleteWithUndo (whose removeNow() runs
  // synchronously as its very first statement) rather than before the
  // animation await above — snapshotting earlier left a window where a
  // second rapid delete (a different item) could run its own removeNow()
  // during this item's animation delay, so this item's restore() would
  // capture a stale, pre-that-removal state.logs. Undoing THIS delete would
  // then silently resurrect the OTHER, already-removed item too — the
  // "rapid taps corrupt the list" bug. Taking the snapshot immediately
  // before the synchronous removal closes that window.
  const previousLogs = state.logs;
  deleteWithUndo({
    // Deliberately NOT the full render() here. By this point `card` has
    // already fully played its .exiting collapse (animateItemRemoval only
    // resolves once that transition finishes), so the browser has already
    // closed the gap and slid every card below it up — a plain node.remove()
    // is a no-op as far as layout is concerned, it just drops an already-
    // invisible, already-zero-height element. Routing this through render()
    // instead would re-run renderDashboard AND renderJournal AND
    // renderSavedMeals AND every context-sync call render() also makes on
    // every single delete — far more DOM work than one removed line item
    // needs, for zero visual benefit since the list itself is already
    // correct. renderDashboard alone covers everything that can actually
    // change from a food-log delete: the calorie ring, macro bars, and
    // status banner all read off `logs`, nothing else in render() does.
    removeNow: () => {
      state.logs = state.logs.filter((l) => l.id !== id);
      card?.remove();
      const logs = todaysLogs(state.logs);
      if (state.targets) {
        renderDashboard(state.targets, logs, state.water, undefined, state.dayState?.ended);
      }
      // renderJournal's own reconcileList has nothing left to do here — the
      // one card that changed was already pulled out of the DOM above, and
      // every other card is untouched — EXCEPT when this delete was the
      // last entry left: renderJournal is also what unhides #log-empty, and
      // skipping it entirely (as this handler used to) left the journal
      // permanently blank after deleting down to zero, fixable only by a
      // full page reload. Only calling it in that one case keeps every other
      // delete exactly as cheap as the comment above describes.
      if (!journalEntriesFor(logs).length) {
        renderJournal([], undefined, getScanThumbnailUrl);
      }
      // This fast path deliberately skips the full render() above (see that
      // comment), but a food-log delete is exactly the kind of change the
      // Suggestions card's remaining-budget stat and ranking need to reflect
      // instantly too — savedMeals is unchanged here, only remaining.
      if (state.targets) {
        const todayTotals = computeDailyTotals(logs);
        setSuggestionsContext({
          remaining: {
            calories: (state.targets.daily_calories || 0) - todayTotals.calories,
            protein: (state.targets.daily_protein || 0) - todayTotals.protein,
            carbs: (state.targets.daily_carbs || 0) - todayTotals.carbs,
            fats: (state.targets.daily_fats || 0) - todayTotals.fats,
          },
        });
      }
    },
    restore: () => {
      state.logs = previousLogs;
      journalDeletesInFlight.delete(id);
      clearPendingLogDelete(id);
      render();
    },
    callDelete: async () => {
      await api.deleteLog(id);
      journalDeletesInFlight.delete(id);
      clearPendingLogDelete(id);
      // Best-effort, never awaited by the caller — the log delete already
      // succeeded either way; a failed thumbnail/hero cleanup just leaves an
      // orphaned photo unseen locally (the thumbnail store self-prunes by
      // age via purgeStalePhotos; a stray hero photo would too, next boot),
      // never something worth surfacing as an error.
      deleteRecentScanByLogId(id).then(refreshThumbnailCache);
      removeHeroPhoto(id);
    },
    removedToastKey: "toast.removed",
    revertToastKey: "toast.couldNotDeleteEntryRestored",
  });
}

el("log-list").addEventListener("click", (e) => {
  const card = e.target.closest(".journal-card");
  if (!card) return;
  const domKey = card.dataset.id;
  const log = findLogByDomKey(domKey);
  const btn = e.target.closest("button[data-action]");

  if (btn) {
    if (btn.dataset.action === "save-favorite") {
      pendingFavoriteLog = log;
      openSheet("save-favorite-choice-sheet");
    } else if (btn.dataset.action === "delete" || btn.dataset.action === "swipe-delete") {
      if (log) deleteJournalEntry(log.id, domKey);
    }
    return;
  }

  // A card left revealed by a previous swipe (see initJournalSwipe) treats a
  // tap anywhere else on it as "close the reveal" first, same as any native
  // swipe-list — never opens edit (or the lightbox below) straight out of a
  // half-open state.
  if (card === journalRevealedCard) {
    closeRevealedJournalCard();
    return;
  }

  // Tapping the photo itself opens the full-screen lightbox (photoLightbox.js)
  // instead of falling through to the edit sheet below — the rest of the
  // card (name/macros/time) keeps its existing tap-to-edit behavior.
  const photoImg = e.target.closest(".journal-card-photo");
  if (photoImg && log) {
    openPhotoLightbox(log, photoImg);
    return;
  }

  if (log) openManualSheet(log);
});

// ---------------------------------------------------------------------------
// Swipe-left-to-delete — native-feeling drag on a Journal card, live 1:1
// finger tracking while dragging (same Pointer Events approach as ui.js's
// initSheetDragToDismiss), just horizontal and delegated on the list instead
// of a single fixed handle — see the click handler's own comment on why
// delegation is required here. Only ever animates `transform` on the card's
// inner .journal-card-content (never a paint property), so this stays smooth
// scrolling through a long list even on a low-end phone.
// ---------------------------------------------------------------------------
const JOURNAL_SWIPE_REVEAL_PX = 84; // matches .journal-card-delete-bg's own width in style.css
const JOURNAL_SWIPE_COMMIT_PX = 160; // dragged this far left auto-deletes, no extra tap needed
const JOURNAL_SWIPE_COMMIT_VELOCITY = 0.6; // px/ms leftward — a fast flick commits even under the distance threshold
let journalRevealedCard = null; // the one .journal-card currently showing its delete button, if any

function closeRevealedJournalCard() {
  if (!journalRevealedCard) return;
  const content = journalRevealedCard.querySelector(".journal-card-content");
  if (content) {
    content.style.transition = "transform 0.22s var(--ease)";
    content.style.transform = "";
  }
  journalRevealedCard.classList.remove("journal-card-revealed");
  journalRevealedCard = null;
}

function initJournalSwipe() {
  const list = el("log-list");
  let card = null;
  let content = null;
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let startTime = 0;
  let axis = null; // null while undecided (a few px in), then locked to "x" or "y"

  list.addEventListener("pointerdown", (e) => {
    const target = e.target.closest(".journal-card");
    if (!target || e.target.closest("button")) return; // action buttons behave as plain taps, not a drag start
    card = target;
    content = card.querySelector(".journal-card-content");
    baseX = card === journalRevealedCard ? -JOURNAL_SWIPE_REVEAL_PX : 0;
    startX = e.clientX;
    startY = e.clientY;
    startTime = performance.now();
    axis = null;
    window.addEventListener("pointermove", onJournalPointerMove);
    window.addEventListener("pointerup", onJournalPointerUp);
    window.addEventListener("pointercancel", onJournalPointerUp);
  });

  function onJournalPointerMove(e) {
    if (!content) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!axis) {
      // Too small a movement yet to tell a horizontal swipe from a vertical
      // list scroll apart — wait for a real signal rather than guessing.
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (axis === "x") content.style.transition = "none"; // live 1:1 tracking, no easing lag while dragging
    }
    if (axis !== "x") return; // a vertical scroll — let the page handle it natively, don't fight it
    e.preventDefault();
    const next = Math.min(0, Math.max(baseX + dx, -card.offsetWidth));
    content.style.transform = `translateX(${next}px)`;
  }

  function onJournalPointerUp(e) {
    window.removeEventListener("pointermove", onJournalPointerMove);
    window.removeEventListener("pointerup", onJournalPointerUp);
    window.removeEventListener("pointercancel", onJournalPointerUp);
    if (axis !== "x" || !content) {
      card = null;
      content = null;
      return;
    }
    const dx = e.clientX - startX;
    const finalX = Math.min(0, Math.max(baseX + dx, -card.offsetWidth));
    const leftwardVelocity = (startX - e.clientX) / Math.max(performance.now() - startTime, 1);
    content.style.transition = "transform 0.22s var(--ease)";

    if (-finalX > JOURNAL_SWIPE_COMMIT_PX || leftwardVelocity > JOURNAL_SWIPE_COMMIT_VELOCITY) {
      content.style.transform = "translateX(-100%)";
      const domKey = card.dataset.id;
      const log = findLogByDomKey(domKey);
      if (journalRevealedCard === card) journalRevealedCard = null;
      if (log) setTimeout(() => deleteJournalEntry(log.id, domKey), 180);
    } else if (-finalX > JOURNAL_SWIPE_REVEAL_PX / 2) {
      content.style.transform = `translateX(${-JOURNAL_SWIPE_REVEAL_PX}px)`;
      card.classList.add("journal-card-revealed");
      if (journalRevealedCard && journalRevealedCard !== card) closeRevealedJournalCard();
      journalRevealedCard = card;
    } else {
      content.style.transform = "";
      card.classList.remove("journal-card-revealed");
      if (journalRevealedCard === card) journalRevealedCard = null;
    }
    card = null;
    content = null;
  }
}

// ---------------------------------------------------------------------------
// Swipe-to-navigate — a real two-pane carousel drag between the 4 main tabs
// (Dashboard/Progress/Discover/Saved, left to right), live 1:1 finger
// tracking exactly like initJournalSwipe above (same Pointer Events +
// axis-lock approach), just horizontal-across-the-whole-screen instead of
// one list card. Both the outgoing AND incoming view are shown and dragged
// together (see .view-dragging in style.css) rather than only sliding the
// current screen away, since that's what actually reads as "native" here —
// a single-pane drag with nothing sliding in behind it looks like the
// content is being dragged off a ledge, not paged through.
// ---------------------------------------------------------------------------
const TAB_ORDER = ["dashboard", "progress", "discover", "saved"];
const TAB_SWIPE_COMMIT_FRACTION = 0.3; // dragged this fraction of the screen width auto-commits
const TAB_SWIPE_COMMIT_PX_MAX = 130; // ...capped, so a commit never demands an unreasonably long drag on a tablet-wide viewport
const TAB_SWIPE_COMMIT_VELOCITY = 0.45; // px/ms — a fast flick commits even under the distance threshold
// The velocity path above is judged on distance/time — a very short, quick
// touch-and-lift (barely past the 10px axis-lock in onTabSwipeMove) can
// still read as a high px/ms rate simply because the elapsed time is tiny,
// even though the actual finger travel was negligible. Committing from that
// means animating the FULL remaining width in one shot from a barely-there
// starting offset — a big, sudden jump that doesn't feel continuous with
// what the user's finger actually did, which is exactly what reads as
// "I dragged just a bit and it switched." Gating the velocity path behind a
// real minimum distance (well past the axis-lock threshold, but still a
// small/quick gesture) means only a genuine flick — not gesture noise —
// can commit without also crossing the distance threshold on its own.
const TAB_SWIPE_COMMIT_MIN_FLICK_PX = 28;
const TAB_SWIPE_EDGE_RESIST = 0.35; // rubber-band damping when dragging past the first/last tab (nowhere to go)
// Visual breathing room between the outgoing and incoming panes while
// they're both on screen — without this, the two panes sit flush edge-to-
// edge (separated by exactly one pane-width) and read as a single
// continuous strip rather than two distinct pages sliding past each other.
// Only affects PANE SEPARATION (see paneOffset below, used everywhere one
// pane is positioned relative to the other) — never the pane's own
// .style.width pin, and never the gesture-distance math (commit distance,
// velocity, nav-indicator progress), which all stay screen-relative and
// unaffected by this.
const TAB_SWIPE_GAP_PX = 16;
// Settle duration scales with how far a pane actually has left to travel
// (see settleTabSwipe's own remaining-distance calc) instead of being one
// fixed number regardless of distance — the same "don't animate a big jump
// out of a small gesture" reasoning as TAB_SWIPE_COMMIT_MIN_FLICK_PX above,
// applied to the release snap instead of the commit decision. A release
// that's already 90% of the way across (a fast flick, or a slow drag
// released right near the edge) finishes almost immediately; a full-width
// swing (an early cancel, or a commit from just past the axis lock) still
// gets the full duration. Constant VELOCITY instead of constant DURATION —
// the same thing native iOS/Android page-swipe transitions do, and why
// their release snap never feels like it's dragging out a short flick or
// rushing a long one.
const TAB_SWIPE_SETTLE_MS_MAX = 280;
const TAB_SWIPE_SETTLE_MS_MIN = 140; // floor so an already-mostly-there flick still finishes as a smooth glide, not a jump-cut
// Deliberately excluded from starting a tab-swipe: horizontal-scroll strips
// that already own left/right drags on their own axis (a tab-swipe stealing
// the gesture would make those unusable), and journal cards, which already
// have their own horizontal swipe-to-delete (initJournalSwipe above) —
// letting both listeners race for the same drag would be ambiguous at best.
// .discover-filter-chips covers all three Discover filter strips (recipes'
// goal row, recipes' tag row, plans' goal row) since the goal rows carry
// both classes — same reasoning as .journal-filters: a scrollable pill row
// this close to the left edge would otherwise arm the tab-swipe on the very
// first horizontal pointermove, dragging the whole view instead of
// scrolling the pills (and reads exactly like a page reload/navigation).
const TAB_SWIPE_EXCLUDE_SELECTOR = ".journal-filters, .discover-recommended-strip, .ai-coach-suggestions, .journal-card, .discover-filter-chips";

function initTabSwipe() {
  let outgoingView = null;
  let incomingView = null;
  let outgoingBtn = null;
  let incomingBtn = null;
  let direction = 0; // -1 = dragging toward the next tab (finger moving left), 1 = toward the previous tab
  let pendingTargetView = null;
  let width = 0;
  let paneOffset = 0; // width + TAB_SWIPE_GAP_PX — see that constant's own comment
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let axis = null; // null while undecided, then locked to "x" or "y"
  let previousMinHeight = "";
  // Cached once per drag (armDrag) instead of re-read on every pointermove —
  // .bottom-nav is position: fixed and nav-btn columns don't move mid-drag,
  // so re-measuring them per move bought nothing except a forced synchronous
  // layout (write the view's transform, then immediately read
  // getBoundingClientRect back) on every single pointermove event, i.e. real
  // layout thrashing on the hottest path in this whole gesture.
  let navIndicatorFromX = 0;
  let navIndicatorToX = 0;
  // rAF-batches the actual transform writes below (armDrag/settleTabSwipe's
  // own transform writes are one-shot, not part of this — only the
  // continuous per-pointermove hot path is batched). pointermove can fire
  // multiple times per animation frame (high-frequency touch sampling vs a
  // 60Hz display, or just a fast finger), and writing style.transform
  // straight from the event handler means every one of those extra events
  // does its own style recalc for a value the next event immediately
  // overwrites before a frame is ever painted — pure wasted main-thread
  // work on the hottest path in this whole gesture, and exactly the kind of
  // thrashing that reads as jank rather than a steady 60fps follow. Coalescing
  // to "remember the latest pointer position, apply it once per frame" is
  // the standard fix for a drag-follows-finger interaction like this one.
  let dragFrameId = null;
  let latestDx = 0;
  // outgoingView's current live transform X, kept in sync by applyDragFrame
  // on every frame — settleTabSwipe reads this to know how far the pane
  // actually has left to travel to its settle target, so it can scale the
  // release animation's duration to that remaining distance (see
  // TAB_SWIPE_SETTLE_MS_MAX/_MIN's own comment) instead of always
  // animating the same fixed duration regardless of how close it already
  // is. Zeroed at the start of each drag (armDrag) since a fresh drag
  // always starts from the resting position (offset 0).
  let currentOffset = 0;

  function navButtonFor(view) {
    return document.querySelector(`.nav-btn[data-view="${view}"]`);
  }

  el("app").addEventListener("pointerdown", (e) => {
    // Animation lock: refuse to arm a new drag while the previous swipe is
    // still dragging OR settling (isTabSwipeActive stays true across both —
    // see its own comment in ui.js). A rapid swipe-swipe-swipe sequence hits
    // this every time it lands on the second finger-down before the first
    // gesture's settle transition has actually finished; nothing has moved
    // yet at this point (this is the entry point, before any state changes),
    // so there's nothing to snap back — the touch is simply not captured as
    // a swipe and the app stays exactly where the in-flight settle leaves it.
    if (isTabSwipeActive()) return;
    if (el("app").classList.contains("no-scroll")) return; // a sheet is open — swiping the page underneath it would be surprising
    const tutorialOverlay = el("tutorial-overlay");
    if (tutorialOverlay && !tutorialOverlay.hidden) return;
    if (e.target.closest(TAB_SWIPE_EXCLUDE_SELECTOR)) return;
    const view = e.target.closest(".view:not([hidden])");
    if (!view) return;

    outgoingView = view;
    outgoingBtn = document.querySelector(".nav-btn.active");
    startX = e.clientX;
    startY = e.clientY;
    startTime = performance.now();
    axis = null;
    incomingView = null;
    incomingBtn = null;
    direction = 0;
    window.addEventListener("pointermove", onTabSwipeMove);
    window.addEventListener("pointerup", onTabSwipeUp);
    window.addEventListener("pointercancel", onTabSwipeCancel);
  });

  function armDrag(dx) {
    currentOffset = 0; // a fresh drag always starts from the resting position
    const appRect = el("app").getBoundingClientRect();
    const outgoingRect = outgoingView.getBoundingClientRect();
    width = outgoingRect.width || window.innerWidth;
    paneOffset = width + TAB_SWIPE_GAP_PX;
    // Where this view's top edge ALREADY sits, relative to .app's own top
    // edge — needed because `.view-dragging` (style.css) can't bake in a
    // fixed top offset the way it does `left`/`right` (--app-h-pad):
    // `.app-header` sits above every `.view` in the DOM (both siblings
    // inside `.app`) with its own rendered height plus `margin-bottom:
    // 20px`, and that header height isn't a fixed constant — i18n string
    // length, avatar visibility, etc. can all change it — so it has to be
    // measured fresh every drag, not baked into CSS. Without this, `top:0`
    // (style.css's own bare fallback) puts the dragged pane at .app's OWN
    // top edge, well above where it actually sits in flow, overlapping the
    // header — the exact "the tab jumps up and gets stuck near the header"
    // bug this fixes.
    const topOffset = outgoingRect.top - appRect.top;
    direction = dx < 0 ? -1 : 1;
    const currentIndex = TAB_ORDER.indexOf(outgoingBtn?.dataset.view);
    const targetIndex = currentIndex + (direction === -1 ? 1 : -1);
    const targetView = TAB_ORDER[targetIndex];
    pendingTargetView = targetView || null;

    if (targetView) {
      // Progress's and Discover's lazy-loads both trigger here (the instant
      // the drag direction — and so the target tab — is known), not in the
      // commit handler, so a real network fetch has the whole drag+settle
      // duration to resolve instead of starting from scratch right as the
      // gesture commits — same convention switchView() itself follows for a
      // plain tap. Both modules guard their own DOM-mutating re-render
      // against landing mid-drag internally (runOrDeferDuringSwipe, ui.js —
      // see progress.js's renderFromCache and discover.js's loadRecipes/
      // renderRecommended), so starting either this early is safe even
      // though this view is about to spend the whole gesture live-dragged
      // (position: absolute + a per-frame transform) before it's back in
      // normal flow.
      if (targetView === "progress") {
        renderProgress(state.targets, state.logs, state.savedMeals);
        renderAnalyticsInsights();
      }
      else if (targetView === "discover") onDiscoverTabOpened();
      incomingView = el(`view-${targetView}`);
      incomingBtn = navButtonFor(targetView);

      // Read both nav-btn positions once, up front, alongside the height
      // measurements below (also reads) — grouped before any of this
      // function's style writes so this doesn't force its own extra layout
      // on top of theirs.
      const navRect = document.querySelector(".bottom-nav").getBoundingClientRect();
      navIndicatorFromX = outgoingBtn.getBoundingClientRect().left - navRect.left;
      navIndicatorToX = incomingBtn.getBoundingClientRect().left - navRect.left;

      // .app's own rect, NOT outgoingView's — NOT Math.max(incomingHeight,
      // outgoingHeight) the way switchView's own cross-fade height-freeze
      // does it just above, either. Two separate reasons:
      // 1. That Math.max exists there to make two CROSS-FADED (View
      //    Transition) snapshots the same height so neither has to visibly
      //    stretch/squish into the other mid-blend — it does not apply
      //    here. A drag never overlays the two panes in place; it slides
      //    them past each other side by side, so there's nothing to
      //    blend-stretch in the first place. Pulling incomingHeight into
      //    this Math.max only pinned the page to whichever tab happens to
      //    be taller the INSTANT a drag arms — before the user has dragged
      //    far enough to even see it, let alone commit to it — which on
      //    real content (a short Dashboard vs. a long, many-card Discover
      //    feed, say) reads exactly like "the page suddenly got bigger the
      //    moment I touch a tab."
      // 2. `outgoingView.getBoundingClientRect().height` is only the
      //    `<main>` element's own content height — it does NOT include
      //    `.app`'s own 20px-top/130px-bottom padding wrapped around it,
      //    which the page's REAL current height (what body.style.minHeight
      //    needs to preserve) already includes. Pinning to that narrower
      //    number instead of `.app`'s own height UNDERSHOOTS by exactly
      //    that padding whenever the current tab's content is taller than
      //    one screen — the page would visibly SHRINK by ~150px the
      //    instant a drag arms, the same jarring "size changed mid-touch"
      //    symptom in the other direction. `.app`'s own rect already nets
      //    both the content height AND its padding AND its `min-height:
      //    100vh/100dvh` floor in one read, matching the page's actual
      //    current on-screen size exactly.
      previousMinHeight = document.body.style.minHeight;
      document.body.style.minHeight = `${appRect.height}px`;

      incomingView.classList.add("view-dragging");
      incomingView.style.transition = "none";
      // Explicit pixel width/top pins, not left-to-imply-them-every-frame
      // from `.view-dragging`'s own CSS alone (style.css). `width` and
      // `topOffset` here are this view's PRE-drag measurements — taken
      // while it was still a plain in-flow child of `.app`, i.e. its
      // normal resting geometry — and `.view-dragging`'s `left/right:
      // var(--app-h-pad)` was specifically chosen (see that rule's own
      // comment) to resolve to that same width, so pinning it explicitly
      // doesn't change anything visually; it just means an engine that
      // hasn't fully settled this element's layout before the next
      // transform-only frame lands (it was `display:none` a moment ago,
      // and it's about to be translated every frame via a compositor-only
      // property) reads a number instead of re-deriving it on every recalc
      // — `.discover-grid`'s own `auto-fill` column count is the most
      // exposed to that derivation transiently disagreeing with the real
      // resting width mid-drag. `top` has no CSS equivalent at all (see
      // topOffset's own comment above) — this is its only source.
      incomingView.style.width = `${width}px`;
      incomingView.style.top = `${topOffset}px`;
      incomingView.hidden = false;
      incomingView.style.transform = `translate3d(${direction === -1 ? paneOffset : -paneOffset}px, 0, 0)`;
    }

    outgoingView.classList.add("view-dragging");
    outgoingView.style.transition = "none";
    outgoingView.style.width = `${width}px`; // see incomingView's own width/top comment just above
    outgoingView.style.top = `${topOffset}px`;
    el("nav-indicator").style.transition = "none";
    setTabSwipeActive(true);
  }

  function updateIndicatorForDrag(progress) {
    if (!incomingBtn) return;
    const indicator = el("nav-indicator");
    if (!indicator) return;
    indicator.style.transform = `translateX(${navIndicatorFromX + (navIndicatorToX - navIndicatorFromX) * progress}px)`;
  }

  function onTabSwipeMove(e) {
    if (!outgoingView) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!axis) {
      // A stricter ratio than a plain |dx| > |dy| (see initJournalSwipe's
      // own 6px version above) — this gesture spans the whole screen and
      // preempts native scrolling the instant it locks, so it deliberately
      // demands a clearly-more-horizontal-than-vertical drag before
      // committing to that, rather than a bare majority.
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      axis = Math.abs(dx) > Math.abs(dy) * 1.5 ? "x" : "y";
      if (axis === "x") armDrag(dx);
    }
    if (axis !== "x") return; // a vertical scroll — let the page handle it natively, don't fight it
    e.preventDefault();

    latestDx = dx;
    if (dragFrameId == null) dragFrameId = requestAnimationFrame(applyDragFrame);
  }

  function applyDragFrame() {
    dragFrameId = null;
    if (!outgoingView) return; // the drag may have already settled by the time this frame's callback runs
    // The target tab (if any) was picked once, at lock time, based on the
    // drag's direction at that instant — clamped here so a finger that
    // reverses mid-drag can only ease back toward 0, never past it into the
    // opposite direction, which is the one side nothing was ever armed for
    // (it would drag the outgoing view away from a target that isn't there).
    const boundedDx = direction === -1 ? Math.min(latestDx, 0) : Math.max(latestDx, 0);
    const resisted = incomingView ? boundedDx : boundedDx * TAB_SWIPE_EDGE_RESIST; // rubber-band when there's nowhere to go
    currentOffset = resisted;
    outgoingView.style.transform = `translate3d(${resisted}px, 0, 0)`;
    if (incomingView) {
      const offset = direction === -1 ? paneOffset : -paneOffset;
      incomingView.style.transform = `translate3d(${offset + resisted}px, 0, 0)`;
      updateIndicatorForDrag(Math.min(Math.abs(resisted) / width, 1));
    }
  }

  function resetSwipeState() {
    outgoingView = null;
    incomingView = null;
    outgoingBtn = null;
    incomingBtn = null;
    pendingTargetView = null;
    axis = null;
  }

  function settleTabSwipe(commit) {
    window.removeEventListener("pointermove", onTabSwipeMove);
    window.removeEventListener("pointerup", onTabSwipeUp);
    window.removeEventListener("pointercancel", onTabSwipeCancel);
    // A frame requested by the last pointermove(s) before release can still
    // be pending. Cancelling it (so it can't fire LATER and stomp the
    // settle transform below with a stale mid-drag position) is only half
    // of what's needed — applyDragFrame() must also run RIGHT NOW,
    // synchronously, because it may never have run at all yet for this
    // gesture: on a fast flick (press, short move, release, all within a
    // single ~16ms frame — a completely normal way to swipe on a real
    // phone, and exactly what TAB_SWIPE_COMMIT_VELOCITY exists to detect),
    // pointerup can fire before the browser ever gets to paint the ONE
    // rAF frame onTabSwipeMove scheduled. outgoingView's transform is only
    // ever written inside that frame — never anywhere else — so without
    // this, it stays at its untouched, untransformed resting position (as
    // if the finger never moved) right up to the moment the code below
    // starts a transition FROM "wherever it currently is" TO its settle
    // target. Transitioning from that stale, wrong start position is
    // exactly what put the outgoing and incoming panes on top of each
    // other mid-snap — the "destination page sticks to the current tab"
    // bug. Flushing here guarantees the settle transition always starts
    // from the pane's real, current, correctly-offset visual position.
    if (dragFrameId != null) {
      cancelAnimationFrame(dragFrameId);
      dragFrameId = null;
      applyDragFrame();
    }

    if (axis !== "x" || !outgoingView) {
      resetSwipeState();
      return;
    }

    const view = outgoingView;
    const incoming = incomingView;
    const targetView = pendingTargetView;
    const willCommit = commit && !!incoming;

    // Forces the browser to actually commit/paint the transform applyDragFrame()
    // just wrote (with transition: none) as a real, observed "before" state,
    // before the transition-enabling write below changes transition AND
    // transform again. Without this, both writes land in the same
    // synchronous script with no rendering opportunity between them and get
    // coalesced into one style recalculation — the transition then has no
    // distinct prior value to interpolate from and can start from the
    // pane's stale pre-drag position instead of where it actually is, which
    // is what let the outgoing and incoming panes visibly overlap mid-snap
    // (this was reproducible even with applyDragFrame() above in place,
    // confirmed by forcing an artificially long settle duration and
    // screenshotting mid-transition). offsetHeight (not getBoundingClientRect)
    // since only the layout-flush side effect is wanted, not its value.
    void view.offsetHeight;
    if (incoming) void incoming.offsetHeight;

    // Scaled to how far the pane actually has left to travel — see
    // TAB_SWIPE_SETTLE_MS_MAX/_MIN's own comment for why (constant
    // velocity, not constant duration). targetOffset/currentOffset are
    // both outgoingView's own coordinate space (0 = resting, ±paneOffset =
    // fully off-screen, gap included); incoming always mirrors it at a
    // constant `paneOffset` separation, so this one distance covers both
    // panes. Denominator is still plain `width` (not paneOffset) — this is
    // scaling against the same screen-relative sense of "distance" the
    // commit decision itself uses, not the gap-inflated pane geometry;
    // Math.min below already clamps the result regardless.
    const targetOffset = willCommit ? (direction === -1 ? -paneOffset : paneOffset) : 0;
    const remaining = Math.abs(targetOffset - currentOffset);
    const settleMs = Math.max(TAB_SWIPE_SETTLE_MS_MIN, Math.min(TAB_SWIPE_SETTLE_MS_MAX, TAB_SWIPE_SETTLE_MS_MAX * (remaining / width)));

    view.style.transition = `transform ${settleMs}ms var(--ease)`;
    view.style.transform = willCommit ? `translate3d(${direction === -1 ? -paneOffset : paneOffset}px, 0, 0)` : "translate3d(0, 0, 0)";
    if (incoming) {
      incoming.style.transition = `transform ${settleMs}ms var(--ease)`;
      incoming.style.transform = willCommit ? "translate3d(0, 0, 0)" : `translate3d(${direction === -1 ? paneOffset : -paneOffset}px, 0, 0)`;
    }
    // Explicitly driven to the same duration/easing as the view slide above,
    // to the exact cached target position — not cleared to "" here. Clearing
    // it fell back to .nav-indicator's own CSS default (transform 0.4s),
    // which visibly disagreed with the view's settle duration: on a commit
    // the pill would still be catching up to its final spot well after the
    // view had already finished sliding (updateNavChrome() below only fires
    // once finishSettle's transitionend/timeout resolves), reading as a
    // stray second "snap" tacked onto the end of the gesture.
    if (incoming) {
      const indicator = el("nav-indicator");
      indicator.style.transition = `transform ${settleMs}ms var(--ease)`;
      indicator.style.transform = `translateX(${willCommit ? navIndicatorToX : navIndicatorFromX}px)`;
    }

    let finished = false;
    const finishSettle = () => {
      if (finished) return; // the real transitionend and the safety-net timeout below race — only the first should act
      finished = true;
      [view, incoming].forEach((v) => {
        if (!v) return;
        v.classList.remove("view-dragging");
        v.style.transition = "";
        v.style.transform = "";
        v.style.width = ""; // clears the drag-start width/top pins (armDrag) — back to normal in-flow sizing/position
        v.style.top = "";
      });
      document.body.style.minHeight = previousMinHeight;
      if (willCommit) {
        switchView(targetView, { skipTransition: true });
      } else if (incoming) {
        incoming.hidden = true;
      }
      // Hand the indicator back to its normal CSS-driven transition now that
      // it's already sitting at the correct resting spot (either the synced
      // settle above, or updateNavIndicator() inside switchView's
      // updateNavChrome() call just above) — a future plain tap should ease
      // on the component's own default timing, not this gesture's.
      el("nav-indicator").style.transition = "";
      // After the DOM/style cleanup above, not before — a deferred
      // mid-drag re-render (see progress.js's runOrDeferDuringSwipe) flushes
      // synchronously the instant this flips false, so anything still
      // mid-cleanup at that point would have its DOM mutated out from under
      // it.
      setTabSwipeActive(false);
    };

    // transitionend, not a duration-matched setTimeout alone — fires on the
    // exact frame the slide visually finishes rather than an approximation
    // that can drift a few ms from real main-thread scheduling, which is
    // exactly what reads as "snaps into place a beat early/late." Also
    // correctly tracks prefers-reduced-motion for free: the app's global
    // `transition-duration: 0.01ms !important` override still fires this
    // event, just almost immediately, whereas a fixed setTimeout would keep
    // waiting out its full nominal duration regardless.
    // e.target/propertyName filtered — this listener sits directly on the
    // view element, and transition events bubble, so a completely unrelated
    // DESCENDANT finishing its OWN transform transition (a macro bar filling
    // in, say) must not be mistaken for this view's own slide finishing.
    // {once: true} is deliberately NOT used here: it would remove the
    // listener on the FIRST transitionend received regardless of whether
    // the filter above matched, which could consume it on a bubbled
    // descendant event and leave nothing listening for the real one.
    const pending = new Set([view, incoming].filter(Boolean));
    pending.forEach((v) => {
      const onTransitionEnd = (e) => {
        if (e.target !== v || e.propertyName !== "transform") return;
        v.removeEventListener("transitionend", onTransitionEnd);
        pending.delete(v);
        if (pending.size === 0) finishSettle();
      };
      v.addEventListener("transitionend", onTransitionEnd);
    });
    // Safety net only — transitionend not firing at all (element removed,
    // interrupted by something outside this gesture's control, etc.) must
    // never permanently strand the drag's cleanup.
    setTimeout(finishSettle, settleMs + 150);

    resetSwipeState();
  }

  function onTabSwipeUp(e) {
    if (axis !== "x" || !outgoingView) {
      settleTabSwipe(false);
      return;
    }
    // Bounded the same way onTabSwipeMove clamps the live visual drag — a
    // flick that reverses right at release should be judged on how far/fast
    // it actually traveled in the locked direction (what's on screen),
    // not the raw signed delta, which a late reversal could otherwise
    // inflate into a false commit.
    const dx = e.clientX - startX;
    const boundedDx = direction === -1 ? Math.min(dx, 0) : Math.max(dx, 0);
    const elapsed = Math.max(performance.now() - startTime, 1);
    const velocity = Math.abs(boundedDx) / elapsed;
    const commitDistance = Math.min(width * TAB_SWIPE_COMMIT_FRACTION, TAB_SWIPE_COMMIT_PX_MAX);
    const traveled = Math.abs(boundedDx);
    const commit = traveled > commitDistance || (traveled > TAB_SWIPE_COMMIT_MIN_FLICK_PX && velocity > TAB_SWIPE_COMMIT_VELOCITY);
    settleTabSwipe(commit);
  }

  function onTabSwipeCancel() {
    settleTabSwipe(false);
  }
}

// ---------------------------------------------------------------------------
// Today's Journal — filter chips + sort toggle. Both are pure display-order/
// subset choices over state.logs, never a separate fetch — see ui.js's
// journalPeriodOf for the meal-period heuristic the filter values line up
// with (there's no meal-type column on the log model to filter on directly).
// ---------------------------------------------------------------------------
let journalFilter = "all"; // "all" | "breakfast" | "lunch" | "dinner" | "snacks"
let journalSortAsc = false; // false = newest first (the default)

function journalEntriesFor(logs) {
  const filtered = journalFilter === "all" ? logs : logs.filter((log) => journalPeriodOf(log) === journalFilter);
  return [...filtered].sort((a, b) => {
    const diff = new Date(a.logged_at) - new Date(b.logged_at);
    return journalSortAsc ? diff : -diff;
  });
}

el("journal-filters").addEventListener("click", (e) => {
  const filterBtn = e.target.closest("[data-journal-filter]");
  if (filterBtn) {
    journalFilter = filterBtn.dataset.journalFilter;
    el("journal-filters")
      .querySelectorAll("[data-journal-filter]")
      .forEach((b) => b.classList.toggle("active", b === filterBtn));
    render();
    return;
  }
  if (e.target.closest("#journal-sort-btn")) {
    journalSortAsc = !journalSortAsc;
    el("journal-sort-btn").classList.toggle("journal-sort-asc", journalSortAsc);
    render();
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
  const dayLogs = state.logs.filter((l) => l.log_date === day.date);
  renderDayDetailList(dayLogs);
  renderDayDetailTotals(dayLogs);
  openSheet("day-detail-sheet");
}

el("day-detail-add-btn").addEventListener("click", () => {
  if (!dayDetailDate) return;
  // Only actually locked if dayDetailDate resolves to today (Daily History
  // can be opened for today too) — a genuinely backdated past day is never
  // affected by the lock, exactly like the backend's own rule.
  if (blockIfDayLocked(dayDetailDate)) return;
  openManualSheet(null, dayDetailDate);
});

// "+ From Saved" — the same instant-log convenience the main Saved tab
// already offers for today, extended to whichever historical day the
// day-detail sheet is currently showing. Reuses submitNewLog (POST /logs
// with an explicit log_date) rather than the fast POST /meals/{id}/log path
// logSavedMealOptimistic calls elsewhere: that endpoint always writes to
// *today* server-side (backend/routers/meals.py::log_saved_meal has no
// log_date param at all) and would need its own backdating support to be
// reusable here, whereas POST /logs already validates + backdates correctly
// for every other entry point (manual, Smart Tools) — no backend change
// needed, just building the same payload shape those already do.
el("day-detail-saved-btn").addEventListener("click", () => {
  if (!dayDetailDate) return;
  if (blockIfDayLocked(dayDetailDate)) return;
  el("day-detail-saved-title").textContent = t("dayDetail.savedPickerTitle", { date: formatShortDate(dayDetailDate) });
  el("day-detail-saved-date-pill-text").textContent = t("dayDetail.addingToDate", { date: formatShortDate(dayDetailDate) });
  renderDaySavedPickerList(allSavedMealsSorted());
  openSheet("day-detail-saved-sheet");
});

el("day-detail-saved-list").addEventListener("click", (e) => {
  const item = e.target.closest(".log-item");
  if (!item || !dayDetailDate) return;
  const meal = state.savedMeals.find((m) => m.id === item.dataset.id);
  if (!meal) return;
  const targetDate = dayDetailDate;
  const servings = meal.servings > 0 ? meal.servings : 1;
  // Same one-serving scaling as the plain Saved tab's "log-saved" handler
  // below (a multi-serving recipe logs one portion, not the whole batch) —
  // duplicated rather than shared since that handler's payload also carries
  // today-specific side effects (loggedFoodToastMessage's reward-toast
  // check) this backdated path deliberately skips in favor of the date
  // confirmation toast below.
  const payload =
    servings > 1
      ? {
          food_name: meal.name,
          weight_g: roundTo1(meal.weight_g / servings),
          calories: Math.round(meal.calories / servings),
          protein: roundTo1(meal.protein / servings),
          carbs: roundTo1(meal.carbs / servings),
          fats: roundTo1(meal.fats / servings),
          fiber: roundTo1((meal.fiber || 0) / servings),
          source: "saved_meal",
          log_date: targetDate,
        }
      : {
          food_name: meal.name,
          weight_g: meal.weight_g,
          calories: meal.calories,
          protein: meal.protein,
          carbs: meal.carbs,
          fats: meal.fats,
          fiber: meal.fiber,
          sugar: meal.sugar,
          sodium: meal.sodium,
          ingredients: meal.ingredients,
          source: "saved_meal",
          log_date: targetDate,
        };
  closeSheet("day-detail-saved-sheet");
  vibrate(12);
  showToast(t("dayDetail.loggedToDate", { date: formatShortDate(targetDate) }), "success");
  submitNewLog(payload);
});

el("day-detail-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  // domKey (the <li>'s data-id) can be a stable _domKey rather than the
  // log's current real id — see renderDayDetailList's own getId comment in
  // ui.js. Must resolve back through the actual log object (same
  // findLogByDomKey helper the Today's Journal list above uses, for the
  // exact same reason) before touching state.logs or the API: filtering/
  // calling by domKey directly silently no-ops on a backdated item that's
  // already been reconciled to its real server id (edit opens nothing,
  // delete's optimistic removeNow() fails to filter it out of state.logs
  // and the API call 500s on a non-UUID id).
  const domKey = btn.closest(".log-item").dataset.id;
  const log = findLogByDomKey(domKey);
  if (!log) return;

  if (btn.dataset.action === "edit") {
    openManualSheet(log);
  } else if (btn.dataset.action === "delete") {
    await animateItemRemoval("day-detail-list", domKey);
    vibrate(10);
    // Snapshot taken here, after the animation await — not before it — so a
    // second rapid delete of a different item that completes its own
    // removeNow() during this item's animation delay isn't erased if this
    // item's own delete gets undone later (see deleteJournalEntry's own
    // comment on this same race in the Today's Journal list above).
    const previousLogs = state.logs;
    deleteWithUndo({
      removeNow: () => {
        state.logs = state.logs.filter((l) => l.id !== log.id);
        render();
      },
      restore: () => {
        state.logs = previousLogs;
        render();
      },
      callDelete: () => api.deleteLog(log.id),
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

// Reopen Day — no confirmation sheet (see reopen_day's own docstring in
// backend/routers/day.py for why: unlike ending, it's trivially reversible).
// `btn.disabled` both prevents a double-submit from a rapid double-tap and,
// since the button is swapped for "End day" the instant state.dayState
// updates (syncEndDayButton, called from render()), naturally can't overlap
// with a fresh end_day request either — the two actions can never race each
// other because only one of the two buttons is ever in the DOM as visible at
// a time.
el("reopen-day-btn").addEventListener("click", async () => {
  const btn = el("reopen-day-btn");
  if (btn.disabled || !state.targets) return;
  btn.disabled = true;
  try {
    state.dayState = await api.reopenDay();
    render();
    showToast(t("endDay.reopenedToast"), "success");
  } catch (err) {
    showToast(err.message || t("endDay.couldNotReopen"), "error");
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
  // Called after favoriting a new meal from submitNewLog — a brand-new
  // candidate the Suggestions card's food ranking should be able to pick up
  // immediately, not just after the next Progress-tab visit.
  setSuggestionsContext({ savedMeals: state.savedMeals });
}

// Saved Meals is now strictly Meals/Products — reusable nutrition templates,
// managed with plain edit/delete like any other list. Recent Scans (photo
// history) used to have a third pill here sharing this section with a
// completely different data source (local IndexedDB photos, not
// state.savedMeals); it's moved out entirely and merged into Today's
// Journal on the dashboard instead (see renderJournal/getScanThumbnailUrl),
// where a scan photo actually belongs next to the log it documents rather
// than sitting in a separate gallery beside meal *templates*.
wirePillTabs("saved-type-tabs", (type) => {
  state.savedMealsTab = type;
  renderSavedMeals(savedMealsForActiveTab());
});

// Intelligent Suggestions toggle — collapsed by default (see its own
// comment in index.html for why this moved here from the Progress tab).
// Purely a show/hide; suggestions.js already keeps the panel's contents
// live via setSuggestionsContext() regardless of whether it's visible.
el("saved-suggestions-toggle").addEventListener("click", () => {
  const toggle = el("saved-suggestions-toggle");
  const expanded = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-expanded", String(!expanded));
  el("saved-suggestions-panel").classList.toggle("is-expanded", !expanded);
  vibrate(8);
});

el("saved-meals-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest(".log-item").dataset.id;

  if (btn.dataset.action === "log-saved") {
    const meal = state.savedMeals.find((m) => m.id === id);
    if (!meal) return;
    // Guarded here (not just inside submitNewLog/logSavedMealOptimistic):
    // both branches below show their own "Logged!" toast before calling
    // into either function, which would otherwise fire right alongside the
    // day-locked toast.
    if (blockIfDayLocked()) return;
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
    await animateItemRemoval("saved-meals-list", id);
    vibrate(10);
    // See deleteJournalEntry's comment on why this snapshot is taken after
    // the animation await, not before it.
    const previousSavedMeals = state.savedMeals;
    deleteWithUndo({
      removeNow: () => {
        state.savedMeals = state.savedMeals.filter((m) => m.id !== id);
        renderSavedMeals(savedMealsForActiveTab());
        // Removing (or, on undo below, restoring) a favorite can remove the
        // exact meal the Suggestions card was showing — without this it kept
        // suggesting an already-deleted meal until the next Progress-tab
        // visit re-fetched everything from scratch.
        setSuggestionsContext({ savedMeals: state.savedMeals });
      },
      restore: () => {
        state.savedMeals = previousSavedMeals;
        renderSavedMeals(savedMealsForActiveTab());
        setSuggestionsContext({ savedMeals: state.savedMeals });
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
  // "Member since" — created_at is optional on the wire (see
  // TargetsResponse's own comment: it's stitched on server-side from
  // Supabase Auth, not a real profiles column), and a not-yet-migrated
  // backend or a genuinely malformed date string both need to fail toward
  // "just hide it" rather than showing "Member since Invalid Date" or
  // throwing and breaking the rest of this sync.
  const memberSinceEl = el("profile-member-since");
  const joined = targets.created_at ? new Date(targets.created_at) : null;
  const joinedValid = joined && !Number.isNaN(joined.getTime());
  memberSinceEl.hidden = !joinedValid;
  if (joinedValid) {
    memberSinceEl.textContent = t("settings.memberSince", {
      date: joined.toLocaleDateString(getLocale(), { year: "numeric", month: "long" }),
    });
  }
}

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
  updateLangButtons();
  resetPillTabs("export-lang-tabs", getLanguage());
  resetPillTabs("goal-type-tabs", state.targets.goal_type || "maintain");
  updateSettingsGoalSummary();
  resetSettingsAccordionDefaults();
  // Fire-and-forget: this is a live GET /ai-usage read (never blocking, and
  // never awaited) so a slow/offline network never delays the sheet itself
  // opening — aiUsage.js's own renderAIUsage() shows its own inline loading
  // state, then either the real quota bars or an inline error message once
  // the request settles.
  renderAIUsage();
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

// The gear icon is the ONLY entry point into Settings now — the header
// avatar used to open the identical sheet too, which read as a confusing
// second/duplicate settings button rather than a helpful shortcut (the two
// controls looked unrelated at a glance, so finding Settings via the avatar
// felt like an accident rather than a designed shortcut). The avatar is now
// a pure identity glance (see its plain <div>, not <button>, in index.html).
// Same tap-flourish-before-sheet-opens pattern as the FAB above (see
// FAB_PRESS_ANIMATION_MS's comment) — style.css's .icon-btn.pulse reuses the
// FAB's own flash/icon-spin/ring-burst animation vocabulary, scaled down for
// this 44px circle, held just long enough to actually be seen before the
// sheet's slide-up covers it.
const ICON_BTN_PRESS_ANIMATION_MS = 220;
let settingsPressPending = false;

el("settings-btn").addEventListener("click", () => {
  if (settingsPressPending) return;
  const btn = el("settings-btn");
  btn.classList.remove("pulse");
  void btn.offsetWidth;
  btn.classList.add("pulse");
  vibrate(10);
  if (prefersReducedMotion) {
    openSettingsSheet();
    return;
  }
  settingsPressPending = true;
  setTimeout(() => {
    settingsPressPending = false;
    openSettingsSheet();
  }, ICON_BTN_PRESS_ANIMATION_MS);
});

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
});

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
    // Same reasoning as every field above: PUT /targets applies Pydantic
    // defaults to anything OMITTED from the payload (not just anything
    // explicitly null), so leaving these out of a partial update (avatar,
    // display name, macro-lock) would silently reset a saved age/height/sex/
    // activity_level back to unset/"moderate" — see analytics_service.py's
    // TargetsUpdate. ?? null/undefined-safe: these are all still-optional
    // profile columns (sql/schema.sql) that may not exist on this project
    // yet, or simply never set by this user.
    age: state.targets.age ?? null,
    height_cm: state.targets.height_cm ?? null,
    biological_sex: state.targets.biological_sex ?? null,
    activity_level: state.targets.activity_level || "moderate",
    locked_macro: state.targets.locked_macro ?? null,
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

// ---------------------------------------------------------------------------
// About & Legal — Privacy Policy / Terms of Service / Disclaimers, all
// rendered into the one shared #legal-sheet from js/legalContent.js (the
// same content the standalone privacy.html/terms.html/disclaimers.html pages
// render, so the native sheet and the public pages Play Store requires a URL
// for can never say something different). Also opened from the sign-up
// consent checkbox's two inline links further below — same function either
// way, since it's just a docId + which sheet to show.
// ---------------------------------------------------------------------------
let openLegalDocId = null;

function renderLegalSheet(docId) {
  const doc = getLegalDoc(docId, getLanguage());
  if (!doc) return;
  el("legal-sheet-title").textContent = doc.title;
  const updatedDate = new Date(`${getLegalLastUpdated()}T00:00:00`).toLocaleDateString(getLocale(), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  el("legal-sheet-updated").textContent = t("legal.lastUpdated", { date: updatedDate });
  el("legal-sheet-body").innerHTML = renderLegalSectionsHtml(doc.sections);
}

function openLegalSheet(docId) {
  openLegalDocId = docId;
  renderLegalSheet(docId);
  openSheet("legal-sheet");
  // Same fix as settings-sheet above (see its own comment for why this has
  // to come AFTER openSheet(), not before): the sheet's DOM node is reused
  // across docs, not recreated, so without this, scrolling down into Terms,
  // closing, then opening Privacy Policy would land already scrolled down
  // instead of at the top of the new document.
  const legalSheetPanel = el("legal-sheet").querySelector(".sheet");
  if (legalSheetPanel) legalSheetPanel.scrollTop = 0;
}

// Re-renders in place if the sheet is open when the language is switched —
// the same live-update convention every other open sheet with translated
// dynamic content follows in this file, rather than leaving stale-language
// text behind until the next open.
onLanguageChange(() => {
  if (openLegalDocId && !el("legal-sheet").hidden) renderLegalSheet(openLegalDocId);
});
document.querySelectorAll("[data-legal-doc]").forEach((btn) => {
  btn.addEventListener("click", () => openLegalSheet(btn.dataset.legalDoc));
});

// Sign-up consent checkbox links (see index.html's #signup-consent-*-link) —
// wired here rather than in auth.js since this module already owns
// #legal-sheet and openLegalSheet(); auth.js only owns the checkbox's native
// `required` gating on submit. stopPropagation because both buttons live
// inside the checkbox's own <label>, whose default behavior is to forward a
// click to the labeled control — without this, tapping "Terms of Service"
// would also toggle the checkbox underneath it.
const consentTermsLink = document.getElementById("signup-consent-terms-link");
const consentPrivacyLink = document.getElementById("signup-consent-privacy-link");
if (consentTermsLink) {
  consentTermsLink.addEventListener("click", (e) => {
    e.stopPropagation();
    openLegalSheet("terms");
  });
}
if (consentPrivacyLink) {
  consentPrivacyLink.addEventListener("click", (e) => {
    e.stopPropagation();
    openLegalSheet("privacy");
  });
}

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

// Seeded from the saved profile (openSettingsSheet below) so a plain "Save
// targets" — without ever reopening the calculator — still round-trips
// whatever biometrics were already known, and updated again every time the
// calculator itself is submitted (see its own submit handler below). null
// fields (never-set biometrics) are sent through untouched: the backend's
// TargetsUpdate treats age/height_cm/biological_sex as independently
// optional, so a partial or entirely empty set here is fine.
let lastCalculatorBiometrics = null;

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
  // Cheap DOM-attribute check (closest, not a layout query) to skip out
  // before the two forced-layout reads below if this container is still
  // inside a [hidden] sheet — e.g. openSettingsSheet() calls
  // updateLangButtons() (which calls this) while settings-sheet is still
  // hidden, well before its own later, deliberately-deferred rAF call does
  // the real measurement once the sheet is actually visible. Without this,
  // that early call reads a bogus 0 (offsetWidth/offsetLeft on a
  // display:none subtree) AND forces a real synchronous layout flush of
  // whatever else openSettingsSheet just wrote to the DOM moments earlier
  // — wasted work sitting in the same critical path as the sheet's CSS
  // entrance animation trying to compute its first frame.
  if (containerEl.closest("[hidden]")) return;
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

// ---------------------------------------------------------------------------
// Auth screen — pull-string lamp theme toggle. Deliberately reuses
// THEME_STORAGE_KEY/applyTheme/getStoredTheme/resolvedTheme/updateThemeButtons
// above rather than a second parallel theme system, so a choice made here
// before signing in is already reflected the moment Settings' own switcher
// is opened, and vice versa. Only ever writes an explicit "light"/"dark" —
// toggling relative to whatever's currently *resolved* (not the raw stored
// choice) means a "system" or "amoled" user who pulls the cord lands on the
// sensible opposite of what they're actually seeing, instead of being
// force-reset to a fixed default.
// ---------------------------------------------------------------------------
const lampToggle = el("lamp-toggle");
if (lampToggle) {
  const syncLampState = () => {
    const isLight = resolvedTheme(getStoredTheme()) === "light";
    lampToggle.dataset.lampState = isLight ? "on" : "off";
    lampToggle.setAttribute("aria-pressed", String(isLight));
  };
  // "Try me ✨" hint (style.css's .lamp-hint) — a one-time nudge, not a
  // recurring nag: dismissed for good, via localStorage, the first time the
  // cord is actually pulled. Never shown again after that, even across
  // reloads/reinstalls of this same browser profile.
  const LAMP_HINT_SEEN_KEY = "ironlog_lamp_hint_seen";
  const lampHint = el("lamp-hint");
  const dismissLampHint = () => {
    if (!lampHint || lampHint.hidden) return;
    localStorage.setItem(LAMP_HINT_SEEN_KEY, "1");
    lampHint.classList.add("hint-dismissed");
    setTimeout(() => {
      lampHint.hidden = true;
    }, 450); // matches .hint-dismissed's own opacity/transform transition duration
  };
  if (lampHint && localStorage.getItem(LAMP_HINT_SEEN_KEY)) lampHint.hidden = true;
  lampToggle.addEventListener("click", () => {
    const nextChoice = resolvedTheme(getStoredTheme()) === "light" ? "dark" : "light";
    localStorage.setItem(THEME_STORAGE_KEY, nextChoice);
    applyTheme(nextChoice);
    updateThemeButtons();
    syncLampState();
    dismissLampHint();
    vibrate(15);
    // Same classList remove/reflow/add idiom as the FAB/settings-gear tap
    // flourishes elsewhere in this file — replays the CSS pull animation on
    // every tap instead of only the first.
    lampToggle.classList.remove("pulling");
    void lampToggle.offsetWidth;
    lampToggle.classList.add("pulling");
  });
  syncLampState();
}

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
  // Same resync as manual-sheet-title above — the "From Saved" picker's
  // title/date-pill are set dynamically (openDaySavedPickerSheet's own click
  // handler), never via data-i18n, so a language switch mid-sheet needs this
  // explicit resync too. Only meaningful while dayDetailDate is actually set
  // (Daily History currently open) — harmless no-op otherwise since these
  // elements are hidden either way.
  if (dayDetailDate) {
    el("day-detail-saved-title").textContent = t("dayDetail.savedPickerTitle", { date: formatShortDate(dayDetailDate) });
    el("day-detail-saved-date-pill-text").textContent = t("dayDetail.addingToDate", { date: formatShortDate(dayDetailDate) });
  }
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
  // The bottom nav's own sliding indicator used to need a resync here too
  // ("Progress"/"Progres" etc. aren't the same width in both languages, so
  // a label swap changed the active button's geometry) — moot now that the
  // nav is icon-only (see style.css's .nav-btn): every button is a fixed
  // 44px regardless of language, so the indicator's position/size no longer
  // depends on which language is active at all.
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

async function registerPdfFonts(doc) {
  // pdfFonts.js is a ~110KB module of hand-subsetted base64 font data, used
  // by nothing except this export path — a dynamic import here (rather than
  // a static top-of-file one) means that weight is only ever fetched/parsed
  // when a user actually exports, not on every single page load. addFont/
  // addFileToVFS calls themselves are per-jsPDF-instance state, not global —
  // every new export creates a fresh doc, so this always runs.
  const { NOTO_SANS_BOLD_B64, NOTO_SANS_REGULAR_B64 } = await import("./pdfFonts.js?v=20260821g");
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
    reportTitle: "Performance Report",
    eyebrow: "PERSONAL REPORT",
    generated: "Generated",
    range2: "Last 2 days",
    range3: "Last 3 days",
    range7: "Whole week",
    chipEntries: (n) => `${n} ${n === 1 ? "entry" : "entries"} logged`,
    chipActiveDays: (n) => `${n} active ${n === 1 ? "day" : "days"}`,
    summaryLabel: "Report Summary",
    page: (i, n) => `Page ${i} of ${n}`,
    source: { ai: "AI", manual: "Manual", saved_meal: "Saved meal" },
    // sodium: "Na" read as ambiguous shorthand to non-technical users (too
    // easily misread as "N/A") — spelled out in full, matching the exact
    // wording frontend/js/i18n.js already uses for "sodium" elsewhere in the
    // app, for consistency across surfaces even though this dictionary is
    // its own separate one (see PDF_STRINGS's own comment above).
    extras: { fiber: "Fiber", sugar: "Sugar", sodium: "Sodium" },
    workoutFallbackName: "Workout",
    reportSummary: {
      title: "Report Summary",
      avgCalories: "Avg. Calories",
      avgProtein: "Avg. Protein",
      totalWater: "Water Logged",
      weightChange: "Weight Change",
      weightChangeSub: "vs. start of range",
      workoutsLogged: "Workouts",
      daysActive: "Active Days",
      noData: "No data",
      setsLabel: "sets",
    },
    counts: {
      entries: (n) => `${n} ${n === 1 ? "entry" : "entries"}`,
      days: (n) => `${n} ${n === 1 ? "day" : "days"}`,
      sessions: (n, sets) => `${n} ${n === 1 ? "session" : "sessions"} · ${sets} ${sets === 1 ? "set" : "sets"}`,
    },
    sections: {
      // "Date" dropped from the row head — it's shown once per date-group
      // divider row instead (see buildExportPdf's foodLogBody), not per row.
      food: { title: "Food Log", head: ["Time", "Food", "Weight (g)", "Calories", "Protein (g)", "Carbs (g)", "Fats (g)", "Extras", "Source"] },
      summary: { title: "Daily Summary", head: ["Date", "Calories", "Protein (g)", "Carbs (g)", "Fats (g)", "Fiber (g)", "Water (ml)"] },
      weight: { title: "Body Weight", head: ["Date", "Weight (kg)", "Change"] },
      measurements: { title: "Body Measurements", head: ["Date", "Time", "Measurement", "Value", "Unit"] },
      workouts: { title: "Training Log", head: ["Time", "Exercise", "Set", "Reps", "Weight (kg)", "RPE"] },
    },
  },
  ro: {
    subtitle: "Export de date",
    reportTitle: "Raport de performanță",
    eyebrow: "RAPORT PERSONAL",
    generated: "Generat",
    range2: "Ultimele 2 zile",
    range3: "Ultimele 3 zile",
    range7: "Toată săptămâna",
    chipEntries: (n) => `${n} ${n === 1 ? "aliment înregistrat" : "alimente înregistrate"}`,
    chipActiveDays: (n) => `${n} ${n === 1 ? "zi activă" : "zile active"}`,
    summaryLabel: "Rezumatul raportului",
    page: (i, n) => `Pagina ${i} din ${n}`,
    source: { ai: "AI", manual: "Manual", saved_meal: "Masă salvată" },
    extras: { fiber: "Fibre", sugar: "Zahăr", sodium: "Sodiu" }, // see the en block's comment on sodium above
    workoutFallbackName: "Antrenament",
    reportSummary: {
      title: "Rezumatul raportului",
      avgCalories: "Media calorii",
      avgProtein: "Media proteine",
      totalWater: "Apă înregistrată",
      weightChange: "Schimbare greutate",
      weightChangeSub: "față de începutul intervalului",
      workoutsLogged: "Antrenamente",
      daysActive: "Zile active",
      noData: "Fără date",
      setsLabel: "seturi",
    },
    counts: {
      entries: (n) => `${n} ${n === 1 ? "intrare" : "intrări"}`,
      days: (n) => `${n} ${n === 1 ? "zi" : "zile"}`,
      sessions: (n, sets) => `${n} ${n === 1 ? "sesiune" : "sesiuni"} · ${sets} seturi`,
    },
    sections: {
      food: { title: "Jurnal alimentar", head: ["Ora", "Aliment", "Greutate (g)", "Calorii", "Proteine (g)", "Carbohidrați (g)", "Grăsimi (g)", "Detalii", "Sursă"] },
      summary: { title: "Rezumat zilnic", head: ["Data", "Calorii", "Proteine (g)", "Carbohidrați (g)", "Grăsimi (g)", "Fibre (g)", "Apă (ml)"] },
      weight: { title: "Greutate corporală", head: ["Data", "Greutate (kg)", "Schimbare"] },
      measurements: { title: "Măsurători corporale", head: ["Data", "Ora", "Măsurătoare", "Valoare", "Unitate"] },
      workouts: { title: "Jurnal de antrenament", head: ["Ora", "Exercițiu", "Set", "Repetări", "Greutate (kg)", "RPE"] },
    },
  },
};

// ---------------------------------------------------------------------------
// Design tokens for the report — a deliberately distinct "stamped metal
// plate" identity (brass accent + gunmetal header, playing on the app's own
// weights/plates branding) layered on top of the app's real --c-* macro
// colors (css/style.css) for everything data-related, so the report reads as
// premium without inventing a second, disconnected color language for the
// numbers themselves. All hardcoded as RGB arrays, same reason as before:
// jsPDF can't read CSS custom properties at runtime.
// ---------------------------------------------------------------------------
const PDF_INK = [10, 12, 16]; // == css/style.css's --bg
const PDF_INK_2 = [24, 27, 34]; // header gradient's lower endpoint
const PDF_BRASS = [196, 155, 61]; // the report's own signature accent — not in the app's UI, deliberately reserved for this "printed plate" identity
const PDF_BRASS_SOFT = [214, 191, 140];
const PDF_PAPER = [247, 248, 250];
const PDF_PAPER_BORDER = [230, 232, 236];
const PDF_SHADOW = [214, 216, 222]; // faux drop-shadow fill sat behind each KPI card
const PDF_MUTED = [120, 126, 138];
const PDF_TEXT = [26, 28, 34];
const PDF_HAIRLINE = [225, 227, 232];
const PDF_ZEBRA = [248, 249, 251];
const PDF_DIVIDER = [236, 238, 242]; // workout session-divider row fill
// Food Log's date-group divider row fill — same shaded-divider-row mechanic
// as PDF_DIVIDER above, but tinted with this table's own accent
// (EXPORT_SECTION_COLORS.food, the report's coral) at roughly 10% strength
// over PDF_PAPER, rather than a flat neutral gray, so the grouping reads as
// this section's own device rather than a reused workout-table label.
const PDF_FOOD_DATE_DIVIDER = [248, 236, 232];
const PDF_DANGER = [255, 84, 112]; // --c-danger, used only for RPE >= 9

// The 6 "Report Summary" KPI cards, colored to match the app's own macro
// language where a real semantic tie exists (calories/protein/water), and a
// neutral tone elsewhere (weight change isn't "good" or "bad" without
// knowing the user's goal direction, so it gets a cool neutral, not
// green/red judgment).
const PDF_METRIC_COLORS = {
  calories: [255, 107, 74], // --c-calories
  protein: [51, 214, 166], // --c-protein
  water: [79, 195, 247], // --c-water
  weight: [140, 158, 255], // --c-fats, reused here as a neutral cool tone
  workouts: [139, 195, 74], // --c-fiber
  streak: [255, 194, 75], // --c-carbs
};

// One color per table section — "weight" and "workouts" intentionally reuse
// their KPI-card counterpart above for visual continuity between the summary
// cards and the detail tables underneath them; "measurements" borrows the
// water blue purely decoratively (no KPI card of its own to match).
const EXPORT_SECTION_COLORS = {
  food: PDF_METRIC_COLORS.calories,
  summary: PDF_METRIC_COLORS.streak,
  weight: PDF_METRIC_COLORS.weight,
  measurements: PDF_METRIC_COLORS.water,
  workouts: PDF_METRIC_COLORS.workouts,
};

// Badge colors for the Food Log's Source pill — no semantic tie to the
// metric colors above, just three visually distinct tones.
const SOURCE_BADGE_COLORS = {
  ai: PDF_METRIC_COLORS.weight,
  manual: PDF_MUTED,
  saved_meal: PDF_METRIC_COLORS.protein,
};

// Every icon is drawn centered at (cx, cy) in `fg` (white by default — the
// medallion logo in the header is the one caller that passes PDF_INK
// instead, since it sits on a solid brass fill rather than a colored badge),
// sized to sit comfortably inside its badge circle with a clear margin on
// every side. Verified by actually rendering each one at real badge scale
// and zooming in — several went through multiple iterations: "workouts"
// as two plain circles+a line read as a face (two eyes, a mouth) until
// redrawn as two tall plates on a thick bar; "calories" as a symmetric
// triangle+circle was indistinguishable from "water" until made
// deliberately asymmetric with a second counter-tilted wisp.
function drawIcon(doc, colorKey, cx, cy, fg = [255, 255, 255]) {
  doc.setDrawColor(...fg);
  doc.setFillColor(...fg);
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
      // A barbell in cross-section: a thick bar through two tall plates —
      // not two dots + a thin line, which read as a face at badge scale.
      doc.setLineWidth(0.85);
      doc.line(cx - s * 0.55, cy, cx + s * 0.55, cy);
      doc.roundedRect(cx - s * 1.2, cy - s * 0.8, s * 0.55, s * 1.6, 0.3, 0.3, "F");
      doc.roundedRect(cx + s * 0.65, cy - s * 0.8, s * 0.55, s * 1.6, 0.3, 0.3, "F");
      break;
    }
    case "calories": {
      // A flame: an asymmetric main tongue + a smaller counter-tilted wisp
      // merged into one silhouette, deliberately not a symmetric
      // triangle+circle (that reads as a droplet — see "water" below).
      doc.circle(cx - s * 0.06, cy + s * 0.42, s * 0.6, "F");
      doc.triangle(cx + s * 0.32, cy - s * 1.15, cx - s * 0.6, cy + s * 0.4, cx + s * 0.5, cy + s * 0.4, "F");
      doc.triangle(cx - s * 0.42, cy - s * 0.15, cx - s * 0.05, cy + s * 0.55, cx - s * 0.62, cy + s * 0.5, "F");
      break;
    }
    case "protein": {
      // A bolt: a steep zigzag, wider strokes than a hairline so it
      // survives at badge scale instead of collapsing into a smudge.
      doc.triangle(cx + s * 0.5, cy - s * 1.05, cx - s * 0.75, cy + s * 0.1, cx + s * 0.02, cy + s * 0.1, "F");
      doc.triangle(cx + s * 0.02, cy + s * 0.1, cx - s * 0.5, cy + s * 1.05, cx + s * 0.75, cy - s * 0.1, "F");
      break;
    }
    case "water": {
      // A droplet: triangle top + circle bottom, symmetric on purpose (the
      // one shape here that SHOULD read as calm/liquid rather than dynamic).
      doc.triangle(cx, cy - s * 1.05, cx - s * 0.6, cy + s * 0.1, cx + s * 0.6, cy + s * 0.1, "F");
      doc.circle(cx, cy + s * 0.32, s * 0.6, "F");
      break;
    }
    case "streak": {
      // A small pennant flag on a pole.
      doc.setLineWidth(0.45);
      doc.line(cx - s * 0.75, cy - s, cx - s * 0.75, cy + s);
      doc.triangle(cx - s * 0.75, cy - s * 0.9, cx - s * 0.75, cy - s * 0.05, cx + s * 0.85, cy - s * 0.48, "F");
      break;
    }
  }
}

// Room a section's medallion + heading + table header row + a few body rows
// actually needs. If less than this is left on the current page, the whole
// section starts fresh on a new page instead — this is what used to be able
// to strand a section's title alone at the bottom of a page with its table
// (autoTable does its own page-break math independently of the heading drawn
// just above it) reflowing to the top of the next one.
const MIN_SECTION_SPACE_MM = 40;

const SECTION_MEDALLION_RADIUS = 3.6;

// A section header reads as a small stamped medallion (an outlined ring
// around a filled center, echoing the header's own logo mark) rather than a
// flat colored dot — plus an optional right-aligned row-count label and a
// hairline rule closing off the header from the table below it.
function drawSectionHeader(doc, { title, count, colorKey }, y) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const color = EXPORT_SECTION_COLORS[colorKey];
  const cx = 14 + SECTION_MEDALLION_RADIUS;
  const cy = y - 2.4;
  doc.setDrawColor(...color);
  doc.setLineWidth(0.5);
  doc.circle(cx, cy, SECTION_MEDALLION_RADIUS, "S");
  doc.setFillColor(...color);
  doc.circle(cx, cy, SECTION_MEDALLION_RADIUS * 0.65, "F");
  drawIcon(doc, colorKey, cx, cy);

  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(11.5);
  doc.setTextColor(...PDF_TEXT);
  doc.text(title, 14 + SECTION_MEDALLION_RADIUS * 2 + 4, y);

  if (count) {
    doc.setFont(PDF_FONT, "normal");
    doc.setFontSize(8.2);
    doc.setTextColor(...PDF_MUTED);
    doc.text(count, pageWidth - 14, y, { align: "right" });
  }

  doc.setDrawColor(...PDF_HAIRLINE);
  doc.setLineWidth(0.25);
  doc.line(14, y + 2.6, pageWidth - 14, y + 2.6);
}

// Draws one section's medallion header + table, returning the y position the
// next section should start at. Skips sections with nothing to show (no
// empty "Food Log" table taking up space when the export range has no food
// logged, for instance) rather than rendering a header over a blank table.
// `columnStyles`/`didParseCell`/`didDrawCell` pass straight through to
// autoTable — used by callers that need right-aligned numeric columns or a
// custom cell (Source/RPE badges, the weight Change column's arrow+delta).
function addExportSection(doc, { title, colorKey, head, rows, count, columnStyles, didParseCell, didDrawCell, y }) {
  if (!rows.length) return y;
  const pageHeight = doc.internal.pageSize.getHeight();
  if (pageHeight - y < MIN_SECTION_SPACE_MM) {
    doc.addPage();
    y = 20;
  }
  drawSectionHeader(doc, { title, count, colorKey }, y);
  doc.autoTable({
    startY: y + 5,
    head: [head],
    body: rows,
    theme: "plain",
    styles: { font: PDF_FONT, fontSize: 8.6, cellPadding: 2.8, textColor: PDF_TEXT, lineColor: PDF_HAIRLINE, lineWidth: 0.15 },
    headStyles: { font: PDF_FONT, fillColor: EXPORT_SECTION_COLORS[colorKey], textColor: 255, fontStyle: "bold", lineWidth: 0 },
    alternateRowStyles: { fillColor: PDF_ZEBRA },
    columnStyles,
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
    didParseCell,
    didDrawCell,
  });
  return doc.lastAutoTable.finalY + 14;
}

// A plain stack of tables reads as a raw data dump, not a report — the KPI
// cards below turn it into one. Every stat here is derived entirely from
// data the export already fetched (see downloadExportPdf), so this adds zero
// extra network requests. Averages are computed over active days only (days
// with at least one food/water entry — dailySummaryRows is already exactly
// that set), same "average of days that actually happened" definition
// progress.js's own avg-calories stat uses, not an average over the whole
// calendar window including untouched days.
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
  const totalSets = workouts.reduce((s, w) => s + (w.sets || []).length, 0);
  return { activeDays, avgCalories, avgProtein, totalWaterMl, weightChange, workoutsCount: workouts.length, totalSets, targetCalories };
}

const PDF_KPI_CARD_H = 27;
const PDF_KPI_GAP = 5;

// One "widget" card: icon medallion, big value, muted tracked-caps label,
// and EITHER a thin progress bar (avg-vs-target, only when a target exists)
// OR a one-line colored sub-note — never both, since they'd otherwise land
// on top of each other at this card height. A faux drop-shadow (a second,
// slightly offset rounded rect painted first, in a darker paper tone) gives
// the flat card real depth without relying on jsPDF's opacity/GState API,
// which the SRI-pinned CDN build isn't guaranteed to expose identically
// across jsPDF versions.
function drawKpiCard(doc, { x, y, w, h, colorKey, label, value, sub, progress }) {
  const color = PDF_METRIC_COLORS[colorKey];
  doc.setFillColor(...PDF_SHADOW);
  doc.roundedRect(x + 0.6, y + 0.9, w, h, 2.6, 2.6, "F");
  doc.setFillColor(...PDF_PAPER);
  doc.setDrawColor(...PDF_PAPER_BORDER);
  doc.setLineWidth(0.3);
  doc.roundedRect(x, y, w, h, 2.6, 2.6, "FD");

  const bcx = x + 8.5;
  const bcy = y + 8.6;
  doc.setFillColor(...color);
  doc.circle(bcx, bcy, 4.4, "F");
  drawIcon(doc, colorKey, bcx, bcy);

  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(13.5);
  doc.setTextColor(...PDF_TEXT);
  doc.text(value, x + 16, y + 10.6);

  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(7.4);
  doc.setTextColor(...PDF_MUTED);
  doc.text(label.toUpperCase(), x + 16, y + 15.4, { charSpace: 0.4 });

  if (typeof progress === "number") {
    const barY = y + 19.4;
    const barX = x + 8.5;
    const barW = w - 17;
    doc.setFillColor(...PDF_PAPER_BORDER);
    doc.roundedRect(barX, barY, barW, 1.7, 0.85, 0.85, "F");
    doc.setFillColor(...color);
    doc.roundedRect(barX, barY, barW * Math.min(1, Math.max(0.04, progress)), 1.7, 0.85, 0.85, "F");
  } else if (sub) {
    doc.setFontSize(7.8);
    doc.setTextColor(...color);
    doc.text(sub, x + 8.5, y + 21.8);
  }
}

// 3x2 grid of independent cards (not one big card split into columns) —
// real gaps between them read as distinct widgets, the "modern card/widget
// styles" this replaced the flat Report Summary card with.
function drawKpiGrid(doc, y, cards) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const cols = 3;
  const cardW = (pageWidth - 28 - PDF_KPI_GAP * (cols - 1)) / cols;
  cards.forEach((card, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    drawKpiCard(doc, { ...card, x: 14 + col * (cardW + PDF_KPI_GAP), y: y + row * (PDF_KPI_CARD_H + PDF_KPI_GAP), w: cardW, h: PDF_KPI_CARD_H });
  });
  const rows = Math.ceil(cards.length / cols);
  return y + rows * (PDF_KPI_CARD_H + PDF_KPI_GAP) + 6;
}

const PDF_HEADER_HEIGHT = 46;

// A flat fill read as a plain banner — this fakes a subtle vertical gradient
// (jsPDF has no native gradient fill reliable across export targets) with a
// stack of thin rects interpolating color, cheap enough to not be worth a
// canvas pattern for a one-time header band.
function drawGradientBand(doc, x, y, w, h, colorTop, colorBottom, steps = 32) {
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    doc.setFillColor(
      Math.round(colorTop[0] + (colorBottom[0] - colorTop[0]) * t),
      Math.round(colorTop[1] + (colorBottom[1] - colorTop[1]) * t),
      Math.round(colorTop[2] + (colorBottom[2] - colorTop[2]) * t),
    );
    doc.rect(x, y + (h * i) / steps, w, h / steps + 0.5, "F");
  }
}

// The cover band: a stamped-medallion logo mark + tracked "IRON LOG"
// wordmark (echoing the app's own weight-plate branding), the report's real
// headline, a right-aligned "generated at" timestamp, and a row of pill
// chips summarizing the report's scope — replacing the old single line of
// plain "Data export — {range}" text with an actual designed cover.
function drawReportHeader(doc, { title, eyebrow, generatedLine, chips }) {
  const pageWidth = doc.internal.pageSize.getWidth();
  drawGradientBand(doc, 0, 0, pageWidth, PDF_HEADER_HEIGHT, PDF_INK, PDF_INK_2);
  doc.setFillColor(...PDF_BRASS);
  doc.rect(0, PDF_HEADER_HEIGHT - 0.9, pageWidth, 0.9, "F");

  const mcx = 14 + 5.2;
  const mcy = 13.5;
  doc.setDrawColor(...PDF_BRASS);
  doc.setLineWidth(0.5);
  doc.circle(mcx, mcy, 5.2, "S");
  doc.setFillColor(...PDF_BRASS);
  doc.circle(mcx, mcy, 3.2, "F");
  drawIcon(doc, "workouts", mcx, mcy, PDF_INK);

  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(8.4);
  doc.setTextColor(...PDF_BRASS_SOFT);
  doc.text("IRON LOG", mcx + 9, mcy - 1.3, { charSpace: 1.1 });

  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(19);
  doc.setTextColor(255, 255, 255);
  doc.text(title, mcx + 9, mcy + 5.6);

  doc.setFont(PDF_FONT, "normal");
  doc.setFontSize(7.6);
  doc.setTextColor(...PDF_BRASS_SOFT);
  doc.text(eyebrow, pageWidth - 14, 10.5, { align: "right", charSpace: 1 });
  doc.setFontSize(9);
  doc.setTextColor(210, 213, 222);
  doc.text(generatedLine, pageWidth - 14, 16, { align: "right" });

  let cx = 14;
  const chipY = PDF_HEADER_HEIGHT - 10;
  doc.setFontSize(8.4);
  chips.forEach((label) => {
    const w = doc.getTextWidth(label) + 9;
    doc.setFillColor(...PDF_INK_2);
    doc.roundedRect(cx, chipY, w, 7, 3.5, 3.5, "F");
    doc.setFont(PDF_FONT, "normal");
    doc.setTextColor(224, 226, 232);
    doc.text(label, cx + w / 2, chipY + 4.8, { align: "center" });
    cx += w + 4;
  });

  return PDF_HEADER_HEIGHT + 14;
}

// Combined Fiber/Sugar/Sodium into one muted "Extras" column on the Food Log
// table rather than three more full columns — sugar and sodium are real
// tracked fields (backend/models.py's DailyLogResponse) that had no home in
// the old export at all, but a 12-column table read as a cramped spreadsheet
// long before it read as cluttered data. This keeps every value present
// without three more full-width columns competing with Food/Calories/macros
// for attention.
function formatExtras(l, S) {
  return `${S.extras.fiber} ${Math.round(l.fiber || 0)}g · ${S.extras.sugar} ${Math.round(l.sugar || 0)}g · ${S.extras.sodium} ${Math.round(l.sodium || 0)}mg`;
}

// Reserves enough Source-column width up front for the widest badge label
// this export's language can produce. Needed because didParseCell (see the
// Food Log section below) blanks that column's actual cell text so it
// doesn't render underneath the badge drawSourceBadge paints on top — but
// that means autoTable's own auto-width pass, which only measures rendered
// cell text, never sees the real label and would otherwise size the column
// off the short "Source"/"Sursă" header alone. That's exactly what let a
// wider label (Romanian's "Masă salvată") overflow its cell and bleed off
// the page edge, since it's the rightmost column.
function sourceBadgeColumnWidth(doc, S) {
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(7);
  const widest = Math.max(...Object.values(S.source).map((label) => doc.getTextWidth(label)));
  return widest + 6 + 3;
}

// Draws the Source pill, clamped to never exceed its own cell width — a hard
// backstop independent of sourceBadgeColumnWidth() above, so even a future
// source value/language longer than anything reserved for still can't push
// the pill past its cell (and, on the rightmost column, off the page).
// Shrinks the font first, then truncates with an ellipsis, before ever
// letting the pill itself exceed maxW. Font/size are set BEFORE measuring
// (not after, as before) so the measured width always matches what's drawn.
function drawSourceBadge(doc, data, S) {
  const raw = data.cell.raw;
  const label = S.source[raw] || raw;
  const color = SOURCE_BADGE_COLORS[raw] || PDF_MUTED;

  const maxW = data.cell.width - 1.5;
  doc.setFont(PDF_FONT, "bold");
  let fontSize = 7;
  doc.setFontSize(fontSize);
  let text = label;
  let textW = doc.getTextWidth(text);
  const minFontSize = 5.5;
  while (textW + 6 > maxW && fontSize > minFontSize) {
    fontSize -= 0.5;
    doc.setFontSize(fontSize);
    textW = doc.getTextWidth(text);
  }
  if (textW + 6 > maxW) {
    while (text.length > 1 && doc.getTextWidth(text + "…") + 6 > maxW) {
      text = text.slice(0, -1);
    }
    text += "…";
    textW = doc.getTextWidth(text);
  }

  const w = Math.min(textW + 6, maxW);
  const bx = data.cell.x + (data.cell.width - w) / 2;
  const by = data.cell.y + (data.cell.height - 5) / 2;
  doc.setFillColor(...color);
  doc.roundedRect(bx, by, w, 5, 2.5, 2.5, "F");
  doc.setTextColor(255, 255, 255);
  doc.text(text, bx + w / 2, by + 3.5, { align: "center" });
}

// A neutral (not good/bad) up/down triangle + signed delta for the Body
// Weight table's Change column — color only distinguishes direction, it
// doesn't judge it, since a rising trend is exactly the goal for a user
// bulking rather than cutting.
function drawWeightDelta(doc, data) {
  const val = Number(data.cell.raw);
  const color = val < 0 ? PDF_METRIC_COLORS.water : PDF_METRIC_COLORS.streak;
  const text = `${val > 0 ? "+" : ""}${val.toFixed(1)} kg`;
  const tx = data.cell.x + data.cell.width - 3;
  const ty = data.cell.y + data.cell.height / 2 + 1.1;
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(8.4);
  doc.setTextColor(...color);
  doc.text(text, tx, ty, { align: "right" });
  const triCx = tx - doc.getTextWidth(text) - 3.4;
  const triCy = data.cell.y + data.cell.height / 2 - 0.3;
  doc.setFillColor(...color);
  if (val < 0) doc.triangle(triCx - 1.1, triCy - 0.9, triCx + 1.1, triCy - 0.9, triCx, triCy + 1.1, "F");
  else doc.triangle(triCx - 1.1, triCy + 1.1, triCx + 1.1, triCy + 1.1, triCx, triCy - 0.9, "F");
}

// RPE is a 1-10 exertion scale — color-coding it (green/amber/red as effort
// climbs) makes a page of sets scannable for "which sets were actually
// hard" without reading every number.
function drawRpeBadge(doc, data) {
  const rpe = Number(data.cell.raw);
  const color = rpe >= 9 ? PDF_DANGER : rpe >= 7 ? PDF_METRIC_COLORS.streak : PDF_METRIC_COLORS.workouts;
  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(8);
  doc.setTextColor(...color);
  doc.text(String(rpe), data.cell.x + data.cell.width / 2, data.cell.y + data.cell.height / 2 + 1.2, { align: "center" });
}

async function buildExportPdf(logs, water, weight, measurements, workouts, days, lang, targets) {
  const S = PDF_STRINGS[lang];
  const rangeLabel = { 2: S.range2, 3: S.range3, 7: S.range7 }[days] || S.range7;

  const { jsPDF } = window.jspdf;
  // Landscape, not portrait: the Food Log section alone has 10 columns
  // (Date/Time/Food/Weight/Calories/Protein/Carbs/Fats/Extras/Source), and
  // Romanian's longer header words (Carbohidrați, Greutate) push portrait's
  // ~182mm usable width past the point where autoTable can lay out every
  // column on one line — headers AND data cells (dates, times) started
  // wrapping mid-word/mid-value, verified by actually rendering both language
  // variants. Landscape's ~269mm usable width fits every column on a single
  // line in both languages, which is what makes this read as a clean report
  // instead of a cramped spreadsheet screenshot.
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
  await registerPdfFonts(doc);
  const pageWidth = doc.internal.pageSize.getWidth();

  const dailySummaryRows = buildDailySummaryRows(logs, water);
  const generatedNow = new Date().toISOString();

  let y = drawReportHeader(doc, {
    title: S.reportTitle,
    eyebrow: S.eyebrow,
    generatedLine: `${S.generated} ${formatPdfDate(generatedNow, lang)}, ${formatTimeOfDay(generatedNow)}`,
    chips: [rangeLabel, S.chipEntries(logs.length), S.chipActiveDays(dailySummaryRows.length)],
  });

  doc.setFont(PDF_FONT, "bold");
  doc.setFontSize(8.6);
  doc.setTextColor(...PDF_MUTED);
  doc.text(S.summaryLabel.toUpperCase(), 14, y, { charSpace: 0.6 });
  y += 6;

  // Every stat here is derived entirely from data the export already
  // fetched (see downloadExportPdf), so this adds zero extra requests.
  const stats = computeReportStats(dailySummaryRows, water, weight, workouts, targets?.daily_calories);
  const calValue = stats.targetCalories
    ? `${Math.round(stats.avgCalories).toLocaleString()} / ${Math.round(stats.targetCalories).toLocaleString()}`
    : `${Math.round(stats.avgCalories).toLocaleString()}`;
  const weightValue =
    stats.weightChange === null
      ? S.reportSummary.noData
      : `${stats.weightChange > 0 ? "+" : ""}${stats.weightChange.toFixed(1)} kg`;

  y = drawKpiGrid(doc, y, [
    {
      colorKey: "calories",
      label: S.reportSummary.avgCalories,
      value: calValue,
      progress: stats.targetCalories ? stats.avgCalories / stats.targetCalories : undefined,
    },
    { colorKey: "protein", label: S.reportSummary.avgProtein, value: `${Math.round(stats.avgProtein)} g` },
    { colorKey: "water", label: S.reportSummary.totalWater, value: `${(stats.totalWaterMl / 1000).toFixed(1)} L` },
    {
      colorKey: "weight",
      label: S.reportSummary.weightChange,
      value: weightValue,
      sub: stats.weightChange === null ? undefined : S.reportSummary.weightChangeSub,
    },
    { colorKey: "workouts", label: S.reportSummary.workoutsLogged, value: `${stats.workoutsCount} · ${stats.totalSets} ${S.reportSummary.setsLabel}` },
    { colorKey: "streak", label: S.reportSummary.daysActive, value: `${stats.activeDays} / ${days}` },
  ]);

  // Sorted defensively here rather than trusted from the API response: GET
  // /logs orders by logged_at desc, which is NOT guaranteed to keep same-
  // log_date entries contiguous (log_date is a separately-assigned calendar
  // day from the day-lock system, backend/routers/day.py — it can drift from
  // a naive UTC reading of logged_at). log_date desc is the primary sort key
  // so every group below is guaranteed contiguous; logged_at desc breaks
  // ties within a day so each group's own rows are newest-time-first too.
  const sortedLogs = [...logs].sort((a, b) => b.log_date.localeCompare(a.log_date) || new Date(b.logged_at) - new Date(a.logged_at));

  // 9 columns: Time/Food/Weight/Calories/Protein/Carbs/Fats/Extras/Source —
  // "Date" is dropped from every row and shown once per group instead, via a
  // shaded divider row (same mechanic the Training Log section below uses
  // for its session dividers, PDF_DIVIDER — see workoutDividerRows/
  // workoutBody further down — tinted with this table's own accent instead
  // of a flat gray, see PDF_FOOD_DATE_DIVIDER's comment).
  const FOOD_LOG_COLUMNS = 9;
  const foodDateDividerRows = new Set();
  const foodLogBody = [];
  let lastLogDate = null;
  sortedLogs.forEach((l) => {
    if (l.log_date !== lastLogDate) {
      lastLogDate = l.log_date;
      foodDateDividerRows.add(foodLogBody.length);
      foodLogBody.push([
        { content: formatPdfDate(l.log_date, lang), colSpan: FOOD_LOG_COLUMNS, styles: { fillColor: PDF_FOOD_DATE_DIVIDER, textColor: PDF_TEXT, fontStyle: "bold", fontSize: 8.6, halign: "left" } },
      ]);
    }
    foodLogBody.push([
      formatTimeOfDay(l.logged_at),
      l.food_name,
      Math.round(l.weight_g),
      Math.round(l.calories),
      l.protein,
      l.carbs,
      l.fats,
      formatExtras(l, S),
      l.source,
    ]);
  });

  y = addExportSection(doc, {
    ...S.sections.food,
    colorKey: "food",
    count: S.counts.entries(logs.length),
    rows: foodLogBody,
    columnStyles: {
      2: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "right" },
      7: { fontSize: 7.4, textColor: PDF_MUTED },
      8: { halign: "center", cellWidth: sourceBadgeColumnWidth(doc, S) },
    },
    // Source is rendered as a colored pill, not plain text — didParseCell
    // blanks the default text so it doesn't draw underneath the badge,
    // didDrawCell then paints the badge using the cell's own raw value. Both
    // hooks skip date-divider rows first (row-index membership, same check
    // the Training Log section uses for its own divider rows) — colSpan
    // already means column.index never reaches 8 on a divider row, but the
    // explicit check is kept for the same belt-and-suspenders reason the
    // Training Log's didDrawCell keeps it too.
    didParseCell: (data) => {
      if (data.section !== "body") return;
      if (foodDateDividerRows.has(data.row.index)) {
        data.row.height = 8;
      } else if (data.column.index === 8) {
        data.cell.text = [];
      }
    },
    didDrawCell: (data) => {
      if (data.section === "body" && data.column.index === 8 && !foodDateDividerRows.has(data.row.index)) {
        drawSourceBadge(doc, data, S);
      }
    },
    y,
  });

  // Water is deliberately NOT a separate raw per-entry section here — for a
  // 7-day export that could mean dozens of individual "+250ml" rows, which
  // ate a disproportionate amount of report space for the least useful level
  // of detail. A per-day total (the "Water (ml)" column below) plus the
  // report-wide total in the KPI grid above already cover what anyone
  // reviewing this export actually wants to know.
  //
  // Wraps up the nutrition side (Food Log above) before moving on to
  // body/training data below — one rolled-up row per calendar day.
  y = addExportSection(doc, {
    ...S.sections.summary,
    colorKey: "summary",
    count: S.counts.days(dailySummaryRows.length),
    rows: dailySummaryRows.map((day) => [
      formatPdfDate(day.date, lang),
      Math.round(day.calories),
      Math.round(day.protein),
      Math.round(day.carbs),
      Math.round(day.fats),
      Math.round(day.fiber),
      day.water_ml,
    ]),
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" } },
    y,
  });

  // Sorted chronologically (weight is fetched newest-first — see
  // computeReportStats above) so the table reads top-to-bottom as an actual
  // trend, and so each row's own Change column can diff against the row
  // directly above it.
  const sortedWeight = [...weight].sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at));
  y = addExportSection(doc, {
    ...S.sections.weight,
    colorKey: "weight",
    count: S.counts.entries(sortedWeight.length),
    rows: sortedWeight.map((w, i) => [
      formatPdfDate(formatCalendarDate(w.logged_at), lang),
      w.weight_kg,
      i === 0 ? "" : w.weight_kg - sortedWeight[i - 1].weight_kg,
    ]),
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 2 && data.cell.raw !== "") data.cell.text = [];
    },
    didDrawCell: (data) => {
      if (data.section === "body" && data.column.index === 2 && data.cell.raw !== "") drawWeightDelta(doc, data);
    },
    y,
  });

  // Always the full history, unlike Food Log/Water/Daily Summary above:
  // measurements aren't part of the 7-day retention window (see
  // sql/schema.sql), so filtering them down to the same short range would
  // hide most of a user's actual measurement history for no reason.
  y = addExportSection(doc, {
    ...S.sections.measurements,
    colorKey: "measurements",
    count: S.counts.entries(measurements.length),
    rows: measurements.map((m) => [
      formatPdfDate(formatCalendarDate(m.logged_at), lang),
      formatTimeOfDay(m.logged_at),
      m.name,
      m.value,
      m.unit,
    ]),
    columnStyles: { 3: { halign: "right" } },
    y,
  });

  // Same "always full history" reasoning as measurements above — training
  // history is also kept indefinitely (see sql/schema.sql's workout_sessions
  // comment), capped server-side at MAX_SESSION_ROWS rather than day-ranged.
  // Grouped by session with a shaded divider row (name, date, calories
  // burned) rather than the old design's flat one-row-per-set table with a
  // "Session kcal" column populated only on each session's first row — that
  // read as an artifact/near-bug (a mostly-empty column), not a deliberate
  // design choice, once actually looked at on a rendered page.
  const sortedSessions = [...workouts].sort(
    (a, b) => new Date(a.session_date) - new Date(b.session_date) || new Date(a.started_at) - new Date(b.started_at),
  );
  const workoutDividerRows = new Set();
  const workoutBody = [];
  let sessionsWithSets = 0;
  sortedSessions.forEach((session) => {
    const sets = [...(session.sets || [])].sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at));
    if (!sets.length) return;
    sessionsWithSets += 1;
    const label = [
      session.name || S.workoutFallbackName,
      formatPdfDate(formatCalendarDate(session.started_at), lang),
      session.calories_burned ? `${Math.round(session.calories_burned)} kcal` : null,
    ]
      .filter(Boolean)
      .join("  ·  ");
    workoutDividerRows.add(workoutBody.length);
    workoutBody.push([{ content: label, colSpan: 6, styles: { fillColor: PDF_DIVIDER, textColor: PDF_TEXT, fontStyle: "bold", fontSize: 8.6, halign: "left" } }]);
    sets.forEach((set) => {
      workoutBody.push([formatTimeOfDay(set.logged_at), set.exercise_name, set.set_number, set.reps, set.weight_kg, set.rpe ?? ""]);
    });
  });

  addExportSection(doc, {
    ...S.sections.workouts,
    colorKey: "workouts",
    count: S.counts.sessions(sessionsWithSets, stats.totalSets),
    rows: workoutBody,
    columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "center" } },
    didParseCell: (data) => {
      if (data.section !== "body") return;
      if (workoutDividerRows.has(data.row.index)) {
        data.row.height = 8;
      } else if (data.column.index === 5 && data.cell.raw !== "") {
        data.cell.text = [];
      }
    },
    didDrawCell: (data) => {
      if (data.section === "body" && data.column.index === 5 && !workoutDividerRows.has(data.row.index) && data.cell.raw !== "") {
        drawRpeBadge(doc, data);
      }
    },
    y,
  });

  const pageCount = doc.internal.getNumberOfPages();
  const pageHeight = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    // A brass rule (echoing the header's own accent) + the tracked brand
    // name on the left turns a bare page number into something that reads
    // as a finished, designed document footer instead of an afterthought
    // stamped in the corner.
    doc.setDrawColor(...PDF_BRASS);
    doc.setLineWidth(0.5);
    doc.line(14, pageHeight - 13, pageWidth - 14, pageHeight - 13);
    doc.setFont(PDF_FONT, "normal");
    doc.setFontSize(8);
    doc.setTextColor(...PDF_MUTED);
    doc.text("IRON LOG", 14, pageHeight - 8, { charSpace: 0.6 });
    doc.text(S.page(i, pageCount), pageWidth - 14, pageHeight - 8, { align: "right" });
  }

  return doc;
}

async function downloadExportPdf(logs, water, weight, measurements, workouts, days, lang, targets) {
  const doc = await buildExportPdf(logs, water, weight, measurements, workouts, days, lang, targets);
  const filename = `iron-log-export-${localDateStr()}.pdf`;
  doc.save(filename);
  // Intercept the just-generated report for the on-device PDF Archive (see
  // pdfArchiveStore.js) — fire-and-forget, same as photoStore's hero-photo
  // writes: this is a best-effort local convenience layered on top of the
  // download above, never something that should delay or fail the export
  // the user actually asked for. doc.output("blob") re-serializes the same
  // in-memory doc doc.save() just used; a second pass over one export-sized
  // PDF is cheap enough that it isn't worth restructuring save() to share it.
  archivePdfReport({ blob: doc.output("blob"), filename, days, lang }).then((record) => {
    if (record) refreshPdfArchiveBadge();
  });
}

// ---------------------------------------------------------------------------
// jsPDF + jspdf-autotable, loaded on demand instead of as static <script>
// tags in index.html — Export PDF is a rare Settings action, but the two
// libraries combined are real weight (100+ KB) that was previously fetched
// and parsed on every single page load for every user, whether they ever
// exported or not. Mirrors the dynamic-script-injection pattern
// frontend/js/auth.js already uses for the (also-optional) Turnstile
// widget, including keeping the same SRI hashes index.html used to pin
// inline — integrity is preserved, just deferred until actually needed.
// jspdf-autotable extends window.jspdf.jsPDF.API, so it must load strictly
// after jspdf itself, not in parallel.
// ---------------------------------------------------------------------------
let pdfLibsPromise = null;

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function ensurePdfLibsLoaded() {
  if (window.jspdf?.jsPDF?.API?.autoTable) return Promise.resolve();
  if (!pdfLibsPromise) {
    pdfLibsPromise = loadScript(
      "https://cdn.jsdelivr.net/npm/jspdf@3.0.1/dist/jspdf.umd.min.js",
      "sha384-ytX5osgYad9GPnagB0k+CxKTir/bsE7AfpzvCnQ7owfeWuDd+2l2y0PSIqRK+z/2",
    ).then(() =>
      loadScript(
        "https://cdn.jsdelivr.net/npm/jspdf-autotable@5.0.8/dist/jspdf.plugin.autotable.min.js",
        "sha384-5jk55M0XWoAw7LyhlXJe19ErOr3doBAPzxw9vahPFbvolqWa2yDk4fhHa2zuYeOa",
      ),
    );
  }
  return pdfLibsPromise;
}

el("export-btn").addEventListener("click", async () => {
  const days = Number(el("export-range").value);
  const lang = getActivePillType("export-lang-tabs") === "ro" ? "ro" : "en";
  const btn = el("export-btn");
  btn.disabled = true;
  try {
    const [logs, water, weight, measurements, workouts] = await Promise.all([
      ensurePdfLibsLoaded(),
      api.listLogs(days),
      api.listWaterHistory(days),
      api.listWeight(days),
      api.listMeasurements(),
      api.listWorkoutSessions(),
    ]).then(([, ...rest]) => rest);
    await downloadExportPdf(logs, water, weight, measurements, workouts, days, lang, state.targets);
    showToast(t("export.exportSuccess"), "success");
  } catch (err) {
    showToast(err.message || t("export.exportFailed"), "error");
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// PDF Archive — on-device history of every report Export Data (above) has
// generated (see pdfArchiveStore.js). `pdfArchiveEntries` is this module's
// own lazily-fetched cache of the sheet's current list (metadata only, no
// PDF bytes — see listArchivedReports), the same "re-render from local
// state, refetch on open" convention day-detail-saved-list etc. already use;
// there's no reason to keep it live once the sheet is closed.
// ---------------------------------------------------------------------------
let pdfArchiveEntries = [];
// Cached from the most recent real getArchiveUsageSummary() read — a fixed
// constant in pdfArchiveStore.js, never derived from the current entries, so
// paintPdfArchiveUsage (below) can keep showing it during a purely-local,
// optimistic update without needing its own storage read.
let pdfArchiveMaxCount = 20;

// Paints the Settings row's count badge and (if the archive sheet happens to
// be open) its own usage hint line from whatever {count, totalBytes} the
// caller already has — never reads storage itself. Deliberately separate
// from refreshPdfArchiveBadge below: during the 5s deleteWithUndo window
// (see deleteArchivedReportWithUndo) the record hasn't actually been deleted
// from storage yet, so a storage-truth read at that moment would show the
// item as still present — visibly contradicting the list, which already
// removed it optimistically. Reading count/size off pdfArchiveEntries
// instead keeps both in lockstep, same "trust local state, not the network
// round trip" convention this app's other optimistic updates already follow.
function paintPdfArchiveUsage(count, totalBytes) {
  const badge = el("pdf-archive-count-badge");
  badge.textContent = String(count);
  badge.hidden = count === 0;
  el("pdf-archive-usage-hint").textContent = t("pdfArchive.usageHint", {
    count,
    max: pdfArchiveMaxCount,
    size: formatFileSize(totalBytes),
  });
}

function pdfArchiveEntriesUsage() {
  return { count: pdfArchiveEntries.length, totalBytes: pdfArchiveEntries.reduce((sum, e) => sum + (e.sizeBytes || 0), 0) };
}

// The real, storage-backed refresh — used at boot and right after a fresh
// export, where there's no reason to believe local state has drifted from
// storage. Also refreshes the cached max values above.
async function refreshPdfArchiveBadge() {
  const usage = await getArchiveUsageSummary();
  pdfArchiveMaxCount = usage.maxCount;
  paintPdfArchiveUsage(usage.count, usage.totalBytes);
}

async function refreshPdfArchiveList() {
  pdfArchiveEntries = await listArchivedReports();
  // Ids never collide (see newArchiveId), but a stale sheet-open/close cycle
  // is a fine point to drop any prefetches that never got tapped rather than
  // let the cache grow for the life of the page.
  pdfShareFilePrefetch.clear();
  renderPdfArchive(pdfArchiveEntries);
  refreshPdfArchiveBadge();
}

el("open-pdf-archive-btn").addEventListener("click", () => {
  openSheet("pdf-archive-sheet");
  refreshPdfArchiveList();
});

// Downloads the archived PDF's bytes straight to the device — deliberately
// NOT "open in a new tab via a blob: URL" (an earlier version of this did
// exactly that, via window.open). That approach is fundamentally incompatible
// with this app's CSP, not just a popup-blocker/process-isolation quirk: a
// blob: URL document inherits its Content-Security-Policy from the context
// that created the blob (see the CSP spec's "inherit a policy" algorithm) —
// so a PDF opened that way is still bound by THIS app's strict style-src
// (no 'unsafe-inline', see index.html/CLAUDE.md's frontend security posture,
// deliberately kept that way). The browser's own built-in PDF viewer injects
// its layout/toolbar via inline styles to size itself to the tab — CSP blocks
// every one of them, so the viewer collapses to whatever minimal box survives
// (reported: "10% of a page, just a header, in a tiny scrollable rectangle").
// This isn't fixable by changing how the tab is opened (tried removing
// noopener first — that fixed a real but separate bug, the tab actually
// navigating at all, but didn't touch this CSP-inheritance issue underneath
// it) or by relaxing style-src (that would weaken the CSP for the whole app
// to fix one rarely-used viewer). A real download is immune to all of this:
// once the file lands on disk, it's opened by the OS/browser's own PDF
// handling OUTSIDE this origin entirely, so nothing here constrains it — and
// it's the exact same `<a download>`-plus-blob-URL technique jsPDF's own
// `.save()` already uses for the main Export button, which is why that one
// never had this problem. Works identically across Chrome/Edge/Firefox and
// modern Safari, with no new dependency and no CSP change.
async function downloadArchivedReport(id) {
  const entry = pdfArchiveEntries.find((e) => e.id === id);
  const file = await getArchivedReportFile(id);
  if (!file) {
    showToast(t("pdfArchive.openFailed"), "error");
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = entry?.filename || "report.pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safe to revoke right away (unlike a new-tab navigation, the browser reads
  // the blob synchronously when the download starts — there's no async load
  // race to protect against here).
  URL.revokeObjectURL(url);
}

// Native share sheet when the platform actually supports sharing a file
// (mobile Safari/Chrome/Samsung Internet); falls back to the download above
// everywhere else, rather than a dead button — matches this app's
// barcode-scanning convention of never leaving an unsupported action as a
// silent no-op. Unaffected by the CSP issue above: the OS share sheet
// renders the file itself, entirely outside this app's document/CSP.
//
// User-activation is the real constraint here, not feature support. Both
// canShare({files}) and share() require a live "transient activation" token
// from the tap that's still consuming it, and any real async I/O between the
// tap and the share() call can burn through that window before share() ever
// runs — most reliably reproduced on Android in an *installed* PWA (the
// user-reported case: works in a normal browser tab, always falls back to
// download once "installed" and launched standalone), where the OPFS/
// IndexedDB read in getArchivedReportFile() is enough of a real macrotask
// delay to invalidate the gesture every single time, not just flakily. iOS
// Safari has the same underlying constraint, just a more forgiving window in
// practice, which is why this previously read as iOS-only.
//
// The fix is to do that storage read *before* the tap needs it, not after:
// prefetchArchivedShareFile() below is kicked off on pointerdown (fires
// before click, same physical tap, not itself activation-gated) so by the
// time this click handler runs, the read has almost always already resolved
// — the `await` here then settles on a microtask instead of waiting on a
// fresh IndexedDB/OPFS round trip, leaving the tap's activation window
// intact for the share() call that immediately follows. If no prefetch was
// in flight (e.g. a keyboard-triggered click with no preceding pointerdown),
// it falls back to reading inline, same as before — strictly no worse than
// the old behavior, just no longer the common case.
//
// The canShare() check AND the share() call itself are both wrapped in the
// same try/catch, and any failure (not just an unsupported/absent API) falls
// through to the download fallback. AbortError (user dismissed the native
// share sheet) is the one case that intentionally does NOT fall back to
// download — that's a deliberate cancel, not a failure.
const pdfShareFilePrefetch = new Map();

// Builds the exact File the OS share sheet will receive: real bytes wrapped
// fresh with a filename that's guaranteed to end in `.pdf` (entry.filename
// already does — see downloadExportPdf — but re-deriving it here means this
// stays correct even if that ever changes) and an explicit
// `type: "application/pdf"`, since neither the OPFS engine's File (its on-
// disk name is the archive id, not the report filename, and OPFS doesn't
// reliably preserve the blob's MIME type) nor the IndexedDB engine's raw
// Blob (no name at all) is shareable as-is. Mobile share sheets are strict
// about both fields — a missing/wrong extension or MIME type is enough for
// canShare() to quietly return false.
function buildShareableReportFile(entry, blob) {
  if (!entry || !blob) return null;
  const filename = entry.filename?.toLowerCase().endsWith(".pdf") ? entry.filename : `${entry.filename || "report"}.pdf`;
  return new File([blob], filename, { type: "application/pdf" });
}

function prefetchArchivedShareFile(id) {
  if (!id || pdfShareFilePrefetch.has(id)) return;
  const entry = pdfArchiveEntries.find((e) => e.id === id);
  const promise = getArchivedReportFile(id)
    .then((blob) => buildShareableReportFile(entry, blob))
    .catch(() => null);
  pdfShareFilePrefetch.set(id, promise);
}

async function shareArchivedReport(id) {
  const entry = pdfArchiveEntries.find((e) => e.id === id);
  const pending = pdfShareFilePrefetch.get(id);
  pdfShareFilePrefetch.delete(id);
  const file = pending ? await pending : buildShareableReportFile(entry, await getArchivedReportFile(id));
  if (!file) {
    showToast(t("pdfArchive.openFailed"), "error");
    return;
  }
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: entry.filename });
      return;
    }
  } catch (err) {
    if (err?.name === "AbortError") return;
  }
  await downloadArchivedReport(id);
}

// Same toast-with-5s-undo convention as every other delete in this app (see
// ui.js's deleteWithUndo) — deleteArchivedReport never throws (best-effort,
// like every pdfArchiveStore export), so the revert branch only ever fires
// via an actual Undo tap, not a failed delete.
async function deleteArchivedReportWithUndo(id) {
  await animateItemRemoval("pdf-archive-list", id);
  vibrate(10);
  const previousEntries = pdfArchiveEntries;
  deleteWithUndo({
    removeNow: () => {
      pdfArchiveEntries = pdfArchiveEntries.filter((e) => e.id !== id);
      renderPdfArchive(pdfArchiveEntries);
      const { count, totalBytes } = pdfArchiveEntriesUsage();
      paintPdfArchiveUsage(count, totalBytes);
    },
    restore: () => {
      pdfArchiveEntries = previousEntries;
      renderPdfArchive(pdfArchiveEntries);
      const { count, totalBytes } = pdfArchiveEntriesUsage();
      paintPdfArchiveUsage(count, totalBytes);
    },
    callDelete: () => deleteArchivedReport(id),
    removedToastKey: "pdfArchive.deletedToast",
    revertToastKey: "pdfArchive.deleteFailedToast",
  });
}

// pointerdown fires (and completes hit-testing) before the click's own
// activation-gated work runs, on the same physical tap — starting the
// storage read here, instead of inside the click handler, is what gives
// shareArchivedReport's prefetch cache above a real head start. Not
// activation-gated itself, so kicking off async work here doesn't consume
// anything the later share() call needs.
el("pdf-archive-list").addEventListener("pointerdown", (e) => {
  const btn = e.target.closest("button[data-action='share-report']");
  if (!btn) return;
  const id = btn.closest("[data-id]")?.dataset.id;
  if (id) prefetchArchivedShareFile(id);
});

el("pdf-archive-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest("[data-id]")?.dataset.id;
  if (!id) return;
  if (btn.dataset.action === "download-report") downloadArchivedReport(id);
  else if (btn.dataset.action === "share-report") shareArchivedReport(id);
  else if (btn.dataset.action === "delete-report") {
    pdfShareFilePrefetch.delete(id);
    deleteArchivedReportWithUndo(id);
  }
});

// ---------------------------------------------------------------------------
// PWA — installable app shell caching (see sw.js). Registered after the
// page's own load event so it never competes with the initial render for
// bandwidth/CPU; feature-detected so browsers without service worker
// support (rare) just silently skip this.
//
// sw.js's install handler calls self.skipWaiting() unconditionally and
// activate() calls self.clients.claim() — together those make a newly
// fetched SW take control of this tab immediately, without waiting for
// every other open tab/instance to close first. But "takes control" only
// means *future* fetch()es from this tab go through the new worker; the
// JS modules already loaded and running in memory (this very script
// included) are untouched until something reloads the page. On a home-
// screen-installed mobile PWA that's rarely a full browser tab close/
// reopen — the OS just suspends/resumes the same process — so without an
// explicit reload-on-update below, a user could sit on stale in-memory JS
// (pointing at a since-decommissioned backend URL, old i18n strings, etc.)
// indefinitely even though the SW/cache underneath it is fully current.
// This was the actual bug behind "stuck on old version, uninstall/reinstall
// fixes it": reinstalling was really just forcing the one thing this does
// automatically now — a fresh page load under the new controller.
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .then((registration) => {
        // Standalone/installed PWAs can stay resident for days without a
        // real navigation, and browsers only auto-check a SW script for
        // updates on navigation (or at most every 24h) — neither happens
        // reliably here. Proactively re-check whenever the app regains
        // focus (covers the common "was backgrounded, user switches back
        // to it" resume path on mobile) and on a coarse timer as a
        // backstop for a session that's simply left open/foregrounded for
        // a long stretch. registration.update() is a no-op network-wise if
        // sw.js is byte-identical to what's already installed.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") registration.update().catch(() => {});
        });
        setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000);
      })
      .catch(() => {
        /* offline-caching is a nice-to-have, never a requirement — fail silently */
      });

    // Fires once a new SW has installed (skipWaiting) and activated
    // (clients.claim) and actually taken over this tab's requests — the
    // signal that whatever's currently loaded in memory is now stale.
    // Guarded with a one-shot flag: per spec this can also fire once on a
    // brand-new install (no previous controller → first controller), which
    // just costs a first-time visitor one harmless extra reload, not a
    // loop — the guard is what prevents an actual loop if it ever fired
    // more than once.
    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedForUpdate) return;
      reloadedForUpdate = true;
      window.location.reload();
    });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
initI18n(); // must run before anything else renders text, including the auth screen
setGreeting();
initScan({
  logNewFood: submitNewLog,
  getLoggedToastMessage: loggedFoodToastMessage,
  // Re-paints Today's Journal once a just-confirmed scan's thumbnail is
  // actually ready in scan.js's cache — the log itself already appeared
  // (the optimistic insert), just without a photo yet until this fires.
  onThumbnailsUpdated: () => render(),
  onReturnToEdit: returnToEditWithMergedIngredients,
});
initTutorial();
initProgress({
  onDayClick: openDayDetailSheet,
  // Not just `logSavedMealOptimistic` directly (unlike the plain saved-meal
  // list's own quick-log button below, this call site was missing this
  // exact same "toast before the optimistic mutation" step entirely — see
  // the saved-meals-list click handler above for the pattern this mirrors).
  onLogSuggestedMeal: (meal) => {
    if (blockIfDayLocked()) return;
    showToast(loggedFoodToastMessage(meal), "success");
    logSavedMealOptimistic(meal);
  },
});
initWorkoutDiary();
setAnalyticsContext({
  getTargetsPayload: () => (state.targets ? currentTargetsPayload() : null),
  onTargetsUpdated: (updated) => {
    state.targets = updated;
    syncProfileUi(state.targets);
  },
});
initAnalytics();
initNotifications();
initCoachChat();
initDamageControl({ openMealSuggester: () => openMealSuggesterSheet({ suggestedFilters: ["low_fat"] }) });
initMealSuggester({ logSuggestion: logMealSuggestion });
initDiscover({ onDataChanged: loadAll });
// Zero backend dependency (localStorage-only) — doesn't need to wait for
// loadAll()/sign-in like every other dashboard card here, so it's wired up
// directly in the boot sequence rather than from onSignedIn below.
initFastingTimer();
initSheetDragToDismiss();
initJournalSwipe();
initTabSwipe();
// Same "zero backend dependency, wire up directly" reasoning as
// initFastingTimer() above — capability detection + DOM wiring only, no
// network/auth involved, so there's no reason to gate this behind sign-in.
initPhotoStore();
initPhotoLightbox();
initPdfArchiveStore().then(refreshPdfArchiveBadge);
// Same "zero backend dependency, wire up directly" reasoning as
// initFastingTimer() above — this is a pure document-level event delegation
// setup (see its own comment in ui.js), so it belongs in the boot sequence
// rather than gated behind sign-in.
initNumericInputGuards();
// Same "zero backend dependency, wire up directly" reasoning as
// initFastingTimer() above — pure DOM/scroll wiring, needed before the auth
// screen's own scroll even happens.
initScrollProgress();

// .view-boot-in (index.html) plays the cold-boot entrance once, then is
// meant to never fire again — its own CSS comment already documents this as
// resting on one specific, empirically-observed (Chrome, 2026) behavior:
// toggling `[hidden]` on an element doesn't restart an already-finished CSS
// animation, "not a spec guarantee — nothing requires every engine to agree,
// now or later." initTabSwipe's armDrag routinely flips #view-dashboard's
// `hidden` back to false mid-gesture (every drag that arms toward it), so on
// any engine where that assumption doesn't hold (mobile Safari/WebKit is
// exactly the kind of engine known to diverge here), `view-in`'s own
// `transform: translateY(...)` keyframe would replay on top of — and, since
// a running CSS animation overrides an inline style for the properties it
// animates, fight with and clobber — the drag's own live `translate3d()`
// tracking, which reads as the view instantly snapping/flashing instead of
// sliding smoothly. Removing the class for good the instant the real
// one-time entrance finishes makes this structurally impossible on every
// engine, instead of quietly depending on today's Chrome behavior.
el("view-dashboard").addEventListener("animationend", (e) => {
  if (e.animationName === "view-in") el("view-dashboard").classList.remove("view-boot-in");
});
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
    if (reopenScanSheet && openScanSheetFresh()) {
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
