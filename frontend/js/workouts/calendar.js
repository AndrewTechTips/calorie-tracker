// The month grid. Lifted verbatim out of workoutDiary.js (Phase 0.3) apart
// from one deliberate seam, called out here because it is the only place in
// this split where the code shape changed at all:
//
// `selectDate()` used to end by calling `renderDayDetail()` and
// `closeActiveSession()` directly. Both now live in sessionView.js, which
// already imports THIS module (for updateCalendarDots) — so importing it back
// would make the folder's first import cycle, for two calls that are really
// "tell whoever cares that the selected date moved". It takes an injected
// callback instead, wired once in index.js. Same two functions run, in the
// same order, at the same moment; the difference is only who names them.
import { getLocale } from "../i18n.js";
import { isoDate, parseIsoDate, sessionDateSet, state, todayIso } from "./workoutState.js";

const el = (id) => document.getElementById(id);

// Set once by index.js at init. Kept optional-call (`?.()`) so this module
// stays usable — and testable — without a listener attached.
let onDateSelected = null;
export function setOnDateSelected(fn) {
  onDateSelected = fn;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
// Weekday header built off a known Monday (2024-01-01), so it's correct
// regardless of the current date, and locale-formatted so English/Romanian
// each get their own real weekday abbreviations rather than a hardcoded set.
function renderWeekdayHeader() {
  const container = el("wd-cal-weekdays");
  if (container.childElementCount) return; // static — built once
  const monday = new Date(2024, 0, 1);
  const labels = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    labels.push(d.toLocaleDateString(getLocale(), { weekday: "short" }));
  }
  container.replaceChildren(
    ...labels.map((label) => {
      const span = document.createElement("span");
      span.className = "wd-calendar-weekday";
      span.textContent = label;
      return span;
    }),
  );
}

export function renderCalendar() {
  renderWeekdayHeader();
  el("wd-cal-title").textContent = state.calendarCursor.toLocaleDateString(getLocale(), { month: "long", year: "numeric" });

  const year = state.calendarCursor.getFullYear();
  const month = state.calendarCursor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  // Monday-first grid: JS getDay() is 0=Sunday..6=Saturday, shift so Monday=0.
  const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - leadingBlanks);

  const datesWithSessions = sessionDateSet();
  const todayIsoStr = todayIso();

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    const dateIso = isoDate(date);
    if (i >= 35 && date.getMonth() !== month) break; // 5 full rows already cover every real month; only extend to 6 if the month itself needs it
    cells.push({ date, dateIso, otherMonth: date.getMonth() !== month });
  }

  const grid = el("wd-cal-grid");
  grid.replaceChildren(
    ...cells.map(({ date, dateIso, otherMonth }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wd-calendar-day";
      if (otherMonth) btn.classList.add("wd-other-month");
      if (dateIso === todayIsoStr) btn.classList.add("wd-today");
      if (dateIso === state.selectedDate) btn.classList.add("wd-selected");
      btn.dataset.date = dateIso;
      btn.textContent = String(date.getDate());
      if (datesWithSessions.has(dateIso)) {
        const dot = document.createElement("span");
        dot.className = "wd-calendar-day-dot";
        btn.appendChild(dot);
      }
      btn.addEventListener("click", () => selectDate(dateIso));
      return btn;
    }),
  );
}

// Selecting a date within the month already on screen only ever needs its
// `.wd-selected` class moved — not a full grid rebuild. `renderCalendar()`
// tears down and recreates all 42 day buttons via `replaceChildren`, and
// every fresh button replays `wd-cal-day-in`'s entrance animation
// (opacity 0→1, scale 0.82→1). That's what produced the "aggressive
// refresh" flash on every tap: mid-animation, the CSS animation's own
// `opacity` keyframe temporarily overrides `.wd-other-month`'s steady-state
// `opacity: 0.35`, so every greyed-out day briefly renders at full opacity
// (reads as "flashing white") before settling back down once the animation
// ends a moment later. Reserve the full rebuild for when the visible month
// actually changes (navigating months, or selecting a date outside it).
export function updateCalendarSelection() {
  const grid = el("wd-cal-grid");
  const previous = grid.querySelector(".wd-calendar-day.wd-selected");
  if (previous) previous.classList.remove("wd-selected");
  const next = grid.querySelector(`.wd-calendar-day[data-date="${state.selectedDate}"]`);
  if (next) next.classList.add("wd-selected");
}

// The same argument as updateCalendarSelection() above, for the OTHER reason
// the grid used to be thrown away and rebuilt — a change to the logged data
// rather than to which date is selected.
//
// `renderCalendar()` was being called after every set add, set delete, session
// finish and session delete. Only one of those can change anything the grid
// actually draws (a session appearing or disappearing moves one date's dot);
// adding a set to a session that already exists changes nothing on screen at
// all. Either way the cost was the same and it was the full one: 42 buttons
// torn down and recreated via `replaceChildren`, 42 fresh click listeners, and
// `wd-cal-day-in` (style.css — opacity 0->1, scale 0.82->1, 0.28s) replayed on
// every cell. Mid-animation that keyframe's own `opacity` overrides
// `.wd-other-month`'s steady-state 0.35, so every greyed-out day flashes to
// full opacity and back — the exact flash updateCalendarSelection() was added
// to fix, still firing on the hottest path in the view, once per logged set.
//
// This syncs the dots in place instead: one pass over the existing buttons,
// adding or removing only the dots whose date's session state has actually
// changed. No teardown, no new listeners, no animation, and no work at all in
// the common case where nothing moved. It stays a full sync rather than a
// targeted "this one date changed" call so it cannot drift out of step with
// `state.sessions` the way a per-date update would if a caller forgot to say
// which date it touched.
export function updateCalendarDots() {
  const grid = el("wd-cal-grid");
  if (!grid.childElementCount) return; // never painted yet — openView() builds it from scratch
  const datesWithSessions = sessionDateSet();
  grid.querySelectorAll(".wd-calendar-day").forEach((btn) => {
    const shouldHaveDot = datesWithSessions.has(btn.dataset.date);
    const dot = btn.querySelector(".wd-calendar-day-dot");
    if (shouldHaveDot && !dot) {
      const span = document.createElement("span");
      span.className = "wd-calendar-day-dot";
      btn.appendChild(span);
    } else if (!shouldHaveDot && dot) {
      dot.remove();
    }
  });
}

export function selectDate(dateIso) {
  state.selectedDate = dateIso;
  const selectedMonth = parseIsoDate(dateIso);
  const monthChanged = selectedMonth.getMonth() !== state.calendarCursor.getMonth() || selectedMonth.getFullYear() !== state.calendarCursor.getFullYear();
  if (monthChanged) {
    state.calendarCursor = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), 1);
    renderCalendar();
  } else {
    updateCalendarSelection();
  }
  onDateSelected?.();
}
