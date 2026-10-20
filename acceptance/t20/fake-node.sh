#!/bin/sh
# YUZUNO_NODE for the T-20 controlled acceptance: Core starts the real bridge
# (its argument) with the fake SDK in place of the Claude Agent SDK.
here=$(dirname "$(readlink -f "$0")")
exec node --import "$here/fake-sdk-loader.mjs" "$@"
