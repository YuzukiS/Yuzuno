#!/usr/bin/env bash
set -uo pipefail
# Always invoked as a managed Job under the shared heavy-slot helper.
T61_REPORT_DIR="${T61_REPORT_DIR:-target/t61/latest}"
mkdir -p "$T61_REPORT_DIR"
export CARGO_TARGET_DIR="$PWD/target/t61/cargo"
export CARGO_BUILD_JOBS=2
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_PROFILE_TEST_DEBUG=0
failed=0
run() { local name="$1"; shift; "$@" >"$T61_REPORT_DIR/$name.log" 2>&1; local status=$?; printf '%s: %s\n' "$name" "$status"; if [ "$status" != 0 ]; then tail -70 "$T61_REPORT_DIR/$name.log"; failed=1; fi; }
run core-delivery cargo test --offline --locked -p yuzuno-workspace --lib delivery:: -- --test-threads=2
if [ "$failed" = 0 ]; then
  run core-review cargo test --offline --locked -p yuzuno-workspace --lib pr_review:: -- --test-threads=2
  run core-ci cargo test --offline --locked -p yuzuno-workspace --lib ci_monitor:: -- --test-threads=2
  run core-collaboration cargo test --offline --locked -p yuzuno-workspace --lib collaboration_store:: -- --test-threads=2
fi
if [ "${T61_CORE_ONLY:-0}" != 1 ]; then
  # Keep dependency installation in this worktree; never follow a daily symlink.
  if [ -L web/node_modules ]; then
    printf 'Refusing to install into a shared node_modules symlink\n' >&2
    exit 1
  fi
  if [ ! -d web/node_modules/@codemirror/state ]; then
    (cd web && npm ci --ignore-scripts --prefer-offline --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000 --cache "${HOME}/yuzuno-next/target/npm-cache") >"$T61_REPORT_DIR/dependencies.log" 2>&1 || { tail -40 "$T61_REPORT_DIR/dependencies.log"; failed=1; }
  fi
  run ui-delivery node web/tools/delivery-flow-ui.test.mjs
  (cd web && node node_modules/typescript/bin/tsc -b --noEmit) >"$T61_REPORT_DIR/typecheck.log" 2>&1 || { cat "$T61_REPORT_DIR/typecheck.log"; failed=1; }
  (cd web && node node_modules/vite/bin/vite.js build --outDir "../$T61_REPORT_DIR/web-dist") >"$T61_REPORT_DIR/web-build.log" 2>&1 || { tail -40 "$T61_REPORT_DIR/web-build.log"; failed=1; }
fi
printf '{"success":%s,"isolated":true,"paidModelCalls":0,"coreOnly":%s}\n' "$([ "$failed" = 0 ] && printf true || printf false)" "$([ "${T61_CORE_ONLY:-0}" = 1 ] && printf true || printf false)" >"$T61_REPORT_DIR/validation.json"
exit "$failed"
