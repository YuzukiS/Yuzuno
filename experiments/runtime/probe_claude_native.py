#!/usr/bin/env python3
"""Test existing WSL and Windows official Claude logins without moving auth.

No explicit CLAUDE_CONFIG_DIR is added: default and explicit aliases are not
equivalent in these installed CLIs. All sessions are new, tools disabled, and
customization disabled with the official --safe-mode flag.
"""
import base64
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid


def ps(source, timeout=180):
    encoded=base64.b64encode(source.encode("utf-16le")).decode()
    return subprocess.run(["powershell.exe","-NoProfile","-EncodedCommand",encoded],
                          capture_output=True,text=True,timeout=timeout)


def quote(s):return "'"+s.replace("'","''")+"'"


# Resolve the existing native installation from Windows PATH; an explicit path
# can be supplied without committing a user's profile directory.
WIN_CLI=os.environ.get("YUZUNO_WINDOWS_CLAUDE", "claude.cmd")
flags=["-p","--safe-mode","--tools=","--output-format","json","--model","haiku",
       "--effort","low","--max-budget-usd","1.0"]


def run(host, cwd, extra, prompt):
    args=flags+extra+[prompt]
    if host=="wsl":
        env=os.environ.copy();env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]="1"
        r=subprocess.run(["claude"]+args,cwd=cwd,env=env,text=True,capture_output=True,timeout=180)
    else:
        r=ps("$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'; Set-Location "+quote(cwd)+"; & "+quote(WIN_CLI)+" "+" ".join(quote(a) for a in args))
    try:
        data=json.loads(r.stdout)
        # Result JSON contains test text, session id and usage. Keep no system
        # init or auth output; do not include opaque stderr/debug logs.
        return {"exitCode":r.returncode,**{k:data.get(k) for k in
                ["type","subtype","is_error","result","session_id","num_turns","total_cost_usd","usage","permission_denials"]}}
    except ValueError:
        return {"exitCode":r.returncode,"nonJsonOutput":r.stdout[-2000:],"stderr":r.stderr[-1000:]}


def status(host):
    r=(subprocess.run(["claude","auth","status","--json"],text=True,capture_output=True,timeout=30)
       if host=="wsl" else ps("& "+quote(WIN_CLI)+" auth status --json",timeout=30))
    return json.loads(r.stdout)


def finish_windows():
    """Run only after the user has completed the official Windows login."""
    path=Path("experiments/runtime/claude-session-observations.json")
    report=json.loads(path.read_text())
    identities={h:status(h) for h in ["wsl","windows"]}
    identifiers={h:identities[h].get("email") or identities[h].get("accountId") for h in identities}
    if not all(identifiers.values()) or len(set(identifiers.values()))!=2:
        raise RuntimeError("Windows and WSL must report two distinct official account identities")
    # The previous Windows request failed before producing any model content.
    # Preserve it, then start a new explicit test session after reauthentication.
    report.setdefault("previousWindowsAttempts",[]).append({"sessionId":report["sessionIds"]["windows"],
        "taskDirectory":report["taskDirectories"]["windows"],"initial":report["initial"]["windows"]})
    sid=str(uuid.uuid4())
    cwd=ps("$p=Join-Path $env:LOCALAPPDATA 'Yuzuno\\acceptance\\"+sid+"'; New-Item -ItemType Directory -Force -Path $p | Out-Null; Write-Output $p").stdout.strip()
    marker="YUZUNO_WINDOWS_"+uuid.uuid4().hex[:10]
    report["sessionIds"]["windows"]=sid;report["taskDirectories"]["windows"]=cwd
    def save():path.write_text(json.dumps(report,indent=2)+"\n")
    r=run("windows",cwd,["--session-id",sid],"Remember this exact acceptance marker for this conversation: "+marker+". Reply with exactly that marker. Use no tools.")
    report["initial"]["windows"]=r
    report["checks"]["windowsInitialSucceeded"]=r.get("exitCode")==0 and r.get("session_id")==sid and marker in r.get("result","")
    save()
    if not report["checks"]["windowsInitialSucceeded"]:
        print(json.dumps(report["checks"],indent=2));return
    r=run("windows",cwd,["--resume",sid],"What exact acceptance marker did I ask you to remember earlier? Reply with only that marker. Use no tools.")
    report.setdefault("resumed",{})["windows"]=r
    report["checks"]["windowsResumeKeptSessionAndContext"]=r.get("exitCode")==0 and r.get("session_id")==sid and marker in r.get("result","")
    save()
    # Recheck the new Session ID's ownership. Neither foreign lookup runs a
    # model when the expected 'No conversation found' boundary holds.
    for host,foreign in [("wsl",sid),("windows",report["sessionIds"]["wsl"])]:
        r=run(host,report["taskDirectories"][host],["--resume",foreign],"Reply YUZUNO_FOREIGN_SESSION_SHOULD_NOT_OPEN. Use no tools.")
        report.setdefault("foreignResume",{})[host]=r
        report["checks"][host+"CannotResumeForeignProfile"]=r.get("exitCode")!=0 and "No conversation found" in (r.get("nonJsonOutput","")+r.get("stderr",""))
    current={h:status(h) for h in identifiers}
    report["checks"]["officialAccountIdentitiesUnchanged"]=all((current[h].get("email") or current[h].get("accountId"))==identifiers[h] for h in identifiers)
    report["windowsContinuationAt"]=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())
    save();print(json.dumps(report["checks"],indent=2))


def main():
    path=Path("experiments/runtime/claude-session-observations.json")
    report={"createdAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
            "credentialFilesReadOrCopied":False,"configDirectoryEnvironmentChanged":False,"checks":{}}
    original={h:status(h) for h in ["wsl","windows"]}
    identifiers={h:original[h].get("email") or original[h].get("accountId") for h in original}
    report["checks"]["distinctOfficialAccountIdentities"]=bool(all(identifiers.values()) and len(set(identifiers.values()))==2)
    if not report["checks"]["distinctOfficialAccountIdentities"]:
        path.write_text(json.dumps(report,indent=2)+"\n");raise RuntimeError("Two distinct account identities were not confirmed")
    report["accounts"]={h:{"identityLabel":"account-"+str(i+1),"loggedIn":original[h].get("loggedIn"),
                            "authMethod":original[h].get("authMethod"),"subscriptionType":original[h].get("subscriptionType")}
                        for i,h in enumerate(original)}
    roots={"wsl":tempfile.mkdtemp(prefix="yuzuno-next-claude-")}
    win_id=str(uuid.uuid4())
    roots["windows"]=ps("$p=Join-Path $env:LOCALAPPDATA 'Yuzuno\\acceptance\\"+win_id+"'; New-Item -ItemType Directory -Force -Path $p | Out-Null; Write-Output $p").stdout.strip()
    ids={h:str(uuid.uuid4()) for h in roots};markers={h:"YUZUNO_"+h.upper()+"_"+uuid.uuid4().hex[:10] for h in roots}
    report["taskDirectories"]=roots;report["sessionIds"]=ids
    def save():path.write_text(json.dumps(report,indent=2)+"\n")
    save()
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures={h:pool.submit(run,h,roots[h],["--session-id",ids[h]],"Remember this exact acceptance marker for this conversation: "+markers[h]+". Reply with exactly that marker. Use no tools.") for h in roots}
        report["initial"]={h:f.result() for h,f in futures.items()}
    save();print("Initial Claude turns completed",flush=True)
    for h,r in report["initial"].items():
        report["checks"][h+"InitialSucceeded"]=r.get("exitCode")==0 and r.get("session_id")==ids[h] and markers[h] in r.get("result","")
    active=[h for h in roots if report["checks"].get(h+"InitialSucceeded")]
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures={h:pool.submit(run,h,roots[h],["--resume",ids[h]],"What exact acceptance marker did I ask you to remember earlier? Reply with only that marker. Use no tools.") for h in active}
        report["resumed"]={h:f.result() for h,f in futures.items()}
    save()
    for h,r in report["resumed"].items():
        report["checks"][h+"ResumeKeptSessionAndContext"]=r.get("exitCode")==0 and r.get("session_id")==ids[h] and markers[h] in r.get("result","")
    # A foreign native profile should not automatically find the other profile's
    # session. This is storage/launch isolation, not a same-OS-user security claim.
    report["foreignResume"]={}
    for h in roots:
        other="windows" if h=="wsl" else "wsl"
        r=run(h,roots[h],["--resume",ids[other]],"Reply YUZUNO_FOREIGN_SESSION_SHOULD_NOT_OPEN. Use no tools.")
        report["foreignResume"][h]=r
        report["checks"][h+"CannotResumeForeignProfile"]=r.get("exitCode")!=0 and "No conversation found" in (r.get("nonJsonOutput","")+r.get("stderr",""))
    current={h:status(h) for h in roots}
    report["checks"]["officialAccountIdentitiesUnchanged"]=all((current[h].get("email") or current[h].get("accountId"))==identifiers[h] for h in roots)
    save();print(json.dumps(report["checks"],indent=2))


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--finish-windows",action="store_true",help="Continue the saved report only after the user completes official Windows login")
    args=parser.parse_args()
    if args.finish_windows:finish_windows()
    else:main()
