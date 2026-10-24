#!/bin/bash
# Builds web/ from this checkout for run.sh full (T-170), on a case-sensitive
# disk image: web/src has had modules whose names differ only in case, which
# a Mac's default disk resolves to the wrong file. Tracked files only (git
# archive), npm ci on the image; the image is removed when it ends.
#   uitests/web-build.sh <dist>
set -euo pipefail
[ $# = 1 ] || { echo "usage: web-build.sh <dist>" >&2; exit 64; }
mkdir -p "$1"
dist=$(cd "$1" && pwd)
repo=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/yuzuno-web.XXXXXX")
hdiutil create -quiet -size 4g -type SPARSE -fs "Case-sensitive APFS" -volname yuzuno-web "$work/web.sparseimage"
mkdir "$work/volume"
hdiutil attach -quiet -nobrowse -mountpoint "$work/volume" "$work/web.sparseimage"
trap 'hdiutil detach -quiet "$work/volume" || true; rm -rf "$work"' EXIT
git -C "$repo" archive HEAD LICENSE web | tar -x -C "$work/volume"
(cd "$work/volume/web" && npm ci --ignore-scripts --no-audit --no-fund && npx vite build --outDir "$dist" --emptyOutDir)
