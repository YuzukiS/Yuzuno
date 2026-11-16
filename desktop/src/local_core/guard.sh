# Read-only look at what the WSL distributions share (YN-156, design 2.5).
# The desktop app sends this script on stdin, to a distribution that is
# already running:
#
#   wsl.exe --distribution <W> --exec /bin/sh -s
#
# as that distribution's default account, and reads the key=value lines it
# prints (desktop/src/local_core/guard_rules.rs). It is run before and after
# each command into the distribution being checked, and compares what it
# prints: WSL 2's distributions share one binfmt_misc table (Windows interop)
# and one cgroup v2 tree.
#
# It creates no file or folder, mounts nothing and changes no setting: it
# reads files and prints. It uses no here-document, no redirection into a
# file and no program that writes. YUZUNO_GUARD_ROOT is for the tests only:
# it moves the /proc and /sys prefixes onto a fake root. wsl.exe passes no
# environment of its own, so a release never sets it.

root=${YUZUNO_GUARD_ROOT:-}

# key value: one line; line breaks in the value are removed.
out() {
  printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr -d '\r\n')"
}

first_line() {
  head -n 1 "$1" </dev/null 2>/dev/null
}

value_of() {
  grep "^$1 " "$2" </dev/null 2>/dev/null | head -n 1 | cut -d' ' -f2
}

binfmt=$root/proc/sys/fs/binfmt_misc
status=absent
if [ -f "$binfmt/status" ]; then
  case $(first_line "$binfmt/status") in
    enabled*) status=enabled ;;
    *) status=disabled ;;
  esac
fi

out format 1
out binfmt.status "$status"

# Every registered entry whose magic is an MZ header and whose interpreter is
# WSL's own /init is the Windows interop rule. The rest are only counted.
others=0
for entry in "$binfmt"/*; do
  [ -f "$entry" ] || continue
  name=${entry##*/}
  case $name in
    status | register) continue ;;
  esac
  state=disabled
  case $(first_line "$entry") in
    enabled*) state=enabled ;;
  esac
  magic=$(value_of magic "$entry")
  interpreter=$(value_of interpreter "$entry")
  if [ "$magic" = 4d5a ] && [ "$interpreter" = /init ]; then
    flags=$(value_of 'flags:' "$entry")
    [ -n "$flags" ] || flags=-
    out interop "$name $state $flags"
  else
    others=$((others + 1))
  fi
done
out binfmt.other "$others"

# The controllers each cgroup turns on for its children: the root, the two
# shared slices, and every systemd user manager with its app.slice. A missing
# file says (absent): it is not the same as an empty one.
cgroup=$root/sys/fs/cgroup
control() {
  if [ -f "$1" ]; then
    first_line "$1"
  else
    printf '%s' '(absent)'
  fi
}

out cgroup.root "$(control "$cgroup/cgroup.subtree_control")"
out cgroup.user-slice "$(control "$cgroup/user.slice/cgroup.subtree_control")"
out cgroup.system-slice "$(control "$cgroup/system.slice/cgroup.subtree_control")"

count=0
for service in "$cgroup"/user.slice/user-*.slice/user@*.service; do
  [ -f "$service/cgroup.subtree_control" ] || continue
  uid=${service##*/user@}
  uid=${uid%.service}
  case $uid in
    '' | *[!0-9]*) continue ;;
  esac
  count=$((count + 1))
  [ "$count" -le 64 ] || break
  out "user.$uid.control" "$(control "$service/cgroup.subtree_control")"
  out "user.$uid.app" "$(control "$service/app.slice/cgroup.subtree_control")"
done
