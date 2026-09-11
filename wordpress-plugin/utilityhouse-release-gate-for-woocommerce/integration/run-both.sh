#!/usr/bin/env bash
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$HARNESS_DIR"
if [ -d /Applications/Docker.app/Contents/Resources/bin ]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi

cleanup() { docker compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

AGENTREADY_WP_CLI_IMAGE=wordpress:cli-php8.3 docker compose build wordpress
for mode in on off; do
  cleanup
  AGENTREADY_WP_CLI_IMAGE=wordpress:cli-php8.3 AGENTREADY_WP_VERSION=latest \
    AGENTREADY_WOO_VERSION=latest AGENTREADY_HPOS="$mode" \
    AGENTREADY_PLUGIN_CHECK="$([ "$mode" = on ] && echo 1 || echo 0)" \
    docker compose run --rm wordpress
done

# The readme's lower bounds are claims too. Exercise them as one real stack,
# separately from the current-stable HPOS matrix.
cleanup
AGENTREADY_WP_CLI_IMAGE=wordpress:cli-php7.4 docker compose build wordpress
AGENTREADY_WP_CLI_IMAGE=wordpress:cli-php7.4 AGENTREADY_WP_VERSION=6.0.9 \
  AGENTREADY_WOO_VERSION=7.0.1 AGENTREADY_HPOS=off AGENTREADY_PLUGIN_CHECK=0 \
  docker compose run --rm wordpress

cleanup
trap - EXIT
