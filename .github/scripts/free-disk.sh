#!/usr/bin/env bash
# Removes preinstalled SDKs that no job here uses (Android, .NET, Haskell,
# CodeQL, Swift), but only when / has less than MIN_GIB free (T-150).
# An earlier hosted run (2026-10-17) ran out of disk compiling the Core tests;
# hosted runners now usually start with far more free space than a build
# uses, and removing the SDKs took 50-120 s. When the free space cannot be
# read, they are removed. disk-precheck.sh still refuses to start a build with
# too little free.
# Usage: free-disk.sh MIN_GIB
set -euo pipefail
min=${1:-}
[[ $min =~ ^[0-9]+$ ]] || { echo "usage: free-disk.sh MIN_GIB" >&2; exit 2; }
avail=$(df --output=avail -B1 / 2>/dev/null | tail -n 1 | tr -d ' ' || true)
if [[ $avail =~ ^[0-9]+$ ]] && ((avail >= min * 1073741824)); then
  echo "/ has $((avail / 1073741824)) GiB free, at least ${min} GiB: nothing removed."
else
  echo "/ has less than ${min} GiB free, or its free space is unknown: removing preinstalled SDKs that no job here uses."
  sudo rm -rf /usr/local/lib/android /usr/share/dotnet /opt/ghc /usr/local/.ghcup \
    /opt/hostedtoolcache/CodeQL /usr/share/swift
fi
df -h / "${RUNNER_TEMP:-/tmp}"
