// The capped free-text half of the AI Coach — sits inside the same sheet as
// aiCoach.js's zero-cost preset insights/questions, but this one genuinely
// calls Gemini per message (backend/routers/coach.py's POST /coach/chat),
// gated by a small per-user daily allowance (see that router's docstring).
// History lives only in this module's own memory — cleared on a full page
// reload, never sent anywhere except round-tripped back to the backend on
// each turn (see backend/models.py's CoachChatRequest docstring for why:
// there is no server-side transcript table).
import { onLanguageChange, t } from "./i18n.js?v=20260805y";
import { api } from "./api.js?v=20260805y";

const el = (id) => document.getElementById(id);

let history = []; // [{role: "user"|"coach", content: string}]
let sending = false;
let cappedForToday = false;

function scrollToBottom() {
  const messages = el("ai-coach-chat-messages");
  messages.scrollTop = messages.scrollHeight;
}

function appendMessage(role, content) {
  const messages = el("ai-coach-chat-messages");
  const bubble = document.createElement("div");
  bubble.className = `ai-coach-chat-msg ai-coach-chat-msg-${role}`;
  bubble.textContent = content;
  messages.appendChild(bubble);
  scrollToBottom();
}

function setSending(next) {
  sending = next;
  const input = el("ai-coach-chat-input");
  const sendBtn = el("ai-coach-chat-send-btn");
  el("ai-coach-chat-typing").hidden = !next;
  if (next) scrollToBottom();
  input.disabled = next || cappedForToday;
  sendBtn.disabled = next || cappedForToday;
}

function setCapped(remaining) {
  cappedForToday = remaining <= 0;
  el("ai-coach-chat-input").disabled = cappedForToday;
  el("ai-coach-chat-send-btn").disabled = cappedForToday;
  el("ai-coach-chat-remaining").textContent = cappedForToday
    ? t("aiCoach.chatCappedToday")
    : t("aiCoach.chatRemainingToday", { count: remaining });
}

async function submitMessage(text) {
  const trimmed = text.trim();
  if (!trimmed || sending || cappedForToday) return;

  el("ai-coach-chat-error").hidden = true;
  const historyForRequest = [...history]; // everything BEFORE this new turn
  history.push({ role: "user", content: trimmed });
  appendMessage("user", trimmed);
  el("ai-coach-chat-input").value = "";
  setSending(true);

  try {
    const res = await api.sendCoachChat(trimmed, historyForRequest);
    history.push({ role: "coach", content: res.reply });
    appendMessage("coach", res.reply);
    setCapped(res.messages_remaining_today);
  } catch (err) {
    // The failed turn stays out of `history` (only pushed on success above)
    // so a retry doesn't resend a message twice — but it's already rendered
    // as a bubble, so the error appears right below it instead of the
    // message silently vanishing.
    el("ai-coach-chat-error").textContent = err.message || t("aiCoach.chatError");
    el("ai-coach-chat-error").hidden = false;
    // 503 here means either this user's own daily cap or the shared global
    // Gemini quota is exhausted (see routers/coach.py) — neither recovers by
    // retrying right away, so treat it the same as a normal capped response
    // rather than leaving input enabled for a guaranteed-repeat failure.
    if (err.status === 503) cappedForToday = true;
  } finally {
    setSending(false);
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
  el("ai-coach-chat-error").hidden = true;
  el("ai-coach-chat-remaining").textContent = cappedForToday ? t("aiCoach.chatCappedToday") : t("aiCoach.chatHint");
  setSending(false);
}

export function initCoachChat() {
  el("ai-coach-chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitMessage(el("ai-coach-chat-input").value);
  });
  el("ai-coach-chat-reset-btn").addEventListener("click", resetConversation);
  el("ai-coach-chat-remaining").textContent = t("aiCoach.chatHint");

  // Static labels only — in-flight bubbles/remaining-count text stay in
  // whatever language they were sent/received in (translating history after
  // the fact would misrepresent what was actually said), same "don't
  // retranslate live content" rule aiCoach.js's own refreshForLanguage
  // follows for its answer text.
  onLanguageChange(() => {
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
