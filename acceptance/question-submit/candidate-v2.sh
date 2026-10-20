#!/bin/bash
set -euo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048
test "$LP_NUM_THREADS" = 2
test ! -e target/t67/candidate-v2
mkdir -p target/t67/candidate-v2
git rev-parse HEAD > target/t67/candidate-v2/head.txt
export CARGO_TARGET_DIR="${HOME}/yuzuno-next/target"
export CARGO_BUILD_JOBS=1
export YUZUNO_RESULT_VALIDATOR="$PWD/runtimes/result-validator/validator.mjs"
# v1's release browser measurements passed. Only a unit-test fixture changed.
# Run correctness checks in the normal test profile; no browser rerun.
{
    cargo test --offline --locked -p yuzuno-workspace --lib store::tests -- --test-threads=2
    cargo test --offline --locked -p yuzuno-workspace --lib claude_forms_use_real_start_and_queued_receipts_without_confirming_unknown_starts -- --test-threads=1
    cargo test --offline --locked -p yuzuno-workspace --lib a_permission_reply_whose_request_is_dropped_still_reaches_claude -- --test-threads=1
    cargo test --offline --locked -p yuzuno-workspace --test conversation_interactions --test remote_workspace --test codex_session_import --test live_events -- --test-threads=2
} 2>&1 | tee target/t67/candidate-v2/tests.log
