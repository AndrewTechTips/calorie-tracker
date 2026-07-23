from slowapi import Limiter

from auth import rate_limit_key

# Single shared limiter instance for the whole app. Every route gets the
# generous default unless it explicitly overrides it (see routers/scan.py and
# the AI-triggering path in routers/logs.py, both capped lower since they
# spend real money on Gemini API calls). 120/minute is far above any real
# usage pattern this app has (the dashboard fires at most ~4 parallel GETs on
# load) — it exists to stop a runaway client/script, not to throttle people.
limiter = Limiter(key_func=rate_limit_key, default_limits=["120/minute"])
