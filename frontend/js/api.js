import { API_BASE_URL } from "./config.js?v=20260812j";
import { supabaseClient } from "./supabaseClient.js?v=20260812j";
import { getLanguage, t } from "./i18n.js?v=20260812j";

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
    // slowapi's default error body is {"error": "..."}, not {"detail": "..."}
    // like the rest of this API, so the generic branch below would otherwise
    // just say "Request failed (429)" — worth a clearer, friendlier message.
    throw new Error(t("api.rateLimited"));
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
  scanDescription: (description, attachedItems) =>
    request("/scan/describe", {
      method: "POST",
      json: { description, attached_items: attachedItems || [], language: getLanguage() },
      timeoutMs: 20000,
    }),
  getScanUsage: () => request("/scan/usage"),

  // Logs
  listLogs: (days) => request(days ? `/logs?days=${days}` : "/logs"),
  createLog: (payload) => request("/logs", { method: "POST", json: payload }),
  correctLog: (id, payload) => request(`/logs/${id}`, { method: "PATCH", json: payload }),
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

  // Training log (sets/reps/weight — kept indefinitely, user-dated, same pattern as measurements)
  listWorkouts: () => request("/workouts"),
  addWorkout: (payload) => request("/workouts", { method: "POST", json: payload }),
  updateWorkout: (id, payload) => request(`/workouts/${id}`, { method: "PATCH", json: payload }),
  deleteWorkout: (id) => request(`/workouts/${id}`, { method: "DELETE" }),

  // Trends (7-day aggregation + streak)
  getTrends: () => request("/trends"),

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
  suggestMeals: (filters) =>
    request("/coach/suggest-meals", {
      method: "POST",
      json: { filters: filters || [], language: getLanguage() },
      timeoutMs: 20000,
    }),

  // Discover — recipes/workout-plans are the curated static catalog
  // (instant, backend/data/discover_data.py); exercises/products proxy live
  // external APIs (wger.de, Open Food Facts search) so those two get a
  // longer timeout and tolerate taking a beat longer to answer.
  getRecipes: (params = {}, { signal } = {}) => request(`/discover/recipes?${new URLSearchParams(params)}`, { signal }),
  getWorkoutPlans: (params = {}, { signal } = {}) => request(`/discover/workout-plans?${new URLSearchParams(params)}`, { signal }),
  searchExercises: (params = {}, { signal } = {}) => request(`/discover/exercises/search?${new URLSearchParams(params)}`, { timeoutMs: 20000, signal }),
  searchProducts: (params = {}, { signal } = {}) => request(`/discover/products/search?${new URLSearchParams(params)}`, { timeoutMs: 20000, signal }),
};
