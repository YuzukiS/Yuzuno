#!/usr/bin/env bash
set -euo pipefail
mkdir -p target/t19
cargo test -p yuzuno-workspace --lib workspace::collaboration_admission_tests -- --test-threads=1 2>&1 | tee target/t19/http-tests.log
cargo test -p yuzuno-workspace --lib workspace::concurrency_tests -- --test-threads=1 2>&1 | tee target/t19/concurrency-tests.log
cargo test -p yuzuno-workspace --lib rpc::transport_tests -- --test-threads=1 2>&1 | tee target/t19/transport-tests.log
cargo test -p yuzuno-workspace --test empty_session_recovery -- --test-threads=1 2>&1 | tee target/t19/empty-session-tests.log
node --test web/tools/recovery-ui.test.mjs web/tools/remote-ui.test.mjs 2>&1 | tee target/t19/ui-tests.log
(cd web && npm run typecheck) 2>&1 | tee target/t19/typecheck.log
