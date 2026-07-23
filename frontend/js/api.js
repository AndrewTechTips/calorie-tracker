import { API_BASE_URL } from "./config.js?v=20260723c";
import { supabaseClient } from "./supabaseClient.js?v=20260723c";

async function authHeader() {
  const { data } = await supabaseClient.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error("Not signed in");
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
    throw new Error("Your session expired — please log in again.");
  }
  if (res.status === 429) {
    // slowapi's default error body is {"error": "..."}, not {"detail": "..."}
    // like the rest of this API, so the generic branch below would otherwise
    // just say "Request failed (429)" — worth a clearer, friendlier message.
    throw new Error("You're doing that a bit too fast — please wait a moment and try again.");
  }
  if (!res.ok) {
    const message = body?.detail || `Request failed (${res.status})`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
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
      throw new Error("The server is taking too long to respond. Please try again.");
    }
    throw new Error("Could not reach the server. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
  }
  return handleResponse(res);
}

// Free-tier hosts (Render et al.) spin the backend down after inactivity, and
// a cold start can take 30-60s. Called once at page load, well before the
// user finishes typing their login, so that wait happens in the background
// instead of eating into their first real action. No auth needed (hits the
// public health check), fire-and-forget — a failure here is silent and
// harmless, the real requests will surface their own errors if the backend
// is genuinely unreachable.
export function warmBackend() {
  fetch(`${API_BASE_URL}/`).catch(() => {});
}

// ---------------------------------------------------------------------------
export const api = {
  // Targets
  getTargets: () => request("/targets"),
  updateTargets: (payload) => request("/targets", { method: "PUT", json: payload }),

  // Scan
  scanFood: (file, contextText) => {
    const form = new FormData();
    form.append("image", file);
    form.append("context_text", contextText || "");
    return request("/scan", { method: "POST", formData: form, timeoutMs: 45000 });
  },

  // Logs
  listLogs: () => request("/logs"),
  createLog: (payload) => request("/logs", { method: "POST", json: payload }),
  correctLog: (id, payload) => request(`/logs/${id}`, { method: "PATCH", json: payload }),
  deleteLog: (id) => request(`/logs/${id}`, { method: "DELETE" }),

  // Saved meals
  listSavedMeals: () => request("/meals"),
  saveMeal: (payload) => request("/meals", { method: "POST", json: payload }),
  logSavedMeal: (id) => request(`/meals/${id}/log`, { method: "POST" }),
  deleteSavedMeal: (id) => request(`/meals/${id}`, { method: "DELETE" }),

  // Water
  getTodayWater: () => request("/water/today"),
  addWater: (amountMl) => request("/water", { method: "POST", json: { amount_ml: amountMl } }),
  deleteWaterEntry: (id) => request(`/water/${id}`, { method: "DELETE" }),
};
