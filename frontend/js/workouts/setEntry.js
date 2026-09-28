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
  renderSessionSummary,
  renderSetList,
} from "./sessionView.js";
import { updateCalendarDots } from "./calendar.js";
import { renderCard } from "./card.js";
import { applyGhostValues } from "./ghostValues.js";
import { celebratePr, renderOneRepMax } from "./oneRepMaxPanel.js";
import { startRestTimer } from "./restTimer.js";
import { clearSelectedRpe, getSelectedRpe, renderRpeSelection } from "./rpeScale.js";
import { cacheSessions, isTempId, nextSetNumber, PENDING_FLAG, tempId } from "./offline.js";
import { enqueueWrite } from "../db.js";
import { findSession } from "./workoutState.js";

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Set entry
// ---------------------------------------------------------------------------
export async function submitSet(e) {
  e.preventDefault();
  const weightKg = el("wd-set-weight").value === "" ? 0 : Number(el("wd-set-weight").value);
  const reps = Number(el("wd-set-reps").value);
  if (!reps) return;

  // Captured *before* the write, from whatever is already cached — this is
  // "was there already a record to beat", so it must reflect history only,
  // never the set about to be added.
  const priorBest = bestOneRepMax(allSetsFlat().filter((s) => s.exercise_name.toLowerCase() === state.activeExerciseName.toLowerCase()));

  const payload = { exercise_name: state.activeExerciseName, category: state.activeExerciseCategory, reps, weight_kg: weightKg, rpe: getSelectedRpe() };
  try {
    const session = await api.addWorkoutSet(state.activeSessionId, payload);
    replaceSession(session);
    renderSessionSummary(session);
    renderSetList();
    renderDayDetail();
    updateCalendarDots();
    renderCard();
    vibrate(12);
    // Weight/reps deliberately kept as-is (fast consecutive straight sets are
    // then a single tap); only RPE resets, since perceived effort can
    // legitimately differ set to set.
    clearSelectedRpe();
    renderRpeSelection();
    applyGhostValues(state.activeExerciseName); // now reflects the set just logged
    renderOneRepMax(state.activeExerciseName);
    startRestTimer();
    // Only a genuine improvement over an *existing* record counts — the
    // very first set ever logged for a brand new exercise trivially "beats"
    // nothing, and celebrating that would just be noise.
    const newEst = estimateOneRepMax(weightKg, reps);
    if (newEst != null && priorBest != null && newEst > priorBest) celebratePr(newEst);
    cacheSessions();
  } catch (err) {
    if (!isConnectivityError(err)) {
      showToast(err.message || t("workoutDiary.toastError"), "error");
      return;
    }
    applySetOffline(payload, weightKg, reps, priorBest);
  }
}

/** The offline half of submitSet (Phase 0.4). Deliberately mirrors the
 *  success path's rendering step for step — the set appears, the summary and
 *  ghost values update, the rest timer starts, a PR still celebrates — so a
 *  session logged with no signal feels the same as one logged with it. The
 *  only visible differences are the queued-offline toast in place of the
 *  silent success, and the session's calorie figure staying put until the
 *  server recomputes it (the MET table is backend-only, and a guess here
 *  would just disagree with the real answer a few minutes later).
 *
 *  `session_id` may be a temp id when the session itself is still queued;
 *  app.js's drain rewrites it to the real one before replaying, which is what
 *  `updateQueuedWrite` in db.js exists for. */
function applySetOffline(payload, weightKg, reps, priorBest) {
  const session = findSession(state.activeSessionId);
  if (!session) return;
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
  enqueueWrite({
    type: "addWorkoutSet",
    payload,
    // Which of the two this is decides whether the drain has to resolve it
    // first; keeping them as separate fields means the drain never has to
    // guess from the id's shape at replay time.
    sessionId: isTempId(session.id) ? null : session.id,
    sessionTempId: isTempId(session.id) ? session.id : null,
    tempId: localSet.id,
  });

  const updated = findSession(state.activeSessionId);
  renderSessionSummary(updated);
  renderSetList();
  renderDayDetail();
  updateCalendarDots();
  renderCard();
  vibrate(12);
  clearSelectedRpe();
  renderRpeSelection();
  applyGhostValues(state.activeExerciseName);
  renderOneRepMax(state.activeExerciseName);
  startRestTimer();
  const newEst = estimateOneRepMax(weightKg, reps);
  if (newEst != null && priorBest != null && newEst > priorBest) celebratePr(newEst);
  showToast(t("toast.queuedOffline"), "default");
}

export async function deleteSet(setId) {
  try {
    const session = await api.deleteWorkoutSet(setId);
    replaceSession(session);
    renderSessionSummary(session);
    renderSetList();
    renderDayDetail();
    updateCalendarDots();
    renderCard();
    // Deleting the most recent set changes what "last time" means for this
    // exercise (falls back to the one before it, or clears entirely) — same
    // refresh submitSet() already does after adding one.
    applyGhostValues(state.activeExerciseName);
    renderOneRepMax(state.activeExerciseName); // the deleted set may have been the exercise's best estimate
    showToast(t("workoutDiary.toastSetDeleted"), "success");
  } catch (err) {
    showToast(err.message || t("workoutDiary.toastError"), "error");
  }
}

export async function finishSession() {
  if (!state.activeSessionId) return;
  try {
    const session = await api.finishWorkoutSession(state.activeSessionId);
    replaceSession(session);
    renderDayDetail();
    updateCalendarDots();
    renderCard();
    showToast(t("workoutDiary.toastSessionFinished"), "success");
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
    },
    restore: () => {
      state.sessions = previous;
      renderDayDetail();
      updateCalendarDots();
      renderCard();
    },
    callDelete: () => api.deleteWorkoutSession(id),
    removedToastKey: "workoutDiary.toastSessionDeleted",
    revertToastKey: "workoutDiary.toastError",
  });
}
