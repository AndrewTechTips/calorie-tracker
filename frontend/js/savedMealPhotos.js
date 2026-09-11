// Saved-meal photos — Phase 4 of the Pantry redesign.
//
// When a logged item that has a scan photo is saved as a favourite, that same
// thumbnail is copied onto the saved meal so the Pantry card shows the actual
// food instead of its generated macro mark. Anything saved by hand — or saved
// before this existed — keeps the mark, unchanged (see macroMark.js).
//
// LIFECYCLE. The photo belongs to the SAVED MEAL, not to the log it came from,
// and that distinction is the whole point of this module:
//   - it survives the 7-day sweep that clears scan history (photoStore.js's
//     purgeStalePhotos) and the 30-row cap on the recentScans store, because
//     it is a copy rather than a reference into either;
//   - it is deleted the moment its saved meal is, in the same place Phase 3's
//     tally is forgotten;
//   - and reconcile() sweeps anything whose meal no longer exists, which is
//     what makes "never outlives its meal" true rather than merely intended —
//     it covers a delete that failed mid-flight, an account reset, and a meal
//     deleted on another device.
//
// Entirely on-device, like every other photo in this app. Nothing here is
// uploaded, and no code path in this module touches the network.
//
// The object-URL map is the same shape as scan.js's thumbnailsByLogId, and for
// the same reason: ui.js's renderPantryList builds card markup synchronously,
// so the lookup it calls has to be synchronous too.

import {
  SAVED_MEAL_PHOTOS_STORE,
  clearStore,
  deleteSavedMealPhoto,
  getRecentScanBlobByLogId,
  getSavedMealPhotos,
  putSavedMealPhoto,
} from "./db.js";

let urlsByMealId = new Map();

function revokeAll() {
  urlsByMealId.forEach((url) => URL.revokeObjectURL(url));
  urlsByMealId = new Map();
}

// Read every stored photo into object URLs. Called once at boot and again
// after a favourite is saved. Revokes the previous batch first so a long
// session can't leak one URL per refresh.
export async function refreshSavedMealPhotos() {
  const rows = await getSavedMealPhotos();
  revokeAll();
  const next = new Map();
  rows.forEach((row) => {
    if (!row?.thumbnail) return;
    next.set(row.mealId, URL.createObjectURL(row.thumbnail));
  });
  urlsByMealId = next;
}

// Synchronous — see the module header. Returns undefined (never null) for "no
// photo", so callers can use it directly in a truthiness check.
export function savedMealPhotoUrl(mealId) {
  return urlsByMealId.get(mealId);
}

export function hasAnySavedMealPhoto() {
  return urlsByMealId.size > 0;
}

// Copies the scan thumbnail belonging to `logId` onto `mealId`. A no-op when
// that log never had a photo (manual entry, describe-a-meal, barcode), which
// is the common case and not a failure — the card simply keeps its mark.
// Returns whether a photo was actually attached, so a caller can skip a
// needless re-render.
export async function attachPhotoFromLog(mealId, logId) {
  if (!mealId || !logId) return false;
  const blob = await getRecentScanBlobByLogId(logId);
  if (!blob) return false;
  return await attachPhotoBlob(mealId, blob);
}

// The direct form, for the one caller that already holds the bytes: scan.js
// creates the thumbnail and the favourite in the same confirm, so making it
// re-read what it just wrote would be both wasteful and a race — the write and
// the favourite land independently.
export async function attachPhotoBlob(mealId, blob) {
  if (!mealId || !blob) return false;
  const stored = await putSavedMealPhoto(mealId, blob);
  if (!stored) return false;
  const previous = urlsByMealId.get(mealId);
  if (previous) URL.revokeObjectURL(previous);
  urlsByMealId.set(mealId, URL.createObjectURL(blob));
  return true;
}

export async function detachPhoto(mealId) {
  if (!mealId) return;
  const url = urlsByMealId.get(mealId);
  if (url) URL.revokeObjectURL(url);
  urlsByMealId.delete(mealId);
  await deleteSavedMealPhoto(mealId);
}

// Session/account teardown — see clearAllSavedMealStats for why the in-memory
// half matters as much as the stored half. Revoking first means no object URL
// is left dangling for a photo that no longer exists.
export async function clearAllSavedMealPhotos() {
  revokeAll();
  await clearStore(SAVED_MEAL_PHOTOS_STORE);
}

// Drops every stored photo whose saved meal no longer exists.
//
// `liveMealIds` MUST be the real, loaded set — passing an empty or partial
// list would delete everything, so the caller is responsible for only calling
// this once saved meals have actually loaded. Guarded here as well: an empty
// set is treated as "nothing known yet", never as "nothing exists".
export async function reconcile(liveMealIds) {
  const live = new Set(liveMealIds || []);
  if (!live.size) return 0;
  const rows = await getSavedMealPhotos();
  let dropped = 0;
  for (const row of rows) {
    if (live.has(row.mealId)) continue;
    await detachPhoto(row.mealId);
    dropped += 1;
  }
  return dropped;
}
