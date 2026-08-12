from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Targets / profile
# ---------------------------------------------------------------------------
class TargetsUpdate(BaseModel):
    # Upper bounds below are all deliberately generous (no realistic target
    # comes remotely close) — they exist only to stop a single request from
    # writing an absurd value that then bloats every future read of this
    # profile row, not to second-guess a legitimate target.
    daily_calories: float = Field(gt=0, le=20000)
    daily_protein: float = Field(ge=0, le=2000)
    daily_carbs: float = Field(ge=0, le=2000)
    daily_fats: float = Field(ge=0, le=2000)
    # Defaulted (unlike the other daily_* targets above, which are always
    # sent as a complete set by the settings form): a profile row written
    # before this column existed, or a request from a not-yet-migrated
    # Supabase project (see db_tolerance.py), should still validate as a
    # normal profile with a sensible default rather than erroring.
    daily_fiber: float = Field(ge=0, default=30, le=500)
    daily_water_ml: int = Field(gt=0, le=20000)
    # Optional — used only for the dashboard greeting ("Good morning,
    # Andrew"). None/omitted is valid and leaves it unset.
    display_name: Optional[str] = Field(default=None, max_length=40)
    # Optional profile picture, a data: URI (see sql/schema.sql's column
    # comment for why this is stored inline rather than in a Storage
    # bucket). frontend/js/avatar.js compresses/resizes client-side to a
    # small square JPEG before ever sending this — the generous max_length
    # here is a sanity ceiling against abuse, not the real expected size
    # (~15-40KB base64 in practice), same "upper bounds are generous, not a
    # second-guess of a legitimate value" spirit as every other Field above.
    avatar_url: Optional[str] = Field(default=None, max_length=400000)
    # Defaulted, same reasoning as daily_fiber above — a not-yet-migrated
    # profile row has no goal_type column yet. "maintain" also happens to be
    # the value that keeps coach.js's existing calorie-overage tone
    # completely unchanged, so an unset goal never alters today's behavior.
    goal_type: Literal["cut", "maintain", "bulk"] = "maintain"


class TargetsResponse(TargetsUpdate):
    id: str
    email: Optional[str] = None
    # Read-only surface of the IANA timezone the day/date system is using for
    # this user — set via PUT /day/timezone, not through this endpoint (the
    # settings form never sends it back through TargetsUpdate).
    timezone: str = "UTC"
    # Account signup date, for the "Member since" badge on the profile card
    # (frontend/js/app.js::syncProfileUi). Deliberately NOT a `profiles`
    # column — it's Supabase Auth's own auth.users.created_at, already
    # available for free off the `user` object routers/targets.py gets from
    # Depends(get_current_user), so there's nothing to add to sql/schema.sql
    # or backfill for existing rows. Optional only as defense-in-depth (every
    # real caller sets it); a missing value just hides the badge client-side
    # rather than breaking the rest of the settings payload.
    created_at: Optional[datetime] = None


# ---------------------------------------------------------------------------
# Day/date tracking — see backend/services/daytime_service.py
# ---------------------------------------------------------------------------
class DayStateResponse(BaseModel):
    date: str  # YYYY-MM-DD, the user's local calendar date
    ended: bool


class TimezoneUpdate(BaseModel):
    timezone: str = Field(max_length=100)


# ---------------------------------------------------------------------------
# Account management (routers/account.py) — both Reset Progress and Delete
# Account require this exact body, not just a bare POST/DELETE with no
# payload, as a deliberate extra guard against an irreversible action ever
# firing from a stray/automated/retried request instead of real, deliberate
# frontend intent (the frontend's own confirmation sheet is the primary
# guard; this is defense-in-depth on the backend, same spirit as every other
# destructive endpoint in this app requiring a real authenticated user).
# ---------------------------------------------------------------------------
class AccountActionConfirm(BaseModel):
    confirm: bool = False


# ---------------------------------------------------------------------------
# Per-ingredient breakdown — shared by AI scan results, daily logs, and saved
# meals (see sql/schema.sql's daily_logs.ingredients / saved_meals.ingredients
# columns). Every food entry has at least one of these (a plain single-food
# log is just a 1-item list) so the frontend never needs to branch on whether
# a breakdown exists — see gemini_service.py::_finalize_ingredients and
# routers/barcode.py for how single-item lists get constructed.
# ---------------------------------------------------------------------------
class IngredientItem(BaseModel):
    food_name: str = Field(min_length=1, max_length=100)
    weight_g: float = Field(ge=0, le=10000)
    calories: float = Field(ge=0, le=20000)
    protein: float = Field(ge=0, le=2000)
    carbs: float = Field(ge=0, le=2000)
    fats: float = Field(ge=0, le=2000)
    fiber: float = Field(ge=0, default=0, le=500)
    # Defaulted, same reasoning as fiber above — an older cached frontend
    # build or a pre-migration row simply has "not tracked" for these two
    # rather than failing validation. sugar is grams (already counted inside
    # carbs, same relationship fiber has); sodium is milligrams (the
    # conventional nutrition-label unit — grams would be sub-1 for almost
    # every real food and awkward to display).
    sugar: float = Field(ge=0, default=0, le=2000)
    sodium: float = Field(ge=0, default=0, le=20000)


# ---------------------------------------------------------------------------
# AI scan
# ---------------------------------------------------------------------------
class ScanResult(BaseModel):
    food_name: str
    weight_g: float
    calories: float
    protein: float
    carbs: float
    fats: float
    # Defaulted rather than required: a stray Gemini response missing this
    # one field (unlikely, but possible on a bad day from a smaller model)
    # should degrade to "fiber not estimated" instead of failing the whole
    # scan the user is waiting on.
    fiber: float = 0
    # Same "degrade gracefully, never fail the scan" reasoning as fiber above
    # — see IngredientItem.sugar/sodium for units (g / mg respectively).
    sugar: float = 0
    sodium: float = 0
    confidence_note: Optional[str] = None
    # Always populated by the backend before this model is constructed (see
    # gemini_service.py::_finalize_ingredients / routers/barcode.py) — never
    # actually None/empty in a real response, but Optional so a caller
    # constructing this manually (e.g. a future code path) isn't forced to.
    ingredients: Optional[list[IngredientItem]] = Field(default=None, max_length=15)
    # Barcode-only (routers/barcode.py) — Open Food Facts product photo/brand,
    # passed through as-is when present. None on every AI-scan/manual result;
    # the frontend simply omits the image/brand UI when these are unset.
    image_url: Optional[str] = Field(default=None, max_length=500)
    brand: Optional[str] = Field(default=None, max_length=200)


class DescriptionScanRequest(BaseModel):
    # Capped here, before it ever reaches Gemini — bounds cost/abuse on the
    # no-photo "describe what I ate" path (routers/scan.py's POST
    # /scan/describe). 800 chars comfortably covers a multi-item meal
    # description ("2 eggs scrambled with cheese, 2 slices whole wheat toast
    # with butter, a cup of orange juice, and a banana on the side") while
    # still bounding a single request's token cost. Defaulted to "" (not
    # required) rather than min_length=1: a request can be description-only,
    # attached_items-only (see below), or both — routers/scan.py validates
    # that at least one of the two is actually present.
    description: str = Field(default="", max_length=800)
    # Barcode-scanned product(s) the user attaches alongside a text
    # description (or, on POST /scan, alongside a photo) — see
    # routers/scan.py's _merge_attached_items/_sum_attached_items. Each entry
    # already carries the user-confirmed weight and its macros scaled to that
    # weight (frontend does the scaling, same "known values, not a guess"
    # convention as DailyLogCorrection). Capped at 3: together with the up to
    # 12 ingredients Gemini can return, this stays within ScanResult.
    # ingredients' own max_length=15 cap after routers/scan.py merges them.
    attached_items: list[IngredientItem] = Field(default_factory=list, max_length=3)
    # The user's current app display language — steers Gemini's food_name/
    # confidence_note output to match (see gemini_service.py's
    # _output_language_block). Defaulted, not required: an older cached
    # frontend build that doesn't send this yet just gets the pre-existing
    # English-default behavior, not a validation error.
    language: Literal["en", "ro"] = "en"


class ScanError(BaseModel):
    error: Literal["invalid_input"]
    message: str = "The image/text did not appear to contain identifiable food."


class AIFeatureUsage(BaseModel):
    """One row of GET /ai-usage's payload — this user's own count today
    against one AI feature's daily quota (services/ai_usage_service.py).
    Unlike the old shared, provider-wide GET /scan/usage number (removed —
    superseded entirely by this per-user system), this is per-user:
    `feature` is a stable key (e.g. "scan", "coach_chat") the frontend maps
    to its own localized label, never a display string
    itself — see CLAUDE.md's i18n section for why backend strings stay
    English-only/non-presentational.

    monthly_* are None for every feature except the handful with an actual
    monthly gate (currently just "weekly_recap" —
    ai_usage_service.py's _FEATURE_MONTHLY_LIMIT_SETTINGS): most features'
    real usage pattern is genuinely daily, so a monthly axis would just be
    redundant math on top of the daily one. The frontend renders a second
    "this month" bar only when these are non-None."""

    feature: str
    used: int
    limit: int
    remaining: int
    monthly_used: int | None = None
    monthly_limit: int | None = None
    monthly_remaining: int | None = None


class AIUsageSummary(BaseModel):
    """GET /ai-usage's full response — every known AI feature's quota state
    for this user today, always the same set of features regardless of
    whether they've touched all of them (used=0 for ones they haven't), so
    the frontend never has to special-case a missing entry. `resets_at` is
    the shared daily reset (UTC midnight); `monthly_resets_at` is the shared
    monthly reset (the 1st of next month, UTC) for whichever features carry
    a monthly quota."""

    features: list[AIFeatureUsage]
    resets_at: datetime
    monthly_resets_at: datetime


# ---------------------------------------------------------------------------
# Daily logs
# ---------------------------------------------------------------------------
class DailyLogCreate(BaseModel):
    # Bounds here are all deliberately generous (see TargetsUpdate above for
    # why) — a single log entry writing e.g. a megabyte-long name or an
    # absurd calorie value would otherwise bloat every future GET /logs and
    # GET /trends read for this user, on a storage-capped Supabase project.
    food_name: str = Field(min_length=1, max_length=200)
    weight_g: float = Field(gt=0, le=10000)
    calories: float = Field(ge=0, le=20000)
    protein: float = Field(ge=0, le=2000)
    carbs: float = Field(ge=0, le=2000)
    fats: float = Field(ge=0, le=2000)
    # Unlike the AI-scan path, a manual entry has no estimator to fall back
    # on — defaulted to 0 so the field is simply "not tracked for this entry"
    # rather than forcing every manual-entry submission to specify it.
    fiber: float = Field(ge=0, default=0, le=500)
    # Same "not tracked unless given" defaulting as fiber above.
    sugar: float = Field(ge=0, default=0, le=2000)
    sodium: float = Field(ge=0, default=0, le=20000)
    # Optional meal-timing tag relative to a workout — user-set (never
    # AI-inferred), surfaced to the AI Coach chat (see gemini_service.py's
    # COACH_CHAT_PROMPT) so it can give timing-aware nudges. Defaults to
    # "regular" (not tied to a workout), matching sql/schema.sql's column
    # default so an unset tag reads identically whichever side defaults it.
    workout_tag: Literal["pre_workout", "post_workout", "regular"] = "regular"
    source: Literal["ai", "manual", "saved_meal"] = "manual"
    # Backdates this entry into a past day instead of today — used by the
    # Daily History "edit a past day" flow (see backend/routers/day.py's
    # get_day_context and the routers/logs.py::create_log validation of this
    # field). None/omitted means "today", the normal case.
    log_date: Optional[date] = None
    # Optional per-ingredient breakdown — see IngredientItem above. The
    # frontend always sends this (at minimum a 1-item list matching the
    # aggregate fields); None only for very old clients that predate this
    # field, which still work fine as a plain aggregate-only entry.
    ingredients: Optional[list[IngredientItem]] = Field(default=None, max_length=15)


class DailyLogCorrection(BaseModel):
    """Used when the user edits a log entry.

    - If food_name changes, the backend re-derives fresh macros via a
      text-only Gemini call at the given weight (no image) — calories/protein/
      carbs/fats/fiber passed alongside a name change are ignored, since
      they're presumed to describe the *old* food, not the new one.
    - Otherwise, whatever of weight_g/calories/protein/carbs/fats/fiber are
      provided are applied directly, as-is — this is a plain edit, not a
      guess. (The frontend rescales the macro fields proportionally in the
      form itself when the user changes only the weight, then submits the
      resulting values here like any other direct edit.)
    """

    food_name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    weight_g: Optional[float] = Field(default=None, gt=0, le=10000)
    calories: Optional[float] = Field(default=None, ge=0, le=20000)
    protein: Optional[float] = Field(default=None, ge=0, le=2000)
    carbs: Optional[float] = Field(default=None, ge=0, le=2000)
    fats: Optional[float] = Field(default=None, ge=0, le=2000)
    fiber: Optional[float] = Field(default=None, ge=0, le=500)
    sugar: Optional[float] = Field(default=None, ge=0, le=2000)
    sodium: Optional[float] = Field(default=None, ge=0, le=20000)
    # Editable independently of a food-name change (unlike calories/protein/
    # etc., which only apply on a direct edit) — retagging "this was actually
    # my post-workout meal" shouldn't require re-triggering a macro
    # re-estimate. None means "leave whatever it already is."
    workout_tag: Optional[Literal["pre_workout", "post_workout", "regular"]] = None
    # Passed through as-is on a direct edit, same as every other field above;
    # explicitly cleared server-side on a food-name change instead (see
    # routers/logs.py::correct_log) since a rename collapses back to one
    # implicit ingredient rather than carrying over a now-stale breakdown.
    ingredients: Optional[list[IngredientItem]] = Field(default=None, max_length=15)


class DailyLogResponse(BaseModel):
    id: str
    user_id: str
    food_name: str
    weight_g: float
    calories: float
    protein: float
    carbs: float
    fats: float
    # Defaulted for rows written before this column existed (see
    # db_tolerance.py) — reads back as "not tracked" instead of failing.
    fiber: float = 0
    sugar: float = 0
    sodium: float = 0
    workout_tag: str = "regular"
    source: str
    log_date: str
    logged_at: datetime
    ingredients: Optional[list[IngredientItem]] = None


# ---------------------------------------------------------------------------
# Saved meals (favorites/templates)
# ---------------------------------------------------------------------------
class SavedMealCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    weight_g: float = Field(gt=0, le=10000)
    calories: float = Field(ge=0, le=20000)
    protein: float = Field(ge=0, le=2000)
    carbs: float = Field(ge=0, le=2000)
    fats: float = Field(ge=0, le=2000)
    fiber: float = Field(ge=0, default=0, le=500)
    sugar: float = Field(ge=0, default=0, le=2000)
    sodium: float = Field(ge=0, default=0, le=20000)
    # Defaulted, not required — same reasoning as fiber above: a request from
    # a not-yet-migrated Supabase project, or a saved meal written before
    # this column existed, must still validate rather than erroring.
    type: Literal["meal", "product"] = "meal"
    ingredients: Optional[list[IngredientItem]] = Field(default=None, max_length=15)
    # How many servings weight_g/the macro fields above represent — plain
    # single-serving meals/products default to 1 (unchanged behavior). A
    # Recipe Builder result can set this >1; POST /meals/{id}/log still logs
    # the stored snapshot verbatim regardless — any per-serving scaling
    # happens client-side before that call (see frontend/js/app.js).
    servings: float = Field(gt=0, default=1, le=100)


class SavedMealResponse(SavedMealCreate):
    id: str
    user_id: str
    created_at: datetime


# ---------------------------------------------------------------------------
# Body measurements (gym-tracking upgrade) — kept indefinitely, same
# reasoning as weight_logs below. Unlike weight, the user names the
# measurement themselves (e.g. "Waist", "Left bicep") and logged_at is
# user-specified rather than always "now" — measurements are often logged
# after the fact, at whatever day/time they were actually taken.
# ---------------------------------------------------------------------------
class MeasurementCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    value: float = Field(gt=0, lt=1000)
    unit: str = Field(default="cm", max_length=10)
    logged_at: Optional[datetime] = None


class MeasurementUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    value: Optional[float] = Field(default=None, gt=0, lt=1000)
    unit: Optional[str] = Field(default=None, max_length=10)
    logged_at: Optional[datetime] = None


class MeasurementResponse(BaseModel):
    id: str
    user_id: str
    name: str
    value: float
    unit: str
    logged_at: datetime
    created_at: datetime


# ---------------------------------------------------------------------------
# Training log (sets/reps/weight) — kept indefinitely, same reasoning as
# weight_logs/measurements above. logged_at is user-specified, not always
# "now" — same as measurements, workouts are almost always logged after the
# fact rather than live at the gym. reps/weight_kg are per-set values assumed
# uniform across a given entry's sets (see sql/schema.sql's table comment for
# why this doesn't model arbitrary per-set variation).
# ---------------------------------------------------------------------------
class WorkoutLogCreate(BaseModel):
    exercise_name: str = Field(min_length=1, max_length=100)
    sets: int = Field(gt=0, le=50)
    reps: int = Field(gt=0, le=200)
    weight_kg: float = Field(ge=0, lt=500, default=0)
    logged_at: Optional[datetime] = None


class WorkoutLogUpdate(BaseModel):
    exercise_name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    sets: Optional[int] = Field(default=None, gt=0, le=50)
    reps: Optional[int] = Field(default=None, gt=0, le=200)
    weight_kg: Optional[float] = Field(default=None, ge=0, lt=500)
    logged_at: Optional[datetime] = None


class WorkoutLogResponse(BaseModel):
    id: str
    user_id: str
    exercise_name: str
    sets: int
    reps: int
    weight_kg: float
    logged_at: datetime
    created_at: datetime


# ---------------------------------------------------------------------------
# Water
# ---------------------------------------------------------------------------
class WaterLogCreate(BaseModel):
    amount_ml: int = Field(gt=0, le=5000, default=250)
    # Same backdating mechanism as DailyLogCreate.log_date above.
    log_date: Optional[date] = None


class WaterLogResponse(BaseModel):
    id: str
    amount_ml: int
    log_date: str
    logged_at: datetime


class WaterSummaryResponse(BaseModel):
    total_ml: int
    target_ml: int
    entries: list[WaterLogResponse]


# ---------------------------------------------------------------------------
# Body weight — kept indefinitely (not subject to the 7-day log retention),
# see sql/schema.sql's weight_logs table comment for why.
# ---------------------------------------------------------------------------
class WeightLogCreate(BaseModel):
    weight_kg: float = Field(gt=0, lt=500)


class WeightLogResponse(BaseModel):
    id: str
    weight_kg: float
    logged_at: datetime


# ---------------------------------------------------------------------------
# Trends / streak (computed at read time from daily_logs/water_logs/
# weight_logs — no separate aggregate table; see backend/routers/trends.py)
# ---------------------------------------------------------------------------
class DayTrend(BaseModel):
    date: str  # YYYY-MM-DD, the day's actual calendar-date identity now
    calories: float
    protein: float
    carbs: float
    fats: float
    water_ml: int
    weight_kg: Optional[float] = None
    adherent: bool


class TrendsResponse(BaseModel):
    days: list[DayTrend]
    streak: int


# ---------------------------------------------------------------------------
# AI coach — weekly recap (routers/coach.py, services/coach_cache_service.py)
# ---------------------------------------------------------------------------
class WeeklyRecapResponse(BaseModel):
    recap_text: str
    cached: bool  # served from coach_cache_service vs. a fresh Gemini call this request


# ---------------------------------------------------------------------------
# AI coach — capped free-text chat (routers/coach.py, services/
# ai_usage_service.py). Chat history is client-side only (kept in
# the frontend's own JS state, cleared on reload) — there is no server-side
# transcript table, so `history` here is round-tripped by the client on
# every turn, not read back from storage. Because of that, it is untrusted
# input just like `message` (a tampered client could inject fake turns into
# it) — see gemini_service.py's COACH_CHAT_PROMPT for how it's framed.
# ---------------------------------------------------------------------------
class ChatTurn(BaseModel):
    role: Literal["user", "coach"]
    content: str = Field(min_length=1, max_length=800)


class CoachChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    # Capped at 12 turns (~6 exchanges) — enough for real conversational
    # context without letting the prompt (and therefore token cost) grow
    # unbounded across a long-running chat.
    history: list[ChatTurn] = Field(default_factory=list, max_length=12)
    language: str = "en"


class CoachChatResponse(BaseModel):
    reply: str
    messages_remaining_today: int


# ---------------------------------------------------------------------------
# "Damage Control" intervention (routers/coach.py, services/gemini_service.py's
# DAMAGE_CONTROL_PROMPT) — triggered client-side (app.js) right after a log
# that pushes today's calories well past target. The numeric fields here are
# all server-computed from this user's own daily_logs/profiles rows, never
# from the AI — only `message` is Gemini's output. See DamageControlRequest
# below for why trigger_food_name is treated as untrusted despite this
# endpoint having no other free-text input.
# ---------------------------------------------------------------------------
class DamageControlRequest(BaseModel):
    # The food name of the log entry that triggered this — echoed back into
    # the prompt so the message can reference it, but it's still user-typed
    # text (a manual entry's food_name), so gemini_service treats it as
    # untrusted data, not an instruction (see that prompt's SECURITY block).
    trigger_food_name: str = Field(min_length=1, max_length=200)
    language: str = "en"


class DamageControlResponse(BaseModel):
    message: str
    calories_over: float
    remaining_calories: float
    remaining_protein: float
    remaining_carbs: float
    remaining_fats: float


# ---------------------------------------------------------------------------
# Smart Meal Suggester (routers/coach.py, services/gemini_service.py's
# MEAL_SUGGESTION_PROMPT) — filters are a fixed enum, never free text, so
# (combined with the server-computed remaining-macros input) this whole
# request is trusted data end to end; no invalid_input escape hatch needed
# on the Gemini side for this one.
# ---------------------------------------------------------------------------
class MealSuggestionRequest(BaseModel):
    filters: list[Literal["high_protein", "low_fat", "budget", "fast_prep"]] = Field(
        default_factory=list, max_length=4
    )
    language: str = "en"


class MealSuggestion(BaseModel):
    name: str
    # Typical serving weight for the WHOLE suggestion, in grams — lets a
    # logged suggestion support the same weight-based rescale every other
    # food entry in this app gets (see nutritionMath.js's
    # scaleMacrosByWeight), instead of being a dead flat number forever.
    # NOT part of Gemini's own per-suggestion schema (see
    # gemini_service.py::_MEAL_SUGGESTION_ITEM_SCHEMA's own comment on why) —
    # always computed server-side as the sum of `ingredients` before this
    # model is constructed. Field default (150) is a defensive placeholder
    # only, for the theoretical case ingredients ends up empty.
    weight_g: float = Field(gt=0, le=10000, default=150)
    calories: float
    protein: float
    carbs: float
    fats: float
    fiber: float = 0
    sugar: float = 0
    sodium: float = 0
    # Short "why this fits" line (e.g. "lean and quick — ready in 10 minutes").
    note: str = ""
    # Per-component breakdown (e.g. "Grilled chicken breast" / "Jasmine rice" /
    # "Steamed broccoli" for one composite suggestion) — same IngredientItem
    # shape and reconcile-then-sum guarantee as a scan result's own
    # `ingredients` (see gemini_service.py::_finalize_ingredients), just
    # capped lower (6, not 15/12) — partly because a suggested recipe has
    # fewer realistic distinct components than an arbitrary scanned plate,
    # and partly a hard constraint: Gemini's structured-output schema hits an
    # opaque 400 error past this cap for this particular nesting shape (see
    # _MEAL_SUGGESTION_ITEM_SCHEMA's comment). Always populated by the
    # backend before this model is constructed — never actually None/empty
    # in a real response, but Optional so a caller constructing this
    # manually isn't forced to.
    ingredients: Optional[list[IngredientItem]] = Field(default=None, max_length=6)


class MealSuggestionsResponse(BaseModel):
    suggestions: list[MealSuggestion]


# ---------------------------------------------------------------------------
# Discover (routers/discover.py) — recipes and workout plans are curated,
# static content shipped with the backend (backend/data/discover_data.py),
# not per-user rows; exercises and products are live proxies to free/keyless
# external APIs (wger.de, Open Food Facts) reshaped into these lean response
# models. Nothing here is user-owned, so none of these carry a user_id.
# ---------------------------------------------------------------------------
class RecipeResult(BaseModel):
    id: str
    icon: str  # category key — see frontend/js/discover.js's ICONS map for the pictogram/color
    name: str
    tags: list[str]
    prep_minutes: int
    servings: int
    weight_g: float  # approximate weight of one serving — lets "log this" create a real SavedMeal
    calories: float
    protein: float
    carbs: float
    fats: float
    fiber: float
    ingredients: list[str]
    instructions: list[str]
    # Curated photo (Wikimedia Commons, hotlinked — same external-image trust
    # model already used for exercises/products below) — see
    # data/discover_data.py's module comment for sourcing notes.
    image_url: Optional[str] = None


class WorkoutPlanExercise(BaseModel):
    name: str
    sets: int
    reps: str  # a range/rep-scheme string (e.g. "8-12", "AMRAP") reads better than forcing a single int
    # Short "how to perform it" cue, looked up from discover_data.EXERCISE_HOW_TO
    # and localized — see routers/discover.py. None only if a plan ever
    # references an exercise name with no curated cue (shouldn't happen for the
    # built-in plans; kept Optional defensively rather than crashing on a typo).
    description: Optional[str] = None


class WorkoutPlanDay(BaseModel):
    label: str
    exercises: list[WorkoutPlanExercise]


class WorkoutPlanResult(BaseModel):
    id: str
    icon: str  # category key — see frontend/js/discover.js's ICONS map for the pictogram/color
    name: str
    tags: list[str]
    level: str  # "beginner" | "intermediate" | "advanced"
    days: list[WorkoutPlanDay]
    image_url: Optional[str] = None


class ExerciseResult(BaseModel):
    id: int
    name: str
    category: str
    muscles: list[str]
    equipment: list[str]
    image_url: Optional[str] = None
    # CC-BY-SA attribution, as wger.de's API terms require when displaying
    # their exercise data — surfaced in the UI, not just kept server-side.
    license_author: Optional[str] = None
    # Short "how to perform it" cue — for a curated POPULAR_EXERCISES entry
    # this is the localized discover_data.EXERCISE_HOW_TO text; for a live
    # wger.de search result this is wger's own (English-only) description
    # when it has one, else the same curated fallback by exercise name.
    description: Optional[str] = None
