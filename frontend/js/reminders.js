import { showToast } from "./ui.js?v=20260725f";
import { t } from "./i18n.js?v=20260725f";

// Deliberately lightweight, zero-backend-infra reminders: no VAPID keys, no
// push-subscription table, no server involvement at all — just the
// Notification permission + a local "have I reminded today" check run from
// the page itself whenever it's open. This means it can only ever fire
// while the tab/installed app is open or in the foreground, never when
// fully closed — that limitation is stated directly in the settings UI
// (reminders.foregroundNote), not hidden. A true background-push version
// would need a subscriptions table and a server-side push call, which is a
// meaningfully bigger feature than what was asked for here.
const KEY_ENABLED = "ironlog_reminder_enabled";
const KEY_TIME = "ironlog_reminder_time"; // "HH:MM"
const KEY_LAST_FIRED = "ironlog_reminder_last_fired"; // "YYYY-MM-DD"
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const el = (id) => document.getElementById(id);

const isEnabled = () => localStorage.getItem(KEY_ENABLED) === "1";
const getTime = () => localStorage.getItem(KEY_TIME) || "19:00";
const todayKey = () => new Date().toISOString().slice(0, 10);

async function maybeFireReminder() {
  if (!isEnabled()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (localStorage.getItem(KEY_LAST_FIRED) === todayKey()) return;

  const [hours, minutes] = getTime().split(":").map(Number);
  const due = new Date();
  due.setHours(hours, minutes, 0, 0);
  if (new Date() < due) return;

  localStorage.setItem(KEY_LAST_FIRED, todayKey());
  const body = t("reminders.notificationBody");
  const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
  if (registration) {
    registration.showNotification("Iron Log", { body, icon: "icons/icon-192.png", badge: "icons/icon-192.png" });
  } else {
    new Notification("Iron Log", { body, icon: "icons/icon-192.png" });
  }
}

export function initReminders() {
  const toggle = el("reminder-toggle");
  const timeRow = el("reminder-time-row");
  const timeInput = el("reminder-time");

  toggle.checked = isEnabled();
  timeRow.hidden = !isEnabled();
  timeInput.value = getTime();

  toggle.addEventListener("change", async () => {
    if (!toggle.checked) {
      localStorage.setItem(KEY_ENABLED, "0");
      timeRow.hidden = true;
      showToast(t("reminders.disabledToast"), "success");
      return;
    }

    if (!("Notification" in window)) {
      toggle.checked = false;
      showToast(t("reminders.permissionDenied"), "error");
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toggle.checked = false;
      showToast(t("reminders.permissionDenied"), "error");
      return;
    }

    localStorage.setItem(KEY_ENABLED, "1");
    timeRow.hidden = false;
    showToast(t("reminders.enabledToast"), "success");
    maybeFireReminder();
  });

  timeInput.addEventListener("change", () => {
    localStorage.setItem(KEY_TIME, timeInput.value);
  });

  // Checked once immediately (covers "opened the app after today's reminder
  // time already passed") and periodically thereafter for as long as the
  // app stays open in the foreground.
  maybeFireReminder();
  setInterval(maybeFireReminder, CHECK_INTERVAL_MS);
}
