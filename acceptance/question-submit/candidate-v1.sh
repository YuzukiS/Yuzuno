#!/bin/bash
set -euo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048
test "$LP_NUM_THREADS" = 2
test ! -e target/t67/candidate-v1
# The product frontend is unchanged; use the exact baseline assets.
git diff --quiet cda2392ac26458535b4a048d958be9cdf4c9c70d HEAD -- web/src
sha256sum --status -c target/t67/baseline-v1/asset-sha256.txt
mkdir -p target/t67/candidate-v1
git rev-parse HEAD > target/t67/candidate-v1/head.txt
export T67_OUT="$PWD/target/t67/candidate-v1"
export YUZUNO_UI_DIST="$PWD/target/t67/web-baseline-v1"
export CARGO_TARGET_DIR="${HOME}/yuzuno-next/target"
export CARGO_BUILD_JOBS=1
export YUZUNO_RESULT_VALIDATOR="$PWD/runtimes/result-validator/validator.mjs"
cargo test --release --offline --locked -p yuzuno-workspace --test question_submit_profile -- --ignored --nocapture --test-threads=1 2>&1 | tee target/t67/candidate-v1/profile.log
python3 acceptance/question-submit/analyze.py target/t67/baseline-v2 target/t67/candidate-v1 > target/t67/candidate-v1/comparison.json
tar -czf target/t67/candidate-v1/raw-evidence.tar.gz -C target/t67/candidate-v1 short long delayed
{
    cargo test --release --offline --locked -p yuzuno-workspace --lib store::tests -- --test-threads=2
    cargo test --release --offline --locked -p yuzuno-workspace --lib claude_forms_use_real_start_and_queued_receipts_without_confirming_unknown_starts -- --test-threads=1
    cargo test --release --offline --locked -p yuzuno-workspace --lib a_permission_reply_whose_request_is_dropped_still_reaches_claude -- --test-threads=1
    cargo test --release --offline --locked -p yuzuno-workspace --test conversation_interactions --test remote_workspace --test codex_session_import --test live_events -- --test-threads=2
} 2>&1 | tee target/t67/candidate-v1/tests.log
