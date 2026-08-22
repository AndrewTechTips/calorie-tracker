import { api } from "./api.js?v=20260822q";
import { t } from "./i18n.js?v=20260822q";

const el = (id) => document.getElementById(id);

// Feature keys mirror backend/services/ai_usage_service.py's
// _FEATURE_LIMIT_SETTINGS exactly — GET /ai-usage returns one entry per
// these same string keys. This list also fixes the display order (roughly
// "how a user encounters these features day to day", not alphabetical).
const FEATURES = ["scan", "scan_describe", "log_correction", "coach_chat", "weekly_recap", "damage_control", "suggest_meals"];

const FEATURE_LABEL_KEYS = {
  scan: "aiUsage.featureScan",
  scan_describe: "aiUsage.featureScanDescribe",
  log_correction: "aiUsage.featureLogCorrection",
  coach_chat: "aiUsage.featureCoachChat",
  weekly_recap: "aiUsage.featureWeeklyRecap",
  damage_control: "aiUsage.featureDamageControl",
  suggest_meals: "aiUsage.featureSuggestMeals",
};

// Only the two features that actually read as the same thing at a glance
// ("Describe a Meal" and "Coach Chat" both sound like "talking to Ollie")
// get a hint — every other name (AI Meal Scan, Food Corrections, Weekly
// Recap, Damage Control, Meal Suggester) is already self-explanatory, and
// a hint under all 7 rows made the list feel much longer than it needed to.
const FEATURE_HINT_KEYS = {
  scan_describe: "aiUsage.featureScanDescribeHint",
  coach_chat: "aiUsage.featureCoachChatHint",
};

function buildRow(feature, index) {
  const dailyRemaining = Math.max(0, feature.limit - feature.used);
  const atCapacityDaily = feature.limit > 0 && feature.used >= feature.limit;
  const hasMonthly = feature.monthly_limit != null;
  const monthlyRemaining = hasMonthly ? Math.max(0, feature.monthly_limit - feature.monthly_used) : null;
  const atCapacityMonthly = hasMonthly && feature.monthly_used >= feature.monthly_limit;

  const row = document.createElement("div");
  row.className = "ai-usage-row";
  // Small stagger, same idea as settings-group-in's own entrance — reads as
  // one deliberate reveal instead of every row popping in at once.
  row.style.animationDelay = `${index * 40}ms`;

  const name = document.createElement("div");
  name.className = "ai-usage-row-name";
  name.textContent = t(FEATURE_LABEL_KEYS[feature.feature] || feature.feature);
  row.appendChild(name);

  const hintKey = FEATURE_HINT_KEYS[feature.feature];
  if (hintKey) {
    const hint = document.createElement("p");
    hint.className = "ai-usage-row-hint";
    hint.textContent = t(hintKey);
    row.appendChild(hint);
  }

  const top = document.createElement("div");
  top.className = "ai-usage-row-top";
  const count = document.createElement("span");
  count.className = "ai-usage-row-count";
  count.classList.toggle("at-capacity", atCapacityDaily || atCapacityMonthly);
  // A feature with a monthly gate (currently just Weekly Recap) shows both
  // numbers on ONE line rather than a second bar/section — "1 left today ·
  // 5 left this month" reads as one fact about one feature, not two
  // separate meters to parse. Every other feature only ever shows the
  // first half.
  const dailyText = atCapacityDaily ? t("aiUsage.capped") : t("aiUsage.remaining", { count: dailyRemaining });
  if (hasMonthly) {
    const monthlyText = atCapacityMonthly ? t("aiUsage.cappedMonthly") : t("aiUsage.remainingMonthly", { count: monthlyRemaining });
    count.textContent = `${dailyText} · ${monthlyText}`;
  } else {
    count.textContent = dailyText;
  }
  top.appendChild(count);
  row.appendChild(top);

  // The bar always reflects the DAILY count — it's the one that resets
  // soonest and changes most often, so it's the more useful thing to see
  // at a glance; the text above already carries the monthly number too.
  const bar = document.createElement("div");
  bar.className = "quota-bar";
  const track = document.createElement("div");
  track.className = "quota-bar-track";
  const fill = document.createElement("div");
  fill.className = "quota-bar-fill";
  const pct = feature.limit > 0 ? Math.min(100, (feature.used / feature.limit) * 100) : 0;
  fill.style.transform = `scaleX(${pct / 100})`;
  fill.classList.toggle("danger", atCapacityDaily);
  fill.classList.toggle("warning", !atCapacityDaily && pct >= 80);
  track.appendChild(fill);
  bar.appendChild(track);
  row.appendChild(bar);

  return row;
}

function showMessage(list, message) {
  list.replaceChildren();
  const p = document.createElement("p");
  p.className = "ai-usage-empty";
  p.textContent = message;
  list.appendChild(p);
}

// Fetched fresh every time Settings opens (see app.js's openSettingsSheet)
// — this is live, per-request server state (backend/services/
// ai_usage_service.py), never cached client-side, so a value shown here is
// never more than one sheet-open stale. Failing silently-ish into an inline
// message rather than a toast: this is a passive info panel inside an
// already-open sheet, not an action the user just took.
export async function renderAIUsage() {
  const list = el("ai-usage-list");
  if (!list) return;
  showMessage(list, t("aiUsage.hint"));

  let summary;
  try {
    summary = await api.getAIUsage();
  } catch (err) {
    showMessage(list, err.message || t("aiUsage.loadError"));
    return;
  }

  const byFeature = new Map((summary.features || []).map((f) => [f.feature, f]));
  list.replaceChildren();
  FEATURES.forEach((key, index) => {
    const feature = byFeature.get(key);
    if (feature) list.appendChild(buildRow(feature, index));
  });
  if (!list.children.length) {
    showMessage(list, t("aiUsage.loadError"));
  }
}
