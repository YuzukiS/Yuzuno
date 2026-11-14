# Makes and removes the temporary folder the desktop app installs Core from
# (YN-107 design 4.5). The desktop app sends this script on stdin, as the
# account it installs for:
#
#   wsl.exe --distribution <D> --user <U> --exec /bin/sh -s -- prepare <installDir>
#   wsl.exe --distribution <D> --user <U> --exec /bin/sh -s -- clean <stage>
#
# prepare: makes <installDir's parent>/.yuzuno-core-install.XXXXXXXX (mode
#   0700; the parent too, with mode 0700, when it is missing), with an empty
#   bundle/ to unpack the release into and the marker .yuzuno-desktop-stage
#   beside it (not inside bundle/: the release's own check refuses a file
#   its manifest does not list), and prints stage=<folder>. First it removes
#   this account's stages in that folder that are older than 60 minutes: a
#   window closed during an installation leaves one.
# clean: removes <stage>, and prints removed=<stage>.
#
# A folder is removed only when all of these hold: its name is
# .yuzuno-core-install. and 8 letters or digits, in an absolute path with no
# empty, . or .. part; it is a folder, not a link; it belongs to this
# account; it holds the marker as a file, not a link. Nothing else is ever
# removed. A failure prints error=<why> and exits 1.
#
# The script arrives on stdin. Its work is done by the `case` at its end, so
# the shell has read all of it before any program runs; every program still
# reads /dev/null.

set -u
umask 077
marker=.yuzuno-desktop-stage

fail() {
  printf 'error=%s\n' "$1"
  exit 1
}

# An absolute path with no empty, . or .. part.
plain_path() {
  case $1 in
    /*) ;;
    *) return 1 ;;
  esac
  case $1/ in
    *//* | */./* | */../*) return 1 ;;
  esac
}

# A stage of this account, by the rules above.
is_stage() {
  plain_path "$1" || return 1
  case $1 in
    /*/.yuzuno-core-install.????????) ;;
    *) return 1 ;;
  esac
  case ${1##*.} in
    *[!A-Za-z0-9]*) return 1 ;;
  esac
  [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && [ -f "$1/$marker" ] && [ ! -L "$1/$marker" ]
}

# Removes this account's stages in $1 that are older than 60 minutes. Their
# age needs find's -mmin (GNU and BusyBox find); without it none is removed.
sweep() {
  for old in "$1"/.yuzuno-core-install.????????; do
    is_stage "$old" || continue
    [ -n "$(find "$old" -prune -mmin +60 </dev/null 2>/dev/null)" ] || continue
    rm -rf -- "$old" </dev/null 2>/dev/null && swept=$((swept + 1))
  done
}

prepare() {
  root=$1
  plain_path "$root" || fail "The installation folder must be an absolute path without empty, . or .. parts: $root"
  parent=${root%/*}
  [ -n "$parent" ] || fail "The installation folder must be inside another folder, not /."
  mkdir -p -- "$parent" </dev/null || fail "Cannot make $parent."
  swept=0
  sweep "$parent"
  stage=$(mktemp -d "$parent/.yuzuno-core-install.XXXXXXXX" </dev/null) || fail "Cannot make a temporary folder in $parent."
  if ! { mkdir -- "$stage/bundle" </dev/null && : >"$stage/$marker" && is_stage "$stage"; }; then
    rm -rf -- "$stage" </dev/null
    fail "Cannot prepare the temporary folder $stage."
  fi
  printf 'stage=%s\n' "$stage"
  printf 'swept=%s\n' "$swept"
}

clean() {
  is_stage "$1" || fail "$1 is not a temporary folder of this app; nothing was removed."
  rm -rf -- "$1" </dev/null || fail "Cannot remove all of $1."
  printf 'removed=%s\n' "$1"
}

[ $# -eq 2 ] || fail "Give a step and one folder."
case $1 in
  prepare) prepare "$2" ;;
  clean) clean "$2" ;;
  *) fail "Unknown step: $1" ;;
esac
