#!/usr/bin/env bash
set -euo pipefail
export CARGO_TARGET_DIR="$PWD/target/t61/cargo"
export CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export T61_REPORT_DIR="${T61_REPORT_DIR:-target/t61/run4}"
mkdir -p "$T61_REPORT_DIR"
cargo test --offline --locked -p yuzuno-workspace --lib collaboration_store:: -- --test-threads=2 >"$T61_REPORT_DIR/core-collaboration.log" 2>&1 || { tail -70 "$T61_REPORT_DIR/core-collaboration.log"; exit 1; }
node web/tools/delivery-flow-browser.mjs >"$T61_REPORT_DIR/browser.log" 2>&1 || { cat "$T61_REPORT_DIR/browser.log"; exit 1; }
printf '{"success":true,"scope":"collaboration regression and isolated browser layout"}\n' >"$T61_REPORT_DIR/validation.json"
