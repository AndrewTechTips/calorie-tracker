// The four write actions: log a set, delete a set, finish a session, delete a
// session. Lifted verbatim out of workoutDiary.js (Phase 0.3) apart from the
// imports/exports and `selectedRpe` becoming rpeScale.js's accessor pair.
//
// This module sits at the TOP of the folder's dependency graph — it imports
// sessionView/calendar/card and nothing imports it back except index.js, which
// only wires it to its buttons. That direction is deliberate: a write fans out
// to several renderers, and renderers must never reach back into a write.
import { api, isConnectivityError } from "../api.js";
import { deleteWithUndo, showToast, vibrate } from "../ui.js";
import { t } from "../i18n.js";
import { bestOneRepMax, estimateOneRepMax } from "../oneRepMax.js";
import { allSetsFlat, removeSessionFromCache, replaceSession, state } from "./workoutState.js";
import {
  closeActiveSession,
  renderDayDetail,
  renderExerciseRail,
  renderSessionSummary,
  renderSetList,
} from "./sessionView.js";
import { updateCalendarDots } from "./calendar.js";
import { renderTrain } from "./trainView.js";
import { renderCard } from "./card.js";
import { applyGhostValues } from "./ghostValues.js";
import { celebratePr, renderOneRepMax } from "./oneRepMaxPanel.js";
import { celebrateFinishedSession } from "./celebrations.js";
import { startRestTimer } from "./restTimer.js";
import { clearSelectedRpe, getSelectedRpe, renderRpeSelection } from "./rpeScale.js";
import { cacheSessions, isTempId, nextSetNumber, PENDING_FLAG, tempId } from "./offline.js";
import { enqueueWrite, listQueuedWrites, removeQueuedWrite } from "../db.js";
import { findSession } from "./workoutState.js";

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Set entry
// ---------------------------------------------------------------------------
/** The render fan-out every set change shares. Pulled out of the places that
 *  used to repeat it verbatim — the point of a single list is that the
 *  optimistic paint and the reconcile paint cannot drift apart. */
function renderAfterSetChange() {
  renderSessionSummary(findSession(state.activeSessionId));
  renderSetList();
  renderExerciseRail();
  renderDayDetail();
  updateCalendarDots();
  renderCard();
  renderTrain();
}

/** Puts the set into the cached session immediately, before any network call,
 *  and hands back the row so the caller can reconcile or roll back exactly it.
 *  `set_number` mirrors the backend's own per-exercise rule (see
 *  offline.js::nextSetNumber); it is a display value the server's answer
 *  overwrites moments later. */
function insertLocalSet(session, payload) {
  const now = new Date().toISOString();
  const localSet = {
    id: tempId("set"),
    session_id: session.id,
    exercise_name: payload.exercise_name,
    category: payload.category,
    set_number: nextSetNumber(session, payload.exercise_name),
    reps: payload.reps,
    weight_kg: payload.weight_kg,
    rpe: payload.rpe,
    logged_at: now,
    created_at: now,
    [PENDING_FLAG]: true,
  };
  replaceSession({ ...session, sets: [...(session.sets || []), localSet] });
  return localSet;
}

/** Fold the server's authoritative session back in, WITHOUT dropping sets that
 *  were logged optimistically while this request was in flight.
 *
 *  A plain `replaceSession(saved)` was the obvious version and it is wrong on
 *  exactly the workload this feature exists for: rapid straight sets. Log two
 *  sets a second apart and the first response — which the server built before
 *  the second set ever arrived — would replace the list with one set, making
 *  the second visibly vanish until its own response landed. Carrying any
 *  still-pending local row across keeps the list monotonic.
 *
 *  `confirmedTempId` is the row THIS response corresponds to; it is dropped,
 *  since the server's own copy of it is in `saved`. (A carried row may briefly
 *  show a set_number the server will renumber, and the session's calorie total
 *  lags by one set until the next response — both self-correct within the
 *  second, and both are strictly better than a row disappearing.) */
function reconcileSession(saved, confirmedTempId) {
  const current = findSession(saved.id);
  const stillPending = (current?.sets || []).filter((s) => s[PENDING_FLAG] && s.id !== confirmedTempId);
  replaceSession(stillPending.length ? { ...saved, sets: [...(saved.sets || []), ...stillPending] } : saved);
}

/** The write can never succeed (a real rejection, not a dropped connection) —
 *  take the optimistic row back out. Mirrors app.js's rollbackNewLog for food. */
function rollbackLocalSet(sessionId, localSetId) {
  const session = findSession(sessionId);
  if (!session) return;
  replaceSession({ ...session, sets: (session.sets || []).filter((s) => s.id !== localSetId) });
  renderAfterSetChange();
  applyGhostValues(state.activeExerciseName);
  renderOneRepMax(state.activeExerciseName);
}

function queueSet(session, payload, localSetId) {
  enqueueWrite({
    type: "addWorkoutSet",
    payload,
    sessionId: isTempId(session.id) ? null : session.id,
    sessionTempId: isTempId(session.id) ? session.id : null,
    tempId: localSetId,
  });
  showToast(t("toast.queuedOffline"), "default");
}

// ---------------------------------------------------------------------------
// Phase 2.2 — logging a set is OPTIMISTIC.
//
// It used to `await api.addWorkoutSet(...)` and only then paint, which made the
// single most rapid-fire interaction in the app the one mutation that waited on
// the network — on gym wifi, between two straight sets, one-handed. CLAUDE.md
// states the rule for food and water explicitly ("do not 'simplify' a mutation
// back to await-then-render"); sets were simply never brought in line with it.
//
// The row, the haptic, the rest timer and a PR celebration now all happen on
// the user's own numbers, before the request is even sent. The request then
// reconciles (see reconcileSession) or rolls back. Phase 0.4 built the offline
// half of this; what is new here is that the ONLINE path no longer waits.
// ---------------------------------------------------------------------------
export async function submitSet(e) {
  e.preventDefault();
  const weightKg = el("wd-set-weight").value === "" ? 0 : Number(el("wd-set-weight").value);
  const reps = Number(el("wd-set-reps").value);
  if (!reps) return;

  const session = findSession(state.activeSessionId);
  if (!session) return;

  // Captured *before* the write, from whatever is already cached — this is
  // "was there already a record to beat", so it must reflect history only,
  // never the set about to be added.
  const priorBest = bestOneRepMax(allSetsFlat().filter((s) => s.exercise_name.toLowerCase() === state.activeExerciseName.toLowerCase()));

  const payload = { exercise_name: state.activeExerciseName, category: state.activeExerciseCategory, reps, weight_kg: weightKg, rpe: getSelectedRpe() };

  // --- everything the user sees, now -----------------------------------------
  const localSet = insertLocalSet(session, payload);
  renderAfterSetChange();
  vibrate(12);
  // Weight/reps deliberately kept as-is (fast consecutive straight sets are
  // then a single tap); only RPE resets, since perceived effort can
  // legitimately differ set to set.
  clearSelectedRpe();
  renderRpeSelection();
  applyGhostValues(state.activeExerciseName); // now reflects the set just logged
  renderOneRepMax(state.activeExerciseName);
  startRestTimer();
  // Only a genuine improvement over an *existing* record counts — the very
  // first set ever logged for a brand new exercise trivially "beats" nothing.
  // Fired on the user's own entered numbers rather than on the response: the
  // lift happened whether or not the request does.
  const newEst = estimateOneRepMax(weightKg, reps);
  if (newEst != null && priorBest != null && newEst > priorBest) celebratePr(newEst, state.activeExerciseName);

  // --- then the network ------------------------------------------------------
  // A session that has not itself synced yet has no id the backend would
  // recognise, so there is nothing to POST against — queue straight away rather
  // than spend a round trip earning a 404 that would read as a real rejection.
  if (isTempId(session.id)) {
    queueSet(session, payload, localSet.id);
    return;
  }
  try {
    const saved = await api.addWorkoutSet(session.id, payload);
    reconcileSession(saved, localSet.id);
    renderAfterSetChange();
    applyGhostValues(state.activeExerciseName);
    renderOneRepMax(state.activeExerciseName);
    cacheSessions();
  } catch (err) {
    if (isConnectivityError(err)) {
      queueSet(session, payload, localSet.id);
      return;
    }
    rollbackLocalSet(session.id, localSet.id);
    showToast(err.message || t("workoutDiary.toastError"), "error");
  }
}

/** A set the server has never seen — either still in flight, or queued because
 *  the connection is down. There is nothing to DELETE remotely, and its queued
 *  write has to go too or the next drain would faithfully re-create the row the
 *  user just removed. Optimistic logging widened this from a sub-second window
 *  into the whole of an offline session, which is what makes it worth handling
 *  rather than ignoring. */
async function deletePendingSet(session, setId) {
  const queued = await listQueuedWrites();
  const entry = queued.find((q) => q.type === "addWorkoutSet" && q.tempId === setId);
  if (entry) await removeQueuedWrite(entry.id);
  replaceSession({ ...session, sets: (session.sets || []).filter((s) => s.id !== setId) });
  renderAfterSetChange();
  applyGhostValues(state.activeExerciseName);
  renderOneRepMax(state.activeExerciseName);
  showToast(t("workoutDiary.toastSetDeleted"), "success");
}

export async function deleteSet(setId) {
  const session = findSession(state.activeSessionId);
  if (isTempId(setId)) {
    if (session) await deletePendingSet(session, setId);
    return;
  }
  // Deliberately NOT optimistic, unlike submitSet above. Deleting is a
  // correction — rare, deliberate, and never fired in a burst between two
  // working sets — so the latency nobody notices here buys a simpler story:
  // the row leaves only once the server has agreed it can.
  try {
    const saved = await api.deleteWorkoutSet(setId);
    reconcileSession(saved, null);
    renderAfterSetChange();
    // Deleting the most recent set changes what "last time" means for this
    // exercise (falls back to the one before it, or clears entirely) — same
    // refresh submitSet() already does after adding one.
    applyGhostValues(state.activeExerciseName);
    renderOneRepMax(state.activeExerciseName); // the deleted set may have been the exercise's best estimate
    cacheSessions();
    showToast(t("workoutDiary.toastSetDeleted"), "success");
  } catch (err) {
    showToast(err.message || t("workoutDiary.toastError"), "error");
  }
}

export async function finishSession() {
  if (!state.activeSessionId) return;
  // Captured BEFORE closeActiveSession(), which clears it — the routine is
  // what "did you finish what you planned" is measured against, and it only
  // exists for the length of the session it was started from.
  const routineExercises = [...(state.activeRoutineExercises || [])];
  try {
    const session = await api.finishWorkoutSession(state.activeSessionId);
    replaceSession(session);
    renderDayDetail();
    updateCalendarDots();
    renderCard();
    renderTrain();
    showToast(t("workoutDiary.toastSessionFinished"), "success");
    // Phase 4.2/4.3 — Ollie reacts, and one achievement tier (if any qualified)
    // gets the confetti. Runs on the SERVER's session, so the sets it judges
    // are the ones that were actually persisted. See celebrations.js for every
    // guard; it can only ever return early, never throw a finish away.
    celebrateFinishedSession(session, { routineExercises });
    closeActiveSession();
  } catch (err) {
    showToast(err.message || t("workoutDiary.toastError"), "error");
  }
}

export function deleteSession(id) {
  const previous = state.sessions;
  deleteWithUndo({
    removeNow: () => {
      removeSessionFromCache(id);
      if (state.activeSessionId === id) closeActiveSession();
      renderDayDetail();
      updateCalendarDots();
      renderCard();
      renderTrain();
    },
    restore: () => {
      state.sessions = previous;
      renderDayDetail();
      updateCalendarDots();
      renderCard();
      renderTrain();
    },
    callDelete: () => api.deleteWorkoutSession(id),
    removedToastKey: "workoutDiary.toastSessionDeleted",
    revertToastKey: "workoutDiary.toastError",
  });
}
