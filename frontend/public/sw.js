// Cache-first shell caching only — never the API. Deliberately does NOT
// precache an explicit asset list at install time: this app already has a
// manual `?v=` cache-busting convention for every static file (see
// index.html's own comment on it), and hardcoding a second list of exact
// versioned URLs here would just be another place for that list to go
// stale. Instead, this caches whatever same-origin GET requests actually
// happen at runtime, the first time each one is fetched — so it can never
// drift out of sync with what the app currently references.
// Bumped to v3 alongside the controllerchange-reload fix in js/app.js — any
// device still stuck on v1 (cache-first index.html) or v2 (no reload-on-
// update, so the new SW could activate/claim but the already-open tab never
// picked up the fresh JS) gets a clean break: a new SW version always forces
// a byte-diff update check, and activate()'s cleanup below drops the old
// cache name outright rather than leaving stale entries under it forever.
const CACHE_NAME = "ironlog-shell-v3";

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
// Scoped to the exact 4 hosts already allow-listed in index.html's CSP
// img-src (images.openfoodfacts.org, wger.de, commons.wikimedia.org,
// upload.wikimedia.org) — never a wildcard, same narrow-scoping discipline
// the CSP itself uses.
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
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = allClients.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        return;
      }
      await clients.openWindow(targetUrl);
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

  // Every static asset this app owns carries a `?v=...` cache-busting query
  // string (see index.html's own comment on the convention) — so a URL that
  // HAS one is immutable and safe to serve cache-first forever (a content
  // change always means a new URL). A URL WITHOUT one is exactly the entry
  // points that convention can't version — index.html itself, `/`,
  // manifest.json — and those must always be network-first. Cache-first on
  // index.html was the actual bug behind "I still see the old version after
  // a push, even minutes later, until I hard-refresh": once cached, it kept
  // being served forever, still pointing at whatever `?v=` asset URLs were
  // current the first time it was ever fetched — so no deploy could ever
  // reach a returning visitor's tab without a hard refresh, no matter how
  // many times the JS/CSS underneath it changed.
  if (!url.search.includes("v=")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request)) // offline fallback to whatever shell was last cached
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline and never cached — let the failure surface naturally
    })
  );
});
