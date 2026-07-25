import { api } from "./api.js?v=20260725g";
import { closeSheet, showToast } from "./ui.js?v=20260725g";
import { onLanguageChange, t } from "./i18n.js?v=20260725g";

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
let scanMode = "photo"; // "photo" | "barcode"
let quotaAtCapacity = false;

// The shared daily Gemini quota only gates the AI photo path — barcode
// lookups (services/barcode.py on the backend) are a separate, unlimited
// external API and are never affected by this.
function updateAnalyzeButtonState() {
  el("scan-analyze-btn").disabled = !selectedFile || quotaAtCapacity;
}

async function refreshScanQuota() {
  const bar = el("scan-quota-bar");
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
    bar.hidden = false;
  } catch {
    // Not worth blocking or erroring the sheet over a usage-display fetch —
    // just hide the bar and leave the AI scan path unrestricted client-side
    // (the backend enforces the real cap regardless of what's shown here).
    quotaAtCapacity = false;
    bar.hidden = true;
  }
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

function stopBarcodeCamera() {
  barcodeActive = false;
  if (barcodeLoopHandle) cancelAnimationFrame(barcodeLoopHandle);
  barcodeLoopHandle = null;
  if (barcodeStream) {
    barcodeStream.getTracks().forEach((track) => track.stop());
    barcodeStream = null;
  }
  const video = el("barcode-video");
  if (video) video.srcObject = null;
}

function showScanError(message) {
  el("scan-error").hidden = false;
  el("scan-error").textContent = message;
}

async function startBarcodeCamera(onDetected) {
  if (!("BarcodeDetector" in window)) {
    showScanError(t("scan.barcodeUnsupported"));
    return;
  }

  try {
    barcodeDetector = new window.BarcodeDetector({
      formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
    });
  } catch {
    showScanError(t("scan.barcodeUnsupported"));
    return;
  }

  try {
    barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch {
    showScanError(t("scan.barcodeCameraError"));
    return;
  }

  const video = el("barcode-video");
  video.srcObject = barcodeStream;
  await video.play().catch(() => {});

  barcodeActive = true;
  const loop = async () => {
    if (!barcodeActive) return;
    try {
      const codes = await barcodeDetector.detect(video);
      if (codes.length > 0) {
        onDetected(codes[0].rawValue);
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
  el("scan-barcode-mode").hidden = mode !== "barcode";
  el("scan-analyze-btn").hidden = mode !== "photo";
  el("scan-error").hidden = true;
  stopPhotoCamera();

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
    showScanError(err.message || t("scan.errorGeneric"));
    if (scanMode === "barcode") startBarcodeCamera(handleBarcodeDetected); // let them try another item
  }
}

function populateResultForm(result) {
  el("scan-result-name").value = result.food_name;
  el("scan-result-weight").value = Math.round(result.weight_g);
  el("scan-result-calories").value = Math.round(result.calories);
  el("scan-result-protein").value = result.protein;
  el("scan-result-carbs").value = result.carbs;
  el("scan-result-fats").value = result.fats;
  const note = result.confidence_note || "";
  el("scan-confidence-note").textContent = note;
  el("scan-confidence-note-wrap").hidden = !note;
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
  el("scan-analyze-btn").disabled = true;
  el("scan-loading-text").textContent = t("scan.loadingText");
  el("scan-upload-stage").hidden = false;
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

export function initScan({ logNewFood }) {
  const dropzone = el("dropzone");

  el("scan-mode-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".scan-mode-tab");
    if (!btn || btn.dataset.mode === scanMode) return;
    setScanMode(btn.dataset.mode);
  });

  // Neither camera must ever keep running in the background — stop both the
  // instant the sheet is dismissed, from any of the ways that can happen.
  const stopAllCameras = () => {
    stopBarcodeCamera();
    stopPhotoCamera();
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
    if (!selectedFile) return;
    el("scan-upload-stage").hidden = true;
    el("scan-loading-stage").hidden = false;
    el("scan-loading-text").textContent = t("scan.loadingText");
    el("scan-error").hidden = true;

    try {
      const result = await api.scanFood(selectedFile, el("scan-context").value.trim());
      populateResultForm(result);
      el("scan-loading-stage").hidden = true;
      el("scan-result-stage").hidden = false;
    } catch (err) {
      el("scan-loading-stage").hidden = true;
      el("scan-upload-stage").hidden = false;
      showScanError(err.message || t("scan.errorGeneric"));
    }
  });

  el("scan-result-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      food_name: el("scan-result-name").value.trim(),
      weight_g: Number(el("scan-result-weight").value),
      calories: Number(el("scan-result-calories").value),
      protein: Number(el("scan-result-protein").value),
      carbs: Number(el("scan-result-carbs").value),
      fats: Number(el("scan-result-fats").value),
      source: "ai",
    };

    // The values on screen are already fully known (the user can edit them
    // before confirming), exactly like manual entry — so this can be logged
    // optimistically too instead of waiting on a network round trip before
    // the sheet closes and the dashboard updates.
    const favoriteName = el("scan-save-favorite").checked ? payload.food_name : undefined;
    showToast(t("toast.loggedSuccess"), "success");
    closeSheet("scan-sheet");
    resetScanSheet();
    logNewFood(payload, { favoriteName });
  });
}

export function openScanSheetFresh() {
  resetScanSheet();
}
