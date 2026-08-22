import { supabaseClient } from "./supabaseClient.js?v=20260822q";
import { getLanguage, onLanguageChange, setLanguage, t } from "./i18n.js?v=20260822q";
import { TURNSTILE_SITE_KEY } from "./config.js?v=20260822q";
import { showToast } from "./ui.js?v=20260822q";
import { api } from "./api.js?v=20260822q";
import { fileToAvatarDataUrl, isImageFile } from "./avatar.js?v=20260822q";

const bootLoader = document.getElementById("boot-loader");
const authScreen = document.getElementById("auth-screen");
const appRoot = document.getElementById("app");

const authTabs = document.getElementById("auth-tabs");
const tabs = document.querySelectorAll(".auth-tab");
const authFlipViewport = document.getElementById("auth-flip-viewport");
const authFlipInner = document.getElementById("auth-flip-inner");
const frontFace = authFlipViewport.querySelector(".auth-face-front");
const backFace = authFlipViewport.querySelector(".auth-face-back");

const loginForm = document.getElementById("login-form");
const loginEmail = document.getElementById("login-email");
const loginPassword = document.getElementById("login-password");
const loginPasswordWrap = document.getElementById("login-password-wrap");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");
const forgotPasswordLink = document.getElementById("forgot-password-link");
const forgotPasswordWrap = document.getElementById("forgot-password-wrap");

const signupForm = document.getElementById("signup-form");
const signupName = document.getElementById("signup-name");
const signupEmail = document.getElementById("signup-email");
const signupPassword = document.getElementById("signup-password");
const signupError = document.getElementById("signup-error");
const signupSubmit = document.getElementById("signup-submit");

const avatarPicker = document.getElementById("avatar-picker");
const avatarPickerInput = document.getElementById("avatar-picker-input");
const avatarPickerImg = document.getElementById("avatar-picker-img");
const avatarPickerPlaceholder = document.getElementById("avatar-picker-placeholder");

const newPasswordForm = document.getElementById("new-password-form");
const newPasswordInput = document.getElementById("new-password-input");
const newPasswordError = document.getElementById("new-password-error");
const newPasswordSubmit = document.getElementById("new-password-submit");

const turnstileContainer = document.getElementById("turnstile-container");
const turnstileWidgetEl = document.getElementById("turnstile-widget");
const googleAuthBtn = document.getElementById("google-auth-btn");

const authLangSwitcher = document.getElementById("auth-lang-switcher");

// Drives the .auth-collapsible/grid-template-rows shrink CSS (style.css) instead
// of the `hidden` attribute — that trick is what lets the height change
// animate instead of snapping. `inert` keeps a collapsed field out of the
// tab order and un-clickable while it's visually gone, without needing a
// second attribute toggled on a delay after the transition ends.
function setCollapsed(target, collapsed) {
  target.classList.toggle("is-collapsed", collapsed);
  target.toggleAttribute("inert", collapsed);
}

let mode = "login"; // "login" | "signup" | "reset" — "reset" is a sub-state of the login face, not a third flip face

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
// after our callback already exists. Now permanently part of the signup
// face's own markup (it used to be a mode-collapsible section of one shared
// form) — the only thing still gated on mode is *when* the script first
// loads, so visiting "Log in" alone never fetches it.
// ---------------------------------------------------------------------------
let turnstileWidgetId = null;
let turnstileReady = false;

function loadTurnstile() {
  if (!TURNSTILE_SITE_KEY || turnstileReady) return;
  turnstileReady = true; // set before the async load starts — never inject the script twice
  turnstileContainer.hidden = false;

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

// The login submit label depends on *both* the current sub-mode (login vs.
// reset) and the current language, so it can't just be a static data-i18n
// element — it's resynced here on every mode change and again on every
// language change. Signup's own submit button stays a plain data-i18n
// element in index.html (its label never changes with mode).
function updateLoginSubmitLabel() {
  loginSubmit.textContent = mode === "reset" ? t("auth.submitReset") : t("auth.submitLogin");
}
onLanguageChange(updateLoginSubmitLabel);
updateLoginSubmitLabel();

// ---------------------------------------------------------------------------
// 3D flip height sync — both faces are `position: absolute` (required so
// they can occupy the same spot for the rotateY flip), so the viewport can't
// size itself from an auto-height child the normal way. A ResizeObserver on
// both faces (rather than only calling this from enterMode()) means the
// height also stays correct through everything that isn't a mode switch: a
// validation error appearing, the reset sub-state collapsing the password
// field, a language change reflowing text, or the viewport itself resizing.
// ---------------------------------------------------------------------------
function syncFlipHeight() {
  const activeFace = mode === "signup" ? backFace : frontFace;
  authFlipViewport.style.height = `${activeFace.scrollHeight}px`;
}
new ResizeObserver(syncFlipHeight).observe(frontFace);
new ResizeObserver(syncFlipHeight).observe(backFace);

function enterMode(newMode) {
  mode = newMode;
  tabs.forEach((tb) => tb.classList.toggle("active", tb.dataset.tab === mode));
  if (mode === "login" || mode === "signup") {
    authTabs.dataset.active = mode;
    authFlipViewport.dataset.active = mode;
    // The face rotated away shouldn't be reachable by keyboard/screen reader
    // — style.css also sets pointer-events: none on it, this covers focus.
    frontFace.toggleAttribute("inert", mode === "signup");
    backFace.toggleAttribute("inert", mode !== "signup");
    if (mode === "signup") loadTurnstile();
    syncFlipHeight();
  }
  loginError.hidden = true;
  signupError.hidden = true;
  // "Forgot password?" only makes sense while looking at the login form, and
  // the password field itself is irrelevant to a reset request (only the
  // email matters there).
  setCollapsed(loginPasswordWrap, mode === "reset");
  loginPassword.required = mode !== "reset";
  setCollapsed(forgotPasswordWrap, mode !== "login");
  updateLoginSubmitLabel();
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => enterMode(tab.dataset.tab));
});

forgotPasswordLink.addEventListener("click", () => enterMode("reset"));

// Google OAuth via Supabase Auth (provider already configured in the
// Supabase dashboard — Client ID/Secret live there, never in this repo).
// signInWithOAuth() does a full top-level browser redirect to Google's
// consent screen by default (no skipBrowserRedirect), so on success this
// function never returns control to us — the page navigates away. Supabase
// appends the resulting session to the redirect-back URL, and the
// supabaseClient (default options: detectSessionInUrl/persistSession both
// true, same as every other auth path here) parses it automatically and
// fires the same onAuthStateChange("SIGNED_IN", session) below that
// email/password login does — so onSignedIn/session storage are identical
// across every auth method, nothing OAuth-specific needed there. redirectTo
// must be on Supabase's Redirect URLs allowlist (Authentication → URL
// Configuration), same requirement as resetPasswordForEmail/signUp above.
googleAuthBtn.addEventListener("click", async () => {
  googleAuthBtn.disabled = true;
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) throw error;
  } catch (err) {
    googleAuthBtn.disabled = false;
    showToast(authErrorMessage(err), "error");
  }
});

// ---------------------------------------------------------------------------
// Language switcher — a single button showing the *current* language's flag;
// tapping it toggles to the other one. Reuses i18n.js's own getLanguage/
// setLanguage directly, the exact same persisted (localStorage) choice
// Settings' own language switcher uses, so this isn't a second, parallel
// language system (same pattern as the pull-string lamp reusing the
// Settings theme switcher's own storage).
// ---------------------------------------------------------------------------
const authLangFlag = document.getElementById("auth-lang-flag");
const LANG_FLAGS = { en: "🇺🇸", ro: "🇷🇴" };

// Elastic pop & fade — two chained Element.animate() calls (Web Animations,
// not CSS keyframes/setTimeout) driving only `transform`/`opacity`, so this
// stays fully on the compositor thread: no layout, no repaint, and no risk
// of the blurry-text class of bug a naive 3D rotateY (without a perspective
// context) caused before. .onfinish is what times the glyph swap — it fires
// exactly when the browser finishes the "out" phase, with zero drift, unlike
// the previous setTimeout(…, 250) guess that could visibly land a frame
// early or late.
//
// flagBusy debounces a rapid second tap instead of trying to gracefully
// interrupt a running animation mid-flight (which would need to read the
// element's current computed transform as the new start point, or it snaps
// back to scale(1) for a frame first — a worse glitch than just ignoring an
// extra tap for ~300ms). The button's own press-scale (style.css's
// :active rule) still responds instantly regardless, so a debounced tap
// never feels unacknowledged.
let flagBusy = false;

function syncAuthLangFlag() {
  if (flagBusy) return;
  authLangFlag.textContent = LANG_FLAGS[getLanguage()] || LANG_FLAGS.en;
}

authLangSwitcher.addEventListener("click", () => {
  if (flagBusy) return;
  const nextLang = getLanguage() === "en" ? "ro" : "en";
  flagBusy = true;
  // Safety net: guarantees the button can never get stuck permanently
  // debounced even if an onfinish event below is delayed or never fires —
  // e.g. the tab getting backgrounded/occluded mid-animation, which throttles
  // rendering in most browsers. 600ms is comfortably longer than the 130ms +
  // 190ms the animation actually takes under normal conditions; the
  // onfinish handler further down clears this the moment it does fire, so
  // this timer is only ever the fallback path, not the common one.
  const unstickFlagBusy = setTimeout(() => {
    flagBusy = false;
  }, 600);
  setLanguage(nextLang);

  const outAnim = authLangFlag.animate(
    [
      { transform: "scale(1)", opacity: 1 },
      { transform: "scale(0.35)", opacity: 0 },
    ],
    { duration: 130, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
  );
  outAnim.onfinish = () => {
    authLangFlag.textContent = LANG_FLAGS[nextLang];
    // Releases the "out" animation's held forwards-fill right before the
    // "in" one starts. Web Animations don't self-remove a filled effect
    // just because a later animation on the same property has also
    // finished — left uncanceled, this stays on the effect stack forever,
    // and once the "in" animation's own (unfilled) effect is later removed,
    // the flag falls back to THIS one's held scale(0.35)/opacity:0 instead
    // of the base resting style, i.e. a permanently invisible flag. Both
    // animate() calls happen synchronously in this same tick, so there's no
    // frame in between where cancelling this reads as a flicker.
    outAnim.cancel();
    const inAnim = authLangFlag.animate(
      [
        { transform: "scale(0.35)", opacity: 0 },
        { transform: "scale(1.1)", opacity: 1, offset: 0.7 },
        { transform: "scale(1)", opacity: 1 },
      ],
      { duration: 190, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    );
    // No fill: "forwards" here — .auth-lang-flag's base CSS already rests at
    // an implicit scale(1)/opacity:1 (no transform override at all), which
    // is exactly this animation's own final frame, so letting the effect
    // clean itself up on finish is already visually seamless and leaves
    // nothing lingering for the next tap to fight.
    inAnim.onfinish = () => {
      clearTimeout(unstickFlagBusy);
      flagBusy = false;
    };
  };
});
onLanguageChange(syncAuthLangFlag);
syncAuthLangFlag();

// Keeps the field being typed into centered above the mobile virtual
// keyboard instead of letting it get squashed against the top/bottom edge —
// .auth-screen already allows itself to scroll (overflow-y: auto) for
// exactly this case.
authScreen.addEventListener("focusin", (e) => {
  if (e.target.matches("input")) {
    e.target.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});

// ---------------------------------------------------------------------------
// Signup avatar picker — purely client-side until the account actually
// exists. Reuses avatar.js's fileToAvatarDataUrl (the same square-crop/
// downscale helper Settings' own avatar uploader uses) so a picked photo is
// stored in the exact format profiles.avatar_url expects; the actual save
// happens once, best-effort, right after a successful sign-up below.
// ---------------------------------------------------------------------------
let pendingAvatarDataUrl = null;

avatarPicker.addEventListener("click", () => avatarPickerInput.click());
avatarPickerInput.addEventListener("change", async () => {
  const file = avatarPickerInput.files?.[0];
  avatarPickerInput.value = ""; // clears the selection so picking the same file again still fires "change"
  if (!file || !isImageFile(file)) return;
  try {
    pendingAvatarDataUrl = await fileToAvatarDataUrl(file);
    avatarPickerImg.src = pendingAvatarDataUrl;
    avatarPickerImg.hidden = false;
    avatarPickerPlaceholder.hidden = true;
  } catch {
    showToast(t("auth.avatarError"), "error");
  }
});

function resetSignupAvatar() {
  pendingAvatarDataUrl = null;
  avatarPickerImg.hidden = true;
  avatarPickerImg.removeAttribute("src");
  avatarPickerPlaceholder.hidden = false;
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  loginSubmit.disabled = true;

  const email = loginEmail.value.trim();

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
      loginError.hidden = false;
      loginError.style.color = "var(--c-protein)";
      loginError.textContent = t("auth.resetLinkSent");
    } catch (err) {
      loginError.hidden = false;
      loginError.style.color = "";
      loginError.textContent = authErrorMessage(err);
    } finally {
      loginSubmit.disabled = false;
    }
    return;
  }

  const password = loginPassword.value;
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // onAuthStateChange (registered in app.js) handles showing the app.
  } catch (err) {
    loginError.hidden = false;
    loginError.style.color = "";
    loginError.textContent = authErrorMessage(err);
  } finally {
    loginSubmit.disabled = false;
  }
});

signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  signupError.hidden = true;
  signupSubmit.disabled = true;

  const fullName = signupName.value.trim();
  const email = signupEmail.value.trim();
  const password = signupPassword.value;

  // Only relevant once a real site key is configured — see loadTurnstile()
  // above. getResponse() returns "" if the widget hasn't been completed yet
  // or doesn't exist; either way Supabase itself is the final authority on
  // whether a captchaToken was actually required.
  const captchaToken =
    TURNSTILE_SITE_KEY && turnstileWidgetId !== null ? window.turnstile?.getResponse(turnstileWidgetId) : undefined;

  try {
    // emailRedirectTo pins the confirmation link to wherever this app is
    // actually running, the same way resetPasswordForEmail's redirectTo
    // does above — without it, Supabase falls back to the project's Site
    // URL, which is what was sending confirmation links to the
    // localhost:3000 placeholder instead of the real deployed app. Still
    // requires this exact URL to be on Supabase's Redirect URLs allowlist
    // (Authentication → URL Configuration) or Supabase ignores it anyway.
    // full_name rides along in Supabase's own user_metadata regardless of
    // whether the best-effort profile save below succeeds — a fallback
    // source of truth for it, not the primary one.
    const { error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        captchaToken,
        emailRedirectTo: window.location.origin + window.location.pathname,
        data: fullName ? { full_name: fullName } : undefined,
      },
    });
    if (error) throw error;

    // If email confirmation is enabled on the Supabase project, there will
    // be no session yet — let the user know instead of silently hanging.
    const { data } = await supabaseClient.auth.getSession();
    if (!data.session) {
      signupError.hidden = false;
      signupError.textContent = t("auth.confirmEmail");
      signupError.style.color = "var(--c-protein)";
      signupSubmit.disabled = false;
      return;
    }

    // Immediate session (email confirmation disabled on this project) — carry
    // the name/avatar just picked into the new profile row, best-effort.
    // getTargets() first: it's what self-heals a not-yet-existent profiles
    // row (see backend/routers/targets.py's GET handler) — PUT alone 404s if
    // the on_auth_user_created trigger hasn't finished running yet. Never
    // blocks sign-in on failure; the user can always set these in Settings.
    try {
      await api.getTargets();
      const profileUpdate = {};
      if (fullName) profileUpdate.display_name = fullName;
      if (pendingAvatarDataUrl) profileUpdate.avatar_url = pendingAvatarDataUrl;
      if (Object.keys(profileUpdate).length > 0) await api.updateTargets(profileUpdate);
    } catch {
      /* best-effort — Settings remains the fallback place to set these */
    }
    // onAuthStateChange (registered in app.js) handles showing the app.
  } catch (err) {
    signupError.hidden = false;
    signupError.style.color = "";
    signupError.textContent = authErrorMessage(err);
  } finally {
    signupSubmit.disabled = false;
    // Turnstile tokens are single-use — reset so a retry (after a wrong
    // password, a duplicate-email error, etc.) gets a fresh one instead of
    // silently resubmitting an already-spent token.
    if (turnstileWidgetId !== null) window.turnstile?.reset(turnstileWidgetId);
  }
});

// ---------------------------------------------------------------------------
// Google profile parity — a fresh email/password signup best-effort saves
// display_name/avatar_url right after account creation (see signupForm's
// submit handler above); a Google sign-in should land in the exact same
// place instead of a blank greeting/initials avatar. Google's OAuth profile
// data lands in session.user.user_metadata (full_name/name, avatar_url/
// picture — Supabase copies these straight from Google's own userinfo
// response) — this fills profiles.display_name/avatar_url from them, but
// ONLY when that field is still genuinely empty, so it's safe to call on
// EVERY Google sign-in (not just the account's first) without ever
// clobbering a name/photo the user later changed in Settings. avatar_url
// is stored as Google's own photo URL, not re-encoded into a data: URI like
// an uploaded photo — see index.html's CSP comment (*.googleusercontent.com)
// for why that's the one exception to this app's usual data:-URI-only rule.
// ---------------------------------------------------------------------------
async function syncGoogleProfileIfNeeded(session) {
  if (session?.user?.app_metadata?.provider !== "google") return;
  const meta = session.user.user_metadata || {};
  const googleName = meta.full_name || meta.name || "";
  const googleAvatar = meta.avatar_url || meta.picture || "";
  if (!googleName && !googleAvatar) return;

  try {
    // GET /targets also self-heals a not-yet-existent profile row (same
    // reason the signup flow above calls it first) — necessary here too
    // since a Google sign-in never calls PUT /targets any other way.
    const targets = await api.getTargets();
    const update = {};
    if (googleName && !targets.display_name) update.display_name = googleName;
    if (googleAvatar && !targets.avatar_url) update.avatar_url = googleAvatar;
    if (Object.keys(update).length === 0) return;
    // PUT /targets isn't a PATCH (backend/models.py's TargetsUpdate requires
    // the full target set), so the rest of the already-stored profile rides
    // along unchanged alongside the two new fields.
    await api.updateTargets({ ...targets, ...update });
  } catch {
    /* best-effort — Settings remains the fallback place to set these */
  }
}

// Tracks the user id `onSignedIn` was last actually delivered for — see the
// SIGNED_IN dedup check inside onAuthStateChange below for why this exists.
let signedInUserId = null;

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

    // supabase-js's GoTrueClient installs its own document visibilitychange
    // listener and, on a backgrounded tab/installed PWA regaining focus,
    // recovers the still-valid session from storage — but rather than
    // emitting TOKEN_REFRESHED (handled above) it re-emits a plain SIGNED_IN
    // for the SAME user, indistinguishable from a real sign-in by event type
    // alone. Left unguarded, that re-ran onSignedIn() (app.js) on every
    // app-switch-and-return, which calls closeAllSheets() and reloads the
    // whole dashboard — the bug where an open bottom sheet (Manual Entry,
    // Scan, etc.) and whatever the user had typed into it vanished simply
    // from switching apps to look something up and coming back. A genuine
    // new sign-in (first sign-in this session, or a different user after a
    // sign-out) still has session.user.id !== signedInUserId and goes
    // through the normal path below untouched.
    if (event === "SIGNED_IN" && session?.user?.id && session.user.id === signedInUserId) return;

    if (event === "PASSWORD_RECOVERY") {
      appRoot.hidden = true;
      authScreen.hidden = false;
      newPasswordForm.hidden = false;
      return;
    }

    if (session) {
      signedInUserId = session.user.id;
      authScreen.hidden = true;
      appRoot.hidden = false;
      newPasswordForm.hidden = true;
      onSignedIn(session);
      // Gated on the real "SIGNED_IN" event specifically (not e.g.
      // INITIAL_SESSION on every reload of an already-logged-in session) —
      // this only ever needs to run right after an actual sign-in action.
      // Fire-and-forget: this is a nice-to-have profile fill, never allowed
      // to delay onSignedIn's own render above.
      if (event === "SIGNED_IN") syncGoogleProfileIfNeeded(session);
    } else {
      signedInUserId = null;
      appRoot.hidden = true;
      authScreen.hidden = false;
      newPasswordForm.hidden = true;
      loginForm.reset();
      signupForm.reset();
      resetSignupAvatar();
      loginError.hidden = true;
      signupError.hidden = true;
      loginSubmit.disabled = false;
      signupSubmit.disabled = false;
      enterMode("login");
      onSignedOut();
    }
  });
}

export async function logOut() {
  await supabaseClient.auth.signOut();
}
