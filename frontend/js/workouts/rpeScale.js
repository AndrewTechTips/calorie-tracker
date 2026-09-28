// The 1-10 RPE picker. Lifted out of workoutDiary.js (Phase 0.3), keeping
// `selectedRpe` PRIVATE to this module rather than promoting it to the shared
// state object: nothing outside here ever needs to assign it, and the two
// callers that used to (submitSet clearing it after a logged set,
// selectExercise clearing it on a switch) want exactly "clear it", which is
// what clearSelectedRpe() is. A private variable with a narrow accessor pair
// says that; a public state field would not.
const el = (id) => document.getElementById(id);

let selectedRpe = null;

/** The value submitSet() sends as the set's `rpe` — null when the user
 *  skipped it, which the backend and schema both allow. */
export function getSelectedRpe() {
  return selectedRpe;
}
export function clearSelectedRpe() {
  selectedRpe = null;
}

// ---------------------------------------------------------------------------
// RPE picker — 10 segments, built once; renderRpeSelection() below just
// toggles which one is marked active.
// ---------------------------------------------------------------------------
export function buildRpeScale() {
  const container = el("wd-rpe-scale");
  container.replaceChildren(
    ...Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rpe-scale-btn";
      btn.dataset.rpe = String(n);
      btn.textContent = String(n);
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", "false");
      btn.addEventListener("click", () => {
        selectedRpe = selectedRpe === n ? null : n; // tap again to clear — RPE is optional
        renderRpeSelection();
      });
      return btn;
    }),
  );
}
export function renderRpeSelection() {
  el("wd-rpe-scale")
    .querySelectorAll(".rpe-scale-btn")
    .forEach((btn) => {
      const active = Number(btn.dataset.rpe) === selectedRpe;
      btn.classList.toggle("wd-rpe-active", active);
      btn.setAttribute("aria-checked", String(active));
    });
}
