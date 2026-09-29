// The muscle map (Phase 4.1) — what this week actually covered, drawn on a
// body instead of listed as six bars.
//
// It replaces progress.js's renderMuscleHeatmap, which was honest and cheap
// and also a bar chart wearing a heatmap's name, sitting two taps deep inside
// a *different* tab from the logging it describes. The pure 7-day counting
// function came with it unchanged (computeMuscleHeatmap below) — it was
// already correct, and progress.js still imports it for the bento's
// "least-trained group" line.
//
// Constraints this module is built to respect, all of them pre-existing:
//   - INLINE SVG, hand-authored, right here. `script-src` allows only
//     cdn.jsdelivr.net and challenges.cloudflare.com, so a third-party
//     muscle-map library would mean loosening the CSP for a decorative
//     feature. The app already carries one 3D asset (ollie_model.glb), and it
//     earns its weight by being the entire companion mechanic; a body map
//     does not earn a second.
//   - The figure is built ONCE (initMuscleMap) and every render after that
//     writes one CSS custom property per group — `--muscle-intensity`, 0..1 —
//     plus the text. No per-frame work, no markup rebuild, nothing that could
//     steal focus from the legend buttons.
//   - SIX groups, drawn well. workout_sets.category holds exactly the six
//     coarse buckets in MUSCLE_GROUPS; drawing thirty muscles and tinting
//     them from six numbers would be a chart lying about its own resolution.
//
// ACCESSIBILITY IS NOT OPTIONAL HERE, because colour intensity alone excludes
// colour-blind users from the whole point of the thing. So the SVG is
// explicitly decorative (`aria-hidden`), and the real control is the legend
// underneath it: six ordinary <button>s, each carrying its group's NAME and
// SET COUNT as text, always visible, never only-on-tap. Tapping the drawing
// does the same thing as tapping its chip — it is the enhancement, not the
// interface. An untrained group is additionally drawn with a dashed outline
// and no fill, so "zero" survives being rendered in greyscale.
import { escapeHtml } from "../ui.js";
import { getLanguage, t } from "../i18n.js";
import { MUSCLE_GROUPS, translateExerciseName } from "../exerciseI18n.js";
import { allSetsFlat } from "./workoutState.js";

const el = (id) => document.getElementById(id);

export const MUSCLE_HEATMAP_CATEGORIES = MUSCLE_GROUPS;
export const MUSCLE_WINDOW_DAYS = 7;
const DAY_MS = 86400000;
// How many exercises to name in the detail panel. A group is rarely worked
// with more than three or four distinct movements in a week, and the panel is
// a glance surface sitting under a drawing — not an archive.
const DETAIL_EXERCISE_LIMIT = 4;

// ---------------------------------------------------------------------------
// The counting (moved verbatim from progress.js — see its old header)
//
// Sets, not tonnage, are the volume proxy: it is the same choice openGym's own
// muscle map makes, and the only one that still counts bodyweight work
// (weight_kg = 0) as real training instead of as zero volume. Cardio and
// full-body sets exist in the data but are not a muscle-group signal, so they
// are simply not in this list — excluded, not zeroed.
//
// Pure and synchronous. At the data sizes this app ever sees (a few hundred
// cached sets at most) one O(n) pass is sub-millisecond, nowhere near enough
// to justify chunking or a worker.
// ---------------------------------------------------------------------------
function categoryOf(set) {
  const raw = (set?.category || "").toLowerCase();
  return MUSCLE_HEATMAP_CATEGORIES.find((c) => c.toLowerCase() === raw) || null;
}

export function computeMuscleHeatmap(sets) {
  const cutoff = Date.now() - MUSCLE_WINDOW_DAYS * DAY_MS;
  const counts = Object.fromEntries(MUSCLE_HEATMAP_CATEGORIES.map((c) => [c, 0]));
  for (const s of sets || []) {
    if (new Date(s.logged_at).getTime() < cutoff) continue;
    const cat = categoryOf(s);
    if (cat) counts[cat]++;
  }
  const max = Math.max(0, ...Object.values(counts));
  return { counts, max };
}

/** Everything the map and its detail panel need, in one pass over the same
 *  cached sets.
 *
 *  `lastTrainedAt` deliberately looks at the WHOLE cached history rather than
 *  the 7-day window the counts use: "last trained 11 days ago" is the single
 *  most useful thing this panel can tell someone about a group with a zero
 *  next to it, and a window-bounded scan could only ever answer "not this
 *  week", which the zero already said. */
export function computeMuscleStats(sets, now = Date.now()) {
  const cutoff = now - MUSCLE_WINDOW_DAYS * DAY_MS;
  const stats = Object.fromEntries(
    MUSCLE_HEATMAP_CATEGORIES.map((c) => [c, { count: 0, lastTrainedAt: null, exercises: new Map() }]),
  );
  for (const s of sets || []) {
    const cat = categoryOf(s);
    if (!cat) continue;
    const at = new Date(s.logged_at).getTime();
    const entry = stats[cat];
    if (Number.isFinite(at) && (entry.lastTrainedAt === null || at > entry.lastTrainedAt)) entry.lastTrainedAt = at;
    if (!Number.isFinite(at) || at < cutoff) continue;
    entry.count += 1;
    const name = s.exercise_name || "";
    entry.exercises.set(name, (entry.exercises.get(name) || 0) + 1);
  }
  // Map -> a sorted array, so nothing downstream has to know it was a Map.
  for (const cat of MUSCLE_HEATMAP_CATEGORIES) {
    const entry = stats[cat];
    entry.exercises = [...entry.exercises.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }
  const max = Math.max(0, ...MUSCLE_HEATMAP_CATEGORIES.map((c) => stats[c].count));
  return { stats, max };
}

/** Whole local days between `at` and now, floored — so a set logged four hours
 *  ago reads "today" rather than "0 days ago", and one logged last night reads
 *  as yesterday even though it is 14 hours old. Calendar days are what a
 *  lifter means by "when did I last hit legs". */
function daysSince(at, now = Date.now()) {
  if (at === null) return null;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfThen = new Date(at);
  startOfThen.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((startOfToday - startOfThen) / DAY_MS));
}

// ---------------------------------------------------------------------------
// The drawing.
//
// Authored as ONE side of a stylised figure and mirrored about the centre line
// (x = 60) by the renderer, so the two halves cannot drift apart and the
// markup is half the size. `mirror: false` marks the shapes that are already
// symmetric about that line and must therefore be drawn once (the abdomen, the
// lower back) — mirroring those would paint them on top of themselves at
// double opacity.
//
// The base silhouette carries no group and is never tinted: it is what makes
// the tinted regions read as a body rather than as six floating blobs.
// ---------------------------------------------------------------------------
const VIEWBOX = "0 0 120 232";

// The body itself, never tinted: it is what makes the coloured regions read as
// a person rather than as six floating blobs. Authored as separate pieces
// (torso, arm, leg) rather than one heroic path, because a limb that is its own
// shape is the difference between a figure and a rectangle with a head — the
// first draft merged the arms into the torso and looked like exactly that.
const SILHOUETTE = [
  { d: "M54 26h12v11c-4 3-8 3-12 0z", mirror: false }, // neck
  // Torso: shoulders at y 40, waist pulled in at y 88, hips back out at y 116.
  { d: "M60 34C50 34 43 37 41 44L38 60C37 71 37 81 39 90L44 106C45 111 45 114 44 118H76C75 114 75 111 76 106L81 90C83 81 83 71 82 60L79 44C77 37 70 34 60 34Z", mirror: false },
  // Arm: one tapering piece from the deltoid to the hand, hanging clear of the
  // torso's own edge so the two never read as one slab.
  { d: "M41 44C34 47 30 53 29 62L26 96C25 107 24 117 24 127C24 134 26 138 29 138C33 138 35 134 35 127L37 105L40 80L43 58Z", mirror: true },
  // Leg: hip to foot, with the knee as the narrow point at y 168.
  { d: "M44 118V152C44 166 45 180 46 192L47 210C47 218 48 222 51 222H56C58 222 59 218 59 210V190L60 160V118Z", mirror: true },
];

const FRONT_REGIONS = [
  // Deltoid cap — the outermost shape at the top, which is what makes the
  // figure read as having shoulders rather than just a wide chest.
  { group: "Shoulders", d: "M45 40C37 43 32 50 31 60C30 66 31 71 33 75C35 64 38 53 46 47Z", mirror: true },
  // Pectoral. Stops short of the centre line so the two halves read as two
  // muscles with a sternum between them, not one slab.
  { group: "Chest", d: "M58 46L48 49C44 51 43 56 43 63C43 69 46 73 51 73L58 72Z", mirror: true },
  // Biceps, then forearm — two shapes rather than one, so the elbow exists.
  { group: "Arms", d: "M41 50C36 53 33 58 32 66L30 86C34 86 37 82 38 76L40 62Z", mirror: true },
  { group: "Arms", d: "M29 96L27 114C26 122 26 128 27 132C31 131 33 127 33 120L34 102Z", mirror: true },
  // Abdomen — symmetric about the centre line, so it is authored once.
  { group: "Core", d: "M50 76H70L69 93C68 103 65 111 60 117C55 111 52 103 51 93Z", mirror: false },
  { group: "Legs", d: "M45 122H59V150C59 160 58 166 56 171H48C46 166 45 160 45 150Z", mirror: true },
  { group: "Legs", d: "M47 178H57V197C57 204 56 209 54 212H50C48 209 47 204 47 197Z", mirror: true },
];

const BACK_REGIONS = [
  { group: "Shoulders", d: "M45 40C37 43 32 50 31 60C30 66 31 71 33 75C35 64 38 53 46 47Z", mirror: true },
  // Lat + trap as ONE shape per side. The six-bucket data cannot tell them
  // apart, so drawing them apart would be a claim the numbers do not support.
  { group: "Back", d: "M59 42L48 46C43 49 41 55 41 65C41 77 45 87 51 93L59 97Z", mirror: true },
  { group: "Arms", d: "M41 50C36 53 33 58 32 66L30 86C34 86 37 82 38 76L40 62Z", mirror: true },
  { group: "Arms", d: "M29 96L27 114C26 122 26 128 27 132C31 131 33 127 33 120L34 102Z", mirror: true },
  // Lower back — symmetric, authored once (see the abdomen above).
  { group: "Core", d: "M51 101H69L68 113C67 119 64 124 60 127C56 124 53 119 52 113Z", mirror: false },
  { group: "Legs", d: "M45 122H59V150C59 160 58 166 56 171H48C46 166 45 160 45 150Z", mirror: true },
  { group: "Legs", d: "M47 178H57V197C57 204 56 209 54 212H50C48 209 47 204 47 197Z", mirror: true },
];

// Mirroring about x = 60: reflect through the origin, then slide back.
const MIRROR = "translate(120,0) scale(-1,1)";

function regionMarkup(regions) {
  return regions
    .map((r) => {
      const one = (transform) =>
        `<path class="muscle-region" data-group="${r.group}"${transform ? ` transform="${transform}"` : ""} d="${r.d}" />`;
      return r.mirror ? one(null) + one(MIRROR) : one(null);
    })
    .join("");
}

function silhouetteMarkup() {
  return SILHOUETTE.map((p) => {
    const one = (transform) =>
      `<path class="muscle-figure-base"${transform ? ` transform="${transform}"` : ""} d="${p.d}" />`;
    return p.mirror ? one(null) + one(MIRROR) : one(null);
  }).join("");
}

function figureMarkup(side, regions) {
  return `
    <figure class="muscle-figure" data-side="${side}">
      <svg class="muscle-figure-svg" viewBox="${VIEWBOX}" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">
        <ellipse class="muscle-figure-base" cx="60" cy="17" rx="11" ry="13" />
        ${silhouetteMarkup()}
        ${regionMarkup(regions)}
      </svg>
      <figcaption class="muscle-figure-caption" data-caption="${side}"></figcaption>
    </figure>`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
let selectedGroup = null;
/** Every `.muscle-region` path, bucketed by group once at init — so a render
 *  is six `setProperty` calls over a cached list, never a querySelectorAll. */
let regionsByGroup = new Map();
let built = false;

function groupLabel(group) {
  return t(`muscleMap.group${group}`);
}

function lastTrainedText(days) {
  if (days === null) return t("muscleMap.lastNever");
  if (days === 0) return t("muscleMap.lastToday");
  if (days === 1) return t("muscleMap.lastYesterday");
  return t("muscleMap.lastDaysAgo", { count: days });
}

function paintRegions(stats, max) {
  for (const group of MUSCLE_HEATMAP_CATEGORIES) {
    const count = stats[group].count;
    // Relative to the week's own busiest group, not to an absolute set count:
    // a 40-set week and a 12-set week are both legible, and the question this
    // answers is "what did I cover", never "did I train enough".
    const intensity = max > 0 ? count / max : 0;
    for (const node of regionsByGroup.get(group) || []) {
      node.style.setProperty("--muscle-intensity", String(intensity));
      node.dataset.empty = count === 0 ? "true" : "false";
      node.dataset.selected = selectedGroup === group ? "true" : "false";
    }
  }
}

function renderLegend(stats) {
  const legend = el("muscle-map-legend");
  if (!legend) return;
  legend.replaceChildren(
    ...MUSCLE_HEATMAP_CATEGORIES.map((group) => {
      const count = stats[group].count;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "muscle-legend-chip";
      btn.dataset.group = group;
      btn.dataset.empty = count === 0 ? "true" : "false";
      btn.setAttribute("aria-pressed", String(selectedGroup === group));
      // The set count is real text inside the chip, not a title or a tooltip:
      // it is the half of this component that works without colour at all.
      btn.innerHTML = `<span class="muscle-legend-name">${escapeHtml(groupLabel(group))}</span><span class="muscle-legend-count mono">${count}</span>`;
      return btn;
    }),
  );
}

function renderDetail(stats) {
  const panel = el("muscle-map-detail");
  if (!panel) return;
  if (!selectedGroup) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  const entry = stats[selectedGroup];
  const lang = getLanguage();
  panel.hidden = false;

  const title = document.createElement("p");
  title.className = "muscle-detail-title";
  title.textContent = groupLabel(selectedGroup);

  const meta = document.createElement("p");
  meta.className = "muscle-detail-meta";
  meta.textContent = `${t("muscleMap.setsThisWeek", { count: entry.count })} · ${lastTrainedText(
    daysSince(entry.lastTrainedAt),
  )}`;

  const list = document.createElement("ul");
  list.className = "muscle-detail-list";
  if (!entry.exercises.length) {
    const li = document.createElement("li");
    li.className = "muscle-detail-none";
    li.textContent = t("muscleMap.detailNone");
    list.appendChild(li);
  } else {
    for (const ex of entry.exercises.slice(0, DETAIL_EXERCISE_LIMIT)) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = translateExerciseName(ex.name, lang);
      const n = document.createElement("span");
      n.className = "mono";
      n.textContent = String(ex.count);
      li.append(name, n);
      list.appendChild(li);
    }
  }
  panel.replaceChildren(title, meta, list);
}

/** Cheap and idempotent — every caller that might have changed a set can just
 *  call it. Reads the same `state.sessions` cache everything else in this
 *  folder reads, so it costs no network and nothing can be stale relative to
 *  the set list it sits next to. */
export function renderMuscleMap() {
  if (!built) return;
  const { stats, max } = computeMuscleStats(allSetsFlat());

  const empty = el("muscle-map-empty");
  const body = el("muscle-map-body");
  if (max === 0) {
    // Nothing trained in the window. The figure is hidden rather than drawn
    // entirely blank: an all-grey body says "this feature is broken" far more
    // readily than it says "you have not trained this week".
    if (empty) empty.hidden = false;
    if (body) body.hidden = true;
    selectedGroup = null;
    renderDetail(stats);
    return;
  }
  if (empty) empty.hidden = true;
  if (body) body.hidden = false;

  for (const side of ["front", "back"]) {
    const cap = document.querySelector(`#muscle-map-body [data-caption="${side}"]`);
    if (cap) cap.textContent = t(`muscleMap.side${side === "front" ? "Front" : "Back"}`);
  }

  paintRegions(stats, max);
  renderLegend(stats);
  renderDetail(stats);

  // The non-visual summary the old heatmap already produced, kept verbatim in
  // spirit: the one line that answers "what am I missing" without reading any
  // colour at all.
  const hint = el("muscle-map-hint");
  if (hint) {
    const neglected = MUSCLE_HEATMAP_CATEGORIES.filter((c) => stats[c].count === 0);
    hint.hidden = false;
    hint.dataset.tone = neglected.length ? "warn" : "ok";
    hint.textContent = neglected.length
      ? t("muscleMap.neglected", { names: neglected.map(groupLabel).join(", ") })
      : t("muscleMap.allCovered");
  }
}

function selectGroup(group) {
  // Tapping the current selection clears it — the same "a mistap is undone by
  // a second tap" affordance portionPresets.js's chips already use.
  selectedGroup = selectedGroup === group ? null : group;
  renderMuscleMap();
}

export function initMuscleMap() {
  const body = el("muscle-map-body");
  if (!body || built) return;
  body.innerHTML = figureMarkup("front", FRONT_REGIONS) + figureMarkup("back", BACK_REGIONS);

  regionsByGroup = new Map(MUSCLE_HEATMAP_CATEGORIES.map((g) => [g, []]));
  for (const node of body.querySelectorAll(".muscle-region")) {
    regionsByGroup.get(node.dataset.group)?.push(node);
  }

  // One delegated listener per surface rather than one per path (there are 26
  // of them). The drawing is the enhancement — see this module's header — so
  // it carries no keyboard handling of its own; the legend below is the
  // focusable control and gets it for free by being real buttons.
  body.addEventListener("click", (e) => {
    const region = e.target.closest?.(".muscle-region");
    if (region?.dataset.group) selectGroup(region.dataset.group);
  });
  el("muscle-map-legend")?.addEventListener("click", (e) => {
    const chip = e.target.closest?.(".muscle-legend-chip");
    if (chip?.dataset.group) selectGroup(chip.dataset.group);
  });

  built = true;
}
