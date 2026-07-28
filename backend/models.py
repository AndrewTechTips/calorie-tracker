from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Targets / profile
# ---------------------------------------------------------------------------
class TargetsUpdate(BaseModel):
    daily_calories: float = Field(gt=0)
    daily_protein: float = Field(ge=0)
    daily_carbs: float = Field(ge=0)
    daily_fats: float = Field(ge=0)
    # Defaulted (unlike the other daily_* targets above, which are always
    # sent as a complete set by the settings form): a profile row written
    # before this column existed, or a request from a not-yet-migrated
    # Supabase project (see db_tolerance.py), should still validate as a
    # normal profile with a sensible default rather than erroring.
    daily_fiber: float = Field(ge=0, default=30)
    daily_water_ml: int = Field(gt=0)
    # Optional — used only for the dashboard greeting ("Good morning,
    # Andrew"). None/omitted is valid and leaves it unset.
    display_name: Optional[str] = Field(default=None, max_length=40)


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
    timezone: str


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


class DescriptionScanRequest(BaseModel):
    # Capped here, before it ever reaches Gemini — bounds cost/abuse on the
    # no-photo "describe what I ate" path (routers/scan.py's POST
    # /scan/describe). 500 chars is generous for a real meal description
    # ("a hand of nuts, a spoon of yogurt, ~2 slices of toast with butter")
    # while still bounding a single request's token cost.
    description: str = Field(min_length=1, max_length=500)


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
    food_name: str
    weight_g: float = Field(gt=0)
    calories: float = Field(ge=0)
    protein: float = Field(ge=0)
    carbs: float = Field(ge=0)
    fats: float = Field(ge=0)
    # Unlike the AI-scan path, a manual entry has no estimator to fall back
    # on — defaulted to 0 so the field is simply "not tracked for this entry"
    # rather than forcing every manual-entry submission to specify it.
    fiber: float = Field(ge=0, default=0)
    source: Literal["ai", "manual", "saved_meal"] = "manual"
    # Backdates this entry into a past day instead of today — used by the
    # Daily History "edit a past day" flow (see backend/routers/day.py's
    # get_day_context and the routers/logs.py::create_log validation of this
    # field). None/omitted means "today", the normal case.
    log_date: Optional[date] = None


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

    food_name: Optional[str] = None
    weight_g: Optional[float] = Field(default=None, gt=0)
    calories: Optional[float] = Field(default=None, ge=0)
    protein: Optional[float] = Field(default=None, ge=0)
    carbs: Optional[float] = Field(default=None, ge=0)
    fats: Optional[float] = Field(default=None, ge=0)
    fiber: Optional[float] = Field(default=None, ge=0)


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


# ---------------------------------------------------------------------------
# Saved meals (favorites/templates)
# ---------------------------------------------------------------------------
class SavedMealCreate(BaseModel):
    name: str
    weight_g: float = Field(gt=0)
    calories: float = Field(ge=0)
    protein: float = Field(ge=0)
    carbs: float = Field(ge=0)
    fats: float = Field(ge=0)
    fiber: float = Field(ge=0, default=0)
    # Defaulted, not required — same reasoning as fiber above: a request from
    # a not-yet-migrated Supabase project, or a saved meal written before
    # this column existed, must still validate rather than erroring.
    type: Literal["meal", "product"] = "meal"


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
