import { showToast } from "./ui.js?v=20260810j";
import { t } from "./i18n.js?v=20260810j";

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
const KEY_SMART_ENABLED = "ironlog_smart_nudge_enabled";
const KEY_LAST_FOOD_NUDGE_DATE = "ironlog_last_food_nudge_date"; // "YYYY-MM-DD"
const KEY_LAST_WATER_NUDGE_DATE = "ironlog_last_water_nudge_date"; // "YYYY-MM-DD"
const KEY_WEEKLY_RECAP_ENABLED = "ironlog_weekly_recap_enabled";
const KEY_LAST_RECAP_DATE = "ironlog_last_weekly_recap_date"; // "YYYY-MM-DD" of the Sunday it fired
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Smart nudges check in at most once per kind per day, each only after its
// own local-time threshold has passed — gives the user a fair chance to
// catch up on their own before nudging, and keeps this to at most 2
// notifications/day total (one water, one food) so it stays useful instead
// of spammy.
const FOOD_NUDGE_HOUR = 14;
const WATER_NUDGE_HOUR = 15;
const NUDGE_WINDOW_END_HOUR = 22;
// "Sunday evening" — JS Date.getDay() === 0 is Sunday regardless of locale
// (the getDay() numbering itself is locale-independent, unlike e.g.
// Intl.DateTimeFormat's first-day-of-week).
const RECAP_DAY_OF_WEEK = 0;
const RECAP_HOUR = 18;

const el = (id) => document.getElementById(id);

const isEnabled = () => localStorage.getItem(KEY_ENABLED) === "1";
const isSmartEnabled = () => localStorage.getItem(KEY_SMART_ENABLED) === "1";
const isWeeklyRecapEnabled = () => localStorage.getItem(KEY_WEEKLY_RECAP_ENABLED) === "1";
const getTime = () => localStorage.getItem(KEY_TIME) || "19:00";
const todayKey = () => new Date().toISOString().slice(0, 10);

async function sendNotification(body) {
  const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
  if (registration) {
    registration.showNotification("Iron Log", { body, icon: "icons/icon-192.png", badge: "icons/icon-192.png" });
  } else {
    new Notification("Iron Log", { body, icon: "icons/icon-192.png" });
  }
}

async function maybeFireReminder() {
  if (!isEnabled()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (localStorage.getItem(KEY_LAST_FIRED) === todayKey()) return;

  const [hours, minutes] = getTime().split(":").map(Number);
  const due = new Date();
  due.setHours(hours, minutes, 0, 0);
  if (new Date() < due) return;

  localStorage.setItem(KEY_LAST_FIRED, todayKey());
  await sendNotification(t("reminders.notificationBody"));
}

// Fed by app.js on every render() — deliberately just a few stashed
// primitives, not a reference to the app's own state object, so this module
// stays independent of app.js's internals and easy to reason about.
// weekAdherentDays/weekLoggedDays (used by the weekly recap below) are
// derived by app.js from state.logs, which already covers the full
// retention window (not just today) — see app.js's computeWeekAdherence.
let context = { waterMl: 0, waterTargetMl: 3000, hasLoggedFoodToday: false, weekAdherentDays: 0, weekLoggedDays: 0 };
export function setContext(next) {
  context = { ...context, ...next };
}

async function maybeFireSmartNudges() {
  if (!isSmartEnabled()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const hour = new Date().getHours();
  if (hour >= NUDGE_WINDOW_END_HOUR) return;
  const today = todayKey();

  if (hour >= FOOD_NUDGE_HOUR && !context.hasLoggedFoodToday && localStorage.getItem(KEY_LAST_FOOD_NUDGE_DATE) !== today) {
    localStorage.setItem(KEY_LAST_FOOD_NUDGE_DATE, today);
    await sendNotification(t("reminders.foodNudgeBody"));
    return; // one nudge per check tick — never stack two in the same pass
  }

  if (hour >= WATER_NUDGE_HOUR && context.waterMl < context.waterTargetMl && localStorage.getItem(KEY_LAST_WATER_NUDGE_DATE) !== today) {
    localStorage.setItem(KEY_LAST_WATER_NUDGE_DATE, today);
    await sendNotification(t("reminders.waterNudgeBody"));
  }
}

// Local-only — no server call, no cached Gemini recap here (that's the AI
// coach's own weekly summary, a separate feature). This is purely the
// existing per-day adherence data app.js already has, read once a week.
async function maybeFireWeeklyRecap() {
  if (!isWeeklyRecapEnabled()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const now = new Date();
  if (now.getDay() !== RECAP_DAY_OF_WEEK || now.getHours() < RECAP_HOUR) return;
  const today = todayKey();
  if (localStorage.getItem(KEY_LAST_RECAP_DATE) === today) return;

  localStorage.setItem(KEY_LAST_RECAP_DATE, today);
  const body =
    context.weekLoggedDays > 0
      ? t("reminders.weeklyRecapBodyWithLogs", { adherent: context.weekAdherentDays, logged: context.weekLoggedDays })
      : t("reminders.weeklyRecapBodyNoLogs");
  await sendNotification(body);
}

async function requestNotificationPermission(toggle) {
  if (!("Notification" in window)) {
    toggle.checked = false;
    showToast(t("reminders.permissionDenied"), "error");
    return false;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    toggle.checked = false;
    showToast(t("reminders.permissionDenied"), "error");
    return false;
  }
  return true;
}

export function initReminders() {
  const toggle = el("reminder-toggle");
  const timeRow = el("reminder-time-row");
  const timeInput = el("reminder-time");
  const smartToggle = el("smart-nudge-toggle");
  const weeklyRecapToggle = el("weekly-recap-toggle");

  toggle.checked = isEnabled();
  timeRow.hidden = !isEnabled();
  timeInput.value = getTime();
  smartToggle.checked = isSmartEnabled();
  weeklyRecapToggle.checked = isWeeklyRecapEnabled();

  toggle.addEventListener("change", async () => {
    if (!toggle.checked) {
      localStorage.setItem(KEY_ENABLED, "0");
      timeRow.hidden = true;
      showToast(t("reminders.disabledToast"), "success");
      return;
    }

    if (!(await requestNotificationPermission(toggle))) return;

    localStorage.setItem(KEY_ENABLED, "1");
    timeRow.hidden = false;
    showToast(t("reminders.enabledToast"), "success");
    maybeFireReminder();
  });

  timeInput.addEventListener("change", () => {
    localStorage.setItem(KEY_TIME, timeInput.value);
  });

  smartToggle.addEventListener("change", async () => {
    if (!smartToggle.checked) {
      localStorage.setItem(KEY_SMART_ENABLED, "0");
      showToast(t("reminders.smartNudgeDisabledToast"), "success");
      return;
    }

    if (!(await requestNotificationPermission(smartToggle))) return;

    localStorage.setItem(KEY_SMART_ENABLED, "1");
    showToast(t("reminders.smartNudgeEnabledToast"), "success");
    maybeFireSmartNudges();
  });

  weeklyRecapToggle.addEventListener("change", async () => {
    if (!weeklyRecapToggle.checked) {
      localStorage.setItem(KEY_WEEKLY_RECAP_ENABLED, "0");
      showToast(t("reminders.weeklyRecapDisabledToast"), "success");
      return;
    }

    if (!(await requestNotificationPermission(weeklyRecapToggle))) return;

    localStorage.setItem(KEY_WEEKLY_RECAP_ENABLED, "1");
    showToast(t("reminders.weeklyRecapEnabledToast"), "success");
    maybeFireWeeklyRecap();
  });

  // Checked once immediately (covers "opened the app after today's reminder
  // time already passed") and periodically thereafter for as long as the
  // app stays open in the foreground.
  maybeFireReminder();
  maybeFireSmartNudges();
  maybeFireWeeklyRecap();
  setInterval(() => {
    maybeFireReminder();
    maybeFireSmartNudges();
    maybeFireWeeklyRecap();
  }, CHECK_INTERVAL_MS);
}
