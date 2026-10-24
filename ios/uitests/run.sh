#!/bin/bash
# The iOS app's UI checks (T-170), shared by ios.yml and a Mac with Xcode.
# They run in a Simulator of their own, created for the run and deleted when
# it ends, so a Mac's other Simulators are left as they are.
#   uitests/run.sh smoke <Yuzuno.app> <out>   the app starts and refuses a
#                                             plain HTTP address itself (CI)
#   uitests/run.sh full  <Yuzuno.app> <out>   also turned, the keyboard open,
#                                             an address nothing answers, and
#                                             Mobile Safari beside the app
# full needs a web build in YUZUNO_UI_DIST (web-build.sh) and node; Safari's
# pages come from web/tools/phone-fixture-server.mjs on 127.0.0.1 only.
# <out> gets screenshots/, frames.txt and checks.xcresult (give each run its
# own <out>); full also phone-measure.jsonl and page-server.log. Needs Xcode
# and xcodegen; installs nothing.
# Repeated runs on a Mac may share, for the length of one round of checks:
#   YUZUNO_DEVICE=<udid>       a Simulator kept for the round: not created,
#                              shut down or deleted here
#   YUZUNO_DERIVED_DATA=<dir>  the tests' build, built incrementally
# Otherwise each run creates a Simulator of type YUZUNO_DEVICE_TYPE (default
# "iPhone 17") and deletes it when it ends, and builds the tests in
# <out>/DerivedData. Either way the Simulator runs the installed iOS runtime
# that matches the active Xcode's Simulator SDK (DEVELOPER_DIR picks another
# Xcode); with none, or a kept Simulator on another runtime, it stops.
set -euo pipefail
[ $# = 3 ] && { [ "$1" = smoke ] || [ "$1" = full ]; } || { echo "usage: run.sh smoke|full <app> <out>" >&2; exit 64; }
mode=$1
app=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
mkdir -p "$3/screenshots"
out=$(cd "$3" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
ios=$(dirname "$here")

derived=${YUZUNO_DERIVED_DATA:-$out/DerivedData}
# The runtime of the SDK the tests are built with: simctl's own default is
# the newest runtime installed, which an older Xcode cannot test on.
sdk=$(xcrun --sdk iphonesimulator --show-sdk-version)
runtime=$(xcrun simctl list runtimes --json | python3 -c '
import json, sys
sdk = sys.argv[1]
for runtime in json.load(sys.stdin)["runtimes"]:
    version = runtime.get("version", "")
    if runtime.get("platform") == "iOS" and runtime.get("isAvailable") and (version == sdk or version.startswith(sdk + ".")):
        print(runtime["identifier"])
        break
' "$sdk")
[ -n "$runtime" ] || { echo "run.sh: no installed iOS Simulator runtime for the iphonesimulator SDK $sdk" >&2; exit 1; }
echo "Simulator SDK $sdk, runtime $runtime"
if [ -n "${YUZUNO_DEVICE:-}" ]; then
  device=$YUZUNO_DEVICE
  kept=1
  on=$(xcrun simctl list devices --json | python3 -c '
import json, sys
for runtime, devices in json.load(sys.stdin)["devices"].items():
    if any(each.get("udid") == sys.argv[1] for each in devices):
        print(runtime)
' "$device")
  [ "$on" = "$runtime" ] || { echo "run.sh: YUZUNO_DEVICE $device runs ${on:-no runtime found}, not $runtime" >&2; exit 1; }
else
  device=$(xcrun simctl create "yuzuno-check-$mode-$$" "${YUZUNO_DEVICE_TYPE:-iPhone 17}" "$runtime")
  kept=
fi
server=
finish() {
  [ -z "$server" ] || kill "$server" 2> /dev/null || true
  if [ -z "$kept" ]; then
    xcrun simctl shutdown "$device" 2> /dev/null || true
    xcrun simctl delete "$device" 2> /dev/null || true
  fi
}
trap finish EXIT
xcrun simctl list devices | awk -v device="$device" '/^-- /{runtime=$0} index($0, device){print runtime; print}'
# A kept Simulator may already be running.
xcrun simctl boot "$device" 2> /dev/null || true
xcrun simctl bootstatus "$device" -b
xcrun simctl install "$device" "$app"

# xcodebuild hands TEST_RUNNER_<name> to the tests as <name>.
export TEST_RUNNER_YUZUNO_SCREENSHOTS="$out/screenshots" TEST_RUNNER_YUZUNO_FRAMES="$out/frames.txt"
only=(-only-testing:Checks/ConnectionPageChecks/testLaunchAndTheAppsOwnRefusal)
if [ "$mode" = full ]; then
  : "${YUZUNO_UI_DIST:?the web build for the Safari pages, from uitests/web-build.sh}"
  export TEST_RUNNER_YUZUNO_EXPLORE=1 TEST_RUNNER_YUZUNO_SAFARI=http://127.0.0.1:4510/
  YUZUNO_MEASURE_OUT="$out/phone-measure.jsonl" YUZUNO_PORT=4510 YUZUNO_EXTRA="/connection=$ios/connection" \
    node "$ios/../web/tools/phone-fixture-server.mjs" > "$out/page-server.log" 2>&1 &
  server=$!
  for attempt in $(seq 1 30); do curl -sf -o /dev/null "${TEST_RUNNER_YUZUNO_SAFARI}connection/" && break; sleep 0.5; done
  only=()
fi
(cd "$here" && xcodegen generate --quiet)
xcodebuild test -quiet -project "$here/YuzunoChecks.xcodeproj" -scheme Checks \
  -destination "platform=iOS Simulator,id=$device" -derivedDataPath "$derived" \
  -resultBundlePath "$out/checks.xcresult" ${only[@]+"${only[@]}"}
[ ! -f "$out/frames.txt" ] || cat "$out/frames.txt"
