#!/usr/bin/env python3
"""Bumps every `?v=` cache-busting query string in the frontend to one new,
consistent value in a single command.

This is a no-build static site , so every <script>/<link> in
index.html and every relative import inside js/*.js carries a `?v=...` query
string as a manual cache-buster. Without it, a browser can keep serving a
stale cached copy of one module while a fresher one loads another. Bumping
these by hand across a dozen files is exactly the kind of error-prone,
tedious step this script replaces — it finds every occurrence and rewrites
them all together, so it's impossible to miss one.

Usage:
    python3 bump_version.py            # auto: today's date + next letter
    python3 bump_version.py 20260901a  # explicit version
"""
import re
import sys
from datetime import date
from pathlib import Path

FRONTEND_DIR = Path(__file__).parent
# "*.html", not just "index.html": the standalone legal pages
# (privacy/terms/disclaimers/data-deletion.html) also carry ?v= cache-busters
# on their own <link>/<script> tags now, same reasoning as index.html above.
TARGET_GLOBS = ["*.html", "js/*.js"]
VERSION_PATTERN = re.compile(r"\?v=\d{8}[a-z]?")


def _target_files():
    for pattern in TARGET_GLOBS:
        yield from FRONTEND_DIR.glob(pattern)


def _find_current_versions():
    versions = set()
    for path in _target_files():
        versions.update(VERSION_PATTERN.findall(path.read_text()))
    return versions


def _next_version(existing):
    today = date.today().strftime("%Y%m%d")
    todays_suffixes = sorted(v[-1] for v in existing if v.startswith(f"?v={today}") and v[-1].isalpha())
    if not todays_suffixes:
        return f"?v={today}a"
    return f"?v={today}{chr(ord(todays_suffixes[-1]) + 1)}"


def main():
    existing = _find_current_versions()
    if not existing:
        print("No ?v= occurrences found under frontend/ — nothing to bump.")
        return 1

    new_version = sys.argv[1] if len(sys.argv) > 1 else None
    new_version = f"?v={new_version}" if new_version and not new_version.startswith("?v=") else new_version
    new_version = new_version or _next_version(existing)

    changed = []
    for path in _target_files():
        text = path.read_text()
        new_text = VERSION_PATTERN.sub(new_version, text)
        if new_text != text:
            path.write_text(new_text)
            changed.append(path.relative_to(FRONTEND_DIR))

    print(f"Previous version(s) found: {', '.join(sorted(existing))}")
    print(f"Bumped {len(changed)} file(s) to {new_version}:")
    for f in changed:
        print(f"  {f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
