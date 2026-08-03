import { supabaseClient } from "./supabaseClient.js?v=20260803k";
import { onLanguageChange, t } from "./i18n.js?v=20260803k";
import { TURNSTILE_SITE_KEY } from "./config.js?v=20260803k";

const bootLoader = document.getElementById("boot-loader");
const authScreen = document.getElementById("auth-screen");
const appRoot = document.getElementById("app");
const authForm = document.getElementById("auth-form");
const authError = document.getElementById("auth-error");
const authSubmit = document.getElementById("auth-submit");
const authPassword = document.getElementById("auth-password");
const passwordFieldWrap = document.getElementById("password-field-wrap");
const forgotPasswordLink = document.getElementById("forgot-password-link");
const newPasswordForm = document.getElementById("new-password-form");
const newPasswordInput = document.getElementById("new-password-input");
const newPasswordError = document.getElementById("new-password-error");
const newPasswordSubmit = document.getElementById("new-password-submit");
const turnstileContainer = document.getElementById("turnstile-container");
const turnstileWidgetEl = document.getElementById("turnstile-widget");
const tabs = document.querySelectorAll(".auth-tab");

let mode = "login"; // "login" | "signup" | "reset"

// Supabase's AuthError.message is always English (it comes straight from
// GoTrue, not this app's own i18n) — showing it as-is would put raw English
// text in the middle of an otherwise fully Romanian login/signup screen.
// AuthError.code (a stable machine-readable string, not the human message)
// is what supabase-js has actually promised not to change across versions,
// so that's what gets mapped to this app's own localized copy here; anything
// not in this map — genuinely unexpected errors — falls back to the generic
// localized message rather than ever surfacing the raw English one.
const AUTH_ERROR_KEYS = {
  invalid_credentials: "auth.errorInvalidCredentials",
  email_not_confirmed: "auth.errorEmailNotConfirmed",
  user_already_exists: "auth.errorUserExists",
  weak_password: "auth.errorWeakPassword",
  same_password: "auth.errorSamePassword",
  over_email_send_rate_limit: "auth.errorRateLimited",
  over_request_rate_limit: "auth.errorRateLimited",
  captcha_failed: "auth.captchaFailed",
};

function authErrorMessage(err) {
  const key = AUTH_ERROR_KEYS[err?.code];
  return key ? t(key) : t("auth.errorGeneric");
}

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

// The submit button's text depends on *both* the current tab/mode and the
// current language, so it can't just be a static data-i18n element — it's
// resynced here on every mode change and again on every language change.
function updateSubmitLabel() {
  authSubmit.textContent =
    mode === "login" ? t("auth.submitLogin") : mode === "signup" ? t("auth.submitSignup") : t("auth.submitReset");
}
onLanguageChange(updateSubmitLabel);
updateSubmitLabel();

function enterMode(newMode) {
  mode = newMode;
  tabs.forEach((tb) => tb.classList.toggle("active", tb.dataset.tab === mode));
  updateSubmitLabel();
  updateTurnstileVisibility();
  authError.hidden = true;
  // "Forgot password?" only makes sense while looking at the login form, and
  // the password field itself is irrelevant to a reset request (only the
  // email matters there).
  passwordFieldWrap.hidden = mode === "reset";
  authPassword.required = mode !== "reset";
  forgotPasswordLink.hidden = mode !== "login";
  // Only enforce a stronger minimum on signup. Applying this to login too
  // would lock out any already-registered account whose password is
  // shorter than the new minimum — this field is shared by both modes.
  authPassword.minLength = mode === "signup" ? 8 : 1;
  // "new-password" (vs "current-password") is what makes browsers offer
  // their strong-password generator / not autofill an old saved password.
  authPassword.autocomplete = mode === "signup" ? "new-password" : "current-password";
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => enterMode(tab.dataset.tab));
});

forgotPasswordLink.addEventListener("click", () => enterMode("reset"));

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.hidden = true;
  authSubmit.disabled = true;

  const email = document.getElementById("auth-email").value.trim();

  if (mode === "reset") {
    try {
      // redirectTo must be on Supabase's allowed redirect list (Authentication
      // → URL Configuration) or the reset link will fail — see CLAUDE.md.
      // Supabase deliberately returns success here whether or not the email
      // is actually registered, so the copy (auth.resetLinkSent) never
      // confirms/denies an account's existence either — don't tighten this
      // into a specific "email sent" vs "not found" message.
      const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
      });
      if (error) throw error;
      authError.hidden = false;
      authError.style.color = "var(--c-protein)";
      authError.textContent = t("auth.resetLinkSent");
    } catch (err) {
      authError.hidden = false;
      authError.style.color = "";
      authError.textContent = authErrorMessage(err);
    } finally {
      authSubmit.disabled = false;
    }
    return;
  }

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
    // emailRedirectTo pins the confirmation link to wherever this app is
    // actually running, the same way resetPasswordForEmail's redirectTo
    // does below — without it, Supabase falls back to the project's Site
    // URL, which is what was sending confirmation links to the
    // localhost:3000 placeholder instead of the real deployed app. Still
    // requires this exact URL to be on Supabase's Redirect URLs allowlist
    // (Authentication → URL Configuration) or Supabase ignores it anyway.
    const { error } =
      mode === "login"
        ? await supabaseClient.auth.signInWithPassword({ email, password })
        : await supabaseClient.auth.signUp({
            email,
            password,
            options: { captchaToken, emailRedirectTo: window.location.origin + window.location.pathname },
          });

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
    authError.textContent = authErrorMessage(err);
  } finally {
    authSubmit.disabled = false;
    // Turnstile tokens are single-use — reset so a retry (after a wrong
    // password, a duplicate-email error, etc.) gets a fresh one instead of
    // silently resubmitting an already-spent token.
    if (turnstileWidgetId !== null) window.turnstile?.reset(turnstileWidgetId);
  }
});

export function initAuth({ onSignedIn, onSignedOut }) {
  // Landing back here from a password-reset email link: Supabase has already
  // exchanged the link's token for a real (recovery-scoped) session by the
  // time this fires, but that session is only good for setting a new
  // password — show that form instead of dropping them straight into the
  // dashboard on their old password.
  newPasswordForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    newPasswordError.hidden = true;
    newPasswordSubmit.disabled = true;
    try {
      const { error } = await supabaseClient.auth.updateUser({ password: newPasswordInput.value });
      if (error) throw error;
      newPasswordForm.reset();
      newPasswordForm.hidden = true;
      authScreen.hidden = true;
      appRoot.hidden = false;
      onSignedIn();
    } catch (err) {
      newPasswordError.hidden = false;
      newPasswordError.textContent = authErrorMessage(err);
    } finally {
      newPasswordSubmit.disabled = false;
    }
  });

  supabaseClient.auth.onAuthStateChange((event, session) => {
    bootLoader.hidden = true;

    // Supabase fires this periodically (silent background token renewal) and
    // whenever the tab regains focus. The session is unchanged, so treat it as
    // a no-op instead of re-running onSignedIn — otherwise the whole dashboard
    // (logs, water, saved meals) re-fetches and re-renders under the user while
    // they're mid-interaction, which reads as random flicker/jank.
    if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;

    if (event === "PASSWORD_RECOVERY") {
      appRoot.hidden = true;
      authScreen.hidden = false;
      authForm.hidden = true;
      newPasswordForm.hidden = false;
      return;
    }

    if (session) {
      authScreen.hidden = true;
      appRoot.hidden = false;
      authForm.hidden = false;
      newPasswordForm.hidden = true;
      onSignedIn(session);
    } else {
      appRoot.hidden = true;
      authScreen.hidden = false;
      authForm.hidden = false;
      newPasswordForm.hidden = true;
      authForm.reset();
      authError.hidden = true;
      authSubmit.disabled = false;
      enterMode("login");
      onSignedOut();
    }
  });
}

export async function logOut() {
  await supabaseClient.auth.signOut();
}
