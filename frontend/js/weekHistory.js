// Client-side weekly history — "The Rack". Phase 2 of the Progress-tab
// redesign (js/progress.js renders it; this file is the data layer only).
//
// The backend's GET /trends only ever returns a trailing 7-day retention
// window — older daily_logs rows are deleted (Settings.retention_days, see
// CLAUDE.md) — so a *past* week's record genuinely can't be re-fetched from
// the server. It has to be snapshotted in the browser: the first time the
// Progress tab is opened in a new calendar week, we capture the trailing-7
// window exactly as it stands (the same 7 days Phase 1's "This week" row
// shows) and keep it in localStorage. Never sent anywhere.
//
// Same client-only, degrade-quietly-if-storage-is-blocked discipline as
// js/streakFreeze.js. Each snapshot keeps only { date, adherent, logged }
// per day — no food names, no calorie values.

import { computeMomentum } from "./momentumMath.js";
import { getLanguage } from "./i18n.js";

const STORAGE_KEY = "ironlog_week_history";
const SCHEMA_VERSION = 1;
const MAX_WEEKS = 26; // ~6 months; FIFO-evict older. Tiny records, but not unbounded over years.

// The local calendar Monday (as "YYYY-MM-DD") of the week containing `dateStr`.
// Used as each snapshot's key: naturally unique per week, sorts lexically,
// and doubles as a stable identity that can't drift the way an ISO
// week-number can around year boundaries.
export function weekStartMonday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const back = (d.getDay() + 6) % 7; // days since Monday (getDay: 0 = Sunday)
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (raw && raw.v === SCHEMA_VERSION && Array.isArray(raw.weeks)) {
      return {
        v: SCHEMA_VERSION,
        seededKey: typeof raw.seededKey === "string" ? raw.seededKey : null,
        weeks: raw.weeks,
      };
    }
  } catch {
    /* corrupt / blocked storage — treat as "no history", same as streakFreeze.js */
  }
  return { v: SCHEMA_VERSION, seededKey: null, weeks: [] };
}

function save(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* losing this is only a cosmetic regression (a week not recorded) —
       never a correctness issue for real logged data */
  }
}

// onTrack: adherent-day count for the week being recorded.
// m: its computeMomentum() result. priorWeeks: everything already on the rack.
function headlineFor(onTrack, m, priorWeeks) {
  const priorBest = priorWeeks.reduce((mx, w) => Math.max(mx, w.onTrack || 0), 0);
  const last = priorWeeks.length ? priorWeeks[priorWeeks.length - 1] : null;
  if (onTrack >= 3 && onTrack > priorBest) return { key: "progress.weekHeadlineStrongest", vars: {} };
  if (last && onTrack >= 1 && onTrack === (last.onTrack || 0)) {
    return { key: "progress.weekHeadlineSameAsLast", vars: { count: onTrack } };
  }
  if (onTrack >= 2) return { key: "progress.weekHeadlineOnTrack", vars: { count: onTrack } };
  if (onTrack === 1) return { key: "progress.weekHeadlineOnTrackOne", vars: { count: 1 } };
  if (m.anyActivity) return { key: "progress.weekHeadlineQuiet", vars: {} };
  return { key: "progress.weekHeadlineFresh", vars: {} };
}

function nudgeFor(tierKey) {
  if (tierKey === "Flying" || tierKey === "InGroove") return "progress.weekNudgeStrong";
  if (tierKey === "Rolling" || tierKey === "FindingFeet") return "progress.weekNudgeBuilding";
  return "progress.weekNudgeFresh";
}

// Called from progress.js's renderFromCache on every Progress-tab paint.
// Cheap and idempotent: usually a load + one string compare that returns
// false immediately. Actually records a week at most once per calendar week.
//
// days:   lastTrends.days (chronological, last entry = today)
// targets: currentTargets (needs daily_calories)
// Returns true only when a new week was just recorded.
export function maybeSnapshotWeek(days, targets) {
  if (!days?.length) return false;
  const targetCalories = targets?.daily_calories || 0;
  if (!targetCalories) return false;

  const today = days[days.length - 1].date;
  const curWeek = weekStartMonday(today);
  const state = load();

  if (state.seededKey == null) {
    // First run ever. Seed silently — we never record the week we were
    // installed in, because we didn't witness its start. Brand-new users and
    // freshly-updated users both just get a quiet seed here; the first real
    // check-in arrives next Monday.
    save({ ...state, seededKey: curWeek, weeks: state.weeks });
    return false;
  }

  const lastKey = state.weeks.length ? state.weeks[state.weeks.length - 1].key : state.seededKey;
  if (!(curWeek > lastKey)) return false; // same week we last recorded — nothing new

  // A new calendar week has begun since the last record. Capture the
  // trailing-7 window as it stands now — complete, identical to what the
  // "This week" row was showing a moment ago. If the user was away for
  // several weeks, only this one is recorded; the gap weeks are simply lost
  // (their daily_logs are long gone from the server anyway).
  const snapDays = days.map((d) => ({
    date: d.date,
    adherent: d.adherent === true,
    logged: (d.calories || 0) > 0,
  }));
  const m = computeMomentum(snapDays, targetCalories, { finalDayComplete: true });
  const onTrack = snapDays.filter((d) => d.adherent).length;

  const week = {
    key: curWeek,
    startDate: snapDays[0].date,
    endDate: snapDays[snapDays.length - 1].date,
    savedAt: Date.now(),
    days: snapDays,
    score: m.score,
    tierKey: m.tier.key,
    onTrack,
    judged: m.judgedDays,
    headline: headlineFor(onTrack, m, state.weeks),
    nudgeKey: nudgeFor(m.tier.key),
    dismissed: false,
    lang: getLanguage(), // which language the (interpolated) headline was built for — see progress.js's re-check
  };

  // Only ever one un-dismissed check-in at a time: if the last one was never
  // dismissed, it quietly moves to the rack as this one appears.
  const weeks = state.weeks.map((w) => ({ ...w, dismissed: true }));
  weeks.push(week);
  while (weeks.length > MAX_WEEKS) weeks.shift();
  save({ ...state, weeks });
  return true;
}

// Newest first — for the Past Weeks list.
export function getWeeks() {
  return load().weeks.slice().reverse();
}

// The one un-dismissed snapshot, or null. Drives whether the Sunday
// check-in card is shown.
export function getPendingCheckin() {
  const pending = load().weeks.filter((w) => !w.dismissed);
  return pending.length ? pending[pending.length - 1] : null;
}

// Marks the pending check-in (and defensively any older stragglers) as
// dismissed. The week stays on the rack — only the top-of-tab card goes away.
export function dismissPendingCheckin() {
  const state = load();
  let changed = false;
  const weeks = state.weeks.map((w) => {
    if (w.dismissed) return w;
    changed = true;
    return { ...w, dismissed: true };
  });
  if (changed) save({ ...state, weeks });
}
