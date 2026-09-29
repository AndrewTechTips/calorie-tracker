// The cardio logged against the active session (Phase 5.3) — and the first
// time any of it has been visible.
//
// Phase 3 could CREATE a cardio entry and DELETE one by id, and that was the
// whole surface. Nothing rendered the rows, so `api.deleteCardio` had no
// caller and there was no way to reach an entry at all. A user who logged 20
// minutes when they meant 40, or picked the bike when they were on the rower,
// had two options: live with the wrong figure — folded into the session total,
// the dashboard's Activity Burn chip and analytics' 7-day average — or delete
// the session it was attached to.
//
// That is the "computed once, never again" gap, and its visible half is this
// list. The invisible half is what the backend does when an edit arrives: it
// re-runs the equations rather than patching the stored number (see
// routers/workouts.py::update_cardio).
//
// Each row states its own provenance, exactly as the sheet's live preview
// does. A treadmill priced by the ACSM walking equation and an elliptical
// priced from a MET band must not look equally certain just because they are
// both rows in a list — that is the one thing the whole cardio module exists
// to avoid.
import { deleteWithUndo, escapeHtml } from "../ui.js";
import { t } from "../i18n.js";
import { findSession, state } from "./workoutState.js";

const el = (id) => document.getElementById(id);

// Machine ids the cardio sheet offers. Anything else is free text the backend
// priced from the flat MET table, and is shown as typed.
const MACHINE_LABEL_KEYS = {
  treadmill: "cardio.machineTreadmill",
  stairmaster: "cardio.machineStairmaster",
  bike: "cardio.machineBike",
  rower: "cardio.machineRower",
  elliptical: "cardio.machineElliptical",
  outdoor: "cardio.machineOutdoor",
};

function machineLabel(machine) {
  const key = MACHINE_LABEL_KEYS[(machine || "").toLowerCase()];
  return key ? t(key) : machine || "—";
}

/** The console readings, rendered back as the user typed them — "6 km/h · 8%"
 *  rather than a params blob. Keys are per-machine (see cardio.js's MACHINES),
 *  so this is a lookup, not a fixed shape, and an unrecognised key is shown
 *  rather than dropped: a figure priced from something the UI cannot name is
 *  exactly the case a user needs to see in order to correct it. */
const PARAM_SUFFIX = {
  speed_kmh: "km/h",
  incline_percent: "%",
  steps_per_min: "/min",
  watts: "W",
  split_seconds: "s/500m",
  distance_km: "km",
};

// A reading with no unit to hang off needs its NAME instead: a bare "10" in a
// row that otherwise reads "6km/h · 8%" is the one entry a user cannot decode,
// and an elliptical's resistance level is exactly that. Named rather than
// given an invented unit, and translated, since the rest of the row is.
const PARAM_LABEL_KEYS = {
  resistance: "cardio.fieldResistance",
};

function paramsSummary(params) {
  const entries = Object.entries(params || {}).filter(([, v]) => v !== "" && v !== null && v !== undefined);
  if (!entries.length) return "";
  return entries
    .map(([k, v]) => {
      const labelKey = PARAM_LABEL_KEYS[k];
      if (labelKey) return `${t(labelKey)} ${v}`;
      return `${v}${PARAM_SUFFIX[k] ?? ""}`;
    })
    .join(" · ");
}

// Injected by index.js, for the same reason trainView.js's actions are: this
// module sits above the sheet and the write paths, and importing downward
// would close a cycle.
let actions = {
  onEdit: null, //   (cardioRow) => void
  onDelete: null, // (cardioId) => Promise
  onChanged: null, // (savedSession) => void
};
export function setCardioListActions(next) {
  actions = { ...actions, ...next };
}

export function renderCardioList() {
  const section = el("wd-cardio-section");
  const list = el("wd-cardio-list");
  if (!section || !list) return;
  const session = findSession(state.activeSessionId);
  const rows = session?.cardio || [];
  // Hidden entirely rather than shown empty: a strength session has no cardio
  // and an empty panel offering nothing is noise on the one screen that is
  // meant to hold only what is being logged right now.
  if (!rows.length) {
    section.hidden = true;
    list.replaceChildren();
    return;
  }
  section.hidden = false;
  list.replaceChildren(
    ...rows.map((row) => {
      const item = document.createElement("div");
      item.className = "wd-cardio-row";
      item.dataset.cardioId = row.id;
      // A flagged estimate visibly loses the accent, the same way the sheet's
      // live figure does — so the tier is consistent between the moment it was
      // logged and every time it is read back.
      item.dataset.estimate = String(Boolean(row.is_estimate));
      const readings = paramsSummary(row.params);
      const meta = [t("cardio.overMinutes", { minutes: Math.round(row.duration_minutes || 0) }), readings]
        .filter(Boolean)
        .join(" · ");
      item.innerHTML = `
        <button type="button" class="wd-cardio-main" data-action="edit">
          <span class="wd-cardio-name">${escapeHtml(machineLabel(row.machine))}</span>
          <span class="wd-cardio-meta">${escapeHtml(meta)}</span>
          <span class="wd-cardio-provenance">${escapeHtml(
            row.is_estimate ? t("cardio.roughEstimate") : t("cardio.basisNet"),
          )}</span>
        </button>
        <span class="wd-cardio-kcal mono">${Math.round(row.calories_burned || 0)}</span>
        <button type="button" class="wd-cardio-delete" data-action="delete" aria-label="${escapeHtml(
          t("cardio.deleteAria"),
        )}">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      `;
      return item;
    }),
  );
}

export function initCardioList() {
  const list = el("wd-cardio-list");
  if (!list) return;
  list.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-action]");
    const row = e.target.closest?.(".wd-cardio-row");
    if (!btn || !row) return;
    const session = findSession(state.activeSessionId);
    const entry = (session?.cardio || []).find((c) => c.id === row.dataset.cardioId);
    if (!entry) return;
    if (btn.dataset.action === "edit") {
      actions.onEdit?.(entry);
      return;
    }
    // Deleting goes through the app's shared undo toast rather than a confirm
    // dialog — the same affordance deleting a session already uses, and the
    // right one for a removal that is cheap to reverse.
    deleteWithUndo({
      removeNow: () => {
        const current = findSession(state.activeSessionId);
        if (!current) return;
        actions.onChanged?.({ ...current, cardio: (current.cardio || []).filter((c) => c.id !== entry.id) });
      },
      restore: () => actions.onChanged?.(session),
      // The DELETE answers with the whole recomputed session, so the burn
      // reconciles from the server's own figure rather than from the local
      // subtraction the optimistic removal above did.
      callDelete: async () => {
        const saved = await actions.onDelete?.(entry.id);
        if (saved) actions.onChanged?.(saved);
      },
      removedToastKey: "cardio.toastDeleted",
      revertToastKey: "workoutDiary.toastError",
    });
  });
}
