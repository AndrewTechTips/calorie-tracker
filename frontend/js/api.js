import { API_BASE_URL } from "./config.js?v=20260822h";
import { supabaseClient } from "./supabaseClient.js?v=20260822h";
import { getLanguage, t } from "./i18n.js?v=20260822h";

async function authHeader() {
  const { data } = await supabaseClient.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error(t("api.notSignedIn"));
  return { Authorization: `Bearer ${token}` };
}

async function handleResponse(res) {
  if (res.status === 204) return null;
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  if (res.status === 401) {
    // The backend is the source of truth on session validity, not the client's
    // cached Supabase session. If it rejects the token (expired/revoked), force
    // a real sign-out so auth.js drops the user back to the login screen instead
    // of leaving them stranded on an app shell that can no longer load data.
    await supabaseClient.auth.signOut();
    throw new Error(t("api.sessionExpired"));
  }
  if (res.status === 429) {
    // Two different things share this status code:
    //   - slowapi's own burst/sustained rate limiter, whose default error
    //     body is {"error": "..."}, not {"detail": "..."} like the rest of
    //     this API — the generic branch below would otherwise just say
    //     "Request failed (429)", worth a clearer, friendlier message.
    //   - backend/services/ai_usage_service.py's per-user, per-feature daily
    //     AI quota rejections (scan/coach/etc.), which DO send a real
    //     {"detail": "..."} — a specific, friendly "you're out of X for
    //     today" message worth surfacing as-is rather than overwriting with
    //     the generic one above. `quotaExceeded` lets a caller (e.g.
    //     coachChat.js) tell the two apart without string-matching.
    const quotaExceeded = typeof body?.detail === "string";
    const error = new Error(quotaExceeded ? body.detail : t("api.rateLimited"));
    error.status = 429;
    error.quotaExceeded = quotaExceeded;
    throw error;
  }
  if (!res.ok) {
    const message = body?.detail || `Request failed (${res.status})`;
    const error = new Error(typeof message === "string" ? message : JSON.stringify(message));
    // Lets callers recognize known backend conditions (e.g. 409 "day ended")
    // and show their own localized copy instead of this raw, English-only
    // backend detail string — see the i18n note in models/routers about that
    // being an accepted gap for *unexpected* errors, not for ones common
    // enough that every non-English user would hit them routinely.
    error.status = res.status;
    throw error;
  }
  return body;
}

const DEFAULT_TIMEOUT_MS = 15000;

async function request(path, { method = "GET", json, formData, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const headers = await authHeader();
  const init = { method, headers };

  if (formData) {
    init.body = formData; // browser sets multipart boundary automatically
  } else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  }

  // A stuck backend/DB request should never hang the UI indefinitely (that's
  // what read as an "app freeze" — a button whose handler is still awaiting a
  // fetch forever looks dead, since nothing ever re-renders or errors out).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Callers doing fast-typing search-as-you-type (see discover.js) pass their
  // own `signal` to cancel a now-stale in-flight request when a newer one
  // supersedes it — chained onto the same controller so either the timeout or
  // a deliberate caller-side cancel aborts the same underlying fetch.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  init.signal = controller.signal;

  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, init);
  } catch (err) {
    if (err.name === "AbortError") {
      // A caller-initiated cancel (superseded search) is not a real failure —
      // rethrow as-is so callers can tell it apart from a genuine timeout and
      // skip showing an error toast for it.
      if (signal?.aborted) throw err;
      throw new Error(t("api.timeout"));
    }
    throw new Error(t("api.unreachable"));
  } finally {
    clearTimeout(timer);
  }
  return handleResponse(res);
}

// Free-tier hosts (Render et al.) spin the backend down after inactivity, and
// a cold start can take 30-60s. Called once at page load, well before the
// user finishes typing their login, so that wait happens in the background
// instead of eating into their first real action.
//
// Retries the plain health ping every 2s (instead of firing once and letting
// the result go unused) up to a ~50s deadline, and returns a promise that
// resolves true the moment the backend answers — or false once the deadline
// passes. This matters because a *remembered* session signs in almost
// instantly (no typing time), so loadAll()'s first real data requests used to
// fire within milliseconds of this ping, racing a still-waking instance
// against their own much shorter 15s per-request timeout and losing: the
// dashboard silently came up empty with a "some data could not be loaded"
// toast, which is what read as the app "not responding" on a cold start.
// app.js now awaits this same promise before firing that batch, so the wait
// happens once, explained, instead of surfacing as a spurious failure.
export function warmBackend() {
  // A device with no network interface at all can't distinguish "still
  // waking up" from "will never answer" — every attempt below would fail
  // near-instantly, but the unconditional 2s backoff between attempts would
  // still burn the whole ~50s deadline before giving up. Skip straight to
  // "not warm" so app.js's offline dashboard-snapshot fallback (loadAll())
  // isn't stuck behind a pointless wait. navigator.onLine can still
  // false-positive as "online" (e.g. captive portals) — that case just falls
  // through to the retry loop below and fails there instead, same as before.
  if (!navigator.onLine) return Promise.resolve(false);

  const deadline = Date.now() + 50000;
  const attempt = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/`);
      if (res.ok) return true;
    } catch {
      /* still waking up (or genuinely unreachable) — keep retrying until the deadline */
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return attempt();
  };
  return attempt();
}

// ---------------------------------------------------------------------------
export const api = {
  // Targets
  getTargets: () => request("/targets"),
  updateTargets: (payload) => request("/targets", { method: "PUT", json: payload }),

  // Account management (Settings → Account → danger zone) — both require an
  // explicit {confirm: true} body; the backend rejects anything else with a
  // 400 (see backend/routers/account.py) as defense-in-depth beyond the
  // frontend's own confirmation sheets.
  resetProgress: () => request("/account/reset", { method: "POST", json: { confirm: true } }),
  deleteAccount: () => request("/account", { method: "DELETE", json: { confirm: true } }),

  // Day tracking (today's local date + whether it's been manually ended)
  getDayState: () => request("/day"),
  endDay: () => request("/day/end", { method: "POST" }),
  reopenDay: () => request("/day/reopen", { method: "POST" }),
  updateTimezone: (timezone) => request("/day/timezone", { method: "PUT", json: { timezone } }),

  // Scan
  scanFood: (file, contextText, attachedItems) => {
    const form = new FormData();
    form.append("image", file);
    form.append("context_text", contextText || "");
    // Barcode-scanned product(s) attached alongside the photo (see scan.js's
    // attach* functions) — JSON-encoded since multipart form data has no
    // native way to carry a nested array. Backend: routers/scan.py's
    // _parse_attached_items_form.
    form.append("attached_items", JSON.stringify(attachedItems || []));
    // Steers Gemini's food_name/confidence_note to come back in the app's
    // current display language instead of defaulting to English — see
    // gemini_service.py's _output_language_block.
    form.append("language", getLanguage());
    return request("/scan", { method: "POST", formData: form, timeoutMs: 45000 });
  },
  scanBarcode: (code) => request(`/scan/barcode/${encodeURIComponent(code)}`, { timeoutMs: 15000 }),
  // 30s (was 20s): backend/services/gemini_service.py's Task B accuracy-tier
  // chain leads with mistral-large-latest for this call, which carries a
  // live-confirmed ~15-21s COLD-START tax on the first request against it
  // per backend connection (drops to ~2-3s once warm) — 20s left too thin a
  // margin against that plus network jitter.
  scanDescription: (description, attachedItems) =>
    request("/scan/describe", {
      method: "POST",
      json: { description, attached_items: attachedItems || [], language: getLanguage() },
      timeoutMs: 30000,
    }),

  // Logs
  listLogs: (days) => request(days ? `/logs?days=${days}` : "/logs"),
  createLog: (payload) => request("/logs", { method: "POST", json: payload }),
  // 25s explicit override (was the 15s default): only sends an AI call when
  // food_name changes (backend/routers/logs.py), which routes through
  // gemini_service.py's Task B lookup-tier chain — see that file's
  // _MISTRAL_LOOKUP_PRIORITY comment for why medium/large are tried before
  // small here; a full fallback through both before Groq can approach 15s.
  correctLog: (id, payload) => request(`/logs/${id}`, { method: "PATCH", json: payload, timeoutMs: 25000 }),
  deleteLog: (id) => request(`/logs/${id}`, { method: "DELETE" }),

  // Saved meals
  listSavedMeals: () => request("/meals"),
  saveMeal: (payload) => request("/meals", { method: "POST", json: payload }),
  updateSavedMeal: (id, payload) => request(`/meals/${id}`, { method: "PUT", json: payload }),
  logSavedMeal: (id) => request(`/meals/${id}/log`, { method: "POST" }),
  deleteSavedMeal: (id) => request(`/meals/${id}`, { method: "DELETE" }),

  // Water
  getTodayWater: () => request("/water/today"),
  listWaterHistory: (days) => request(days ? `/water/history?days=${days}` : "/water/history"),
  addWater: (amountMl) => request("/water", { method: "POST", json: { amount_ml: amountMl } }),
  deleteWaterEntry: (id) => request(`/water/${id}`, { method: "DELETE" }),

  // Weight (kept indefinitely — not part of the 7-day retention window)
  listWeight: (days) => request(days ? `/weight?days=${days}` : "/weight"),
  addWeight: (weightKg) => request("/weight", { method: "POST", json: { weight_kg: weightKg } }),
  deleteWeight: (id) => request(`/weight/${id}`, { method: "DELETE" }),

  // Body measurements (gym tracking — kept indefinitely, user-named, user-dated)
  listMeasurements: () => request("/measurements"),
  addMeasurement: (payload) => request("/measurements", { method: "POST", json: payload }),
  updateMeasurement: (id, payload) => request(`/measurements/${id}`, { method: "PATCH", json: payload }),
  deleteMeasurement: (id) => request(`/measurements/${id}`, { method: "DELETE" }),

  // Workout Diary — sessions (one per gym visit) + their per-set entries
  // (reps/weight/RPE), kept indefinitely, same pattern as measurements. See
  // workoutDiary.js, backend/routers/workouts.py.
  listWorkoutSessions: (params = {}) => request(`/workouts/sessions?${new URLSearchParams(params)}`),
  getWorkoutSession: (id) => request(`/workouts/sessions/${id}`),
  createWorkoutSession: (payload = {}) => request("/workouts/sessions", { method: "POST", json: payload }),
  updateWorkoutSession: (id, payload) => request(`/workouts/sessions/${id}`, { method: "PATCH", json: payload }),
  finishWorkoutSession: (id) => request(`/workouts/sessions/${id}`, { method: "PATCH", json: { finish: true } }),
  deleteWorkoutSession: (id) => request(`/workouts/sessions/${id}`, { method: "DELETE" }),
  addWorkoutSet: (sessionId, payload) => request(`/workouts/sessions/${sessionId}/sets`, { method: "POST", json: payload }),
  updateWorkoutSet: (setId, payload) => request(`/workouts/sets/${setId}`, { method: "PATCH", json: payload }),
  deleteWorkoutSet: (setId) => request(`/workouts/sets/${setId}`, { method: "DELETE" }),

  // Trends (7-day aggregation + streak)
  getTrends: () => request("/trends"),

  // Predictive Analytics — weight forecast + Adaptive Goals (see
  // backend/services/analytics_service.py). Pure math, no AI call behind
  // either of these, so both use the default timeout.
  getAnalyticsInsights: () => request("/analytics/insights"),
  applyAdaptiveGoal: () => request("/analytics/apply-adaptive-goal", { method: "POST" }),

  // Shared, non-user-scoped food-name suggestions (services/food_cache_service.py)
  getPopularFoods: () => request("/foods/popular"),

  // AI coach — cached server-side per (user, language) for a rolling week
  // (services/coach_cache_service.py), so repeat opens in the same week cost
  // nothing extra. 20s timeout, not the default 15s: a cache miss means a
  // real (if small, thinking-disabled) Gemini call behind it.
  getWeeklyRecap: () => request(`/coach/weekly-recap?language=${getLanguage()}`, { timeoutMs: 20000 }),
  // `history` is this module's own in-memory message list (see
  // coachChat.js) — never fetched back from the server, since chat
  // transcripts aren't stored there (see backend/models.py's
  // CoachChatRequest docstring). 20s timeout, same reasoning as the recap
  // above: a real, thinking-disabled Gemini call sits behind every turn.
  sendCoachChat: (message, history) =>
    request("/coach/chat", { method: "POST", json: { message, history, language: getLanguage() }, timeoutMs: 20000 }),
  // "Damage Control" intervention (damageControl.js) — triggerFoodName is the
  // log entry that pushed today over target; the backend recomputes
  // remaining macros itself rather than trusting client math (see
  // routers/coach.py::damage_control). 20s timeout, same reasoning as the
  // chat/recap calls above: a real, thinking-disabled Gemini call sits
  // behind this.
  getDamageControlPlan: (triggerFoodName) =>
    request("/coach/damage-control", {
      method: "POST",
      json: { trigger_food_name: triggerFoodName, language: getLanguage() },
      timeoutMs: 20000,
    }),
  // Smart Meal Suggester (mealSuggester.js) — filters is a subset of
  // ["high_protein", "low_fat", "budget", "fast_prep"], validated again
  // server-side against that same fixed enum (models.py's
  // MealSuggestionRequest) regardless of what this sends.
  // 30s (was 20s): this is Task B's biggest JSON payload (up to 4
  // suggestions x 6 ingredients x 9 fields each — see gemini_service.py's
  // generate_meal_suggestions max_tokens comment, raised to 2600 after a
  // live production truncation on mistral-large-latest at the old 1400).
  // The default priority now leads with the fast mistral-small-latest (see
  // _MISTRAL_SUGGESTIONS_PRIORITY), typically ~6-13s, but 30s keeps real
  // margin for the rare full-chain-fallback case.
  suggestMeals: (filters) =>
    request("/coach/suggest-meals", {
      method: "POST",
      json: { filters: filters || [], language: getLanguage() },
      timeoutMs: 30000,
    }),

  // Per-user, per-feature AI quota snapshot for today (Settings → AI Limits,
  // see aiUsage.js). backend/services/ai_usage_service.py.
  getAIUsage: () => request("/ai-usage"),

  // Discover — recipes/workout-plans are the curated static catalog
  // (instant, backend/data/discover_data.py); exercises/products proxy live
  // external APIs (wger.de, Open Food Facts search) so those two get a
  // longer timeout and tolerate taking a beat longer to answer.
  getRecipes: (params = {}, { signal } = {}) => request(`/discover/recipes?${new URLSearchParams(params)}`, { signal }),
  getWorkoutPlans: (params = {}, { signal } = {}) => request(`/discover/workout-plans?${new URLSearchParams(params)}`, { signal }),
  searchExercises: (params = {}, { signal } = {}) => request(`/discover/exercises/search?${new URLSearchParams(params)}`, { timeoutMs: 20000, signal }),
  searchProducts: (params = {}, { signal } = {}) => request(`/discover/products/search?${new URLSearchParams(params)}`, { timeoutMs: 20000, signal }),

  // Web Push notifications (js/notifications.js). The VAPID public key
  // itself is NOT fetched from the backend — it ships directly in
  // js/config.js (VAPID_PUBLIC_KEY), same non-secret, embedded-at-the-
  // frontend posture as SUPABASE_ANON_KEY/TURNSTILE_SITE_KEY in that same
  // file, and it saves a round-trip on every enable-push action.
  // subscribePush takes the browser's own PushSubscriptionJSON shape
  // ({endpoint, keys: {p256dh, auth}}) — callers pass
  // `subscription.toJSON()` for a real PushSubscription, or (from sw.js's
  // pushsubscriptionchange handoff) an already-JSON-shaped object that was
  // never a live PushSubscription instance in this tab to begin with.
  subscribePush: (subscriptionJson) =>
    request("/notifications/subscribe", {
      method: "POST",
      json: { endpoint: subscriptionJson.endpoint, keys: subscriptionJson.keys, user_agent: navigator.userAgent },
    }),
  unsubscribePush: (endpoint) => request("/notifications/subscribe", { method: "DELETE", json: { endpoint } }),
  getNotificationPreferences: () => request("/notifications/preferences"),
  updateNotificationPreferences: (payload) => request("/notifications/preferences", { method: "PUT", json: payload }),
  sendTestNotification: () => request(`/notifications/test?language=${getLanguage()}`, { method: "POST" }),
};
