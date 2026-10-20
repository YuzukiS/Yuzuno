#!/bin/sh
# Starts, stops or checks the SSH tunnel the Mac desktop app uses to reach a
# Core on another computer (for example Linux in WSL over a private network).
#
#   scripts/mac-tunnel.sh start|stop|status
#
# Settings come from the environment (defaults in brackets):
#   YUZUNO_TUNNEL_HOST         the Core host's address              (required to start)
#   YUZUNO_TUNNEL_SSH_PORT     its SSH port                         [22]
#   YUZUNO_TUNNEL_USER         the account on it                    [$USER]
#   YUZUNO_TUNNEL_KEY          the key this tunnel signs in with    [~/.ssh/yuzuno_tunnel]
#   YUZUNO_TUNNEL_KNOWN_HOSTS  the pinned host key of that server   [~/.ssh/yuzuno_known_hosts]
#   YUZUNO_TUNNEL_LOCAL_PORT   the port the app connects to here    [5317]
#   YUZUNO_TUNNEL_CORE_PORT    Core's loopback port on that host    [4317]
#   YUZUNO_TUNNEL_STATE_DIR    a folder only you can open           [$TMPDIR/yuzuno-tunnel]
#
# The host key must already be in YUZUNO_TUNNEL_KNOWN_HOSTS, written from a
# fingerprint you checked; this never accepts a new or changed host key. It
# forwards 127.0.0.1:<local port> to Core's loopback port only and stops when
# the connection is lost (start it again). Point the app at
# http://127.0.0.1:<local port> once; it remembers it.
#
# One tunnel per local port. ssh runs as a control master, and its control
# socket in the state folder is the only handle on it: status and stop ask the
# master itself, never a process ID. start refuses a local port that something
# else already answers on, and one this script already tunnels to another
# Core. A second run for the same port while one is working stops at once
# with status 75.
set -eu

host=${YUZUNO_TUNNEL_HOST:-}
ssh_port=${YUZUNO_TUNNEL_SSH_PORT:-22}
user=${YUZUNO_TUNNEL_USER:-$USER}
key=${YUZUNO_TUNNEL_KEY:-$HOME/.ssh/yuzuno_tunnel}
known=${YUZUNO_TUNNEL_KNOWN_HOSTS:-$HOME/.ssh/yuzuno_known_hosts}
local_port=${YUZUNO_TUNNEL_LOCAL_PORT:-5317}
core_port=${YUZUNO_TUNNEL_CORE_PORT:-4317}
tmp=${TMPDIR:-/tmp}
dir=${YUZUNO_TUNNEL_STATE_DIR:-${tmp%/}/yuzuno-tunnel}
dir=${dir%/}

for port in "$ssh_port" "$local_port" "$core_port"; do
  case $port in
    '' | *[!0-9]*) echo "Ports must be numbers (got '$port')." >&2; exit 64 ;;
  esac
done
case ${1:-} in
  start | stop | status) ;;
  *) echo "Usage: $0 start|stop|status" >&2; exit 64 ;;
esac

ctl=$dir/$local_port.ssh
record=$dir/$local_port.target
log=$dir/$local_port.log
# ssh makes the control socket under a name 17 characters longer, and a
# socket path on macOS holds at most 103.
if [ ${#ctl} -gt 86 ]; then
  echo "The state folder's path is too long for ssh's control socket: set YUZUNO_TUNNEL_STATE_DIR to a shorter folder." >&2
  exit 64
fi
if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then
  (umask 077 && mkdir "$dir")
fi
if [ -L "$dir" ] || [ ! -d "$dir" ] || [ -z "$(find "$dir" -prune -user "$(id -u)" -perm 700)" ]; then
  echo "$dir must be a folder of yours that only you can open (mode 700)." >&2
  exit 73
fi

# One start, stop or status per local port at a time; the lock goes with the
# process that holds it.
if [ -z "${YUZUNO_TUNNEL_LOCKED:-}" ]; then
  status=0
  YUZUNO_TUNNEL_LOCKED=1 /usr/bin/lockf -k -s -t 0 "$dir/$local_port.lock" /bin/sh "$0" "$@" || status=$?
  if [ "$status" -eq 75 ]; then
    echo "Another start, stop or status for port $local_port is running; try again when it ends." >&2
  fi
  exit "$status"
fi

master() {
  /usr/bin/ssh -F /dev/null -S "$ctl" -O "$1" "$user@${host:-core}" 2>/dev/null
}

running() {
  [ -S "$ctl" ] && master check
}

health() {
  /usr/bin/curl -fsS --max-time 4 --noproxy '*' "http://127.0.0.1:$local_port/api/health" >/dev/null 2>&1
}

# Whether anything accepts a connection on the local port (curl's 7: refused).
answering() {
  code=0
  /usr/bin/curl -s -o /dev/null --connect-timeout 2 --max-time 3 --noproxy '*' "http://127.0.0.1:$local_port/" || code=$?
  [ "$code" -ne 7 ]
}

case $1 in
  start)
    [ -n "$host" ] || { echo "Set YUZUNO_TUNNEL_HOST to the Core host's address." >&2; exit 64; }
    [ -f "$key" ] || { echo "No key at $key." >&2; exit 66; }
    [ -f "$known" ] || { echo "No pinned host key at $known; see the guide." >&2; exit 66; }
    target="$user@$host port $ssh_port to Core port $core_port, key $key, host key $known"
    if running; then
      if [ "$(cat "$record" 2>/dev/null || true)" != "$target" ]; then
        echo "Port $local_port already has a tunnel to another Core ($(cat "$record" 2>/dev/null || echo 'unknown')). Stop it first: $0 stop" >&2
        exit 1
      fi
      if health; then echo "Already running: http://127.0.0.1:$local_port"; exit 0; fi
      echo "Already running, but Core does not answer through it; stop it and start again." >&2
      exit 1
    fi
    # Left by a tunnel that ended without stop.
    rm -f "$ctl" "$record" "$log"
    if answering; then
      echo "Something on this Mac already answers on 127.0.0.1:$local_port; set YUZUNO_TUNNEL_LOCAL_PORT to a free port." >&2
      exit 1
    fi
    printf '%s\n' "$target" >"$record"
    # With -f, ssh returns only once it has signed in, bound the local port and
    # opened its control socket; ExitOnForwardFailure makes a bind failure fatal.
    if ! /usr/bin/ssh -F /dev/null -i "$key" -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes \
      -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known" -o GlobalKnownHostsFile=/dev/null \
      -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -o ForwardAgent=no -o ForwardX11=no \
      -o ControlMaster=yes -o ControlPath="$ctl" -o ControlPersist=no -E "$log" \
      -f -N -L "127.0.0.1:$local_port:127.0.0.1:$core_port" -p "$ssh_port" "$user@$host" </dev/null; then
      echo "The tunnel did not start. ssh said:" >&2
      cat "$log" >&2
      rm -f "$record" "$log"
      exit 1
    fi
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      running || break
      if health; then echo "Tunnel up: http://127.0.0.1:$local_port"; exit 0; fi
      sleep 1
    done
    echo "The tunnel did not reach Core. ssh said:" >&2
    cat "$log" >&2
    master exit || true
    rm -f "$ctl" "$record" "$log"
    exit 1
    ;;
  stop)
    if running; then
      master exit || true
      # Its listener closes as it exits.
      for _ in 1 2 3 4 5; do
        answering || break
        sleep 1
      done
      echo "Stopped."
    else
      echo "Not running."
    fi
    rm -f "$ctl" "$record" "$log"
    ;;
  status)
    if running; then
      if health; then echo "Up: http://127.0.0.1:$local_port ($(cat "$record" 2>/dev/null || true))"; exit 0; fi
      echo "Running, but Core does not answer through it."
      exit 1
    fi
    echo "Not running."
    exit 3
    ;;
esac
