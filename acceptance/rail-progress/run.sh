#!/usr/bin/env bash
# YN-234 A, in one managed Job: build the dispatched base and this head the
# same way, show web/tools/rail-rows-ui.test.mjs red on the base and green
# here (with the existing tests of the rail's rows), then profile both builds
# with profile.mjs. The base is a copy of its web/ under .tmp/, sharing this
# checkout's node_modules (package-lock.json is the same). Results go to
# results/yn234/rail-progress/ with their sha256.
#   [RAIL_REPS=5] [RAIL_SECONDS=10] acceptance/rail-progress/run.sh
set -euo pipefail
W=$(git rev-parse --show-toplevel)
cd "$W"
BASE=${RAIL_BASE:-1a62182302041c11db617d6c9046435670a700de}
git diff --quiet HEAD -- web acceptance/rail-progress
git diff --quiet "$BASE" HEAD -- web/package-lock.json
NODE=$(command -v node)
T=$W/.tmp/yn234-a
R=$W/results/yn234/rail-progress
rm -rf "$T" "$R"
mkdir -p "$T/base" "$R"
{ echo "base $BASE"; echo "head $(git rev-parse HEAD)"; "$NODE" --version; /usr/sbin/chromium --version || true; } > "$R/sources.txt"
git archive "$BASE" web | tar -x -C "$T/base"
ln -s "$W/web/node_modules" "$T/base/web/node_modules"
cp web/tools/rail-rows-ui.test.mjs "$T/base/web/tools/"
(cd "$T/base/web" && "$NODE" node_modules/vite/bin/vite.js build --outDir "$T/dist-base" --emptyOutDir) > "$R/build-base.log" 2>&1
(cd "$W/web" && "$NODE" node_modules/vite/bin/vite.js build --outDir "$T/dist-head" --emptyOutDir) > "$R/build-head.log" 2>&1

set +e
(cd "$T/base/web" && YUZUNO_UI_DIST="$T/dist-base" "$NODE" tools/rail-rows-ui.test.mjs) > "$R/test-base.log" 2>&1
base_status=$?
(cd "$W/web" && YUZUNO_UI_DIST="$T/dist-head" "$NODE" tools/rail-rows-ui.test.mjs) > "$R/test-head.log" 2>&1
head_status=$?
others=0
for test in agent-actions-ui live-ci-ui live-jobs-ui ring-wait-ui live-events-ui executor-rail-ui executor-seen-ui; do
  (cd "$W/web" && YUZUNO_UI_DIST="$T/dist-head" "$NODE" "tools/$test.test.mjs") > "$R/test-head-$test.log" 2>&1
  status=$?
  echo "$test exit $status" >> "$R/tests.txt"
  [ "$status" -eq 0 ] || others=1
done
set -e
echo "rail-rows-ui on base exit $base_status, on head exit $head_status" >> "$R/tests.txt"
cat "$R/tests.txt"

RAIL_DISTS="baseline=$T/dist-base,candidate=$T/dist-head" RAIL_OUT="$R" \
  RAIL_REPS="${RAIL_REPS:-5}" RAIL_SECONDS="${RAIL_SECONDS:-10}" \
  "$NODE" acceptance/rail-progress/profile.mjs 2>&1 | tee "$R/profile.log"
(cd "$R" && sha256sum -- * > SHA256SUMS)
test "$base_status" -ne 0
test "$head_status" -eq 0
test "$others" -eq 0
