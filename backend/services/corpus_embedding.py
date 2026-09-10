"""The one place a text is turned into a 384-dim vector.

Shared by the ingest script (which embeds ~24k corpus names once) and by
nutrition_db_service (which embeds one query per uncached lookup). Both sides
MUST go through here: an embedding is only comparable to another embedding
produced by the identical model with identical preprocessing, so a second
call site that picked its own model or skipped normalization would produce
vectors that are silently, unfixably wrong — cosine similarity would still
return a number, it would just be meaningless.

MODEL CHOICE, and why it is not multilingual-e5-small
-----------------------------------------------------
The plan called for intfloat/multilingual-e5-small. fastembed 0.8.0 does not
ship it — its catalog has exactly one multilingual model at 384 dimensions
under 0.5 GB, which is the one used here, plus multilingual-e5-LARGE at 1024
dims and 2.24 GB.

Both were measured against real USDA descriptions before choosing (2026-09-10;
the numbers are reproduced in sql/phase1_nutrition_corpus.sql's header). The
summary that decided it:

  * e5-large has better RECALL — it surfaces "Bread, whole-wheat" for the
    Romanian "paine integrala", which MiniLM effectively does not (0.047).
  * e5-large has WORSE score separation. Its similarities compress into a
    0.80-0.91 band across both correct and incorrect answers: 'banana' scores
    "Banana pudding" 0.847, "Bananas, raw" 0.846 and "Banana chips" 0.845 — a
    0.002 spread, which is noise. It also ranks "Beef, ground" (0.824) above
    the correct chicken entry (0.800) for 'piept de pui'.
  * Neither can separate a food from its fried/dried/composite variants, so
    neither is usable as a ranking signal regardless.

Since vectors are used for RECALL ONLY here — the caller re-ranks with its own
lexical score and filters with its own plausibility gates, and never reads
cosine similarity as a quality measure — e5-large's marginally better ordering
buys nothing, while its 10x size costs real RAM on a single small VPS. The
cross-lingual recall gap it would have closed is covered two other ways: the
full-text half of the hybrid query, and the fact that Stage 1 already produces
an English `search_name` and lookup_best() queries both languages.

To switch anyway: change _MODEL_NAME here, change vector(384) to vector(1024)
in sql/phase1_nutrition_corpus.sql (both the table and the function signature),
drop and recreate the HNSW indexes, and re-run the ingest. Nothing else needs
to know.

THE MODEL IS LAZY-LOADED AND NEVER LOADED AT IMPORT. It is ~220 MB on disk and
a few hundred MB resident, downloaded to _CACHE_DIR on first use. Importing
this module must stay free, because the whole backend imports
nutrition_db_service at startup and a container that pauses to download a
model before serving its first request is a container that fails its health
check.
"""

from __future__ import annotations

import logging
import os
import threading

logger = logging.getLogger("corpus_embedding")

_MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
EMBEDDING_DIM = 384

# Kept next to the app rather than in ~/.cache so a Docker layer can pre-warm
# it (see the Dockerfile note in the Phase 1 section of CLAUDE.md) and so a
# read-only or per-request-ephemeral HOME cannot silently trigger a re-download
# on every call.
_CACHE_DIR = os.environ.get("FASTEMBED_CACHE_DIR", "/tmp/ironlog-fastembed")

_model = None
_model_lock = threading.Lock()


def _get_model():
    """Double-checked lazy init. The lock matters: uvicorn serves concurrent
    requests, fastembed's first call downloads and initialises an ONNX
    session, and two threads racing that produces either a corrupt partial
    download or two full model copies resident at once."""
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        from fastembed import TextEmbedding  # imported here, not at module top — see docstring

        logger.info("Loading embedding model %s (first call downloads ~220MB)", _MODEL_NAME)
        _model = TextEmbedding(model_name=_MODEL_NAME, cache_dir=_CACHE_DIR)
        logger.info("Embedding model ready")
        return _model


def is_available() -> bool:
    """Whether embedding can work at all in this process, without paying to
    find out. Used by nutrition_db_service to decide whether to attempt a
    vector query or fall back to the text-only half of the hybrid search —
    fastembed is a real dependency but a deployment that somehow lacks it
    should degrade, not 500."""
    try:
        import fastembed  # noqa: F401
    except ImportError:
        return False
    return True


def embed_documents(texts: list[str], batch_size: int = 256) -> list[list[float]]:
    """Embed corpus entries. Batched, and deliberately synchronous: the only
    caller is the offline ingest script, where blocking is correct and
    progress output is useful."""
    model = _get_model()
    out: list[list[float]] = []
    total = len(texts)
    for start in range(0, total, batch_size):
        chunk = texts[start : start + batch_size]
        out.extend([vector.tolist() for vector in model.embed(chunk)])
        print(f"  embedded {min(start + batch_size, total)}/{total}", flush=True)
    return out


def embed_query(text: str) -> list[float] | None:
    """Embed one search query. Returns None rather than raising if anything
    goes wrong — every caller in this codebase treats a failed embedding as
    "do the text-only search instead", never as a request failure, which
    matches nutrition_db_service's standing rule that grounding is
    best-effort and lookup() never raises.

    NOTE the symmetry requirement: the corpus side embeds each row's
    `search_text` (i.e. _normalize()d), so callers must normalize the query
    the same way before calling this. This function does not normalize for
    you, because the caller already holds the normalized form it uses for the
    full-text half of the same query and re-deriving it here would be a second
    place for that to drift.
    """
    if not text:
        return None
    try:
        model = _get_model()
        for vector in model.embed([text]):
            return vector.tolist()
    except Exception as exc:  # noqa: BLE001 - best-effort by contract, see docstring
        logger.warning("Query embedding failed for %r (%s) — falling back to text-only search", text, exc)
    return None


def warm_up() -> None:
    """Force the model to load now instead of on the first user request.
    Called from main.py's lifespan so the ~2s one-off init lands during
    startup rather than inside somebody's photo scan. Safe to call when
    fastembed is missing or the corpus is disabled — it just logs and
    returns."""
    try:
        _get_model()
    except Exception as exc:  # noqa: BLE001 - warm-up is an optimisation, never a startup blocker
        logger.warning("Embedding warm-up failed (%s) — lookups will fall back to text-only search", exc)
