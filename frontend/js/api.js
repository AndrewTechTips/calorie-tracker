import { API_BASE_URL } from "./config.js?v=20260731j";
import { supabaseClient } from "./supabaseClient.js?v=20260731j";
import { t } from "./i18n.js?v=20260731j";

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

async function request(path, { method = "GET", json, formData, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
  init.signal = controller.signal;

  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, init);
  } catch (err) {
    if (err.name === "AbortError") {
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

  // Day tracking (today's local date + whether it's been manually ended)
  getDayState: () => request("/day"),
  endDay: () => request("/day/end", { method: "POST" }),
  updateTimezone: (timezone) => request("/day/timezone", { method: "PUT", json: { timezone } }),

  // Scan
  scanFood: (file, contextText) => {
    const form = new FormData();
    form.append("image", file);
    form.append("context_text", contextText || "");
    return request("/scan", { method: "POST", formData: form, timeoutMs: 45000 });
  },
  scanBarcode: (code) => request(`/scan/barcode/${encodeURIComponent(code)}`, { timeoutMs: 15000 }),
  scanDescription: (description) => request("/scan/describe", { method: "POST", json: { description }, timeoutMs: 20000 }),
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
};
