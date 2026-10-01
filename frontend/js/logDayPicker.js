// "Which day is this going into?" — the one control both food-entry sheets
// (manual entry and the scan sheet) use to show, and change, the day a NEW
// entry is logged to.
//
// Why it exists. Backdating used to be reachable only from Progress → Daily
// history → a day → "+ Add", and the day it targeted lived in a module
// variable nothing on screen reflected once the user moved on to Photo /
// Describe / Barcode. When a regression dropped that variable on the scan
// sheet, a meal meant for yesterday silently landed on today and the user had
// no way to see it coming. Showing the target day on every add surface makes
// the state visible (a wrong day is now something the user can see and fix
// before confirming), and letting them change it makes "I forgot yesterday's
// dinner" a two-tap job from the + button instead of a hunt through Progress.
//
// Value contract, shared with app.js's manualTargetDate and scan.js's
// scanTargetDate: `null` means TODAY (the backend defaults log_date to today
// when it is omitted), a "YYYY-MM-DD" string means a past day. Picking today's
// chip hands back null rather than today's date string, so every existing
// "is this backdated?" check (`if (targetDate)`) keeps meaning what it means.
//
// Built once per mount and updated in place — the same rule the profile-cover
// picker follows (see settings.js::chooseBanner): rebuilding the chips on
// every open would be a pointless DOM churn on the app's most common sheet.

import { t, getLocale, onLanguageChange } from "./i18n.js";

// Mirrors backend Settings.retention_days (default 7) — the backend rejects a
// log_date older than `retention_days - 1` days ago (routers/logs.py's
// create_log), so offering an older chip would only ever produce a 422. Kept
// in sync by hand, same discipline as photoStore.js's PHOTO_RETENTION_DAYS.
export const LOG_WINDOW_DAYS = 7;

const pad2 = (n) => String(n).padStart(2, "0");
const toDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromDateStr = (s) => new Date(`${s}T00:00:00`);

// Newest last, so the row reads left-to-right the same way the Progress
// hero's week strip and the calorie chart already do.
function windowDays(today) {
  const base = fromDateStr(today);
  const days = [];
  for (let i = LOG_WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    days.push(toDateStr(d));
  }
  return days;
}

// True for a PAST day the backend would still accept (today itself is not
// "within" in this sense — today is represented by null, never by a date).
export function isWithinLogWindow(date, todayDate) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const days = windowDays(todayDate || toDateStr(new Date()));
  return days.includes(date) && date !== days[days.length - 1];
}

function relativeName(date, today) {
  if (date === today) return t("logDay.today");
  const yesterday = fromDateStr(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date === toDateStr(yesterday)) return t("logDay.yesterday");
  return null;
}

const CALENDAR_ICON =
  '<svg class="log-day-pill-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 9.5h17M8 3v3.5M16 3v3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const CHEVRON_ICON =
  '<svg class="log-day-pill-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 10l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// `root` is an empty container in index.html. `onChange(dateOrNull)` fires
// only on a user's pick, never on setDate() — callers set the value
// themselves and already know what they set.
export function createLogDayPicker(root, { onChange } = {}) {
  const optionsId = `${root.id}-options`;
  root.classList.add("log-day-picker");
  root.innerHTML = `
    <button type="button" class="log-day-pill" aria-expanded="false" aria-controls="${optionsId}">
      ${CALENDAR_ICON}<span class="log-day-pill-text"></span>${CHEVRON_ICON}
    </button>
    <div class="log-day-options" id="${optionsId}" hidden>
      <div class="log-day-chips" role="radiogroup"></div>
      <p class="log-day-hint"></p>
    </div>`;
  const pill = root.querySelector(".log-day-pill");
  const pillText = root.querySelector(".log-day-pill-text");
  const options = root.querySelector(".log-day-options");
  const chips = root.querySelector(".log-day-chips");
  const hint = root.querySelector(".log-day-hint");

  let today = toDateStr(new Date());
  let value = null; // null = today, see the module comment
  let lockedDate = null; // today's date while End Day has locked it, else null
  let builtFor = null; // the `today` the chips were last built against

  const selected = () => value || today;

  function buildChips() {
    if (builtFor === today) return;
    builtFor = today;
    chips.innerHTML = "";
    for (const date of windowDays(today)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "log-day-chip";
      btn.setAttribute("role", "radio");
      btn.dataset.date = date;
      btn.innerHTML = '<span class="log-day-chip-name"></span><span class="log-day-chip-num mono"></span>';
      chips.appendChild(btn);
    }
  }

  function paint() {
    buildChips();
    const locale = getLocale();
    const current = selected();
    const isPast = current !== today;
    const shortDate = fromDateStr(current).toLocaleDateString(locale, { month: "short", day: "numeric" });
    const weekday = fromDateStr(current).toLocaleDateString(locale, { weekday: "long" });
    // Romanian weekdays come back lowercase ("marți"); the pill starts a phrase.
    const name = relativeName(current, today) || weekday.charAt(0).toLocaleUpperCase(locale) + weekday.slice(1);
    pillText.textContent = t("logDay.pill", { day: name, date: shortDate });
    pill.classList.toggle("is-past", isPast);
    pill.setAttribute("aria-label", t("logDay.changeAria", { day: name, date: shortDate }));
    chips.setAttribute("aria-label", t("logDay.groupAria"));
    hint.textContent = t("logDay.hint", { days: LOG_WINDOW_DAYS });

    chips.querySelectorAll(".log-day-chip").forEach((btn) => {
      const date = btn.dataset.date;
      const d = fromDateStr(date);
      // Only today gets a word instead of a weekday: seven chips share one
      // phone-width row, and "Yesterday" does not fit in a seventh of it. The
      // pill above already says "Yesterday" once that chip is picked.
      btn.querySelector(".log-day-chip-name").textContent =
        date === today ? t("logDay.today") : d.toLocaleDateString(locale, { weekday: "short" });
      btn.querySelector(".log-day-chip-num").textContent = String(d.getDate());
      const isSelected = date === current;
      btn.classList.toggle("active", isSelected);
      btn.setAttribute("aria-checked", String(isSelected));
      // Today while End Day holds it: shown, so the row never looks like it
      // is missing a day, but not pickable — the submit would only be refused
      // (routers/logs.py's 409) after the user had already filled the form.
      const locked = date === lockedDate;
      btn.disabled = locked;
      btn.classList.toggle("locked", locked);
      btn.title = locked ? t("day.addBlockedToast") : "";
      btn.setAttribute("aria-label", d.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" }));
    });
  }

  function setOpen(open) {
    options.hidden = !open;
    pill.setAttribute("aria-expanded", String(open));
    root.classList.toggle("open", open);
  }

  pill.addEventListener("click", () => setOpen(options.hidden));

  chips.addEventListener("click", (e) => {
    const btn = e.target.closest(".log-day-chip");
    if (!btn || btn.disabled) return;
    const date = btn.dataset.date;
    value = date === today ? null : date;
    paint();
    setOpen(false);
    onChange?.(value);
  });

  onLanguageChange(() => {
    if (!root.hidden) paint();
  });

  return {
    // `todayDate` is the backend's tz-aware "today" (GET /day) when the caller
    // has it — the browser's own clock is only the fallback, since the two can
    // disagree around midnight for a user whose profile timezone differs from
    // the device's.
    setDate(date, { todayDate, locked = false } = {}) {
      today = todayDate || toDateStr(new Date());
      value = date && date !== today ? date : null;
      lockedDate = locked ? today : null;
      setOpen(false);
      paint();
    },
    getDate: () => value,
    setVisible(visible) {
      root.hidden = !visible;
      if (!visible) setOpen(false);
    },
  };
}
