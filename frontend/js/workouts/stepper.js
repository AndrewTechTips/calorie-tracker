// Phase 2.3 — ± steppers on the weight and reps fields.
//
// The keyboard becomes opt-in rather than mandatory. Set to set, weight usually
// repeats and reps drift by one, so the overwhelmingly common entry is "the
// same again" or "one less" — both of which a numeric keypad makes needlessly
// expensive on a phone held one-handed in a gym: focus the field, wait for the
// pad, type, dismiss it to see the button underneath.
//
// This is also the single biggest accessibility win available in the logger.
// A 44px target hit with a thumb is reachable for someone with reduced fine
// motor control, and for anyone who simply cannot read a 14px field in bad
// lighting; the fields stay fully typeable for the cases stepping is wrong for
// (a first-ever entry, a big jump).
import { vibrate } from "../ui.js";

// Bounds come from the input's own min/max — which already mirror
// backend/models.py's WorkoutSetCreate — so there is no second copy of the
// limits here to drift from them. The increment is per-field, declared on the
// wrapper as `data-step`: 2.5kg is the standard plate jump, reps go by one.
function clamp(value, input) {
  const min = input.min === "" ? -Infinity : Number(input.min);
  const max = input.max === "" ? Infinity : Number(input.max);
  return Math.min(max, Math.max(min, value));
}

/** Trailing-zero-free output: 82.5 stays 82.5, 80.0 becomes 80. A field that
 *  reads "80.0" invites the user to wonder whether it means something. */
function format(value) {
  return String(Math.round(value * 100) / 100);
}

function stepOnce(input, stepSize, direction) {
  const raw = input.value.trim();

  // An EMPTY field with a ghost placeholder (ghostValues.js has put last
  // session's number there) adopts that number outright on the first tap,
  // without applying the step. "Same as last time" is by far the most common
  // intent when starting an exercise, and this makes it one tap rather than
  // one tap plus a correction. A second tap then steps from there as normal.
  if (raw === "" && input.placeholder !== "") {
    const ghost = Number(input.placeholder);
    if (Number.isFinite(ghost)) {
      input.value = format(clamp(ghost, input));
      return true;
    }
  }

  const current = raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(current)) return false;
  const next = clamp(current + stepSize * direction, input);
  if (format(next) === format(current) && raw !== "") return false; // already at the bound
  input.value = format(next);
  return true;
}

/** Wires every `.wd-stepper` currently in the document. Delegated from the
 *  document rather than bound per button so markup that a later phase moves
 *  (2.1 restructures this whole panel) keeps working without re-initialising. */
export function initSteppers() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".wd-stepper-btn");
    if (!btn) return;
    const wrap = btn.closest(".wd-stepper");
    const input = document.getElementById(btn.dataset.target);
    if (!wrap || !input) return;
    const stepSize = Number(wrap.dataset.step) || 1;
    const changed = stepOnce(input, stepSize, Number(btn.dataset.dir) || 1);
    if (!changed) return;
    // A short tick per accepted step, and none when the value is already at its
    // bound — the absence of feedback is what tells a thumb it has hit the end.
    vibrate(8);
    // Anything listening to the field (validation, a future live 1RM preview)
    // should see a real edit, not a silent property write.
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
