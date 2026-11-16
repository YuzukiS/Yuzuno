#!/bin/sh
# Builds the macOS desktop app (Yuzuno.app), a disk image and the app's update
# package (Yuzuno.app.tar.gz) on a Mac, and writes what was built and with
# what to build.json.
#
#   scripts/desktop-macos.sh --tools DIR --out DIR [--version X.Y.Z] [--update-public-key FILE]
#                            [--lab] [--toolchain NAME] [--test]
#   scripts/desktop-macos.sh --tools DIR --install-cli [--toolchain NAME]
#
# --lab builds Yuzuno Lab (desktop/tauri.lab.conf.json: its own name, bundle
# identifier and data) for update tests; its files are named after it
# (Yuzuno Lab.app, Yuzuno Lab.app.zip, Yuzuno Lab.app.tar.gz).
# --install-cli only installs the pinned Tauri CLI into --tools and prints
# its path, for its signer commands.
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
#
# --update-public-key embeds an updater public key (a .pub as `tauri signer
# generate` writes it: one base64 line) as plugins > updater > pubkey, the key
# the app verifies its updates with. The update package is not signed here:
# no private key is used, and the package is signed where the release is made.
set -eu

TAURI_CLI_VERSION=2.12.3 # matches desktop/Cargo.lock; bump both together
tools= out= version= test= channel=stable key_file= lab= cli_only=
while [ $# -gt 0 ]; do
  case "$1" in
    --tools) tools=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --update-public-key) key_file=$2; shift 2 ;;
    --lab) lab=1; shift ;;
    --install-cli) cli_only=1; shift ;;
    --toolchain) channel=$2; shift 2 ;;
    --test) test=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done
[ -n "$tools" ] && { [ -n "$out" ] || [ -n "$cli_only" ]; } || { echo "--tools and --out are required" >&2; exit 64; }
[ "$(uname -s)" = Darwin ] || { echo "This builds the macOS app; run it on a Mac." >&2; exit 69; }
[ -f desktop/Cargo.lock ] || { echo "Run from the repository root." >&2; exit 66; }
grep -A1 '^name = "tauri"$' desktop/Cargo.lock | grep -q "^version = \"$TAURI_CLI_VERSION\"$" ||
  { echo "desktop/Cargo.lock's tauri is not $TAURI_CLI_VERSION; update TAURI_CLI_VERSION with it." >&2; exit 65; }
# The update public key: one base64 line holding a minisign public key, read
# now, before the build. Its key ID (what minisign prints for it) goes to
# build.json. (Python's text is in single quotes: macOS's /bin/sh, bash 3.2,
# misreads a here-document inside $(...).)
key= key_id=
if [ -n "$key_file" ]; then
  [ -f "$key_file" ] || { echo "No update public key at $key_file." >&2; exit 66; }
  key_id=$(/usr/bin/python3 -I -c '
import base64, re, struct, sys
text = open(sys.argv[1], encoding="ascii").read()
if not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}\n?", text):
    sys.exit("it is not one line of base64")
pub = base64.b64decode(text.strip(), validate=True).decode("ascii")
found = re.fullmatch(r"untrusted comment: minisign public key: ([0-9A-F]{16})\n(RW[A-Za-z0-9+/]{54})\n?", pub)
if not found:
    sys.exit("it does not hold a minisign public key")
raw = base64.b64decode(found.group(2), validate=True)
# "Ed", then the key ID as a little-endian 64-bit number, then the key.
if len(raw) != 42 or raw[:2] != b"Ed":
    sys.exit("its key is not an Ed25519 minisign key")
print("%016X" % struct.unpack("<Q", raw[2:10])[0])
' "$key_file") || { echo "$key_file is not an updater public key." >&2; exit 65; }
  key=$(cat "$key_file")
fi

arch=$(uname -m)
# The oldest macOS each build is for: Tauri writes it to the bundle's
# LSMinimumSystemVersion and sets cargo's MACOSX_DEPLOYMENT_TARGET from it.
# Apple silicon Macs start at macOS 11, which is also what Rust's
# aarch64-apple-darwin target links for. The build stops below if the
# executable says otherwise. macOS is Apple silicon only (YN-161): Intel
# Macs are no longer supported, so an Intel Mac is refused below.
case "$arch" in
  arm64) triple=aarch64-apple-darwin minimum=11.0 ;;
  x86_64) echo "This builds the macOS app for Apple silicon only; Intel Macs are not supported." >&2; exit 69 ;;
  *) echo "Unknown architecture $arch" >&2; exit 69 ;;
esac
toolchain=$(ls -d "${RUSTUP_HOME:-$HOME/.rustup}"/toolchains/"$channel-$triple" 2>/dev/null) ||
  { echo "No $channel-$triple toolchain under ${RUSTUP_HOME:-$HOME/.rustup}." >&2; exit 69; }
mkdir -p "$tools"
tools=$(cd "$tools" && pwd)
if [ -z "$cli_only" ]; then mkdir -p "$out" && out=$(cd "$out" && pwd); fi
# The toolchain itself, not rustup's proxies, and no global cargo home.
export PATH="$toolchain/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CARGO_HOME="$tools/cargo-home" CARGO_TARGET_DIR="$tools/target"
# CI skips the disk image's Finder layout script, which needs Automation access.
export CI=true

cli="$tools/tauri-cli-$TAURI_CLI_VERSION/bin/cargo-tauri"
if [ ! -x "$cli" ]; then
  cargo install tauri-cli --version "$TAURI_CLI_VERSION" --locked --root "$tools/tauri-cli-$TAURI_CLI_VERSION"
fi
if [ -n "$cli_only" ]; then
  echo "$cli"
  exit 0
fi

cd desktop
if [ -n "$test" ]; then
  cargo test --locked
fi
rm -rf "$CARGO_TARGET_DIR/release/bundle"
set -- build --ci --bundles app,dmg --config "{\"bundle\":{\"macOS\":{\"minimumSystemVersion\":\"$minimum\"}}}"
[ -z "$version" ] || set -- "$@" --config "{\"version\":\"$version\"}"
[ -z "$key" ] || set -- "$@" --config "{\"plugins\":{\"updater\":{\"pubkey\":\"$key\"}}}"
[ -z "$lab" ] || set -- "$@" --config "$(pwd)/tauri.lab.conf.json"
"$cli" "$@"

bundle="$CARGO_TARGET_DIR/release/bundle"
# The one app and the one disk image the bundler made; the app is named after
# the product (Yuzuno, or Yuzuno Lab with --lab).
set -- "$bundle"/macos/*.app
[ $# -eq 1 ] && [ -d "$1" ] || { echo "Expected one app in $bundle/macos, found: $*" >&2; exit 70; }
app=$1 name=$(basename "$1")
set -- "$bundle"/dmg/*.dmg
[ $# -eq 1 ] && [ -f "$1" ] || { echo "Expected one disk image in $bundle/dmg, found: $*" >&2; exit 70; }
dmg=$1
rm -rf "$out/$name"
ditto "$app" "$out/$name"
cp "$dmg" "$out/"
ditto -c -k --keepParent "$app" "$out/$name.zip"
# The update package, as Tauri's bundler packs one (the .app with its own
# folder as the root, symbolic links kept as links; the updater skips that
# first level when it unpacks): written here because the bundler signs the
# packages it makes and needs the private key for that. GNU format, without
# the ._ files and extended attributes macOS's own tar would add.
/usr/bin/python3 -I - "$app" "$out/$name.tar.gz" <<'EOF'
import os, sys, tarfile
with tarfile.open(sys.argv[2], "w:gz", format=tarfile.GNU_FORMAT) as tar:
    tar.add(sys.argv[1], arcname=os.path.basename(sys.argv[1]))  # does not follow symbolic links
EOF
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
        # The minisign key ID of the embedded update public key, or None.
        "updatePublicKeyId": "$key_id" or None,
    },
    "files": {name: {"sha256": sha256(os.path.join("$out", name)), "bytes": os.path.getsize(os.path.join("$out", name))}
              for name in sorted(os.listdir("$out")) if name.endswith((".dmg", ".zip", ".tar.gz"))},
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
