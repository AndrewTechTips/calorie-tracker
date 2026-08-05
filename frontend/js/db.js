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
const DB_VERSION = 2;

const STORE_SNAPSHOT = "dashboardSnapshot";
const STORE_QUEUE = "writeQueue";
const STORE_FOOD_NAMES = "foodNames";
const STORE_RECENT_SCANS = "recentScans";
const STORE_DISCOVER = "discoverCache";
const SNAPSHOT_KEY = "latest";
const RECENT_SCANS_LIMIT = 30;

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
    console.log("[IndexedDB] Dashboard snapshot saved", { savedAt: new Date(snapshot.savedAt).toISOString(), logCount: snapshot.logs?.length ?? 0 });
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
    if (snapshot) {
      console.log("[IndexedDB] Dashboard loaded from cache", { savedAt: new Date(snapshot.savedAt).toISOString() });
    } else {
      console.log("[IndexedDB] No cached dashboard snapshot found");
    }
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
    console.log(`[IndexedDB] Queued offline write #${id}`, { type: item.type });
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
    console.log(`[IndexedDB] Synced and cleared queued write #${id}`);
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
    console.log(`[IndexedDB] Cached ${names.length} food name(s) for offline autocomplete`);
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
    console.log(`[IndexedDB] Loaded ${rows.length} cached food name(s) from offline store`);
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
    console.log("[IndexedDB] Recent scan thumbnail saved", { foodName: entry.foodName });
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
    console.log(`[IndexedDB] Loaded ${results.length} recent scan(s) from offline gallery`);
    return results;
  } catch (err) {
    console.warn("[IndexedDB] Failed to read recent scans", err);
    return [];
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
    console.log(`[IndexedDB] Cached ${items.length} Discover ${type} item(s) (${language})`);
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
