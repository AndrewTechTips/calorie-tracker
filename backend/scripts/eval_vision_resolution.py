#!/usr/bin/env python3
"""Paired A/B: does lowering the photo upload cap cost Stage 1 any accuracy?

WHY THIS IS A SCRIPT AND NOT A TEST
-----------------------------------
frontend/js/scan.js's MAX_DIMENSION was introduced as a billing lever. It is
not one on gemini-3.8-flash — see _MEASURED_IMAGE_TOKENS below: an image costs
a FLAT ~1064 input tokens at every size measured, so lowering the cap saves no
Gemini spend at all. What the cap still buys is upload bytes on a phone, and
what it still RISKS is whatever detail the model needs to read the plate. That
risk is the whole remaining question, and nothing already in this repo can
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
  IMG TOKENS         measured per-scan image cost. Flat on this model —
                     printed anyway so a future model that reintroduces
                     tiling shows up immediately instead of being assumed
                     away a second time.

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

COST: one vision call per photo per resolution. At ~$0.008 each (measured over
54 real scans, 2026-09-11), 10 photos x 2 resolutions is about $0.16.
--dry-run prints the estimate and exits.

RUN REPEATS PER CONDITION. One run per resolution is not an experiment on this
workload: the same photo at the same resolution returned meal totals spanning
430-566 kcal across ten runs. A single pair WILL show a difference that is not
there — that is exactly how a resolution effect was reported, and then
disproved, on 2026-09-11. Give each condition 8-10 runs and compare the spread
WITHIN a condition against the gap BETWEEN them.
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


# MEASURED 2026-09-11, and it invalidates the tile model below for the model
# this app actually calls. client.models.count_tokens (free, no generation) on
# three real meal photos at seven encodings each returns a FLAT ~1064-1100
# input tokens for the image, from 288x384 all the way to 3000x4000 — the small
# variation tracks aspect ratio, not pixel count. Real scans agree: the same
# photo sent at 960x1280 and 3000x4000 reports the same prompt_token_count in
# usage_metadata. On gemini-3.8-flash, resolution is not a billing lever.
_MEASURED_IMAGE_TOKENS = 1064


def tiles_for(width: int, height: int) -> int:
    """The 258-tokens-per-768x768-tile model, KEPT FOR COMPARISON ONLY.

    This is what the cost of an image was assumed to be across this repo, and
    it is printed next to the measured figure so the gap stays visible rather
    than being quietly forgotten. Do not price a run with it — use
    measured_image_tokens() below. See _MEASURED_IMAGE_TOKENS above."""
    if width <= 384 and height <= 384:
        return 1
    return math.ceil(width / 768) * math.ceil(height / 768)


def measured_image_tokens(width: int, height: int) -> int:
    """What an image of any size actually costs on gemini-3.8-flash.

    Takes the dimensions it ignores on purpose: the signature documents that
    the answer does not depend on them, which is the whole finding, and it
    keeps every call site honest if a future model reintroduces tiling."""
    return _MEASURED_IMAGE_TOKENS


def resize(path: Path, cap: int):
    """APPROXIMATES frontend/js/scan.js's compressImage: longest edge to `cap`,
    JPEG at quality 85, and an image already inside the cap is left alone.

    "Approximates", not "mirrors" — the word was overstated and the difference
    was measured on 2026-09-11 rather than assumed either way. PIL's LANCZOS
    resample and libjpeg encode are not Chromium's canvas drawImage + toBlob:
    against the byte-exact browser output (the real exported function, driven
    headlessly), this lands at 35.0-38.4 dB PSNR, mean absolute difference
    ~2/255, with 2.5-6.9% of pixels differing by more than 8 levels. Close
    enough that an ingredient-agreement metric will not notice; NOT close
    enough to attribute a small observed difference to resolution rather than
    to the resampler. If you are chasing something subtle, get the real bytes:
    `(await import("/js/scan.js")).compressImage(file)` in a browser on a
    running dev server."""
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
    print(f"\n{len(files)} photo(s) x {len(caps)} resolution(s) = {calls} vision calls (~${calls * 0.008:.2f})\n")
    if args.dry_run:
        for f in files:
            data, w, h = resize(f, max(caps))
            print(
                f"  {f.name:<34} {w}x{h} at cap {max(caps)}  {len(data)/1024:.0f}KB  "
                f"{measured_image_tokens(w,h)} img tokens"
            )
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
                f"   {cap:>5}px  {measured_image_tokens(width,height)} img tokens "
                f"(tile model said {tiles_for(width,height)*_TOKENS_PER_TILE})  "
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
        cost = measured_image_tokens(cap, round(cap * 0.75)) * _INPUT_PER_TOKEN
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
