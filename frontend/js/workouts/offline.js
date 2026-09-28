// Offline support for the Workout Diary (Phase 0.4).
//
// A gym is the single most likely place this app is opened without a usable
// connection — a basement, a thick-walled building, a phone in aeroplane mode
// to avoid interruptions. Before this, that was the one environment where
// logging simply did not work: every set threw, showed an error toast, and was
// lost, while `loadWorkoutSessions()`'s catch replaced the whole history with
// an empty list so the calendar and diary looked wiped too.
//
// Two halves, mirroring what food and water logging already had:
//   * a READ cache, so a cold offline open renders the real diary; and
//   * WRITE queueing, so a set logged with no signal is replayed on reconnect
//     by app.js's existing drain rather than discarded.
//
// Deliberately scoped: the offline branch only engages on a genuine
// connectivity failure (see api.js's isConnectivityError). The ONLINE path is
// untouched and still awaits the server before rendering — making that
// optimistic too is Phase 2.2, and doing it here would have made a
// de-risking phase the place where the hot path changed shape.
import { readWorkoutSessions, saveWorkoutSessions } from "../db.js";
import { state } from "./workoutState.js";

// Marks a session or set that exists locally but has not reached the server
// yet. Purely informational today — nothing renders differently — but it is
// what lets a later phase show a pending affordance without inventing a
// second bookkeeping channel for it.
export const PENDING_FLAG = "_pending";

/** A client-side id for a row the server has not seen. Deliberately prefixed
 *  and obviously not a UUID, so it can never be mistaken for a real id if one
 *  ever leaks into a request URL — it would 404 loudly rather than act on
 *  someone else's row. */
export function tempId(kind) {
  return `temp-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isTempId(id) {
  return typeof id === "string" && id.startsWith("temp-");
}

/** Mirrors backend/routers/workouts.py's own numbering rule exactly: per
 *  EXERCISE within the session, case-insensitively, not per session. Kept in
 *  sync by hand — the same discipline CLAUDE.md describes for RETENTION_DAYS
 *  and VAPID_PUBLIC_KEY. A wrong guess here is cosmetic and self-corrects the
 *  moment the real session comes back from the drain. */
export function nextSetNumber(session, exerciseName) {
  const name = (exerciseName || "").trim().toLowerCase();
  return 1 + (session?.sets || []).filter((s) => (s.exercise_name || "").trim().toLowerCase() === name).length;
}

export function cacheSessions() {
  // Never cache the optimistic rows — a temp id that survived a reload would
  // be unreplayable (its queue entry is keyed separately) and would render a
  // session that can never be finished or deleted. The queue is what makes
  // those durable; this cache is only ever a picture of the synced truth.
  saveWorkoutSessions(state.sessions.filter((s) => !isTempId(s.id)));
}

export async function hydrateSessionsFromCache() {
  const cached = await readWorkoutSessions();
  return Array.isArray(cached) ? cached : null;
}
