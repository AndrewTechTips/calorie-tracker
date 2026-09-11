#!/usr/bin/env python3
"""Paired A/B: does lowering the photo upload cap cost Stage 1 any accuracy?

WHY THIS IS A SCRIPT AND NOT A TEST
-----------------------------------
frontend/js/scan.js's MAX_DIMENSION is a pure billing lever: Gemini charges
258 input tokens per 768x768 tile, so what a photo costs is
ceil(w/768) * ceil(h/768) — 24 tiles for a raw 4032x3024 phone photo, 4 at
1280, 2 at 1024. Dropping a step is free money IF the model can still read the
plate. That "if" is the whole question, and nothing already in this repo can
answer it:

  * tests/test_retrieval_eval.py is OFFLINE and starts one stage DOWNSTREAM of
    the photo. Its fixture is 50 frozen TEXT queries with the database
    candidates each returned; it never makes a vision call. Run it at 1280 and
    at 1024 and it prints byte-identical numbers (grounding 42/46, accuracy
    33/46) — verified. It is structurally blind to this constant, and a test
    that cannot observe a change will report "no regression" after one.
  * tests/test_golden_macros.py is live but goes through
    estimate_from_description — text in, no image.

So this is the only way to get a number, and it costs real Gemini quota on a
paid key. That is why you invoke it by hand, on photos you choose, rather than
it running in CI.

WHAT IT MEASURES
----------------
For each photo, Stage 1 (analyze_food_image's extraction call, the same
VISION_EXTRACTION_PROMPT production uses) is run once per resolution. It then
reports, per resolution:

  INGREDIENTS FOUND  how many distinct components the model picked out.
                     Resolution loss shows up here first: the garnish, the
                     oil sheen, the small side that stops being visible.
  AGREEMENT          fraction of the baseline resolution's ingredients that
                     the lower one also found (fuzzy name match). This is the
                     headline: 1.00 means the smaller image saw everything the
                     bigger one did.
  WEIGHT DELTA       total estimated grams vs the baseline, as a percentage.
                     Portion mass is already the dominant error source in this
                     whole product (see frontend/js/portionPresets.js), so a
                     few percent of drift here is noise, not signal — read it
                     alongside AGREEMENT, never on its own.
  COST               modelled per-scan image cost at that tile count.

USAGE
-----
    cd backend
    python3 scripts/eval_vision_resolution.py ~/photos/plates --caps 1280,1024

    # a dry run that spends nothing, to check the photo set and the bill first
    python3 scripts/eval_vision_resolution.py ~/photos/plates --dry-run

Use 8-12 photos of REAL meals you have logged, ideally the awkward ones
(mixed plates, small sides, sauces) — an omelette on a clean plate will
survive any resolution and tells you nothing. Ground truth is the baseline
resolution's own answer, so run the baseline first and sanity-check that it
is actually right before trusting the comparison.

COST: one vision call per photo per resolution. At ~$0.005 each, 10 photos x
2 resolutions is about $0.10. --dry-run prints the estimate and exits.
"""
import argparse
import asyncio
import io
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Modelled prices, gemini-3.8-flash introductory (see CLAUDE.md's routing
# section — re-check these before quoting the output as a real bill).
_INPUT_PER_TOKEN = 0.75 / 1_000_000
_TOKENS_PER_TILE = 258
_SUPPORTED = {".jpg", ".jpeg", ".png", ".webp"}


def tiles_for(width: int, height: int) -> int:
    """Gemini's image tokenisation: 258 tokens per 768x768 tile, with an
    image small in both dimensions costing one tile flat."""
    if width <= 384 and height <= 384:
        return 1
    return math.ceil(width / 768) * math.ceil(height / 768)


def resize(path: Path, cap: int):
    """Mirrors frontend/js/scan.js's compressImage: longest edge to `cap`,
    JPEG at quality 85, and an image already inside the cap is left alone."""
    from PIL import Image

    with Image.open(path) as img:
        img = img.convert("RGB")
        scale = min(1.0, cap / max(img.width, img.height))
        if scale < 1.0:
            img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return buf.getvalue(), img.width, img.height


def _norm(name: str) -> str:
    import re
    import unicodedata

    text = unicodedata.normalize("NFD", str(name or "").lower())
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", text).split())


def agreement(baseline: list[str], other: list[str]) -> float:
    """Fraction of baseline ingredients the other resolution also found.
    Token-overlap rather than exact match, because the model rewords freely
    ("branza" / "branza telemea") without having missed anything."""
    if not baseline:
        return 1.0
    matched = 0
    pool = [set(_norm(n).split()) for n in other]
    for name in baseline:
        want = set(_norm(name).split())
        if any(want & have and len(want & have) >= min(len(want), len(have)) / 2 for have in pool):
            matched += 1
    return matched / len(baseline)


async def extract(image_bytes: bytes):
    """Stage 1 only — the extraction call, not the pricing fan-out. Pricing is
    database work that resolution cannot influence, and skipping it keeps this
    to exactly one billed call per photo per resolution."""
    import services.gemini_service as gs

    data = await gs.analyze_food_image(image_bytes, "image/jpeg", "", None, "en", None)
    names = [str(i.get("food_name") or "") for i in data.get("ingredients") or []]
    weight = sum(float(i.get("weight_g") or 0) for i in data.get("ingredients") or [])
    return names, weight


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("photos", type=Path, help="directory of real meal photos")
    parser.add_argument("--caps", default="1280,1024", help="comma-separated longest-edge caps; the FIRST is the baseline")
    parser.add_argument("--dry-run", action="store_true", help="print the photo set and the estimated bill, then exit")
    args = parser.parse_args()

    caps = [int(c) for c in args.caps.split(",") if c.strip()]
    files = sorted(p for p in args.photos.iterdir() if p.suffix.lower() in _SUPPORTED)
    if not files:
        print(f"No images in {args.photos}", file=sys.stderr)
        return 1

    calls = len(files) * len(caps)
    print(f"\n{len(files)} photo(s) x {len(caps)} resolution(s) = {calls} vision calls (~${calls * 0.005:.2f})\n")
    if args.dry_run:
        for f in files:
            data, w, h = resize(f, max(caps))
            print(f"  {f.name:<34} {w}x{h} at cap {max(caps)}  {len(data)/1024:.0f}KB  {tiles_for(w,h)} tiles")
        print("\nDry run — nothing was sent. Drop --dry-run to spend the quota above.")
        return 0

    if not os.environ.get("GEMINI_API_KEY"):
        print("GEMINI_API_KEY is not set — refusing to run.", file=sys.stderr)
        return 1

    results: dict[int, list] = {cap: [] for cap in caps}
    for photo in files:
        print(f"{photo.name}")
        baseline_names = None
        baseline_weight = None
        for cap in caps:
            image, width, height = resize(photo, cap)
            try:
                names, weight = await extract(image)
            except Exception as exc:  # noqa: BLE001 - one bad photo must not end the run
                print(f"   {cap:>5}px  FAILED: {exc}")
                continue
            if baseline_names is None:
                baseline_names, baseline_weight = names, weight
            agree = agreement(baseline_names, names)
            drift = ((weight - baseline_weight) / baseline_weight * 100) if baseline_weight else 0.0
            results[cap].append((agree, drift, len(names)))
            print(
                f"   {cap:>5}px  {tiles_for(width,height)} tiles  "
                f"{len(names)} ingredient(s)  agreement {agree:.2f}  weight {drift:+.1f}%  "
                f"[{', '.join(names)}]"
            )
        print()

    print("=" * 78)
    print(f"{'cap':>7}{'ingredients/photo':>20}{'agreement':>12}{'weight drift':>15}{'$/scan image':>15}")
    for cap in caps:
        rows = results[cap]
        if not rows:
            continue
        mean_agree = sum(r[0] for r in rows) / len(rows)
        mean_drift = sum(abs(r[1]) for r in rows) / len(rows)
        mean_count = sum(r[2] for r in rows) / len(rows)
        cost = tiles_for(cap, round(cap * 0.75)) * _TOKENS_PER_TILE * _INPUT_PER_TOKEN
        print(f"{cap:>7}{mean_count:>20.2f}{mean_agree:>12.2f}{mean_drift:>14.1f}%{cost:>15.5f}")
    print("=" * 78)
    print(
        "\nRead agreement first. Below ~0.95 the smaller image is losing components,\n"
        "and no image-token saving is worth an ingredient the user never sees.\n"
        "Weight drift alone is weak evidence — portion mass is not recoverable from a\n"
        "photograph at ANY resolution (see frontend/js/portionPresets.js).\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
