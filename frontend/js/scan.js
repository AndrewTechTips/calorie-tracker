import { api } from "./api.js";
import { closeSheet, showToast } from "./ui.js";

const el = (id) => document.getElementById(id);

let selectedFile = null;

function resetScanSheet() {
  selectedFile = null;
  el("scan-file-input").value = "";
  el("scan-preview").hidden = true;
  el("scan-preview").src = "";
  el("dropzone").hidden = false;
  el("dropzone-label").textContent = "Tap to take or choose a photo";
  el("scan-context").value = "";
  el("scan-error").hidden = true;
  el("scan-analyze-btn").disabled = true;
  el("scan-upload-stage").hidden = false;
  el("scan-loading-stage").hidden = true;
  el("scan-result-stage").hidden = true;
}

export function initScan({ onLogged }) {
  el("scan-file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    selectedFile = file;
    const url = URL.createObjectURL(file);
    el("scan-preview").src = url;
    el("scan-preview").hidden = false;
    el("dropzone").hidden = true;
    el("scan-analyze-btn").disabled = false;
    el("scan-error").hidden = true;
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

    try {
      await api.createLog(payload);
      if (el("scan-save-favorite").checked) {
        await api.saveMeal({
          name: payload.food_name,
          weight_g: payload.weight_g,
          calories: payload.calories,
          protein: payload.protein,
          carbs: payload.carbs,
          fats: payload.fats,
        });
      }
      showToast("Logged!", "success");
      closeSheet("scan-sheet");
      resetScanSheet();
      onLogged();
    } catch (err) {
      showToast(err.message || "Could not save that entry", "error");
    }
  });
}

export function openScanSheetFresh() {
  resetScanSheet();
}
