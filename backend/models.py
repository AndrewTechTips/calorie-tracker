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


# ---------------------------------------------------------------------------
# Day/date tracking — see backend/services/daytime_service.py
# ---------------------------------------------------------------------------
class DayStateResponse(BaseModel):
    date: str  # YYYY-MM-DD, the user's local calendar date
    ended: bool


class TimezoneUpdate(BaseModel):
    timezone: str = Field(max_length=100)


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


class UsageStatus(BaseModel):
    """Shared (not per-user) daily Gemini call count vs. the soft cap this
    backend enforces — see services/quota_service.py."""

    used: int
    limit: int
    remaining: int
    at_capacity: bool
    resets_at: datetime


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
