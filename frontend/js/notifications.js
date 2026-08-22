import { api } from "./api.js?v=20260822s";
import { VAPID_PUBLIC_KEY } from "./config.js?v=20260822s";
import { showToast } from "./ui.js?v=20260822s";
import { getLanguage, onLanguageChange, t } from "./i18n.js?v=20260822s";

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

async function savePreferences(patch) {
  // Stamps the CURRENT UI language onto every save, not just an explicit
  // language-change event — see backend/services/notification_scheduler.py's
  // localized copy, which reads this stored value for every push it sends
  // (a background sweep has no live request to read a language header
  // from). This keeps it correct with zero extra plumbing even for a user
  // who switches language once and never touches Settings → Notifications
  // again afterward.
  const previous = preferences;
  const next = { ...preferences, ...patch, language: getLanguage() };
  preferences = next; // optimistic
  try {
    await api.updateNotificationPreferences(next);
  } catch {
    // Roll back to what the backend actually has — without this, a failed
    // save (flaky connection, backend hiccup) left the UI showing e.g.
    // "hourly reminders" selected while the server silently kept whatever
    // config it had before, so the schedule the user sees on screen and the
    // one actually running server-side would quietly disagree. The backend
    // is the sole source of truth for what fires (services/
    // notification_scheduler.py), so the UI must reflect its real state,
    // not the un-persisted optimistic guess.
    preferences = previous;
    renderToggles();
    showToast(t("reminders.saveFailedToast"), "error");
  }
}

async function subscribeAndRegister() {
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  await api.subscribePush(subscription.toJSON());
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
    if (subscription) await api.subscribePush(subscription.toJSON());
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
      await savePreferences({ push_enabled: true });
      renderToggles();
      showToast(t("reminders.enabledToast"), "success");
    } else {
      await unsubscribeAndDeregister();
      await savePreferences({ push_enabled: false });
      renderToggles();
      showToast(t("reminders.disabledToast"), "success");
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
    showToast(t(event.target.checked ? "reminders.smartNudgeEnabledToast" : "reminders.smartNudgeDisabledToast"), "success");
  });

  el("weekly-recap-toggle").addEventListener("change", (event) => {
    savePreferences({ weekly_recap_enabled: event.target.checked });
    showToast(t(event.target.checked ? "reminders.weeklyRecapEnabledToast" : "reminders.weeklyRecapDisabledToast"), "success");
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
      api.subscribePush(event.data.subscription).catch(() => {});
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
