import { supabaseClient } from "./supabaseClient.js";

const authScreen = document.getElementById("auth-screen");
const appRoot = document.getElementById("app");
const authForm = document.getElementById("auth-form");
const authError = document.getElementById("auth-error");
const authSubmit = document.getElementById("auth-submit");
const tabs = document.querySelectorAll(".auth-tab");

let mode = "login"; // "login" | "signup"

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    mode = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    authSubmit.textContent = mode === "login" ? "Log in" : "Create account";
    authError.hidden = true;
  });
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.hidden = true;
  authSubmit.disabled = true;

  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;

  try {
    const { error } =
      mode === "login"
        ? await supabaseClient.auth.signInWithPassword({ email, password })
        : await supabaseClient.auth.signUp({ email, password });

    if (error) throw error;

    if (mode === "signup") {
      // If email confirmation is enabled on the Supabase project, there will
      // be no session yet — let the user know instead of silently hanging.
      const { data } = await supabaseClient.auth.getSession();
      if (!data.session) {
        authError.hidden = false;
        authError.textContent = "Account created — check your email to confirm, then log in.";
        authError.style.color = "var(--c-protein)";
        authSubmit.disabled = false;
        return;
      }
    }
    // onAuthStateChange (registered in app.js) handles showing the app.
  } catch (err) {
    authError.hidden = false;
    authError.style.color = "";
    authError.textContent = err.message || "Something went wrong, try again.";
  } finally {
    authSubmit.disabled = false;
  }
});

export function initAuth({ onSignedIn, onSignedOut }) {
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (session) {
      authScreen.hidden = true;
      appRoot.hidden = false;
      onSignedIn(session);
    } else {
      appRoot.hidden = true;
      authScreen.hidden = false;
      onSignedOut();
    }
  });
}

export async function logOut() {
  await supabaseClient.auth.signOut();
}
