import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// Iron Log frontend — plain multi-page vanilla JS + FastAPI backend, no
// framework. This config is infrastructure only (perf audit Phase 1): it
// bundles/minifies/hashes exactly the same source files that were already
// being served as-is, and replaces the old manual "?v=" cache-buster
// convention (bump_version.py, now deleted) with Rollup's real content
// hashing. Nothing about the app's own architecture changes here — every
// JS file still imports the others via plain static `import`, same as
// before; code-splitting by tab is a later phase, not this one.
export default defineConfig({
  root,

  // Relative, not "/" — this app has no fixed deployment domain (see
  // config.js's own API_BASE_URL comment on dev vs. Render). A relative
  // base makes every asset URL Vite emits resolve correctly regardless of
  // whether GitHub Pages ends up serving this from a root domain or a
  // project-page subpath (https://user.github.io/repo/) — the same
  // domain-agnostic posture the app's existing relative asset paths
  // (icons/, manifest.json, sw.js) already have today.
  base: "./",

  // Vite's default is already "public", named explicitly so it's obvious
  // this directory is deliberate, not an accident: it holds every static
  // file that must be copied byte-for-byte rather than bundled/hashed —
  // sw.js (a classic, non-module script the service-worker spec requires
  // at a stable, predictable URL — a hashed filename would break every
  // existing installed service worker's update check), manifest.json +
  // icons/ (referenced by exact filename from the OS/browser install
  // flow, not just this app's own HTML), and assets/ollie_model.glb
  // (referenced only via <model-viewer src="..."> in index.html, a custom-
  // element attribute Vite's HTML asset scanner doesn't recognize, so
  // nothing would ever tell Vite to bundle it if it stayed in the
  // processed source tree — see css/style.css's own comment on why
  // ollie_grove_bg.svg sits in this same public/assets/ folder for the
  // same reason, even though it COULD have been bundled via its CSS
  // url() reference).
  publicDir: "public",

  build: {
    outDir: "dist",
    // Vite's production CSS minify step runs through lightningcss with NO
    // browser targets at all unless this is set (verified directly against
    // lightningcss's own transform() API, not guessed): `css.lightningcss`'s
    // own default targets only apply when `css.transformer` is explicitly
    // "lightningcss" (this app still uses Vite's default "postcss"
    // transformer for the dev/non-minify pass), and `build.cssTarget` is
    // what the separate minify step's own `convertTargets()` call reads —
    // with it unset (as it always has been here), that call is handed
    // `undefined` and lightningcss minifies with no target info whatsoever.
    // Without a target, lightningcss treats a hand-written
    // `backdrop-filter` + `-webkit-backdrop-filter` pair (same value, both
    // needed — see .bottom-nav::before in style.css) as one logical
    // property declared twice and silently keeps only whichever of the two
    // was written LAST in the source rule, discarding the other — not a
    // "vendor prefix gets stripped" story, the opposite: it's the STANDARD
    // `backdrop-filter` that was getting dropped from the shipped CSS,
    // since -webkit-backdrop-filter was always the second of the pair in
    // source. That's real, and reproduces on every `npm run build` — it has
    // nothing to do with the dev server (which never minifies, so both
    // properties always reached the browser there) and nothing to do with
    // mobile Safari specifically; it would just as easily have dropped
    // *either* property depending on which was written last. Setting an
    // explicit target here (the same "Baseline Widely Available" browser
    // set Vite itself defaults to for the transformer, so this isn't
    // inventing a new support floor) makes lightningcss fall back to its
    // normal, correct behavior instead: for a browser old enough to still
    // need -webkit-backdrop-filter (Safari/iOS Safari < 18, per
    // lightningcss's own compat table — live-verified against several
    // target versions), it emits BOTH the prefixed and the standard
    // declaration for a plain, single `backdrop-filter` rule, no manual
    // duplication needed in the source CSS at all. See style.css's
    // .bottom-nav::before comment for the other half of this fix (removing
    // the now-redundant hand-written -webkit- line there, since keeping
    // both is exactly what triggered the drop).
    cssTarget: ["chrome111", "edge111", "firefox114", "safari16.4", "ios16.4"],
    // Every real HTML entry point in this app — Vite's standard multi-page
    // pattern (each gets its own independent module graph / output
    // bundle). The legal pages' own inline `<script type="module">` blocks
    // and their `js/legalPage.js` import are picked up automatically as
    // part of each page's own entry, same as index.html's js/app.js.
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        privacy: resolve(root, "privacy.html"),
        terms: resolve(root, "terms.html"),
        disclaimers: resolve(root, "disclaimers.html"),
        dataDeletion: resolve(root, "data-deletion.html"),
      },
    },
  },

  // Matches the port `python3 -m http.server 5173` already used for local
  // dev (see the project's own CLAUDE.md) purely so that instruction stays
  // accurate without also needing an edit.
  server: {
    port: 5173,
  },
  preview: {
    port: 5173,
  },
});
