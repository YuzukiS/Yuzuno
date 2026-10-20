#!/bin/sh
# Self-test of independent.py over a user-level sshd on 127.0.0.1 (this
# machine, so never independent acceptance): its guards first (an unknown
# host key and the same machine both stop the run), then every item with
# --allow-same-host. No system service, account or ~/.ssh change; the sshd's
# sessions get HOME inside the lab. Usage: independent_selftest.sh [port].
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
port=${1:-4609}
lab="$root/target/t47/independent-selftest-$(date +%s)"
mkdir -p "$lab/home" && chmod 700 "$lab"
ssh-keygen -q -t ed25519 -N '' -f "$lab/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$lab/client_key"
cp "$lab/client_key.pub" "$lab/authorized_keys" && chmod 600 "$lab/authorized_keys"
sshd_port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
cat >"$lab/sshd_config" <<EOF
Port $sshd_port
ListenAddress 127.0.0.1
HostKey $lab/host_key
AuthorizedKeysFile $lab/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
StrictModes no
PidFile $lab/sshd.pid
SetEnv HOME=$lab/home
LogLevel ERROR
EOF
echo "[127.0.0.1]:$sshd_port $(cut -d' ' -f1,2 "$lab/host_key.pub")" >"$lab/known_hosts"
: >"$lab/empty_known_hosts"
for name in selftest unknown; do
  known="$lab/known_hosts"
  [ "$name" = unknown ] && known="$lab/empty_known_hosts"
  cat >>"$lab/ssh_config" <<EOF
Host $name
  HostName 127.0.0.1
  Port $sshd_port
  User $(id -un)
  IdentityFile $lab/client_key
  IdentitiesOnly yes
  UserKnownHostsFile $known
  GlobalKnownHostsFile /dev/null
EOF
done
/usr/bin/sshd -D -e -f "$lab/sshd_config" 2>"$lab/sshd.log" &
sshd=$!
trap 'kill "$sshd" 2>/dev/null; wait "$sshd" 2>/dev/null' EXIT
sleep 1
failed=0
run() {
  python3 "$here/independent.py" --port "$port" --ssh-config "$lab/ssh_config" "$@" >"$lab/last.log" 2>&1
  code=$?
  report=$(tail -1 "$lab/last.log")
  cat "$lab/last.log"
}
expect_stop() {
  label=$1; shift; reason=$1; shift
  run "$@"
  if [ "$code" -ne 0 ] && python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if sys.argv[2] in r.get("stopped","") and not r["items"] else 1)' "$report" "$reason"; then
    echo "SELFTEST PASS $label"
  else
    echo "SELFTEST FAIL $label"; failed=1
  fi
}
expect_stop "an unknown host key stops the run before anything" "host key is unknown or changed" --target unknown
expect_stop "the same machine is not taken for an independent remote" "not an independent remote" --target selftest
run --target selftest --allow-same-host --clean
if [ "$code" -eq 0 ] && python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r["passed"] and r["independent"] is False else 1)' "$report"; then
  echo "SELFTEST PASS every item over loopback, reported as not independent"
else
  echo "SELFTEST FAIL every item over loopback"; failed=1
fi
# The default data root, ~/.yuzuno in the lab's HOME: --clean leaves nothing of the run.
left=$(ls "$lab/home/.yuzuno/jobs" "$lab/home/.yuzuno/acceptance" 2>/dev/null | grep -cv -e '^$' -e ':$')
[ "$left" -eq 0 ] && echo "SELFTEST PASS nothing left under the data root" || { echo "SELFTEST FAIL $left entries left under the data root"; failed=1; }
others=$(ls -A "$lab/home" | grep -cv '^\.yuzuno$')
[ "$others" -eq 0 ] && echo "SELFTEST PASS nothing created in the remote HOME outside the data root" || { echo "SELFTEST FAIL $others entries outside the data root"; failed=1; }
echo "lab $lab"
exit $failed
