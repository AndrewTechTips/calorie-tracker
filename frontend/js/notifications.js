import { api } from "./api.js";
import { VAPID_PUBLIC_KEY } from "./config.js";
import { showToast } from "./ui.js";
import { getLanguage, onLanguageChange, t } from "./i18n.js";

// Real Web Push (VAPID) — replaces the old local-only, tab-must-be-open
// reminder system (frontend/js/reminders.js, removed). The firing decision
// now lives entirely server-side (backend/services/notification_scheduler.py)
// so this module's only job is: (1) keep the browser's push subscription and
// this device's copy of it on the backend in sync, and (2) sync the settings
// UI toggles against GET/PUT /notifications/preferences. Nothing here polls
// or fires a notification itself anymore — doing that from an open tab
// alongside the server would risk a duplicate for the same event.
//
// Defaults deliberately mirror sql/schema.sql's own column defaults exactly
// (push_enabled false — a subscription still requires a real user gesture —
// everything else true/on) so that the very first time a user flips the
// master toggle, they land on a fully-configured, motivating setup with zero
// extra taps: a 7 PM daily reminder, smart nudges, and the weekly recap —
// see reminders.defaultsHint in index.html for the copy that tells them so.
const DEFAULT_PREFERENCES = {
  push_enabled: false,
  daily_reminder_enabled: true,
  reminder_mode: "fixed",
  daily_reminder_time: "19:00",
  reminder_interval_hours: 4,
  smart_nudges_enabled: true,
  weekly_recap_enabled: true,
  quiet_hours_start: "22:00",
  quiet_hours_end: "08:00",
  language: "en",
};

let preferences = { ...DEFAULT_PREFERENCES };
// Guards the language-change listener below: don't PUT a language-only patch
// before the real GET /notifications/preferences has ever resolved, or it
// would overwrite every other field with DEFAULT_PREFERENCES' placeholders.
let preferencesLoaded = false;

const el = (id) => document.getElementById(id);

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

// A stable per-install id, generated once and kept forever. This — not the
// push `endpoint`, which the browser silently rotates on its own (key
// refresh, storage pressure) — is what the backend upserts on to guarantee
// exactly ONE subscription row per device: every rotation lands back on the
// same row instead of leaving the pre-rotation endpoint behind as a
// still-briefly-deliverable orphan (the duplicate-notification bug). See
// sql/schema.sql's push_subscriptions.device_id comment.
const DEVICE_ID_KEY = "ironlog:device-id";
let sessionDeviceId = null;
function randomId() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = randomId();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // localStorage blocked (private mode / partitioned iframe): a
    // per-session id still collapses THIS session's rotations, just not
    // across restarts.
    if (!sessionDeviceId) sessionDeviceId = randomId();
    return sessionDeviceId;
  }
}

// True iff `subscription` was minted with exactly `vapidKey` as its
// applicationServerKey. A subscription left over from a different (old) VAPID
// key produces an endpoint whose pushes the backend's current VAPID
// signature can't authenticate — the push service 403s it and it becomes a
// silently-dead row — so reusing it must be avoided. `options` is unset in a
// few older engines: treat "can't tell" as a match rather than churn a
// perfectly good subscription.
function subscriptionMatchesVapidKey(subscription, vapidKey) {
  try {
    const current = subscription.options?.applicationServerKey;
    if (!current) return true;
    const a = new Uint8Array(current);
    const b = urlBase64ToUint8Array(vapidKey);
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  } catch {
    return true;
  }
}

// The reminder-time vs. reminder-interval rows are mutually exclusive
// (see reminder_mode) and both only ever meaningful while the daily
// reminder itself is on — split out from renderToggles() so the
// mode-select and toggle change handlers can re-run just this bit without
// re-touching every other control's value on every small change.
function renderReminderTimingRows() {
  const enabled = preferences.daily_reminder_enabled;
  const isInterval = preferences.reminder_mode === "interval";
  el("reminder-mode-row").hidden = !enabled;
  el("reminder-time-row").hidden = !enabled || isInterval;
  el("reminder-interval-row").hidden = !enabled || !isInterval;
}

function renderToggles() {
  el("push-master-toggle").checked = preferences.push_enabled;
  el("notification-options").hidden = !preferences.push_enabled;
  el("reminder-toggle").checked = preferences.daily_reminder_enabled;
  el("reminder-mode-select").value = preferences.reminder_mode;
  el("reminder-time").value = preferences.daily_reminder_time;
  el("reminder-interval-select").value = String(preferences.reminder_interval_hours);
  renderReminderTimingRows();
  el("smart-nudge-toggle").checked = preferences.smart_nudges_enabled;
  el("weekly-recap-toggle").checked = preferences.weekly_recap_enabled;
  el("quiet-hours-start").value = preferences.quiet_hours_start;
  el("quiet-hours-end").value = preferences.quiet_hours_end;
}

// Debounced so N preference changes made in quick succession (flipping a
// couple of toggles, adjusting both quiet-hours fields back to back) collapse
// into ONE PUT instead of N round trips — each one was previously firing
// immediately on its own "change" event. Optimistic apply is still instant
// (renderToggles() reflects every change the moment it's made, same as
// before); only the actual network write is delayed and batched.
const SAVE_DEBOUNCE_MS = 500;
// How long the quiet "Saved" confirmation stays visible before fading —
// replaces the old per-toggle success toast (push/smart-nudge/weekly-recap
// all used to show one), which fired on top of whatever the user was still
// actively doing in the sheet. A brief ambient confirmation instead of a
// modal interruption.
const SAVED_INDICATOR_VISIBLE_MS = 2000;

let saveTimer = null;
let savedIndicatorTimer = null;
// Snapshot of `preferences` from just BEFORE the current pending batch's
// first change — captured once per batch (null between batches), not
// per-patch, so a failed flush rolls back the WHOLE batch atomically rather
// than leaving it partially applied.
let pendingBatchSnapshot = null;

function showSavedIndicator() {
  const indicator = el("reminders-save-indicator");
  if (!indicator) return;
  indicator.textContent = t("reminders.savedIndicator");
  indicator.classList.add("visible");
  clearTimeout(savedIndicatorTimer);
  savedIndicatorTimer = setTimeout(() => indicator.classList.remove("visible"), SAVED_INDICATOR_VISIBLE_MS);
}

async function flushSave() {
  saveTimer = null;
  const toSend = preferences;
  const rollbackTo = pendingBatchSnapshot;
  pendingBatchSnapshot = null;
  try {
    await api.updateNotificationPreferences(toSend);
    showSavedIndicator();
  } catch {
    // Roll back to what the backend actually has — without this, a failed
    // save (flaky connection, backend hiccup) left the UI showing e.g.
    // "hourly reminders" selected while the server silently kept whatever
    // config it had before, so the schedule the user sees on screen and the
    // one actually running server-side would quietly disagree. The backend
    // is the sole source of truth for what fires (services/
    // notification_scheduler.py), so the UI must reflect its real state,
    // not the un-persisted optimistic guess. Still a toast, deliberately —
    // this is a real failure the user should notice, unlike the quiet
    // success case above.
    preferences = rollbackTo;
    renderToggles();
    showToast(t("reminders.saveFailedToast"), "error");
  }
}

// `immediate` skips the debounce and flushes right away — used only for
// push_enabled (see the master toggle handler below): that change is always
// paired with a real, already-awaited subscribe/unsubscribe side effect, so
// leaving the matching preference row un-persisted for a debounce window is
// a real risk (navigate away/close the tab inside that window and the
// backend never learns push is on, even though a live subscription now
// exists) — not just a missed batching opportunity, unlike every other
// field here.
function savePreferences(patch, { immediate = false } = {}) {
  // Stamps the CURRENT UI language onto every save, not just an explicit
  // language-change event — see backend/services/notification_scheduler.py's
  // localized copy, which reads this stored value for every push it sends
  // (a background sweep has no live request to read a language header
  // from). This keeps it correct with zero extra plumbing even for a user
  // who switches language once and never touches Settings → Notifications
  // again afterward.
  if (pendingBatchSnapshot === null) pendingBatchSnapshot = preferences;
  preferences = { ...preferences, ...patch, language: getLanguage() }; // optimistic, applied immediately regardless of debounce
  clearTimeout(saveTimer);
  if (immediate) {
    flushSave();
  } else {
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }
}

async function subscribeAndRegister() {
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  // Strictly reuse-or-replace: an existing subscription is kept ONLY if it
  // was created with the VAPID key we still use. A mismatch (key rotated, or
  // a leftover from another deploy) is torn down first so the subscribe
  // below mints one fresh endpoint the backend can actually authenticate —
  // never two.
  if (subscription && !subscriptionMatchesVapidKey(subscription, VAPID_PUBLIC_KEY)) {
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  await api.subscribePush(subscription.toJSON(), getDeviceId());
}

// Full teardown, not just flipping the preference flag — see
// sql/schema.sql's push_enabled column comment for why: a subscription this
// user has switched off would otherwise sit forever un-pinged (and
// therefore never hit the backend's own 410-Gone self-cleaning path), which
// is exactly the kind of dead-row bloat this whole feature is supposed to
// avoid. Re-enabling later is still cheap (no fresh permission prompt).
async function unsubscribeAndDeregister() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await api.unsubscribePush(endpoint).catch(() => {
    /* best-effort — a now-invalid endpoint will also self-clean on its next attempted send */
  });
}

async function enablePush() {
  if (!VAPID_PUBLIC_KEY || !pushSupported()) {
    el("push-unavailable-hint").hidden = false;
    return false;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    showToast(t("reminders.permissionDenied"), "error");
    return false;
  }
  try {
    await subscribeAndRegister();
    return true;
  } catch {
    showToast(t("reminders.subscribeFailedToast"), "error");
    return false;
  }
}

// Covers a returning session where permission + a live browser subscription
// already exist and preferences say push is on: makes sure the backend
// still has the CURRENT subscription on file, since the browser can rotate
// it on its own between visits (see sw.js's pushsubscriptionchange handler
// for the other half of this — that one covers the case where the rotation
// happens while this tab isn't even open).
async function resyncExistingSubscription() {
  if (!pushSupported() || !VAPID_PUBLIC_KEY) return;
  if (Notification.permission !== "granted") return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    // Keyed by device_id server-side, so this is self-healing: if the
    // browser rotated the endpoint while no tab was open, this POST both
    // registers the new endpoint AND drops the stale row for this device.
    if (subscription) await api.subscribePush(subscription.toJSON(), getDeviceId());
  } catch {
    /* best-effort resync — a real reminder firing later surfaces any persistent problem */
  }
}

export function initNotifications() {
  const masterToggle = el("push-master-toggle");
  if (!masterToggle) return; // settings markup not present (shouldn't happen in the real app shell)

  if (!pushSupported()) {
    el("push-unavailable-hint").hidden = false;
    masterToggle.disabled = true;
  }

  api
    .getNotificationPreferences()
    .then((prefs) => {
      preferences = { ...DEFAULT_PREFERENCES, ...prefs };
      preferencesLoaded = true;
      renderToggles();
      if (preferences.push_enabled) resyncExistingSubscription();
    })
    .catch(() => {
      /* Settings just show defaults on a fetch failure — not fatal, no toast on first load */
    });

  masterToggle.addEventListener("change", async (event) => {
    const wantsOn = event.target.checked;
    if (wantsOn) {
      const ok = await enablePush();
      if (!ok) {
        masterToggle.checked = false;
        return;
      }
      savePreferences({ push_enabled: true }, { immediate: true });
      renderToggles();
    } else {
      await unsubscribeAndDeregister();
      savePreferences({ push_enabled: false }, { immediate: true });
      renderToggles();
    }
  });

  el("reminder-toggle").addEventListener("change", (event) => {
    savePreferences({ daily_reminder_enabled: event.target.checked });
    renderReminderTimingRows();
  });

  el("reminder-mode-select").addEventListener("change", (event) => {
    savePreferences({ reminder_mode: event.target.value });
    renderReminderTimingRows();
  });

  el("reminder-time").addEventListener("change", (event) => {
    savePreferences({ daily_reminder_time: event.target.value });
  });

  el("reminder-interval-select").addEventListener("change", (event) => {
    savePreferences({ reminder_interval_hours: Number(event.target.value) });
  });

  el("smart-nudge-toggle").addEventListener("change", (event) => {
    savePreferences({ smart_nudges_enabled: event.target.checked });
  });

  el("weekly-recap-toggle").addEventListener("change", (event) => {
    savePreferences({ weekly_recap_enabled: event.target.checked });
  });

  el("quiet-hours-start").addEventListener("change", (event) => {
    savePreferences({ quiet_hours_start: event.target.value });
  });
  el("quiet-hours-end").addEventListener("change", (event) => {
    savePreferences({ quiet_hours_end: event.target.value });
  });

  el("test-notification-btn").addEventListener("click", async () => {
    try {
      await api.sendTestNotification();
      showToast(t("reminders.testSentToast"), "success");
    } catch {
      showToast(t("reminders.testFailedToast"), "error");
    }
  });

  // sw.js's pushsubscriptionchange handler hands a freshly browser-rotated
  // subscription to every open client via postMessage (it has no
  // authenticated Supabase session available to call the backend directly
  // from inside a service worker) — this is the other half of that handoff.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type !== "ironlog:push-subscription-changed") return;
      // Register the rotated endpoint (device_id-keyed, so it REPLACES this
      // device's row, not adds one) and — belt and braces for a push
      // service that keeps the old endpoint briefly deliverable — explicitly
      // delete the pre-rotation endpoint too.
      api.subscribePush(event.data.subscription, getDeviceId()).catch(() => {});
      if (event.data.oldEndpoint) api.unsubscribePush(event.data.oldEndpoint).catch(() => {});
    });
  }

  // A language switch (Settings' own language toggle) should retarget which
  // language future background pushes arrive in too, not just the visible
  // UI — savePreferences() already stamps getLanguage() onto every save, so
  // an empty patch here is enough to push just that one field. Guarded on
  // preferencesLoaded so this can never fire (and overwrite real settings
  // with placeholder defaults) before the initial GET above has resolved.
  onLanguageChange(() => {
    if (preferencesLoaded) savePreferences({});
  });
}
