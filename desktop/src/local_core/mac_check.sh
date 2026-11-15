#!/bin/sh
# What the Mac app reads of the tools on the login shell's PATH (YN-108
# design 4.2). The app runs this one fixed script, never one built from a
# name or path, with /bin/sh and the PATH it read from the login shell.
#
# It prints `key=value` lines only: a version is the program's own first
# line, `-` says the PATH has no such program, and `?` says it was not run.
# Nothing here writes a file or changes a setting. The last line, `done=1`,
# tells the app the script reached its end before its time was up.
printf 'format=1\n'
if command -v node >/dev/null 2>&1; then
  printf 'tool.node=%s\n' "$(node --version 2>/dev/null | head -n 1)"
else
  printf 'tool.node=-\n'
fi
# /usr/bin/git is Xcode's stand-in while the command line tools are missing:
# running it opens Apple's installer, so the app says not to run it then.
if [ "${YUZUNO_CHECK_GIT:-1}" = 0 ]; then
  printf 'tool.git=?\n'
elif command -v git >/dev/null 2>&1; then
  printf 'tool.git=%s\n' "$(git --version 2>/dev/null | head -n 1)"
else
  printf 'tool.git=-\n'
fi
if command -v gh >/dev/null 2>&1; then
  printf 'tool.gh=%s\n' "$(gh --version 2>/dev/null | head -n 1)"
  gh auth status >/dev/null 2>&1
  printf 'gh.auth=%s\n' "$?"
else
  printf 'tool.gh=-\n'
  printf 'gh.auth=-\n'
fi
if command -v claude >/dev/null 2>&1; then
  printf 'tool.claude=%s\n' "$(claude --version 2>/dev/null | head -n 1)"
else
  printf 'tool.claude=-\n'
fi
if command -v codex >/dev/null 2>&1; then
  printf 'tool.codex=%s\n' "$(codex --version 2>/dev/null | head -n 1)"
else
  printf 'tool.codex=-\n'
fi
printf 'done=1\n'
