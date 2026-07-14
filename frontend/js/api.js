import { API_BASE_URL } from "./config.js";
import { supabaseClient } from "./supabaseClient.js";

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
  if (!res.ok) {
    const message = body?.detail || `Request failed (${res.status})`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return body;
}

async function request(path, { method = "GET", json, formData } = {}) {
  const headers = await authHeader();
  const init = { method, headers };

  if (formData) {
    init.body = formData; // browser sets multipart boundary automatically
  } else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  }

  const res = await fetch(`${API_BASE_URL}${path}`, init);
  return handleResponse(res);
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
    return request("/scan", { method: "POST", formData: form });
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
};
