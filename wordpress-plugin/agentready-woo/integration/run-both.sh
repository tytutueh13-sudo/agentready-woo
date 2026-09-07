#!/usr/bin/env bash
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$HARNESS_DIR"
if [ -d /Applications/Docker.app/Contents/Resources/bin ]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi

cleanup() { docker compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker compose build wordpress
for mode in on off; do
  cleanup
  AGENTREADY_HPOS="$mode" docker compose run --rm wordpress
done

cleanup
trap - EXIT
