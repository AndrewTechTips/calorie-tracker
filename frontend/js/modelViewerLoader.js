// Split out of ollie3d.js on purpose: this file has no other static
// imports and nothing else in the app statically imports it, so Rollup
// genuinely splits it into its own small chunk — unlike ollie3d.js itself,
// which coachChat.js/petHud.js both statically import, so a dynamic
// import("./ollie3d.js") from anywhere else just pulls in that whole
// merged AI-Coach chunk instead of isolating this one piece (verified via
// Rollup's own INEFFECTIVE_DYNAMIC_IMPORT build warning). Keeping this
// loader's CDN-script injection isolated here is what lets app.js's
// idle-time warm-up (loadAll(), below the Discover warm-up) prefetch just
// the <model-viewer> library + GLB, without also forcing the rest of the
// AI Coach feature's JS to parse before it's actually needed.

// Perf audit Phase 0 — Google's <model-viewer> CDN script used to be an
// unconditional <script type="module"> in index.html, so its ~250-300KB
// (gzipped) plus assets/ollie_model.glb were paid on every cold boot,
// whether or not the user ever opened AI Coach. index.html no longer ships
// that tag at all — this injects the exact same SRI-pinned script on
// demand instead, the same dynamic-script-injection pattern js/auth.js
// already uses for Turnstile.
const MODEL_VIEWER_SRC = "https://cdn.jsdelivr.net/npm/@google/model-viewer@4.3.1/dist/model-viewer.min.js";
const MODEL_VIEWER_INTEGRITY = "sha384-cprcVQt7wbUl0xngF3PGP6yBB7n4/t+4AoAMG9biiMCGFiWOdzUH10Ie2COTqFNW";
let modelViewerLoadPromise = null;

// Safe to call from more than one place (coachChat.js's openCoachSheet() on
// every real open, app.js's idle-time warm-up once per boot) — memoized on
// modelViewerLoadPromise, so a second call reuses the same in-flight/settled
// promise rather than injecting a second <script> tag.
export function lazyLoadModelViewer() {
  if (modelViewerLoadPromise) return modelViewerLoadPromise;
  if (customElements.get("model-viewer")) {
    modelViewerLoadPromise = Promise.resolve();
    return modelViewerLoadPromise;
  }
  modelViewerLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = MODEL_VIEWER_SRC;
    // Same SRI-pinning convention as every other CDN script this app loads
    // (see index.html's own comment on the Supabase script) — regenerate
    // with `openssl dgst -sha384 -binary <file> | openssl base64 -A` if
    // this pinned version is ever bumped.
    script.integrity = MODEL_VIEWER_INTEGRITY;
    script.crossOrigin = "anonymous";
    script.onload = () => resolve();
    script.onerror = () => {
      // Let a later retry (e.g. the user backs out and reopens the sheet
      // after a flaky network blip) actually retry, instead of a failed
      // load permanently wedging every future open.
      modelViewerLoadPromise = null;
      reject(new Error("Failed to load model-viewer"));
    };
    document.head.appendChild(script);
  });
  return modelViewerLoadPromise;
}
