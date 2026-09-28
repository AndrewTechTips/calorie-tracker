# Iron Log — Workouts Overhaul (`README_upgrade.md`)

**Status:** strategic plan, pre-implementation. Nothing in here has been built.
**Scope:** the entire Workouts surface — the Diary, the Weekly Plan Builder, exercise search, the
calendar, the calorie-burn engine, and a new Cardio module.
**Date:** 2026-09-28
**Author's note on method:** every bottleneck below is a claim about *this* codebase with a file and
line behind it, not a generic UX checklist. Where I measured something (round trips, tap counts,
catalog sizes) the number is stated. Where I am proposing rather than reporting, it says so.

---

## 0. Verdict up front

The Workouts module is not a weak feature — it is a **strong feature with a broken front door and no
cardio**. The data model is sound, the MET math is honest and unit-tested, the ghost values and 1RM
tracking are genuinely good product instincts, and `exerciseSearch.js` has already been fixed once
with real care. The problems are concentrated in four places:

1. **It is buried three navigation layers deep** and shares a bottom-nav tab with nothing. A user
   who wants to log a set taps 5 times and types twice, and 3 of those 5 taps are pure navigation.
2. **The logging loop is the slowest write path in the app** — 6 sequential Supabase round trips per
   set, no optimistic update, no offline queue — in the one room in a user's life that reliably has
   no signal: a gym basement.
3. **Cardio effectively does not exist.** There is no cardio UI at all. The only way to log cardio
   today is the Damage Control "Move it" button, which hardcodes one activity string. The MET table
   has 12 entries and no concept of incline, speed, resistance level, or step rate — which is
   exactly the information that determines the answer on the machines the user named.
4. **The visual layer under-delivers on data it already has.** The exercise catalog fetches and
   filters *on* images (`exercise_cache_service.py` rejects every exercise without one), the CSP
   already allows `https://wger.de` as an image source — and the picker renders text only.

Everything below follows from those four.

---

## 1. Current-state inventory

### Backend

| File | Lines | Role |
|---|---|---|
| `backend/routers/workouts.py` | ~300 | Session/set REST surface. 9 routes. |
| `backend/routers/routines.py` | ~180 | Routine templates + weekday assignment. 7 routes. |
| `backend/services/workout_service.py` | ~200 | All calorie math. Pure, no I/O, unit-tested. |
| `backend/services/exercise_cache_service.py` | ~240 | wger.de bulk fetch + in-memory fuzzy search. |
| `backend/tests/test_workout_service.py` | — | MET/RPE/duration math. |
| `backend/tests/test_exercise_cache_service.py` | — | Fuzzy-match scoring. |

Tables (`sql/schema.sql`): `workout_sessions`, `workout_sets`, `workout_routines`,
`weekly_plan_days`, plus the superseded-but-retained `workout_logs` and its one-time migration.

### Frontend

| File | Size | Role |
|---|---|---|
| `frontend/js/workoutDiary.js` | 35 KB | Calendar, day detail, active session, set entry, rest timer, RPE, 1RM, PR celebration. Everything. |
| `frontend/js/routines.js` | 20 KB | Weekly Plan Builder (separate fullscreen view). |
| `frontend/js/exerciseSearch.js` | 14 KB | Shared debounced search controller used by both. |
| `frontend/js/exerciseI18n.js` | 16 KB | EN↔RO exercise-name dictionary + `MUSCLE_GROUPS`. |
| `frontend/js/oneRepMax.js` | 3 KB | Epley-family estimator + series reducer. |
| `frontend/js/progress.js` | (partial) | `computeMuscleHeatmap` / `renderMuscleHeatmap`, 6 bars. |

CSS: 171 `wd-`-prefixed occurrences inside a single 16,793-line `style.css`.

### What is genuinely good and must survive the overhaul

State these explicitly so the rebuild does not throw them out:

- **Ghost values** (`applyGhostValues`, `workoutDiary.js`). "What did I lift last time," read
  synchronously out of already-resident memory, zero network. The right answer, implemented the
  right way.
- **RPE-scaled MET** (`rpe_effort_scale`). A defensible, documented, clamped effort multiplier.
- **Estimated 1RM + PR confetti.** The one dopamine moment the module already has, and it fires on a
  real condition (`priorBest != null && newEst > priorBest`), not on every set.
- **The rest timer's absolute-end-timestamp design.** Self-corrects across a locked screen instead of
  drifting. Compositor-only progress fill. Do not touch this; it is already correct.
- **`exerciseSearch.js`'s custom-exercise flow.** Escape hatch first in the list, then a
  muscle-group step so a custom exercise still lands on a heatmap bar. Keep the flow, restyle it.
- **The category snapshot on `workout_sets.category`.** Denormalised on purpose so the exercise
  library changing shape later cannot retroactively break old MET lookups.
- **`_503_if_not_migrated`.** The right failure mode for a feature whose tables may not exist.

---

## 2. Bottleneck analysis

### A. Discoverability: Workouts is a third-class citizen (highest severity)

The bottom nav has four tabs: Dashboard, Progress, Discover, Saved meals (`index.html:1512-1528`).
Workouts is not one of them. The real path to logging a set:

```
Bottom nav → Progress
  → tap "Training" bento tile               (opens #progress-detail-sheet, DETAIL_CONFIG.training)
    → scroll to the Training section
      → tap "Open Diary"                    (#workout-diary-open-btn, index.html:4275)
        → #workout-diary-view opens fullscreen
          → tap "Start workout"             (#wd-start-workout-btn)
            → search + tap an exercise
              → type weight, type reps
                → tap "+ Add set"
```

Three of those steps are navigation through surfaces that tell the user nothing about training. And
the Weekly Plan Builder is a *sibling* fullscreen view reached by a *second* button in the same
buried block (`#plan-builder-open-btn`) — so the two halves of one mental model ("what should I do" /
"what did I do") are peers that can never be seen together.

**This is the single biggest cause of the "clunky, hard to navigate" complaint.** No amount of polish
inside `#workout-diary-view` is visible to a user who never reaches it.

### B. The logging loop is the app's slowest write, in its worst network environment

**Six sequential Supabase round trips per logged set.** Tracing `POST /workouts/sessions/{id}/sets`:

| # | Call | Source |
|---|---|---|
| 1 | `_fetch_session_or_404` | `workouts.py` |
| 2 | `_fetch_sets` (to compute `set_number`) | `workouts.py` |
| 3 | `insert` the set | `workouts.py` |
| 4 | `_fetch_sets` **again** | `_recompute_and_save` |
| 5 | `_get_latest_weight_kg` | `_recompute_and_save` |
| 6 | `update` the session's `calories_burned` | `_recompute_and_save` |

Each crosses the public internet on a 10s httpx timeout (`database.py`). A 25-set workout is **150
round trips.** Calls 2 and 4 are the same query. Call 5 fetches a bodyweight that cannot change
between sets.

**No optimistic update.** `submitSet` does `const session = await api.addWorkoutSet(...)` and only
then renders. `CLAUDE.md` documents optimistic updates as a deliberate architectural rule for food
and water — "do not 'simplify' a mutation back to await-then-render." Set logging is the *most*
rapid-fire interaction in the app (between rest periods, one-handed, phone half-sweaty) and it is the
one mutation that waits.

**No offline support at all.** `db.js` has ten IndexedDB stores; none is for workouts. The offline
write queue (`enqueueWrite`) handles exactly two types: `createLog` and `addWater`. A gym with no
signal means every set fails with an error toast. This is arguably a correctness bug, not a polish
item — the primary use environment for this feature is the one environment it does not work in.

**The calendar rebuilds itself after every set.** `submitSet` calls `renderCalendar()`
(`workoutDiary.js:667`), which `replaceChildren`s all 42 day buttons, attaches 42 fresh listeners,
and replays the `wd-cal-day-in` entrance animation (`style.css:15564`, 0.28s, opacity 0→1 +
scale 0.82→1) on all of them. The module's own comment above `updateCalendarSelection()` documents
this exact flash and fixed it — **for date selection only.** The hot path (add set / delete set /
finish / delete session — 5 more call sites) still takes the full rebuild. And it is entirely wasted
work: the only thing the calendar shows is a dot per date *with a session*, and adding a set to an
existing session never changes that set.

### C. Exercise search: a good controller starved of data and pictures

- **The catalog is truncated at the source.** `_PAGES_TO_FETCH = 2` × `_PAGE_SIZE = 200` → ~400 of
  the 833 English exercises wger actually has (the service's own comment confirms 833). Half the
  library is unreachable, by a constant.
- **Then it is truncated again by an image filter that buys nothing.** `passes_filters` returns
  `False` for any exercise with no `image_url`. The reasoning in the comment is sound *if the image
  is shown*. It is not: `buildResultButton` (`exerciseSearch.js`) renders name + category only. So
  the filter shrinks the catalog to pay for a visual that never renders — while `img-src` in the CSP
  already allows `https://wger.de` (`index.html:114`) and the payload already carries the URL.
- **Then it is truncated a third time in the UI.** `MAX_VISIBLE_RESULTS = 6`, with a "narrow your
  query" hint. Defensible on a phone — but three stacked truncations (833 → ~400 → image-filtered →
  6) means the effective catalog is far smaller than anyone reading the code would assume.
- **Search is a text field with a 400 ms debounce and nothing else.** No muscle filter, no equipment
  filter, no "recent," no "favourites" — despite the backend already accepting `muscle` and
  `equipment` params (`discover.py:298`) and the exercise payload already carrying both. In practice
  a lifter cycles through the same 15–25 movements forever; making them retype "bench" every session
  is the friction, not the search quality.
- **Typing is required to start.** An empty query returns the curated `POPULAR_EXERCISES` list, which
  is good, but the field is focused on open (`showExercisePicker` calls `.focus()`), so the keyboard
  covers half the screen before the user has decided anything.

### D. The calendar answers a question nobody asked

A month grid of 42 cells whose only per-day information is *one binary dot*. For a training log, the
month view is the wrong default zoom:

- It cannot show **what** was trained (push/pull/legs), which is the thing a lifter actually scans
  for when deciding today's session.
- It occupies the top of the view — the most valuable real estate — to tell the user something they
  mostly already know.
- It is the reason the "start a workout" action is two taps deep (select date → Start workout) when
  99% of sessions are today.

### E. Cardio: absent, and the MET table cannot support it

There is **no cardio UI**. The only cardio entry point in the entire app is
`damageControl.js:267` → `openWorkoutForMoveIt({ activity, durationMinutes })` → `app.js:7594` →
`POST /workouts/sessions` with a single hardcoded activity string.

`CARDIO_MET_BY_ACTIVITY` (`workout_service.py`) has 12 flat entries: walk, brisk walk, power walk,
jog, run, cycling, bike, swim, row, elliptical, hike, jump rope. Against the machines the brief names:

| Requested | Present? | Why the flat MET cannot answer it |
|---|---|---|
| Incline treadmill at a set speed | No | A flat `run: 9.8` ignores both speed and grade — the two variables that *are* the answer. 6 km/h at 12% incline and 12 km/h at 0% are wildly different and both map to one number here. |
| Stairmaster | No | Falls to `CARDIO_DEFAULT_MET = 4.3` (a brisk walk). Real stepping is 8–12 METs. **Roughly a 2.5× undercount.** |
| Stepper / step mill | No | Same 4.3 fallback. Step height and step rate are the determining inputs and neither exists. |
| Stationary bike | `bike: 7.5` | Ignores resistance/watts entirely. 50 W and 200 W score identically. |
| Rowing machine | `row: 7.0` | Ignores pace/watts. A 2:30/500m pace and a 1:50/500m pace score identically. |

And the estimate is **computed once at session creation and never recomputed** — the router's own
comment notes "nothing else ever recomputes it." A typo in the duration is uncorrectable.

**The structural point:** flat METs are the right tool for *unquantified* activity ("I went for a
walk"). They are the wrong tool for a **machine that displays its own settings.** When a user can
read speed, incline, resistance, and step rate off a console, the app should use those numbers — and
the standard, published way to do that is the ACSM metabolic equations, not a lookup table. This is
the single highest-value new capability in the whole overhaul, because it is the one place where the
app can be *measurably more accurate than its competitors* rather than merely prettier.

### F. Two honesty problems in the strength calorie math

Worth fixing while the engine is open, because both are user-visible:

1. **Set count does not affect a finished session's burn.** `estimate_session_calories` computes
   `avg_MET × weight × duration_hours`. Once `ended_at` is set, duration is real elapsed time — so a
   90-minute session with 30 hard sets and a 90-minute session with 4 sets and a lot of phone-scrolling
   produce **the same number**. The in-progress estimate (set count × 90s) is actually more honest
   than the finished one. Density needs to enter the formula.
2. **Gross vs. net is never distinguished.** MET × kg × h is *gross* energy expenditure, including
   the resting metabolism that would have happened on the couch. Every figure the app shows is
   therefore inflated by roughly 1 MET × duration (~70–110 kcal/hour). `analytics_service.py` already
   has `calculate_bmr`, so the app has everything it needs to show a net figure or to label the gross
   one honestly. This is the same "unverified vs. verified zero" discipline the nutrition side
   already applies — it should apply here too.

### G. The dopamine layer is thin and the visual layer is inconsistent

- Only **one** celebration exists (a 1RM PR). There is nothing for finishing a session, hitting a
  volume record, completing a planned routine, extending a streak, or covering every muscle group in
  a week — all of which are already computable from data in memory.
- Ollie, the app's entire companion/reward mechanic, is **completely absent from Workouts.** He
  reacts to food and water (`petHud.pulseFeed` / `pulseHydrate`) and to nothing a user does in the
  gym. The gamification loop stops at the gym door.
- The muscle "heatmap" is **six horizontal bars** (`progress.js:1984`). It is honest and cheap, but
  it is a bar chart wearing a heatmap's name, and it lives in a different view from the workout
  logging it describes.
- `#workout-diary-view` and `#plan-builder-view` reuse `.progress-card` / `.glass` / `.analytics-stat`
  — Progress's visual vocabulary. Workouts has no identity of its own.

### H. Maintainability: `workoutDiary.js` is nine features in one 35 KB module

Calendar rendering, day detail, session lifecycle, exercise picking, set entry, ghost values, 1RM
charting, PR celebration, and the rest timer all share one module-level mutable state bag (9
`let` variables). Adding cardio to this file would be the wrong move; it needs to be split first.

---

## 3. The target experience

### 3.1 The structural decision: Workouts becomes a first-class tab

**Promote Workouts to the bottom nav.** This is the one change that unlocks every other improvement,
and it is the only way to fix bottleneck A.

The nav has four tabs plus the centre scan button. The proposal:

> **Dashboard · Progress · Train · Discover** — with **Saved meals** moving into the Dashboard's own
> "add food" flow, where it is contextually correct (it is a food-entry shortcut, not a destination),
> or into Discover alongside the recipe catalog.

**DECIDED (D1): Train replaces Saved meals. No 5th tab.** The rationale, recorded so it is not
reopened: Saved Meals is a
*shortcut*, reached when you already intend to log food. Training is a *destination*, visited with
its own intent, on a schedule, several times a week. Destinations earn tabs; shortcuts earn placement
inside the flow they shortcut. The 5th-tab fallback was considered and **rejected** by the product owner: it would break the
nav's four-plus-centre-button symmetry. Saved meals' new home is task 1.2, with an explicit ship gate
— still reachable in two taps or fewer from the Dashboard.

### 3.2 The new Train tab: one view, three zones, no calendar at the top

Replace *both* `#workout-diary-view` and `#plan-builder-view` with a single scrollable Train view.
"What should I do" and "what did I do" are not two mental models that need two surfaces — they are
**today** and **history**, and today comes first.

```
┌─────────────────────────────────────────┐
│  TRAIN                          [ ⚙ ]   │
│                                         │
│  ╔═══════════════════════════════════╗  │  ZONE 1 — TODAY (the hero)
│  ║  MONDAY · PUSH DAY                ║  │  Three states, one card:
│  ║                                   ║  │
│  ║  Bench · Incline DB · OHP · Dips  ║  │  (a) PLANNED  → "Start Push Day"
│  ║                                   ║  │  (b) IN PROGRESS → live volume /
│  ║     ┌───────────────────────┐     ║  │      elapsed / sets, "Continue"
│  ║     │   ▶  START PUSH DAY   │     ║  │  (c) DONE → summary + Ollie's line
│  ║     └───────────────────────┘     ║  │
│  ║                                   ║  │  Rest day → "Rest day. Log
│  ║  [ Free session ]  [ + Cardio ]   ║  │  something anyway?" + both buttons
│  ╚═══════════════════════════════════╝  │
│                                         │
│  ─── THIS WEEK ─────────────────────    │  ZONE 2 — THE WEEK STRIP
│   M   T   W   T   F   S   S             │  7 cells, horizontal, always visible.
│  ███ ███  ·  ███  ▢   ·   ·             │  Each cell shows the TRAINED SPLIT,
│  Psh Pul     Leg Psh                    │  not a dot. Tap = that day's detail.
│                                         │  Tap-and-hold = assign a routine.
│  ─── YOUR BODY ─────────────────────    │
│  ╔═══════════════════════════════════╗  │  ZONE 3 — THE MUSCLE MAP
│  ║      front  ◉ ───── ◯  back       ║  │  Inline SVG, front/back toggle.
│  ║         [ figure, muscle          ║  ║  Fill intensity = 7-day set count.
│  ║           groups tinted by        ║  ║  Tap a muscle → that group's
│  ║           7-day volume ]          ║  ║  exercises + "last trained N days".
│  ║                                   ║  │  Replaces the 6-bar heatmap and
│  ║  Neglected: Legs, Core            ║  │  moves it next to the logging.
│  ╚═══════════════════════════════════╝  │
│                                         │
│  ─── HISTORY ───────────  [Calendar ▸]  │  Month calendar becomes a
│  Recent sessions, newest first          │  SECONDARY, opt-in view — not the
│  ...                                    │  default zoom.
└─────────────────────────────────────────┘
```

**Taps to first set, planned day: 2** (Train → Start Push Day → set entry is already on screen with
the first exercise pre-selected and ghost values loaded). Down from 5 plus 2 text entries.

**Why the week strip replaces the month grid as the default.** Seven cells can each carry a *label*
(the split trained), where 42 cells can only carry a dot. The week is also the actual planning unit —
`weekly_plan_days` is keyed by weekday, and `compute_week_adherence` already exists. The month
calendar keeps every bit of its current code and moves behind a "Calendar" affordance for the user
who genuinely wants to scan backwards.

### 3.3 The active session: a full-screen logger, not a card inside a scroll

Today the active session is `<section id="wd-active-session">` — a card in a scrolling page, below a
calendar, which the code has to `scrollIntoView` into place. During a workout the phone should show
**only** the thing being logged.

```
┌─────────────────────────────────────────┐
│ ✕  PUSH DAY            18:24    ⏱ 1:30  │  Persistent header: elapsed + rest
├─────────────────────────────────────────┤  timer live in the SAME bar.
│  ●━━━━━○━━━━━○━━━━━○                    │  Exercise rail: horizontal, swipeable,
│  Bench  Inc   OHP   Dips                │  done/current/pending. Swipe between
│                                         │  exercises — no "Change exercise" trip
│  BARBELL BENCH PRESS                    │  back to a search box.
│  Last time: 80kg × 8                    │
│  Est. 1RM 102kg  ▁▂▃▅▆  ↑ +4kg          │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ #1   80 kg × 8    RPE 7      ✓    │  │  Logged sets. Tap to edit inline.
│  │ #2   80 kg × 8    RPE 8      ✓    │  │
│  └───────────────────────────────────┘  │
│                                         │
│   ┌─────────┐  ┌─────────┐              │  Big numeric fields, thumb-height.
│   │  80 kg  │  │  8 reps │              │  Steppers (±2.5kg / ±1 rep) so the
│   │  −  +   │  │  −  +   │              │  common case needs no keyboard at all.
│   └─────────┘  └─────────┘              │
│   RPE  ① ② ③ ④ ⑤ ⑥ ⑦ ⑧ ⑨ ⑩            │
│                                         │
│  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │  One thumb-reachable primary action,
│  ┃         LOG SET  ✓                ┃  │  bottom of screen. Fires optimistically:
│  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │  row appears + haptic + rest timer
└─────────────────────────────────────────┘  starts BEFORE the network resolves.
```

Key changes, each tied to a bottleneck:

- **Steppers on weight and reps** (B, plus accessibility). Set-to-set, weight usually repeats and
  reps drift by one. A ±2.5 kg / ±1 rep stepper turns the common case into one tap and removes the
  keyboard entirely — which is also the single biggest accessibility win available here, for anyone
  with reduced fine motor control or who simply cannot read 14px labels in gym lighting.
- **Optimistic logging** (B). The set row, the haptic, and the rest timer must all fire before the
  request resolves, reconciling on response and rolling back with a toast on failure — exactly the
  pattern `app.js`'s `insertOptimisticLog` already establishes.
- **A swipeable exercise rail** instead of "Change exercise → back to search." The session's
  exercises are known at start (from the routine) or accumulated (free session); moving between them
  should never revisit a search box.
- **The rest timer moves into the header.** Today it is absolutely positioned over the view
  (`#wd-rest-timer`), overlapping content. In the header it is always visible and never occludes.

### 3.4 Exercise search: filter first, type last

```
┌─────────────────────────────────────────┐
│  ADD EXERCISE                       ✕   │
│  ┌───────────────────────────────────┐  │
│  │ 🔍  Search…                       │  │  NOT auto-focused. The keyboard
│  └───────────────────────────────────┘  │  appears when the user asks for it.
│                                         │
│  RECENT                                 │  ← NEW. From sets already in memory.
│  [Bench Press] [Squat] [Lat Pulldown]   │    Covers the 80% case in one tap.
│                                         │
│  MUSCLE    Chest Back Legs Sho Arms Core│  ← NEW. Backend already accepts
│  GEAR      Barbell Dumbbell Machine BW  │    `muscle` + `equipment` params.
│                                         │
│  ┌───┐ Barbell Bench Press              │  ← Images. Already fetched, already
│  │img│ Chest · Barbell        80kg×8 ▸  │    CSP-allowed, already filtered FOR.
│  └───┘                                  │    Plus each exercise's own last-lift.
│  ┌───┐ Incline Dumbbell Press           │
│  │img│ Chest · Dumbbell       30kg×10▸  │
│  └───┘                                  │
│                                         │
│  + Create "incline machine press"       │  ← Keep exactly as built. It works.
└─────────────────────────────────────────┘
```

Four changes: **Recent** chips (pure client-side, from `allSetsFlat()`), **muscle + equipment
filters** (backend already supports them), **images** (already in the payload), and **each row
showing your own last lift for that movement** (already in memory). Three of the four require no new
backend work at all. And `_PAGES_TO_FETCH` rises from 2 to cover the full 833-entry catalog, at which
point the image filter can be relaxed to a placeholder-icon fallback instead of an exclusion.

### 3.5 The Cardio module

A first-class sibling to strength logging, reached from the Today card's `+ Cardio` button.

```
┌─────────────────────────────────────────┐
│  LOG CARDIO                         ✕   │
│                                         │
│  🏃 Treadmill   🪜 Stairmaster          │  Machine first — because the machine
│  🚴 Bike        🚣 Rower                │  determines which inputs matter.
│  🏃 Elliptical  🪜 Step mill            │
│  🚶 Outdoor walk / run   ➕ Other       │
├─────────────────────────────────────────┤
│  TREADMILL                              │
│                                         │
│  Speed      ◀   6.0 km/h   ▶            │  Inputs match the CONSOLE, because
│  Incline    ◀    8.0 %     ▶            │  that is what the user is reading.
│  Duration   ◀    32 min    ▶            │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │  ≈ 318 kcal            8.4 METs   │  │  LIVE, updating as they adjust.
│  │  net · 74 kg · ACSM walking eq.   │  │  Shows its own provenance: net vs
│  └───────────────────────────────────┘  │  gross, the bodyweight used, and
│                                         │  WHICH equation produced it.
│  Intervals?  [ + Add a segment ]        │  Optional: warm-up / work / cool-down
│                                         │  as separate rows, summed.
│  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│  ┃           LOG CARDIO              ┃  │
│  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
└─────────────────────────────────────────┘
```

Per-machine input sets:

| Machine | Inputs | Equation |
|---|---|---|
| Treadmill | speed, incline %, duration | ACSM walking (< 6.4 km/h) or running (≥ 6.4) |
| Stairmaster / step mill | steps/min **or** floors/hour, duration | ACSM stepping |
| Stationary bike | watts **or** resistance level + RPM, duration | ACSM leg ergometry |
| Rower | watts **or** /500m split, duration | Concept2-style power → VO₂ |
| Elliptical | resistance, incline, duration | MET band (honest: no published equation) |
| Outdoor walk/run | distance + duration (→ pace), incline optional | ACSM walking/running |
| Other | free text + duration | Existing flat MET table |

**The last row matters as much as the first six.** The elliptical has no published metabolic
equation, so the app should say "estimate" there and not fake a precision it does not have — the same
discipline `nutrition_db_service.lookup()` applies when it omits a nutrient rather than defaulting it
to zero.

---

## 4. Architecture changes

### 4.1 Backend: split the calorie engine in two

`workout_service.py` stays as-is for strength. Cardio gets its own module, because the math is a
different *kind* of math and mixing them would bury both.

```
backend/services/
├── workout_service.py       ← unchanged responsibility: strength MET/RPE/duration
└── cardio_service.py        ← NEW. Pure, deterministic, no I/O, fully unit-testable.
                               Same shape as trends_service / workout_service:
                               the router does Supabase, this does math.
```

**`cardio_service.py`'s contract.** One public function per machine, plus a dispatcher:

```
estimate_cardio(machine, params, weight_kg, duration_minutes, *, net=True)
    -> CardioEstimate(kcal, met, vo2_ml_kg_min, equation_id, is_estimate)
```

Returning the provenance (`equation_id`, `is_estimate`) alongside the number is the point — the UI
shows "ACSM walking eq." or "estimate," and the honesty is carried in the data rather than
hardcoded in copy.

**The equations.** These are the published ACSM metabolic equations, the standard reference for
exactly this problem. VO₂ is in ml·kg⁻¹·min⁻¹; speed `S` in m/min; grade `G` as a decimal fraction.

| Machine | Equation |
|---|---|
| Walking (< ~107 m/min) | `VO₂ = 0.1·S + 1.8·S·G + 3.5` |
| Running (≥ ~107 m/min) | `VO₂ = 0.2·S + 0.9·S·G + 3.5` |
| Stepping | `VO₂ = 0.2·f + 1.33 · 1.8 · h · f + 3.5`  (f = steps/min, h = step height in m) |
| Leg ergometry | `VO₂ = 1.8 · (W·6.12) / kg + 3.5 + 3.5`  (W = watts) |
| Rowing | watts → `VO₂ ≈ 1.8 · (W·6.12) / kg + 7`, calibrated against Concept2 split→watts |

Then, for every machine, the same two final steps:

```
kcal_per_min_gross = (VO₂ · kg / 1000) · 5.0          # 5 kcal per litre of O₂
kcal_per_min_net   = ((VO₂ − 3.5) · kg / 1000) · 5.0  # subtract 1 MET of resting
```

Four things this buys that the flat table cannot:

1. **Incline is a real variable.** In the walking equation the grade term `1.8·S·G` carries an 18×
   larger coefficient than the speed term `0.1·S` — which is why a flat `run: 9.8` MET is not merely
   imprecise on an inclined treadmill, it is answering a different question.
2. **Stairmaster stops being a brisk walk.** The stepping equation at a realistic 60 steps/min on
   20 cm steps lands around 8–9 METs against the current 4.3 fallback.
3. **Watts make the bike and rower honest.** Resistance finally matters.
4. **Net vs. gross becomes explicit** (bottleneck F2) via the `− 3.5` term, for cardio *and* — once
   the helper exists — for strength.

**Verification is non-negotiable and is a real deliverable, not a footnote.** The equations must be
pinned in `backend/tests/test_cardio_service.py` against values computed by hand from the published
forms, plus monotonicity properties that catch a sign error a point-check would miss: kcal must rise
with speed at fixed incline, with incline at fixed speed, with watts, with bodyweight, and with
duration; net must always be strictly below gross; and every machine must degrade to a documented
flat-MET fallback rather than raise. **Do not lower an asserted value to make a build pass** — the
same rule `test_retrieval_eval.py`'s floors already carry.

### 4.2 Backend: fix the six round trips

Three changes to `routers/workouts.py`, none of which changes the API surface:

1. **Drop the duplicate `_fetch_sets`.** `add_set` fetches sets to compute `set_number`, then
   `_recompute_and_save` fetches them again. Pass the first result through with the new set appended.
   **6 round trips → 4.**
2. **Cache bodyweight per request.** `_get_latest_weight_kg` cannot change between two sets of one
   session. Resolve it once and pass it down. **4 → 3.**
3. **Consider a Postgres function for the recompute.** Insert + recompute + update in one round trip
   is achievable as an RPC. This is a genuine trade — it moves math out of the tested Python module
   into SQL the test suite cannot reach, and it needs a migration the user must apply by hand. **My
   recommendation: do 1 and 2 (pure Python, no migration, no risk), ship, then measure whether 3 is
   still worth it.** With optimistic updates in place the user never waits on this path anyway, and
   3 pays for correctness confidence with SQL duplication.

### 4.3 Frontend: split `workoutDiary.js`

```
frontend/js/workouts/
├── trainView.js        ← the Train tab: Today card, week strip, history. Composes the rest.
├── session.js          ← active-session lifecycle: start / log / edit / finish. Owns the
│                         optimistic path and the reconcile.
├── setEntry.js         ← the logger UI: steppers, RPE, ghost values, exercise rail.
├── cardio.js           ← NEW. Machine picker, per-machine inputs, live estimate.
├── muscleMap.js        ← NEW. Inline SVG body map. Replaces progress.js's 6 bars.
├── restTimer.js        ← lifted verbatim out of workoutDiary.js. Do not rewrite it.
├── exerciseSearch.js   ← moved, extended with recent/filters/images. Same controller.
└── workoutState.js     ← the one mutable state bag, explicit instead of 9 module-level `let`s.
```

`routines.js` folds into `trainView.js` (its week strip *is* Zone 2) and `plan-builder-view` is
deleted. `oneRepMax.js` and `exerciseI18n.js` stay where they are — both are already pure and
correctly scoped.

**On CSS:** `style.css` is 16,793 lines and Workouts holds 171 `wd-` rules inside it. This overhaul
roughly doubles that. Splitting `style.css` per-feature is a real and worthwhile change — Vite
handles multiple stylesheets natively and hashes each — but it is **not** part of this overhaul.
Bundling a global CSS restructure into a feature rebuild means a regression in either one is
indistinguishable from a regression in the other. Do it as its own change, before or after.

### 4.4 The offline story (bottleneck B, third part)

Two additions, mirroring what food logging already has:

1. **A `workoutSessions` IndexedDB store** in `db.js`, so the Train tab renders from cache on a cold
   offline open exactly as the dashboard snapshot does.
2. **Two new write-queue types** — `addWorkoutSet` and `createWorkoutSession` — alongside the
   existing `createLog` / `addWater`.

`set_number` is the one real wrinkle: it is currently computed server-side from existing sets, so two
sets queued offline for the same exercise would both want the same number. Resolve it the way the app
already resolves optimistic log ids — the client assigns a provisional number for display,
and the server's authoritative number replaces it on flush. The reconcile machinery for this pattern
already exists.

### 4.5 The muscle map (requirement 4)

**Inline SVG, hand-authored, in the JS module. No library, no new CDN entry, no GLB.**

This is the constraint-respecting answer, and the constraints are already documented in this repo:
`script-src` allows only `cdn.jsdelivr.net` and `challenges.cloudflare.com`, adding a third-party
muscle-map library means loosening the CSP for a decorative feature, and the app already carries one
3D asset (`ollie_model.glb`) whose weight is justified by it being the entire companion mechanic. A
body map does not earn a second.

Concretely:

- **Two `<svg>` figures** (front / back), each ~12–14 `<path>` elements, one per muscle group, sharing
  the six `MUSCLE_GROUPS` the data already uses. Total under ~8 KB of markup.
- **Fill driven by a CSS custom property** per group, set from the 7-day set count —
  `--muscle-intensity: 0…1` — so the tint is one style write per group per render, no per-frame work.
  `style-src` already includes `'unsafe-inline'` (`index.html:112`), so this is CSP-clean today.
- **Tap a muscle** → that group's exercises, its set count, and "last trained N days ago."
- **It lives in the Train tab**, next to the logging it describes, and `progress.js`'s
  `renderMuscleHeatmap` is deleted in favour of it. `computeMuscleHeatmap` itself — the pure
  7-day-count function — is kept and moved; it is already correct.
- **Light and dark must both be authored,** not derived. A tint ramp that reads well on dark reads as
  mud on light.
- **Accessibility is not optional here.** Colour intensity alone excludes colour-blind users
  entirely, so every group carries a text label with its set count on tap, and the "Neglected: Legs,
  Core" line (which the current heatmap already produces) stays as the non-visual summary.

**A note on scope honesty:** a *detailed* anatomical map (individual heads of the deltoid, upper vs.
lower lats) is not supportable, because the data cannot support it. `workout_sets.category` holds six
coarse groups. Drawing 30 muscles and tinting them from 6 buckets would be a chart that lies about
its own resolution. Six groups, drawn well, is the honest version — and if per-muscle resolution is
ever wanted, the prerequisite is richer category data on the way in, not a more detailed drawing.

### 4.6 Schema changes

**These must be written here and applied by hand.** Nothing in this repo can execute DDL against
Supabase — there is no `exec_sql` RPC — so `sql/schema.sql` is updated in the repo and the user
pastes it into the Supabase SQL editor. **The feature is not live until they do.** New tables also
need an explicit `grant ... to service_role, authenticated`, or the service-role client returns a
live 500; `weight_logs` and `push_subscriptions` both carry this warning already.

```sql
-- NEW: cardio_sessions. Its own table, not a nullable widening of workout_sets.
--
-- Why separate: a cardio effort has no reps, no weight, no set number, and no
-- RPE-scaled category MET — it has a machine and that machine's own parameters.
-- Widening workout_sets would make six columns nullable-and-meaningless for
-- every strength set ever logged, and would put two different calorie engines
-- behind one row shape. It attaches to the SAME workout_sessions row, so a
-- session can hold lifting and a finisher on the bike and the dashboard's
-- Activity chip / trends / analytics all keep reading one place.
create table if not exists public.cardio_sessions (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  session_id  uuid not null references public.workout_sessions(id) on delete cascade,
  machine     text not null,          -- 'treadmill' | 'stairmaster' | 'bike' | 'rower' | ...
  -- Per-machine console readings. JSONB because the KEYS DIFFER BY MACHINE
  -- (speed/incline vs. steps_per_min vs. watts) and are always read and
  -- written as one whole blob, never filtered on individually — the same
  -- argument workout_routines.exercises already makes for its own JSONB.
  params      jsonb not null default '{}'::jsonb,
  duration_minutes numeric not null check (duration_minutes > 0 and duration_minutes <= 600),
  calories_burned  numeric,
  -- Provenance, so the UI never has to guess and a later equation change is
  -- auditable against rows computed by the old one.
  equation_id text,                   -- 'acsm_walking' | 'acsm_stepping' | 'flat_met' | ...
  is_estimate boolean not null default false,
  logged_at   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists idx_cardio_sessions_session on public.cardio_sessions (session_id);
create index if not exists idx_cardio_sessions_user_time on public.cardio_sessions (user_id, logged_at desc);
grant select, insert, update, delete on public.cardio_sessions to service_role, authenticated;
-- + RLS enable + the same user_id policy every other table here carries.
```

Plus two small additive columns on `workout_sessions`: `total_volume_kg` (cached, so the week strip
and history do not re-sum every set client-side) and `split_label` (the "Push"/"Pull"/"Legs" text the
week strip renders — derived at finish from the session's own categories).

**Retention:** `cardio_sessions` follows `workout_sessions` — kept indefinitely, outside the 7-day
window, for the same reason stated in the schema comment for workouts. It needs **no**
`cleanup_service` entry, and it must **not** be added to one by reflex.

**`routers/account.py`:** `cardio_sessions` cascade-deletes via `session_id`, so `RESET_TABLES` needs
no new entry — but **verify** that rather than assume it, because a missed table in a "reset my
progress" flow is a data-retention bug a user will find.

---

## 5. Roadmap

Six phases. Each ends at a shippable, independently valuable state — no phase leaves the app in a
worse condition than it started, and none depends on a later phase to be coherent.

**Tracking:** these checkboxes are the source of truth for progress. A box is ticked only after the
change is made *and* its ship gate verified — never on "written but untested." Keep this file
updated as each sub-task lands, so progress survives a cleared chat context.

### Phase 0 — Foundations (no user-visible change)

*The de-risking phase. Everything after this is cheaper because of it.*

**Execution order note:** the sub-tasks below are deliberately ordered by *increasing risk* rather
than by the order they were first written down. The backend round-trip fix is isolated and
pytest-verifiable; the `renderCalendar` fix is a handful of surgical lines; the module split is the
largest change but a pure move; offline support builds on the split. Each step is independently
verifiable before the next one starts.

- [x] **0.1 — Collapse the 6 Supabase round trips to 3** (§4.2 items 1–2). Backend only, no API
      surface change. Drop the duplicate `_fetch_sets`; resolve bodyweight once per request.
      **Done.** `POST /sets` went from **6 sequential waits / 6 queries** to **3 sequential waits /
      5 queries**: the three independent reads (ownership check, existing sets, bodyweight) now run
      in one `asyncio.gather` — the same idiom `routers/trends.py` already uses for its own six —
      the set list is built from the insert's own returned row instead of re-reading a table the
      request just wrote to, and `_recompute_and_save` takes optional pre-resolved `sets`/`weight_kg`
      so the callers that genuinely have nothing to hand in (`update_set`/`delete_set`/`finish`)
      also drop from two waits to one. Falls back to a re-read if an insert ever returns no row.
      Guarded by `backend/tests/test_workout_round_trips.py` (15 cases) — count, order, "no read
      after the insert", plus behaviour-neutrality assertions that compute every expected calorie
      figure by calling `workout_service` rather than pinning a literal. **Teeth verified:**
      re-introducing the duplicate read fails 4 of those tests by name.
      *Result: 725 passed / 32 skipped (baseline 710 / 32), 0 failures.*
- [x] **0.2 — Fix the wasted `renderCalendar()` on the set-logging path.** Adding a set cannot change
      a single calendar dot, yet it rebuilds all 42 cells and replays a 0.28s entrance animation.
      **Done.** New `updateCalendarDots()` syncs dots in place — one pass over the existing day
      buttons, adding/removing only what changed — and the six data-mutation call sites (set add,
      set delete, session finish, session create, session delete, undo-restore) now call it instead
      of `renderCalendar()`. The four calls that legitimately need a full rebuild (month nav,
      `selectDate` across a month boundary, `openView`, language change) are untouched. Both it and
      `renderCalendar()` read the dot set from one shared `sessionDateSet()` so they cannot disagree.
      **Verified live** in a real browser against the real module, real `style.css` and the real
      markup lifted from `index.html`, with only the network layer stubbed — see
      `frontend/wd-harness.html`. The grid's day buttons are stamped, the action is performed, and
      the stamps are re-checked: surviving stamps *are* the proof no teardown happened. 16/16 pass,
      including "a new session still adds exactly one dot, on the right date, without a rebuild" and
      "month navigation MUST still rebuild." **Teeth verified:** restoring `renderCalendar()` in
      `submitSet` fails that assertion with `firstStamp=gone`.
- [x] **0.3 — Split `workoutDiary.js` into `frontend/js/workouts/`** per §4.3. Pure moves, no
      behaviour change. `restTimer.js` is lifted **verbatim**.
      **Done.** One 917-line module became ten, plus `exerciseSearch.js` moved in beside them.
      The code was sliced out programmatically rather than retyped, so every function body and
      every comment is the original text; the only edits are imports, exports, and the three seams
      listed below. `workoutDiary.js` is **deleted** — not left as a re-export barrel — and its four
      importers (`app.js`, `progress.js`, `discover.js`, `routines.js`) now point at
      `workouts/index.js`, which is the folder's only public surface.

      | module | lines | role |
      |---|---|---|
      | `workoutState.js` | 86 | date helpers + the shared `state` object + cache helpers. No DOM, no sibling imports — the bottom of the graph. |
      | `card.js` | 66 | the Progress-tab summary card |
      | `calendar.js` | 166 | month grid, dot sync, selection |
      | `sessionView.js` | 223 | day detail + active-session workspace |
      | `setEntry.js` | 127 | the four write actions |
      | `ghostValues.js` | 61 | "what did I lift last time" |
      | `oneRepMaxPanel.js` | 56 | 1RM card + PR celebration |
      | `restTimer.js` | 73 | **verbatim**, untouched |
      | `rpeScale.js` | 53 | the 1-10 picker, owning `selectedRpe` privately |
      | `index.js` | 172 | public surface + all listener wiring |
      | `exerciseSearch.js` | 288 | moved in, import paths re-pointed |

      **Three deliberate seams**, each because the alternative was an import cycle: the nine
      module-level `let`s became one exported `state` object (an imported binding is read-only on
      the importing side, and a mutable-property object is the shape `app.js` already uses);
      `selectDate()`'s two cross-module calls became an `onDateSelected` callback injected by
      `index.js`; and the `exerciseSearch` instance is handed to `sessionView.js` through a setter.
      Same functions, same order, same moment — only the naming moved.

      **Verified:** build green; a static pass confirms **every call in all eleven modules resolves
      to an import or a local declaration** (no orphaned reference the harness happened not to
      execute), and no unused imports remain. The live harness was extended from 16 to **25** cases
      to cover the paths a refactor breaks first — rest timer start/±15/skip, the PR celebration,
      `openWorkoutDiary(prefill)` deep links, `startRoutineToday` routine chips, `deleteSession`'s
      undo toast, `getCachedSets`/`getCachedSessions` (progress.js's read-back), the language-switch
      re-render, and `closeView`. **25/25 pass.**
- [x] **0.4 — Add the `workoutSessions` IndexedDB store and the two write-queue types** (§4.4), so a
      set logged in a no-signal gym flushes on reconnect.
      **Done.** `db.js` goes to `DB_VERSION` 8 with a `workoutSessions` store (one-row blob, same
      shape as the dashboard snapshot) plus `updateQueuedWrite()`, and the queue learns
      `createWorkoutSession` and `addWorkoutSet` alongside the existing `createLog`/`addWater`.
      New `workouts/offline.js` owns the cache and the temp-id helpers.
      - **Read side:** `loadWorkoutSessions()`'s catch used to set the list to `[]`, so a cold
        offline open wiped the calendar, the diary, the streak and the Progress card as if the user
        had never trained. It now falls back to the last cached list; `[]` is only the answer when
        nothing is cached.
      - **Write side:** on a genuine connectivity failure, starting a session and logging sets both
        stand up locally and queue for replay; `app.js`'s existing drain replays them and
        `applySyncedWorkoutSession()` reconciles. **A real rejection (a 409, say) is still rolled
        back, never queued** — queueing one would retry it forever.
      - **The temp-id problem, solved durably:** sets queued behind a not-yet-created session point
        at a client-side id. When the create replays, the drain rewrites those queue entries *in
        IndexedDB* rather than in a `Map`, so a connection that drops again mid-drain — or a tab
        closed and reopened — resumes correctly instead of stranding sets against an id the backend
        has never heard of.
      - **Scope, stated rather than blurred:** only the *connectivity-failure* branch is new. The
        online path still awaits the server before rendering, exactly as before. Making it
        optimistic always, for zero perceived latency, is **Phase 2.2** and is deliberately still
        open. No new i18n strings — the existing `toast.queuedOffline` /
        `toast.couldNotSyncQueuedRemoved` pair is reused, so EN/RO parity holds by construction.
      - **Verified:** 7 new harness cases (32/32 total) covering cache hydration, offline session
        start, offline set logging with backend-matching `set_number`, the durable temp-id rewrite,
        both reconcile hooks, and "a 409 is never queued". `app.js`'s drain dispatch is not
        harness-reachable, so its contract is checked statically instead: **every field the drain
        reads is written by one of the two enqueue sites.**
      - **Bonus cleanup:** `isConnectivityError` moved to `api.js` (next to the errors it
        classifies) so `app.js` and `js/workouts/` share one definition instead of two copies.

**Ship gate:** existing tests green, every current flow behaviourally identical, a set logs with 3
round trips instead of 6, and a set logged offline flushes on reconnect.

- [x] **Phase 0 ship gate verified (2026-09-28).**
      - Backend: **725 passed / 32 skipped / 0 failed** (baseline was 710/32 — the 15 new ones are
        `test_workout_round_trips.py`). Retrieval-eval floors unchanged and still passing.
      - Frontend: `npm run build` green. `main` 223.51 kB → 227.82 kB (+4.3 kB raw, +1.03 kB gzip)
        for ten module headers, the offline layer and the new store — paid once, not per render.
      - Live: **32/32** harness cases against the real modules in a real browser.
      - Smoke: the real `index.html` boots on the dev server with **no module errors** — only the
        expected CORS failures from a localhost origin calling the production API. Bottom nav still
        reads Dashboard · Progress · Discover · Saved, i.e. Phase 0 changed nothing a user can see.

**Test instrument built during this phase:** `frontend/wd-harness.html` — a live rig that loads the
real workout modules, the real `style.css` and the real markup lifted from `index.html`, stubbing
only the network layer (`api` is a module singleton, so patching it patches the object the modules
actually imported). It is excluded from the production build by `vite.config.js`'s explicit
`rollupOptions.input` list. This is the repo's only automated frontend test — **keep it current
through Phases 1 and 2**, where it is the thing standing between a UI rewrite and a silent
regression. Each assertion was also proven to FAIL against the un-fixed code before being accepted;
a test that passes either way is not a test.

### Phase 1 — The front door

*The highest-leverage phase. Everything already built becomes reachable.*

- [ ] **1.1 — Promote Train to the bottom nav**, replacing the Saved meals tab (§3.1, decision D1).
- [ ] **1.2 — Relocate Saved meals** into the Add Food flow, where it is contextually correct.
      Must feel native, not bolted on — it is a food-entry shortcut, not a destination.
- [ ] **1.3 — Build the Train tab shell:** Today card, week strip, history list (§3.2).
- [ ] **1.4 — Fold `routines.js` into the Train tab**; delete `plan-builder-view`.
- [ ] **1.5 — Move the month calendar behind a secondary "History / Calendar" affordance** (decision D2).
      **Carry this pre-existing bug with it, found while doing 0.2 and deliberately NOT fixed there**
      (Phase 0 is behaviour-neutral, and this is a behaviour change): `renderWeekdayHeader()` guards
      itself with `if (container.childElementCount) return; // static — built once`, so on a
      language switch the month title re-translates and the **weekday abbreviations do not** — an
      English user switching to Romanian keeps Mon/Tue/Wed above Romanian month names. The fix is to
      let the language-change path rebuild that header; it belongs with whatever replaces or keeps
      this calendar.

**Ship gate:** 2 taps to first set on a planned day. Every routine/plan capability that worked before
still works. `#plan-builder-view` is gone, not orphaned. Saved meals is still reachable in ≤ 2 taps
from the Dashboard.

- [ ] **Phase 1 ship gate verified.**

### Phase 2 — The logging loop

*Where the "dopamine-inducing" requirement is actually won or lost.*

- [ ] **2.1 — Full-screen session logger** (§3.3).
- [ ] **2.2 — Optimistic set logging** with reconcile + rollback.
- [ ] **2.3 — Steppers on weight/reps**; keyboard becomes opt-in.
- [ ] **2.4 — Swipeable exercise rail**; retire "Change exercise."
- [ ] **2.5 — Rest timer into the persistent header.**

**Ship gate:** a set logs with zero perceived latency, a set can be logged with no keyboard, and a
mid-set network failure rolls back visibly with a toast rather than silently diverging.

- [ ] **Phase 2 ship gate verified.**

### Phase 3 — Cardio

*The new capability, and the one place this app can be measurably more accurate than its competitors.*

- [ ] **3.1 — `cardio_service.py` + `test_cardio_service.py` FIRST** — the math, pinned, before any UI.
- [ ] **3.2 — `cardio_sessions` table written into `sql/schema.sql`.** Hand it to the user to apply.
      State plainly that the feature is dark until they run it, and that new tables need grants.
- [ ] **3.3 — `POST /workouts/sessions/{id}/cardio` + the read path**; `_503_if_not_migrated` on all of it.
- [ ] **3.4 — `cardio.js`:** machine picker, per-machine inputs, live estimate with visible provenance.
- [ ] **3.5 — Interval segments.**
- [ ] **3.6 — Keep the Damage Control "Move it" path working unchanged** — routes to flat-MET fallback.

**Ship gate:** a 32-minute treadmill walk at 6 km/h and 8% incline produces a figure that matches a
hand-computed ACSM result; the stairmaster no longer estimates as a brisk walk; net and gross are
distinguishable in the UI; and an unrecognised machine degrades to flat MET rather than raising.

- [ ] **Phase 3 ship gate verified.**

### Phase 4 — Visual and reward layer

*Polish, deliberately after the mechanics work.*

- [ ] **4.1 — `muscleMap.js`** (§4.5); delete `renderMuscleHeatmap`, keep and move `computeMuscleHeatmap`.
- [ ] **4.2 — Bring Ollie into the gym.** A finished session feeds the same celebrate/mood machinery,
      with new lines in both languages. *Biggest single dopamine win; reuses existing mechanics.*
- [ ] **4.3 — Widen the celebration set** beyond the 1RM PR: session finished, volume record, routine
      completed, every muscle group covered this week. All four computable from data already in memory.
- [ ] **4.4 — Give Workouts its own visual identity** instead of borrowing `.progress-card`.

**Ship gate:** EN/RO key parity (a mismatch silently falls back to English rather than erroring); the
muscle map is legible in light and dark; and every celebration fires on a real condition, not on
every action — the current PR guard is the standard to match.

- [ ] **Phase 4 ship gate verified.**

### Phase 5 — Honest numbers

*Deferred on purpose: it changes figures users have already seen. Approved — see decision D3.*

- [ ] **5.1 — Bring set density into finished-session strength calories** (§F1).
- [ ] **5.2 — Net-vs-gross for strength**, reusing `calculate_bmr`.
- [ ] **5.3 — Recompute-on-edit for cardio**, closing the "computed once, never again" gap.

**Ship gate:** documented in `CLAUDE.md` as a deliberate change in what the app reports, with the
before/after magnitude stated — because a user watching their burn figure drop 15% after an update
deserves to find an explanation rather than a mystery.

- [ ] **Phase 5 ship gate verified.**

## 6. Risks and explicit non-goals

**Risks**

| Risk | Mitigation |
|---|---|
| **The schema migration is manual.** Cardio is dark until the user runs it. | Phase 3 leads with it; `_503_if_not_migrated` gives a clear reason instead of a 500; new tables get explicit grants. |
| **Promoting Train demotes Saved meals.** A real trade, not a free win. | Argued openly in §3.1 rather than assumed. The 5th-tab fallback exists. Worth watching whether saved-meal usage drops. |
| **Optimistic set logging can diverge from the server.** | Reconcile on response, roll back with a toast on failure — the pattern `insertOptimisticLog` already proves in this codebase. |
| **`set_number` collides for offline-queued sets.** | Client-side provisional numbering, server-authoritative on flush (§4.4). |
| **The muscle map's tint ramp fails on light theme or for colour-blind users.** | Both themes authored, never derived; every group carries a text label and set count; the neglected-groups line stays. |
| **This is a large change to a heavily-commented codebase.** | Six independently shippable phases; Phase 0 is behaviour-neutral; `CLAUDE.md` updated as each lands, not in one pass at the end. |
| **ACSM equations are validated for steady-state submaximal work.** They over-report at maximal intensity and do not model EPOC. | Do not claim clinical precision. `is_estimate` and `equation_id` are in the schema exactly so the UI can be honest about which figure is which. |

**Non-goals** — named so they do not creep in:

- No framework. No React/Vue/Svelte. Vanilla ES modules, as the whole app is.
- No new CDN script and no CSP loosening. The muscle map is inline SVG for exactly this reason.
- No 3D body model. Ollie's GLB is justified by being the entire companion mechanic; a body map is not.
- No global `style.css` restructure inside this overhaul (§4.3). Worth doing; not here.
- No per-muscle anatomical resolution beyond the six groups the data supports (§4.5).
- No wearable/HR integration, no social feed, no video demos.
- No deletion of `workout_logs` or its migration block. It is inert and harmless; removing it is a
  separate, deliberate decision.
- No backend error-string localisation. English-only `HTTPException` detail text is an accepted,
  documented gap app-wide, and Workouts should not become the one exception.

---

## 7. Business decisions — RESOLVED (2026-09-28)

All three open questions were answered by the product owner before Phase 1. **These are settled; do
not re-litigate them.** They are recorded here with their rationale so a cleared chat context does
not reopen a closed decision.

- [x] **D1 — Train replaces the Saved meals tab. No 5th tab.**
      A 5th tab would break the bottom nav's symmetry (four tabs plus the centre scan button), so
      Saved meals gives up its slot rather than the nav growing. **Saved meals must be relocated
      somewhere elegant and native-feeling — inside the Add Food flow or the Dashboard, wherever it
      reads as contextually correct** — not merely demoted into a settings list. It is a food-entry
      shortcut, so it belongs inside the flow it shortcuts. Tracked as task 1.2, and its ship gate
      is explicit: still reachable in ≤ 2 taps from the Dashboard.

- [x] **D2 — The month calendar survives, behind a secondary "History / Calendar" button.**
      It is already built and already good; it was only ever wrong as the *default* zoom. The week
      strip becomes the default view and the month grid keeps all of its current code behind an
      affordance. Tracked as task 1.5.

- [x] **D3 — The Phase 5 calorie-math correction is approved.**
      Gross-vs-net and set-density both land, changing figures users have already seen. Accepted on
      the grounds that this section has not been heavily used yet, so the correction is cheap now and
      gets more expensive every week it waits. It still ships **last**, and still carries its
      documented before/after magnitude in `CLAUDE.md` — an announced change, not a silent drift.

Everything else in this document was confident enough to build without a decision gate.
