#!/bin/sh
# T-88: the account owner signs the account's own Claude Code in to the NEW,
# empty profile of an installed remote_host_lab.py run, before its first-use
# stage. Copy it to the host and run it yourself in an SSH session; it opens
# Claude's own interactive login and nothing is sent to anyone else. No HOME
# change, no credential copy, no global configuration change: the profile,
# temporary and XDG folders all stay under the run folder.
# Usage: claude-login.sh <run folder on this host>
# Env: CLAUDE_BIN, the claude to use (default: $HOME/.local/bin/claude).
set -eu
run=${1:?usage: claude-login.sh <run folder>}
run=$(cd "$run" && pwd -P)
test -f "$run/core/current.json" || { echo "not an installed run: $run" >&2; exit 2; }
export CLAUDE_CONFIG_DIR="$run/claude-config"
export TMPDIR="$run/tmp"
export XDG_CACHE_HOME="$run/xdg/cache"
export XDG_CONFIG_HOME="$run/xdg/config"
export XDG_DATA_HOME="$run/xdg/data"
export XDG_STATE_HOME="$run/xdg/state"
export DISABLE_AUTOUPDATER=1
test -d "$CLAUDE_CONFIG_DIR" || { echo "missing $CLAUDE_CONFIG_DIR" >&2; exit 2; }
test -z "$(ls -A "$CLAUDE_CONFIG_DIR")" || echo "note: this profile is not empty any more (already signed in?)" >&2
exec "${CLAUDE_BIN:-$HOME/.local/bin/claude}" auth login
