#!/usr/bin/env bash
# Runs right after checkout in every job of the public repository's CI
# (ci/public/ci.yml) and its other workflows, on Linux and on macOS (T-165).
# Each job's first step has already refused a runner that is not
# GitHub-hosted; this checks again, so a runner registered with a matching
# label can never run a public job, and records the runner image and its
# architecture, CPU, memory and disk in the job summary.
set -uo pipefail
environment=${RUNNER_ENVIRONMENT:-}
if [[ $environment != github-hosted ]]; then
  echo "::error title=Not a GitHub-hosted runner::RUNNER_ENVIRONMENT is '${environment:-unset}'. The public CI runs only on GitHub-hosted runners."
  exit 1
fi
image="${ImageOS:-unknown} ${ImageVersion:-unknown}"
arch=$(uname -m)
if [[ $(uname -s) == Darwin ]]; then
  cpus=$(sysctl -n hw.ncpu)
  memory="$(($(sysctl -n hw.memsize) / 1073741824)) GiB"
else
  cpus=$(nproc)
  memory=$(free -g | awk '/^Mem:/ { print $2 " GiB" }')
fi
echo "GitHub-hosted runner: image $image, $arch, $cpus CPUs, $memory memory"
df -h / "${RUNNER_TEMP:-/tmp}"
if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  {
    echo "### Runner"
    echo
    echo "GitHub-hosted, image \`$image\`, $arch, $cpus CPUs, $memory memory."
    echo
    echo '```'
    df -h / "${RUNNER_TEMP:-/tmp}"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi
