#!/usr/bin/env python3
"""Build the public AgentReady Woo plugin zip deterministically."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "wordpress-plugin" / "agentready-woo"
OUTPUT = ROOT / "marketing" / "landing" / "downloads" / "agentready-woo.zip"
FILES = (
    "agentready-woo.php",
    "includes/class-agentready-woo.php",
    "readme.txt",
)
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in FILES:
            source = PLUGIN / relative
            info = ZipInfo(f"agentready-woo/{relative}", FIXED_TIME)
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, source.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
    print(f"built {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
