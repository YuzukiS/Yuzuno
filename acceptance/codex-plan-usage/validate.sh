#!/usr/bin/env bash
set -uo pipefail
T83_OUT="${T83_OUT:-target/t83/check-1}"
mkdir -p "$T83_OUT"
export CARGO_TARGET_DIR="$PWD/target/t83/cargo"
export CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
failed=0
run() {
  local name="$1"; shift
  "$@" >"$T83_OUT/$name.log" 2>&1
  local code=$?
  printf '%s: %s\n' "$name" "$code"
  if [ "$code" != 0 ]; then tail -65 "$T83_OUT/$name.log"; failed=1; fi
}
run core cargo test --offline --locked -p yuzuno-workspace --lib codex_usage:: -- --test-threads=2
if [ ! -d web/node_modules/@codemirror/state ]; then
  (cd web && npm ci --ignore-scripts --prefer-offline --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000 --cache "${HOME}/yuzuno-next/target/npm-cache") >"$T83_OUT/dependencies.log" 2>&1 || { tail -30 "$T83_OUT/dependencies.log"; failed=1; }
fi
run ui node web/tools/codex-plan-usage.test.mjs
(cd web && node node_modules/typescript/bin/tsc -b --noEmit) >"$T83_OUT/typecheck.log" 2>&1 || { cat "$T83_OUT/typecheck.log"; failed=1; }
(cd web && node node_modules/vite/bin/vite.js build --outDir "../$T83_OUT/web-dist") >"$T83_OUT/web-build.log" 2>&1 || { tail -30 "$T83_OUT/web-build.log"; failed=1; }
if [ "${T83_NATIVE:-0}" = 1 ]; then run native python3 acceptance/codex-plan-usage/native_probe.py "$T83_OUT/native.json"; fi
if [ -f web/tools/codex-plan-usage-browser.mjs ]; then
  export T83_BROWSER_OUT="$PWD/$T83_OUT/browser"
  run browser node web/tools/codex-plan-usage-browser.mjs
fi
printf '{"success":%s,"isolated":true,"modelCalls":0}\n' "$([ "$failed" = 0 ] && printf true || printf false)" >"$T83_OUT/validation.json"
exit "$failed"
