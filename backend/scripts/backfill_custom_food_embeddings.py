#!/usr/bin/env python3
"""Populate custom_foods.embedding for rows that predate the Phase 1 migration.

    cd backend
    set -a && source .env && set +a
    python3 scripts/backfill_custom_food_embeddings.py

Every custom food saved BEFORE sql/phase1_nutrition_corpus.sql was applied has
a null embedding, which means it is invisible to the fuzzy path
(nutrition_db_service.lookup_custom_fuzzy) — it still resolves by exact name,
as it always did, it just does not get the inexact second chance. New rows get
their embedding at write time (custom_food_service._attach_embedding); this is
purely the one-off catch-up for the existing ones.

Safe to run repeatedly and safe to skip entirely: nothing breaks without it,
the affected rows simply keep their pre-Phase-1 behaviour. It only ever fills
in nulls — an existing embedding is left alone, so it will not fight the write
path if a user edits a food while this is running.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database import get_supabase  # noqa: E402
from services import corpus_embedding  # noqa: E402

_BATCH = 200


def _fail(message: str) -> int:
    """Scripts here are run by hand on a server, often once, often months
    apart. A raw traceback for a predictable setup mistake wastes the
    operator's time; say what to do instead."""
    print(f"\nERROR: {message}\n", file=sys.stderr)
    return 1


def main() -> int:
    supabase = get_supabase()

    # PostgREST caps a single response; page rather than assuming one read
    # covers a table that could hold thousands of rows across all users.
    rows: list[dict] = []
    offset = 0
    while True:
        try:
            page = (
                supabase.table("custom_foods")
                .select("id, normalized_name")
                .is_("embedding", "null")
                .range(offset, offset + _BATCH - 1)
                .execute()
            ).data or []
        except Exception as exc:  # noqa: BLE001 - turn a setup mistake into an instruction
            detail = str(exc)
            if "embedding" in detail or "column" in detail.lower():
                return _fail(
                    "custom_foods has no 'embedding' column yet.\n"
                    "Run sql/phase1_nutrition_corpus.sql in the Supabase SQL editor first, "
                    "then re-run this script."
                )
            return _fail(f"Could not read custom_foods: {detail}")
        rows.extend(page)
        if len(page) < _BATCH:
            break
        offset += _BATCH

    if not rows:
        print("Nothing to backfill — every custom food already has an embedding.")
        return 0

    print(f"{len(rows)} custom foods without an embedding")
    vectors = corpus_embedding.embed_documents([r["normalized_name"] for r in rows])

    # One UPDATE per row rather than a bulk upsert: an upsert would need every
    # NOT NULL column in the payload (macros, user_id, display_name) and a
    # mistake there would overwrite a user's own saved figures with whatever
    # this script happened to select. Updating a single column by primary key
    # cannot do that, and a few hundred small writes once is not worth the
    # risk of getting it wrong.
    for index, (row, vector) in enumerate(zip(rows, vectors), start=1):
        supabase.table("custom_foods").update({"embedding": vector}).eq("id", row["id"]).execute()
        if index % 50 == 0 or index == len(rows):
            print(f"  updated {index}/{len(rows)}", flush=True)

    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
