//! YN-194: job_logs reads the lines that matter (tail, grep) instead of a
//! 32 KiB page, and job_list's compact row of a failed Job on this host says
//! the last line it printed.
use super::*;
use crate::model::AgentDetail;

fn setup() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/workspace".into(), "unused".into()).unwrap();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"Mori","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    ws.store.collaboration_call(None, "task_create", json!({"requestId":"task","title":"Builds","status":"doing"})).unwrap();
    (dir, ws)
}
/// A failed local Job whose ring wrapped: the older segment starts at
/// `start`, the newer holds `newer`.
fn failed_with_output(dir: &std::path::Path, ws: &Arc<Workspace>, older: &[u8], newer: &[u8]) -> Value {
    let submit: Submit = serde_json::from_value(json!({"requestId":"j","taskId":"T-1","name":"build","cwd":"/workspace",
        "argv":["/usr/bin/true"],"resources":{"cpuMillis":200,"memoryMiB":64,"swapMiB":0}})).unwrap();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":600,"memoryMiB":192,"swapMiB":0}});
    ws.store.create_job(Some("a"), submit, json!({"cwd":"/workspace","git":null,"files":[]}), machine, json!({"bootId":"boot"})).unwrap();
    let job = ws.store.reserve_next_job(None, None, None).unwrap().unwrap();
    let evidence = json!({"jobId":job["id"],"attempt":job["attempt"],"status":"failed","reason":"exit-code",
        "evidence":{"systemd":{"Result":"exit-code","ExecMainCode":"1","ExecMainStatus":"101"}}});
    assert!(ws.store.update_job_evidence(job["id"].as_str().unwrap(), evidence).unwrap());
    let folder = dir.join("data/jobs").join(job["id"].as_str().unwrap());
    std::fs::create_dir_all(&folder).unwrap();
    let segment = |start: u64, body: &[u8]| [start.to_be_bytes().as_slice(), body].concat();
    std::fs::write(folder.join("log-0.bin"), segment(1000, older)).unwrap();
    std::fs::write(folder.join("log-1.bin"), segment(1000 + older.len() as u64, newer)).unwrap();
    job
}
async fn logs(ws: &Arc<Workspace>, input: Value) -> anyhow::Result<Value> {
    call(ws.clone(), Some("a".into()), "job_logs".into(), input).await
}

/// job_list's lastLine reads only the newest bytes of the ring (review
/// 6c243065): the same bytes as the end of the whole ring, across segments.
#[tokio::test]
async fn the_newest_bytes_are_the_end_of_the_ring_read_alone() {
    let (dir, ws) = setup();
    let (older, newer) = (b"one\ntwo\nthree\n", b"four\nfive");
    let job = failed_with_output(dir.path(), &ws, older, newer);
    let whole = [older.as_slice(), newer.as_slice()].concat();
    for limit in [0u64, 3, 9, 12, 23, 1000] {
        let from = whole.len().saturating_sub(limit as usize);
        assert_eq!(host::newest(&ws.data_dir, &job, limit).await.unwrap(), whole[from..], "limit {limit}");
    }
}

#[tokio::test]
async fn tail_and_grep_read_lines_of_the_whole_ring_with_their_offsets() {
    let (dir, ws) = setup();
    let older = b"Compiling a\nwarning: unused x\ntest one ... ok\n";
    let newer = b"test two ... FAILED\ntest three ... ok\nerror: test failed, to rerun pass `--lib`\n";
    let job = failed_with_output(dir.path(), &ws, older, newer);
    let id = job["id"].clone();
    // A page reads as before.
    let page = logs(&ws, json!({"jobId":id})).await.unwrap();
    assert_eq!(page["oldestOffset"], 1000);
    assert!(page["text"].as_str().unwrap().contains("Compiling a"));
    // tail: the last lines, across both segments, with where each starts.
    let tail = logs(&ws, json!({"jobId":id,"tail":3})).await.unwrap();
    let lines: Vec<&str> = tail["lines"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap()).collect();
    assert_eq!(lines, ["test two ... FAILED", "test three ... ok", "error: test failed, to rerun pass `--lib`"]);
    assert_eq!(tail["lines"][0]["offset"], 1000 + older.len() as u64);
    assert_eq!((tail["linesMatched"].as_u64(), tail["more"].as_bool()), (Some(6), Some(true)));
    assert_eq!(tail["searched"], json!({"fromOffset":1000,"toOffset":1000 + (older.len() + newer.len()) as u64}));
    assert_eq!(tail["truncated"], true, "output before offset 1000 was overwritten");
    // grep: only the lines that contain the text, oldest first.
    let grep = logs(&ws, json!({"jobId":id,"grep":" ... "})).await.unwrap();
    let found: Vec<(u64, &str)> = grep["lines"].as_array().unwrap().iter()
        .map(|l| (l["offset"].as_u64().unwrap(), l["text"].as_str().unwrap())).collect();
    assert_eq!(found.iter().map(|f| f.1).collect::<Vec<_>>(), ["test one ... ok", "test two ... FAILED", "test three ... ok"]);
    assert_eq!(found[0].0, 1000 + b"Compiling a\nwarning: unused x\n".len() as u64);
    assert_eq!(grep["more"], false);
    let last = logs(&ws, json!({"jobId":id,"grep":"FAILED","tail":1})).await.unwrap();
    assert_eq!(last["lines"], json!([{"offset":1000 + older.len() as u64,"text":"test two ... FAILED"}]));
    assert_eq!(logs(&ws, json!({"jobId":id,"grep":"no such text"})).await.unwrap()["lines"], json!([]));
    // What they cannot be combined with or take.
    for (input, words) in [
        (json!({"jobId":id,"tail":2,"offset":0}), "omit offset"),
        (json!({"jobId":id,"tail":0}), "tail must be 1–1000"),
        (json!({"jobId":id,"tail":1001}), "tail must be 1–1000"),
        (json!({"jobId":id,"grep":""}), "grep must contain 1–200"),
        (json!({"jobId":id,"grep":"x".repeat(201)}), "grep must contain 1–200"),
    ] {
        let error = logs(&ws, input).await.unwrap_err().to_string();
        assert!(error.contains(words), "{words}: {error}");
    }
    // job_list's compact row says the last line it printed.
    let list = call(ws.clone(), Some("a".into()), "job_list".into(), json!({})).await.unwrap();
    assert_eq!(list["jobs"][0]["lastLine"], "error: test failed, to rerun pass `--lib`");
    // The GUI's list is as it was.
    let gui = call(ws.clone(), None, "job_list".into(), json!({})).await.unwrap();
    assert!(gui["jobs"][0].get("lastLine").is_none());
}

#[test]
fn long_lines_and_many_matches_stay_bounded_newest_kept() {
    let mut bytes = Vec::new();
    for n in 0..300 {
        bytes.extend_from_slice(format!("line {n}\n").as_bytes());
    }
    bytes.extend_from_slice(&[b'y'; 900]);
    let answer = log_lines(&bytes, 0, None, None);
    let lines = answer["lines"].as_array().unwrap();
    assert_eq!(lines.len(), LOG_LINES);
    assert_eq!(lines[0]["text"], "line 101", "the newest are kept");
    assert_eq!(lines[LOG_LINES - 1]["text"].as_str().unwrap().chars().count(), LOG_LINE_CHARS + 1, "cut with …");
    assert_eq!((answer["linesMatched"].as_u64(), answer["more"].as_bool()), (Some(301), Some(true)));
    // Bytes bound too: each line near its cap, so fewer than 200 fit.
    let wide: Vec<u8> = (0..100).flat_map(|_| [vec![b'z'; 499], vec![b'\n']].concat()).collect();
    let answer = log_lines(&wide, 0, None, None);
    let total: usize = answer["lines"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap().len() + 1).sum();
    assert!(total <= LOG_BYTES && answer["more"] == true, "{total}");
    // A last line not ended by a newline is a line; an empty tail after one is not.
    assert_eq!(log_lines(b"a\nb", 5, None, Some(5))["lines"], json!([{"offset":5,"text":"a"},{"offset":7,"text":"b"}]));
    assert_eq!(log_lines(b"a\n", 0, None, None)["lines"], json!([{"offset":0,"text":"a"}]));
    assert_eq!(list::last_line("ok\n\n  last words  \n\n").as_deref(), Some("last words"));
    assert_eq!(list::last_line("\n \n"), None);
    assert_eq!(list::last_line(&"界".repeat(300)).unwrap().chars().count(), 201);
}
