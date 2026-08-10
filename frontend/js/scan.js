import { api } from "./api.js?v=20260810i";
import { closeSheet, escapeHtml, getActivePillType, openSheet, resetPillTabs, showToast, wirePillTabs } from "./ui.js?v=20260810i";
import { getLanguage, onLanguageChange, t } from "./i18n.js?v=20260810i";
import { asImplicitIngredient, createIngredientsEditor } from "./ingredientsList.js?v=20260810i";
import { scaleMacrosByWeight } from "./nutritionMath.js?v=20260810i";
import { addRecentScan, deleteRecentScanByLogId, listRecentScans } from "./db.js?v=20260810i";

const el = (id) => document.getElementById(id);

// On mobile, "tap to take a photo" is the natural affordance; on a laptop
// there's no camera capture flow worth advertising, and dragging a saved
// image in is the natural one instead — so the two hint different actions.
// This depends on pointer type, not just language, so it's resynced here
// (rather than being a plain data-i18n element) both at boot and on every
// language change.
const IS_POINTER_FINE = window.matchMedia("(pointer: fine)").matches;
const dropzoneHint = () => (IS_POINTER_FINE ? t("scan.dropzonePointer") : t("scan.dropzoneTouch"));

let selectedFile = null;
let scanMode = "photo"; // "photo" | "describe" | "barcode"
// Set by openScanSheetFresh() when this sheet was opened from a food-entry
// modal's own Smart Tools row while backdating a past day (see app.js's
// openManualSheet/manualTargetDate) — applied to the confirm payload's
// log_date below, exactly like the manual-entry form's own backdate handling,
// so a scan reached that way logs to the day the user actually meant instead
// of silently landing on today. null (the default, and what every other
// entry point into this sheet leaves it at) means "today," same as omitting
// log_date entirely.
let scanTargetDate = null;
// Set by openScanSheetFresh() when this sheet was opened from an EXISTING
// entry's own Smart Tools row (a Today's Journal card, or a Saved Meal) —
// see app.js's openSmartTool. Shape: { kind: "log" | "savedMeal", id,
// existingFoodName, existingIngredients }. When set, confirming this scan
// does NOT create a brand-new entry — it merges this scan's ingredients
// into the existing ones and hands the combined list back to the
// centralized edit modal for review (see onReturnToEdit below), so
// "forgot to log Bread with that meal" appends to what's already there
// instead of duplicating the whole meal as a second Journal card. null (the
// default, and what every other entry point into this sheet leaves it at)
// means "this is logging something brand new," the original behavior.
let scanEditContext = null;
let quotaAtCapacity = false;
let quotaLoaded = false; // has refreshScanQuota() ever resolved this sheet-open? gates the bar's visibility per mode

// Barcode-scanned product(s) attached alongside a photo/description — see
// the "Attach barcode product" flow below. Each entry is already a final
// {food_name, weight_g, calories, protein, carbs, fats, fiber} object scaled
// to the weight the user confirmed (see confirmAttachedItem), ready to send
// straight to the backend as-is (backend/models.py's IngredientItem shape).
let scanAttachedItems = [];
const MAX_ATTACHED_ITEMS = 3; // matches backend/routers/scan.py's MAX_ATTACHED_ITEMS
let pendingAttachResult = null; // raw scanBarcode() result awaiting weight confirmation
let attachRetryTimeout = null;

// ---------------------------------------------------------------------------
// In-progress draft + open-state persistence — installed PWAs get
// aggressively memory-discarded by the OS when backgrounded (see
// startPhotoCamera's own comment below for another angle on the same
// underlying issue), which fully reloads the page rather than merely
// suspending it: a user typing a description, switching apps to reply to a
// message, and coming back to find the sheet reset to blank — or gone
// entirely, dumped back on the dashboard mid-scan — is this exact failure
// mode, not a bug in any one event handler. sessionStorage (not
// localStorage) is the right scope — it survives that reload but doesn't
// need to survive a deliberate close of the tab/app the way a real saved
// preference would.
//
// `open: true` is the field that actually fixes the reported bug: it's
// written the instant the sheet opens (markSheetOpenForRecovery, called from
// openScanSheetFresh) and cleared the instant it's genuinely dismissed (see
// the MutationObserver on #scan-sheet's `hidden` attribute in initScan,
// below — one observer covers every dismissal path uniformly: Cancel,
// backdrop tap, swipe-to-dismiss, and submit, rather than needing each one
// to remember to clear it individually). app.js's boot sequence checks
// wasScanSheetOpenBeforeReload() right after sign-in resolves and, if true,
// reopens the sheet automatically instead of leaving the user to notice
// something vanished and hunt for it — the sheet stays "fully intact and
// visible" across a backgrounding-triggered reload, not just across a
// deliberate close/reopen. The two free-text fields ride along in the same
// object since they're cheap and already had their own recovery path; a
// selected photo/attached barcode items are not recoverable from a plain
// string, so those stay lost the way they always were.
// ---------------------------------------------------------------------------
const DRAFT_KEY = "ironlog_scan_draft";

function saveDraft() {
  const draft = {
    open: true,
    mode: scanMode,
    describeText: el("scan-describe-text").value,
    contextText: el("scan-context").value,
  };
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* sessionStorage can throw in some locked-down/private-browsing contexts
       — losing the draft-recovery convenience is fine, the sheet still works */
  }
}

// Written the moment the sheet opens, independent of saveDraft() above (which
// only fires on text input) — a user who opens the sheet and switches apps
// before typing anything must still be recognized as "had it open" when the
// app comes back.
function markSheetOpenForRecovery() {
  try {
    const existing = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}");
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...existing, open: true, mode: scanMode }));
  } catch {
    /* see saveDraft's comment */
  }
}

// Exported so app.js's onSignedOut can forget any in-progress scan draft —
// otherwise a next sign-in in the same tab (a shared/test device, or the
// same user signing back in) could inherit a stale "reopen the scan sheet"
// flag left by a session that ended by signing out rather than by actually
// closing the sheet.
export function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* see saveDraft's comment */
  }
}

// Read once at app boot (see app.js's onSignedIn) — true only when the sheet
// was left open by a session that never got a chance to close it cleanly
// (i.e. the page reloaded out from under it), never for a normal dismissal,
// since every real close path clears this same key (see the MutationObserver
// in initScan below).
export function wasScanSheetOpenBeforeReload() {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}").open === true;
  } catch {
    return false;
  }
}

// Called once, right after resetScanSheet() has already blanked everything —
// deliberately a separate step rather than folded into resetScanSheet itself,
// since resetScanSheet is also what runs right after a real submit (where the
// draft must stay cleared, not come back).
function restoreDraftIfAny() {
  let raw;
  try {
    raw = sessionStorage.getItem(DRAFT_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let draft;
  try {
    draft = JSON.parse(raw);
  } catch {
    clearDraft();
    return;
  }
  if (draft.describeText) el("scan-describe-text").value = draft.describeText;
  if (draft.contextText) el("scan-context").value = draft.contextText;
  updateDescribeCharCount();
  updateAnalyzeButtonState();
  // barcode mode has nothing typed to restore — it's a camera-driven lookup,
  // not a text draft, so there's no reason to reopen straight into it.
  if (draft.mode && draft.mode !== "barcode" && draft.mode !== scanMode) setScanMode(draft.mode);
}

// The shared daily Gemini quota gates both AI paths — photo and describe —
// but not barcode lookups (services/barcode.py on the backend, a separate,
// unlimited external API). Describe mode has a second exception: attached
// item(s) with no typed description at all skip Gemini entirely on the
// backend (a deterministic sum — see routers/scan.py::_sum_attached_items),
// so that combination must stay enabled even while the AI quota is spent.
function updateAnalyzeButtonState() {
  if (scanMode === "describe") {
    const hasText = el("scan-describe-text").value.trim().length > 0;
    const hasAttached = scanAttachedItems.length > 0;
    const needsQuota = hasText; // attached-only submits never call Gemini
    el("scan-analyze-btn").disabled = !(hasText || hasAttached) || (needsQuota && quotaAtCapacity);
    return;
  }
  el("scan-analyze-btn").disabled = !selectedFile || quotaAtCapacity;
}

// The button's label depends on *both* the active scan mode and the current
// language, so — same pattern as auth.js's submit button — it's resynced
// here on every mode change and again on every language change, rather than
// being a static data-i18n element. Describing a meal in text and being told
// to "analyze photo" was a real, reported inaccuracy: the button must name
// whichever action it's actually about to take.
function updateAnalyzeButtonLabel() {
  el("scan-analyze-btn").textContent = scanMode === "describe" ? t("scan.analyzeBtnDescribe") : t("scan.analyzeBtn");
}

function updateQuotaBarVisibility() {
  el("scan-quota-bar").hidden = scanMode === "barcode" || !quotaLoaded;
}

async function refreshScanQuota() {
  try {
    const usage = await api.getScanUsage();
    quotaAtCapacity = usage.at_capacity;
    const fill = el("scan-quota-fill");
    const label = el("scan-quota-label");
    const pct = Math.min((usage.used / usage.limit) * 100, 100);
    fill.style.transform = `scaleX(${pct / 100})`;
    fill.classList.toggle("danger", usage.at_capacity);
    fill.classList.toggle("warning", !usage.at_capacity && pct >= 80);
    label.textContent = usage.at_capacity
      ? t("quota.atCapacity")
      : `${t("quota.scanUsageLabel")}: ${usage.used}/${usage.limit}`;
    quotaLoaded = true;
  } catch {
    // Not worth blocking or erroring the sheet over a usage-display fetch —
    // just hide the bar and leave the AI scan path unrestricted client-side
    // (the backend enforces the real cap regardless of what's shown here).
    quotaAtCapacity = false;
    quotaLoaded = false;
  }
  updateQuotaBarVisibility();
  updateAnalyzeButtonState();
}

// ---------------------------------------------------------------------------
// Barcode camera — native BarcodeDetector only (see gemini_service.py's
// sibling decision for the AI prompt: keep new features off the CSP/CDN
// surface wherever a browser-native API can do the job instead). Where the
// browser doesn't support it, this fails visibly with a clear message
// pointing at the alternatives — never a silent dead end.
// ---------------------------------------------------------------------------
let barcodeStream = null;
let barcodeDetector = null;
let barcodeLoopHandle = null;
let barcodeActive = false;
let barcodeRetryTimeout = null;

// How many consecutive frames the same code has to show up in before it's
// accepted. Without this, detection was firing on literally the first frame
// a code was visible — including a blurry glimpse while the phone was still
// being aimed — which read as "so fast I can't even tell what it scanned."
// A few frames' agreement (well under a second) is enough to filter that out
// without feeling sluggish.
const BARCODE_CONFIRM_FRAMES = 3;
let barcodeCandidate = null;
let barcodeCandidateStreak = 0;

// Tracks whichever video element the currently (or most recently) active
// barcode session is/was bound to — the standalone Barcode tab's
// #barcode-video, or the "attach a product" overlay's #attach-barcode-video.
// Only one of the two is ever active at once (the attach overlay is only
// reachable from photo/describe mode, never while the Barcode tab itself is
// showing), so one shared set of camera state variables is enough for both.
let barcodeVideoElId = "barcode-video";

function stopBarcodeCamera() {
  barcodeActive = false;
  if (barcodeLoopHandle) cancelAnimationFrame(barcodeLoopHandle);
  barcodeLoopHandle = null;
  clearTimeout(barcodeRetryTimeout);
  clearTimeout(attachRetryTimeout);
  barcodeCandidate = null;
  barcodeCandidateStreak = 0;
  if (barcodeStream) {
    barcodeStream.getTracks().forEach((track) => track.stop());
    barcodeStream = null;
  }
  const video = el(barcodeVideoElId);
  if (video) video.srcObject = null;
}

// A quick green "got it" beat on whichever viewport just confirmed a code
// (see .barcode-frame-success in style.css) before the caller tears the
// camera down and moves on — otherwise the frame just vanishes outright with
// no acknowledgment that anything was actually recognized.
function flashBarcodeFrame(videoElId) {
  const frame = el(videoElId)?.closest(".barcode-viewport")?.querySelector(".barcode-frame");
  if (!frame) return;
  frame.classList.add("barcode-frame-success");
  setTimeout(() => frame.classList.remove("barcode-frame-success"), 400);
}

function showElError(elId, message) {
  el(elId).hidden = false;
  el(elId).textContent = message;
}

function showScanError(message) {
  showElError("scan-error", message);
}

// Backend error detail text is English-only (api.js attaches `.status` so
// callers can recognize well-known conditions instead — see its comment).
// The two conditions below are common, everyday outcomes here (the shared
// AI quota runs out under normal use, and a blurry photo/vague description
// is routine), not rare edge cases, so they get this app's own localized
// copy; anything else falls back to the backend's raw (English) message,
// same accepted gap as everywhere else that hits truly unexpected errors.
function scanErrorMessage(err, { describeMode = false } = {}) {
  if (err?.status === 503) return t("quota.atCapacity");
  if (err?.status === 422) return t(describeMode ? "scan.couldNotIdentifyDescription" : "scan.couldNotIdentifyPhoto");
  return err.message || t(describeMode ? "scan.errorGenericDescribe" : "scan.errorGeneric");
}

function barcodeErrorMessage(err) {
  if (err?.status === 404) return t("scan.barcodeNotFound");
  if (err?.status === 503) return t("scan.barcodeServiceUnavailable");
  if (err?.status === 422) return t("scan.barcodeIncompleteData");
  return err.message || t("scan.errorGeneric");
}

// ---------------------------------------------------------------------------
// Voice input — browser-native Web Speech API only, same "native API over
// CDN/backend round trip" preference this file already applies to barcode
// detection above. No CSP change needed: like getUserMedia (already used for
// both cameras in this file), the browser handles the actual speech
// recognition at the OS/browser level, not via a page-initiated fetch/XHR
// this app's connect-src would need to cover.
//
// Two independent mount points share this one recognition engine: describe
// mode's free-text field, and photo mode's optional context field (e.g. "no
// oil, extra sauce") — same convenience, same UX, just a different target
// field/button/hint/length-cap. VOICE_TARGETS holds that per-field config;
// activeVoiceTarget tracks which one (if any) is currently listening, so
// switching scan modes or tapping the other mic button cleanly stops
// whichever was running instead of the two fighting over one text field.
// ---------------------------------------------------------------------------
const VOICE_TARGETS = {
  describe: {
    fieldId: "scan-describe-text",
    micBtnId: "scan-mic-btn",
    hintId: "scan-mic-hint",
    maxLength: 800,
    onUpdate: () => {
      updateDescribeCharCount();
      updateAnalyzeButtonState();
      saveDraft();
    },
    onError: showScanError,
  },
  photo: {
    fieldId: "scan-context",
    micBtnId: "scan-photo-mic-btn",
    hintId: "scan-photo-mic-hint",
    maxLength: 300,
    onUpdate: () => saveDraft(),
    onError: showScanError,
  },
};

let recognition = null;
let isListening = false;
let activeVoiceTarget = null;
let voiceBaseText = "";
// Chrome's cloud speech service quite often reports a spurious "network"
// error on the very first start() right after a fresh mic permission grant —
// same underlying timing quirk as the "not-allowed" case below, just a
// different error code — and a second attempt milliseconds later typically
// succeeds with no user action needed. One silent auto-retry absorbs that;
// if it fails twice in a row back to back it's a real problem worth showing.
// Two flags, not one: micRetryUsed tracks whether this listening session has
// already spent its one retry (so a second "network" error doesn't loop
// forever); micRetryPending is only true for the brief window between
// scheduling that retry and it actually firing, so onend can tell "the
// failed attempt is tearing down, a restart is coming" apart from "this
// session genuinely ended" — without that distinction, the retry's own
// later, real onend would also get suppressed.
let micRetryUsed = false;
let micRetryPending = false;

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function updateDescribeCharCount() {
  el("scan-describe-count").textContent = `${el("scan-describe-text").value.length} / 800`;
}

// Exported generic voice-input engine — the two mount points below
// (describe field, photo context field) were the only two consumers until
// coachChat.js's mic button became a third, so the engine itself takes a
// plain target config object (see VOICE_TARGETS' own shape) rather than
// being hardcoded to this file's own fields. Every consumer shares the same
// module-level `recognition`/`isListening`/`activeVoiceTarget` singleton
// state, which is deliberate: only one SpeechRecognition session should ever
// be live at a time regardless of which sheet/field started it, and this is
// what lets starting a NEW one cleanly stop whichever was already running
// instead of two sessions fighting over the mic.
export function isVoiceInputSupported() {
  return !!getSpeechRecognitionCtor();
}
export function stopVoiceInput() {
  stopVoiceRecognition();
}
// Tap to start, speak, and it auto-stops on a pause in speech (continuous =
// false) — or tap again to stop early. Interim results are shown live so the
// field fills in as the user talks, not just once at the end. New speech is
// appended to whatever was already in the field (not replaced), so a user
// who typed part of it and wants to add more by voice doesn't lose what they
// already wrote. Tapping a DIFFERENT target's mic while one is already
// listening stops the first before starting the new one, so only one
// recognition session (and one text field) is ever active at a time.
export function toggleVoiceInput(target) {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return;
  if (isListening) {
    const wasSameTarget = activeVoiceTarget === target;
    stopVoiceRecognition();
    if (wasSameTarget) return;
  }
  activeVoiceTarget = target;
  voiceBaseText = el(target.fieldId).value.trim();
  micRetryUsed = false;
  startRecognition(Ctor);
}

function stopVoiceRecognition() {
  micRetryUsed = false;
  micRetryPending = false;
  if (isListening && recognition) recognition.stop(); // triggers onend, which does the rest of the cleanup
  isListening = false;
  if (activeVoiceTarget) {
    el(activeVoiceTarget.micBtnId).classList.remove("listening");
    el(activeVoiceTarget.hintId).hidden = true;
  }
  activeVoiceTarget = null;
}

function startRecognition(Ctor) {
  const target = activeVoiceTarget;
  recognition = new Ctor();
  recognition.lang = getLanguage() === "ro" ? "ro-RO" : "en-US";
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onresult = (e) => {
    let transcript = "";
    for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
    const combined = [voiceBaseText, transcript.trim()].filter(Boolean).join(" ");
    el(target.fieldId).value = combined.slice(0, target.maxLength);
    target.onUpdate();
  };
  recognition.onerror = (e) => {
    // "no-speech" (silence timeout) and "aborted" (we called .stop()
    // ourselves) are routine, not failures worth surfacing.
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (e.error === "network" && !micRetryUsed) {
      micRetryUsed = true;
      micRetryPending = true;
      setTimeout(() => {
        micRetryPending = false;
        if (isListening) startRecognition(Ctor);
      }, 400);
      return;
    }
    // Logged for diagnosability (remote debugging a user's device is hard
    // otherwise) — the exact SpeechRecognitionErrorEvent.error code, not
    // just "it failed".
    console.warn("[scan] SpeechRecognition error:", e.error);
    const MIC_ERROR_MESSAGES = {
      // Chrome's very first mic request on a page can fail with this even
      // right after the user taps "Allow" — the permission prompt was still
      // resolving when start() fired. A second tap (permission already
      // granted by then) recovers cleanly, so the message says so instead
      // of implying the permission attempt itself failed.
      "not-allowed": t("scan.micErrorNotAllowed"),
      "service-not-allowed": t("scan.micErrorNotAllowed"),
      "audio-capture": t("scan.micErrorNoMic"),
      network: t("scan.micErrorNetwork"),
    };
    // Routed through the target's own onError, not a hardcoded showScanError
    // — the chat mic target (coachChat.js) has no #scan-error element to
    // write into (that's inside the scan sheet, which isn't even open), so
    // each consumer gets to decide how its own error actually surfaces.
    target.onError(MIC_ERROR_MESSAGES[e.error] || t("scan.micError"));
  };
  recognition.onend = () => {
    // A retry is already scheduled — this "end" is the failed first attempt
    // tearing down, not the user stopping or the session really being over.
    // Leave the listening UI in place; startRecognition() (called shortly by
    // the retry timeout) picks up right where this left off.
    if (micRetryPending) return;
    isListening = false;
    el(target.micBtnId).classList.remove("listening");
    el(target.hintId).hidden = true;
    activeVoiceTarget = null;
  };

  try {
    recognition.start();
    isListening = true;
    el(target.micBtnId).classList.add("listening");
    el(target.hintId).hidden = false;
  } catch {
    /* start() throws if called while already starting/started — nothing to
       recover, onend/onerror handle any real failure */
  }
}

async function startBarcodeCamera(onDetected, videoElId = "barcode-video", errorElId = "scan-error") {
  barcodeVideoElId = videoElId;

  if (!("BarcodeDetector" in window)) {
    showElError(errorElId, t("scan.barcodeUnsupported"));
    return;
  }

  try {
    barcodeDetector = new window.BarcodeDetector({
      formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
    });
  } catch {
    showElError(errorElId, t("scan.barcodeUnsupported"));
    return;
  }

  try {
    barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch {
    showElError(errorElId, t("scan.barcodeCameraError"));
    return;
  }

  const video = el(videoElId);
  video.srcObject = barcodeStream;
  await video.play().catch(() => {});

  barcodeActive = true;
  barcodeCandidate = null;
  barcodeCandidateStreak = 0;
  const loop = async () => {
    if (!barcodeActive) return;
    try {
      const codes = await barcodeDetector.detect(video);
      const code = codes[0]?.rawValue;
      if (code && code === barcodeCandidate) {
        barcodeCandidateStreak++;
      } else {
        barcodeCandidate = code || null;
        barcodeCandidateStreak = code ? 1 : 0;
      }
      if (barcodeCandidateStreak >= BARCODE_CONFIRM_FRAMES) {
        const confirmedCode = barcodeCandidate;
        flashBarcodeFrame(videoElId);
        // A short beat so the success flash is actually visible before the
        // caller (handleBarcodeDetected/handleAttachBarcodeDetected) tears
        // the camera down and swaps to the loading stage.
        setTimeout(() => onDetected(confirmedCode), 220);
        return; // detection loop stops here — the caller decides whether to restart it
      }
    } catch {
      /* a frame not being ready yet is common and transient — keep looping */
    }
    barcodeLoopHandle = requestAnimationFrame(loop);
  };
  loop();
}

// ---------------------------------------------------------------------------
// Photo camera — an in-page live capture, deliberately not a plain
// <input capture> handoff to a separate native camera app: on several
// mobile browsers, returning from that handoff can suspend or fully reload
// the page, silently losing the whole scan sheet's state. Same getUserMedia
// approach as barcode mode above, just without a detection loop — the user
// taps the shutter instead of it firing automatically.
// ---------------------------------------------------------------------------
let photoStream = null;

function stopPhotoCamera() {
  if (photoStream) {
    photoStream.getTracks().forEach((track) => track.stop());
    photoStream = null;
  }
  const video = el("photo-camera-video");
  if (video) video.srcObject = null;
  el("photo-camera-viewport").hidden = true;
  el("photo-source-row").hidden = false;
}

async function startPhotoCamera() {
  try {
    photoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch {
    showScanError(t("scan.barcodeCameraError"));
    return;
  }
  const video = el("photo-camera-video");
  video.srcObject = photoStream;
  await video.play().catch(() => {});
  el("photo-source-row").hidden = true;
  el("photo-camera-viewport").hidden = false;
}

async function capturePhoto() {
  const video = el("photo-camera-video");
  if (!video.videoWidth) return; // not ready yet — ignore a too-early tap
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  stopPhotoCamera();
  if (!blob) {
    showScanError(t("scan.errorGeneric"));
    return;
  }
  // Wrapped in a File (not a bare Blob) so it carries a .name — compressImage()
  // relies on that when it re-encodes an oversized image.
  selectFile(new File([blob], "capture.jpg", { type: "image/jpeg" }));
}

function setScanMode(mode) {
  scanMode = mode;
  document.querySelectorAll(".scan-mode-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
  el("scan-photo-mode").hidden = mode !== "photo";
  el("scan-describe-mode").hidden = mode !== "describe";
  el("scan-barcode-mode").hidden = mode !== "barcode";
  // Shown for photo and describe (both spend the shared AI quota), hidden
  // for barcode (a separate, unlimited lookup); the auto-triggering barcode
  // mode also has no manual "analyze" step.
  el("scan-analyze-btn").hidden = mode === "barcode";
  // The attach-a-barcode add-on only makes sense alongside a photo/description
  // — the Barcode tab itself already IS a standalone barcode lookup.
  el("scan-attach-section").hidden = mode === "barcode";
  el("scan-error").hidden = true;
  stopPhotoCamera();
  stopVoiceRecognition();
  updateQuotaBarVisibility();
  updateAnalyzeButtonLabel();
  updateAnalyzeButtonState();

  if (mode === "barcode") {
    startBarcodeCamera(handleBarcodeDetected);
  } else {
    stopBarcodeCamera();
  }
}

// ---------------------------------------------------------------------------
// Loading stage — three callers (barcode lookup, describe-text analysis,
// photo analysis) share this element, but want different combinations of
// "keep the just-taken photo visible instead of a bare spinner" and "is this
// actually a multi-second AI call worth masking with staged messages + a
// result-shape skeleton, or a fast deterministic lookup that shouldn't
// borrow 'AI is thinking' language it doesn't back up". Only the two real
// Gemini calls (photo scan, describe) ever pass staged: true; the barcode
// lookup (a plain external API call, no AI, no quota) always gets its own
// static fallbackTextKey instead.
// ---------------------------------------------------------------------------
const LOADING_STAGE_MESSAGE_KEYS = ["scan.loadingStageIdentify", "scan.loadingStagePortion", "scan.loadingStageMacros"];
const LOADING_STAGE_INTERVAL_MS = 1400;
let loadingStageTimer = null;

function startLoadingStageCycle() {
  let i = 0;
  el("scan-loading-text").textContent = t(LOADING_STAGE_MESSAGE_KEYS[0]);
  loadingStageTimer = setInterval(() => {
    i = (i + 1) % LOADING_STAGE_MESSAGE_KEYS.length;
    el("scan-loading-text").textContent = t(LOADING_STAGE_MESSAGE_KEYS[i]);
  }, LOADING_STAGE_INTERVAL_MS);
}

function stopLoadingStageCycle() {
  clearInterval(loadingStageTimer);
  loadingStageTimer = null;
}

function showScanLoadingStage({ photoUrl, staged, fallbackTextKey } = {}) {
  el("scan-upload-stage").hidden = true;
  el("scan-loading-stage").hidden = false;
  el("scan-error").hidden = true;

  const photoWrap = el("scan-loading-photo-wrap");
  if (photoUrl) {
    el("scan-loading-photo").src = photoUrl;
    photoWrap.hidden = false;
    el("scan-loading-spinner").hidden = true;
  } else {
    photoWrap.hidden = true;
    el("scan-loading-spinner").hidden = false;
  }

  el("scan-loading-stage").querySelector(".scan-loading-skeleton").hidden = !staged;
  if (staged) {
    startLoadingStageCycle();
  } else {
    stopLoadingStageCycle();
    el("scan-loading-text").textContent = t(fallbackTextKey);
  }
}

function hideScanLoadingStage() {
  stopLoadingStageCycle();
  el("scan-loading-stage").hidden = true;
}

async function handleBarcodeDetected(code) {
  stopBarcodeCamera();
  showScanLoadingStage({ fallbackTextKey: "scan.barcodeLooking" });

  try {
    const result = await api.scanBarcode(code);
    populateResultForm(result, { isBarcode: true });
    hideScanLoadingStage();
    el("scan-result-stage").hidden = false;
  } catch (err) {
    hideScanLoadingStage();
    el("scan-upload-stage").hidden = false;
    showScanError(barcodeErrorMessage(err));
    // A beat before scanning resumes — restarting instantly gave no time to
    // actually read the error or reposition before the camera was already
    // hunting for the next code.
    if (scanMode === "barcode") {
      barcodeRetryTimeout = setTimeout(() => {
        if (scanMode === "barcode") startBarcodeCamera(handleBarcodeDetected);
      }, 1200);
    }
  }
}

// ---------------------------------------------------------------------------
// Attach-a-barcode-product add-on — lets a scanned product's exact,
// pre-verified nutrition data ride alongside a photo/description of the rest
// of the meal (e.g. a homemade sandwich + this specific loaf of bread),
// instead of forcing a choice between "AI-estimate everything" and "log this
// one packaged product". Reuses the same api.scanBarcode() lookup and camera
// loop as the standalone Barcode tab, just with its own video element and a
// weight-confirmation step in between (the backend sums the confirmed,
// weight-scaled macros in deterministically — see routers/scan.py's
// _merge_attached_items/_sum_attached_items — rather than re-estimating a
// component that's already known exactly).
// ---------------------------------------------------------------------------
function attachBarcodeErrorMessage(err) {
  if (err?.status === 404) return t("scan.attachNotFound");
  if (err?.status === 503) return t("scan.attachServiceUnavailable");
  if (err?.status === 422) return t("scan.attachIncompleteData");
  return err.message || t("scan.errorGeneric");
}

function renderAttachedItems() {
  const container = el("scan-attached-items");
  container.innerHTML = scanAttachedItems
    .map(
      (item, idx) => `
      <span class="attached-item-chip">
        ${escapeHtml(item.food_name)}
        <span class="attached-item-chip-macros">${item.weight_g}g · ${item.calories} kcal</span>
        <button type="button" class="attached-item-remove" data-idx="${idx}" aria-label="${t("ingredients.removeAriaLabel")}">&times;</button>
      </span>`
    )
    .join("");
  el("scan-attach-btn").disabled = scanAttachedItems.length >= MAX_ATTACHED_ITEMS;
  updateAnalyzeButtonState();
}

function openAttachCamera() {
  if (scanAttachedItems.length >= MAX_ATTACHED_ITEMS) {
    showToast(t("scan.attachMaxReached"), "error");
    return;
  }
  el("scan-upload-stage").hidden = true;
  el("scan-attach-camera-error").hidden = true;
  el("scan-attach-camera-stage").hidden = false;
  startBarcodeCamera(handleAttachBarcodeDetected, "attach-barcode-video", "scan-attach-camera-error");
}

function closeAttachCamera() {
  stopBarcodeCamera();
  el("scan-attach-camera-stage").hidden = true;
  el("scan-upload-stage").hidden = false;
}

function updateAttachConfirmPreview() {
  const weight = Number(el("scan-attach-confirm-weight").value) || 0;
  const scaled = scaleMacrosByWeight(pendingAttachResult, weight);
  el("scan-attach-confirm-macros").textContent =
    `${Math.round(scaled.calories)} ${t("field.calories")} · ${scaled.protein}g ${t("dashboard.macroAbbrProtein")} · ` +
    `${scaled.carbs}g ${t("dashboard.macroAbbrCarbs")} · ${scaled.fats}g ${t("dashboard.macroAbbrFats")}`;
}

async function handleAttachBarcodeDetected(code) {
  stopBarcodeCamera();
  try {
    const result = await api.scanBarcode(code);
    pendingAttachResult = result;
    el("scan-attach-camera-stage").hidden = true;
    el("scan-attach-confirm-stage").hidden = false;
    el("scan-attach-confirm-name").textContent = result.food_name;
    populateProductHeader("scan-attach-confirm", result);
    el("scan-attach-confirm-weight").value = 100;
    updateAttachConfirmPreview();
  } catch (err) {
    showElError("scan-attach-camera-error", attachBarcodeErrorMessage(err));
    // Same beat-before-resuming pattern as the standalone Barcode tab
    // (handleBarcodeDetected above) — only restart if the overlay is still
    // actually showing (the user might have hit Cancel in the meantime).
    attachRetryTimeout = setTimeout(() => {
      if (!el("scan-attach-camera-stage").hidden) {
        startBarcodeCamera(handleAttachBarcodeDetected, "attach-barcode-video", "scan-attach-camera-error");
      }
    }, 1200);
  }
}

function cancelAttachConfirm() {
  pendingAttachResult = null;
  el("scan-attach-confirm-stage").hidden = true;
  el("scan-upload-stage").hidden = false;
}

function confirmAttachedItem() {
  const weight = Number(el("scan-attach-confirm-weight").value) || 0;
  if (weight <= 0) {
    showToast(t("toast.needsWeight"), "error");
    return;
  }
  const scaled = scaleMacrosByWeight(pendingAttachResult, weight);
  scanAttachedItems.push({
    food_name: pendingAttachResult.food_name,
    weight_g: weight,
    calories: scaled.calories,
    protein: scaled.protein,
    carbs: scaled.carbs,
    fats: scaled.fats,
    fiber: scaled.fiber,
  });
  pendingAttachResult = null;
  el("scan-attach-confirm-stage").hidden = true;
  el("scan-upload-stage").hidden = false;
  renderAttachedItems();
}

// The ingredients editor is the single source of truth for weight/macros in
// the result-review form — see ingredientsList.js. Mounted once; reseeded
// via setIngredients() every time a new scan/describe/barcode result comes
// back (populateResultForm below).
const scanIngredientsEditor = createIngredientsEditor({
  listEl: el("scan-ingredients-list"),
  totalsEl: el("scan-ingredients-totals"),
  addBtnEl: el("scan-ingredients-add-btn"),
});

// Gemini's response only ever carries a free-text caveat (confidence_note) —
// there is no structured/numeric confidence field in its response schema
// (see gemini_service.py) — so High/Medium/Low here is inferred client-side:
// no note at all reads as nothing worth flagging (High); a note containing
// one of these plain-language uncertainty markers reads as Low; any other
// non-empty note (a portion-size caveat, an assumption, etc.) is Medium —
// present, but not necessarily a sign the estimate is shaky.
const LOW_CONFIDENCE_PHRASES = [
  "hard to tell",
  "hard to see",
  "difficult to",
  "couldn't fully",
  "could not fully",
  "partially obscured",
  "low light",
  "blurry",
  "rough estimate",
  "uncertain",
  "not clearly visible",
  "guess",
  "unclear",
];

function estimateConfidence(note) {
  if (!note) return "high";
  const lower = note.toLowerCase();
  return LOW_CONFIDENCE_PHRASES.some((phrase) => lower.includes(phrase)) ? "low" : "medium";
}

// Fills the product-photo/brand header shared by the main result form and
// the attach-a-product confirm card (see #scan-product-header/
// #scan-attach-confirm-header in index.html) — both are the exact same
// three-element shape (wrapper, image, brand text), just under different
// ids, so one function drives either given its id prefix.
function populateProductHeader(idPrefix, result) {
  const wrap = el(`${idPrefix}-header`);
  const img = el(`${idPrefix}-image`);
  const brand = el(`${idPrefix}-brand`);
  if (result.image_url) {
    img.src = result.image_url;
    img.alt = result.food_name || "";
    img.hidden = false;
  } else {
    img.hidden = true;
    img.src = "";
  }
  brand.textContent = result.brand || "";
  brand.hidden = !result.brand;
  wrap.hidden = !(result.image_url || result.brand);
}

// Whether the user has touched anything in the result-review form since the
// AI/barcode result was first populated — see markResultManuallyCorrected
// below. Reset every time populateResultForm seeds a fresh result.
let resultManuallyCorrected = false;

// Once a user has actually edited the name, weight, or any macro, the value
// on screen is no longer "the AI's guess" — it's an exact, user-provided
// number, exactly as trustworthy as a manual entry. Upgrading the badge to
// High (or leaving a barcode result's own "Verified" badge alone — editing a
// barcode result doesn't make it MORE verified than it already was) reflects
// that instead of leaving a stale AI confidence label on a value the AI no
// longer actually produced. Idempotent past the first edit so repeated
// keystrokes don't keep rewriting the same DOM text.
function markResultManuallyCorrected() {
  if (resultManuallyCorrected) return;
  const noteWrap = el("scan-confidence-note-wrap");
  if (noteWrap.classList.contains("ai-note-verified")) return; // barcode result — already as trustworthy as this gets
  resultManuallyCorrected = true;
  const badge = el("scan-confidence-badge");
  badge.textContent = t("scan.confidenceHigh");
  badge.className = "confidence-badge confidence-high badge-updated";
  el("scan-confidence-note").textContent = t("scan.manuallyCorrectedNote");
  el("scan-confidence-note").hidden = false;
  noteWrap.hidden = false;
}

// isBarcode distinguishes a real Open Food Facts label match from an AI
// estimate — the two need different treatment for the confidence badge
// below, since a barcode match isn't a probabilistic guess the way Gemini's
// confidence_note is (see estimateConfidence's own comment).
function populateResultForm(result, { isBarcode = false } = {}) {
  resultManuallyCorrected = false;
  el("scan-result-name").value = result.food_name;
  scanIngredientsEditor.setIngredients(
    result.ingredients?.length ? result.ingredients : [asImplicitIngredient(result)]
  );
  populateProductHeader("scan-product", result);

  const note = result.confidence_note || "";
  el("scan-confidence-note").textContent = note;
  el("scan-confidence-note").hidden = !note;

  const badge = el("scan-confidence-badge");
  if (isBarcode) {
    badge.textContent = t("scan.verifiedBadge");
    badge.className = "confidence-badge confidence-verified";
  } else {
    const confidence = estimateConfidence(note);
    badge.textContent = t(`scan.confidence${confidence[0].toUpperCase()}${confidence.slice(1)}`);
    badge.className = `confidence-badge confidence-${confidence}`;
  }
  el("scan-confidence-note-wrap").classList.toggle("ai-note-verified", isBarcode);
  el("scan-confidence-note-wrap").hidden = false;
}

function resetScanSheet(mode = "photo") {
  selectedFile = null;
  scanTargetDate = null; // see its own comment — every entry point into this sheet starts here, only openScanSheetFresh's explicit `targetDate` sets it forward again
  scanEditContext = null; // same reasoning — only openScanSheetFresh's explicit `editContext` sets it forward again
  el("scan-file-input").value = "";
  el("scan-preview").hidden = true;
  el("scan-preview").src = "";
  el("dropzone").hidden = false;
  el("dropzone-label").textContent = dropzoneHint();
  // No live in-page camera capture worth advertising on a laptop — same
  // reasoning as the dropzone hint above differing by pointer type.
  el("open-photo-camera-btn").hidden = IS_POINTER_FINE;
  el("scan-context").value = "";
  el("scan-error").hidden = true;
  el("scan-save-favorite").checked = false;
  // Hidden entirely while editing (see setScanEditUi below) — this row and
  // this reset both run before setScanEditUi has a chance to run, so it's
  // unconditionally shown here first, then hidden again right after if this
  // sheet is opening into an edit context.
  el("scan-save-favorite-row").hidden = false;
  el("scan-favorite-type").hidden = true;
  resetPillTabs("scan-favorite-type");
  el("scan-describe-text").value = "";
  updateDescribeCharCount();
  stopVoiceRecognition();
  scanAttachedItems = [];
  pendingAttachResult = null;
  renderAttachedItems();
  el("scan-analyze-btn").disabled = true;
  stopLoadingStageCycle();
  el("scan-loading-text").textContent = t("scan.loadingText");
  el("scan-loading-photo-wrap").hidden = true;
  el("scan-loading-photo").src = "";
  el("scan-loading-spinner").hidden = false;
  el("scan-loading-stage").querySelector(".scan-loading-skeleton").hidden = true;
  el("scan-upload-stage").hidden = false;
  el("scan-attach-camera-stage").hidden = true;
  el("scan-attach-confirm-stage").hidden = true;
  el("scan-loading-stage").hidden = true;
  el("scan-result-stage").hidden = true;
  stopBarcodeCamera();
  setScanMode(mode);
  refreshScanQuota();
}

onLanguageChange(() => {
  // Only refresh the hint while the upload stage is actually showing its own
  // placeholder text — resetScanSheet() already recomputes it fresh every
  // time the sheet is (re)opened.
  if (!el("dropzone").hidden) el("dropzone-label").textContent = dropzoneHint();
  updateAnalyzeButtonLabel();
  el("scan-confirm-btn").textContent = t(scanEditContext ? "scan.confirmAppend" : "scan.confirmLog");
});

const MAX_DIMENSION = 1600; // plenty of detail for food recognition; way smaller than a raw phone photo
const JPEG_QUALITY = 0.85;
const SKIP_COMPRESSION_UNDER_BYTES = 1.5 * 1024 * 1024;

// Phone cameras routinely produce 8-20MB photos; shrinking that client-side
// before upload is the single biggest win for "smooth on a phone, especially
// on cellular data" — both for upload time and for how fast Gemini processes
// it. This is a pure optimization, never a requirement: HEIC is skipped
// (canvas-based decode of HEIC isn't reliably supported outside Safari) and
// any failure anywhere in this path just falls back to the original file, so
// scanning can never be *blocked* by a browser that can't do this.
async function compressImage(file) {
  if (file.size <= SKIP_COMPRESSION_UNDER_BYTES || file.type === "image/heic") {
    return file;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) return file; // already small enough dimensionally

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file; // didn't actually help — keep the original

    return new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
  } catch {
    return file;
  } finally {
    bitmap?.close?.();
  }
}

async function selectFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const processedFile = await compressImage(file);
  selectedFile = processedFile;
  const url = URL.createObjectURL(processedFile);
  el("scan-preview").src = url;
  el("scan-preview").hidden = false;
  el("photo-source-row").hidden = true;
  updateAnalyzeButtonState();
  el("scan-error").hidden = true;
}

// ---------------------------------------------------------------------------
// Recent-scans thumbnail cache — a small, near-zero-cost local history of
// past scan photos (see db.js's recentScans store), merged directly into
// Today's Journal cards on the dashboard (see ui.js's renderJournal and this
// module's getScanThumbnailUrl) rather than living in its own separate
// gallery view. Still meaningfully smaller than the already-compressed
// upload itself (compressImage above targets "good enough for Gemini"), but
// this is 100% local IndexedDB storage with no server cost, so there's no
// real reason to squeeze it down to a blurry postage stamp — a sharp,
// detailed thumbnail is worth the extra few KB per entry even at 30+ stored
// locally. Saved at CONFIRM time (the submit handler below), not when the
// analysis result first comes back — a scan the user reviews and then
// cancels/backs out of was never actually logged, so it shouldn't show up in
// a history of what was eaten. Each entry also carries the real backend log
// id (once the optimistic create reconciles — see submitNewLog's return
// value in app.js), which is the join key getScanThumbnailUrl below matches
// a Journal card against; a scan saved before this field existed, or whose
// source log has since aged out of the retention window / been deleted,
// simply never matches anything and that entry's slot in the (capped, self-
// pruning) IndexedDB store just goes unseen rather than needing its own
// cleanup path.
// ---------------------------------------------------------------------------
const THUMB_MAX_DIMENSION = 480;
const THUMB_JPEG_QUALITY = 0.82;

async function makeRecentScanThumbnail(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, THUMB_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", THUMB_JPEG_QUALITY));
  } catch {
    return null; // best-effort — a missing thumbnail never blocks the scan itself
  } finally {
    bitmap?.close?.();
  }
}

// Object URLs from the previous cache refresh, revoked before creating the
// next batch so this can't leak memory across repeated refreshes over a long
// session. `thumbnailsByLogId` is the live, synchronously-readable cache
// getScanThumbnailUrl reads from — populated by refreshThumbnailCache below
// and never touched anywhere else, so there's exactly one place this can get
// out of sync with IndexedDB.
let scanObjectUrls = [];
let thumbnailsByLogId = new Map();
// Called once at app boot (see app.js's loadAll) and again every time a new
// scan is confirmed (saveRecentScanThumbnail below) — cheap (a capped-at-30
// IndexedDB read) and idempotent, so there's no harm calling it opportunis-
// tically rather than trying to track finer-grained invalidation.
export async function refreshThumbnailCache() {
  const scans = await listRecentScans(30);
  scanObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  scanObjectUrls = [];
  const next = new Map();
  // scans is newest-first (see listRecentScans) — skip any logId already
  // seen so a duplicate (there shouldn't normally be one; replaceScanThumbnail
  // above always deletes a log's old thumbnail before adding its new one,
  // but this stays correct even if that were ever violated some other way)
  // resolves to its newest photo, not whichever happened to be iterated
  // last, and this also skips creating an object URL for an entry that
  // would just be immediately overwritten anyway.
  scans.forEach((scan) => {
    if (!scan.logId || next.has(scan.logId)) return;
    const url = URL.createObjectURL(scan.thumbnail);
    scanObjectUrls.push(url);
    next.set(scan.logId, url);
  });
  thumbnailsByLogId = next;
}

// The one lookup Today's Journal cards need — synchronous by design (see
// thumbnailsByLogId's own comment) so ui.js's renderJournal can call this
// directly while building each card's HTML, same as any other plain field
// read off the log object itself. Returns undefined (never null) for "no
// photo," so a template literal's `${getScanThumbnailUrl(id) || ""}`-style
// usage stays simple.
export function getScanThumbnailUrl(logId) {
  return thumbnailsByLogId.get(logId);
}

// Fire-and-forget from the confirm handler below — never awaited there, so a
// slow thumbnail encode or a still-in-flight create-log request can't delay
// closing the sheet/showing the toast, which already happened synchronously
// before this was called. `logPromise` is submitNewLog's own return value —
// it never rejects (submitNewLog handles its own errors internally), it just
// resolves to `undefined` on failure/offline-queue, which the `?.id` below
// already tolerates. `onThumbnailReady` (initScan's own callback, ultimately
// app.js's render()) re-paints the dashboard once the cache actually has
// this scan's photo, so it appears on its Journal card without needing a
// manual refresh — the log itself may already be showing (from the
// optimistic insert), just without a photo yet until this resolves.
function saveRecentScanThumbnail(file, payload, logPromise, onThumbnailReady) {
  if (!file) return; // describe-mode/barcode confirms have no photo to save
  Promise.all([makeRecentScanThumbnail(file), logPromise]).then(([thumbnail, createdLog]) => {
    if (!thumbnail) return;
    addRecentScan({
      thumbnail,
      foodName: payload.food_name,
      calories: payload.calories,
      logId: createdLog?.id || null,
    })
      .then(refreshThumbnailCache)
      .then(() => onThumbnailReady?.());
  });
}

// The edit-flow counterpart to saveRecentScanThumbnail above — called by
// app.js only when a Smart Tools edit (see scanEditContext) captured a
// genuinely NEW photo for an entry that already exists, e.g. re-taking a
// blurry photo rather than appending by voice/text. Deletes whatever
// thumbnail that log already had first, then adds the new one — never just
// adds alongside, which would leave two thumbnails racing for the same
// logId (and, since refreshThumbnailCache reads newest-first, the OLDER one
// would silently win). Voice/text/barcode edits never call this at all —
// see onReturnToEdit's own comment on why that's exactly what preserves the
// original hero photo untouched when no new one was captured.
export async function replaceScanThumbnail(logId, file, foodName, calories, onThumbnailReady) {
  if (!file || !logId) return;
  const thumbnail = await makeRecentScanThumbnail(file);
  if (!thumbnail) return;
  await deleteRecentScanByLogId(logId);
  await addRecentScan({ thumbnail, foodName, calories, logId });
  await refreshThumbnailCache();
  onThumbnailReady?.();
}

// Jumps straight to the result-review stage with an already-known result —
// used by discover.js when a Discover product card is tapped, so a product
// found via search reuses the exact same review/confirm form a barcode scan
// does (both are already-verified nutrition data, `isBarcode: true` styling
// applies equally well to either) instead of building a second, separate
// "confirm this product" UI.
export function openProductResult(result) {
  resetScanSheet();
  openSheet("scan-sheet");
  populateResultForm(result, { isBarcode: true });
  el("scan-upload-stage").hidden = true;
  el("scan-result-stage").hidden = false;
}

export function initScan({ logNewFood, getLoggedToastMessage, onThumbnailsUpdated, onReturnToEdit }) {
  const dropzone = el("dropzone");

  el("scan-save-favorite").addEventListener("change", () => {
    el("scan-favorite-type").hidden = !el("scan-save-favorite").checked;
  });
  wirePillTabs("scan-favorite-type");

  el("scan-mode-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".scan-mode-tab");
    if (!btn || btn.dataset.mode === scanMode) return;
    setScanMode(btn.dataset.mode);
  });

  // The standalone Barcode tab's own quick-exit — same idea as the photo
  // camera's close button, just for this camera view. Switching tabs already
  // stops this camera too (setScanMode), but that means hunting for the
  // right tab; this is a direct way out without leaving the barcode flow
  // conceptually (lands back on Photo, this sheet's default mode).
  el("scan-barcode-close-btn").addEventListener("click", () => setScanMode("photo"));

  el("scan-describe-text").addEventListener("input", () => {
    updateDescribeCharCount();
    updateAnalyzeButtonState();
    saveDraft();
  });
  el("scan-context").addEventListener("input", saveDraft);
  // Feature-detected, not assumed universal (Firefox desktop lacks it) — same
  // hide-on-unsupported pattern this file already uses for BarcodeDetector.
  // Shared across both mount points (describe field + photo context field).
  if (getSpeechRecognitionCtor()) {
    el("scan-mic-btn").hidden = false;
    el("scan-photo-mic-btn").hidden = false;
  }
  el("scan-mic-btn").addEventListener("click", () => toggleVoiceInput(VOICE_TARGETS.describe));
  el("scan-photo-mic-btn").addEventListener("click", () => toggleVoiceInput(VOICE_TARGETS.photo));

  // Attach-a-barcode-product add-on (photo + describe modes) — see the
  // attach* functions above.
  el("scan-attach-btn").addEventListener("click", openAttachCamera);
  el("scan-attach-camera-cancel-btn").addEventListener("click", closeAttachCamera);
  el("scan-attach-confirm-cancel-btn").addEventListener("click", cancelAttachConfirm);
  el("scan-attach-confirm-add-btn").addEventListener("click", confirmAttachedItem);
  el("scan-attach-confirm-weight").addEventListener("input", updateAttachConfirmPreview);
  el("scan-attached-items").addEventListener("click", (e) => {
    const btn = e.target.closest(".attached-item-remove");
    if (!btn) return;
    scanAttachedItems.splice(Number(btn.dataset.idx), 1);
    renderAttachedItems();
  });

  // Neither camera nor voice recognition must ever keep running in the
  // background — stop all three the instant the sheet is dismissed, from
  // any of the ways that can happen. A deliberate dismissal like this is
  // also exactly when the saved draft should go away — the whole point of
  // draft recovery is surviving an accidental app-switch/reload, not
  // outliving an explicit Cancel.
  const stopAllCameras = () => {
    stopBarcodeCamera();
    stopPhotoCamera();
    stopVoiceRecognition();
    clearDraft();
  };
  el("scan-sheet").querySelectorAll("[data-close='scan-sheet']").forEach((btn) => {
    btn.addEventListener("click", stopAllCameras);
  });
  el("scan-sheet").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) stopAllCameras(); // backdrop click
  });

  // Universal safety net for the sheet actually closing, regardless of HOW —
  // on top of the explicit Cancel/backdrop calls above, this also covers
  // ui.js's generic swipe-to-dismiss (initSheetDragToDismiss has no
  // scan-specific hook of its own, it just flips `hidden` on whichever sheet
  // was dragged) and a real submit. Without this, dismissing the sheet by
  // swiping it away left its camera/mic running in the background and its
  // recovery draft still marked "open" — the next reload would then
  // incorrectly reopen a sheet the user had already deliberately closed.
  new MutationObserver(() => {
    if (el("scan-sheet").hidden) stopAllCameras();
  }).observe(el("scan-sheet"), { attributes: true, attributeFilter: ["hidden"] });

  // ---------------------------------------------------------------------------
  // Camera recovery on regaining focus — the other half of the "WhatsApp"
  // fix (see the DRAFT_KEY comment above for the full-reload half). A brief
  // app-switch usually does NOT get the whole page discarded, but mobile
  // browsers commonly stop live camera tracks outright while backgrounded
  // regardless (a privacy/battery behavior at the OS/browser level, nothing
  // this app's code triggers or can prevent): the stream object survives,
  // every track's readyState flips to "ended", and the <video> is left
  // showing a frozen/black last frame with no error and no built-in recovery.
  // Silently restarting whichever camera view is actually on screen when the
  // page becomes visible again is what keeps the sheet "fully intact and
  // visible" instead of stuck showing a dead feed the user has no way to fix
  // short of closing and reopening the whole sheet.
  // ---------------------------------------------------------------------------
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || el("scan-sheet").hidden) return;

    if (!el("photo-camera-viewport").hidden && photoStream?.getTracks().some((tr) => tr.readyState === "ended")) {
      startPhotoCamera();
    }
    if (barcodeActive && barcodeStream?.getTracks().some((tr) => tr.readyState === "ended")) {
      const attaching = barcodeVideoElId === "attach-barcode-video";
      startBarcodeCamera(
        attaching ? handleAttachBarcodeDetected : handleBarcodeDetected,
        barcodeVideoElId,
        attaching ? "scan-attach-camera-error" : "scan-error"
      );
    }
  });

  el("open-photo-camera-btn").addEventListener("click", startPhotoCamera);
  el("photo-camera-close-btn").addEventListener("click", stopPhotoCamera);
  el("photo-capture-btn").addEventListener("click", capturePhoto);

  el("scan-file-input").addEventListener("change", (e) => {
    selectFile(e.target.files[0]);
  });

  // Desktop/laptop drag-and-drop — the scan feature works just as well from a
  // laptop (dragging in a saved photo) as it does from a phone camera.
  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("dropzone-active");
    });
  });
  ["dragleave", "dragend"].forEach((evt) => {
    dropzone.addEventListener(evt, () => dropzone.classList.remove("dropzone-active"));
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dropzone-active");
    selectFile(e.dataTransfer?.files?.[0]);
  });

  el("scan-analyze-btn").addEventListener("click", async () => {
    if (scanMode === "describe") {
      const description = el("scan-describe-text").value.trim();
      // Blank text is fine as long as at least one barcode item is attached
      // (the backend then skips Gemini entirely — a deterministic sum, see
      // routers/scan.py::_sum_attached_items); with neither, there's nothing
      // to analyze.
      if (!description && scanAttachedItems.length === 0) return;
      stopVoiceRecognition();
      showScanLoadingStage({ staged: true });
      try {
        const result = await api.scanDescription(description, scanAttachedItems);
        populateResultForm(result);
        hideScanLoadingStage();
        el("scan-result-stage").hidden = false;
      } catch (err) {
        hideScanLoadingStage();
        el("scan-upload-stage").hidden = false;
        showScanError(scanErrorMessage(err, { describeMode: true }));
      }
      return;
    }

    if (!selectedFile) return;
    showScanLoadingStage({ photoUrl: el("scan-preview").src, staged: true });

    try {
      const result = await api.scanFood(selectedFile, el("scan-context").value.trim(), scanAttachedItems);
      populateResultForm(result);
      hideScanLoadingStage();
      el("scan-result-stage").hidden = false;
    } catch (err) {
      hideScanLoadingStage();
      el("scan-upload-stage").hidden = false;
      showScanError(scanErrorMessage(err));
    }
  });

  // Any real edit to the food name or the ingredients editor (typing a new
  // weight/macro value, adding/removing/duplicating a row) means the values
  // on screen are no longer "the AI's guess" — see markResultManuallyCorrected.
  // One delegated pair of listeners covers the static name field and every
  // dynamically added/removed ingredient row alike.
  el("scan-result-form").addEventListener("input", (e) => {
    if (e.target.closest("#scan-result-name, #scan-ingredients-list")) markResultManuallyCorrected();
  });
  el("scan-result-form").addEventListener("click", (e) => {
    if (e.target.closest("#scan-ingredients-list, #scan-ingredients-add-btn")) markResultManuallyCorrected();
  });

  el("scan-result-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ingredients = scanIngredientsEditor.getIngredients();
    const payload = {
      food_name: el("scan-result-name").value.trim(),
      ...scanIngredientsEditor.getAggregate(),
      ingredients,
      source: "ai",
    };
    // See scanTargetDate's own comment — set only when this sheet was opened
    // from a food-entry modal's Smart Tools row while backdating a past day.
    // submitNewLog (app.js) already falls back to today whenever log_date is
    // omitted, same as the manual-entry form's own backdate handling.
    if (scanTargetDate) payload.log_date = scanTargetDate;
    // Same weight_g > 0 guard as manual entry (app.js) — a user can zero out
    // the only ingredient's weight before confirming a scan result. A toast,
    // not showScanError(): #scan-error lives inside #scan-upload-stage, which
    // is hidden while this result-review stage is showing, so it would never
    // actually be visible here.
    if (payload.weight_g <= 0) {
      showToast(t("toast.needsWeight"), "error");
      return;
    }

    const scannedFile = selectedFile; // resetScanSheet() below clears selectedFile itself

    // Appending to (or re-scanning part of) an entry the user was already
    // editing — see scanEditContext's own module comment. This never
    // creates a new log/saved meal itself: it merges this scan's
    // ingredients into whatever the entry already had and hands the
    // combined list back to the centralized edit modal (onReturnToEdit,
    // app.js) for one last review before the user actually saves — the
    // *same* PATCH/PUT save path an ordinary manual edit already uses,
    // completely unchanged, so this Smart Tools detour only ever changes
    // what's pre-filled in the form, never how saving itself works or what
    // the backend does with it.
    if (scanEditContext) {
      const editContext = scanEditContext;
      const mergedIngredients = [...(editContext.existingIngredients || []), ...ingredients];
      closeSheet("scan-sheet");
      clearDraft();
      resetScanSheet();
      onReturnToEdit(editContext, mergedIngredients, scannedFile);
      return;
    }

    // The values on screen are already fully known (the user can edit them
    // before confirming), exactly like manual entry — so this can be logged
    // optimistically too instead of waiting on a network round trip before
    // the sheet closes and the dashboard updates.
    const favoriteName = el("scan-save-favorite").checked ? payload.food_name : undefined;
    const favoriteType = getActivePillType("scan-favorite-type");
    showToast(getLoggedToastMessage(payload), "success");
    closeSheet("scan-sheet");
    clearDraft();
    resetScanSheet();
    const logPromise = logNewFood(payload, { favoriteName, favoriteType });
    saveRecentScanThumbnail(scannedFile, payload, Promise.resolve(logPromise), onThumbnailsUpdated);
  });
}

// `mode`/`targetDate` are both optional — omitted (the FAB's own "Scan with
// AI" entry point) means "photo mode, draft recovery applies, logs to
// today," exactly as before. A food-entry modal's Smart Tools row (see
// app.js) passes both explicitly: a specific tool the user just tapped, and
// (while backdating a past day) the date that tool's result should log to.
// `editContext` (see its own module-level comment above) is the third way
// this sheet can be opened, alongside a fresh mode/targetDate — a food-entry
// modal's Smart Tools row calls this with all three when the user is
// appending to (or re-scanning part of) an entry they're already editing.
export function openScanSheetFresh(mode = null, targetDate = null, editContext = null) {
  resetScanSheet(mode || "photo");
  scanTargetDate = targetDate;
  scanEditContext = editContext;
  if (editContext) {
    // "Also save as a favorite" doesn't apply here — this scan is being
    // merged into an entry that already exists, not creating anything new
    // to favorite — and the confirm button reads as a continuation of that
    // edit ("Add to entry"), not a fresh "log it" action, so the two stay
    // visually distinct even though this is the exact same sheet either way.
    el("scan-save-favorite-row").hidden = true;
    el("scan-confirm-btn").textContent = t("scan.confirmAppend");
  }
  // An explicit mode means the caller wants that exact tool right now — skip
  // draft recovery, which exists for "the user reopened the FAB's own Scan
  // option" and could otherwise silently override this deliberate choice
  // with a stale in-progress draft left in a different mode.
  if (!mode) restoreDraftIfAny();
  // Must come after restoreDraftIfAny() (which may call setScanMode() and so
  // change `scanMode`) so the persisted mode reflects where the sheet
  // actually ended up, not a stale pre-restore value.
  markSheetOpenForRecovery();
}
