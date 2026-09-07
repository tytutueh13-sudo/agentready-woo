#!/usr/bin/env python3
"""Recompute every digest in the marketplace kit's asset manifest.

The manifest existed before this script did, and its digests were maintained by
hand — which is how four concept renders came to carry the hashes of an earlier
render of the same page. The set of assets is still an editorial decision and is
not discovered here; only the digests, sizes and date are recomputed, so a
re-render can never leave a stale hash behind.

    python3 scripts/refresh-asset-manifest.py [--check]

--check exits non-zero and prints the drift instead of writing.
Also mirrors the result into the package directory, which ships a copy.
"""
import hashlib
import json
import sys
from datetime import date
from pathlib import Path

SERVICE = Path(__file__).resolve().parent.parent
MANIFEST = SERVICE / "registration-handoff" / "marketplace-kit" / "asset-manifest.json"
PACKAGE_COPY = (SERVICE.parent.parent / "output" / "agentwoo-marketplace-package-2026-09-07"
                / "ASSET-MANIFEST.json")

check = "--check" in sys.argv
manifest = json.loads(MANIFEST.read_text())
drift, missing = [], []

for group, items in manifest["groups"].items():
    for item in items:
        path = SERVICE / item["path"]
        if not path.exists():
            missing.append(item["path"])
            continue
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != item["sha256"] or len(raw) != item["bytes"]:
            drift.append(f'{item["path"]}: {item["sha256"][:12]}…/{item["bytes"]}B '
                         f'-> {digest[:12]}…/{len(raw)}B')
        item["sha256"] = digest
        item["bytes"] = len(raw)

if missing:
    print("MISSING:", *missing, sep="\n  ")
    sys.exit(2)

if check:
    if drift:
        print("STALE:", *drift, sep="\n  ")
        sys.exit(1)
    print(f"{sum(len(v) for v in manifest['groups'].values())} assets, all digests current")
    sys.exit(0)

manifest["generated"] = date.today().isoformat()
body = json.dumps(manifest, indent=1) + "\n"
MANIFEST.write_text(body)
PACKAGE_COPY.write_text(body)
print(f"{sum(len(v) for v in manifest['groups'].values())} assets rehashed; {len(drift)} changed")
for line in drift:
    print("  ", line)
