from functools import lru_cache

from supabase import Client, create_client

from .config import get_settings


@lru_cache
def get_supabase() -> Client:
    """Service-role client used for all database reads/writes.

    The service role key bypasses Row Level Security, so every query built with
    this client MUST be explicitly filtered by the authenticated user's id
    (see routers/*.py — every query includes .eq("user_id", user.id)).
    """
    settings = get_settings()
    return create_client(settings.supabase_url, settings.supabase_service_key)


@lru_cache
def get_supabase_anon() -> Client:
    """Anon-key client used ONLY to verify incoming user JWTs (auth.get_user)."""
    settings = get_settings()
    return create_client(settings.supabase_url, settings.supabase_anon_key)
