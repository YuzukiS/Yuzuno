#!/bin/sh
# Builds the macOS desktop app (Yuzuno.app) and a disk image on a Mac, and
# writes what was built and with what to build.json.
#
#   scripts/desktop-macos.sh --tools DIR --out DIR [--version X.Y.Z] [--toolchain NAME] [--test]
#
# Run from a checkout's root (or an export of desktop/ and this script). Needs
# Xcode's command line tools and a rustup toolchain for this Mac's
# architecture: stable, or the one --toolchain names (CI passes its pinned
# version). Nothing is installed globally. The Tauri CLI is built with
# cargo into --tools, pinned to the tauri crate in desktop/Cargo.lock, and
# cargo's own downloads stay under --tools too.
#
# The app is signed ad hoc ("-"): it has no Developer ID signature and is not
# notarized. build.json records codesign's description and Gatekeeper's
# assessment as this Mac gives them.
set -eu

TAURI_CLI_VERSION=2.12.3 # matches desktop/Cargo.lock; bump both together
tools= out= version= test= channel=stable
while [ $# -gt 0 ]; do
  case "$1" in
    --tools) tools=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --toolchain) channel=$2; shift 2 ;;
    --test) test=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done
[ -n "$tools" ] && [ -n "$out" ] || { echo "--tools and --out are required" >&2; exit 64; }
[ "$(uname -s)" = Darwin ] || { echo "This builds the macOS app; run it on a Mac." >&2; exit 69; }
[ -f desktop/Cargo.lock ] || { echo "Run from the repository root." >&2; exit 66; }
grep -A1 '^name = "tauri"$' desktop/Cargo.lock | grep -q "^version = \"$TAURI_CLI_VERSION\"$" ||
  { echo "desktop/Cargo.lock's tauri is not $TAURI_CLI_VERSION; update TAURI_CLI_VERSION with it." >&2; exit 65; }

arch=$(uname -m)
# The oldest macOS each build is for: Tauri writes it to the bundle's
# LSMinimumSystemVersion and sets cargo's MACOSX_DEPLOYMENT_TARGET from it.
# Apple silicon Macs start at macOS 11, which is also what Rust's
# aarch64-apple-darwin target links for; Intel keeps Tauri's default. The
# build stops below if the executable says otherwise.
case "$arch" in
  arm64) triple=aarch64-apple-darwin minimum=11.0 ;;
  x86_64) triple=x86_64-apple-darwin minimum=10.13 ;;
  *) echo "Unknown architecture $arch" >&2; exit 69 ;;
esac
toolchain=$(ls -d "${RUSTUP_HOME:-$HOME/.rustup}"/toolchains/"$channel-$triple" 2>/dev/null) ||
  { echo "No $channel-$triple toolchain under ${RUSTUP_HOME:-$HOME/.rustup}." >&2; exit 69; }
mkdir -p "$tools" "$out"
tools=$(cd "$tools" && pwd) out=$(cd "$out" && pwd)
# The toolchain itself, not rustup's proxies, and no global cargo home.
export PATH="$toolchain/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CARGO_HOME="$tools/cargo-home" CARGO_TARGET_DIR="$tools/target"
# CI skips the disk image's Finder layout script, which needs Automation access.
export CI=true

cli="$tools/tauri-cli-$TAURI_CLI_VERSION/bin/cargo-tauri"
if [ ! -x "$cli" ]; then
  cargo install tauri-cli --version "$TAURI_CLI_VERSION" --locked --root "$tools/tauri-cli-$TAURI_CLI_VERSION"
fi

cd desktop
if [ -n "$test" ]; then
  cargo test --locked
fi
rm -rf "$CARGO_TARGET_DIR/release/bundle"
set -- build --ci --bundles app,dmg --config "{\"bundle\":{\"macOS\":{\"minimumSystemVersion\":\"$minimum\"}}}"
[ -z "$version" ] || set -- "$@" --config "{\"version\":\"$version\"}"
"$cli" "$@"

bundle="$CARGO_TARGET_DIR/release/bundle"
app="$bundle/macos/Yuzuno.app"
dmg=$(ls "$bundle"/dmg/*.dmg)
rm -rf "$out/Yuzuno.app"
ditto "$app" "$out/Yuzuno.app"
cp "$dmg" "$out/"
ditto -c -k --keepParent "$app" "$out/Yuzuno.app.zip"
plist="$app/Contents/Info.plist"
/usr/bin/python3 - "$out/build.json" <<EOF
import hashlib, json, os, plistlib, subprocess, sys

def run(*argv):
    try:
        done = subprocess.run(argv, capture_output=True, text=True)
    except FileNotFoundError:
        return {"argv": list(argv), "exit": None, "output": "not on this Mac"}
    return {"argv": list(argv), "exit": done.returncode, "output": (done.stdout + done.stderr).strip()}

def macho_minimum(path):
    """The oldest macOS a thin 64-bit Mach-O is linked for: LC_BUILD_VERSION's
    minos (platform macOS) or LC_VERSION_MIN_MACOSX's version, as X.Y.Z."""
    import struct
    data = open(path, "rb").read()
    if len(data) < 32 or struct.unpack_from("<I", data)[0] != 0xFEEDFACF:
        sys.exit(f"{path} is not a thin 64-bit Mach-O")
    found, offset = [], 32
    for _ in range(struct.unpack_from("<I", data, 16)[0]):
        command, size = struct.unpack_from("<II", data, offset)
        if command == 0x32 and struct.unpack_from("<I", data, offset + 8)[0] == 1:
            found.append(struct.unpack_from("<I", data, offset + 12)[0])
        elif command == 0x24:
            found.append(struct.unpack_from("<I", data, offset + 8)[0])
        offset += size
    if len(found) != 1:
        sys.exit(f"{path}: {len(found)} macOS minimum version load commands, not one")
    return f"{found[0] >> 16}.{(found[0] >> 8) & 0xFF}.{found[0] & 0xFF}"

def version(text):
    parts = [int(part) for part in str(text).split(".")]
    return tuple(parts + [0] * (3 - len(parts)))

def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()

info = plistlib.load(open("$plist", "rb"))
executable = os.path.join("$app", "Contents", "MacOS", info["CFBundleExecutable"])
record = {
    "sourceCommit": os.environ.get("SOURCE_COMMIT"),
    "app": {
        "bundleIdentifier": info.get("CFBundleIdentifier"),
        "name": info.get("CFBundleName"),
        "version": info.get("CFBundleShortVersionString"),
        "build": info.get("CFBundleVersion"),
        "minimumSystemVersion": info.get("LSMinimumSystemVersion"),
        "executableMinimumSystemVersion": macho_minimum(executable),
        "executableSha256": sha256(executable),
        "architectures": run("/usr/bin/lipo", "-archs", executable)["output"].split(),
    },
    "files": {name: {"sha256": sha256(os.path.join("$out", name)), "bytes": os.path.getsize(os.path.join("$out", name))}
              for name in sorted(os.listdir("$out")) if name.endswith((".dmg", ".zip"))},
    "signature": run("/usr/bin/codesign", "-dv", "--verbose=2", "$app"),
    "signatureCheck": run("/usr/bin/codesign", "--verify", "--deep", "--strict", "$app"),
    "gatekeeper": run("/usr/sbin/spctl", "--assess", "--type", "execute", "-vv", "$app"),
    # What Gatekeeper and notarization would say of a downloaded copy.
    "distribution": run("/usr/bin/syspolicy_check", "distribution", "$app"),
    "tools": {
        "macos": run("/usr/bin/sw_vers")["output"],
        "machine": "$arch",
        "xcode": run("/usr/bin/xcodebuild", "-version")["output"],
        "rustc": run("rustc", "-V")["output"],
        "cargo": run("cargo", "-V")["output"],
        "tauriCli": run("$cli", "-V")["output"],
    },
}
json.dump(record, open(sys.argv[1], "w"), indent=1)
print(json.dumps({k: record[k] for k in ("sourceCommit", "app", "files")}, indent=1))
declared, linked = record["app"]["minimumSystemVersion"], record["app"]["executableMinimumSystemVersion"]
if version(declared) != version(linked):
    sys.exit(f"The bundle declares macOS {declared} but its executable is linked for {linked}")
EOF
