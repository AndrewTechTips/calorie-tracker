// Full-quality ("hero") meal photo storage backing the Today's Journal
// lightbox — a tiered, best-effort local store layered on top of the plain
// thumbnail cache in db.js. Tier 1 is OPFS (Origin Private File System): the
// actual JPEG bytes live in a real file, written via the browser's own async
// writable stream — non-blocking for a file this size (a few hundred KB)
// without needing a dedicated Worker. Tier 2 is IndexedDB (db.js, the same
// mechanism `recentScans` already uses) for contexts without OPFS (Firefox
// private browsing, older Safari, etc.). Tier 3 is "don't persist a hero at
// all" — the thumbnail still works, the lightbox just never gets a
// higher-quality image to swap in, and text/macro logging is unaffected
// either way. Every export here follows db.js's own contract: never throws,
// always resolves to a safe default (null/false) on failure, so no caller
// needs its own try/catch.

import {
  putHeroPhotoRecord,
  getHeroPhotoRecord,
  deleteHeroPhotoRecord,
  listHeroPhotoRecordsOlderThan,
  purgeRecentScansOlderThan,
} from "./db.js?v=20260820l";

const OPFS_DIR = "heroPhotos";
// Mirrors backend Settings.retention_days (default 7 — see CLAUDE.md and
// legalContent.js's own "7 days" copy). There's no live config endpoint for
// this today, so this is a second hardcoded copy — bump it by hand alongside
// those if that default ever changes.
const PHOTO_RETENTION_DAYS = 7;
// Storage-pressure guard for the hero tier only (the larger, optional
// upgrade) — a full device should still let logging/thumbnails work, it just
// stops writing hero photos rather than risking a QuotaExceededError mid-scan.
const STORAGE_PRESSURE_RATIO = 0.9;

let capabilitiesPromise = null;
let opfsDirPromise = null;

async function detectCapabilities() {
  let opfs = false;
  try {
    if ("storage" in navigator && typeof navigator.storage.getDirectory === "function") {
      const root = await navigator.storage.getDirectory();
      await root.getDirectoryHandle(OPFS_DIR, { create: true });
      opfs = true;
    }
  } catch {
    opfs = false;
  }
  const indexedDb = "indexedDB" in window;
  return { opfs, indexedDb, any: opfs || indexedDb };
}

// Feature-checked once per page load and cached — never re-checked per call,
// same "cheap and idempotent" pattern as db.js's own getDb().
export function capabilities() {
  if (!capabilitiesPromise) capabilitiesPromise = detectCapabilities();
  return capabilitiesPromise;
}

async function getOpfsDir() {
  if (!opfsDirPromise) {
    opfsDirPromise = navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(OPFS_DIR, { create: true }));
  }
  return opfsDirPromise;
}

function opfsFileName(logId) {
  return `${logId}.jpg`;
}

async function hasStorageHeadroom() {
  try {
    if (!("storage" in navigator) || typeof navigator.storage.estimate !== "function") return true;
    const { usage, quota } = await navigator.storage.estimate();
    if (!quota) return true;
    return usage / quota < STORAGE_PRESSURE_RATIO;
  } catch {
    return true; // estimate() itself failing is never a reason to skip storing
  }
}

// Best-effort request to reduce (never guarantee) the chance the browser
// evicts this origin's storage under device-wide pressure. Called once at
// boot (app.js) — never blocks anything if denied or unsupported.
export async function requestPersistence() {
  try {
    if ("storage" in navigator && typeof navigator.storage.persist === "function") {
      await navigator.storage.persist();
    }
  } catch {
    /* best-effort only */
  }
}

// Called once at boot (app.js) to warm the capability check + request
// persistence before the first real scan confirm needs an answer.
export async function initPhotoStore() {
  await capabilities();
  requestPersistence();
}

// Called from scan.js once a scan is confirmed (or a Smart Tools re-photo
// replaces one). `loggedAt` is the log's own logged_at (ISO string or Date),
// not scan-capture time, so purgeStalePhotos below stays correct even for a
// backdated entry. Fire-and-forget from every caller — never blocks the
// thumbnail path or the log itself.
export async function putHeroPhoto(logId, blob, loggedAt) {
  if (!logId || !blob) return false;
  const loggedAtMs = new Date(loggedAt).getTime() || Date.now();
  const caps = await capabilities();
  if (!caps.any) return false;
  if (!(await hasStorageHeadroom())) return false;

  if (caps.opfs) {
    try {
      const dir = await getOpfsDir();
      const fileHandle = await dir.getFileHandle(opfsFileName(logId), { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      await putHeroPhotoRecord({ logId, loggedAt: loggedAtMs, engine: "opfs" });
      return true;
    } catch (err) {
      console.warn(`[photoStore] OPFS write failed for log #${logId}, falling back to IndexedDB`, err);
      // fall through to the IndexedDB tier below
    }
  }
  if (caps.indexedDb) {
    try {
      await putHeroPhotoRecord({ logId, loggedAt: loggedAtMs, engine: "idb", blob });
      return true;
    } catch (err) {
      console.warn(`[photoStore] IndexedDB hero write failed for log #${logId}`, err);
    }
  }
  return false;
}

// Returns a Blob/File, or null if no hero was ever stored for this log (an
// older entry from before this feature, storage that was unavailable/full at
// capture time, or any read failure) — callers (photoLightbox.js) treat null
// as "keep showing the thumbnail," never as an error to surface.
export async function getHeroPhoto(logId) {
  if (!logId) return null;
  try {
    const record = await getHeroPhotoRecord(logId);
    if (!record) return null;
    if (record.engine === "opfs") {
      const dir = await getOpfsDir();
      const fileHandle = await dir.getFileHandle(opfsFileName(logId));
      return await fileHandle.getFile();
    }
    return record.blob || null;
  } catch (err) {
    console.warn(`[photoStore] Failed to read hero photo for log #${logId}`, err);
    return null;
  }
}

export async function removeHeroPhoto(logId) {
  if (!logId) return;
  try {
    const record = await getHeroPhotoRecord(logId);
    if (record?.engine === "opfs") {
      const dir = await getOpfsDir();
      await dir.removeEntry(opfsFileName(logId)).catch(() => {});
    }
  } catch {
    /* best-effort — proceed to clear the record regardless */
  }
  await deleteHeroPhotoRecord(logId);
}

// Age-based cleanup, aligned with the backend's own retention window (see
// PHOTO_RETENTION_DAYS above). Guarded to run at most once per page load —
// app.js calls this from loadAll(), which itself fires on every pull-to-
// refresh/Discover reload, not just the first boot; there's never a reason
// to re-sweep within the same session since only the backend's daily cron
// (not this session) could have made anything newly stale.
let purgedThisSession = false;
export async function purgeStalePhotos() {
  if (purgedThisSession) return;
  purgedThisSession = true;
  const cutoffMs = Date.now() - PHOTO_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    const stale = await listHeroPhotoRecordsOlderThan(cutoffMs);
    for (const record of stale) {
      await removeHeroPhoto(record.logId);
    }
    if (stale.length) {
      console.log(`[photoStore] Purged ${stale.length} stale hero photo(s) past the ${PHOTO_RETENTION_DAYS}-day retention window`);
    }
  } catch (err) {
    console.warn("[photoStore] Failed to purge stale hero photos", err);
  }
  await purgeRecentScansOlderThan(cutoffMs);
}
