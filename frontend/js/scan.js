import { api } from "./api.js?v=20260803m";
import { closeSheet, escapeHtml, getActivePillType, resetPillTabs, showToast, wirePillTabs } from "./ui.js?v=20260803m";
import { getLanguage, onLanguageChange, t } from "./i18n.js?v=20260803m";
import { asImplicitIngredient, createIngredientsEditor } from "./ingredientsList.js?v=20260803m";
import { scaleMacrosByWeight } from "./nutritionMath.js?v=20260803m";

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
    fill.style.width = `${pct}%`;
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
    },
  },
  photo: {
    fieldId: "scan-context",
    micBtnId: "scan-photo-mic-btn",
    hintId: "scan-photo-mic-hint",
    maxLength: 300,
    onUpdate: () => {},
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
    showScanError(MIC_ERROR_MESSAGES[e.error] || t("scan.micError"));
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

// Tap to start, speak, and it auto-stops on a pause in speech (continuous =
// false) — or tap again to stop early. Interim results are shown live so the
// field fills in as the user talks, not just once at the end. New speech is
// appended to whatever was already in the field (not replaced), so a user
// who typed part of it and wants to add more by voice doesn't lose what they
// already wrote. targetKey selects which VOICE_TARGETS entry (describe/photo)
// this tap is for — tapping the OTHER field's mic while one is already
// listening stops the first before starting the new one, so only one
// recognition session (and one text field) is ever active at a time.
function toggleVoiceRecognition(targetKey) {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return;
  const target = VOICE_TARGETS[targetKey];
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
        onDetected(barcodeCandidate);
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

async function handleBarcodeDetected(code) {
  stopBarcodeCamera();
  el("scan-upload-stage").hidden = true;
  el("scan-loading-stage").hidden = false;
  el("scan-loading-text").textContent = t("scan.barcodeLooking");

  try {
    const result = await api.scanBarcode(code);
    populateResultForm(result);
    el("scan-loading-stage").hidden = true;
    el("scan-result-stage").hidden = false;
  } catch (err) {
    el("scan-loading-stage").hidden = true;
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

function populateResultForm(result) {
  el("scan-result-name").value = result.food_name;
  scanIngredientsEditor.setIngredients(
    result.ingredients?.length ? result.ingredients : [asImplicitIngredient(result)]
  );
  const note = result.confidence_note || "";
  el("scan-confidence-note").textContent = note;
  el("scan-confidence-note").hidden = !note;

  const confidence = estimateConfidence(note);
  const badge = el("scan-confidence-badge");
  badge.textContent = t(`scan.confidence${confidence[0].toUpperCase()}${confidence.slice(1)}`);
  badge.className = `confidence-badge confidence-${confidence}`;
  el("scan-confidence-note-wrap").hidden = false;
}

function resetScanSheet() {
  selectedFile = null;
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
  el("scan-favorite-type").hidden = true;
  resetPillTabs("scan-favorite-type");
  el("scan-describe-text").value = "";
  updateDescribeCharCount();
  stopVoiceRecognition();
  scanAttachedItems = [];
  pendingAttachResult = null;
  renderAttachedItems();
  el("scan-analyze-btn").disabled = true;
  el("scan-loading-text").textContent = t("scan.loadingText");
  el("scan-upload-stage").hidden = false;
  el("scan-attach-camera-stage").hidden = true;
  el("scan-attach-confirm-stage").hidden = true;
  el("scan-loading-stage").hidden = true;
  el("scan-result-stage").hidden = true;
  stopBarcodeCamera();
  setScanMode("photo");
  refreshScanQuota();
}

onLanguageChange(() => {
  // Only refresh the hint while the upload stage is actually showing its own
  // placeholder text — resetScanSheet() already recomputes it fresh every
  // time the sheet is (re)opened.
  if (!el("dropzone").hidden) el("dropzone-label").textContent = dropzoneHint();
  updateAnalyzeButtonLabel();
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

export function initScan({ logNewFood, getLoggedToastMessage }) {
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

  el("scan-describe-text").addEventListener("input", () => {
    updateDescribeCharCount();
    updateAnalyzeButtonState();
  });
  // Feature-detected, not assumed universal (Firefox desktop lacks it) — same
  // hide-on-unsupported pattern this file already uses for BarcodeDetector.
  // Shared across both mount points (describe field + photo context field).
  if (getSpeechRecognitionCtor()) {
    el("scan-mic-btn").hidden = false;
    el("scan-photo-mic-btn").hidden = false;
  }
  el("scan-mic-btn").addEventListener("click", () => toggleVoiceRecognition("describe"));
  el("scan-photo-mic-btn").addEventListener("click", () => toggleVoiceRecognition("photo"));

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
  // any of the ways that can happen.
  const stopAllCameras = () => {
    stopBarcodeCamera();
    stopPhotoCamera();
    stopVoiceRecognition();
  };
  el("scan-sheet").querySelectorAll("[data-close='scan-sheet']").forEach((btn) => {
    btn.addEventListener("click", stopAllCameras);
  });
  el("scan-sheet").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) stopAllCameras(); // backdrop click
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
      el("scan-upload-stage").hidden = true;
      el("scan-loading-stage").hidden = false;
      el("scan-loading-text").textContent = t("scan.loadingTextDescribe");
      el("scan-error").hidden = true;
      try {
        const result = await api.scanDescription(description, scanAttachedItems);
        populateResultForm(result);
        el("scan-loading-stage").hidden = true;
        el("scan-result-stage").hidden = false;
      } catch (err) {
        el("scan-loading-stage").hidden = true;
        el("scan-upload-stage").hidden = false;
        showScanError(scanErrorMessage(err, { describeMode: true }));
      }
      return;
    }

    if (!selectedFile) return;
    el("scan-upload-stage").hidden = true;
    el("scan-loading-stage").hidden = false;
    el("scan-loading-text").textContent = t("scan.loadingText");
    el("scan-error").hidden = true;

    try {
      const result = await api.scanFood(selectedFile, el("scan-context").value.trim(), scanAttachedItems);
      populateResultForm(result);
      el("scan-loading-stage").hidden = true;
      el("scan-result-stage").hidden = false;
    } catch (err) {
      el("scan-loading-stage").hidden = true;
      el("scan-upload-stage").hidden = false;
      showScanError(scanErrorMessage(err));
    }
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
    // Same weight_g > 0 guard as manual entry (app.js) — a user can zero out
    // the only ingredient's weight before confirming a scan result. A toast,
    // not showScanError(): #scan-error lives inside #scan-upload-stage, which
    // is hidden while this result-review stage is showing, so it would never
    // actually be visible here.
    if (payload.weight_g <= 0) {
      showToast(t("toast.needsWeight"), "error");
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
    resetScanSheet();
    logNewFood(payload, { favoriteName, favoriteType });
  });
}

export function openScanSheetFresh() {
  resetScanSheet();
}
