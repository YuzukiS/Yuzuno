#!/usr/bin/env bash
# Fails a CI job at its start, with a clear message, when the disk it builds
# on has less than MIN_GIB free (2026-10-17: a full disk made the Rust linker
# die with SIGBUS). Read-only:
# df only, nothing is deleted. A check at the start, not a quota: the build
# itself, or any other program on the host, can still fill the disk later.
# Usage: disk-precheck.sh MIN_GIB PATH...
set -uo pipefail
min=$1
shift
status=0
for path in "$@"; do
  avail=$(df --output=avail -B1 -- "$path" 2>/dev/null | tail -n 1 | tr -d ' ')
  # macOS's df has no --output; its POSIX form counts 1024-byte blocks.
  if [[ ! $avail =~ ^[0-9]+$ ]]; then
    kib=$(df -Pk -- "$path" 2>/dev/null | awk 'NR == 2 { print $4 }')
    [[ $kib =~ ^[0-9]+$ ]] && avail=$((kib * 1024))
  fi
  if [[ ! $avail =~ ^[0-9]+$ ]]; then
    echo "::error title=Disk space unknown::Could not read the free space of $path; not starting this job's build."
    status=1
    continue
  fi
  gib=$((avail / 1073741824))
  if ((avail < min * 1073741824)); then
    echo "::error title=Not enough disk space::$path has ${gib} GiB free; this job needs at least ${min} GiB before it starts. Free space on the runner host (nothing is deleted automatically), then run the checks again."
    status=1
  else
    echo "$path: ${gib} GiB free (this job needs ${min} GiB)"
  fi
done
exit $status
