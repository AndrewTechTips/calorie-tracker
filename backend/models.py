from datetime import datetime
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
    daily_water_ml: int = Field(gt=0)
    # Optional — used only for the dashboard greeting ("Good morning,
    # Andrew"). None/omitted is valid and leaves it unset.
    display_name: Optional[str] = Field(default=None, max_length=40)


class TargetsResponse(TargetsUpdate):
    id: str
    email: Optional[str] = None


# ---------------------------------------------------------------------------
# "Day N" tracking — see backend/services/day_service.py
# ---------------------------------------------------------------------------
class DayStateResponse(BaseModel):
    day_number: int
    day_boundary: datetime


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
    confidence_note: Optional[str] = None


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
    source: Literal["ai", "manual", "saved_meal"] = "manual"


class DailyLogCorrection(BaseModel):
    """Used when the user edits a log entry.

    - If food_name changes, the backend re-derives fresh macros via a
      text-only Gemini call at the given weight (no image) — calories/protein/
      carbs/fats passed alongside a name change are ignored, since they're
      presumed to describe the *old* food, not the new one.
    - Otherwise, whatever of weight_g/calories/protein/carbs/fats are provided
      are applied directly, as-is — this is a plain edit, not a guess. (The
      frontend rescales the macro fields proportionally in the form itself
      when the user changes only the weight, then submits the resulting
      values here like any other direct edit.)
    """

    food_name: Optional[str] = None
    weight_g: Optional[float] = Field(default=None, gt=0)
    calories: Optional[float] = Field(default=None, ge=0)
    protein: Optional[float] = Field(default=None, ge=0)
    carbs: Optional[float] = Field(default=None, ge=0)
    fats: Optional[float] = Field(default=None, ge=0)


class DailyLogResponse(BaseModel):
    id: str
    user_id: str
    food_name: str
    weight_g: float
    calories: float
    protein: float
    carbs: float
    fats: float
    source: str
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


class SavedMealResponse(SavedMealCreate):
    id: str
    user_id: str
    created_at: datetime


# ---------------------------------------------------------------------------
# Water
# ---------------------------------------------------------------------------
class WaterLogCreate(BaseModel):
    amount_ml: int = Field(gt=0, le=5000, default=250)


class WaterLogResponse(BaseModel):
    id: str
    amount_ml: int
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
    date: str  # YYYY-MM-DD
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
