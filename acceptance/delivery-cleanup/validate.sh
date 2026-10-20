#!/usr/bin/env bash
set -uo pipefail
# Invoke through a bounded Yuzuno Job and the shared heavy-slot helper.
T80_OUT="${T80_OUT:-target/t80/check-1}"
mkdir -p "$T80_OUT"
export CARGO_TARGET_DIR="$PWD/target/t80/cargo"
export CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
failed=0
run() {
  local name="$1"; shift
  "$@" >"$T80_OUT/$name.log" 2>&1
  local code=$?
  printf '%s: %s\n' "$name" "$code"
  if [ "$code" != 0 ]; then tail -65 "$T80_OUT/$name.log"; failed=1; fi
}
run delivery cargo test --offline --locked -p yuzuno-workspace --lib delivery:: -- --test-threads=2
if [ "$failed" = 0 ]; then
  run ci cargo test --offline --locked -p yuzuno-workspace --lib ci_monitor:: -- --test-threads=2
  run collaboration cargo test --offline --locked -p yuzuno-workspace --lib collaboration_store:: -- --test-threads=2
fi
if [ "${T80_CORE_ONLY:-0}" != 1 ]; then
  if [ -L web/node_modules ]; then exit 1; fi
  if [ ! -d web/node_modules/@codemirror/state ]; then
    (cd web && npm ci --ignore-scripts --prefer-offline --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000 --cache "${HOME}/yuzuno-next/target/npm-cache") >"$T80_OUT/dependencies.log" 2>&1 || { tail -30 "$T80_OUT/dependencies.log"; failed=1; }
  fi
  run ui-delivery node web/tools/delivery-flow-ui.test.mjs
  (cd web && node node_modules/typescript/bin/tsc -b --noEmit) >"$T80_OUT/typecheck.log" 2>&1 || { cat "$T80_OUT/typecheck.log"; failed=1; }
  (cd web && node node_modules/vite/bin/vite.js build --outDir "../$T80_OUT/web-dist") >"$T80_OUT/web-build.log" 2>&1 || { tail -30 "$T80_OUT/web-build.log"; failed=1; }
fi
printf '{"success":%s,"isolated":true,"paidModelCalls":0}\n' "$([ "$failed" = 0 ] && printf true || printf false)" >"$T80_OUT/validation.json"
exit "$failed"
