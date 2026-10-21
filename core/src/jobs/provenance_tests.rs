//! T-168: a provenance export restates what was recorded, attempt by attempt,
//! states how each item is known, and lets nothing outside its list leave.
use super::provenance::{self, Known, Scope};
use super::*;
use crate::{model::AgentDetail, store::Store};
use std::path::Path;

const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const SHA_D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const SHA_E: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CLEAN: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

fn known() -> Known {
    Known::host(Path::new("/srv/core-data"), Some("/home/someone".into()))
}

/// A finished local attempt as Core stores it, with secrets in what must not leave.
fn local_job() -> Value {
    let id = "11111111-1111-4111-8111-111111111111";
    json!({"id":id,"attempt":"a1","name":"train model","taskRef":"T-7",
        "argv":["python3","train.py","--token=SECRET-ARG"],"env":{"API_KEY":"SECRET-ENV","PATH":"/usr/bin"},
        "cwd":"/home/someone/work/exp","guardGit":true,"timeoutSeconds":3600,
        "requestedBy":{"kind":"agent","id":"a","name":"Mori"},"source":{"agentId":"a","turnId":"turn-1","sessionId":"SECRET-SESSION"},
        "machine":{"id":"local-abc","name":"lab-host","bootId":"boot"},
        "target":{"requested":null,"kind":"local","machineId":"local","machineName":"lab-host"},
        "capabilities":{"available":true,"version":"systemd 255","controllers":["cpu","memory","pids"],"python":"3.12.3"},
        "resources":{"cpuMillis":2000,"memoryMiB":512,"swapMiB":0},
        "gpu":{"count":1,"memoryMiB":4096,"mode":"exclusive","devices":["GPU-SECRET-UUID"]},
        "snapshot":{"cwd":"/home/someone/work/exp",
            "git":{"root":"/home/someone/work","head":"0123456789abcdef0123456789abcdef01234567","statusSha256":CLEAN},
            "files":[{"path":"/home/someone/work/exp/config.yaml","sha256":SHA_A},
                {"path":"/home/someone/work/lib/util.py","sha256":SHA_B},
                {"path":"/etc/private/key.txt","sha256":SHA_A},
                {"path":"/home/someone/work/exp/../../outside.txt","sha256":SHA_B},
                {"path":"/home/someone/work/exp/absent.txt","sha256":null}],
            "scope":"Frozen argv/env/resources"},
        "identity":{"version":1,"sha256":SHA_C,"specSha256":SHA_D,"parts":{"command":SHA_E,"code":CLEAN},"codeKnown":true},
        "artifacts":[{"path":"out.json","format":"json"}],
        "status":"succeeded","reason":"Exit 0; wrote /home/someone/work/exp/out.json.",
        "createdAt":"2026-10-21T01:00:00Z","startedAt":"2026-10-21T01:00:05Z","finishedAt":"2026-10-21T01:10:00Z",
        "result":{"jobId":id,"attempt":"a1","status":"succeeded",
            "started":{"at":1.0,"controlGroup":"/user.slice/SECRET-CGROUP","limits":{"memory.max":"536870912"}},
            "evidence":{"systemd":{"Result":"success","ExecMainCode":"1","ExecMainStatus":"0"}},
            "artifacts":[{"path":"out.json","format":"json","minBytes":1,"ok":true,"absolutePath":"/home/someone/work/exp/out.json",
                "bytes":12,"mtimeNs":7,"sha256":SHA_A}],
            "cost":{"knownUsd":0.5,"unknownEntries":0,"invalidLines":0,"incompleteLines":0,"truncated":false,"complete":true,
                "sources":["SECRET-SOURCE"]}}})
}

fn export(jobs: &[Value], extents: Vec<Result<Value, String>>) -> (Value, String) {
    let value = provenance::export(None, jobs, &extents, known());
    (value["manifest"].clone(), value["report"].as_str().unwrap().to_owned())
}

fn assert_absent(manifest: &Value, report: &str, needles: &[&str]) {
    let text = manifest.to_string();
    for needle in needles {
        assert!(!text.contains(needle), "{needle} in manifest: {text}");
        assert!(!report.contains(needle), "{needle} in report: {report}");
    }
}

#[test]
fn a_completed_job_exports_its_recorded_evidence_and_nothing_outside_the_list() {
    let extent = json!({"segments":2,"oldestOffset":1_048_576,"totalBytes":3_145_728,"truncated":true});
    let (m, report) = export(&[local_job()], vec![Ok(extent)]);
    assert_eq!((m["schema"].as_str(), m["version"].as_u64()), (Some("yuzuno.provenance"), Some(1)));
    assert_eq!(m["scope"], json!({"kind":"job","id":"11111111-1111-4111-8111-111111111111","taskRef":"T-7","attempts":1}));
    assert!(m["basis"].as_str().unwrap().contains("Nothing was read or hashed again"));
    let a = &m["attempts"][0];
    assert_eq!(a["exit"], json!({"code":0,"signal":null,"systemdResult":"success","state":"verified","by":"systemd"}));
    assert_eq!(a["target"]["kind"], "local");
    assert_eq!(a["target"]["coreHost"], true);
    assert_eq!(a["code"]["git"]["trackedChanges"], "none");
    assert_eq!(a["code"]["state"], "verified");
    // Inputs inside cwd or the Git root keep a relative path; the rest only a digest.
    let files = a["inputs"]["files"].as_array().unwrap();
    assert_eq!(files[0], json!({"path":"config.yaml","base":"cwd","sha256":SHA_A,"state":"verified"}));
    assert_eq!(files[1], json!({"path":"lib/util.py","base":"gitRoot","sha256":SHA_B,"state":"verified"}));
    assert!(files[2]["path"].is_null() && files[3]["path"].is_null());
    assert_eq!(files[4], json!({"path":"absent.txt","base":"cwd","state":"notRecorded","missingAtSubmit":true}));
    assert_eq!(a["inputs"]["withheld"], 2);
    let artifact = &a["artifacts"]["files"][0];
    assert_eq!((artifact["path"].as_str(), artifact["sha256"].as_str(), artifact["state"].as_str()), (Some("out.json"), Some(SHA_A), Some("verified")));
    assert_eq!(artifact["fetch"]["available"], true);
    assert!(artifact.get("absolutePath").is_none() && artifact.get("mtimeNs").is_none());
    assert_eq!(a["command"]["argv"], json!({"exported":false,"count":3}));
    assert_eq!(a["command"]["env"], json!({"exported":false,"count":2}));
    assert_eq!(a["resources"]["gpu"], json!({"count":1,"memoryMiB":4096,"mode":"exclusive"}));
    assert_eq!(a["resources"]["held"]["state"], "verified");
    assert_eq!(a["cost"]["state"], "declared");
    assert_eq!(a["logs"]["truncated"], true);
    assert_eq!(a["reason"], "Exit 0; wrote <cwd>/out.json.");
    // Digests over the command or withheld paths leave only as labels.
    assert_eq!(a["identity"], json!({"command":"C1","code":"S1","attempt":"I1","codeKnown":true,"version":1}));
    assert_absent(&m, &report, &["SECRET", "/home/someone", "/etc/private", "outside.txt", "controlGroup", SHA_C, SHA_D, SHA_E]);
    for line in ["# Provenance of job train model", "- Ran on this Core's host lab-host (machine local-abc)",
        "exit code 0 (verified, by systemd)", "- Inputs: 5 files frozen by SHA-256; 2 paths withheld",
        "  - Git root/lib/util.py: `bbbb", "  - absent.txt: missing at submission",
        "- Command: not exported (3 arguments, 2 environment variables); command C1, code S1, identity I1",
        "Labels such as C1, S1 and I1 stand for",
        "  - out.json: 12 bytes, SHA-256 `aaaa", "the first 1.0 MiB were overwritten"] {
        assert!(report.contains(line), "{line} missing from:\n{report}");
    }
}

#[test]
fn reasons_lose_known_paths_at_their_boundaries_only() {
    let mut job = local_job();
    job["reason"] = json!("Missing /home/someone/work/exp. See /home/someone/work/exp2/x and /srv/core-data/jobs.");
    let (m, _) = export(&[job], vec![Ok(json!({"segments":0}))]);
    assert_eq!(m["attempts"][0]["reason"], "Missing <cwd>. See <git root>/exp2/x and <Core data folder>/jobs.");
    assert_eq!(m["attempts"][0]["logs"]["state"], "notRecorded");
}

#[test]
fn untrusted_names_and_paths_are_inert_in_the_report() {
    let mut job = local_job();
    job["name"] = json!("x\n# injected <img src=x onerror=alert(1)> [link](http://e) `code`");
    job["result"]["artifacts"][0]["path"] = json!("../escape.json");
    job["result"]["artifacts"].as_array_mut().unwrap().push(json!({"path":"a|b_c.json","ok":false,"problem":"missing","format":"bytes"}));
    let (m, report) = export(&[job], vec![Err("permission denied".into())]);
    assert!(m["attempts"][0]["artifacts"]["files"][0]["path"].is_null());
    assert!(!report.lines().any(|l| l.starts_with("# injected")), "{report}");
    assert!(report.contains("\\<img src=x onerror=alert(1)\\> \\[link\\](http://e) \\`code\\`"), "{report}");
    assert!(report.contains("  - (path withheld): 12 bytes"));
    assert!(report.contains("  - a\\|b\\_c.json: failed its check: missing"), "{report}");
    assert_eq!(m["attempts"][0]["logs"]["state"], "unknown");
}

/// A remote attempt as stored after its machine stopped answering.
fn remote_job(id: &str, status: &str) -> Value {
    json!({"id":id,"attempt":"r1","name":"remote eval","taskRef":"T-7","argv":["./eval"],"env":{},
        "cwd":"/data/someone/work","requestedBy":{"kind":"user","id":"user","name":"You"},
        "machine":{"id":"m1","name":"lab box"},"executor":{"kind":"ssh","machineId":"m1","machineName":"lab box"},
        "target":{"requested":"m1","kind":"ssh","machineId":"m1","machineName":"lab box"},"remote":{"hostId":"f00dfeed00112233"},
        "capabilities":{"executor":"ssh","platform":"Linux","pause":"unavailable"},
        "resources":{"cpuMillis":1000,"memoryMiB":256,"swapMiB":0},
        "snapshot":{"cwd":"/data/someone/work","remote":true,"hostId":"f00dfeed00112233","frozenOn":{"kind":"ssh"},
            "files":[{"path":"in.csv","absolutePath":"/data/someone/work/in.csv","sha256":SHA_A},
                {"path":"/mnt/shared/big.bin","absolutePath":"/mnt/shared/big.bin","sha256":SHA_B}],"scope":"Inputs are files on lab box"},
        "artifacts":[{"path":"metrics.json","format":"json"}],
        "status":status,"reason":"lab box did not answer; this attempt's state there is unknown",
        "createdAt":"2026-10-21T01:00:00Z","startedAt":null,"finishedAt":null,
        "result":{"jobId":id,"attempt":"r1","status":status,"evidence":{"status":"unreachable"}}})
}

#[test]
fn an_offline_remote_job_exports_what_was_stored_and_says_what_stays_there() {
    let mut done = remote_job("22222222-2222-4222-8222-222222222222", "succeeded");
    done["result"] = json!({"jobId":done["id"],"attempt":"r1","status":"succeeded","evidence":{"result":{"exitCode":0,"signal":null}},
        "started":{"at":1.0,"pgid":42,"limits":{"memory":"declared"}},
        "artifacts":[{"path":"metrics.json","format":"json","ok":true,"bytes":20,"sha256":SHA_B,"absolutePath":"/data/someone/work/metrics.json"}],
        "artifactsOn":{"machineId":"m1","name":"lab box","hostId":"f00dfeed00112233"}});
    let lost = remote_job("33333333-3333-4333-8333-333333333333", "unknown");
    let (m, report) = export(std::slice::from_ref(&lost), vec![Ok(Value::Null)]);
    let a = &m["attempts"][0];
    assert_eq!((a["target"]["kind"].as_str(), a["target"]["coreHost"].as_bool()), (Some("ssh"), Some(false)));
    assert_eq!(a["exit"], json!({"state":"unknown"}));
    assert_eq!(a["logs"]["state"], "unknown");
    assert_eq!(a["code"]["state"], "notRecorded");
    assert_eq!(a["inputs"]["files"][0]["path"], "in.csv");
    assert_eq!(a["inputs"]["withheld"], 1);
    assert_eq!(a["artifacts"]["files"][0], json!({"path":"metrics.json","format":"json","minBytes":null,"state":"declared"}));
    assert_eq!(a["resources"]["measured"]["state"], "notRecorded");
    assert!(report.contains("- Ran on SSH machine lab box (m1, host `f00dfeed0011`)"), "{report}");
    assert_absent(&m, &report, &["/data/someone", "/mnt/shared"]);

    let (m, report) = export(&[done], vec![Ok(Value::Null)]);
    let a = &m["attempts"][0];
    assert_eq!(a["exit"]["code"], 0);
    let artifact = &a["artifacts"]["files"][0];
    assert_eq!((artifact["state"].as_str(), artifact["fetch"]["available"].as_bool()), (Some("verified"), Some(false)));
    assert!(artifact["fetch"]["reason"].as_str().unwrap().contains("stays on lab box"));
    assert_eq!(a["artifacts"]["on"]["hostId"], "f00dfeed00112233");
    assert!(report.contains("  - metrics.json: 20 bytes, SHA-256 `bbbb"), "{report}");
    assert_absent(&m, &report, &["/data/someone"]);
}

fn setup() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/workspace".into(), "unused".into()).unwrap();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"Mori","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    ws.store.collaboration_call(None, "task_create", json!({"requestId":"task","title":"Research outcome","status":"doing"})).unwrap();
    (dir, ws)
}

fn finish(s: &Store, job: &Value, status: &str, code: &str, artifacts: Value) {
    let mut evidence = json!({"jobId":job["id"],"attempt":job["attempt"],"status":status,"reason":format!("Exit {code}"),
        "evidence":{"systemd":{"Result":if code == "0" { "success" } else { "exit-code" },"ExecMainCode":"1","ExecMainStatus":code}}});
    if !artifacts.is_null() {
        evidence["artifacts"] = artifacts;
    }
    assert!(s.update_job_evidence(job["id"].as_str().unwrap(), evidence).unwrap());
}

#[test]
fn a_failed_attempt_and_its_retry_export_separately_and_neither_is_overwritten() {
    let (_dir, ws) = setup();
    let s = &ws.store;
    let input: runs::RunSubmit = serde_json::from_value(json!({"requestId":"run","taskId":"T-1","name":"Fixture run",
        "stages":[{"key":"train","cwd":"/workspace","argv":["/usr/bin/true","SECRET-ARG"],"env":{"TOKEN":"SECRET-ENV"},
            "resources":{"cpuMillis":200,"memoryMiB":64,"swapMiB":0},"retry":{"attempts":2,"exitCodes":[75]},
            "artifacts":[{"path":"model.json","format":"json"}]}]})).unwrap();
    let prepared = input.stages.iter().map(|stage| {
        let submit = input.submit(stage);
        let snapshot = json!({"cwd":"/workspace","git":{"root":"/workspace","head":"abc","statusSha256":SHA_A},"files":[]});
        let identity = runs::spec_identity(&submit, &snapshot, stage.needs());
        runs::Prepared { submit, snapshot, identity, reuse: None, guard_exclude: vec![] }
    }).collect();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":600,"memoryMiB":192,"swapMiB":0}});
    let run = s.create_run(Some("a"), input, prepared, machine, json!({"bootId":"boot"})).unwrap();
    let run_id = run["id"].as_str().unwrap().to_owned();
    let first = s.reserve_next_job(None, None, None).unwrap().unwrap();
    finish(s, &first, "failed", "75", Value::Null);
    let second = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(second["retryOf"], first["id"]);
    finish(s, &second, "succeeded", "0", json!([{"path":"model.json","format":"json","minBytes":1,"ok":true,
        "absolutePath":"/workspace/model.json","bytes":12,"mtimeNs":1,"sha256":SHA_B}]));

    let (view, jobs) = s.provenance_records(&Scope::Run(run_id.clone())).unwrap();
    let extents = jobs.iter().map(|_| Ok(json!({"segments":0}))).collect::<Vec<_>>();
    let value = provenance::export(view.as_ref(), &jobs, &extents, known());
    let (m, report) = (&value["manifest"], value["report"].as_str().unwrap());
    assert_eq!(m["scope"]["kind"], "run");
    assert_eq!(m["scope"]["attempts"], 2);
    assert_eq!(m["run"]["stages"][0]["attempts"], json!([first["id"], second["id"]]));
    let (old, new) = (&m["attempts"][0], &m["attempts"][1]);
    assert_eq!((old["status"].as_str(), old["exit"]["code"].as_i64()), (Some("failed"), Some(75)));
    assert_eq!(old["retriedBy"], second["id"]);
    assert_eq!(old["artifacts"]["files"][0]["state"], "declared");
    assert_eq!((new["status"].as_str(), new["exit"]["code"].as_i64()), (Some("succeeded"), Some(0)));
    assert_eq!(new["retryOf"], first["id"]);
    assert_eq!(new["run"]["attempt"], 2);
    assert_eq!(new["artifacts"]["files"][0]["sha256"], SHA_B);
    assert_eq!(new["code"]["git"]["trackedChanges"], "present: their files are among the inputs");
    // A retry repeats its command: the same label, never the digest.
    assert_eq!((old["identity"]["command"].as_str(), new["identity"]["command"].as_str()), (Some("C1"), Some("C1")));
    assert!(!m.to_string().contains(jobs[0]["identity"]["parts"]["command"].as_str().unwrap()));
    assert!(report.contains("## Stage train attempt 1: failed"), "{report}");
    assert!(report.contains("## Stage train attempt 2: succeeded"), "{report}");
    assert!(report.contains("- Stage train: succeeded, 2 attempts"), "{report}");
    assert_absent(m, report, &["SECRET"]);

    // The first attempt alone still says what it was.
    let (none, alone) = s.provenance_records(&Scope::Job(first["id"].as_str().unwrap().into())).unwrap();
    assert!(none.is_none());
    let value = provenance::export(None, &alone, &[Ok(json!({"segments":0}))], known());
    assert_eq!(value["manifest"]["attempts"][0]["status"], "failed");
    assert_eq!(value["manifest"]["attempts"][0]["run"]["id"], run_id.as_str());
}

#[tokio::test]
async fn the_tool_reads_only_log_headers_and_takes_one_scope() {
    let (dir, ws) = setup();
    let submit: Submit = serde_json::from_value(json!({"requestId":"j","taskId":"T-1","name":"local","cwd":"/workspace",
        "argv":["/usr/bin/true"],"resources":{"cpuMillis":200,"memoryMiB":64,"swapMiB":0}})).unwrap();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":600,"memoryMiB":192,"swapMiB":0}});
    ws.store.create_job(Some("a"), submit, json!({"cwd":"/workspace","git":null,"files":[]}), machine, json!({"bootId":"boot"})).unwrap();
    let job = ws.store.reserve_next_job(None, None, None).unwrap().unwrap();
    finish(&ws.store, &job, "succeeded", "0", json!([]));
    // A ring that wrapped: its older segment now starts at 2 MiB, after 3 MiB written.
    let folder = dir.path().join("data/jobs").join(job["id"].as_str().unwrap());
    std::fs::create_dir_all(&folder).unwrap();
    let segment = |start: u64, body: &[u8]| [start.to_be_bytes().as_slice(), body].concat();
    std::fs::write(folder.join("log-0.bin"), segment(2 * 1024 * 1024, &vec![b'x'; 1024 * 1024])).unwrap();
    std::fs::write(folder.join("log-1.bin"), segment(3 * 1024 * 1024, b"SECRET-OUTPUT")).unwrap();
    let value = call(ws.clone(), Some("a".into()), "job_provenance".into(), json!({"jobId":job["id"]})).await.unwrap();
    let logs = &value["manifest"]["attempts"][0]["logs"];
    assert_eq!(logs, &json!({"exported":false,"state":"verified","retainedBytesLimit":2_097_152u64,
        "totalBytes":3 * 1024 * 1024 + 13,"oldestOffset":2 * 1024 * 1024,"truncated":true}));
    assert!(!value.to_string().contains("SECRET-OUTPUT"));
    for bad in [json!({}), json!({"jobId":job["id"],"runId":"r"})] {
        let error = call(ws.clone(), Some("a".into()), "job_provenance".into(), bad).await.unwrap_err();
        assert!(error.to_string().contains("exactly one of jobId or runId"), "{error}");
    }
    assert!(tool_definitions().iter().any(|t| t["name"] == "job_provenance"));
}
