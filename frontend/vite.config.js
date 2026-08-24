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
