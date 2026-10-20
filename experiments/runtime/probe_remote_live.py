#!/usr/bin/env python3
"""Real Mac mini SSH acceptance. Only creates/stops its own temporary runtime.

Uses the existing official login in place; never reads or copies credentials.
The detached process is an official app-server with an explicit private socket,
not the user's managed/default daemon. Raw account metadata is discarded.
"""
import argparse
import json
import queue
import shlex
import subprocess
import threading
import time
import socket as sockets
from pathlib import Path
import websocket


class Remote:
    def __init__(self, target, config, codex="/opt/homebrew/bin/codex"):
        self.codex=codex
        self.ssh = ["ssh", "-F", config, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                    "-o", "ControlMaster=no", "-o", "ControlPath=none",
                    "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", target]

    def run(self, script, timeout=20):
        r = subprocess.run(self.ssh + ["/bin/zsh -lc " + shlex.quote(script)],
                           text=True, capture_output=True, timeout=timeout)
        if r.returncode:
            raise RuntimeError(r.stderr[-2000:])
        return r.stdout.strip()

    def python(self, source):
        return self.run("python3 - <<'YUZUNO_PROBE_PY'\n" + source + "\nYUZUNO_PROBE_PY")

    def start(self, root=None):
        return json.loads(self.python(
            "import tempfile,pathlib,subprocess,json\n"
            + ("root=pathlib.Path(" + repr(root) + ")\n" if root else
               "root=pathlib.Path(tempfile.mkdtemp(prefix='yuzuno-next-live-'))\n")
            + "(root/'work').mkdir(exist_ok=True)\n"
            "log=open(root/'runtime.log','ab')\n"
            f"p=subprocess.Popen([{self.codex!r},'app-server','--listen','unix://'+str(root/'runtime.sock')],"
            "stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,cwd=str(root/'work'))\n"
            "print(json.dumps({'root':str(root),'pid':p.pid,'socket':str(root/'runtime.sock')}))"
        ))

    def stop(self, runtime):
        # Verify PID's executable/arguments before killing this experiment only.
        return self.python(
            "import os,signal,subprocess,json\n"
            f"pid={runtime['pid']}\n"
            "r=subprocess.run(['ps','-p',str(pid),'-o','command='],text=True,capture_output=True)\n"
            f"owned={runtime['socket']!r} in r.stdout and 'codex' in r.stdout\n"
            "if owned: os.kill(pid,signal.SIGTERM)\n"
            "print(json.dumps({'ownedRuntimeStopped':owned}))"
        )

    def ready(self, runtime):
        began=time.monotonic()
        while time.monotonic()-began < 100:
            if self.python("import pathlib\nprint(pathlib.Path("+repr(runtime["socket"])+").exists())")=="True":
                return round(time.monotonic()-began,2)
            time.sleep(2)
        raise TimeoutError("remote socket readiness")


class Rpc:
    def __init__(self, remote, socket):
        with sockets.socket() as reservation:
            reservation.bind(("127.0.0.1",0));port=reservation.getsockname()[1]
        # A Codex Unix control socket speaks WebSocket, not newline JSON.
        # Use OpenSSH's native stream-local forwarding and maintained framing.
        self.process = subprocess.Popen(remote.ssh[:-1] + ["-N","-o","ExitOnForwardFailure=yes",
                                        "-L",f"127.0.0.1:{port}:{socket}",remote.ssh[-1]],
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, bufsize=1)
        self.messages = queue.Queue()
        self.events = []
        self.ids = 0
        self.stderr = []
        deadline=time.monotonic()+10
        while True:
            try:
                self.ws=websocket.create_connection(f"ws://127.0.0.1:{port}",timeout=1)
                break
            except (OSError,websocket.WebSocketException):
                if time.monotonic()>deadline:
                    self.process.terminate();raise
                time.sleep(.2)
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._errors, daemon=True).start()

    def _reader(self):
        while self.process.poll() is None:
            try:
                line=self.ws.recv()
                if not line:return
                self.messages.put(json.loads(line))
            except websocket.WebSocketTimeoutException:continue
            except (ValueError,websocket.WebSocketException,OSError):return

    def _errors(self):
        for line in self.process.stderr:
            self.stderr.append(line.rstrip())

    def send(self, value):
        self.ws.send(json.dumps(value))

    def next(self, timeout=1):
        try:
            m = self.messages.get(timeout=timeout)
            self.events.append(m)
            return m
        except queue.Empty:
            return {}

    def call(self, method, params, timeout=30):
        self.ids += 1
        request_id = self.ids
        self.send({"id":request_id,"method":method,"params":params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            m = self.next(.2)
            if m.get("id") == request_id and "method" not in m:
                if "error" in m: raise RuntimeError(json.dumps(m["error"]))
                if method=="account/read":
                    a=m.get("result",{}).get("account")
                    m["result"]={"account":{"type":a.get("type")} if a else None}
                return m.get("result", {})
        raise TimeoutError(method)

    def initialize(self):
        result = self.call("initialize", {"clientInfo":{"name":"yuzuno_next_live_probe","version":"0.1.0"},
                                          "capabilities":{"experimentalApi":True}})
        self.send({"method":"initialized"})
        return result

    def wait_for(self, predicate, seconds=120):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            m = self.next(.5)
            if predicate(m): return m
            if m.get("method") == "error": print("Native error:", json.dumps(m)[:1500], flush=True)
            if m.get("method") == "turn/completed":
                raise RuntimeError("Turn completed before expected native event")
        raise TimeoutError("event predicate")

    def close(self):
        self.ws.close()
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait(timeout=5)


def thread_params(cwd, approval="never", sandbox="workspace-write"):
    return {"cwd":cwd,"approvalPolicy":approval,"sandbox":sandbox,"ephemeral":False,
            "config":{"model_reasoning_effort":"low"},
            "developerInstructions":"You are running a narrowly scoped Yuzuno acceptance test. Perform only the exact requested test command and reply. Do not inspect other files, load external context, or call additional tools."}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target",required=True,help="Explicitly authorized SSH target or alias")
    ap.add_argument("--ssh-config",default=(str(Path.home() / '.ssh/config')))
    ap.add_argument("--codex-bin",default="/opt/homebrew/bin/codex")
    ap.add_argument("--output",type=Path,default=Path("experiments/runtime/remote-live-observations.json"))
    args=ap.parse_args()
    remote=Remote(args.target,args.ssh_config,args.codex_bin)
    report={"createdAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"target":args.target,
            "runtimeKind":"detached-official-app-server-private-unix-socket", "managedDaemonBootstrapTested":False,
            "credentialsCopied":False,"codexBinary":args.codex_bin,"checks":{}}
    runtime=None; clients=[]
    def save(): args.output.write_text(json.dumps(report,indent=2)+"\n")
    def connect():
        c=Rpc(remote,runtime["socket"]);clients.append(c);init=c.initialize()
        report.setdefault("initialize",init)
        return c
    try:
        runtime=remote.start();report["runtime"]=runtime;save()
        report["socketReadySeconds"]=remote.ready(runtime)
        c=connect()
        a=c.call("account/read",{"refreshToken":False}).get("account")
        report["account"]={"loggedIn":a is not None,"type":a.get("type") if a else None}
        if not a: raise RuntimeError("Remote official account is not logged in")
        cwd=runtime["root"]+"/work"
        started=c.call("thread/start",thread_params(cwd));tid=started["thread"]["id"]
        report["threadId"]=tid;report["model"]=started.get("model");save()
        prompt="Run exactly this command in the current task directory: python3 -c \"import time,pathlib; pathlib.Path('started.txt').write_text('STARTED'); time.sleep(25); pathlib.Path('offline-result.txt').write_text('YUZUNO_MAC_OFFLINE_OK'); print('YUZUNO_MAC_OFFLINE_OK')\". After it finishes, reply exactly YUZUNO_MAC_OFFLINE_OK. Do not run any other commands."
        t=c.call("turn/start",{"threadId":tid,"effort":"low","input":[{"type":"text","text":prompt}]})
        report["turnId"]=t["turn"]["id"]
        m=c.wait_for(lambda m: m.get("method")=="item/started" and m.get("params",{}).get("item",{}).get("type")=="commandExecution")
        report["commandStarted"]=m["params"]["item"]
        c.close();report["disconnectedAt"]=time.time();save()
        print("Remote command started; SSH client disconnected for 35 seconds",flush=True)
        time.sleep(35)
        report["offlineFile"]=remote.python("import pathlib,json\np=pathlib.Path("+repr(cwd+"/offline-result.txt")+")\nprint(json.dumps({'exists':p.exists(),'content':p.read_text() if p.exists() else None}))")
        c=connect()
        c.call("thread/resume",{"threadId":tid})
        history=c.call("thread/read",{"threadId":tid,"includeTurns":True})
        report["historyAfterReconnect"]=history
        turns=history.get("thread",{}).get("turns",[])
        report["checks"]["offlineToolCompleted"]=json.loads(report["offlineFile"]).get("content")=="YUZUNO_MAC_OFFLINE_OK"
        report["checks"]["sameTurnCompletedAfterReconnect"]=any(x.get("id")==report["turnId"] and x.get("status")=="completed" for x in turns)
        report["reconnectEventMethods"]=sorted({x.get("method") for x in c.events if x.get("method")})
        save(); print("Offline completion checked",report["checks"],flush=True)

        # Real approval generated while no client is connected. The command first
        # sleeps within the writable task dir; a later explicit escalation can
        # only print a fixed marker. No unrelated writes or privilege changes.
        started=c.call("thread/start",thread_params(cwd,"on-request","read-only"));ptid=started["thread"]["id"]
        report["pendingThreadId"]=ptid
        prompt="This is a human-approval replay acceptance test. First run exactly `sleep 15` with default permissions and wait for completion. Then invoke exec_command with command `printf YUZUNO_APPROVAL_OK`, sandbox_permissions `require_escalated`, and justification `Yuzuno isolated approval replay test: allow printing this fixed marker?`. You must request that explicit approval rather than silently running the print command normally. After the print command completes reply YUZUNO_APPROVAL_DONE. Do not run other commands."
        pt=c.call("turn/start",{"threadId":ptid,"effort":"low","input":[{"type":"text","text":prompt}]})
        report["pendingTurnId"]=pt["turn"]["id"]
        c.wait_for(lambda m:m.get("method")=="item/started" and m.get("params",{}).get("item",{}).get("type")=="commandExecution")
        c.close();report["pendingDisconnectedAt"]=time.time()
        save();print("Pending-request test disconnected during sleep",flush=True);time.sleep(25)
        c=connect()
        report["pendingReconnectedAt"]=time.time()
        report["pendingResume"]=c.call("thread/resume",{"threadId":ptid})
        try:
            pending=next((m for m in c.events if "id" in m and m.get("method","").endswith("requestApproval")),None)
            if pending is None:
                pending=c.wait_for(lambda m:"id" in m and m.get("method","").endswith("requestApproval"),seconds=20)
            report["replayedApproval"]=pending
            command=pending.get("params",{}).get("command","")
            if command not in ["printf YUZUNO_APPROVAL_OK","/bin/zsh -lc 'printf YUZUNO_APPROVAL_OK'"]:
                raise RuntimeError("Refusing to approve a command other than this experiment's exact marker print")
            c.send({"id":pending["id"],"result":{"decision":"accept"}})
            done=c.wait_for(lambda m:m.get("method")=="turn/completed" and m.get("params",{}).get("turn",{}).get("id")==report["pendingTurnId"],seconds=90)
            report["approvalCompleted"]=done
            report["checks"]["offlinePendingReplayed"]=True
            report["checks"]["approvalAcceptedTurnCompleted"]=done["params"]["turn"]["status"]=="completed"
            report["checks"]["approvedCommandPrintedMarker"]=any(m.get("method")=="item/completed" and m.get("params",{}).get("item",{}).get("type")=="commandExecution" and m["params"]["item"].get("exitCode")==0 and m["params"]["item"].get("aggregatedOutput")=="YUZUNO_APPROVAL_OK" for m in c.events)
        except TimeoutError:
            report["checks"]["offlinePendingReplayed"]=False
            report["pendingHistory"]=c.call("thread/read",{"threadId":ptid,"includeTurns":True})
            c.call("turn/interrupt",{"threadId":ptid,"turnId":report["pendingTurnId"]})
        report["pendingReconnectEvents"]=[m for m in c.events if not m.get("method","").startswith(("account/","remoteControl/"))]
        save()

        # Stop/restart only this runtime, then restore the already completed
        # history. This is distinct from preserving running tool execution.
        for client in clients:client.close()
        report["firstRuntimeStop"]=json.loads(remote.stop(runtime));time.sleep(1)
        runtime=remote.start(runtime["root"]);report["secondRuntime"]=runtime;remote.ready(runtime)
        c=connect();report["resumeAfterRuntimeRestart"]=c.call("thread/resume",{"threadId":tid})
        h=c.call("thread/read",{"threadId":tid,"includeTurns":True})
        report["checks"]["completedHistorySurvivesRuntimeRestart"]=any(x.get("id")==report["turnId"] and x.get("status")=="completed" for x in h.get("thread",{}).get("turns",[]))
        save()
    except Exception as e:
        if clients:
            report["eventsAtFailure"]=clients[-1].events
            report["transportStderr"]=clients[-1].stderr
        report["error"]={"type":type(e).__name__,"message":str(e)};save();raise
    finally:
        for client in clients:client.close()
        if runtime:report["cleanup"]=json.loads(remote.stop(runtime))
        save()
    print(json.dumps(report["checks"],indent=2))


if __name__=="__main__":main()
