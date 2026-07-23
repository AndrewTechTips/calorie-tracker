import { api } from "./api.js?v=20260723c";
import { closeSheet, showToast } from "./ui.js?v=20260723c";

const el = (id) => document.getElementById(id);

// On mobile, "tap to take a photo" is the natural affordance; on a laptop
// there's no camera capture flow worth advertising, and dragging a saved
// image in is the natural one instead — so the two hint different actions.
const IS_POINTER_FINE = window.matchMedia("(pointer: fine)").matches;
const DROPZONE_HINT = IS_POINTER_FINE ? "Click to upload, or drag & drop a photo" : "Tap to take or choose a photo";

let selectedFile = null;

function resetScanSheet() {
  selectedFile = null;
  el("scan-file-input").value = "";
  el("scan-preview").hidden = true;
  el("scan-preview").src = "";
  el("dropzone").hidden = false;
  el("dropzone-label").textContent = DROPZONE_HINT;
  el("scan-context").value = "";
  el("scan-error").hidden = true;
  el("scan-analyze-btn").disabled = true;
  el("scan-upload-stage").hidden = false;
  el("scan-loading-stage").hidden = true;
  el("scan-result-stage").hidden = true;
}

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
  el("dropzone").hidden = true;
  el("scan-analyze-btn").disabled = false;
  el("scan-error").hidden = true;
}

export function initScan({ logNewFood }) {
  const dropzone = el("dropzone");

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
    el("scan-error").hidden = true;

    try {
      const result = await api.scanFood(selectedFile, el("scan-context").value.trim());
      el("scan-result-name").value = result.food_name;
      el("scan-result-weight").value = Math.round(result.weight_g);
      el("scan-result-calories").value = Math.round(result.calories);
      el("scan-result-protein").value = result.protein;
      el("scan-result-carbs").value = result.carbs;
      el("scan-result-fats").value = result.fats;
      el("scan-confidence-note").textContent = result.confidence_note || "";
      el("scan-loading-stage").hidden = true;
      el("scan-result-stage").hidden = false;
    } catch (err) {
      el("scan-loading-stage").hidden = true;
      el("scan-upload-stage").hidden = false;
      el("scan-error").hidden = false;
      el("scan-error").textContent = err.message || "Could not analyze that photo. Try again.";
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
    showToast("Logged!", "success");
    closeSheet("scan-sheet");
    resetScanSheet();
    logNewFood(payload, { favoriteName });
  });
}

export function openScanSheetFresh() {
  resetScanSheet();
}
