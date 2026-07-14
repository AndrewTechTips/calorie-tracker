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


class TargetsResponse(TargetsUpdate):
    id: str
    email: Optional[str] = None


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
    image_url: Optional[str] = None


class DailyLogCorrection(BaseModel):
    """Used when the user edits an AI-scanned item. If food_name changes, the
    backend re-derives per-100g macros via a text-only Gemini call (no image).
    If only weight_g changes, macros are simply rescaled locally — no AI call."""

    food_name: Optional[str] = None
    weight_g: Optional[float] = Field(default=None, gt=0)


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
    image_url: Optional[str] = None
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
