// Shared bootstrap for the four standalone legal pages (privacy.html,
// terms.html, disclaimers.html, data-deletion.html) — one small module
// instead of duplicating render + language-toggle wiring four times. Reads
// legalContent.js (the same source the in-app legal sheet uses, see
// app.js::openLegalSheet) so the public pages Google Play requires a URL for
// can never say something different from what's shown natively in the app.
import { getLastUpdated, getLegalDoc, renderLegalSectionsHtml } from "./legalContent.js?v=20260822h";

// Deliberately the SAME localStorage key i18n.js uses for the in-app
// language switcher: picking a language here and later opening the app (or
// vice versa) carries the choice over instead of surprising the user with a
// mismatched default.
const STORAGE_KEY = "ironlog_lang";

function detectDefaultLang() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "ro") return stored;
  return (navigator.language || "").toLowerCase().startsWith("ro") ? "ro" : "en";
}

const UI_STRINGS = {
  en: { updatedPrefix: "Last updated" },
  ro: { updatedPrefix: "Ultima actualizare" },
};

export function initLegalPage(docId) {
  let lang = detectDefaultLang();
  const titleEl = document.getElementById("legal-title");
  const updatedEl = document.getElementById("legal-updated");
  const bodyEl = document.getElementById("legal-body");
  const toggleButtons = document.querySelectorAll("[data-lang-choice]");

  function render() {
    const doc = getLegalDoc(docId, lang);
    document.documentElement.lang = lang;
    document.title = `${doc.title} — Iron Log`;
    titleEl.textContent = doc.title;
    const updatedDate = new Date(`${getLastUpdated()}T00:00:00`).toLocaleDateString(lang === "ro" ? "ro-RO" : "en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    updatedEl.textContent = `${UI_STRINGS[lang].updatedPrefix} ${updatedDate}`;
    bodyEl.innerHTML = renderLegalSectionsHtml(doc.sections);
    toggleButtons.forEach((btn) => btn.setAttribute("aria-pressed", String(btn.dataset.langChoice === lang)));
  }

  toggleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      lang = btn.dataset.langChoice;
      localStorage.setItem(STORAGE_KEY, lang);
      render();
    });
  });

  render();
}
