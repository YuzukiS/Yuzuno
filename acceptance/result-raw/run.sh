#!/usr/bin/env bash
# YN-234 B, in one managed Job: build the dispatched base and RAW_HEAD the
# same way, each from its own commit (git archive under .tmp/, sharing this
# checkout's node_modules: package-lock.json is the same), show
# web/tools/turn-results-ui.test.mjs red on the base and green on the head,
# with the existing tests of results on the head, then profile both builds
# with profile.mjs. Results go to results/yn234/result-raw/ with their sha256.
#   RAW_HEAD=<commit> [RAW_REPS=5] bash acceptance/result-raw/run.sh
set -euo pipefail
W=$(git rev-parse --show-toplevel)
cd "$W"
BASE=${RAW_BASE:-1a62182302041c11db617d6c9046435670a700de}
HEAD_SHA=$(git rev-parse --verify "${RAW_HEAD:?RAW_HEAD=<commit>}^{commit}")
git diff --quiet "$BASE" "$HEAD_SHA" -- web/package-lock.json
git show "$BASE:web/package-lock.json" | cmp - web/package-lock.json
NODE=$(command -v node)
T=$W/.tmp/yn234-b-run
R=$W/results/yn234/result-raw
rm -rf "$T" "$R"
mkdir -p "$T/base" "$T/head" "$R"
{ echo "base $BASE"; echo "head $HEAD_SHA"; "$NODE" --version; /usr/sbin/chromium --version || true; } > "$R/sources.txt"
git archive "$BASE" web | tar -x -C "$T/base"
git archive "$HEAD_SHA" web acceptance/result-raw | tar -x -C "$T/head"
for side in base head; do ln -s "$W/web/node_modules" "$T/$side/web/node_modules"; done
cp "$T/head/web/tools/turn-results-ui.test.mjs" "$T/base/web/tools/"
(cd "$T/head/web" && "$NODE" node_modules/typescript/bin/tsc -b --noEmit) > "$R/typecheck-head.log" 2>&1
for side in base head; do
  (cd "$T/$side/web" && "$NODE" node_modules/vite/bin/vite.js build --outDir "$T/dist-$side" --emptyOutDir) > "$R/build-$side.log" 2>&1
done

set +e
(cd "$T/base/web" && YUZUNO_UI_DIST="$T/dist-base" "$NODE" tools/turn-results-ui.test.mjs) > "$R/test-base.log" 2>&1
base_status=$?
(cd "$T/head/web" && YUZUNO_UI_DIST="$T/dist-head" "$NODE" tools/turn-results-ui.test.mjs) > "$R/test-head.log" 2>&1
head_status=$?
others=0
for test in intelligent-ui-states-ui intelligent-ui-stream-ui intelligent-ui-storage intelligent-ui form-answer-ui clarification-ui task-status-ui brief-render home-report-ui; do
  (cd "$T/head/web" && YUZUNO_UI_DIST="$T/dist-head" "$NODE" --experimental-strip-types "tools/$test.test.mjs") > "$R/test-head-$test.log" 2>&1
  status=$?
  echo "$test exit $status" >> "$R/tests.txt"
  [ "$status" -eq 0 ] || others=1
done
set -e
echo "turn-results-ui on base exit $base_status, on head exit $head_status" >> "$R/tests.txt"
cat "$R/tests.txt"

RAW_DISTS="baseline=$T/dist-base,candidate=$T/dist-head" RAW_OUT="$R" RAW_REPS="${RAW_REPS:-5}" \
  "$NODE" "$T/head/acceptance/result-raw/profile.mjs" 2>&1 | tee "$R/profile.log"
(cd "$R" && sha256sum -- * > SHA256SUMS)
test "$base_status" -ne 0
test "$head_status" -eq 0
test "$others" -eq 0
