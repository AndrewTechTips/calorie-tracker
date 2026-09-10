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

import asyncio
import logging
import re
import unicodedata
from collections.abc import Iterable

from fastapi.concurrency import run_in_threadpool
from postgrest.exceptions import APIError

from config import get_settings
from database import get_supabase
from services import corpus_embedding
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


def _row_to_macros(row: dict, fallback_name: str) -> dict:
    """One row -> the same per-100g dict shape nutrition_db_service.lookup()
    returns, so _resolve_ingredient can slot it into the existing trust order
    without a special case. Shared by get() and get_many() so the single-name
    and bulk paths can never drift in what they return."""
    return {
        "food_name": row.get("display_name") or fallback_name,
        "source": "user_custom",
        "calories_per_100g": float(row["calories_per_100g"]),
        "protein_per_100g": float(row["protein_per_100g"]),
        "carbs_per_100g": float(row["carbs_per_100g"]),
        "fats_per_100g": float(row["fats_per_100g"]),
        "fiber_per_100g": float(row.get("fiber_per_100g") or 0),
        "sugar_per_100g": float(row.get("sugar_per_100g") or 0),
        "sodium_per_100g": float(row.get("sodium_per_100g") or 0),
    }


# PostgREST renders an `in` filter into the query STRING
# (?normalized_name=in.("a","b",...)), so an unbounded key list would
# eventually build a URL long enough for a proxy or gateway to reject —
# a failure that would show up as a mysterious 4xx on large meals only.
# In practice a scan tops out at 15 ingredients x 2 names = 30 keys of a few
# words each, comfortably inside any limit; this cap exists so that stays
# true if max_ingredients is ever raised, not because 30 is close to the line.
# Chunks run concurrently, so more than one chunk costs no extra wall time.
_MAX_KEYS_PER_QUERY = 50


async def get_many(user_id: str, food_names: Iterable[str]) -> dict[str, dict]:
    """Every custom food this user has for ANY of `food_names`, in ONE query.

    WHY THIS EXISTS. The per-ingredient path used to call get() twice per
    ingredient (once for the display name, once for the English search_name),
    sequentially, inside each ingredient's own resolve. A 6-ingredient scan
    was therefore 12 Supabase round trips — and because each one goes through
    run_in_threadpool (the Supabase client is synchronous), 12 threads out of
    anyio's default pool of 40, for a handful of concurrent scans. That is a
    textbook N+1: the work scales with ingredient count when it never needed
    to, since every one of those lookups hits the same small per-user table.
    Prefetching the whole scan's keys up front collapses it to exactly one
    query, whatever the meal looks like.

    Returns {normalized_name: macro_dict} — keyed by the NORMALIZED name, so
    callers must normalize before looking up. Use lookup_in() below rather
    than indexing this directly; it keeps the normalization in one place.

    Never raises, same contract as get(): a missing table (unmigrated
    project), a failed request, or an empty key set all resolve to an empty
    dict, and every caller already treats "no custom food" as the normal
    case."""
    keys = sorted({k for k in (normalize_name(n) for n in food_names) if k})
    if not keys:
        return {}

    chunks = [keys[i : i + _MAX_KEYS_PER_QUERY] for i in range(0, len(keys), _MAX_KEYS_PER_QUERY)]
    results = await asyncio.gather(*(_fetch_chunk(user_id, chunk) for chunk in chunks))

    found: dict[str, dict] = {}
    for rows in results:
        for row in rows:
            key = row.get("normalized_name")
            if key:
                found[key] = _row_to_macros(row, key)
    return found


async def _fetch_chunk(user_id: str, keys: list[str]) -> list[dict]:
    supabase = get_supabase()
    try:
        result = await run_in_threadpool(
            lambda: supabase.table("custom_foods")
            .select("*")
            .eq("user_id", user_id)
            # .in_() is a PostgREST filter, not string interpolation — the
            # keys travel as query-parameter values and are never spliced
            # into SQL. Combined with the .eq("user_id") above (and the RLS
            # policy behind it), a user can only ever match their own rows.
            .in_("normalized_name", keys)
            .execute()
        )
    except APIError as exc:
        if _is_missing_table(exc):
            return []  # table not migrated yet — behave as if the feature is off
        logger.warning("Bulk custom food lookup failed (%d keys): %s", len(keys), exc.code)
        return []
    except Exception:  # noqa: BLE001 - never let a personal-foods read break a scan
        logger.exception("Unexpected error in bulk custom food lookup (%d keys)", len(keys))
        return []
    return result.data or []


def lookup_in(prefetched: dict[str, dict] | None, food_name: str) -> dict | None:
    """Resolve one name against a get_many() result. Pure and synchronous —
    no I/O, which is the entire point: after the single prefetch, every
    per-ingredient custom-food check is a dict hit.

    Exists so callers never normalize by hand: a caller that forgot would
    silently miss every saved food whose name had a capital letter or a
    diacritic, and nothing would look broken."""
    if not prefetched:
        return None
    return prefetched.get(normalize_name(food_name))


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

    return _row_to_macros(row, food_name)


async def list_all(user_id: str) -> list[dict]:
    """Every custom food this user has saved, newest-corrected first.

    Unlike get()/get_many() — which return the internal per-100g macro shape
    the pricing pipeline consumes — this returns the ROWS, id included,
    because the management UI needs something to edit and delete by. Never
    raises: an unmigrated project lists nothing rather than breaking the
    Saved tab."""
    supabase = get_supabase()
    try:
        result = await run_in_threadpool(
            lambda: supabase.table("custom_foods")
            .select("*")
            .eq("user_id", user_id)
            .order("updated_at", desc=True)
            .execute()
        )
    except APIError as exc:
        if _is_missing_table(exc):
            return []
        logger.warning("Listing custom foods failed: %s", exc.code)
        return []
    except Exception:  # noqa: BLE001 - an empty list is a fine degradation for a management screen
        logger.exception("Unexpected error listing custom foods")
        return []
    return result.data or []


async def update_one(user_id: str, food_id: str, values: dict) -> dict | None:
    """Corrects a saved food's per-100g figures in place. Returns the updated
    row, or None if it doesn't exist / isn't this user's.

    THE POINT OF THIS FUNCTION. A saved food outranks USDA in the pricing
    trust order, so a typo here is worse than no entry at all — it silently
    misprices that food forever, with the "Your label" chip vouching for it.
    Until this existed there was no way to take one back.

    Unlike save_from_portion, values arrive ALREADY per-100g (the user is
    editing the reference itself, not a portion of it), so there is no
    division and no minimum-weight rule — only the shared ceilings, which
    are what stop a second typo replacing the first.

    Deliberately raises nothing but returns None on a miss: the .eq(user_id)
    filter means a foreign id simply matches no rows, which the router turns
    into a 404. That is the same ownership pattern every other route here
    uses (see CLAUDE.md's note on filtering every service-role query)."""
    row = {}
    for field, value in values.items():
        if value is None:
            continue
        ceiling = _FIELD_CEILINGS.get(field)
        if ceiling is None:
            continue  # ignore anything not a known per-100g field
        numeric = float(value)
        if numeric < 0 or numeric > ceiling:
            raise ValueError(f"{field} must be between 0 and {ceiling:g} per 100g")
        row[field] = round(numeric, 2)

    display = (values.get("display_name") or "").strip()[:200]
    if display:
        # Renaming changes the lookup KEY, not just the label — that is the
        # whole identity of the row (see normalize_name). Both move together
        # or the entry becomes unreachable from the pricing pipeline while
        # still looking fine in this list.
        key = normalize_name(display)
        if not key:
            raise ValueError("That name has no letters or digits to save under")
        row["display_name"] = display
        row["normalized_name"] = key

    if not row:
        raise ValueError("Nothing to update")
    row["updated_at"] = "now()"

    supabase = get_supabase()
    try:
        result = await run_in_threadpool(
            lambda: supabase.table("custom_foods")
            .update(row)
            .eq("id", food_id)
            .eq("user_id", user_id)  # ownership — never trust the id alone
            .execute()
        )
    except APIError as exc:
        if _is_missing_table(exc):
            return None
        # 23505 = unique violation: renaming onto a name this user already
        # has. Surfaced as a clean message rather than a 500, since it is a
        # completely ordinary thing to try.
        if (getattr(exc, "code", None) or "") == "23505":
            raise ValueError("You already have a saved food with that name") from exc
        logger.warning("Updating custom food %s failed: %s", food_id, exc.code)
        return None
    rows = result.data or []
    return rows[0] if rows else None


async def delete_one(user_id: str, food_id: str) -> bool:
    """Removes a saved food. True if a row was actually deleted — False means
    it didn't exist or belongs to someone else, which the router turns into a
    404 rather than a silent success."""
    supabase = get_supabase()
    try:
        result = await run_in_threadpool(
            lambda: supabase.table("custom_foods")
            .delete()
            .eq("id", food_id)
            .eq("user_id", user_id)  # ownership — never trust the id alone
            .execute()
        )
    except APIError as exc:
        if _is_missing_table(exc):
            return False
        logger.warning("Deleting custom food %s failed: %s", food_id, exc.code)
        return False
    return bool(result.data)


def _attach_embedding(row: dict, key: str) -> None:
    """Adds the 384-dim vector that lets nutrition_db_service.lookup_custom_fuzzy
    find this food by an INEXACT name later ("piept pui gratar" for a saved
    "piept de pui la gratar"). The exact-name path below does not need it;
    this is purely what makes the fuzzy second chance possible.

    Silently does nothing when the column does not exist yet (the Phase 1
    migration has not been applied) or when embedding fails — a missing
    embedding costs this row its fuzzy matching, nothing more, and must never
    turn a successful log correction into an error. Same best-effort contract
    as the rest of this function.

    The embedded text is `key`, i.e. the normalized name, because that is
    exactly what nutrition_corpus embeds for its own rows — both sides of the
    cosine comparison have to have been through the same preprocessing or the
    similarity is meaningless."""
    if not get_settings().nutrition_db_local_corpus:
        return
    try:
        vector = corpus_embedding.embed_query(key)
    except Exception:  # noqa: BLE001 - see docstring
        logger.warning("Could not embed custom food %r; it will still match by exact name", key)
        return
    if vector is not None:
        row["embedding"] = vector


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
    _attach_embedding(row, key)

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
