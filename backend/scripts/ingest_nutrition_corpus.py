#!/usr/bin/env python3
"""Build public.nutrition_corpus — the local mirror of USDA FoodData Central
and the Romanian slice of Open Food Facts.

Run this ONCE after applying sql/phase1_nutrition_corpus.sql, then again
whenever you want to refresh (quarterly is plenty — reference nutrition data
does not move fast). It is idempotent: rows are upserted on
(source, source_id), so a re-run updates in place rather than duplicating.

    cd backend
    set -a && source .env && set +a          # SUPABASE_URL + SUPABASE_SERVICE_KEY
    python3 scripts/ingest_nutrition_corpus.py --usda --off

    # or one source at a time / a dry run that writes nothing:
    python3 scripts/ingest_nutrition_corpus.py --usda --dry-run
    python3 scripts/ingest_nutrition_corpus.py --off --off-pages 40

Requires `pip install -r requirements.txt` (fastembed is now in there).

WHY A SCRIPT AND NOT A MIGRATION. ~24k rows each need a 384-dim embedding,
which is a CPU job (about 2-4 minutes on a laptop, once). That does not belong
in a SQL file you paste into a web editor, and it does not belong at app
startup either — the running backend should never be the thing that decides
to rebuild a reference corpus.

-- USDA ----------------------------------------------------------------------
Three datasets, all small, all downloaded straight from fdc.nal.usda.gov as
bulk JSON — NOT through the rate-limited /v1/foods/search API this replaces:

    Foundation   ~400 items    lab-analysed whole foods
    SR Legacy    ~7,800 items  the classic reference tables
    FNDDS/Survey ~5,400 items  "as consumed" prepared foods

Deliberately NOT Branded (~2M US retail SKUs). It was excluded from the live
API path too, for the same reason: it is US-retail-specific, irrelevant to
this app's Romanian users, and it drowns the small curated generic datasets
that a query like "chicken breast" actually wants. Open Food Facts covers the
branded case for the market that matters here.

-- Open Food Facts ------------------------------------------------------------
Fetched through the search-a-licious API filtered to countries_tags:en:romania,
paged. The alternative is the 12.8 GB full JSONL dump (or the 7.9 GB HuggingFace
parquet), which is the right call if you ever want the complete set — but the
API path needs no multi-gigabyte download, is resumable, and 10k Romanian
products is already far more than this app's users will ever hit. If you do
want the dump, the row-building below (`_off_row`) takes the same product dict
either way.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import zipfile
from typing import Iterable, Iterator

import httpx

# Import the backend's own normalizer so the text indexed here and the text a
# query is normalized to at read time cannot drift apart. This is the whole
# reason the script lives inside backend/ rather than in a standalone tools
# repo.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.nutrition_db_service import _normalize  # noqa: E402
from services import corpus_embedding  # noqa: E402


# ---------------------------------------------------------------------------
# USDA
# ---------------------------------------------------------------------------
# Pinned, dated filenames rather than a "latest" alias, for the same reason
# config.py pins dated Mistral model ids instead of -latest ones: an alias
# that silently repoints is how a corpus quietly changes underneath a recorded
# eval baseline. Check https://fdc.nal.usda.gov/download-datasets for newer
# releases and bump these deliberately, re-running the eval afterwards.
_USDA_DATASETS = [
    ("FoodData_Central_foundation_food_json_2026-04-30.zip", "FoundationFoods"),
    ("FoodData_Central_sr_legacy_food_json_2018-04.zip", "SRLegacyFoods"),
    ("FoodData_Central_survey_food_json_2024-10-31.zip", "SurveyFoods"),
]
_USDA_BASE = "https://fdc.nal.usda.gov/fdc-datasets/"

# Same nutrient numbers the live API path already used — see
# nutrition_db_service._USDA_NUTRIENT_NUMBERS. Sodium (307) is reported in mg
# by USDA and this app stores sodium in mg everywhere, so it passes through
# unconverted.
_NUTRIENT_NUMBERS = {
    "calories_per_100g": "208",
    "protein_per_100g": "203",
    "fats_per_100g": "204",
    "carbs_per_100g": "205",
    "fiber_per_100g": "291",
    "sugar_per_100g": "269",
    "sodium_per_100g": "307",
}
_REQUIRED = ("calories_per_100g", "protein_per_100g", "fats_per_100g", "carbs_per_100g")


def _download(url: str, cache_dir: str) -> bytes:
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, os.path.basename(url))
    if os.path.exists(path) and os.path.getsize(path) > 0:
        print(f"  cached  {os.path.basename(url)} ({os.path.getsize(path) // 1024} KB)")
        return open(path, "rb").read()
    print(f"  fetching {os.path.basename(url)} …", flush=True)
    with httpx.Client(timeout=httpx.Timeout(300.0, connect=30.0), follow_redirects=True) as client:
        resp = client.get(url)
        resp.raise_for_status()
        open(path, "wb").write(resp.content)
    print(f"  saved   {os.path.basename(url)} ({len(resp.content) // 1024} KB)")
    return resp.content


def _usda_rows(cache_dir: str) -> Iterator[dict]:
    for filename, top_key in _USDA_DATASETS:
        blob = _download(_USDA_BASE + filename, cache_dir)
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            inner = zf.namelist()[0]
            payload = json.loads(zf.read(inner))
        items = payload.get(top_key) or next(iter(payload.values()))
        kept = 0
        for item in items:
            row = _usda_row(item)
            if row is not None:
                kept += 1
                yield row
        print(f"  {filename}: {kept}/{len(items)} usable")


def _usda_row(item: dict) -> dict | None:
    # The Foundation file genuinely contains null entries in its array — real
    # bulk data, not a parsing mistake. One of those must not abort an ingest
    # of 13,000 good rows.
    if not isinstance(item, dict):
        return None
    description = (item.get("description") or "").strip()
    fdc_id = item.get("fdcId")
    if not description or fdc_id is None:
        return None

    by_number: dict[str, float] = {}
    for entry in item.get("foodNutrients") or []:
        number = ((entry.get("nutrient") or {}).get("number"))
        amount = entry.get("amount")
        if number and amount is not None:
            by_number[str(number)] = amount

    values = {}
    for field, number in _NUTRIENT_NUMBERS.items():
        raw = by_number.get(number)
        # None, not 0, when the source is silent — the whole point of the
        # nullable columns. Only the four required macros force a skip.
        values[field] = float(raw) if raw is not None else None

    if any(values[field] is None for field in _REQUIRED):
        return None

    return {
        "source": "usda",
        "source_id": str(fdc_id),
        "food_name": description[:300],
        "search_text": _normalize(description)[:300],
        **values,
    }


# ---------------------------------------------------------------------------
# Open Food Facts
# ---------------------------------------------------------------------------
_OFF_SEARCH_URL = "https://search.openfoodfacts.org/search"
_OFF_PAGE_SIZE = 100
# Open Food Facts asks every API consumer to identify itself; an anonymous
# scraper is what gets an IP blocked. Same courtesy the live path already
# extends.
_OFF_HEADERS = {"User-Agent": "IronLog/1.0 (nutrition corpus ingest; contact: app maintainer)"}

_OFF_NUTRIMENTS = {
    "calories_per_100g": "energy-kcal_100g",
    "protein_per_100g": "proteins_100g",
    "carbs_per_100g": "carbohydrates_100g",
    "fats_per_100g": "fat_100g",
    "fiber_per_100g": "fiber_100g",
    "sugar_per_100g": "sugars_100g",
    "sodium_per_100g": "sodium_100g",
}


def _coerce(value) -> float | None:
    """Open Food Facts nutriments are typed by hand by contributors, so a
    field being PRESENT proves nothing about it being numeric — ''/'n/a'/NaN
    are all real, observed values. Same defensive coercion barcode_lookup.py
    already applies for the same reason."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):  # NaN / inf
        return None
    return number


def _off_row(product: dict) -> dict | None:
    name = (product.get("product_name") or "").strip()
    code = (product.get("code") or "").strip()
    if not name or not code:
        return None

    nutriments = product.get("nutriments") or {}
    values: dict[str, float | None] = {}
    for field, key in _OFF_NUTRIMENTS.items():
        number = _coerce(nutriments.get(key))
        if field == "sodium_per_100g" and number is not None:
            # OFF reports sodium in GRAMS per 100g; this app stores milligrams.
            number *= 1000
        values[field] = number

    if any(values[field] is None for field in _REQUIRED):
        return None
    # A row where every macro is zero is a placeholder someone created and
    # never filled in, not a real food. _is_placeholder_zero_entry rejects
    # these at read time anyway; dropping them here keeps them out of the
    # vector index entirely, where they would otherwise occupy top-K slots.
    if not any(values[field] for field in _REQUIRED):
        return None

    return {
        "source": "openfoodfacts",
        "source_id": code,
        "food_name": name[:300],
        "search_text": _normalize(name)[:300],
        **values,
    }


def _off_rows(max_pages: int) -> Iterator[dict]:
    seen: set[str] = set()
    with httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0), headers=_OFF_HEADERS) as client:
        for page in range(1, max_pages + 1):
            params = {
                "q": 'countries_tags:"en:romania"',
                "page_size": _OFF_PAGE_SIZE,
                "page": page,
                "fields": "code,product_name,nutriments",
            }
            try:
                resp = client.get(_OFF_SEARCH_URL, params=params)
                resp.raise_for_status()
                hits = resp.json().get("hits") or []
            except Exception as exc:  # noqa: BLE001 - one bad page must not lose the rest
                print(f"  page {page} failed ({exc}); continuing")
                continue
            if not hits:
                print(f"  page {page} empty — stopping")
                break
            kept = 0
            for product in hits:
                row = _off_row(product)
                if row is None or row["source_id"] in seen:
                    continue
                seen.add(row["source_id"])
                kept += 1
                yield row
            print(f"  page {page:>3}: {kept}/{len(hits)} usable  (total {len(seen)})", flush=True)
            # Deliberate pacing. This is a free, donation-funded service and
            # we are pulling thousands of rows from it exactly once.
            time.sleep(0.4)


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------
def _dedupe(rows: Iterable[dict]) -> list[dict]:
    """Last row wins per (source, source_id). Postgres rejects an ON CONFLICT
    upsert whose payload touches the same conflict target twice in one
    statement ("cannot affect row a second time"), and Open Food Facts can
    legitimately return the same barcode on two pages while the index shifts
    underneath a paged read."""
    by_key: dict[tuple[str, str], dict] = {}
    for row in rows:
        by_key[(row["source"], row["source_id"])] = row
    return list(by_key.values())


def _upsert(rows: list[dict], batch_size: int = 250) -> None:
    from database import get_supabase

    supabase = get_supabase()
    total = len(rows)
    for start in range(0, total, batch_size):
        chunk = rows[start : start + batch_size]
        supabase.table("nutrition_corpus").upsert(chunk, on_conflict="source,source_id").execute()
        print(f"  upserted {min(start + batch_size, total)}/{total}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--usda", action="store_true", help="ingest USDA Foundation + SR Legacy + FNDDS")
    parser.add_argument("--off", action="store_true", help="ingest the Romanian Open Food Facts slice")
    parser.add_argument("--off-pages", type=int, default=100, help="max OFF pages of 100 (default 100 = 10k products)")
    parser.add_argument("--cache-dir", default=".corpus-cache", help="where USDA zips are cached between runs")
    parser.add_argument("--dry-run", action="store_true", help="build and embed rows but write nothing")
    parser.add_argument("--limit", type=int, default=0, help="cap total rows (for a quick smoke test)")
    args = parser.parse_args()

    if not args.usda and not args.off:
        parser.error("pick at least one of --usda / --off")

    rows: list[dict] = []
    if args.usda:
        print("USDA FoodData Central:")
        rows.extend(_usda_rows(args.cache_dir))
    if args.off:
        print("Open Food Facts (Romania):")
        rows.extend(_off_rows(args.off_pages))

    rows = _dedupe(rows)
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        print("nothing to ingest")
        return 1

    print(f"\n{len(rows)} rows to embed")
    # Embed the SEARCH TEXT, not the raw name: the query side is normalized
    # the same way before its own embedding is computed, so both sides of the
    # cosine comparison have been through identical preprocessing.
    vectors = corpus_embedding.embed_documents([row["search_text"] for row in rows])
    for row, vector in zip(rows, vectors):
        row["embedding"] = vector
    print(f"embedded {len(vectors)} rows, dim={len(vectors[0])}")

    if args.dry_run:
        print("\n--dry-run: not writing. Sample:")
        for row in rows[:5]:
            print(f"  [{row['source']}] {row['food_name'][:56]:<58} {row['calories_per_100g']:>6.0f} kcal")
        return 0

    print("\nwriting to Supabase:")
    _upsert(rows)
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
