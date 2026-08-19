# syntax=docker/dockerfile:1

# Iron Log backend — production image for a plain Linux VPS (no Render
# buildpack behind this one). Two-stage build: dependencies are installed
# into a throwaway "builder" stage so pip's build/wheel cache never ends up
# in the shipped image, then only the installed packages + app code are
# copied into a slim runtime stage.
#
# Base image tracks the Python version backend/render.yaml already pins
# (PYTHON_VERSION) so behavior can't drift between the two deploy targets —
# bump both together if you ever change it.

FROM python:3.14-slim AS builder

WORKDIR /app

# requirements.txt is copied and installed before the rest of the source
# tree — this layer is only invalidated when dependencies actually change,
# so editing application code never forces a full pip reinstall on rebuild.
COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

FROM python:3.14-slim AS runtime

# Run as a non-root user — this process never needs root (no privileged
# port, no runtime package installs).
RUN groupadd --gid 1000 appuser \
    && useradd --uid 1000 --gid appuser --create-home --shell /usr/sbin/nologin appuser

WORKDIR /app

# Pull only the installed packages out of the builder stage (its pip cache
# and build artifacts are left behind), owned by the non-root user.
COPY --from=builder --chown=appuser:appuser /root/.local /home/appuser/.local

# Application code. .dockerignore keeps .env, tests, caches, and other
# dev-only files out of the build context entirely.
COPY --chown=appuser:appuser . .

USER appuser

ENV PATH=/home/appuser/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8000

# GET / is the fast, dependency-free liveness ping main.py defines for
# exactly this purpose (no Supabase/AI calls) — see main.py's health_check
# docstring for why GET /health (which does a real DB query) is deliberately
# NOT used here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/', timeout=3).status == 200 else 1)"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
