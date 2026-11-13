# Read-only check of a WSL distribution before Yuzuno Core is installed in
# it (YN-107 design 4.3). The desktop app sends this script on stdin:
#
#   wsl.exe --distribution <D> --exec /bin/sh -s -- <installDir|default> <dataDir|default>
#
# as the distribution's default account, and reads the key=value lines it
# prints (desktop/src/local_core/check_rules.rs).
#
# It creates no file or folder, installs nothing and changes no setting: it
# reads files, asks programs for their version or status, and prints. It
# uses no here-document (a shell may keep one in a temporary file) and no
# redirection into a file. Every program it runs reads /dev/null, since this
# script itself arrives on stdin, and every one that might wait is bounded
# by `timeout`; without `timeout` they are not run.
#
# To see where the user's own tools are, it first reads the environment of
# the user's login shell as VS Code does (`-i -l -c`, csh/tcsh `-ic`; a
# random mark around `env -0`; input /dev/null; at most 1 MiB; killed with
# its whole process group after 10 seconds: GNU timeout puts the shell in a
# process group of its own and signals all of it), and keeps PATH,
# XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS from it, as a first start of
# Core would. That shell runs the user's startup files, as opening a
# terminal does; its history file is set empty.

install_arg=${1:-default}
data_arg=${2:-default}

has() {
  command -v "$1" >/dev/null 2>&1
}

# key value: one line; line breaks in the value are removed.
out() {
  printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr -d '\r\n')"
}

# The account's passwd line.
passwd_line() {
  if has getent; then
    getent passwd "$1" </dev/null 2>/dev/null | head -n 1
    return
  fi
  while IFS= read -r line; do
    case $line in
      "$2":*) printf '%s\n' "$line"; return ;;
    esac
  done </etc/passwd
}

user=$(id -un 2>/dev/null </dev/null)
uid=$(id -u 2>/dev/null </dev/null)
pw=$(passwd_line "$uid" "$user")
home=${HOME:-}
[ -n "$home" ] || home=$(printf '%s\n' "$pw" | cut -d: -f6)
shell=$(printf '%s\n' "$pw" | cut -d: -f7)
[ -n "$shell" ] || shell=/bin/sh

# What the installation itself runs with `wsl.exe --exec`, on the PATH this
# script was started with (before the login shell's is read).
missing=
for tool in tar gzip mktemp env base64 timeout; do
  has "$tool" || missing="$missing${missing:+ }$tool"
done

# The login shell's environment.
env_source=inherited
env_note=
read_login_environment() {
  case ${shell##*/} in
    bash | zsh | sh | dash | ksh | mksh | fish) flags='-i -l -c' ;;
    csh | tcsh) flags=-ic ;;
    *) env_note=unsupportedShell; return ;;
  esac
  if ! has timeout || ! has od || ! has head || ! has tr || ! has awk; then
    env_note=noTimeout
    return
  fi
  mark=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null </dev/null | tr -d ' \n')
  if [ ${#mark} -ne 16 ]; then
    env_note=noMark
    return
  fi
  # NUL-separated NAME=value becomes one line each, newlines in a value
  # becoming carriage returns first; the shell's exit status follows on a
  # line of its own. awk reads it in one pass (a shell pattern on a long
  # banner before the first mark takes time by the square of its length),
  # keeps the three names between the marks, and says whether both came.
  # shellcheck disable=SC2086 # $flags is one or more options.
  found=$( {
    HISTFILE= timeout -s KILL 10 "$shell" $flags "printf '%s' $mark; /usr/bin/env -0; printf '%s' $mark" </dev/null 2>/dev/null
    printf '\000exit=%s\000' "$?"
  } | head -c 1048576 | LC_ALL=C tr '\n\000' '\r\n' | LC_ALL=C awk -v mark="$mark" '
    /^exit=[0-9]+$/ { status = substr($0, 6) }
    state == 0 {
      at = index($0, mark)
      if (!at) next
      state = 1
      $0 = substr($0, at + length(mark))
    }
    state == 1 && index($0, mark) == 1 { state = 2 }
    state == 1 && /^(PATH|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=/ { print }
    END { print "status=" (state == 2 ? "ok" : status) }
  ')
  login_path=
  login_runtime=
  login_bus=
  status=
  old_ifs=$IFS
  IFS='
'
  set -f
  for line in $found; do
    case $line in
      PATH=*) login_path=${line#PATH=} ;;
      XDG_RUNTIME_DIR=*) login_runtime=${line#XDG_RUNTIME_DIR=} ;;
      DBUS_SESSION_BUS_ADDRESS=*) login_bus=${line#DBUS_SESSION_BUS_ADDRESS=} ;;
      status=*) status=${line#status=} ;;
    esac
  done
  set +f
  IFS=$old_ifs
  case $status in
    ok) ;;
    # timeout's own code, or KILL: the whole group was stopped.
    124 | 137) env_note=timeout; return ;;
    *) env_note=failed; return ;;
  esac
  if [ -z "$login_path" ]; then
    env_note=noPath
    return
  fi
  PATH=$login_path
  export PATH
  if [ -n "$login_runtime" ]; then XDG_RUNTIME_DIR=$login_runtime; export XDG_RUNTIME_DIR; fi
  if [ -n "$login_bus" ]; then DBUS_SESSION_BUS_ADDRESS=$login_bus; export DBUS_SESSION_BUS_ADDRESS; fi
  env_source=login
}
read_login_environment

# A program's version: the first line of `--version`, - when it is not
# found, ? when it was not run or said nothing.
version_of() {
  if [ "${1#/}" != "$1" ]; then
    [ -x "$1" ] || { printf '%s' -; return; }
  elif ! has "$1"; then
    printf '%s' -
    return
  fi
  if ! has timeout; then
    printf '%s' '?'
    return
  fi
  said=$(timeout -s KILL 5 "$1" --version </dev/null 2>/dev/null | head -n 1)
  printf '%s' "${said:-?}"
}

folder() {
  case $1 in
    default) [ -n "$home" ] && printf '%s' "$home/.local/share/$2" ;;
    *) printf '%s' "$1" ;;
  esac
}

root=$(folder "$install_arg" yuzuno-core)
data=$(folder "$data_arg" yuzuno-core-data)

if [ -z "$root" ] || { [ ! -e "$root" ] && [ ! -L "$root" ]; }; then
  root_state=absent
elif [ -d "$root" ] && [ -f "$root/current.json" ]; then
  root_state=installed
else
  root_state=other
fi

if [ -z "$data" ] || { [ ! -e "$data" ] && [ ! -L "$data" ]; }; then
  data_state=absent
elif [ -d "$data" ] && { [ -e "$data/workspace.lock" ] || [ -L "$data/workspace.lock" ]; }; then
  data_state=workspace
elif [ -d "$data" ] && [ -r "$data" ] && [ -x "$data" ] && [ -z "$(ls -A -- "$data" 2>/dev/null </dev/null | head -n 1)" ]; then
  data_state=empty
else
  data_state=other
fi

glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null </dev/null)
case $glibc in
  "glibc "*) glibc=${glibc#glibc } ;;
  *) glibc= ;;
esac

# The first bytes of a file, in base64 on one line; nothing when absent.
encoded() {
  [ -f "$1" ] && [ -r "$1" ] && has base64 || return 0
  head -c "$2" -- "$1" 2>/dev/null </dev/null | base64 | tr -d '\n'
}

if ! has gh; then
  gh_auth=-
elif ! has timeout; then
  gh_auth='?'
else
  timeout -s KILL 10 gh auth status --hostname github.com </dev/null >/dev/null 2>&1
  case $? in
    0) gh_auth=ok ;;
    124 | 137) gh_auth=timeout ;;
    *) gh_auth=no ;;
  esac
fi

cgroup=
if ! has systemctl; then
  systemd=-
elif ! has timeout; then
  systemd='?'
else
  systemd=$(timeout -s KILL 5 systemctl --user is-system-running </dev/null 2>/dev/null | head -n 1)
  group=$(timeout -s KILL 5 systemctl --user show --property=ControlGroup --value </dev/null 2>/dev/null | head -n 1)
  case $group in
    /*) [ -r "/sys/fs/cgroup$group/cgroup.controllers" ] && cgroup=$(head -n 1 "/sys/fs/cgroup$group/cgroup.controllers" </dev/null 2>/dev/null) ;;
  esac
fi

out format 1
out user "$user"
out uid "$uid"
out home "$home"
out shell "$shell"
out arch "$(uname -m 2>/dev/null </dev/null)"
out glibc "$glibc"
out tools.missing "$missing"
out env.source "$env_source"
out env.note "$env_note"
out root "$root"
out root.state "$root_state"
if [ "$root_state" = installed ]; then
  out root.current "$(encoded "$root/current.json" 4096)"
  out root.launch "$(encoded "$root/updates/launch.json" 65536)"
  if [ -x "$root/updates/start" ]; then out root.entry yes; else out root.entry no; fi
fi
out data "$data"
out data.state "$data_state"
out tool.node "$(version_of node)"
out tool.git "$(version_of git)"
out tool.gh "$(version_of gh)"
out tool.claude "$(version_of claude)"
out tool.codex "$(version_of codex)"
out tool.python3 "$(version_of /usr/bin/python3)"
out gh.auth "$gh_auth"
out systemd "$systemd"
out cgroup "$cgroup"
