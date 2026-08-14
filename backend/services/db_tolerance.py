import re
from types import SimpleNamespace

from fastapi.concurrency import run_in_threadpool
from postgrest.exceptions import APIError

UNDEFINED_COLUMN_CODES = {
    "42703",  # raw Postgres "undefined_column" error code
    "PGRST204",  # PostgREST's own schema-cache-miss code — this is the one a
    # real insert/update against Supabase actually returns (verified live):
    # PostgREST validates payload keys against its cached schema and rejects
    # unknown ones itself, before ever issuing SQL, so Postgres's own 42703
    # never gets a chance to fire for this path. Both are handled since which
    # one shows up seems to depend on the operation/PostgREST version.
}

UNDEFINED_TABLE_CODES = {
    "42P01",  # raw Postgres "undefined_table" error code
    "PGRST205",  # PostgREST's own schema-cache-miss code for an unknown
    # table/view ("Could not find the table 'public.workout_sessions' in the
    # schema cache") — same reasoning as PGRST204 above: which one actually
    # shows up depends on whether PostgREST's cache or Postgres itself is the
    # one that rejects the query first.
}


def _undefined_column(exc: APIError) -> str | None:
    message = exc.message or ""
    # PGRST204's own wording: "Could not find the 'fiber' column of
    # 'daily_logs' in the schema cache".
    match = re.search(r"Could not find the '([\w]+)' column", message)
    if match:
        return match.group(1)
    # A raw Postgres-level message, reported two different ways depending on
    # where it originates — a plain quoted name (`column "display_name"`) or
    # a dotted, unquoted table-qualified one (`column profiles.display_name
    # does not exist`). Match either, then drop any table-name prefix.
    match = re.search(r'column "?([\w.]+)"?', message)
    if not match:
        return None
    return match.group(1).rsplit(".", 1)[-1]


async def write_tolerant(execute, data: dict):
    """Runs `execute(data)` (an insert/update against a Supabase table),
    retrying with the offending column progressively stripped out if
    Postgres rejects the write because a column referenced in `data` doesn't
    exist yet on this project.

    This is what a brand-new optional column (e.g. daily_logs.fiber,
    profiles.daily_fiber) needs to roll out safely: there's no migration
    tool tying the backend's schema expectations to what's actually been run
    against a given Supabase project (see sql/schema.sql and CLAUDE.md) — the
    SQL has to be pasted into the dashboard by hand, on the user's own
    schedule, potentially well after this backend redeploys. Without this,
    a single unknown column in the payload would reject the ENTIRE write
    (e.g. every food log, every settings save) until that SQL is run —
    instead, the write still goes through with the other fields applied, and
    only the not-yet-migrated column is silently dropped until then.

    `execute` takes the (possibly narrowed) dict and performs the actual
    Supabase call — kept as a caller-supplied callable rather than this
    module knowing about specific tables/queries.
    """
    remaining = dict(data)
    while True:
        try:
            # A NEW dict every attempt (not a mutate-in-place) — callers that
            # record call arguments (including this module's own tests, via
            # unittest.mock) capture the actual object reference passed in,
            # not a snapshot of it, so mutating one shared dict across
            # retries would silently rewrite what an earlier, already-made
            # call "looks like" it received.
            attempt = dict(remaining)
            return await run_in_threadpool(lambda: execute(attempt))
        except APIError as exc:
            if exc.code not in UNDEFINED_COLUMN_CODES:
                raise
            column = _undefined_column(exc)
            if not column or column not in remaining:
                raise
            remaining = {k: v for k, v in remaining.items() if k != column}


async def read_tolerant(execute):
    """Runs `execute()` (a Supabase select), returning an empty result
    (`.data == []`, matching the shape callers already do `result.data or []`
    against) instead of raising if the query fails because the table itself
    doesn't exist yet on this project.

    This is what a brand-new table (e.g. workout_sessions/workout_sets) needs
    to roll out safely alongside pre-existing routes that now read it (see
    routers/trends.py, routers/analytics.py): the SQL migration that creates
    it has to be pasted into the Supabase dashboard by hand, on the user's
    own schedule, potentially well after this backend redeploys (see
    sql/schema.sql and CLAUDE.md). Without this, a project that hasn't run
    the migration yet would 500 on GET /trends and GET /analytics/insights —
    routes that have nothing to do with the new feature — until it does.
    Unlike write_tolerant, there's no column to strip and retry with; a
    missing table just means "no data for this feature yet," so the fallback
    is a clean empty result rather than a retry loop.
    """
    try:
        return await run_in_threadpool(execute)
    except APIError as exc:
        if exc.code not in UNDEFINED_TABLE_CODES:
            raise
        return SimpleNamespace(data=[])
