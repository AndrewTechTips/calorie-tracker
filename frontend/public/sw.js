// Shell caching only — never the API. Deliberately does NOT precache an
// explicit asset list at install time: a hardcoded list of exact filenames
// would be a second place for the build's output to go stale. Instead this
// caches whatever same-origin GET requests actually happen at runtime, the
// first time each one is fetched, so it can never drift out of sync with what
// the app currently references.
//
// Bumped to v4 in perf audit Sprint 3 (SW-1). v3 and earlier decided
// cache-first vs. network-first by testing for a `?v=` query string — the old
// hand-maintained cache-buster convention, deleted when the Vite build took
// over content hashing (see vite.config.js). Nothing in the app has carried a
// `?v=` since, so that test was false for EVERY asset and the whole shell went
// down the network-first path: the cache was consulted only as an offline
// fallback, and every app open re-fetched all the JS and CSS. The irony is
// that Vite's content hashing makes those files genuinely immutable and
// therefore the ideal cache-first candidates — the strategy had inverted
// itself against its own documented intent.
// The bump is not cosmetic: v3's entries were written under that broken
// policy, and activate() below drops the old cache name outright rather than
// leaving them to be reinterpreted by the new rules.
const CACHE_NAME = "ironlog-shell-v4";

// Three tiers of same-origin file ship from this build, and they want three
// different policies. Getting the boundary wrong in either direction is a real
// bug — cache-first on something mutable strands users on a stale deploy;
// network-first on something immutable is the regression above.
//
// 1. IMMUTABLE — Rollup's content-hashed bundles, `assets/<name>-<hash>.<ext>`
//    (e.g. assets/main-BFtLe6am.js). The hash IS the content, so a change is
//    always a new URL and the old URL can never be wrong. Cache-first forever,
//    no revalidation.
// 2. ENTRY POINTS — index.html, `/`, the legal pages, manifest.json. These
//    have stable names by necessity (the browser/OS install flow and inbound
//    links reference them by exact filename) and their content changes on
//    every deploy, since index.html is what points at the new hashes. Always
//    network-first.
// 3. STABLE-NAME STATIC — everything else this origin serves: icons/*.png,
//    and public/assets/ (ollie_model.glb, ollie_grove_bg.svg). Stale-while-
//    revalidate: served instantly from cache, refreshed in the background.
//
// Tier 3 is the one that is easy to miss. Vite copies public/ into dist/
// VERBATIM, so public/assets/* lands in dist/assets/* right next to the hashed
// bundles while carrying no hash of its own — a naive "/assets/ means
// immutable" rule would pin the 3D model and its backdrop to whatever bytes a
// user first downloaded and no deploy would ever replace them. Hence matching
// on the hash SHAPE rather than on the directory.
//
// The pattern is Rollup's default `[name]-[hash][extname]` with an 8-character
// hash from its base64url-ish alphabet. Both halves can themselves contain `-`
// and `_` (real examples from this build: analytics-strings-C1KjCuYz.js,
// weeklyRecap-BYiIjba-.js, discover-strings-_iOzP-Pz.js, dataDeletion-4OOBfp-A.js),
// which is why this anchors to the END of the path rather than trying to split
// the name: exactly 8 hash characters immediately before the extension.
// ollie_model.glb and ollie_grove_bg.svg have no such segment and correctly
// fall through to tier 3.
const IMMUTABLE_ASSET_RE = /\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

// Hard ceiling on the shell cache, and the answer to "can this grow without
// bound?" — which, before this sprint, it could: both fetch branches called
// cache.put() unconditionally and activate() only ever deleted caches whose
// NAME differed, so every deploy wrote a fresh set of hashed filenames and
// orphaned the previous set under the same name, forever.
//
// The real mechanism that keeps this small is reconcileAssetsAgainstIndex()
// below, which prunes precisely when a deploy lands. This cap is the backstop
// for the cases that mechanism cannot see — a user who never gets a clean
// index.html fetch, or a pathological redirect loop. One deploy's full shell is
// ~40 entries (about 30 bundles, 5 HTML pages, manifest, 3 icons), so 150
// leaves comfortable room for a few generations of drift while still bounding
// the worst case to something trivial on disk.
const SHELL_CACHE_MAX_ENTRIES = 150;

// ---------------------------------------------------------------------------
// Discover Hub media cache — separate Cache Storage bucket from the shell
// cache above, deliberately: the shell cache is nuked wholesale on every
// CACHE_NAME bump (see activate() below), but a recipe/exercise photo is
// still perfectly valid across app versions, so it needs its own lifecycle.
// This is what makes the Discover tab (recipes/workout-plans/exercise
// library) actually usable offline — those photos are hotlinked from
// third-party hosts (Wikimedia Commons, wger.de) that a gym-basement/
// low-signal connection often can't reach, even though the app shell itself
// loaded fine from this SW's own cache.
//
// Scoped to the exact hosts already allow-listed in index.html's CSP
// img-src (images.openfoodfacts.org, wger.de, commons.wikimedia.org,
// upload.wikimedia.org, thumb.wikimedia.org) — never a wildcard, same
// narrow-scoping discipline the CSP itself uses. thumb.wikimedia.org is the
// dedicated host a Special:FilePath?width=N thumbnail request now redirects
// to (see index.html's CSP comment); without it here, every recipe/exercise
// photo would re-fetch from the network on each view instead of being served
// from this cache offline.
//
// These requests arrive here in "no-cors" mode (that's what a cross-origin
// <img src> always sends), so the fetch below yields an *opaque* response —
// status 0, headers/body unreadable from JS. That's still completely valid
// to store via cache.put() and hand back to an <img> tag; it's the standard
// pattern for caching cross-origin images that don't send CORS headers (none
// of these 4 hosts do). The tradeoff: an opaque response's Content-Length
// isn't readable, so a true byte-size eviction cap isn't possible here — see
// evictMediaCacheIfNeeded() below for why this uses an entry-count cap
// instead.
// ---------------------------------------------------------------------------
const MEDIA_CACHE_NAME = "ironlog-media-v1";
const MEDIA_CACHEABLE_HOSTS = new Set([
  "images.openfoodfacts.org",
  "wger.de",
  "commons.wikimedia.org",
  "upload.wikimedia.org",
  "thumb.wikimedia.org",
]);
// Card thumbnails are pre-sized to ~480px wide (~20-30KB each per
// discover.js's own wikimediaThumb comment) and detail-sheet hero images to
// ~960px — 220 entries lands around 10-25MB worst case, a reasonable cap for
// a background media cache on a device that's also running the rest of a
// PWA. FIFO by insertion order (cache.keys() returns entries in the order
// they were put() in every engine this app targets — not spec-guaranteed,
// but stable in practice, and the cost of getting the order slightly wrong
// is just "evicts a not-quite-oldest image," never a correctness bug).
const MEDIA_CACHE_MAX_ENTRIES = 220;

async function cacheMediaResponse(cache, request, response) {
  try {
    await cache.put(request, response);
    await evictMediaCacheIfNeeded(cache);
  } catch {
    // Storage quota exceeded or similar — the media cache is a pure
    // best-effort enhancement, never let a write failure surface as an error.
  }
}

async function evictMediaCacheIfNeeded(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MEDIA_CACHE_MAX_ENTRIES;
  if (excess <= 0) return;
  await Promise.all(keys.slice(0, excess).map((req) => cache.delete(req)));
}

function isMediaRequest(url) {
  return MEDIA_CACHEABLE_HOSTS.has(url.hostname);
}

// Cache-first: an already-cached photo is served instantly with no network
// round-trip at all (not just as an offline fallback), which is also just
// faster on a slow gym-wifi connection generally. A miss falls through to
// the network and silently caches the result for next time (the "lazy"
// half of the caching strategy — the "eager" half is the message handler
// further down, which proactively warms POPULAR_EXERCISES thumbnails).
async function handleMediaRequest(request) {
  const cache = await caches.open(MEDIA_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    // Don't await the cache write before returning — the <img> waiting on
    // this response shouldn't be delayed by the cache.put()/eviction work.
    cacheMediaResponse(cache, request, response.clone());
    return response;
  } catch {
    // Offline (or DNS/connection failure) and never cached. Respond with a
    // deliberate failing Response — rather than letting the rejection
    // propagate — so the <img> element reliably fires its own `error` event
    // the same way a real 404 would, routing into the existing branded
    // icon-placeholder fallback in js/discover.js (buildCard/setDetailImage)
    // instead of the browser's default broken-image glyph.
    return new Response(null, { status: 504, statusText: "Offline" });
  }
}

// Eager pre-warm, triggered by js/discover.js at app boot (see
// warmDiscoverMediaCache) so the curated POPULAR_EXERCISES thumbnails are
// already sitting in the media cache before the user ever opens Discover —
// "the core offline library is never visually empty" even on a first-ever
// offline visit to that tab. Reuses the exact same cache-write/eviction path
// as handleMediaRequest above (one implementation, not two) — this handler's
// only job is picking which URLs to fetch.
self.addEventListener("message", (event) => {
  const { type, urls } = event.data || {};
  if (type !== "ironlog:warm-media-cache" || !Array.isArray(urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(MEDIA_CACHE_NAME);
      for (const rawUrl of urls) {
        try {
          const url = new URL(rawUrl, self.location.origin);
          if (!isMediaRequest(url)) continue; // ignore anything outside the allow-listed hosts
          if (await cache.match(url.href)) continue; // already warm
          // Explicit no-cors: unlike the fetch-interception path above (which
          // reuses the original <img>-originated Request and so already
          // carries the browser's own no-cors mode), this constructs a fresh
          // Request from a bare URL string, which defaults to "cors" mode —
          // and none of the 4 allow-listed hosts send CORS headers, so a
          // default-mode fetch would throw instead of caching anything.
          const response = await fetch(url.href, { mode: "no-cors" });
          await cacheMediaResponse(cache, url.href, response);
        } catch {
          // Best-effort warm-up — one bad/unreachable URL shouldn't stop the rest.
        }
      }
    })(),
  );
});

// ---------------------------------------------------------------------------
// Web Push — this is the entire reason a notification can show up even when
// no tab/installed instance of the app is open at all. `sw.js` is a classic
// (non-module) worker script (no `import`s anywhere above), so it can't
// import VAPID_PUBLIC_KEY from js/config.js the way every other module in
// this app does — it's duplicated here instead and MUST be kept in sync with
// that file's value by hand (same manual-sync discipline this codebase
// already applies to e.g. RETENTION_DAYS across backend/config.py and
// sql/schema.sql — a deliberate, documented tradeoff over adding a build
// step just to share one constant).
// ---------------------------------------------------------------------------
const VAPID_PUBLIC_KEY = "BFbV2J3sROL72uMVz-PDXM2Q2YCyhUmm-fj5jE2Bo0QulS65NuSJI8toe7l47i0qQVPD6ZAcExqccC8y-QJBDFo";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

// The `push` event only ever fires while the browser/OS has woken this
// worker specifically to handle an incoming push message — there's no DOM,
// no access to any open tab's state, so the entire notification's visible
// content has to travel inside the push payload itself (see
// backend/services/push_service.py, which always sends {title, body, url}).
self.addEventListener("push", (event) => {
  let payload = { title: "Iron Log", body: "" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // A malformed/non-JSON push payload should still surface SOMETHING
    // rather than silently showing nothing — falls back to the bare
    // title/empty body above instead of throwing out of this handler.
  }
  // `tag` (backend/services/notification_scheduler.py sends the
  // notification "kind" — daily_reminder/food_nudge/water_nudge/
  // weekly_recap*/test — as this) collapses same-kind notifications into
  // ONE tray entry instead of stacking (matters most for interval-mode
  // reminders, which can fire several times a day: a user who was offline
  // for a few cycles gets one fresh notification on reconnect, not a pile
  // of identical ones). `renotify: true` is the required pairing — without
  // it, `tag` alone makes the OS silently replace the old entry with no new
  // alert/vibration at all, which would defeat the entire point of a
  // repeating reminder (each one would fire, but only the very first would
  // actually be noticed).
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "icons/icon-192.png",
      // Android's status bar renders `badge` as alpha-mask-only (fills every
      // opaque pixel with a flat color, ignoring RGB) — icon-192.png is a
      // fully opaque RGB PNG with no transparency, so using it here made
      // Android fill the ENTIRE square, producing the broken solid-white-
      // square status bar icon. icon-badge-96.png is a dedicated white-on-
      // transparent silhouette (generated from the brand mark) that Android
      // can mask correctly; `icon` above stays full-color since that one IS
      // shown as-is in the expanded notification body on both platforms.
      badge: "icons/icon-badge-96.png",
      tag: payload.tag || "ironlog",
      renotify: true,
      vibrate: [120, 60, 120],
      data: { url: payload.url || "/" },
      actions: [{ action: "open", title: "Open Iron Log" }],
    })
  );
});

// Focuses an already-open tab instead of always opening a fresh one — a user
// who gets a reminder while the app is already open in a background tab
// shouldn't end up with duplicate tabs piling up over time. Only falls back
// to opening a brand new tab/window when none is currently open.
//
// Deep links (currently just the weekly recap): the backend puts a
// `?view=<id>` query on the payload's `url` for kinds that should land on a
// specific screen (see backend/services/notification_scheduler.py's
// _DEEP_LINK_BY_KIND). Two cases, both handled:
//   - app NOT open  -> openWindow() the full ?view= URL; app.js reads the
//     param on boot, opens that screen, then strips it (so a manual refresh
//     doesn't re-trigger it).
//   - app ALREADY open -> focus the tab and postMessage the view id, so it
//     routes IN PLACE without a reload / losing state. A client old enough
//     not to have the listener just gets focused on whatever screen it was
//     on — an acceptable degradation, and it can't happen in practice
//     because a SW update reloads every controlled tab with fresh JS.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || "/";
  let view = null;
  try {
    view = new URLSearchParams((rawUrl.split("?")[1] || "")).get("view");
  } catch {
    /* malformed url — just treat it as a plain open */
  }
  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = allClients.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        if (view) existing.postMessage({ type: "ironlog:notification-navigate", view });
        return;
      }
      // Resolve against the registration scope, not the origin root, so this
      // is correct whether the PWA is deployed at a domain root or a GH
      // Pages project subpath.
      await clients.openWindow(new URL(rawUrl, self.registration.scope).href);
    })()
  );
});

// Browsers occasionally rotate a push subscription's endpoint/keys on their
// own initiative (key rotation, storage eviction under pressure) — this is
// the only notice this worker gets when that happens. There's no
// authenticated Supabase session available inside a service worker to call
// the backend directly from here, so this re-subscribes with the same
// VAPID key and hands the fresh subscription to any currently-open tab to
// re-POST to POST /notifications/subscribe (see js/notifications.js's own
// "ironlog:push-subscription-changed" listener). If no tab happens to be
// open right when this fires, it's still recovered: js/notifications.js
// also compares the live browser subscription against what it last synced
// on every app open, and re-POSTs then instead.
self.addEventListener("pushsubscriptionchange", (event) => {
  if (!VAPID_PUBLIC_KEY) return; // push was never configured on this deploy
  event.waitUntil(
    (async () => {
      // `oldEndpoint` travels with the handoff so the client can explicitly
      // DELETE the pre-rotation row — a push service can keep the old
      // endpoint briefly deliverable, and a leftover row there is exactly
      // what fires a second, duplicate notification for this one device.
      const oldEndpoint = event.oldSubscription?.endpoint || null;
      // Some engines hand back the already-rebuilt subscription on the event
      // itself; only subscribe() ourselves when they don't.
      const newSubscription =
        event.newSubscription ||
        (await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        }));
      const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
      allClients.forEach((client) =>
        client.postMessage({
          type: "ironlog:push-subscription-changed",
          subscription: newSubscription.toJSON(),
          oldEndpoint,
        })
      );
    })()
  );
});

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // MEDIA_CACHE_NAME is deliberately exempt from this sweep — see its own
      // comment above for why it has an independent lifecycle from the shell.
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME && key !== MEDIA_CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// An entry point is anything whose filename is load-bearing and whose content
// changes on deploy: every HTML page, a bare directory URL (`/`, which serves
// index.html), and the PWA manifest. Everything that is not this and not
// immutable is tier 3.
function isEntryPoint(url) {
  return url.pathname.endsWith("/") || url.pathname.endsWith(".html") || url.pathname.endsWith("manifest.json");
}

// index.html specifically — the one document whose contents name the current
// deploy's asset set, and therefore the only one worth reconciling against.
function isIndexDocument(url) {
  return url.pathname.endsWith("/") || url.pathname.endsWith("/index.html") || url.pathname === "/index.html";
}

async function trimShellCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - SHELL_CACHE_MAX_ENTRIES;
  if (excess <= 0) return;
  // FIFO by insertion order, same approach and same caveat as
  // evictMediaCacheIfNeeded above: not spec-guaranteed, stable in practice,
  // and the cost of being slightly wrong about the order is one extra refetch.
  await Promise.all(keys.slice(0, excess).map((request) => cache.delete(request)));
}

// Pulls every immutable asset URL that a freshly-fetched index.html actually
// points at. Vite writes these as relative hrefs (base: "./"), so each is
// resolved against the document's own URL before being compared — otherwise
// nothing would ever match the absolute URLs the cache is keyed by.
function referencedAssetUrls(html, documentUrl) {
  const found = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    let resolved;
    try {
      resolved = new URL(match[1], documentUrl);
    } catch {
      continue; // not a resolvable URL (a data: blob, a template placeholder)
    }
    if (resolved.origin === self.location.origin && IMMUTABLE_ASSET_RE.test(resolved.pathname)) {
      found.add(resolved.href);
    }
  }
  return found;
}

// Perf audit Sprint 3 (SW-2) — the eviction that actually keeps this cache
// small, tied to the live index.html rather than to a timer or a size guess.
//
// The signal is a DEPLOY, and index.html's own bytes are the most reliable one
// available: it is the document that names every entry hash, so it changes on
// any deploy that changed anything, and it changes on nothing else. When it has
// changed, every immutable asset from the previous generation is by definition
// dead — no page in the new build can ever request those URLs again — so they
// are deleted. When it has not changed, nothing is pruned at all.
//
// That distinction is what makes this safe for lazily-imported chunks. Most of
// this app's bundles (progress, discover, settings, tutorial, pdfFonts…) are
// dynamic imports reached from JS, so they never appear in index.html and a
// naive "delete anything index.html doesn't mention" sweep would evict them on
// every single load — turning the cache into a miss generator. Pruning only on
// a real deploy means those chunks are kept for as long as they are valid and
// dropped exactly when they stop being.
async function reconcileAssetsAgainstIndex(cache, request, freshResponse) {
  const previous = await cache.match(request);
  if (!previous) return; // first ever fetch — nothing cached to compare or prune
  const [previousHtml, freshHtml] = await Promise.all([previous.text(), freshResponse.text()]);
  if (previousHtml === freshHtml) return; // same deploy, keep everything

  const keep = referencedAssetUrls(freshHtml, request.url);
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((key) => IMMUTABLE_ASSET_RE.test(new URL(key.url).pathname) && !keep.has(key.url))
      .map((key) => cache.delete(key)),
  );
}

// Tier 1 — content-hashed, immutable. A hit is returned with no network round
// trip at all (not merely as an offline fallback), which is the whole point:
// after the first visit the entire JS/CSS shell comes off disk.
async function handleImmutableAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    // Not awaited — the page waiting on this asset should not be delayed by the
    // cache write or the trim. Swallowed on failure (a full quota is the usual
    // cause) for the same reason cacheMediaResponse above does: caching is an
    // enhancement, never a reason to fail the request.
    cache
      .put(request, response.clone())
      .then(() => trimShellCache(cache))
      .catch(() => {});
  }
  return response;
}

// Tier 2 — always network-first, so a deploy reaches a returning tab without a
// hard refresh. Cache-first on index.html was the original bug behind "I still
// see the old version after a push": once cached it was served forever, still
// naming whatever asset URLs were current the first time it was ever fetched.
async function handleEntryPoint(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Both clones are taken up front, before either body is read. Cloning is
      // a stream tee, so taking the second clone after the first has already
      // been consumed is needlessly subtle — this way each consumer owns an
      // untouched body and the original is still free to be returned.
      const forReconcile = response.clone();
      const forCache = response.clone();
      if (isIndexDocument(new URL(request.url))) {
        // Runs BEFORE the put below, so it still has the previous generation's
        // index.html to compare against. Never allowed to fail the request —
        // eviction is housekeeping, and a user waiting on the page should not
        // pay for it going wrong.
        await reconcileAssetsAgainstIndex(cache, request, forReconcile).catch(() => {});
      }
      await cache.put(request, forCache).catch(() => {});
      trimShellCache(cache).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached; // offline: whatever shell was last cached
    throw new Error("offline and no cached entry point");
  }
}

// Tier 3 — stable filename, mutable content (icons/, public/assets/). Answer
// from cache immediately when there is one, and refresh in the background so
// the next load picks up a redeployed file. That background refresh is what
// tier 1 deliberately does not need and tier 2 cannot afford to defer.
async function handleStableStatic(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache
          .put(request, response.clone())
          .then(() => trimShellCache(cache))
          .catch(() => {});
      }
      return response;
    })
    .catch((err) => {
      // Offline. If there is a cached copy the caller already has it (the
      // `cached || network` below resolved with it and this promise's result is
      // discarded); with nothing cached the failure is real and must surface,
      // not resolve to undefined — respondWith() throws on that.
      if (cached) return cached;
      throw err;
    });
  return cached || network;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === "GET" && isMediaRequest(url)) {
    event.respondWith(handleMediaRequest(event.request));
    return;
  }

  // Only the static shell: same-origin GETs. The backend API lives at a
  // different origin entirely (API_BASE_URL in js/config.js) and must never
  // be cached here — food/water/weight data should always be fresh, and
  // this keeps the service worker completely out of that request path.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  if (IMMUTABLE_ASSET_RE.test(url.pathname)) {
    event.respondWith(handleImmutableAsset(event.request));
    return;
  }
  if (isEntryPoint(url)) {
    event.respondWith(handleEntryPoint(event.request));
    return;
  }
  event.respondWith(handleStableStatic(event.request));
});
