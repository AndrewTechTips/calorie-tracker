"""The user's own nutrition facts — read and write for public.custom_foods
(Diagnostic F8/H3).

This is the highest-trust source in the whole pipeline, above USDA, and the
reasoning is simple: every other source is somebody guessing what the user
ate. A custom food is the user reading the label of the exact product in
their hand. When a person tells you the number, you stop estimating.

It is also the only source that gets BETTER with use. USDA coverage is fixed,
Open Food Facts moves slowly, and model recall is what it is; a user's own
table grows every time they correct something, which is why the branded-local-
product gap (a Romanian supplement no public database has ever heard of) is
closable here and nowhere else.

TABLE-TOLERANT BY DESIGN, like every other optional integration in this app:
if public.custom_foods hasn't been created yet in a given Supabase project,
every function here degrades to "no custom food exists" rather than raising.
An unmigrated deployment therefore behaves exactly as it did before this
feature landed, instead of 500ing on every scan — the same discipline
services/db_tolerance.py applies to newly-added columns.
"""

import logging
import re
import unicodedata

from fastapi.concurrency import run_in_threadpool
from postgrest.exceptions import APIError

from database import get_supabase
from services.db_tolerance import UNDEFINED_TABLE_CODES

logger = logging.getLogger("custom_food_service")

# Mirrors nutrition_db_service._ROMANIAN_DIACRITIC_MAP. Duplicated rather than
# imported to keep this module free of a dependency on the lookup pipeline —
# but it MUST stay in sync, since a name normalized differently here than
# there would silently never match.
_ROMANIAN_DIACRITIC_MAP = str.maketrans("ăâîșşțţ", "aaisstt")

# The four the caller must be able to produce for an entry to be worth
# storing at all; the rest default to 0.
_REQUIRED_FIELDS = (
    "calories_per_100g",
    "protein_per_100g",
    "carbs_per_100g",
    "fats_per_100g",
)
_OPTIONAL_FIELDS = ("fiber_per_100g", "sugar_per_100g", "sodium_per_100g")

# Matches the CHECK constraints in sql/schema.sql. Enforced here too so a
# nonsense value fails as a clean skip rather than a Postgres error on an
# otherwise-successful log correction.
_FIELD_CEILINGS = {
    "calories_per_100g": 1000.0,
    "protein_per_100g": 100.0,
    "carbs_per_100g": 100.0,
    "fats_per_100g": 100.0,
    "fiber_per_100g": 100.0,
    "sugar_per_100g": 100.0,
    "sodium_per_100g": 100000.0,
}

# Below this, dividing a portion total by the weight amplifies any rounding
# in the user's own entry into a large per-100g error (a 1g entry multiplies
# everything by 100). Corrections on portions this small are not worth
# persisting as a reusable reference value.
_MIN_WEIGHT_G_TO_STORE = 5.0


def normalize_name(name: str) -> str:
    """The lookup key. Lowercase, Romanian diacritics folded, punctuation
    stripped, whitespace collapsed — so "Orez pudră Vitabolic", "orez pudra
    vitabolic" and "Orez Pudra  Vitabolic!" are all one food.

    Postgres stores whatever this produces and never recomputes it, so
    changing this function silently orphans every existing row. If it ever
    needs to change, migrate the column in the same commit."""
    text = unicodedata.normalize("NFC", name or "").lower().strip()
    text = text.translate(_ROMANIAN_DIACRITIC_MAP)
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()[:200]


def _is_missing_table(exc: APIError) -> bool:
    return (getattr(exc, "code", None) or "") in UNDEFINED_TABLE_CODES


async def get(user_id: str, food_name: str) -> dict | None:
    """This user's own per-100g figures for `food_name`, or None.

    Returns the same dict shape nutrition_db_service.lookup() does — including
    a `source` of "user_custom" — so _resolve_ingredient can slot it into the
    existing trust order without a special case. Never raises: a missing
    table, a missing row, or an unusable name all resolve to None, and every
    caller already has a fallback path for that.

    NOTE FOR CALLERS: a value from here is PER USER and must never be written
    into food_cache_service, which is keyed by food name alone and shared
    across every user. Leaking one user's label into that cache would serve
    their numbers to everyone else logging the same food name."""
    key = normalize_name(food_name)
    if not key:
        return None

    supabase = get_supabase()
    try:
        result = await run_in_threadpool(
            lambda: supabase.table("custom_foods")
            .select("*")
            .eq("user_id", user_id)
            .eq("normalized_name", key)
            .maybe_single()
            .execute()
        )
    except APIError as exc:
        if _is_missing_table(exc):
            return None  # table not migrated yet — behave as if the feature is off
        logger.warning("Custom food lookup failed for %r: %s", key, exc.code)
        return None
    except Exception:  # noqa: BLE001 - never let a personal-foods read break a scan
        logger.exception("Unexpected error reading custom food %r", key)
        return None

    # maybe_single() returns None outright on no match, not .data = None.
    row = (result.data if result else None) or None
    if not row:
        return None

    return {
        "food_name": row.get("display_name") or food_name,
        "source": "user_custom",
        "calories_per_100g": float(row["calories_per_100g"]),
        "protein_per_100g": float(row["protein_per_100g"]),
        "carbs_per_100g": float(row["carbs_per_100g"]),
        "fats_per_100g": float(row["fats_per_100g"]),
        "fiber_per_100g": float(row.get("fiber_per_100g") or 0),
        "sugar_per_100g": float(row.get("sugar_per_100g") or 0),
        "sodium_per_100g": float(row.get("sodium_per_100g") or 0),
    }


async def save_from_portion(user_id: str, food_name: str, weight_g: float, totals: dict) -> bool:
    """Records a manual correction as a reusable per-100g fact.

    `totals` are the macros for `weight_g` of the food — i.e. exactly what the
    correction route already has — and are divided down here so one correction
    on a 38g scoop prices every future portion of any size.

    Returns True if something was stored. Returns False (never raises) when
    the correction isn't worth persisting: no usable name, a portion too small
    to divide safely (_MIN_WEIGHT_G_TO_STORE), a missing required macro, or a
    resulting figure outside the schema's own bounds. Best-effort by design —
    this runs alongside a log correction that has already succeeded from the
    user's point of view, so a failure here must never turn their successful
    edit into an error."""
    key = normalize_name(food_name)
    display = (food_name or "").strip()[:200]
    if not key or not display:
        return False
    if weight_g is None or weight_g < _MIN_WEIGHT_G_TO_STORE:
        return False

    scale = 100.0 / weight_g
    row: dict = {}
    for field, total in totals.items():
        if total is None:
            continue
        value = round(float(total) * scale, 2)
        ceiling = _FIELD_CEILINGS.get(field)
        if ceiling is not None and (value < 0 or value > ceiling):
            logger.info(
                "Not storing custom food %r: %s scaled to %.1f, outside the allowed range",
                key, field, value,
            )
            return False
        row[field] = value

    if not all(field in row for field in _REQUIRED_FIELDS):
        return False
    for field in _OPTIONAL_FIELDS:
        row.setdefault(field, 0.0)

    row.update({"user_id": user_id, "normalized_name": key, "display_name": display})

    supabase = get_supabase()
    try:
        await run_in_threadpool(
            lambda: supabase.table("custom_foods")
            # on_conflict matches idx_custom_foods_user_name — a re-correction
            # of the same food replaces the previous figures rather than
            # accumulating rows that would race on read.
            .upsert(row, on_conflict="user_id,normalized_name")
            .execute()
        )
    except APIError as exc:
        if _is_missing_table(exc):
            logger.info("custom_foods table not migrated — skipping save for %r", key)
            return False
        logger.warning("Custom food save failed for %r: %s", key, exc.code)
        return False
    except Exception:  # noqa: BLE001 - a failed save must never fail the user's log edit
        logger.exception("Unexpected error saving custom food %r", key)
        return False

    logger.info("Saved custom food %r for user %s (%.0f kcal/100g)", key, user_id, row["calories_per_100g"])
    return True
