// The Pantry's use tally — Phase 3 of the Pantry redesign.
//
// One record per saved meal: how many times it has actually been logged, when
// it was last logged, and a histogram over the day-parts it tends to be logged
// in. Two things read it: the "wear" treatment (a frequently-logged card gains
// visual presence) and the time bands (Mornings / Middays / Evenings), which
// are derived from the user's own behaviour rather than anything they set.
//
// WHY THIS IS ON THE DEVICE. state.logs only reaches back `retention_days`
// (7), so "you've logged this 41 times" cannot come from it — the number has
// to be persisted somewhere. The concept doc's phased answer was to prove the
// idea with an IndexedDB tally first and graduate to two columns on
// saved_meals only if it earns it. The honest cost, stated rather than
// discovered later: this is per-device, so a second phone opens an unworn,
// ungrouped Pantry. Graduating later is additive (seed the columns from
// whichever device has the richer local tally), not a rewrite.
//
// WHY THERE IS AN IN-MEMORY MIRROR. app.js's render() is synchronous and runs
// on every state mutation; it cannot await IndexedDB. So the store is read
// once at boot into `cache`, every write updates both, and all the read
// helpers below are synchronous and safe to call from inside a render.

import { bumpSavedMealStat, deleteSavedMealStat, getSavedMealStats, putSavedMealStat } from "./db.js";

// ---------------------------------------------------------------------------
// Day parts
// ---------------------------------------------------------------------------
// Three buckets, not the four the concept doc first sketched. The bands these
// feed are Mornings / Middays / Evenings plus "Anytime", and Anytime is a
// FALLBACK for "no part dominates" — it is computed, never recorded. A fourth
// stored bucket (a "night" split out of the evening) would be data nothing
// could read, so the evening bucket simply runs to the small hours: a 1am
// snack belongs to the end of the day it felt like, not the start of the next.
// Boundaries are exhaustive — every hour of the clock lands in exactly one.
export const DAY_PARTS = ["morning", "midday", "evening"];
const MORNING_START_HOUR = 5;
const MIDDAY_START_HOUR = 11;
const EVENING_START_HOUR = 17;

export function dayPartIndex(date = new Date()) {
  const hour = date.getHours();
  if (hour >= MORNING_START_HOUR && hour < MIDDAY_START_HOUR) return 0;
  if (hour >= MIDDAY_START_HOUR && hour < EVENING_START_HOUR) return 1;
  return 2; // 17:00–04:59
}

// ---------------------------------------------------------------------------
// Thresholds. All four are the whole policy of this feature, so they live
// together and are named rather than inlined.
// ---------------------------------------------------------------------------

// A single log is an occasion, not a pattern. Below this a meal has no band at
// all and sits in Anytime, however lopsided its one data point looks.
const MIN_LOGS_FOR_BAND = 2;
// More than half its logs must fall in one part for that part to claim it.
// Anything more relaxed puts a genuinely all-day food in a band it will then
// look wrong in.
const BAND_DOMINANCE = 0.5;
// How many meals must have earned a real band before the library switches from
// one plain list to grouped bands. Below this, banding would mean a screen of
// mostly-empty headers over an "Anytime" pile — strictly worse than the flat
// list it replaced, and the first thing a new user would see.
const MIN_BANDED_ITEMS_TO_GROUP = 4;
// Wear tiers. Tier 3 is deliberately hard to reach: it should mean "this is
// genuinely one of the things I live on", and a threshold anyone clears in a
// week would make every card look the same again for the opposite reason.
const WEAR_TIER_2_AT = 10;
const WEAR_TIER_3_AT = 25;

// ---------------------------------------------------------------------------
// The monthly rotation card (Phase 5) summarises the PREVIOUS COMPLETE month,
// never the one in progress. Past tense is what makes it a moment rather than
// a scoreboard: a settled month can be reflected on, whereas a running total
// that ticks up as you log is just another live stat, and a live stat that
// names a "top" meal is exactly the ranking this card must not be.
//
// Three gates, because the sentence has to be TRUE, not just renderable.
// "August ran on your saved meals" is an overclaim on four logs, and "X did
// the heavy lifting — once" is absurd. Below any of these the card simply
// does not exist, which is the "not yet" state: nothing empty, nothing
// awkward, just a list that ends where it ended before.
const MIN_MONTH_LOGS = 8; // roughly twice a week
const MIN_MONTH_MEALS = 2; // "meals" plural has to mean something
const MIN_TOP_MEAL_LOGS = 3; // enough to have actually carried anything
// Current month + the two behind it. Only the previous month is ever shown,
// so this is one spare — enough that a user who does not open the app for a
// few weeks still finds their summary waiting rather than pruned away.
const MONTHS_KEPT = 3;

// "YYYY-MM" in LOCAL time, deliberately not UTC: a 23:00 log in Bucharest
// belongs to the month the user was living in, not to the next one.
export function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function previousMonthKey(now = new Date()) {
  return monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let cache = new Map(); // mealId -> { count, lastLoggedAt, parts: number[] }
let loaded = false;

// Awaited once near boot. Safe to call repeatedly; only the first call reads.
export async function loadSavedMealStats() {
  if (loaded) return;
  const rows = await getSavedMealStats();
  cache = new Map(rows.map((r) => [r.mealId, r]));
  loaded = true;
}

// Synchronous — see the module header for why the render path needs that.
export function statsFor(mealId) {
  return cache.get(mealId) || null;
}

export function logCountFor(mealId) {
  return cache.get(mealId)?.count || 0;
}

// The single write. Updates the mirror optimistically so the very next render
// already shows the incremented count, then persists; a failed write leaves
// the mirror ahead by one until the next reload, which is a better failure
// than a count that visibly refuses to move when you just logged something.
export async function recordSavedMealUse(mealId, when = new Date()) {
  if (!mealId) return;
  const partIndex = dayPartIndex(when);
  const existing = cache.get(mealId);
  const parts = DAY_PARTS.map((_, i) => Number(existing?.parts?.[i]) || 0);
  parts[partIndex] += 1;
  const key = monthKey(when);
  const months = { ...(existing?.months || {}) };
  months[key] = (Number(months[key]) || 0) + 1;
  cache.set(mealId, { mealId, count: (existing?.count || 0) + 1, lastLoggedAt: when.getTime(), parts, months });
  await bumpSavedMealStat(mealId, { partIndex, partCount: DAY_PARTS.length, monthKey: key, monthsKept: MONTHS_KEPT });
}

// Undoing a log has to undo the tally too, or an accidental tap permanently
// inflates a count the user never meant to make — the wear treatment would
// then be reporting something that did not happen.
export async function unrecordSavedMealUse(mealId, when = new Date()) {
  if (!mealId) return;
  const existing = cache.get(mealId);
  if (!existing) return;
  const partIndex = dayPartIndex(when);
  const parts = DAY_PARTS.map((_, i) => Number(existing.parts?.[i]) || 0);
  parts[partIndex] = Math.max(0, parts[partIndex] - 1);
  const count = Math.max(0, (existing.count || 0) - 1);
  // The month bucket rolls back against the SAME timestamp the increment
  // used, so an undo that crosses midnight on the 1st still decrements the
  // month the log was actually made in.
  const key = monthKey(when);
  const months = { ...(existing.months || {}) };
  if (months[key]) {
    months[key] = Math.max(0, months[key] - 1);
    if (!months[key]) delete months[key];
  }
  const row = { mealId, count, lastLoggedAt: existing.lastLoggedAt, parts, months };
  if (!count) cache.delete(mealId);
  else cache.set(mealId, row);
  // A row that has fallen back to zero is deleted rather than stored as a
  // zero: "never logged" and "logged once, then undone" are the same fact.
  if (!count) await deleteSavedMealStat(mealId);
  else await putSavedMealStat(row);
}

export async function forgetSavedMealStat(mealId) {
  cache.delete(mealId);
  await deleteSavedMealStat(mealId);
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

// 0 = never logged (no count, no tint), 1/2/3 = rising presence.
export function wearTier(count) {
  if (!count) return 0;
  if (count >= WEAR_TIER_3_AT) return 3;
  if (count >= WEAR_TIER_2_AT) return 2;
  return 1;
}

// "morning" | "midday" | "evening" | "anytime". Anytime is both "not enough
// history yet" and "genuinely eaten at all hours" — deliberately the same
// bucket, because to the user they read the same way ("no particular time")
// and splitting them would put an empty-ish "not sure yet" header on screen.
export function bandFor(mealId) {
  const stats = cache.get(mealId);
  if (!stats) return "anytime";
  const parts = stats.parts || [];
  const total = parts.reduce((sum, n) => sum + (Number(n) || 0), 0);
  if (total < MIN_LOGS_FOR_BAND) return "anytime";
  let bestIndex = 0;
  parts.forEach((n, i) => {
    if ((Number(n) || 0) > (Number(parts[bestIndex]) || 0)) bestIndex = i;
  });
  return (parts[bestIndex] || 0) / total > BAND_DOMINANCE ? DAY_PARTS[bestIndex] : "anytime";
}

// Whether the library has earned grouping at all. Counts meals that resolved
// to a REAL band — an Anytime pile is not evidence of a pattern.
export function shouldGroupIntoBands(mealIds) {
  let banded = 0;
  for (const id of mealIds) {
    if (bandFor(id) !== "anytime") banded += 1;
    if (banded >= MIN_BANDED_ITEMS_TO_GROUP) return true;
  }
  return false;
}

// Test seam — lets the browser harness install a known history without having
// to tap a card fifty times. Not used by the app itself.
export function __replaceCacheForTesting(rows) {
  cache = new Map(rows.map((r) => [r.mealId, r]));
  loaded = true;
}

// ---------------------------------------------------------------------------
// Monthly rotation
// ---------------------------------------------------------------------------

// Returns { monthKey, year, monthIndex, totalLogs, mealCount, topMealId,
// topCount } for the previous complete month, or null when that month does not
// clear the gates above. Null is the ONLY "not yet" signal callers need — see
// each threshold's reasoning.
//
// `liveMealIds` filters to meals the user still has saved: summarising a month
// around a meal they have since deleted would name something they cannot see,
// look for, or log again.
export function monthlyRotation(liveMealIds, now = new Date()) {
  const key = previousMonthKey(now);
  const live = liveMealIds ? new Set(liveMealIds) : null;

  let totalLogs = 0;
  let mealCount = 0;
  let topMealId = null;
  let topCount = 0;

  for (const [mealId, stats] of cache) {
    if (live && !live.has(mealId)) continue;
    const n = Number(stats?.months?.[key]) || 0;
    if (!n) continue;
    totalLogs += n;
    mealCount += 1;
    if (n > topCount) {
      topCount = n;
      topMealId = mealId;
    }
  }

  if (totalLogs < MIN_MONTH_LOGS || mealCount < MIN_MONTH_MEALS || topCount < MIN_TOP_MEAL_LOGS) return null;

  const [year, month] = key.split("-").map(Number);
  return { monthKey: key, year, monthIndex: month - 1, totalLogs, mealCount, topMealId, topCount };
}
