from functools import lru_cache

import httpx
from supabase import Client, ClientOptions, create_client

from config import get_settings

# Supabase's default client negotiates HTTP/2, which in some network paths
# (proxies, certain sandboxed/VPN'd environments) stalls indefinitely on the
# read after the request is sent — the request never errors, it just hangs.
# supabase-py's own default timeout for that hang is 120s, and since every
# request (via get_current_user -> auth.get_user) goes through this same
# client, a single stalled connection freezes the entire API, not just one
# endpoint. Forcing HTTP/1.1 and a sane timeout turns that into a fast,
# recoverable error instead of an indefinite hang.
_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def _client_options() -> ClientOptions:
    return ClientOptions(
        httpx_client=httpx.Client(http2=False, timeout=_TIMEOUT),
        postgrest_client_timeout=10,
    )


@lru_cache
def get_supabase() -> Client:
    """Service-role client used for all database reads/writes.

    The service role key bypasses Row Level Security, so every query built with
    this client MUST be explicitly filtered by the authenticated user's id
    (see routers/*.py — every query includes .eq("user_id", user.id)).
    """
    settings = get_settings()
    return create_client(settings.supabase_url, settings.supabase_service_key, options=_client_options())


@lru_cache
def get_supabase_anon() -> Client:
    """Anon-key client used ONLY to verify incoming user JWTs (auth.get_user)."""
    settings = get_settings()
    return create_client(settings.supabase_url, settings.supabase_anon_key, options=_client_options())
