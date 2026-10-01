"""BACKGROUND_JOBS_ENABLED: on by default (production must keep its sweeps),
off for a laptop running against the production Supabase project."""
import asyncio
from types import SimpleNamespace

import main
from config import Settings


def test_background_jobs_default_on():
    # Read from the field itself, not Settings(): a developer's own
    # backend/.env legitimately sets this to false.
    assert Settings.model_fields["background_jobs_enabled"].default is True


def _run_lifespan(monkeypatch, enabled):
    started = []

    class _Scheduler:
        def shutdown(self):
            started.append("shutdown")

    monkeypatch.setattr(
        main, "get_settings",
        lambda: SimpleNamespace(background_jobs_enabled=enabled, nutrition_db_local_corpus=False),
    )
    monkeypatch.setattr(main, "start_scheduler", lambda: started.append("cleanup") or _Scheduler())
    monkeypatch.setattr(main, "register_notification_job", lambda s: started.append("notifications"))
    monkeypatch.setattr(main, "register_pet_job", lambda s: started.append("pet"))

    async def _cycle():
        async with main.lifespan(main.app):
            pass

    asyncio.run(_cycle())
    return started


def test_lifespan_starts_every_job_when_enabled(monkeypatch):
    assert _run_lifespan(monkeypatch, True) == ["cleanup", "notifications", "pet", "shutdown"]


def test_lifespan_starts_nothing_when_disabled(monkeypatch):
    assert _run_lifespan(monkeypatch, False) == []
