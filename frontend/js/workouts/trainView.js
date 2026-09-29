// The Train tab (Phase 1.3) — the bottom-nav destination that replaced Saved
// meals, and the front door the whole Workouts overhaul was blocked on.
//
// Everything this renders already existed; none of it was reachable in fewer
// than five taps, three of which were navigation through screens that say
// nothing about training (Progress -> Training tile -> detail sheet -> Open
// Diary). This is the same data one level up.
//
// Three zones, in the order a lifter needs them:
//   1. TODAY   — the hero. Four states, one primary button, one tap to train.
//   2. THIS WEEK — seven cells (rendered by routines.js, which owns the plan).
//   3. RECENT  — the last few sessions; the month calendar is behind a button.
//
// It owns no state of its own. Sessions come from workoutState, the weekly
// plan from routines.js, and every action delegates to the module that already
// performs it — this composes, it does not duplicate.
import { escapeHtml, reconcileList } from "../ui.js";
import { getLanguage, getLocale, t } from "../i18n.js";
import { translateExerciseName } from "../exerciseI18n.js";
import { parseIsoDate, sessionsForDate, state, todayIso } from "./workoutState.js";

const el = (id) => document.getElementById(id);

// How many of a routine's exercises to name on the Today card before
// collapsing the rest into "+N more". Four fits one line at phone width
// without wrapping into the button below it.
const TODAY_EXERCISE_PREVIEW = 4;
// The Recent list is a glance surface, not an archive — the archive is the
// Calendar button next to it.
const RECENT_SESSION_LIMIT = 6;

// Injected by index.js so this module never imports the things it triggers
// (routines.js imports workouts/index.js already, so reaching back for
// startRoutineToday here would close a cycle — the same seam calendar.js
// uses for onDateSelected, and for the same reason).
let actions = {
  startPlanned: null, // (plan) => void  — start today's planned routine
  startFree: null, //    () => void      — start/continue an unplanned session
  openSession: null, // (sessionId) => void
  openCalendar: null, // () => void
  openRoutines: null, // () => void
  planForToday: null, // () => plan | null
  renderWeek: null, //   () => void      — routines.js owns the week strip
  openCardio: null, //   () => void      — the cardio sheet (Phase 3)
};
export function setTrainActions(next) {
  actions = { ...actions, ...next };
}

function isVisible() {
  const view = el("view-train");
  return view && !view.hidden;
}

// ---------------------------------------------------------------------------
// Zone 1 — Today
// ---------------------------------------------------------------------------
/** A session counts as "in progress" while it has no ended_at. The diary has
 *  always used exactly this test (see workout_service.estimate_session_
 *  duration_hours, which switches from its set-count estimate to real elapsed
 *  time on the same field), so the card cannot disagree with the backend
 *  about whether a workout is still open. */
function todaysSessions() {
  return sessionsForDate(todayIso());
}

function sessionTotals(session) {
  const sets = session?.sets || [];
  return {
    sets: sets.length,
    volume: sets.reduce((sum, s) => sum + (s.weight_kg || 0) * (s.reps || 0), 0),
    calories: session?.calories_burned || 0,
  };
}

function renderTodayExercises(plan) {
  const wrap = el("train-today-exercises");
  if (!plan?.exercises?.length) {
    wrap.hidden = true;
    wrap.replaceChildren();
    return;
  }
  const lang = getLanguage();
  const shown = plan.exercises.slice(0, TODAY_EXERCISE_PREVIEW);
  const rest = plan.exercises.length - shown.length;
  const nodes = shown.map((ex) => {
    const chip = document.createElement("span");
    chip.className = "train-today-chip";
    chip.textContent = translateExerciseName(ex.exercise_name, lang);
    return chip;
  });
  if (rest > 0) {
    const more = document.createElement("span");
    more.className = "train-today-chip train-today-chip-more";
    more.textContent = t("train.moreExercises", { count: rest });
    nodes.push(more);
  }
  wrap.hidden = false;
  wrap.replaceChildren(...nodes);
}

/** The row under the primary button. Both are optional per state, and the row
 *  itself disappears when neither is offered rather than leaving an empty gap. */
function showSecondaryActions({ freeSession, cardio }) {
  el("train-today-secondary").hidden = !freeSession;
  el("train-today-cardio").hidden = !cardio;
  const row = el("train-today-secondary").parentElement;
  if (row) row.hidden = !freeSession && !cardio;
}

function renderTodayStats(session) {
  const wrap = el("train-today-stats");
  if (!session) {
    wrap.hidden = true;
    return;
  }
  const { sets, volume, calories } = sessionTotals(session);
  wrap.hidden = false;
  el("train-today-volume").textContent = `${Math.round(volume)} kg`;
  el("train-today-sets").textContent = String(sets);
  el("train-today-calories").textContent = calories ? `${Math.round(calories)} kcal` : "—";
}

export function renderToday() {
  const plan = actions.planForToday?.() || null;
  const sessions = todaysSessions();
  const open = sessions.find((s) => !s.ended_at) || null;
  const finished = sessions.find((s) => s.ended_at) || null;

  el("train-today-eyebrow").textContent = parseIsoDate(todayIso()).toLocaleDateString(getLocale(), {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const badge = el("train-today-badge");
  const title = el("train-today-title");
  const sub = el("train-today-sub");
  const primary = el("train-today-primary");

  // The four states, in priority order. An OPEN session outranks everything —
  // if the user is mid-workout, the only thing this card should offer is the
  // way back into it.
  if (open) {
    badge.hidden = false;
    badge.textContent = t("train.badgeInProgress");
    badge.dataset.tone = "progress";
    title.textContent = open.name || plan?.routine_name || t("train.inProgressTitle");
    sub.textContent = t("train.inProgressSub");
    renderTodayExercises(plan);
    renderTodayStats(open);
    primary.textContent = t("train.continueBtn");
    primary.onclick = () => actions.openSession?.(open.id);
    // Cardio stays reachable mid-session: a bike finisher after the last set
    // is the common case, and it attaches to this same session.
    showSecondaryActions({ freeSession: false, cardio: true });
    return;
  }

  if (finished) {
    badge.hidden = false;
    badge.textContent = t("train.badgeDone");
    badge.dataset.tone = "done";
    title.textContent = finished.name || t("train.doneTitle");
    sub.textContent = t("train.doneSub");
    renderTodayExercises(null);
    renderTodayStats(finished);
    // Deliberately still offers a second session rather than a dead card: two
    // sessions in a day is normal (a morning lift and an evening ride), and
    // the data model has always allowed it.
    primary.textContent = t("train.addAnotherBtn");
    primary.onclick = () => actions.startFree?.();
    showSecondaryActions({ freeSession: false, cardio: true });
    return;
  }

  badge.hidden = true;
  renderTodayStats(null);

  if (plan) {
    title.textContent = plan.routine_name;
    sub.textContent = t("train.plannedSub", { count: plan.exercises.length });
    renderTodayExercises(plan);
    primary.textContent = t("train.startRoutineBtn", { name: plan.routine_name });
    primary.onclick = () => actions.startPlanned?.(plan);
    // A planned day still allows an off-plan session — the plan is a
    // suggestion the user wrote, not a gate — and cardio regardless.
    showSecondaryActions({ freeSession: true, cardio: true });
    return;
  }

  // No plan for today. Not framed as a failure: the copy invites a session
  // rather than reporting an empty schedule.
  title.textContent = t("train.noPlanTitle");
  sub.textContent = t("train.noPlanSub");
  renderTodayExercises(null);
  primary.textContent = t("train.startBtn");
  primary.onclick = () => actions.startFree?.();
  // "Start workout" IS the free session here, so offering it twice would be
  // noise; cardio is a genuinely different action and stays.
  showSecondaryActions({ freeSession: false, cardio: true });
}

// ---------------------------------------------------------------------------
// Zone 3 — Recent sessions
// ---------------------------------------------------------------------------
function sessionMeta(session) {
  const { sets, calories } = sessionTotals(session);
  return calories
    ? t("train.sessionMeta", { sets, kcal: Math.round(calories) })
    : t("train.sessionMetaNoCal", { sets });
}

export function renderRecent() {
  const list = el("train-recent-list");
  const empty = el("train-recent-empty");
  // state.sessions is newest-first as the API returns it, but an optimistic
  // offline insert unshifts and a same-day pair can tie — sort on the way out
  // so the order shown never depends on how a row arrived.
  const recent = [...state.sessions]
    .sort((a, b) => (a.session_date < b.session_date ? 1 : a.session_date > b.session_date ? -1 : 0))
    .slice(0, RECENT_SESSION_LIMIT);

  if (!recent.length) {
    empty.hidden = false;
    list.querySelectorAll(".log-item").forEach((n) => n.remove());
    return;
  }
  empty.hidden = true;

  const locale = getLocale();
  reconcileList(list, recent, {
    getId: (s) => s.id,
    buildHtml: (s) => `
      <div class="log-item-body">
        <div class="log-item-name">${escapeHtml(s.name || t("workoutDiary.sessionUntitled"))}</div>
        <div class="log-item-meta">${escapeHtml(
          parseIsoDate(s.session_date).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" }) +
            " · " +
            sessionMeta(s),
        )}</div>
      </div>
      <div class="log-item-cal">${s.calories_burned ? Math.round(s.calories_burned) + " kcal" : ""}</div>
    `,
  });
}

// ---------------------------------------------------------------------------
// The tab as a whole
// ---------------------------------------------------------------------------
/** Cheap and idempotent, so every caller that might have changed a session can
 *  just call it. Skips entirely while the tab is hidden — a food log should not
 *  pay to re-render a training screen nobody is looking at; onTrainTabOpened()
 *  catches it up the moment it becomes visible. */
export function renderTrain({ force = false } = {}) {
  if (!force && !isVisible()) return;
  renderToday();
  actions.renderWeek?.();
  renderRecent();
}

export function onTrainTabOpened() {
  renderTrain({ force: true });
}

export function initTrainView() {
  el("train-history-btn").addEventListener("click", () => actions.openCalendar?.());
  el("train-routines-btn").addEventListener("click", () => actions.openRoutines?.());
  el("train-today-secondary").addEventListener("click", () => actions.startFree?.());
  el("train-today-cardio").addEventListener("click", () => actions.openCardio?.());
  // Primary's handler is (re)assigned per state in renderToday() — an onclick
  // property rather than addEventListener precisely so re-rendering replaces
  // it instead of stacking a fourth listener on the same button.

  el("train-recent-list").addEventListener("click", (e) => {
    const item = e.target.closest(".log-item");
    if (item?.dataset.id) actions.openSession?.(item.dataset.id);
  });
}
