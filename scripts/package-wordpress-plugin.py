#!/usr/bin/env python3
"""Build the public UtilityHouse Release Gate plugin ZIP deterministically."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent.parent
SLUG = "utilityhouse-release-gate-for-woocommerce"
PLUGIN = ROOT / "wordpress-plugin" / SLUG
OUTPUT = ROOT / "marketing" / "landing" / "downloads" / f"{SLUG}.zip"
LEGACY_OUTPUT = ROOT / "marketing" / "landing" / "downloads" / "agentready-woo.zip"
FILES = (
    "utilityhouse-release-gate-for-woocommerce.php",
    "includes/class-utilityhouse-release-gate.php",
    "readme.txt",
)
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in FILES:
            source = PLUGIN / relative
            info = ZipInfo(f"{SLUG}/{relative}", FIXED_TIME)
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, source.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
    # Keep the former direct-download URL byte-identical so an old bookmark
    # installs the corrected package rather than a stale plugin identity.
    LEGACY_OUTPUT.write_bytes(OUTPUT.read_bytes())
    print(f"built {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
