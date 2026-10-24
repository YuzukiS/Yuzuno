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
# <out> gets screenshots/, frames.txt, checks.xcresult and DerivedData/; full
# also phone-measure.jsonl and page-server.log. Needs Xcode and xcodegen;
# installs nothing.
set -euo pipefail
[ $# = 3 ] && { [ "$1" = smoke ] || [ "$1" = full ]; } || { echo "usage: run.sh smoke|full <app> <out>" >&2; exit 64; }
mode=$1
app=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
mkdir -p "$3/screenshots"
out=$(cd "$3" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
ios=$(dirname "$here")

device=$(xcrun simctl create "yuzuno-check-$mode-$$" "iPhone 17")
server=
finish() {
  [ -z "$server" ] || kill "$server" 2> /dev/null || true
  xcrun simctl shutdown "$device" 2> /dev/null || true
  xcrun simctl delete "$device" 2> /dev/null || true
}
trap finish EXIT
xcrun simctl list devices | awk -v device="$device" '/^-- /{runtime=$0} index($0, device){print runtime; print}'
xcrun simctl boot "$device"
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
  -destination "platform=iOS Simulator,id=$device" -derivedDataPath "$out/DerivedData" \
  -resultBundlePath "$out/checks.xcresult" ${only[@]+"${only[@]}"}
[ ! -f "$out/frames.txt" ] || cat "$out/frames.txt"
