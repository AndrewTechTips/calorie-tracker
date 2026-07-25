import { supabaseClient } from "./supabaseClient.js?v=20260725c";
import { onLanguageChange, t } from "./i18n.js?v=20260725c";
import { TURNSTILE_SITE_KEY } from "./config.js?v=20260725c";

const bootLoader = document.getElementById("boot-loader");
const authScreen = document.getElementById("auth-screen");
const appRoot = document.getElementById("app");
const authForm = document.getElementById("auth-form");
const authError = document.getElementById("auth-error");
const authSubmit = document.getElementById("auth-submit");
const authPassword = document.getElementById("auth-password");
const turnstileContainer = document.getElementById("turnstile-container");
const turnstileWidgetEl = document.getElementById("turnstile-widget");
const tabs = document.querySelectorAll(".auth-tab");

let mode = "login"; // "login" | "signup"

// ---------------------------------------------------------------------------
// Turnstile (optional signup CAPTCHA) — completely inert when
// TURNSTILE_SITE_KEY is blank (the default): no script is ever loaded, no
// network request is made, and the widget container stays hidden/unused.
// Uses explicit rendering (not the simpler data-sitekey auto-render) because
// the site key is only known at runtime from config.js, and explicit mode
// avoids any race between this module and Cloudflare's script over who runs
// first — we control the load order by injecting the script ourselves,
// after our callback already exists.
// ---------------------------------------------------------------------------
let turnstileWidgetId = null;
let turnstileReady = false;

function loadTurnstile() {
  if (!TURNSTILE_SITE_KEY || turnstileReady) return;
  turnstileReady = true; // set before the async load starts — never inject the script twice

  window.onTurnstileLoad = () => {
    turnstileWidgetId = window.turnstile.render(turnstileWidgetEl, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: "dark",
    });
  };

  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit";
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

function updateTurnstileVisibility() {
  if (!TURNSTILE_SITE_KEY) return; // container stays hidden permanently — never touched
  turnstileContainer.hidden = mode !== "signup";
  if (mode === "signup") loadTurnstile();
}
updateTurnstileVisibility();

// The submit button's text depends on *both* the current tab and the current
// language, so it can't just be a static data-i18n element — it's resynced
// here on every tab click and again on every language change.
function updateSubmitLabel() {
  authSubmit.textContent = mode === "login" ? t("auth.submitLogin") : t("auth.submitSignup");
}
onLanguageChange(updateSubmitLabel);
updateSubmitLabel();

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    mode = tab.dataset.tab;
    tabs.forEach((tb) => tb.classList.toggle("active", tb === tab));
    updateSubmitLabel();
    updateTurnstileVisibility();
    authError.hidden = true;
    // Only enforce a stronger minimum on signup. Applying this to login too
    // would lock out any already-registered account whose password is
    // shorter than the new minimum — this field is shared by both modes.
    authPassword.minLength = mode === "signup" ? 8 : 1;
    // "new-password" (vs "current-password") is what makes browsers offer
    // their strong-password generator / not autofill an old saved password.
    authPassword.autocomplete = mode === "signup" ? "new-password" : "current-password";
  });
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.hidden = true;
  authSubmit.disabled = true;

  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;

  // Only relevant on signup, and only once a real site key is configured —
  // see loadTurnstile() above. getResponse() returns "" if the widget hasn't
  // been completed yet or doesn't exist; either way Supabase itself is the
  // final authority on whether a captchaToken was actually required.
  const captchaToken =
    mode === "signup" && TURNSTILE_SITE_KEY && turnstileWidgetId !== null
      ? window.turnstile?.getResponse(turnstileWidgetId)
      : undefined;

  try {
    const { error } =
      mode === "login"
        ? await supabaseClient.auth.signInWithPassword({ email, password })
        : await supabaseClient.auth.signUp({ email, password, options: { captchaToken } });

    if (error) throw error;

    if (mode === "signup") {
      // If email confirmation is enabled on the Supabase project, there will
      // be no session yet — let the user know instead of silently hanging.
      const { data } = await supabaseClient.auth.getSession();
      if (!data.session) {
        authError.hidden = false;
        authError.textContent = t("auth.confirmEmail");
        authError.style.color = "var(--c-protein)";
        authSubmit.disabled = false;
        return;
      }
    }
    // onAuthStateChange (registered in app.js) handles showing the app.
  } catch (err) {
    authError.hidden = false;
    authError.style.color = "";
    authError.textContent = err.message || t("auth.errorGeneric");
  } finally {
    authSubmit.disabled = false;
    // Turnstile tokens are single-use — reset so a retry (after a wrong
    // password, a duplicate-email error, etc.) gets a fresh one instead of
    // silently resubmitting an already-spent token.
    if (turnstileWidgetId !== null) window.turnstile?.reset(turnstileWidgetId);
  }
});

export function initAuth({ onSignedIn, onSignedOut }) {
  supabaseClient.auth.onAuthStateChange((event, session) => {
    bootLoader.hidden = true;

    // Supabase fires this periodically (silent background token renewal) and
    // whenever the tab regains focus. The session is unchanged, so treat it as
    // a no-op instead of re-running onSignedIn — otherwise the whole dashboard
    // (logs, water, saved meals) re-fetches and re-renders under the user while
    // they're mid-interaction, which reads as random flicker/jank.
    if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;

    if (session) {
      authScreen.hidden = true;
      appRoot.hidden = false;
      onSignedIn(session);
    } else {
      appRoot.hidden = true;
      authScreen.hidden = false;
      authForm.reset();
      authError.hidden = true;
      authSubmit.disabled = false;
      onSignedOut();
    }
  });
}

export async function logOut() {
  await supabaseClient.auth.signOut();
}
