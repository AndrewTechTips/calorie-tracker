// The cardio sheet (Phase 3.4/3.5) — machine picker, per-machine inputs, a
// live estimate that carries its own provenance, and optional interval
// segments.
//
// MACHINE FIRST, because the machine decides which inputs exist. A treadmill
// is speed and incline; a bike is watts; a rower is a split. The old path could
// only take "an activity name and a duration", which threw away the readings
// the user is looking at on the console — and those readings ARE the answer
// (see services/cardio_service.py for how much the incline term alone matters).
//
// The estimate updates as the inputs change, computed locally by cardioMath.js.
// What is SAVED is always the backend's own figure: this sheet posts the raw
// segments and renders whatever comes back. See cardioMath.js's header for why
// the duplication exists and what keeps it honest.
import { api } from "../api.js";
import { closeSheet, escapeHtml, openSheet, showToast, vibrate } from "../ui.js";
import { t } from "../i18n.js";
import { estimateSegments } from "./cardioMath.js";
import { sessionsForDate, todayIso } from "./workoutState.js";

const el = (id) => document.getElementById(id);

// Each machine declares the fields it actually has. Adding one is a row here
// plus an entry in cardioMath.js's MACHINES — no branching in the renderer.
const MACHINES = [
  {
    id: "treadmill",
    icon: "🏃",
    labelKey: "cardio.machineTreadmill",
    fields: [
      { key: "speed_kmh", labelKey: "cardio.fieldSpeed", suffix: "km/h", step: 0.5, min: 0, max: 30, default: 6 },
      { key: "incline_percent", labelKey: "cardio.fieldIncline", suffix: "%", step: 0.5, min: 0, max: 40, default: 0 },
    ],
  },
  {
    id: "stairmaster",
    icon: "🪜",
    labelKey: "cardio.machineStairmaster",
    fields: [
      { key: "steps_per_min", labelKey: "cardio.fieldStepRate", suffix: "/min", step: 5, min: 0, max: 200, default: 60 },
    ],
  },
  {
    id: "bike",
    icon: "🚴",
    labelKey: "cardio.machineBike",
    fields: [{ key: "watts", labelKey: "cardio.fieldWatts", suffix: "W", step: 5, min: 0, max: 600, default: 120 }],
  },
  {
    id: "rower",
    icon: "🚣",
    labelKey: "cardio.machineRower",
    // Seconds per 500m, which is what a Concept2 shows. cardioMath converts.
    fields: [
      { key: "split_seconds", labelKey: "cardio.fieldSplit", suffix: "s/500m", step: 1, min: 60, max: 300, default: 135 },
    ],
  },
  {
    id: "elliptical",
    icon: "🏃",
    labelKey: "cardio.machineElliptical",
    fields: [
      { key: "resistance", labelKey: "cardio.fieldResistance", suffix: "", step: 1, min: 1, max: 20, default: 10 },
    ],
  },
  {
    id: "outdoor",
    icon: "🚶",
    labelKey: "cardio.machineOutdoor",
    fields: [
      { key: "distance_km", labelKey: "cardio.fieldDistance", suffix: "km", step: 0.5, min: 0, max: 200, default: 5 },
    ],
  },
];

const machineById = (id) => MACHINES.find((m) => m.id === id) || MACHINES[0];

// One segment while the sheet is simple; "+ Add a segment" grows the list.
let segments = [];
let bodyweightKg = 70; // replaced on first open, see resolveBodyweight()
let saving = false;

function blankSegment(machineId = "treadmill") {
  const machine = machineById(machineId);
  const params = {};
  for (const f of machine.fields) params[f.key] = f.default;
  return { machine: machineId, params, duration_minutes: 20 };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderMachines() {
  const wrap = el("cardio-machines");
  const currentId = segments[0]?.machine || "treadmill";
  wrap.replaceChildren(
    ...MACHINES.map((m) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = m.id === currentId ? "cardio-machine cardio-machine-active" : "cardio-machine";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(m.id === currentId));
      btn.dataset.machine = m.id;
      btn.innerHTML = `<span class="cardio-machine-icon" aria-hidden="true">${m.icon}</span><span class="cardio-machine-label">${escapeHtml(t(m.labelKey))}</span>`;
      btn.addEventListener("click", () => {
        // Switching machine replaces the FIRST segment only. A multi-segment
        // effort is usually on one machine, and silently rewriting a
        // carefully-entered interval list because the picker was tapped would
        // be the worse surprise.
        segments[0] = blankSegment(m.id);
        renderAll();
      });
      return btn;
    }),
  );
}

function renderSegment(segment, index) {
  const machine = machineById(segment.machine);
  const row = document.createElement("div");
  row.className = "cardio-segment";

  if (segments.length > 1) {
    const head = document.createElement("div");
    head.className = "cardio-segment-head";
    head.innerHTML = `<span class="cardio-segment-label">${escapeHtml(t("cardio.segmentLabel", { n: index + 1 }))}</span>`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cardio-segment-remove";
    remove.setAttribute("aria-label", t("cardio.removeSegmentAria"));
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      segments.splice(index, 1);
      renderAll();
    });
    head.appendChild(remove);
    row.appendChild(head);
  }

  const grid = document.createElement("div");
  grid.className = "cardio-field-grid";
  const fields = [
    ...machine.fields,
    { key: "__duration", labelKey: "cardio.fieldDuration", suffix: "min", step: 1, min: 1, max: 600 },
  ];
  for (const field of fields) {
    const isDuration = field.key === "__duration";
    const wrap = document.createElement("label");
    wrap.className = "cardio-field";
    const value = isDuration ? segment.duration_minutes : segment.params[field.key];
    wrap.innerHTML = `
      <span class="cardio-field-label">${escapeHtml(t(field.labelKey))}${field.suffix ? ` <span class="cardio-field-suffix">${escapeHtml(field.suffix)}</span>` : ""}</span>
      <input type="number" inputmode="decimal" step="${field.step}" min="${field.min}" max="${field.max}" value="${value ?? ""}" />
    `;
    const input = wrap.querySelector("input");
    input.addEventListener("input", () => {
      const next = input.value === "" ? "" : Number(input.value);
      if (isDuration) segment.duration_minutes = next;
      else segment.params[field.key] = next;
      // Only the estimate is re-rendered on a keystroke — rebuilding the
      // inputs would steal focus mid-type, which is the classic way a live
      // preview makes a form unusable.
      renderEstimate();
    });
    grid.appendChild(wrap);
  }
  row.appendChild(grid);
  return row;
}

function renderSegments() {
  el("cardio-segments").replaceChildren(...segments.map(renderSegment));
  el("cardio-add-segment-btn").hidden = segments.length >= 20;
}

function renderEstimate() {
  const { kcal, minutes, isEstimate } = estimateSegments(segments, bodyweightKg, { net: true });
  el("cardio-estimate-kcal").textContent = kcal > 0 ? `${Math.round(kcal)} kcal` : "—";
  el("cardio-estimate-met").textContent = minutes > 0 ? t("cardio.overMinutes", { minutes: Math.round(minutes) }) : "";

  // The provenance line. It names the basis (net, not gross), the bodyweight
  // the figure depends on, and — when any segment fell back to a band or an
  // extrapolation — says so plainly rather than letting a guess and a
  // validated equation share a typeface.
  const parts = [t("cardio.basisNet"), t("cardio.atBodyweight", { kg: Math.round(bodyweightKg) })];
  el("cardio-estimate-provenance").textContent =
    (isEstimate ? `${t("cardio.roughEstimate")} · ` : "") + parts.join(" · ");
  el("cardio-estimate").dataset.estimate = String(isEstimate);
}

function renderAll() {
  renderMachines();
  renderSegments();
  renderEstimate();
}

// ---------------------------------------------------------------------------
// Open / save
// ---------------------------------------------------------------------------
/** Bodyweight drives the whole calculation — every equation is per kilogram —
 *  so the preview cannot say anything true without it.
 *
 *  Resolved lazily, on the first open, rather than fetched at boot: most
 *  sessions never log cardio, and this is one small GET against data that
 *  changes at most once a day. `resolved` latches so a second open costs
 *  nothing, and a failure falls back to the same DEFAULT_BODYWEIGHT_KG the
 *  backend uses for a user who has never logged a weight — so the preview and
 *  the saved figure agree even in that case.
 *
 *  Note this only affects the PREVIEW. The stored figure is computed
 *  server-side from the user's real latest weight_logs row. */
const FALLBACK_BODYWEIGHT_KG = 70; // mirrors workout_service.DEFAULT_BODYWEIGHT_KG
let bodyweightResolved = false;

export function setCardioBodyweight(kg) {
  if (kg > 0) {
    bodyweightKg = kg;
    bodyweightResolved = true;
  }
}

async function resolveBodyweight() {
  if (bodyweightResolved) return;
  bodyweightResolved = true; // latch first: a failed lookup must not retry on every open
  try {
    const rows = await api.listWeight();
    const latest = (rows || [])[0];
    if (latest?.weight_kg > 0) {
      bodyweightKg = Number(latest.weight_kg);
      renderEstimate();
    }
  } catch {
    bodyweightKg = FALLBACK_BODYWEIGHT_KG;
  }
}

export function openCardioSheet() {
  segments = [blankSegment("treadmill")];
  saving = false;
  el("cardio-save-btn").disabled = false;
  renderAll();
  openSheet("cardio-sheet");
  // Not awaited — the sheet opens instantly with whatever weight is known and
  // the figure corrects itself a moment later if the lookup changes it.
  resolveBodyweight();
}

async function saveCardio() {
  if (saving) return;
  const usable = segments.filter((s) => Number(s.duration_minutes) > 0);
  if (!usable.length) {
    showToast(t("cardio.needDuration"), "error");
    return;
  }

  saving = true;
  el("cardio-save-btn").disabled = true;
  try {
    // A cardio effort attaches to a workout_sessions row, so one has to exist.
    // Reuse today's open session if there is one — a bike finisher after a lift
    // belongs to the same session, not a second one beside it.
    let session = sessionsForDate(todayIso()).find((s) => !s.ended_at) || null;
    if (!session) {
      session = await api.createWorkoutSession({ session_date: todayIso() });
      onSessionCreated?.(session);
    }
    const saved = await api.addCardio(session.id, {
      segments: usable.map((s) => ({
        machine: s.machine,
        params: s.params,
        duration_minutes: Number(s.duration_minutes),
      })),
      net: true,
    });
    onCardioSaved?.(saved);
    vibrate(12);
    closeSheet("cardio-sheet");
    showToast(t("cardio.toastLogged", { kcal: Math.round(saved.calories_burned || 0) }), "success");
  } catch (err) {
    showToast(err.message || t("workoutDiary.toastError"), "error");
  } finally {
    saving = false;
    el("cardio-save-btn").disabled = false;
  }
}

// Injected by index.js — this module must not reach back into the folder's
// state writers, for the same reason trainView.js does not (see its header).
let onCardioSaved = null;
let onSessionCreated = null;
export function setCardioHandlers({ onSaved, onSession }) {
  onCardioSaved = onSaved;
  onSessionCreated = onSession;
}

export function initCardio() {
  el("cardio-add-segment-btn").addEventListener("click", () => {
    // A new segment inherits the current machine: an interval session is
    // almost always on one machine, at different efforts.
    segments.push(blankSegment(segments[segments.length - 1]?.machine || "treadmill"));
    renderAll();
  });
  el("cardio-save-btn").addEventListener("click", saveCardio);
}
