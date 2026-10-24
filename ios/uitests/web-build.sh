#!/bin/bash
# Builds web/ for run.sh full and safari (T-170): this checkout's committed
# files (git archive of HEAD), in a temporary directory, so the checkout gets
# no node_modules; npm ci there. npm's cache and Node's compile cache are kept
# in that directory too, and it is removed when it ends.
#   uitests/web-build.sh <dist>
set -euo pipefail
[ $# = 1 ] || { echo "usage: web-build.sh <dist>" >&2; exit 64; }
mkdir -p "$1"
dist=$(cd "$1" && pwd)
repo=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/yuzuno-web.XXXXXX")
trap 'rm -rf "$work"' EXIT
export npm_config_cache="$work/npm-cache" NODE_COMPILE_CACHE="$work/node-compile-cache"
echo "web/ from $(git -C "$repo" rev-parse HEAD)"
git -C "$repo" archive HEAD LICENSE web | tar -x -C "$work"
(cd "$work/web" && npm ci --ignore-scripts --no-audit --no-fund && npx vite build --outDir "$dist" --emptyOutDir)
