#!/usr/bin/env bash
# YN-234 (R-46 long replies), in one managed Job: build the dispatched base
# and PROSE_HEAD the same way, each from its own commit (git archive under
# .tmp/, sharing this checkout's node_modules: package-lock.json is the
# same), show web/tools/stream-prose-ui.test.mjs red on the base and green on
# the head, check the head's ProseBlocks against whole-text Prose in Chromium
# (differential.mjs), then profile both builds with profile.mjs. The rest of
# the web tests run in PR CI. Results go to results/yn234/stream-prose/ with
# their sha256.
#   PROSE_HEAD=<commit> [PROSE_REPS=5] bash acceptance/stream-prose/run.sh
set -euo pipefail
W=$(git rev-parse --show-toplevel)
cd "$W"
BASE=${PROSE_BASE:-9281e954794759598cb683d42a8ee7db6a9a7132}
HEAD_SHA=$(git rev-parse --verify "${PROSE_HEAD:?PROSE_HEAD=<commit>}^{commit}")
git diff --quiet "$BASE" "$HEAD_SHA" -- web/package-lock.json
git show "$BASE:web/package-lock.json" | cmp - web/package-lock.json
NODE=$(command -v node)
T=$W/.tmp/yn234-prose-run
R=$W/results/yn234/stream-prose
rm -rf "$T" "$R"
mkdir -p "$T/base" "$T/head" "$R"
{ echo "base $BASE"; echo "head $HEAD_SHA"; "$NODE" --version; /usr/sbin/chromium --version || true; } > "$R/sources.txt"
git archive "$BASE" web | tar -x -C "$T/base"
git archive "$HEAD_SHA" web acceptance/stream-prose | tar -x -C "$T/head"
for side in base head; do ln -s "$W/web/node_modules" "$T/$side/web/node_modules"; done
cp "$T/head/web/tools/stream-prose-ui.test.mjs" "$T/base/web/tools/"
for side in base head; do
  (cd "$T/$side/web" && "$NODE" node_modules/vite/bin/vite.js build --outDir "$T/dist-$side" --emptyOutDir) > "$R/build-$side.log" 2>&1
done

set +e
for side in base head; do
  (cd "$T/$side/web" && YUZUNO_UI_DIST="$T/dist-$side" "$NODE" tools/stream-prose-ui.test.mjs) > "$R/test-$side.log" 2>&1
  echo "stream-prose-ui on $side exit $?" >> "$R/tests.txt"
done
PROSE_WEB="$T/head/web" PROSE_OUT="$R" PROSE_DOCS="${PROSE_DOCS:-4000}" \
  "$NODE" "$T/head/acceptance/stream-prose/differential.mjs" > "$R/differential.log" 2>&1
echo "differential exit $?" >> "$R/tests.txt"
set -e
cat "$R/tests.txt" "$R/differential.log"

PROSE_DISTS="baseline=$T/dist-base,candidate=$T/dist-head" PROSE_OUT="$R" PROSE_REPS="${PROSE_REPS:-5}" \
  "$NODE" "$T/head/acceptance/stream-prose/profile.mjs" 2>&1 | tee "$R/profile.log"
(cd "$R" && sha256sum -- * > SHA256SUMS)
grep -q "on base exit [1-9]" "$R/tests.txt"
grep -q "on head exit 0" "$R/tests.txt"
grep -q "differential exit 0" "$R/tests.txt"
