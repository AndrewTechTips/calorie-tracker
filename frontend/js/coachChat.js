// The AI Coach sheet, in full — an "Immersive Overlay" virtual-pet
// experience, not a chat list. Owns the header avatar button, the status
// banner shortcut, Ollie's one-line speech bubble, the horizontally-
// scrollable suggestion chips, and the floating free-text input, all in one
// module so every source of a "coach message" (see below) shares one
// render path and can never visually drift apart from another.
//
// Three genuinely different sources feed the SAME speech bubble:
// 1. The proactive "today's focus" insight (aiCoach.js's computeInsight) —
//    zero-cost, seeded once as Ollie's opening line the first time the sheet
//    opens each page load.
// 2. Preset question chips + the weekly recap chip (aiCoach.js's QUESTIONS /
//    fetchWeeklyRecap) — the recap is the one real Gemini call in this
//    trio, but it's cached server-side per rolling week (see aiCoach.js's
//    comment), so both read as "instant enough" from here.
// 3. The genuinely interactive free-text chat, capped at a small number of
//    messages/day per user (backend/routers/coach.py's POST /coach/chat) so
//    it can't drain the shared Gemini quota every AI feature in this app
//    draws from. History lives only in this module's own memory — cleared
//    on a full page reload, never sent anywhere except round-tripped back to
//    the backend on each turn (see backend/models.py's CoachChatRequest
//    docstring for why: there is no server-side transcript table).
//
// All three render through appendMessage() below into the ONE speech bubble
// overlaid on the 3D model (index.html's #ollie-speech-bubble) — there is no
// scrolling transcript by design, this is a deliberate departure from a
// conventional chat UI toward a Finch-style "the character is speaking to
// you right now" read. `history` is still kept in memory (it's what gets
// round-tripped to the backend for conversational context), it's just never
// rendered as a list of bubbles. A local reply gets a brief, randomized
// "typing…" pause purely for feel (see LOCAL_TYPING_MIN/MAX_MS), a real one
// gets exactly as long as the network call actually takes, both shown as the
// same typing-dots swap inside the bubble via showTyping()/removeTyping().
// There is deliberately no visual tell distinguishing a local answer from a
// real Gemini one. The user's own line gets its own small, self-dismissing
// echo bubble (showUserBubble()) rather than joining Ollie's — see that
// function's own comment.
import { openSheet, vibrate } from "./ui.js?v=20260822t";
import { onLanguageChange, t } from "./i18n.js?v=20260822t";
import { api } from "./api.js?v=20260822t";
import { QUESTIONS, computeInsight, fetchWeeklyRecap, waveOllie } from "./aiCoach.js?v=20260822t";
import { isVoiceInputSupported, toggleVoiceInput, stopVoiceInput } from "./scan.js?v=20260822t";
import { initOllie3D, PetController } from "./ollie3d.js?v=20260822t";
import { PetHud } from "./petHud.js?v=20260822t";

const el = (id) => document.getElementById(id);
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Same tap-flourish-before-sheet-opens pattern as #settings-btn/#fasting-header-btn
// (see app.js's settingsPressPending / fastingTimer.js's headerPressPending) —
// held here instead since this module already owns everything else about this
// button. style.css's .ai-coach-btn.pulse themes the shared .icon-btn.pulse
// flash+ring vocabulary to Ollie's own orange (var(--c-calories-rgb), the same
// accent his chat send button already uses) instead of settings' neutral blue
// or fasting's violet.
const OLLIE_BTN_PRESS_ANIMATION_MS = 220;
let ollieBtnPressPending = false;

// A third mount point for scan.js's shared voice-input engine (see its own
// "Exported generic voice-input engine" comment) — same tap-to-speak mic,
// same singleton recognition session, just filling this input instead of a
// scan-sheet field. onError reports through the exact same bubble path as
// everything else in this sheet (see appendMessage's own comment on why)
// rather than a separate error surface, since this sheet has no standalone
// error element to write into.
const CHAT_VOICE_TARGET = {
  fieldId: "ai-coach-chat-input",
  micBtnId: "ai-coach-chat-mic-btn",
  hintId: "ai-coach-chat-mic-hint",
  maxLength: 500,
  onUpdate: () => resizeChatInput(),
  onError: (message) => appendMessage("coach", message, { isError: true }),
};

// Grows the composer with typed content, up to the CSS max-height (see
// .ai-coach-chat-form textarea), beyond which the textarea scrolls
// internally instead of the sheet itself — the standard "reset to auto,
// then measure scrollHeight" technique, since a textarea can only report an
// accurate content height once its own inline height stops constraining it.
// CSS max-height clamps the actual rendered box regardless of how tall the
// inline style claims to be, so this never needs to know the pixel cap.
function resizeChatInput() {
  const input = el("ai-coach-chat-input");
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

let history = []; // [{role: "user"|"coach", content: string}]
// True while a real network call OR a local "typing…" delay is in flight —
// gates the input, send button, AND every suggestion chip alike, so two
// exchanges (say, a chip tap and a typed message) can never land on top of
// each other in the feed.
let busy = false;
let cappedForToday = false;
// Seeded once per page load, not once per sheet-open — reopening an
// already-started conversation should show it as-is (like reopening any
// real chat app), not repeat the same greeting every time.
let insightSeeded = false;

const LOCAL_TYPING_MIN_MS = 500;
const LOCAL_TYPING_MAX_MS = 1500;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Static, non-user-derived SVG markup — safe to set via innerHTML since no
// dynamic data is ever interpolated into it (same rule ui.js's TOAST_ICONS
// follows). Reused from the old recap button's own icon.
const RECAP_CHIP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.5l2.4 5.9 6.1.9-4.5 4.2 1.2 6-5.2-3-5.2 3 1.2-6-4.5-4.2 6.1-.9L12 2.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

// Re-triggers a CSS animation class via the standard remove/reflow/re-add
// idiom used everywhere else in this app (the FAB, settings gear, send
// button) — needed because a still-present class doesn't restart its own
// animation on the next call.
function replayAnimation(elmt, className) {
  elmt.classList.remove(className);
  void elmt.offsetWidth; // reflow
  elmt.classList.add(className);
}

// Ollie's one speech bubble (index.html's #ollie-speech-bubble, overlaid on
// the 3D model) — the single render target for every coach message,
// regardless of which of the three sources (insight/chip/real-chat)
// produced it. Only ever shows the LATEST line; see this file's top comment
// for why there's no scrolling transcript anymore. `isError` only ever
// tints it (a failed real-chat turn, or a failed recap fetch) — same shape,
// just the color that reads as "bad news" (style.css's
// .ollie-speech-bubble-error). All the actual bubble DOM + TALKING-animation
// pulse work lives in PetController.speak() (ollie3d.js) — this function
// only adds the header-avatar wave, which is a separate 2D element
// PetController doesn't own.
function showOllieBubble(content, { isError = false } = {}) {
  PetController.speak(content, { isError });
  waveOllie(); // header avatar reacts too — same beat, two places
}

// The user's own last line gets a small, self-dismissing echo bubble near
// the composer (index.html's #ollie-user-bubble) rather than joining
// Ollie's speech bubble above — keeps the one big bubble unambiguously "his"
// (per the brief: it must look like the character is physically speaking to
// you), while still giving the user visible confirmation of what they sent.
// It fades itself out via style.css's ollie-user-bubble-life keyframe
// (triggered by the "show" class below) and is never a second transcript —
// under prefers-reduced-motion (where the global override collapses every
// animation to ~0.01ms, see style.css's blanket rule) it deliberately skips
// that class entirely and just stays put until the next line replaces it,
// rather than flashing and vanishing almost instantly.
function showUserBubble(content) {
  const bubble = el("ollie-user-bubble");
  bubble.textContent = content;
  bubble.hidden = false;
  bubble.classList.remove("show");
  if (prefersReducedMotion) return;
  void bubble.offsetWidth; // reflow
  bubble.classList.add("show");
}

// The one message-rendering path for every source in this sheet — see this
// file's top comment. role "coach" writes into Ollie's speech bubble, role
// "user" into the small echo bubble next to the composer.
function appendMessage(role, content, { isError = false } = {}) {
  if (role === "coach") {
    showOllieBubble(content, { isError });
  } else {
    showUserBubble(content);
  }
}

// Swaps the speech bubble into its typing-dots state — same bubble, same
// position, just its content — rather than a separate indicator element, so
// it's the exact same DOM serving both a fixed local delay and a real
// network call of unknown length. Delegates the actual DOM + THINKING-state
// work to PetController.showTyping() (ollie3d.js). Return value kept for API
// symmetry with the old row-based version (removeTyping ignores it); at most
// one typing state is ever active at a time since every caller awaits it
// under `busy`.
function showTyping() {
  PetController.showTyping();
  return true;
}
function removeTyping() {
  PetController.hideTyping();
}

function setBusy(next) {
  busy = next;
  const input = el("ai-coach-chat-input");
  const sendBtn = el("ai-coach-chat-send-btn");
  input.disabled = next || cappedForToday;
  sendBtn.disabled = next || cappedForToday;
  el("ai-coach-suggestions")
    .querySelectorAll("button")
    .forEach((btn) => (btn.disabled = next));
}

function setCapped(remaining) {
  cappedForToday = remaining <= 0;
  el("ai-coach-chat-input").disabled = cappedForToday;
  el("ai-coach-chat-send-btn").disabled = cappedForToday;
  el("ai-coach-chat-remaining").textContent = cappedForToday
    ? t("aiCoach.chatCappedToday")
    : t("aiCoach.chatRemainingToday", { count: remaining });
}

// The shared "post a question, wait a beat, reveal the zero-cost local
// answer" flow behind every suggestion chip except the weekly recap (see
// triggerRecap below, which is the same idea but awaits a real — if
// server-cached — network call instead of a fixed delay). Randomized within
// spec (0.5-1.5s) rather than a fixed duration so repeated taps don't all
// feel identically timed, which would itself be a tell that this isn't real.
async function triggerLocalExchange(label, answerFn) {
  if (busy) return;
  appendMessage("user", label);
  setBusy(true);
  const typingRow = showTyping();
  await wait(LOCAL_TYPING_MIN_MS + Math.random() * (LOCAL_TYPING_MAX_MS - LOCAL_TYPING_MIN_MS));
  removeTyping(typingRow);
  appendMessage("coach", answerFn());
  setBusy(false);
}

async function triggerRecap() {
  if (busy) return;
  appendMessage("user", t("aiCoach.recapLabel"));
  setBusy(true);
  const typingRow = showTyping();
  try {
    const text = await fetchWeeklyRecap();
    removeTyping(typingRow);
    appendMessage("coach", text);
  } catch (err) {
    removeTyping(typingRow);
    appendMessage("coach", err.message || t("aiCoach.recapError"), { isError: true });
  } finally {
    setBusy(false);
  }
}

function renderSuggestions() {
  const container = el("ai-coach-suggestions");
  container.replaceChildren(
    ...QUESTIONS.map((q) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ai-coach-suggestion-chip";
      const label = t(`aiCoach.q${q.key[0].toUpperCase()}${q.key.slice(1)}`);
      btn.textContent = label;
      btn.addEventListener("click", () => triggerLocalExchange(label, q.answer));
      return btn;
    })
  );
  const recapChip = document.createElement("button");
  recapChip.type = "button";
  recapChip.className = "ai-coach-suggestion-chip ai-coach-suggestion-chip-recap";
  recapChip.innerHTML = RECAP_CHIP_ICON;
  const recapLabel = document.createElement("span");
  recapLabel.textContent = t("aiCoach.recapLabel");
  recapChip.appendChild(recapLabel);
  recapChip.addEventListener("click", triggerRecap);
  container.appendChild(recapChip);
}

// Seeded once per page load (see the module-level `insightSeeded` comment) —
// goes through the exact same typing-then-reveal beat as a chip tap so
// Ollie's very first line doesn't read as a special, instantly-appearing
// case next to everything that follows it.
async function seedInsight() {
  if (insightSeeded) return;
  insightSeeded = true;
  setBusy(true);
  const typingRow = showTyping();
  await wait(LOCAL_TYPING_MIN_MS + Math.random() * (LOCAL_TYPING_MAX_MS - LOCAL_TYPING_MIN_MS));
  removeTyping(typingRow);
  appendMessage("coach", computeInsight());
  setBusy(false);
}

async function submitMessage(text) {
  const trimmed = text.trim();
  if (!trimmed || busy || cappedForToday) return;

  // Same remove/reflow/re-add idiom the FAB and settings gear use for their
  // own one-shot flourishes — a still-present class wouldn't restart its own
  // animation on the very next send.
  const sendBtn = el("ai-coach-chat-send-btn");
  sendBtn.classList.remove("sent");
  void sendBtn.offsetWidth;
  sendBtn.classList.add("sent");

  const historyForRequest = [...history]; // everything BEFORE this new turn
  history.push({ role: "user", content: trimmed });
  appendMessage("user", trimmed);
  el("ai-coach-chat-input").value = "";
  resizeChatInput();
  setBusy(true);
  const typingRow = showTyping();

  try {
    const res = await api.sendCoachChat(trimmed, historyForRequest);
    removeTyping(typingRow);
    history.push({ role: "coach", content: res.reply });
    appendMessage("coach", res.reply);
    setCapped(res.messages_remaining_today);
  } catch (err) {
    // The failed turn stays out of `history` (only pushed on success above)
    // so a retry doesn't resend a message twice — but it's already rendered
    // as a bubble, so the error appears right below it as a normal (if
    // error-tinted) reply instead of the message silently vanishing.
    removeTyping(typingRow);
    appendMessage("coach", err.message || t("aiCoach.chatError"), { isError: true });
    // err.quotaExceeded (api.js) distinguishes this user's own daily cap
    // (backend/services/ai_usage_service.py, feature "coach_chat" — a real
    // {"detail": ...} 429) from a plain burst/sustained rate-limit 429
    // (slowapi's generic {"error": ...} body, no `detail`) — only the
    // former doesn't recover by retrying right away, so only that one
    // should permanently cap input for the rest of today.
    if (err.status === 429 && err.quotaExceeded) cappedForToday = true;
  } finally {
    setBusy(false);
  }
}

function resetConversation() {
  // Clears the visible transcript only — deliberately does NOT touch
  // cappedForToday. That's a server-side fact about this user's daily
  // allowance, independent of what's on screen; resetting the conversation
  // can't un-spend a turn already used, and re-enabling input here would
  // just let a capped user fire a request that the backend rejects anyway.
  history = [];
  PetController.reset(); // hides the bubble, clears any pending talk-pulse timer, back to idle
  const userBubble = el("ollie-user-bubble");
  userBubble.hidden = true;
  userBubble.classList.remove("show");
  el("ai-coach-chat-remaining").textContent = cappedForToday ? t("aiCoach.chatCappedToday") : t("aiCoach.chatHint");
  setBusy(false);
  // A fresh conversation gets a fresh opening line, same as a brand-new
  // sheet-open would — insightSeeded is reset first so seedInsight() doesn't
  // treat this as a repeat.
  insightSeeded = false;
  seedInsight();
}

// Objective 4 — the "How to Play" help modal (index.html's
// #ollie-help-overlay). Kept in this module rather than a separate file:
// it's a small, purely-DOM-toggling piece of the same sheet coachChat.js
// already owns everything else about, not a large enough concern to earn
// its own module the way ollie3d.js/petHud.js's genuinely different
// responsibilities (3D state machine, gamification math) did.
function renderHeartsBody() {
  const node = el("ollie-help-hearts-body");
  if (node) node.textContent = t("aiCoach.helpHeartsBody", { max: PetHud.getMaxHearts() });
}
// Tracked so a reopen mid-close-transition can tear this down explicitly —
// canceling a running CSS transition by re-adding "show" never fires
// 'transitionend' for the canceled instance, so without this an interrupted
// close would leave one more permanently-attached listener behind (same
// class of leak ollie3d.js's dismissBubble()/_bubbleHideHandler guards
// against, for the same reason).
let helpCloseHandler = null;
function openHelpModal() {
  renderHeartsBody(); // always fresh — max_hearts/language could have changed since the sheet last opened
  const overlay = el("ollie-help-overlay");
  if (helpCloseHandler) {
    overlay.removeEventListener("transitionend", helpCloseHandler);
    helpCloseHandler = null;
  }
  overlay.hidden = false;
  void overlay.offsetWidth; // reflow, so the fade-in below replays on repeat opens
  overlay.classList.add("show");
}
function closeHelpModal() {
  const overlay = el("ollie-help-overlay");
  if (overlay.hidden) return;
  overlay.classList.remove("show");
  if (prefersReducedMotion) {
    overlay.hidden = true;
    return;
  }
  if (helpCloseHandler) overlay.removeEventListener("transitionend", helpCloseHandler);
  helpCloseHandler = (e) => {
    // transitionend bubbles — .ollie-help-modal's own transform transition
    // (a different duration/easing) would otherwise also trigger this via
    // bubbling and could hide the overlay mid-panel-animation. Only react to
    // the overlay's own opacity transition finishing; NOT {once: true},
    // since a bubbled child event arriving first would otherwise consume
    // the one-shot slot and leave the overlay's own end unheard.
    if (e.target !== overlay) return;
    overlay.removeEventListener("transitionend", helpCloseHandler);
    overlay.hidden = true;
    helpCloseHandler = null;
  };
  overlay.addEventListener("transitionend", helpCloseHandler);
}
function initHelpModal() {
  const overlay = el("ollie-help-overlay");
  el("ollie-help-btn").addEventListener("click", openHelpModal);
  el("ollie-help-close").addEventListener("click", closeHelpModal);
  el("ollie-help-got-it").addEventListener("click", closeHelpModal);
  // Tapping the dark scrim (not the glass panel itself) dismisses it, same
  // "tap outside to close" convention every other overlay in this app uses —
  // checking e.target === overlay (not e.currentTarget) is what keeps a tap
  // INSIDE the panel from bubbling up and closing it out from under the user.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeHelpModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeHelpModal();
  });
}

function openCoachSheet() {
  openSheet("ai-coach-sheet");
  waveOllie();
  PetController.setState("idle");
  // greet() plays the flourish + recalls whatever was just logged (petHud.js's
  // _lastAction) into the speech bubble, from a clean idle baseline every
  // time — the sheet-hidden observer below guarantees that baseline by fully
  // resetting Ollie's animation state on every close, so this can never
  // inherit a stuck mid-flight clip from a previous open/close cycle.
  PetController.greet();
  // The header pip only ever means "something new since you last opened
  // this" — opening the sheet IS that acknowledgment, regardless of whether
  // the user then also pokes the model directly.
  PetHud.clearUnseenAction();
  seedInsight();
  // Re-measure now, not just on input: the composer's placeholder text (or
  // whatever was left in it from a previous session) needs its real
  // scrollHeight, which reads as 0 while the sheet was [hidden] (display:
  // none has no layout box) — see resizeChatInput's own comment.
  resizeChatInput();
}

export function initCoachChat() {
  renderSuggestions();
  initOllie3D();
  PetHud.init();
  initHelpModal();
  el("ai-coach-chat-remaining").textContent = t("aiCoach.chatHint");

  el("ai-coach-chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitMessage(el("ai-coach-chat-input").value);
  });
  const chatInput = el("ai-coach-chat-input");
  chatInput.addEventListener("input", () => resizeChatInput());
  // A <textarea> doesn't submit its form on Enter the way the old <input>
  // did — Enter sends, Shift+Enter inserts a real newline, the same split
  // every chat app's composer uses. e.isComposing guards IME input (e.g.
  // Romanian diacritics, CJK) committing on Enter, where this would
  // otherwise send mid-composition instead of confirming the character.
  chatInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    submitMessage(chatInput.value);
  });
  el("ai-coach-chat-reset-btn").addEventListener("click", resetConversation);

  // Feature-detected, not assumed universal (Firefox desktop lacks it) —
  // same hide-on-unsupported pattern scan.js uses for its own two mic
  // buttons, which share this exact engine.
  if (isVoiceInputSupported()) el("ai-coach-chat-mic-btn").hidden = false;
  el("ai-coach-chat-mic-btn").addEventListener("click", () => toggleVoiceInput(CHAT_VOICE_TARGET));
  // Universal safety net for the sheet closing while the mic is live,
  // regardless of how — Cancel, backdrop tap, or ui.js's generic swipe-to-
  // dismiss (which has no per-sheet hook of its own, it just flips
  // `hidden`). Same MutationObserver pattern scan.js uses for its own
  // camera/mic cleanup, so a dismissed sheet never leaves the mic running.
  // The one place that reacts to the sheet closing regardless of HOW it
  // closed (header X, swipe-to-dismiss, backdrop tap) — same reasoning as the
  // stopVoiceInput() call this observer already existed for. PetController.reset()
  // is the fix for Ollie getting stuck mid-"fly" and tap-to-interact going
  // dead after a few open/close cycles: <model-viewer> pauses rendering (and,
  // with it, its internal animation-mixer ticking) once it's no longer
  // intersecting the viewport, which this sheet's `hidden` (display: none) is
  // — so a one-shot reaction that's still mid-flight when the sheet closes
  // never gets to fire its own 'finished' event at all. Without an explicit
  // reset here, that leaves `isAnimating` stuck true permanently
  // and the model left paused mid-flap. reset() unconditionally clears that
  // flag, tears down any dangling 'finished' listener, and forces the model
  // back to a looping idle clip — so every single open of this sheet starts
  // from a guaranteed-clean baseline, never a state inherited from whatever
  // happened to be mid-flight last time it closed. clearUnseenAction() here
  // too is a belt-and-suspenders match for openCoachSheet()'s own call — it
  // covers a sheet close that somehow didn't go through openCoachSheet's own
  // acknowledgment (there's no such path today, but a badge left stuck on a
  // closed sheet would be a real regression if one's ever added).
  new MutationObserver(() => {
    if (!el("ai-coach-sheet").hidden) return;
    stopVoiceInput();
    PetController.reset();
    PetHud.clearUnseenAction();
  }).observe(el("ai-coach-sheet"), { attributes: true, attributeFilter: ["hidden"] });

  el("ai-coach-btn").addEventListener("click", () => {
    if (ollieBtnPressPending) return;
    const btn = el("ai-coach-btn");
    vibrate(10);
    if (prefersReducedMotion) {
      openCoachSheet();
      return;
    }
    btn.classList.remove("pulse");
    void btn.offsetWidth;
    btn.classList.add("pulse");
    ollieBtnPressPending = true;
    setTimeout(() => {
      ollieBtnPressPending = false;
      openCoachSheet();
    }, OLLIE_BTN_PRESS_ANIMATION_MS);
  });
  // The dashboard status banner (coach.js's getCalorieStatus, rendered by
  // ui.js) used to be a dead-end read-only notice with no way to act on it —
  // it's really just a preview of the same coach, so tapping it opens the
  // real thing instead of the user having to separately notice/find the
  // header avatar. role="button"/tabindex here (not a <button> element,
  // since the banner's tone-colored left border and layout are shared with
  // the End Day sheet's static summary variant, which stays non-interactive)
  // needs its own keydown handling for keyboard activation.
  const banner = el("status-banner");
  if (banner) {
    banner.addEventListener("click", openCoachSheet);
    banner.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openCoachSheet();
    });
  }

  // Static labels only — in-flight bubbles/remaining-count text stay in
  // whatever language they were sent/received in (translating history after
  // the fact would misrepresent what was actually said), same "don't
  // retranslate live content" rule this app's other i18n consumers follow.
  onLanguageChange(() => {
    renderSuggestions(); // chip labels need retranslation
    if (!el("ollie-help-overlay").hidden) renderHeartsBody(); // interpolated text, not data-i18n — see its own comment
    if (cappedForToday) {
      el("ai-coach-chat-remaining").textContent = t("aiCoach.chatCappedToday");
    } else if (history.length === 0) {
      el("ai-coach-chat-remaining").textContent = t("aiCoach.chatHint");
    }
    // A non-zero remaining count already shown mid-conversation is left
    // alone — it's tied to the last response's actual number, not a static
    // label, and will naturally update in the new language on the next reply.
    // The placeholder string's own length changes between languages (Romanian
    // reliably wraps to more lines than English at this width) — re-measure
    // so a language switch while the sheet is open never leaves the new,
    // longer placeholder clipped. Guarded on visibility for the same reason
    // openCoachSheet's own call is: scrollHeight reads 0 while [hidden].
    if (!el("ai-coach-sheet").hidden) resizeChatInput();
  });
}
