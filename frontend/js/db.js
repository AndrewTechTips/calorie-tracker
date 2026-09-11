// A single shared IndexedDB database backing the app's offline-first storage
// layer: a dashboard snapshot (cold-start offline hydration), a write queue
// (logs/water made while offline, synced on reconnect), a food-name cache
// (instant offline autocomplete), and a recent-scans thumbnail gallery.
//
// No external library (Dexie etc.) — same no-new-CDN-dependency pattern this
// repo already follows for Sentry/Turnstile (see CLAUDE.md): everything here
// is plain browser IndexedDB behind small promisified helpers.
//
// Every export degrades to a silent no-op / safe default (null, [], 0) on any
// failure — unsupported browser, private-browsing storage lockout, quota
// exceeded. None of this is ever required for the app to function; the
// backend is always the source of truth, and this is purely a best-effort
// enhancement layer on top of it. Callers should never need their own
// try/catch around these calls.

const DB_NAME = "ironlog-db";
const DB_VERSION = 7;

const STORE_SNAPSHOT = "dashboardSnapshot";
const STORE_QUEUE = "writeQueue";
const STORE_FOOD_NAMES = "foodNames";
const STORE_RECENT_SCANS = "recentScans";
const STORE_DISCOVER = "discoverCache";
const STORE_HERO_PHOTOS = "heroPhotos";
const STORE_PDF_ARCHIVE = "pdfArchive";
const STORE_AI_RESPONSE_CACHE = "aiResponseCache";
const STORE_SAVED_MEAL_STATS = "savedMealStats";
const STORE_SAVED_MEAL_PHOTOS = "savedMealPhotos";
const SNAPSHOT_KEY = "latest";
const RECENT_SCANS_LIMIT = 30;
const AI_RESPONSE_CACHE_LIMIT = 30;
const AI_RESPONSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let dbPromise = null;

function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB unsupported"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Out-of-line key (no keyPath) — this store only ever holds one row,
      // addressed by the fixed SNAPSHOT_KEY below, not a per-record id.
      if (!db.objectStoreNames.contains(STORE_SNAPSHOT)) {
        db.createObjectStore(STORE_SNAPSHOT);
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_FOOD_NAMES)) {
        db.createObjectStore(STORE_FOOD_NAMES, { keyPath: "key" }); // key = lowercased name
      }
      if (!db.objectStoreNames.contains(STORE_RECENT_SCANS)) {
        const store = db.createObjectStore(STORE_RECENT_SCANS, { keyPath: "id", autoIncrement: true });
        store.createIndex("createdAt", "createdAt");
      }
      // Out-of-line key ("recipes:en", "workoutPlans:ro", ...) — added in
      // DB_VERSION 2, IndexedDB's onupgradeneeded fires for any existing
      // user's DB the first time they load this version, creating just this
      // new store without touching the others already populated above.
      if (!db.objectStoreNames.contains(STORE_DISCOVER)) {
        db.createObjectStore(STORE_DISCOVER);
      }
      // Added in DB_VERSION 3 — full-quality "hero" photo metadata backing
      // the Today's Journal lightbox (see photoStore.js). Keyed by logId
      // (not autoIncrement, unlike recentScans) since there's at most one
      // hero per log and callers always address it by that id directly.
      // Holds the actual image bytes too when engine is "idb"; when OPFS is
      // available the bytes live in a real OPFS file instead and this row is
      // metadata-only ({logId, loggedAt, engine}) — see photoStore.js.
      if (!db.objectStoreNames.contains(STORE_HERO_PHOTOS)) {
        const store = db.createObjectStore(STORE_HERO_PHOTOS, { keyPath: "logId" });
        store.createIndex("loggedAt", "loggedAt");
      }
      // Added in DB_VERSION 4 — the client-side PDF export archive (see
      // pdfArchiveStore.js). Keyed by an app-generated string id (not
      // autoIncrement — pdfArchiveStore.js needs the id up front to name the
      // OPFS file it writes before this record ever gets inserted). Holds the
      // actual PDF bytes too when engine is "idb"; when OPFS is available the
      // bytes live in a real OPFS file instead and this row is metadata-only
      // ({id, filename, createdAt, sizeBytes, days, lang, engine}) — same
      // split as STORE_HERO_PHOTOS above.
      if (!db.objectStoreNames.contains(STORE_PDF_ARCHIVE)) {
        const store = db.createObjectStore(STORE_PDF_ARCHIVE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      // Added in DB_VERSION 5 — the AI scan/describe response cache (see
      // scan.js's photoCacheKey/describeCacheKey). Keyed by a hash of
      // exactly what was sent to the AI, not autoIncrement — a repeat
      // request for the same key overwrites the existing row via put()
      // rather than accumulating duplicates.
      if (!db.objectStoreNames.contains(STORE_AI_RESPONSE_CACHE)) {
        const store = db.createObjectStore(STORE_AI_RESPONSE_CACHE, { keyPath: "key" });
        store.createIndex("cachedAt", "cachedAt");
      }
      // Added in DB_VERSION 6 — the Pantry's per-saved-meal use tally (see
      // savedMealStats.js). Keyed by the saved meal's own backend id, so a
      // repeat log put()s over the same row rather than accumulating.
      // Deliberately ON THE DEVICE and not in Postgres: this is Phase 3 of the
      // Pantry redesign proving the idea before anything durable is built for
      // it. The honest cost is that a second device starts from zero — see
      // savedMealStats.js's own header.
      if (!db.objectStoreNames.contains(STORE_SAVED_MEAL_STATS)) {
        db.createObjectStore(STORE_SAVED_MEAL_STATS, { keyPath: "mealId" });
      }
      // Added in DB_VERSION 7 — the Pantry's saved-meal photos (Phase 4, see
      // savedMealPhotos.js). Keyed by the saved meal's id, holding a COPY of
      // the scan thumbnail that meal was favourited from.
      //
      // Why a copy and not a reference to the recentScans row it came from:
      // that row is doubly transient — capped at RECENT_SCANS_LIMIT and pruned
      // oldest-first on every insert, then swept again at PHOTO_RETENTION_DAYS
      // — so a reference would silently go blank. Exempting the original from
      // those sweeps instead would quietly extend how long this app keeps scan
      // photos, which is a retention promise, not an implementation detail.
      // The copy is the same thumbnail blob, so steady state is still one
      // stored image per scan; only the first 7 days hold two.
      if (!db.objectStoreNames.contains(STORE_SAVED_MEAL_PHOTOS)) {
        db.createObjectStore(STORE_SAVED_MEAL_PHOTOS, { keyPath: "mealId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // A failed open (e.g. private-browsing lockout) shouldn't leave every
  // future call in this module permanently rejecting against a cached
  // rejected promise — reset so the next call tries fresh.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Dashboard snapshot — the last successfully-loaded targets/today's-logs/
// water/dayState, written after every successful loadAll() (see app.js).
// Read back only when a cold start's real API calls fail outright, so the
// dashboard can show "last known" data instead of coming up blank offline.
// ---------------------------------------------------------------------------
export async function saveDashboardSnapshot(snapshot) {
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SNAPSHOT, "readwrite");
      tx.objectStore(STORE_SNAPSHOT).put(snapshot, SNAPSHOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to save dashboard snapshot", err);
  }
}

export async function getDashboardSnapshot() {
  try {
    const db = await getDb();
    const snapshot = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SNAPSHOT, "readonly");
      const req = tx.objectStore(STORE_SNAPSHOT).get(SNAPSHOT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return snapshot;
  } catch (err) {
    console.warn("[IndexedDB] Failed to read dashboard snapshot", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Offline write queue — mutations attempted while genuinely unreachable
// (see app.js's use of err.status === undefined to distinguish "never
// reached the server" from a real business-logic rejection, which is never
// queued). Drained in arrival order on reconnect.
// ---------------------------------------------------------------------------
export async function enqueueWrite(item) {
  try {
    const db = await getDb();
    const id = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, "readwrite");
      const req = tx.objectStore(STORE_QUEUE).add({ ...item, createdAt: Date.now() });
      req.onsuccess = () => resolve(req.result); // auto-generated id
      req.onerror = () => reject(req.error);
    });
    return id;
  } catch (err) {
    console.warn("[IndexedDB] Failed to queue offline write", err);
    return null;
  }
}

export async function listQueuedWrites() {
  try {
    const db = await getDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, "readonly");
      const req = tx.objectStore(STORE_QUEUE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function removeQueuedWrite(id) {
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, "readwrite");
      tx.objectStore(STORE_QUEUE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn(`[IndexedDB] Failed to clear queued write #${id} — entry lingers until the next drain attempt`, err);
  }
}

export async function countQueuedWrites() {
  return (await listQueuedWrites()).length;
}

// ---------------------------------------------------------------------------
// Food-name cache — every name that's ever been shown as an autocomplete
// suggestion (see app.js's syncFoodNameOptions), so a cold offline start
// still has suggestions before any network call has ever resolved.
// ---------------------------------------------------------------------------
export async function cacheFoodNames(names) {
  if (!names?.length) return;
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FOOD_NAMES, "readwrite");
      const store = tx.objectStore(STORE_FOOD_NAMES);
      names.forEach((name) => {
        const trimmed = (name || "").trim();
        if (!trimmed) return;
        store.put({ key: trimmed.toLowerCase(), name: trimmed, lastUsed: Date.now() });
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to cache food names — autocomplete still works from whatever loaded live", err);
  }
}

export async function getCachedFoodNames() {
  try {
    const db = await getDb();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FOOD_NAMES, "readonly");
      const req = tx.objectStore(STORE_FOOD_NAMES).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return rows.map((r) => r.name);
  } catch (err) {
    console.warn("[IndexedDB] Failed to read cached food names", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Recent-scans gallery — a small compressed thumbnail + minimal metadata per
// successful scan (see scan.js), capped at RECENT_SCANS_LIMIT so this stays
// a "near-zero cost" cache rather than an unbounded photo library. Pruned
// oldest-first after every insert.
// ---------------------------------------------------------------------------
export async function addRecentScan(entry) {
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RECENT_SCANS, "readwrite");
      tx.objectStore(STORE_RECENT_SCANS).add({ ...entry, createdAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await pruneRecentScans();
  } catch (err) {
    console.warn("[IndexedDB] Failed to save recent scan thumbnail — the scan already succeeded server-side, this is harmless", err);
  }
}

export async function listRecentScans(limit = RECENT_SCANS_LIMIT) {
  try {
    const db = await getDb();
    const results = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RECENT_SCANS, "readonly");
      const index = tx.objectStore(STORE_RECENT_SCANS).index("createdAt");
      const out = [];
      const req = index.openCursor(null, "prev"); // newest first
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor && out.length < limit) {
          out.push(cursor.value);
          cursor.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error);
    });
    return results;
  } catch (err) {
    console.warn("[IndexedDB] Failed to read recent scans", err);
    return [];
  }
}

// Deletes whichever recent-scan thumbnail(s) point at a given backend log id
// — called when the user deletes that log from Today's Journal (app.js), so
// removing an entry actually removes it everywhere instead of leaving an
// orphaned photo behind that nothing ever shows again but that still occupies
// one of the RECENT_SCANS_LIMIT slots. Deletes by value scan (no index on
// logId — this store is small and capped, so a full-store cursor is cheap),
// not by a single expected id: normally at most one entry has a given logId,
// but this stays correct even if that ever weren't true.
export async function deleteRecentScanByLogId(logId) {
  if (!logId) return;
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RECENT_SCANS, "readwrite");
      const store = tx.objectStore(STORE_RECENT_SCANS);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (cursor.value.logId === logId) store.delete(cursor.primaryKey);
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to remove recent scan thumbnail for deleted log — harmless, it just lingers unseen", err);
  }
}

async function pruneRecentScans() {
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RECENT_SCANS, "readwrite");
      const store = tx.objectStore(STORE_RECENT_SCANS);
      const req = store.index("createdAt").openCursor(null, "prev"); // newest first
      let seen = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        seen += 1;
        if (seen > RECENT_SCANS_LIMIT) store.delete(cursor.primaryKey);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* a slightly-over-cap gallery self-corrects on the next add */
  }
}

// ---------------------------------------------------------------------------
// Discover content cache — the last successfully-fetched recipes/workout
// plans list, per language, so returning to the Discover tab (or opening it
// offline/on a slow connection) can paint instantly from the last known copy
// instead of a blank grid, the same "last known, not required" role the
// dashboard snapshot above plays. Only the unfiltered baseline list per
// (type, language) is ever cached — see discover.js's fetchRecipes/
// fetchWorkoutPlans — a search/tag filter always goes straight to the
// network, this is not a general-purpose query cache.
// ---------------------------------------------------------------------------
export async function cacheDiscoverList(type, language, items) {
  if (!items?.length) return;
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DISCOVER, "readwrite");
      tx.objectStore(STORE_DISCOVER).put({ items, savedAt: Date.now() }, `${type}:${language}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn(`[IndexedDB] Failed to cache Discover ${type} — next load just skips the instant-paint step`, err);
  }
}

export async function getCachedDiscoverList(type, language) {
  try {
    const db = await getDb();
    const entry = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DISCOVER, "readonly");
      const req = tx.objectStore(STORE_DISCOVER).get(`${type}:${language}`);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return entry?.items || null;
  } catch (err) {
    console.warn(`[IndexedDB] Failed to read cached Discover ${type}`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hero photos — the full-quality counterpart to the recentScans thumbnail
// above, backing the Today's Journal lightbox (see photoStore.js, which is
// the only caller of everything below — it owns the OPFS-vs-IndexedDB
// decision, this module just persists whatever record it's handed).
// ---------------------------------------------------------------------------
export async function putHeroPhotoRecord(record) {
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HERO_PHOTOS, "readwrite");
      tx.objectStore(STORE_HERO_PHOTOS).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn(`[IndexedDB] Failed to save hero photo record for log #${record?.logId}`, err);
  }
}

export async function getHeroPhotoRecord(logId) {
  try {
    const db = await getDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HERO_PHOTOS, "readonly");
      const req = tx.objectStore(STORE_HERO_PHOTOS).get(logId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn(`[IndexedDB] Failed to read hero photo record for log #${logId}`, err);
    return null;
  }
}

export async function deleteHeroPhotoRecord(logId) {
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HERO_PHOTOS, "readwrite");
      tx.objectStore(STORE_HERO_PHOTOS).delete(logId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn(`[IndexedDB] Failed to remove hero photo record for log #${logId}`, err);
  }
}

// Read via the loggedAt index (not createdAt — see photoStore.js's own
// comment on why the log's actual logged_at is the correct retention clock,
// not scan-capture time) so a backdated entry still purges on schedule.
export async function listHeroPhotoRecordsOlderThan(cutoffMs) {
  try {
    const db = await getDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HERO_PHOTOS, "readonly");
      const range = IDBKeyRange.upperBound(cutoffMs, true);
      const req = tx.objectStore(STORE_HERO_PHOTOS).index("loggedAt").getAll(range);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to list stale hero photo records", err);
    return [];
  }
}

// Age-based counterpart to deleteRecentScanByLogId above. The backend's own
// daily retention cron deletes daily_logs rows silently — there's no client-
// side delete event to react to for those — so this is the only thing that
// ever catches a thumbnail whose log aged out that way; deleteRecentScanByLogId
// remains the immediate path for a manual delete. Uses the same createdAt
// index pruneRecentScans already reads (scan-capture time is an acceptable
// proxy here: unlike hero photos, a thumbnail's own row has no logged_at of
// its own to key off).
export async function purgeRecentScansOlderThan(cutoffMs) {
  try {
    const db = await getDb();
    let removed = 0;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RECENT_SCANS, "readwrite");
      const store = tx.objectStore(STORE_RECENT_SCANS);
      const range = IDBKeyRange.upperBound(cutoffMs, true);
      const req = store.index("createdAt").openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        removed += 1;
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to purge stale recent-scan thumbnails", err);
  }
}

// ---------------------------------------------------------------------------
// PDF export archive — the on-device "PDF Archive" feature (see
// pdfArchiveStore.js, the only caller of everything below, same division of
// responsibility as photoStore.js/STORE_HERO_PHOTOS above: this module just
// persists whatever record it's handed).
// ---------------------------------------------------------------------------
export async function putPdfArchiveRecord(record) {
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PDF_ARCHIVE, "readwrite");
      tx.objectStore(STORE_PDF_ARCHIVE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn(`[IndexedDB] Failed to save PDF archive record #${record?.id}`, err);
  }
}

export async function getPdfArchiveRecord(id) {
  try {
    const db = await getDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PDF_ARCHIVE, "readonly");
      const req = tx.objectStore(STORE_PDF_ARCHIVE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn(`[IndexedDB] Failed to read PDF archive record #${id}`, err);
    return null;
  }
}

// Newest first, and deliberately strips the `blob` field (present only on
// idb-tier rows) before returning — this is read by the archive list UI,
// which only ever needs the metadata to paint a row; pulling every stored
// PDF's bytes into memory just to render a list would be real, avoidable
// memory pressure once a few reports have accumulated.
export async function listPdfArchiveMeta() {
  try {
    const db = await getDb();
    const results = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PDF_ARCHIVE, "readonly");
      const index = tx.objectStore(STORE_PDF_ARCHIVE).index("createdAt");
      const out = [];
      const req = index.openCursor(null, "prev");
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const { blob, ...meta } = cursor.value;
          out.push(meta);
          cursor.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error);
    });
    return results;
  } catch (err) {
    console.warn("[IndexedDB] Failed to list PDF archive records", err);
    return [];
  }
}

export async function deletePdfArchiveRecord(id) {
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PDF_ARCHIVE, "readwrite");
      tx.objectStore(STORE_PDF_ARCHIVE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn(`[IndexedDB] Failed to remove PDF archive record #${id}`, err);
  }
}

// ---------------------------------------------------------------------------
// AI response cache (js/scan.js) — a same-device, best-effort cache of a
// scan/describe result, keyed by a hash of exactly what was sent to the AI
// (photo bytes, or description text, plus whatever else shapes the answer —
// context, attached items, output language; see scan.js's own key-building).
// A hit resolves the result-review stage instantly, no network round trip,
// no AI-quota spend. Two independent guards keep this from ever silently
// serving stale data: AI_RESPONSE_CACHE_TTL_MS (a 24h freshness window,
// checked here on every read — a food/recipe whose real nutrition data
// later improves shouldn't stay wrong on this one device indefinitely) and
// AI_RESPONSE_CACHE_LIMIT (a hard cap, oldest-evicted-first on every write —
// same bounded-growth shape as STORE_RECENT_SCANS above, not a second
// pattern to reason about).
// ---------------------------------------------------------------------------
export async function getCachedAiResponse(key) {
  try {
    const db = await getDb();
    const entry = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AI_RESPONSE_CACHE, "readonly");
      const req = tx.objectStore(STORE_AI_RESPONSE_CACHE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > AI_RESPONSE_CACHE_TTL_MS) {
      deleteCachedAiResponse(key); // fire-and-forget — a lingering expired row just reads as a miss again next time
      return null;
    }
    return entry.result;
  } catch (err) {
    console.warn("[IndexedDB] Failed to read AI response cache — falls through to a normal AI call", err);
    return null;
  }
}

export async function putCachedAiResponse(key, result) {
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AI_RESPONSE_CACHE, "readwrite");
      tx.objectStore(STORE_AI_RESPONSE_CACHE).put({ key, result, cachedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await pruneAiResponseCache();
  } catch (err) {
    console.warn("[IndexedDB] Failed to write AI response cache — the scan already succeeded, this is harmless", err);
  }
}

async function deleteCachedAiResponse(key) {
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AI_RESPONSE_CACHE, "readwrite");
      tx.objectStore(STORE_AI_RESPONSE_CACHE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* a lingering expired entry just gets treated as a miss again next read */
  }
}

async function pruneAiResponseCache() {
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AI_RESPONSE_CACHE, "readwrite");
      const store = tx.objectStore(STORE_AI_RESPONSE_CACHE);
      const req = store.index("cachedAt").openCursor(null, "prev"); // newest first
      let seen = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        seen += 1;
        if (seen > AI_RESPONSE_CACHE_LIMIT) store.delete(cursor.primaryKey);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* a slightly-over-cap cache self-corrects on the next write */
  }
}

// ---------------------------------------------------------------------------
// Saved-meal use tally (the Pantry's wear tiers + time bands). Same contract
// as everything else in this module: never throws, always resolves to a safe
// default, so no caller needs its own try/catch. A device where IndexedDB is
// unavailable (private-browsing lockout) simply behaves as it did before this
// existed — every count reads as 0, the list stays flat and unworn.
// ---------------------------------------------------------------------------

// One row per saved meal: { mealId, count, lastLoggedAt, parts: [m, d, e] }.
// `parts` is a histogram over the three day-parts defined in
// savedMealStats.js — not four, despite the concept doc's early sketch: the
// bands this feeds are Mornings / Middays / Evenings plus an "Anytime"
// FALLBACK that is computed, not recorded, so a fourth stored bucket would be
// data nothing could ever read.
export async function getSavedMealStats() {
  try {
    const db = await getDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SAVED_MEAL_STATS, "readonly");
      const req = tx.objectStore(STORE_SAVED_MEAL_STATS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to read saved-meal stats — the Pantry just renders unworn and ungrouped", err);
    return [];
  }
}

// Read-modify-write of ONE row inside a single readwrite transaction, so two
// logs fired in quick succession can't both read the same count and write the
// same increment back (IndexedDB gives us the serialisation for free here —
// doing the read outside the transaction would not).
export async function bumpSavedMealStat(mealId, partIndex, partCount) {
  if (!mealId) return null;
  try {
    const db = await getDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SAVED_MEAL_STATS, "readwrite");
      const store = tx.objectStore(STORE_SAVED_MEAL_STATS);
      const read = store.get(mealId);
      let written = null;
      read.onsuccess = () => {
        const existing = read.result;
        const parts = Array.from({ length: partCount }, (_, i) => Number(existing?.parts?.[i]) || 0);
        parts[partIndex] = (parts[partIndex] || 0) + 1;
        written = {
          mealId,
          count: (Number(existing?.count) || 0) + 1,
          lastLoggedAt: Date.now(),
          parts,
        };
        store.put(written);
      };
      tx.oncomplete = () => resolve(written);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to record a saved-meal use — the log itself already succeeded, only the tally missed it", err);
    return null;
  }
}

// Writes one row verbatim. Used by the undo path, which has already computed
// the decremented row in memory and needs it persisted as-is — a second
// read-modify-write helper would just be bumpSavedMealStat with the sign
// flipped, and would race with it.
export async function putSavedMealStat(row) {
  if (!row?.mealId) return;
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SAVED_MEAL_STATS, "readwrite");
      tx.objectStore(STORE_SAVED_MEAL_STATS).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to write a saved-meal tally row", err);
  }
}

// Called when a saved meal is deleted, so its tally doesn't outlive it and
// silently reattach to a future meal that happens to reuse the id.
export async function deleteSavedMealStat(mealId) {
  if (!mealId) return;
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SAVED_MEAL_STATS, "readwrite");
      tx.objectStore(STORE_SAVED_MEAL_STATS).delete(mealId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to drop a saved-meal tally — harmless, it just lingers unreferenced", err);
  }
}


// ---------------------------------------------------------------------------
// Saved-meal photos (Phase 4). Same never-throws contract as the rest of this
// module: a failure anywhere here resolves to "no photo", and the card falls
// back to its generated macro mark exactly as it did before this existed.
// ---------------------------------------------------------------------------

// Returns the blob of whichever recent-scan thumbnail points at this log, or
// null. Needed because the live thumbnail cache in scan.js holds object URLs,
// not blobs, and copying a photo onto a saved meal needs the bytes. Full-store
// cursor like deleteRecentScanByLogId above — no index on logId, and the store
// is capped at 30 rows.
export async function getRecentScanBlobByLogId(logId) {
  if (!logId) return null;
  try {
    const db = await getDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RECENT_SCANS, "readonly");
      const req = tx.objectStore(STORE_RECENT_SCANS).openCursor();
      let found = null;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        // Newest wins if a logId somehow has two rows — the cursor runs in key
        // order and keys autoIncrement, so simply overwriting gets that.
        if (cursor.value.logId === logId && cursor.value.thumbnail) found = cursor.value.thumbnail;
        cursor.continue();
      };
      tx.oncomplete = () => resolve(found);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to read a scan thumbnail by log id", err);
    return null;
  }
}

export async function putSavedMealPhoto(mealId, thumbnail) {
  if (!mealId || !thumbnail) return false;
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SAVED_MEAL_PHOTOS, "readwrite");
      tx.objectStore(STORE_SAVED_MEAL_PHOTOS).put({ mealId, thumbnail, createdAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (err) {
    console.warn("[IndexedDB] Failed to store a saved-meal photo — the favourite itself already saved, it just shows its macro mark", err);
    return false;
  }
}

export async function getSavedMealPhotos() {
  try {
    const db = await getDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SAVED_MEAL_PHOTOS, "readonly");
      const req = tx.objectStore(STORE_SAVED_MEAL_PHOTOS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to read saved-meal photos — cards fall back to their macro marks", err);
    return [];
  }
}

export async function deleteSavedMealPhoto(mealId) {
  if (!mealId) return;
  try {
    const db = await getDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SAVED_MEAL_PHOTOS, "readwrite");
      tx.objectStore(STORE_SAVED_MEAL_PHOTOS).delete(mealId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to delete a saved-meal photo", err);
  }
}
