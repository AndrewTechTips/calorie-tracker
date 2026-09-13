import re
from contextlib import contextmanager
from types import SimpleNamespace

import httpx
from fastapi.concurrency import run_in_threadpool
from postgrest.exceptions import APIError
from pydantic import ValidationError

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


# --- Transient failures (the network, not the schema) ----------------------
# Everything above tolerates Supabase being at a DIFFERENT SCHEMA VERSION
# than this backend expects. This half tolerates Supabase being briefly
# ABSENT: every query crosses the public internet on a 10s httpx timeout
# (see database.py), so a slow or momentarily unreachable PostgREST is a
# normal operating condition, not a bug worth a stack trace each time.
#
# It arrives in two shapes:
#   * postgrest.APIError — the ordinary path. An edge-proxy 504 carries none
#     of PostgREST's own error fields, so `code` ends up the bare HTTP status
#     and the message is whatever the proxy wrote ("Gateway Timeout").
#   * pydantic.ValidationError — the SAME 504, leaking raw out of older
#     postgrest builds. APIErrorFromJSON declares message/code/hint/details
#     as `Optional[str]` with no default, which pydantic v2 reads as
#     required-but-nullable, so a bodiless `{"message": "Gateway Timeout"}`
#     fails validation with exactly 3 errors and THAT parse error propagates
#     in place of an APIError. postgrest 2.31.0 (pinned in requirements.txt)
#     converts it; the image actually deployed may be older, and callers must
#     not depend on which — so both are recognized.
#
# This exists because of a live failure (2026-09-13): that raw ValidationError
# escaped notification_scheduler's very first query and ended one sweep's
# reminders for every user at once.
#
# The classification ONLY picks a log level and never changes control flow —
# a caller skips the same unit of work either way — so misjudging an error
# here can cost log noise, never a sweep.
TRANSIENT_DB_STATUS_CODES = {"408", "425", "429", "500", "502", "503", "504", "520", "521", "522", "524"}
TRANSIENT_DB_MESSAGE_MARKERS = (
    "gateway timeout",
    "bad gateway",
    "service unavailable",
    "timeout",
    "timed out",
    "temporarily unavailable",
    "connection",
    # postgrest's own fallback message when it couldn't parse the error body
    # at all (generate_default_error_message) — i.e. exactly the 504 above,
    # already converted for us by a newer client.
    "json could not be generated",
)


def is_transient_db_error(exc: BaseException) -> bool:
    """True for "Supabase was unreachable or slow just now", false for a real
    bug (a KeyError on a row, a 42703 missing column, a 42501 grant problem) —
    those still deserve a traceback."""
    if isinstance(exc, (httpx.HTTPError, ValidationError)):
        return True
    if isinstance(exc, APIError):
        if str(exc.code or "") in TRANSIENT_DB_STATUS_CODES:
            return True
        return any(marker in (exc.message or "").lower() for marker in TRANSIENT_DB_MESSAGE_MARKERS)
    return False


def describe_db_error(exc: BaseException) -> str:
    """One-line form of an exception, for a warning that shouldn't span four
    log lines — APIError.__repr__ is deliberately multi-line ("Error 504:" /
    "Message: Gateway Timeout" / ...)."""
    return " ".join(f"{type(exc).__name__}: {exc}".split()) or type(exc).__name__


@contextmanager
def sweep_guard(logger, what: str, subject: str | None = None):
    """Isolates one unit of work inside a background sweep.

    Nothing escapes: a transient error (above) is logged as a single warning
    and that unit is skipped until the sweep's next tick; anything else is
    logged with its full traceback. Either way the rest of the sweep runs.

    That asymmetry is the whole point — nobody is watching a background job
    fail in real time, so the two failure modes must stay visibly different:
    a warning line means "the network blinked, it will retry itself", an
    ERROR with a traceback means "someone needs to look at this".
    """
    try:
        yield
    except Exception as exc:
        if is_transient_db_error(exc):
            logger.warning("Skipping %s for %s this sweep: %s", what, subject, describe_db_error(exc))
        else:
            logger.exception("Failed to process %s for %s", what, subject)
