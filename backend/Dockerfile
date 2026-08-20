# syntax=docker/dockerfile:1
#
# Iron Log API — production image. Two stages: the first resolves/builds
# Python deps into an isolated venv (so build tooling and pip's cache never
# reach the runtime image), the second copies just that venv plus the app
# source onto a fresh slim base and runs it as a non-root user.
#
# This app has no compiled/native dependency in requirements.txt (pure-Python
# wheels throughout — pillow ships manylinux wheels), so the builder stage
# needs no gcc/build-essential; kept as its own stage anyway for Docker layer
# caching (deps layer only invalidates when requirements.txt changes, not on
# every source edit) and so a future native dependency doesn't silently bloat
# the runtime image.

FROM python:3.14.7-slim-bookworm AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copied and installed before the rest of the source so this layer is only
# rebuilt when requirements.txt actually changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt


FROM python:3.14.7-slim-bookworm

# Runs as an unprivileged, shell-less service account — a compromised
# process (e.g. via a future dependency CVE) gets no shell and no
# capability to write outside its own app directory.
RUN groupadd --system --gid 1000 ironlog \
    && useradd --system --uid 1000 --gid ironlog --home-dir /app --shell /usr/sbin/nologin ironlog

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY --chown=ironlog:ironlog . .

USER ironlog

EXPOSE 8000

# GET / is the fast, dependency-free liveness ping (see main.py) — never
# touches Supabase, so a transient DB hiccup never flaps the container's
# health status. Runs via python (no curl/wget in the slim base, and adding
# one just for this would be an extra package purely for a healthcheck).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/', timeout=3)" || exit 1

# --workers 1 is deliberate, not a default left unset: quota_service.py's
# per-provider RPM/RPD counters, rate_limit.py's slowapi Limiter, and the
# APScheduler cleanup job in services/cleanup_service.py are all in-process,
# in-memory state (see CLAUDE.md's "Task-based AI routing" section — "this
# is a single Render instance, so there's no second process to desync
# from"). A second worker here would silently double-count nothing (each
# worker gets its own independent counters), under-enforce rate limits, and
# run the daily cleanup job twice. Scale this service by giving the
# container more CPU, not by adding workers/replicas, unless that in-memory
# state is first moved to something shared (e.g. Redis).
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
