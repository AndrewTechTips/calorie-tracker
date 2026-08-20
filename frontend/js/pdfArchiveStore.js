// On-device "PDF Archive" — persists every PDF report Export Data (app.js's
// downloadExportPdf) generates, so a report that's normally an ephemeral
// browser download is also kept around locally for later viewing/re-sharing.
// Same tiered, best-effort local store as photoStore.js (read that file's own
// header first — this mirrors it deliberately): Tier 1 is OPFS, the actual
// PDF bytes written via an async writable stream. Tier 2 is IndexedDB
// (db.js) for contexts without OPFS. Tier 3 is "don't archive at all" — the
// real download this is layered on top of already happened either way, so a
// failure/skip here is never worth surfacing as an error. Every export here
// follows db.js's own contract: never throws, always resolves to a safe
// default (null/false/[]) on failure.
import {
  putPdfArchiveRecord,
  getPdfArchiveRecord,
  listPdfArchiveMeta,
  deletePdfArchiveRecord,
} from "./db.js?v=20260820j";

const OPFS_DIR = "pdfArchive";
// "Reasonable number of recent reports or total size" (the feature's own
// brief) — a jsPDF landscape export table typically runs tens to a couple
// hundred KB, so 20 reports sits comfortably under the byte cap in practice;
// the byte cap exists as a hard backstop for an unusually large history
// export, not as the normal binding constraint.
const MAX_ARCHIVE_COUNT = 20;
const MAX_ARCHIVE_TOTAL_BYTES = 50 * 1024 * 1024;
// Same storage-pressure guard, same ratio, as photoStore.js — kept as its own
// copy rather than imported from there since the two modules archive
// different kinds of files for different reasons and have no other reason to
// depend on each other.
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

function opfsFileName(id) {
  return `${id}.pdf`;
}

async function hasStorageHeadroom() {
  try {
    if (!("storage" in navigator) || typeof navigator.storage.estimate !== "function") return true;
    const { usage, quota } = await navigator.storage.estimate();
    if (!quota) return true;
    return usage / quota < STORAGE_PRESSURE_RATIO;
  } catch {
    return true;
  }
}

// Called once at boot (app.js) to warm the capability check before the first
// export needs an answer. Doesn't also call navigator.storage.persist() —
// photoStore.js's own initPhotoStore() already requests that once per page
// load, and a second request would be redundant, not additive.
export async function initPdfArchiveStore() {
  await capabilities();
}

function newArchiveId() {
  return `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Called from app.js's downloadExportPdf right after the report's blob is
// built — fire-and-forget from that caller, same as photoStore.putHeroPhoto,
// so archiving never delays or blocks the actual (ephemeral) download the
// user asked for. `meta` is whatever the caller wants to remember about this
// report ({ days, lang } today) beyond the file itself.
export async function archivePdfReport({ blob, filename, ...meta }) {
  if (!blob || !filename) return null;
  const caps = await capabilities();
  if (!caps.any) return null;
  if (!(await hasStorageHeadroom())) return null;

  const id = newArchiveId();
  const base = { id, filename, createdAt: Date.now(), sizeBytes: blob.size, ...meta };

  if (caps.opfs) {
    try {
      const dir = await getOpfsDir();
      const fileHandle = await dir.getFileHandle(opfsFileName(id), { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      const record = { ...base, engine: "opfs" };
      await putPdfArchiveRecord(record);
      await enforceArchiveCaps();
      return record;
    } catch (err) {
      console.warn(`[pdfArchiveStore] OPFS write failed for report ${id}, falling back to IndexedDB`, err);
      // fall through to the IndexedDB tier below
    }
  }
  if (caps.indexedDb) {
    try {
      const record = { ...base, engine: "idb", blob };
      await putPdfArchiveRecord(record);
      await enforceArchiveCaps();
      const { blob: _blob, ...meta2 } = record;
      return meta2;
    } catch (err) {
      console.warn(`[pdfArchiveStore] IndexedDB write failed for report ${id}`, err);
    }
  }
  return null;
}

// Newest-first list of archived reports' metadata only — see
// db.js::listPdfArchiveMeta for why the PDF bytes themselves are never
// pulled into memory just to paint this list.
export async function listArchivedReports() {
  return listPdfArchiveMeta();
}

// Returns a Blob/File with the actual report bytes, or null if it can't be
// read (an OPFS file that's since disappeared, any read failure) — callers
// (app.js's open/share handlers) treat null as "this report's gone," never
// as something to retry.
export async function getArchivedReportFile(id) {
  if (!id) return null;
  try {
    const record = await getPdfArchiveRecord(id);
    if (!record) return null;
    if (record.engine === "opfs") {
      const dir = await getOpfsDir();
      const fileHandle = await dir.getFileHandle(opfsFileName(id));
      return await fileHandle.getFile();
    }
    return record.blob || null;
  } catch (err) {
    console.warn(`[pdfArchiveStore] Failed to read archived report ${id}`, err);
    return null;
  }
}

export async function deleteArchivedReport(id) {
  if (!id) return;
  try {
    const record = await getPdfArchiveRecord(id);
    if (record?.engine === "opfs") {
      const dir = await getOpfsDir();
      await dir.removeEntry(opfsFileName(id)).catch(() => {});
    }
  } catch {
    /* best-effort — proceed to clear the record regardless */
  }
  await deletePdfArchiveRecord(id);
}

// Count + total-bytes summary — used by the archive sheet's usage hint and,
// via enforceArchiveCaps below, to decide when to start evicting. A cheap
// metadata-only read (see listPdfArchiveMeta), safe to call as often as the
// UI wants without ever touching the actual PDF bytes.
export async function getArchiveUsageSummary() {
  const entries = await listArchivedReports();
  return {
    count: entries.length,
    totalBytes: entries.reduce((sum, e) => sum + (e.sizeBytes || 0), 0),
    maxCount: MAX_ARCHIVE_COUNT,
    maxBytes: MAX_ARCHIVE_TOTAL_BYTES,
  };
}

// Oldest-first eviction once either cap is exceeded — called after every
// successful archive write. Deletes strictly the minimum needed to satisfy
// both caps, never more, so a single oversized report doesn't evict an entire
// history's worth of otherwise-small ones beyond what the byte cap requires.
async function enforceArchiveCaps() {
  try {
    const entries = await listArchivedReports(); // newest first
    let totalBytes = entries.reduce((sum, e) => sum + (e.sizeBytes || 0), 0);
    const oldestFirst = [...entries].reverse();
    let count = oldestFirst.length;
    for (const entry of oldestFirst) {
      if (count <= MAX_ARCHIVE_COUNT && totalBytes <= MAX_ARCHIVE_TOTAL_BYTES) break;
      await deleteArchivedReport(entry.id);
      count -= 1;
      totalBytes -= entry.sizeBytes || 0;
    }
  } catch (err) {
    console.warn("[pdfArchiveStore] Failed to enforce archive caps — archive may briefly exceed its limit", err);
  }
}
