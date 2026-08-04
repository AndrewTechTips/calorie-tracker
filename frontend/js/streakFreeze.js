// Client-side "streak freeze" — one grace token per rolling 7 days that
// bridges exactly one non-adherent gap day in the calorie streak, the same
// way a real ice cube keeps a cold chain from breaking for one skipped link.
// Deliberately client-only (no backend/schema change — see CLAUDE.md's
// working-in-this-repo note on schema changes needing a real migration
// step): the server (backend/services/trends_service.py::compute_trends)
// keeps computing and returning the honest, un-frozen streak exactly as
// before; this module derives a *second*, freeze-adjusted number from the
// same per-day `adherent` data GET /trends already returns, entirely in the
// browser.
//
// Rolling window, not a calendar week — same philosophy this app already
// uses for data retention (see Settings.retention_days in CLAUDE.md): the
// cooldown is "7 days since the token was last spent", not "resets every
// Monday", so there's no timezone-dependent week-boundary edge case to get
// wrong.
//
// Persisted as {frozenDate, frozenAt} — a SINGLE remembered slot, not a
// counter — so the exact same gap date is honored for free on every future
// render (a page reload or reopening Progress must not "forget" a freeze
// that already saved a specific day), while the cooldown (frozenAt) is what
// actually gates spending a *new* token on a *different* gap.

const STORAGE_KEY = "ironlog_streak_freeze";
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (raw && typeof raw.frozenDate === "string" && typeof raw.frozenAt === "number") return raw;
  } catch {
    /* corrupt/blocked storage — treat as "never used", see saveState's comment */
  }
  return { frozenDate: null, frozenAt: null };
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* losing this is only a minor UX regression (a freeze might get re-offered
       sooner than intended), never a correctness issue for real logged data —
       the underlying server streak this is layered on is unaffected either way */
  }
}

// days: lastTrends.days from GET /trends (chronological, oldest first, last
// entry = today) — the exact same array progress.js already has cached.
// Mirrors trends_service.py's own reversed-loop/skip-today-if-empty
// algorithm exactly, with one addition: the single most recent non-adherent
// gap day can be bridged (not counted, but also not breaking the chain) if
// a fresh token is available, or for free if that exact date was already
// the one frozen by an earlier render/session.
export function computeStreakWithFreeze(days) {
  if (!days?.length) return { streak: 0, freezeAppliedDate: null, freezeReady: false };

  const state = loadState();
  const tokenReady = !state.frozenAt || Date.now() - state.frozenAt >= COOLDOWN_MS;

  let streak = 0;
  let spentNewToken = false;
  let appliedDate = null;
  const lastIndex = days.length - 1;

  for (let i = lastIndex; i >= 0; i--) {
    const day = days[i];
    const isToday = i === lastIndex;
    if (isToday && day.calories === 0) continue; // today isn't over yet — same as the server's own rule
    if (day.adherent) {
      streak++;
      continue;
    }
    if (day.date === state.frozenDate) {
      appliedDate = day.date; // already-spent freeze from a prior render — honor it again, no new cost
      continue;
    }
    // Only worth spending a freeze if there's already a real streak running
    // on the far (older) side of this gap to protect — without this check,
    // the very first render of an account with no history at all (every
    // past day non-adherent simply because nothing was ever logged) would
    // burn the week's only token bridging empty history instead of an
    // actual near-miss, for a streak that's still 0 either way.
    if (streak > 0 && tokenReady && !spentNewToken) {
      spentNewToken = true;
      appliedDate = day.date;
      continue;
    }
    break; // a second gap in the same window always breaks it — only one freeze per window, ever
  }

  if (spentNewToken) saveState({ frozenDate: appliedDate, frozenAt: Date.now() });

  return {
    streak,
    freezeAppliedDate: appliedDate,
    // Whether a *fresh* token remains available after this render — false
    // if one was just spent above, otherwise whatever the cooldown says.
    freezeReady: spentNewToken ? false : tokenReady,
  };
}

// For a Settings/Progress badge: how many whole days until the next token,
// or 0 if one is ready right now. Pure read, no state mutation.
export function daysUntilNextFreeze() {
  const state = loadState();
  if (!state.frozenAt) return 0;
  const remainingMs = COOLDOWN_MS - (Date.now() - state.frozenAt);
  return remainingMs <= 0 ? 0 : Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
}
