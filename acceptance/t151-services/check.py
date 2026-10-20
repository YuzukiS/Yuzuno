#!/usr/bin/env python3
"""T-151 project services over real OpenSSH, on an isolated Core.

The "remote machine" is a user-level sshd on 127.0.0.1 with its own host
key, authorized key and config in this lab's folder (as in
acceptance/remote-jobs): no system service and no change to accounts or
~/.ssh. The lab Core reaches it through a PATH `ssh` wrapper that adds `-F`
for the lab's client config. The "service" is a small HTTP server on the
same host's loopback, reached through the forward.

This is one physical host over loopback: it shows the forward's lifecycle
with real OpenSSH, not acceptance on a separate machine or from another
client computer.

Checks: HTTP and a same-port WebSocket through Core's port and the
forward; nothing listening on the service's port; closing one leaves the
service and the other one alone; the machine's sshd gone (disconnected, then
unreachable) and back; a client on "another computer" (a Mac stand-in: the
address 127.0.0.2, its own SSH tunnel to Core with a restricted key whose
permitopen lists Core's port and the services' range) proves and opens a
service through its tunnel, and refuses one whose port there is taken by
something else; Core killed with SIGKILL while a client holds a stream (its
SSH ends, nothing is left listening) and started again (every service
closed, nothing reopened). The lab finds its own ssh processes by the lab's
unique config path or the lab sshd's process tree, which only this check
does; Core itself never looks for processes.
"""
import http.client
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "remote-jobs"))
import labkit  # noqa: E402

ROOT = labkit.ROOT
wait_for = labkit.wait_for
LAB = ROOT / "target" / "t47" / ("lab-t151-" + uuid.uuid4().hex[:8])
PORT = int(os.environ.get("T151_PORT", "4651"))
CORE = labkit.Core(LAB, PORT, LAB / "bin")
# The services' range for the lab Core, apart from the default one.
RANGE = range(int(os.environ.get("T151_RANGE_FIRST", "4680")), int(os.environ.get("T151_RANGE_FIRST", "4680")) + 4)
os.environ["YUZUNO_SERVICE_PORTS"] = f"{RANGE[0]}-{RANGE[-1]}"
# The "Mac": another loopback address, with its own tunnel to Core.
MAC = "127.0.0.2"
MAC_PORT = 5651
# The Yuzuno page on the Mac, as its browser names it.
MAC_PAGE = f"http://127.0.0.1:{MAC_PORT}"
request = CORE.request
SSHD = {}
REPORT = {"checks": [], "fixture": "Isolated Core + user-level sshd on 127.0.0.1 (same physical host)"}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def setup_sshd():
    """Keys, the sshd config, the client config and the ssh wrapper."""
    client = LAB / "client"
    client.mkdir(mode=0o700)
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(client / "client_key")], check=True)
    shutil.copy(client / "client_key.pub", client / "authorized_keys")
    # The Mac's key, as docs/independent-core.md option A restricts it, with
    # the services' range added to permitopen.
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(client / "mac_key")], check=True)
    opens = ",".join(f'permitopen="127.0.0.1:{p}"' for p in [PORT, *RANGE])
    REPORT["macKeyOptions"] = f'restrict,port-forwarding,{opens},command="/usr/bin/false"'
    mac_public = " ".join((client / "mac_key.pub").read_text().split()[:2])
    with (client / "authorized_keys").open("a") as keys:
        keys.write(f'{REPORT["macKeyOptions"]} {mac_public} lab-mac\n')
    os.chmod(client / "authorized_keys", 0o600)
    folder = LAB / "sshd"
    folder.mkdir(mode=0o700)
    home = LAB / "remote-home"
    home.mkdir(mode=0o700)
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(folder / "host_key")], check=True)
    port = free_port()
    (folder / "sshd_config").write_text(f"""Port {port}
ListenAddress 127.0.0.1
HostKey {folder / 'host_key'}
AuthorizedKeysFile {client / 'authorized_keys'}
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
StrictModes no
AllowTcpForwarding local
PidFile {folder / 'sshd.pid'}
SetEnv HOME={home}
LogLevel ERROR
""")
    ssh = LAB / "ssh"
    ssh.mkdir(mode=0o700)
    host = (folder / "host_key.pub").read_text().split()
    (ssh / "known_hosts").write_text(f"[127.0.0.1]:{port} {host[0]} {host[1]}\n")
    (ssh / "config").write_text(f"""Host yuzuno-lab
  HostName 127.0.0.1
  Port {port}
  User {getpass.getuser()}
  IdentityFile {client / 'client_key'}
  IdentitiesOnly yes
  UserKnownHostsFile {ssh / 'known_hosts'}
  GlobalKnownHostsFile /dev/null
""")
    bin_dir = LAB / "bin"
    bin_dir.mkdir()
    (bin_dir / "ssh").write_text(f"#!/bin/sh\nexec /usr/bin/ssh -F {ssh / 'config'} \"$@\"\n")
    os.chmod(bin_dir / "ssh", 0o755)
    REPORT["sshd"] = {"listen": f"127.0.0.1:{port}"}
    SSHD["port"] = port
    return port


def start_sshd(port):
    log = (LAB / "sshd.log").open("ab")
    SSHD["sshd"] = subprocess.Popen(["/usr/bin/sshd", "-D", "-e", "-f", str(LAB / "sshd" / "sshd_config")],
                                    stdout=log, stderr=log)
    log.close()
    wait_for(lambda: subprocess.run([str(LAB / "bin" / "ssh"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=3",
                                     "yuzuno-lab", "true"], capture_output=True, timeout=15).returncode == 0, bool, 20)


def tree(pid):
    """A process and its descendants (sshd's sessions run as sshd-session,
    whose command line does not name the lab's config)."""
    found, queue = [], [pid]
    while queue:
        current = queue.pop()
        found.append(current)
        out = subprocess.run(["pgrep", "-P", str(current)], capture_output=True, text=True).stdout
        queue += [int(p) for p in out.split()]
    return found


def alive(pids):
    left = []
    for pid in pids:
        try:
            if "zombie" not in Path(f"/proc/{pid}/status").read_text().lower():
                left.append(pid)
        except OSError:
            pass
    return left


def machine_offline():
    """The machine goes away: the lab sshd and every session it serves end."""
    sshd = SSHD.pop("sshd")
    pids = tree(sshd.pid)
    for pid in pids:
        os.kill(pid, signal.SIGKILL)
    sshd.wait(timeout=10)
    wait_for(lambda: alive(pids), lambda left: not left, 10)


def lab_ssh_pids():
    """The lab Core's service forwards: its ssh clients (by the lab's own
    client config path) whose remote command is the forward's. Core also runs
    other, short ssh calls to the machine (Jobs' helper); those are not
    services' and are reported, not counted (`other_ssh_pids`)."""
    return [pid for pid in lab_ssh_all() if b"yuzuno-forward-ready" in cmdline(pid)]


def other_ssh_pids():
    return [pid for pid in lab_ssh_all() if b"yuzuno-forward-ready" not in cmdline(pid)]


def lab_ssh_all():
    out = subprocess.run(["pgrep", "-f", str(LAB / "ssh" / "config")], capture_output=True, text=True).stdout
    return [int(p) for p in out.split()]


def cmdline(pid):
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return b""


def listening(port):
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


SERVICE = r'''
import base64, hashlib, socket, sys, threading, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(16)
def serve(c):
    head = b""
    while b"\r\n\r\n" not in head:
        part = c.recv(4096)
        if not part: return
        head += part
    lines = head.decode().split("\r\n")
    key = [l.split(":", 1)[1].strip() for l in lines if l.lower().startswith("sec-websocket-key:")]
    if key:
        accept = base64.b64encode(hashlib.sha1((key[0] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        c.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        frame = c.recv(4096)
        if len(frame) < 6: c.close(); return
        n = frame[1] & 0x7f; mask = frame[2:6]; data = bytes(b ^ mask[i % 4] for i, b in enumerate(frame[6:6 + n]))
        c.sendall(bytes([0x81, len(data)]) + data); c.close(); return
    if lines[0].startswith("GET /stream"):
        c.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
        try:
            while True: c.sendall(b"data: tick\n\n"); time.sleep(0.5)
        except OSError: return
    body = b"lab service " + sys.argv[1].encode()
    c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
    c.close()
while True:
    c, _ = s.accept(); threading.Thread(target=serve, args=(c,), daemon=True).start()
'''


def start_service(port):
    process = subprocess.Popen([sys.executable, "-c", SERVICE, str(port)])
    wait_for(lambda: listening(port), bool, 10)
    return process


def http_get(port, path="/"):
    return http_get_at("127.0.0.1", port, path)


def http_get_at(host, port, path="/"):
    """The response as text; what came before a reset (SSH resets a refused
    channel's connection)."""
    data = b""
    with socket.create_connection((host, port), timeout=5) as c:
        c.sendall(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n".encode())
        try:
            while part := c.recv(4096):
                data += part
        except ConnectionResetError:
            pass
    return data.decode(errors="replace")


def websocket_echo(port, text):
    return websocket_echo_at("127.0.0.1", port, text)


def websocket_echo_at(host, port, text):
    key = base64.b64encode(os.urandom(16)).decode()
    with socket.create_connection((host, port), timeout=5) as c:
        c.sendall((f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            head += c.recv(4096)
        status, rest = head.split(b"\r\n\r\n", 1)
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
        assert status.startswith(b"HTTP/1.1 101") and expected in status, status
        mask, data = os.urandom(4), text.encode()
        c.sendall(bytes([0x81, 0x80 | len(data)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        frame = rest or c.recv(4096)
        return frame[2:2 + frame[1]].decode()


def mac_tunnel():
    """As scripts/mac-tunnel.sh starts it (key, pinned host key, a control
    master, ExitOnForwardFailure), bound on the Mac stand-in's address."""
    client, ssh = LAB / "client", LAB / "ssh"
    # A Unix socket path holds about 100 bytes; the lab's own is too deep.
    control = Path(tempfile.mkdtemp(prefix="t151-")) / "mac"
    SSHD["control"] = control
    base = ["/usr/bin/ssh", "-F", "/dev/null", "-i", str(client / "mac_key"), "-o", "IdentitiesOnly=yes",
            "-o", "IdentityAgent=none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", f"UserKnownHostsFile={ssh / 'known_hosts'}", "-o", "GlobalKnownHostsFile=/dev/null"]
    subprocess.run(base + ["-o", "ExitOnForwardFailure=yes", "-o", "ControlMaster=yes", "-o", f"ControlPath={control}",
                           "-o", "ControlPersist=no", "-E", str(LAB / "mac.log"), "-f", "-N",
                           "-L", f"{MAC}:{MAC_PORT}:127.0.0.1:{PORT}", "-p", str(SSHD["port"]), f"{getpass.getuser()}@127.0.0.1"],
                   stdin=subprocess.DEVNULL, check=True, timeout=30)
    return control


def mac_forward(control, port, target=None):
    """One more port on the Mac's tunnel (ssh -O forward): the same number on
    the Core host, unless a target is named. Returns ssh's complaint, if any."""
    done = subprocess.run(["/usr/bin/ssh", "-F", "/dev/null", "-S", str(control), "-O", "forward",
                           "-L", f"{MAC}:{port}:127.0.0.1:{target or port}", "lab-mac"], capture_output=True, text=True, timeout=30)
    return None if done.returncode == 0 else (done.stderr.strip() or "failed")


def through_mac(path, body=None):
    """Core's API from the Mac, through its tunnel (Core sees 127.0.0.1:<tunnel port>)."""
    connection = http.client.HTTPConnection(MAC, MAC_PORT, timeout=60)
    connection.request("POST" if body is not None else "GET", "/api" + path,
                       body=None if body is None else json.dumps(body),
                       headers={"Host": f"127.0.0.1:{MAC_PORT}", "Origin": MAC_PAGE, "Content-Type": "application/json",
                                "X-Yuzuno-Client": "desktop"})
    response = connection.getresponse()
    text = response.read()
    assert response.status == 200, (response.status, text)
    return json.loads(text)


def proves(host, port, proof, origin=None):
    """The page's check before it opens a service: the reserved request on
    the port this client would open, with only the challenge and the page's
    origin, returns exactly the answer Core gave, readable by that page."""
    sent = f"Origin: {origin}\r\n" if origin else ""
    try:
        with socket.create_connection((host, port), timeout=5) as c:
            c.sendall(f"GET /.well-known/yuzuno-service/{proof['challenge']} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
                      f"{sent}Connection: close\r\n\r\n".encode())
            data = b""
            while True:
                part = c.recv(4096)
                if not part:
                    break
                data += part
    except OSError:
        return False
    head, _, body = data.partition(b"\r\n\r\n")
    readable = origin is None or f"Access-Control-Allow-Origin: {origin}".encode() in head
    return head.startswith(b"HTTP/1.1 200") and readable and body.decode(errors="replace") == proof["answer"]


def unrelated(host, port):
    """Something else on the Mac that answers every request with 200: the
    last part of its path sent back (the challenge, for the reserved
    request), readable from any page."""
    code = f"""
import socket, threading
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(({host!r}, {port})); s.listen(8)
def h(c):
    line = c.recv(4096).split(b"\\r\\n")[0]
    echo = line.split(b" ")[1].rsplit(b"/", 1)[-1] if b" " in line else b"hello"
    c.sendall(b"HTTP/1.1 200 OK\\r\\nAccess-Control-Allow-Origin: *\\r\\nContent-Length: " + str(len(echo)).encode()
              + b"\\r\\nConnection: close\\r\\n\\r\\n" + echo); c.close()
while True:
    c, _ = s.accept(); threading.Thread(target=h, args=(c,), daemon=True).start()
"""
    process = subprocess.Popen([sys.executable, "-c", code])
    wait_for(lambda: socket.socket().connect_ex((host, port)) == 0, bool, 10)
    return process


def websocket_held(port):
    """A WebSocket opened through the way and left open."""
    key = base64.b64encode(os.urandom(16)).decode()
    c = socket.create_connection(("127.0.0.1", port), timeout=5)
    c.sendall((f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    assert c.recv(4096).startswith(b"HTTP/1.1 101")
    return c


def ended(connection, seconds=5):
    """Whether the other end closes this connection (EOF or reset) in time."""
    connection.settimeout(seconds)
    try:
        while connection.recv(4096):
            pass
        return True
    except (ConnectionResetError, BrokenPipeError):
        return True
    except socket.timeout:
        return False
    finally:
        connection.close()


def check(name):
    REPORT["checks"].append(name)
    print("PASS " + name, flush=True)


def connection(service_id, project):
    services = request(f"/projects/{project}/services")["services"]
    return next(s for s in services if s["id"] == service_id)["connection"]


def main():
    LAB.mkdir(parents=True, mode=0o700)
    print(str(LAB), flush=True)
    sshd_port = setup_sshd()
    services = []
    try:
        start_sshd(sshd_port)
        CORE.start()
        work = LAB / "remote-work"
        work.mkdir()
        machine = request("/machines", {"name": "lab Linux", "target": "yuzuno-lab", "codex": "codex", "defaultCwd": str(work)})
        project = request("/projects", {"name": "Lab"})["id"]

        # 1. HTTP and a same-port WebSocket through the forward.
        port = free_port()
        services.append(start_service(port))
        dev = request(f"/projects/{project}/services", {"name": "dev", "machineId": machine["id"], "port": port, "path": "/"})
        assert dev["author"] == {"kind": "user"} and dev["connection"]["state"] == "closed", dev
        opened = request(f"/services/{dev['id']}/open", {})["connection"]
        assert (opened["state"], opened["httpStatus"]) == ("available", 200), opened
        local = opened["localPort"]
        assert local in RANGE and http_get(local).endswith(f"lab service {port}"), opened
        assert websocket_echo(local, "hello hmr") == "hello hmr"
        assert len(lab_ssh_pids()) == 1, lab_ssh_pids()
        again = request(f"/services/{dev['id']}/open", {})["connection"]
        assert (again["state"], again["localPort"], len(lab_ssh_pids())) == ("available", local, 1), again
        REPORT["forward"] = {"servicePort": port, "localPort": local}
        check("An SSH service opens on Core's port of the range, relayed over real OpenSSH: HTTP and a same-port WebSocket reach it; opening again reuses the way")

        # 2. Nothing listening on the service's port there.
        missing = free_port()
        gone = request(f"/projects/{project}/services", {"name": "stopped", "machineId": machine["id"], "port": missing})
        stopped = request(f"/services/{gone['id']}/open", {})["connection"]
        assert stopped["state"] == "notRunning" and "open failed" in stopped["reason"], stopped
        request(f"/services/{gone['id']}/close", {})
        check("Nothing listening on the service's port: notRunning, with SSH's own 'open failed' reason")

        # 3. Closing one forward leaves the service and the other forward alone.
        other_port = free_port()
        services.append(start_service(other_port))
        other = request(f"/projects/{project}/services", {"name": "other", "machineId": machine["id"], "port": other_port})
        other_local = request(f"/services/{other['id']}/open", {})["connection"]["localPort"]
        held = websocket_held(local)
        closed = request(f"/services/{dev['id']}/close", {})["connection"]
        assert closed["state"] == "closed", closed
        wait_for(lambda: listening(local), lambda up: not up, 10)
        assert ended(held), "closing ends a WebSocket held through it"
        assert http_get(port).endswith(f"lab service {port}"), "the service itself still runs"
        assert http_get(other_local).endswith(f"lab service {other_port}"), "the other forward still works"
        assert len(lab_ssh_pids()) == 1, lab_ssh_pids()
        check("Closing a service ends only its listener, its connections (a held WebSocket) and its SSH: the service and another service's way are untouched")

        # 4. The machine goes away, then comes back.
        machine_offline()
        lost = wait_for(lambda: connection(other["id"], project), lambda c: c["state"] == "disconnected", 60)
        assert lost["reason"], lost
        unreachable = request(f"/services/{other['id']}/open", {})["connection"]
        assert unreachable["state"] == "machineUnreachable" and unreachable.get("localPort") is None, unreachable
        start_sshd(sshd_port)
        back = request(f"/services/{other['id']}/open", {})["connection"]
        assert back["state"] == "available", back
        REPORT["offline"] = {"disconnected": lost["reason"], "reopened": unreachable["reason"]}
        check("The machine's sshd gone: the open forward is disconnected with SSH's reason, opening is machineUnreachable; once back it opens again")

        # 5. A client on another computer: its own tunnel, the same ports.
        control = mac_tunnel()
        dev_opened = through_mac(f"/services/{dev['id']}/open", {})
        other_opened = through_mac(f"/services/{other['id']}/open", {})
        dev_port, other_local = dev_opened["connection"]["localPort"], other_opened["connection"]["localPort"]
        assert dev_opened["connection"]["state"] == "available" and other_opened["connection"]["localPort"] == back["localPort"], other_opened
        # On the Mac, something else already listens on the other's number.
        services.append(unrelated(MAC, other_local))
        refused = {p: mac_forward(control, p) for p in RANGE}
        assert refused[dev_port] is None and refused[other_local], refused
        assert not proves(MAC, dev_port, dev_opened["proof"], origin="http://127.0.0.1:9999"), "not from another page"
        assert proves(MAC, dev_port, dev_opened["proof"], origin=MAC_PAGE), "the Mac's page proves its port reaches this Core"
        assert not proves(MAC, dev_port, dev_opened["proof"], origin=MAC_PAGE), "once only"
        assert http_get_at(MAC, dev_port).endswith(f"lab service {port}") and websocket_echo_at(MAC, dev_port, "via mac") == "via mac"
        # Its own port answers 200 too, but that is not this Core: refused.
        assert http_get_at(MAC, other_local, f"/.well-known/yuzuno-service/{other_opened['proof']['challenge']}").endswith(
            other_opened["proof"]["challenge"]), "the unrelated service echoes the challenge"
        assert not proves(MAC, other_local, other_opened["proof"], origin=MAC_PAGE), "an echo on the Mac never proves the way"
        # The same page on the Core host itself proves it directly.
        assert proves("127.0.0.1", other_local, other_opened["proof"], origin=MAC_PAGE)
        # The key opens Core's ports only: the service's own port is refused.
        sneaked = free_port()
        assert mac_forward(control, sneaked, target=port) is None
        assert http_get_at(MAC, sneaked) == "", "the restricted key cannot reach the service's own port"
        assert "administratively prohibited" in (LAB / "mac.log").read_text()
        REPORT["mac"] = {"tunnel": f"{MAC}:{MAC_PORT} -> 127.0.0.1:{PORT}", "range": f"{RANGE[0]}-{RANGE[-1]}",
                         "forwardRefused": {str(p): r for p, r in refused.items() if r}}
        check("A Mac stand-in through its own restricted tunnel proves and reaches a service on Core's port (HTTP, WebSocket); "
              "once, from its own page only; where its own port is taken by something else answering 200 and echoing the challenge, the proof fails; "
              "the key reaches only Core's ports")

        # 6. Core killed with SIGKILL while a client holds a stream, then started again.
        assert len(lab_ssh_pids()) == 2
        back_local = back["localPort"]
        stream = socket.create_connection(("127.0.0.1", back_local), timeout=5)
        stream.sendall(b"GET /stream HTTP/1.1\r\nHost: x\r\n\r\n")
        assert b"200 OK" in stream.recv(4096)
        CORE.process.send_signal(signal.SIGKILL)
        CORE.process.wait(timeout=10)
        CORE.process = None
        wait_for(lab_ssh_pids, lambda pids: not pids, 10)
        assert not listening(back_local), "nothing is left listening for the killed Core"
        stream.close()
        CORE.start()
        after = request(f"/projects/{project}/services")["services"]
        assert [s["connection"]["state"] for s in after] == ["closed"] * len(after) and not lab_ssh_pids(), after
        assert http_get(other_port).endswith(f"lab service {other_port}"), "the service itself still runs"
        check("Core killed with SIGKILL while a client holds a stream: its SSH ends on its own (stdin EOF) and nothing listens; after a restart every service is closed and none reopens")

        # 7. Core stopped (SIGTERM) while a client holds a stream and a WebSocket.
        reopened = request(f"/services/{other['id']}/open", {})["connection"]
        assert reopened["state"] == "available", reopened
        stream = socket.create_connection(("127.0.0.1", reopened["localPort"]), timeout=5)
        stream.sendall(b"GET /stream HTTP/1.1\r\nHost: x\r\n\r\n")
        assert b"200 OK" in stream.recv(4096)
        held = websocket_held(reopened["localPort"])
        forwards = lab_ssh_pids()
        assert len(forwards) == 1, forwards
        started = time.monotonic()
        CORE.process.terminate()
        CORE.process.wait(timeout=10)
        CORE.process = None
        wait_for(lambda: [p for p in forwards if b"yuzuno-forward-ready" in cmdline(p)], lambda left: not left, 10)
        gone = round(time.monotonic() - started, 2)
        assert not listening(reopened["localPort"]) and ended(held) and ended(stream)
        REPORT["stopped"] = {"forwardGoneWithinSeconds": gone,
                             "otherCoreSshStillRunning": [cmdline(p).replace(b"\0", b" ").decode(errors="replace")[-120:]
                                                          for p in other_ssh_pids()]}
        CORE.start()
        assert all(s["connection"]["state"] == "closed" for s in request(f"/projects/{project}/services")["services"])
        check("Core stopped (SIGTERM) while a client holds an HTTP stream and a WebSocket: it exits at once, both end, SSH ends and nothing listens")

        Path(LAB / "report.json").write_text(json.dumps(REPORT, indent=2))
        print(json.dumps(REPORT, indent=2), flush=True)
    finally:
        if "control" in SSHD:
            subprocess.run(["/usr/bin/ssh", "-F", "/dev/null", "-S", str(SSHD["control"]), "-O", "exit", "lab-mac"], capture_output=True)
            shutil.rmtree(SSHD["control"].parent, ignore_errors=True)
        CORE.stop() if CORE.process else None
        for process in services:
            process.kill()
        if "sshd" in SSHD:
            for pid in tree(SSHD["sshd"].pid):
                os.kill(pid, signal.SIGKILL)


if __name__ == "__main__":
    main()
