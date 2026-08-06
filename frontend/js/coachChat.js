// The AI Coach sheet, in full — a single unified chat feed. Owns the header
// avatar button, the status banner shortcut, the message feed, the
// horizontally-scrollable suggestion chips, and the free-text input, all in
// one module so every source of a "coach message" (see below) shares one
// DOM/render path and can never visually drift apart from another.
//
// Three genuinely different sources feed the SAME bubble path:
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
// All three render through appendMessage() below and share the same
// showTyping()/removeTyping() indicator — a local reply gets a brief,
// randomized "typing…" pause purely for feel (see LOCAL_TYPING_DELAY_MS),
// a real one gets exactly as long as the network call actually takes. There
// is deliberately no visual tell distinguishing them.
import { openSheet } from "./ui.js?v=20260806c{";
import { onLanguageChange, t } from "./i18n.js?v=20260806c{";
import { api } from "./api.js?v=20260806c{";
import { QUESTIONS, computeInsight, fetchWeeklyRecap, waveOllie } from "./aiCoach.js?v=20260806c{";
import { isVoiceInputSupported, toggleVoiceInput, stopVoiceInput } from "./scan.js?v=20260806c{";

const el = (id) => document.getElementById(id);

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
  onUpdate: () => {},
  onError: (message) => appendMessage("coach", message, { isError: true }),
};

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

// A tightly-cropped head-only variant of the same Ollie artwork used
// everywhere else (header avatar, tutorial mascot) — a full body doesn't
// read at a 26px chat-avatar size, so this is a real (smaller) viewBox crop
// around just the head/eyes/beak, not a second drawing. `.ai-coach-avatar-eyes`
// still gets the shared idle blink (see style.css's `.ollie-mascot` rules),
// and `.waving` still gets the shared pop/bob greet — only the wing-wave part
// of that shared animation set silently no-ops here since there are no wings.
const OLLIE_HEAD_SVG = `<svg viewBox="20 5 80 74" aria-hidden="true">
  <path d="M33 27 L25 8 L44 20 Z" fill="#c9915a"/>
  <path d="M87 27 L95 8 L76 20 Z" fill="#c9915a"/>
  <circle cx="60" cy="53" r="32" fill="#f4c98a"/>
  <path d="M27 37 Q60 19 93 37" stroke="#ff6b4a" stroke-width="7.5" fill="none" stroke-linecap="round"/>
  <circle cx="60" cy="27" r="4.5" fill="#ff6b4a"/>
  <ellipse cx="32" cy="64" rx="5" ry="3.5" fill="#ff9d7a" opacity="0.55"/>
  <ellipse cx="88" cy="64" rx="5" ry="3.5" fill="#ff9d7a" opacity="0.55"/>
  <g class="ai-coach-avatar-eyes">
    <circle cx="47" cy="55" r="14" fill="#fff"/>
    <circle cx="73" cy="55" r="14" fill="#fff"/>
    <circle cx="47" cy="55" r="14" fill="none" stroke="#2b2118" stroke-width="1.4"/>
    <circle cx="73" cy="55" r="14" fill="none" stroke="#2b2118" stroke-width="1.4"/>
    <circle cx="49.5" cy="57" r="6.5" fill="#2b2118"/>
    <circle cx="75.5" cy="57" r="6.5" fill="#2b2118"/>
    <circle cx="52" cy="54" r="2" fill="#fff"/>
    <circle cx="78" cy="54" r="2" fill="#fff"/>
  </g>
  <path d="M60 65 L54 73 L66 73 Z" fill="#ffb648"/>
</svg>`;

// Static, non-user-derived SVG markup — safe to set via innerHTML since no
// dynamic data is ever interpolated into it (same rule ui.js's TOAST_ICONS
// follows). Reused from the old recap button's own icon.
const RECAP_CHIP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.5l2.4 5.9 6.1.9-4.5 4.2 1.2 6-5.2-3-5.2 3 1.2-6-4.5-4.2 6.1-.9L12 2.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

function createOllieAvatar() {
  const avatar = document.createElement("div");
  avatar.className = "ai-coach-chat-avatar ollie-mascot";
  avatar.innerHTML = OLLIE_HEAD_SVG;
  return avatar;
}

function scrollToBottom() {
  const messages = el("ai-coach-chat-messages");
  // Smooth, not an instant jump — this fires on every new bubble/typing
  // indicator, and a native smooth scroll is compositor-handled (cheap, no
  // JS animation loop) rather than something to hand-roll.
  messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
}

// The one bubble-rendering path for every message in this sheet, regardless
// of which of the three sources (insight/chip/real-chat) produced it — see
// this file's top comment. `isError` only ever tints a coach bubble (a
// failed real-chat turn, or a failed recap fetch); it never changes the
// DOM shape, just a modifier class, so it still can't be told apart from a
// normal reply at a glance beyond the color.
function appendMessage(role, content, { isError = false } = {}) {
  const messages = el("ai-coach-chat-messages");
  const bubble = document.createElement("div");
  bubble.className = `ai-coach-chat-msg ai-coach-chat-msg-${role}${isError ? " ai-coach-chat-msg-error" : ""}`;
  bubble.textContent = content;

  if (role === "coach") {
    // Ollie "says" this one — his mini avatar rides along with the bubble
    // (see createOllieAvatar) rather than the bubble floating on its own.
    const row = document.createElement("div");
    row.className = "ai-coach-chat-row";
    row.append(createOllieAvatar(), bubble);
    messages.appendChild(row);
    waveOllie(); // header avatar reacts too — same beat, two places
  } else {
    messages.appendChild(bubble);
  }
  scrollToBottom();
}

// Appended as a real (temporary) row in the feed itself, not toggled via
// `hidden` on a static sibling — this is what lets the exact same indicator
// serve both a fixed local delay and a real network call of unknown length,
// and keeps it in the natural scroll flow instead of needing separate
// positioning logic.
function showTyping() {
  const messages = el("ai-coach-chat-messages");
  const row = document.createElement("div");
  row.className = "ai-coach-chat-row";
  const dots = document.createElement("div");
  dots.className = "ai-coach-chat-typing-dots";
  dots.innerHTML = "<span></span><span></span><span></span>";
  row.append(createOllieAvatar(), dots);
  messages.appendChild(row);
  scrollToBottom();
  return row;
}
function removeTyping(row) {
  row?.remove();
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
    // 503 here means either this user's own daily cap or the shared global
    // Gemini quota is exhausted (see routers/coach.py) — neither recovers by
    // retrying right away, so treat it the same as a normal capped response
    // rather than leaving input enabled for a guaranteed-repeat failure.
    if (err.status === 503) cappedForToday = true;
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
  el("ai-coach-chat-messages").replaceChildren();
  el("ai-coach-chat-remaining").textContent = cappedForToday ? t("aiCoach.chatCappedToday") : t("aiCoach.chatHint");
  setBusy(false);
  // A fresh conversation gets a fresh opening line, same as a brand-new
  // sheet-open would — insightSeeded is reset first so seedInsight() doesn't
  // treat this as a repeat.
  insightSeeded = false;
  seedInsight();
}

export function openCoachSheet() {
  openSheet("ai-coach-sheet");
  waveOllie();
  seedInsight();
}

export function initCoachChat() {
  renderSuggestions();
  el("ai-coach-chat-remaining").textContent = t("aiCoach.chatHint");

  el("ai-coach-chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitMessage(el("ai-coach-chat-input").value);
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
  new MutationObserver(() => {
    if (el("ai-coach-sheet").hidden) stopVoiceInput();
  }).observe(el("ai-coach-sheet"), { attributes: true, attributeFilter: ["hidden"] });

  el("ai-coach-btn").addEventListener("click", openCoachSheet);
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
    if (cappedForToday) {
      el("ai-coach-chat-remaining").textContent = t("aiCoach.chatCappedToday");
    } else if (history.length === 0) {
      el("ai-coach-chat-remaining").textContent = t("aiCoach.chatHint");
    }
    // A non-zero remaining count already shown mid-conversation is left
    // alone — it's tied to the last response's actual number, not a static
    // label, and will naturally update in the new language on the next reply.
  });
}
