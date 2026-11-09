use super::*;

fn arguments(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

#[test]
fn an_agents_task_get_reads_the_current_view_unless_it_pages_names_a_view_or_reads_materials() {
    let mut plain = arguments(json!({"taskId":"T-1"}));
    assert_eq!(prepare("task_get", &mut plain), Ok(None));
    assert_eq!(plain["view"], "current");
    let mut paged = arguments(json!({"taskId":"T-1","afterSeq":4}));
    prepare("task_get", &mut paged).unwrap();
    assert_eq!(paged["view"], "activity");
    let mut named = arguments(json!({"taskId":"T-1","view":"full"}));
    prepare("task_get", &mut named).unwrap();
    assert_eq!(named["view"], "full");
    let mut fixed = arguments(json!({"taskId":"T-1","dispatchId":"d"}));
    prepare("task_get", &mut fixed).unwrap();
    assert!(!fixed.contains_key("view"), "fixed materials take no view");
}

#[test]
fn review_get_takes_its_view_out_before_the_review_store_sees_it() {
    let mut plain = arguments(json!({"taskId":"T-1","reviewId":"r"}));
    assert_eq!(prepare("review_get", &mut plain), Ok(Some("summary".into())));
    let mut full = arguments(json!({"taskId":"T-1","reviewId":"r","view":"full"}));
    assert_eq!(prepare("review_get", &mut full), Ok(Some("full".into())));
    assert!(!full.contains_key("view"));
    let mut wrong = arguments(json!({"taskId":"T-1","reviewId":"r","view":"raw"}));
    assert!(prepare("review_get", &mut wrong).is_err());
}

fn task() -> Value {
    json!({"id":"T-7","seq":7,"title":"Ship it","description":"long ".repeat(400),"status":"review","version":5,
        "progress":"p".repeat(3000),"blocker":"","materials":{"acceptance":"a".repeat(2000)},
        "assignee":{"kind":"agent","id":"a","name":"Dev"},"dispatch":{"id":"d1","active":true,"executor":{"id":"a"}},
        "result":{"id":"r1","dispatchId":"d1","summary":"s".repeat(2000),"notification":{"state":"pending","messageId":"m"}},
        "github":[{"snapshot":{"title":"x".repeat(500)}}],"updatedAt":"now","createdBy":{"kind":"user"}})
}

/// Every value of `short` is at the same path in `full`: fields are left out,
/// never moved or renamed.
fn is_part_of(short: &Value, full: &Value, path: &str) {
    match short {
        Value::Object(map) => {
            for (key, value) in map {
                is_part_of(value, &full[key], &format!("{path}.{key}"));
            }
        }
        _ => assert_eq!(short, full, "{path}"),
    }
}

#[test]
fn a_task_writes_receipt_is_its_identity_version_and_the_activity_it_recorded() {
    let full = json!({"task":task(),"activity":{"seq":41,"kind":"comment","at":"now","body":"b".repeat(5000),
        "actor":{"id":"a"},"source":{"agentId":"a"}}});
    let short = answer("task_comment", full.clone(), None);
    assert_eq!(short["task"], json!({"id":"T-7","title":"Ship it","status":"review","version":5,"updatedAt":"now",
        "assignee":{"kind":"agent","id":"a","name":"Dev"},"dispatch":{"id":"d1","active":true}}));
    assert_eq!(short["activity"], json!({"seq":41,"kind":"comment","at":"now"}));
    assert!(short["task"].get("result").is_none(), "only a result write answers with its result");
    assert!(short.to_string().len() < full.to_string().len() / 20, "{}", short);
    let mut without_more = short.clone();
    without_more.as_object_mut().unwrap().remove("more");
    is_part_of(&without_more, &full, "");

    let submitted = json!({"task":task(),"activity":{"seq":42,"kind":"result","at":"now"},
        "message":{"id":"m","seq":9,"dispatchId":"d1","recipient":{"kind":"agent","id":"l","name":"Lead"},
            "delivery":{"state":"pending","attempts":[]},"body":"x".repeat(3000)},"homeHint":"Home: a report."});
    let result = answer("task_submit_result", submitted.clone(), None);
    assert_eq!(result["homeHint"], "Home: a report.", "a content editor's advice survives the short receipt");
    assert_eq!(result["task"]["result"], json!({"id":"r1","dispatchId":"d1","notification":{"state":"pending","messageId":"m"}}));
    assert_eq!(result["message"], json!({"id":"m","seq":9,"dispatchId":"d1","recipient":{"kind":"agent","id":"l","name":"Lead"},
        "delivery":{"state":"pending"}}));
    let mut without_more = result.clone();
    without_more.as_object_mut().unwrap().remove("more");
    is_part_of(&without_more, &submitted, "");

    let created = answer("task_create", json!({"task":task(),"activity":{"seq":1,"kind":"created","at":"now"},
        "projectNotice":"Joined your project"}), None);
    assert_eq!(created["projectNotice"], "Joined your project");
    // Reads and other tools pass through untouched.
    let read = json!({"current":{"taskId":"T-7"}});
    assert_eq!(answer("task_get", read.clone(), None), read);
    assert_eq!(answer("peer_send", full.clone(), None), full);
}

fn review() -> Value {
    let reads = vec![json!({"tool":"source_read"}); 40];
    let files = vec![json!({"path":"x.rs"}); 16];
    let covered = vec![json!({"path":"x.rs"}); 15];
    json!({"id":"r","reviewId":"r","status":"completed","round":2,"conclusion":"approved_with_notes","baseSha":"a","headSha":"b",
        "actualHarness":"codex","actualModel":"model",
        "findings":[{"priority":3,"title":"t","body":"b".repeat(400),"path":"x.rs"}],"explanation":"fine",
        "rawReport":"r".repeat(20000),"contextReads":reads,"files":files,
        "provenance":{"cli":{}},"requestedBy":{"kind":"agent","name":"Dev"},
        "coverage":{"fileCount":16,"coveredFileCount":15,"coveredFiles":covered,"uninspected":[],"failedRequests":[],
            "unresolvedRequests":0,"terminalLimit":null},
        "scope":{"counts":{"covered":15,"unsupported":1},"policy":{"state":"absent"},
            "paths":[{"path":"x.rs","state":"covered","facts":[]},{"path":"bin.exe","state":"unsupported","status":"added","facts":[{"reason":"binary"}]}]}})
}

#[test]
fn a_reviews_summary_keeps_its_findings_counts_and_uncovered_paths_and_drops_the_raw_evidence() {
    let summary = answer("review_get", review(), Some("summary"));
    for gone in ["rawReport", "contextReads", "files", "provenance"] {
        assert!(summary.get(gone).is_none(), "{gone}");
    }
    assert_eq!(summary["findings"], review()["findings"]);
    assert_eq!(summary["requestedBy"], "Dev");
    assert_eq!(summary["coverage"]["coveredFileCount"], 15);
    assert!(summary["coverage"].get("coveredFiles").is_none());
    assert_eq!(summary["scope"]["counts"], review()["scope"]["counts"]);
    assert_eq!(summary["scope"]["notCovered"], json!([{"path":"bin.exe","state":"unsupported","status":"added","facts":[{"reason":"binary"}]}]));
    assert!(summary["more"].as_str().unwrap().contains("view \"full\""));
    assert_eq!(summary["reviewerStarted"], true);
    let mut unprepared = review();
    unprepared["status"] = json!("failed");
    unprepared["actualHarness"] = Value::Null;
    unprepared["error"] = json!("The fixed base is not the PR's base; no reviewer ran");
    let summary = answer("review_get", unprepared, Some("summary"));
    assert_eq!((summary["reviewerStarted"].clone(), summary["round"].clone()), (json!(false), json!(2)));
    assert_eq!(answer("review_get", review(), Some("full")), review(), "the full view is the record as stored");
}

/// An incremental round as the review store keeps it (incremental.rs
/// conclude): an earlier finding still valid, one it settled, one of its own.
fn incremental_review() -> Value {
    let carried = json!({"priority":2,"title":"still open","body":"b","path":"a.rs","origin":{"reviewId":"r1","carried":true},
        "disposition":{"state":"still_valid","reason":"a.rs did not change since that head"}});
    let own = json!({"priority":3,"title":"new","body":"b","path":"c.rs","origin":{"reviewId":"r2","carried":false}});
    let settled = json!({"priority":2,"title":"fixed","body":"b","path":"b.rs","origin":{"reviewId":"r1","carried":true},
        "settlement":{"state":"fixed","fixPaths":["b.rs"],"explanation":"the check now runs first","settledBy":"r2"}});
    let mut value = review();
    value["id"] = json!("r2");
    value["reviewId"] = json!("r2");
    value["kind"] = json!("incremental");
    value["previousReviewId"] = json!("r1");
    value["conclusion"] = json!("changes_requested");
    value["findings"] = json!([carried, own]);
    value["settledFindings"] = json!([settled]);
    value["incremental"] = json!({"previousReviewId":"r1","previousRound":1,"previousBaseSha":"a","previousHeadSha":"h1",
        "previousMergeBaseSha":"a","previousConclusion":"changes_requested","previousExplanation":"e".repeat(3000),
        "previousFindings":[{"title":"still open"},{"title":"fixed"}],"previousLedger":{"calls":40},
        "targets":[{"path":"b.rs","changedSinceEarlierHead":true}],"leftThePr":[]});
    value
}

#[test]
fn an_incremental_rounds_summary_keeps_its_earlier_round_and_what_it_settled() {
    let summary = answer("review_get", incremental_review(), Some("summary"));
    assert_eq!((summary["kind"].clone(), summary["previousReviewId"].clone()), (json!("incremental"), json!("r1")));
    // Findings whole, the earlier round's with their origin: an open one is never shown as passed.
    assert_eq!(summary["findings"], incremental_review()["findings"]);
    assert_eq!(summary["findings"][0]["origin"], json!({"reviewId":"r1","carried":true}));
    assert_eq!(summary["conclusion"], "changes_requested");
    assert_eq!(summary["settledFindings"], incremental_review()["settledFindings"]);
    assert_eq!(summary["settledFindings"][0]["settlement"]["fixPaths"], json!(["b.rs"]));
    assert_eq!(summary["incremental"], json!({"previousReviewId":"r1","previousRound":1,"previousBaseSha":"a",
        "previousHeadSha":"h1","previousMergeBaseSha":"a","previousConclusion":"changes_requested"}));
    for gone in ["rawReport", "contextReads"] {
        assert!(summary.get(gone).is_none(), "{gone}");
    }
    assert_eq!(answer("review_get", incremental_review(), Some("full")), incremental_review(), "full is the record as stored");
    // A review that is not part of a chain gains nothing.
    let plain = answer("review_get", review(), Some("summary"));
    for absent in ["kind", "previousReviewId", "parentReviewId", "settledFindings", "incremental"] {
        assert!(plain.get(absent).is_none(), "{absent}");
    }
}

#[test]
fn merge_get_and_merge_list_take_their_view_out_and_an_agents_page_is_twenty() {
    let mut plain = arguments(json!({"taskId":"T-1"}));
    assert_eq!(prepare("merge_get", &mut plain), Ok(Some("summary".into())));
    let mut full = arguments(json!({"entryId":"e","view":"full"}));
    assert_eq!(prepare("merge_get", &mut full), Ok(Some("full".into())));
    assert!(!full.contains_key("view"), "the merge store knows no views");
    assert!(prepare("merge_get", &mut arguments(json!({"entryId":"e","view":"raw"}))).is_err());
    let mut list = arguments(json!({"state":"done"}));
    assert_eq!(prepare("merge_list", &mut list), Ok(Some("summary".into())));
    assert_eq!(list["limit"], 20, "an Agent's page is 20 unless it asks for more");
    let mut fifty = arguments(json!({"limit":50,"view":"full"}));
    assert_eq!(prepare("merge_list", &mut fifty), Ok(Some("full".into())));
    assert_eq!((fifty["limit"].clone(), fifty.contains_key("view")), (json!(50), false));
}

/// A merge entry as the queue keeps it once it merged and followed main CI:
/// its evidence repeats the entry and the last check (lastEvidence), and its
/// history is long.
fn merge_entry() -> Value {
    let sha = |c: char| c.to_string().repeat(40);
    let gate = json!({"kind":"slot","tree":sha('5'),"runs":[{"run":42,"jobs":[{"name":"Core","checkout":sha('4'),"logSha256":"9".repeat(64)}]}]});
    let main = json!({"atRelease":sha('2'),"anchoredAt":"t0","before":sha('2'),"beforeTree":sha('6'),"ci":{"conclusion":"success"}});
    let merge = json!({"sha":sha('f'),"mergedAt":"t3","attempts":1,"expectedMain":sha('2'),"mainCi":{"conclusion":"success","runId":95},
        "post":{"ok":true,"commit":{"parents":[sha('2'),sha('1')]}}});
    let release = json!({"by":{"kind":"agent","id":"lead","name":"Lead"},"requestId":"r1","at":"t0","reviewId":"rv"});
    let last = json!({"checkedAt":"t2","review":{"id":"rv","conclusion":"no_findings"},"pauseCleared":false,"main":main,"policy":"strict",
        "mainRed":false,"ciRunning":false,"gate":gate,"mergeRef":sha('4'),"batch":null,"wouldMerge":{"sha":sha('1'),"method":"merge"}});
    json!({"id":"e1","entryId":"e1","taskId":"t","taskReference":"YN-1","repositoryId":7,"repository":"owner/repo","number":11,
        "url":"https://github.com/owner/repo/pull/11","linkId":"7:pull:11","headSha":sha('1'),"baseBranch":"main","state":"done",
        "reason":null,"detail":"main CI on the merge commit is green","release":release,"merge":merge,"batch":null,"binaries":null,
        "grouping":{"state":"done"},"lastEvidence":last,
        "evidence":{"entry":"e1","repository":"owner/repo","pr":11,"head":sha('1'),"state":"merged","release":release,"binaries":null,
            "review":last["review"],"main":main,"gate":gate,"mergeRef":sha('4'),"policy":"strict","checkedAt":"t2","batch":null,
            "merge":merge,"grouping":{"state":"pending"},"stop":null},
        "history":(0..30).map(|n| json!({"at":format!("t{n}"),"state":"waiting","detail":format!("check {n}")})).collect::<Vec<_>>(),
        "createdAt":"t0","updatedAt":"t3"})
}

#[test]
fn a_merge_entrys_summary_says_its_state_merge_and_evidence_once() {
    let full = merge_entry();
    let short = answer("merge_get", full.clone(), Some("summary"));
    assert!(short.get("lastEvidence").is_none(), "the last check as read is view full's");
    for gone in ["entry", "repository", "pr", "head", "state", "release", "binaries", "batch", "merge", "grouping", "stop"] {
        assert!(short["evidence"].get(gone).is_none(), "evidence.{gone} repeats the entry, which is current: {}", short["evidence"]);
    }
    for kept in ["review", "main", "gate", "mergeRef", "policy", "checkedAt"] {
        assert_eq!(short["evidence"][kept], full["evidence"][kept], "{kept}");
    }
    let history = short["history"].as_array().unwrap();
    assert_eq!((history.len(), short["historyCount"].clone()), (10, json!(30)));
    assert_eq!(history[..], full["history"].as_array().unwrap()[20..], "the newest ten, oldest first");
    let mut rest = short.clone();
    for added in ["history", "historyCount", "more"] {
        rest.as_object_mut().unwrap().remove(added);
    }
    is_part_of(&rest, &full, "entry");
    assert!(short["more"].as_str().unwrap().contains("view \"full\""));
    assert_eq!(answer("merge_get", full.clone(), Some("full")), full, "view full is the whole record");
    // Each write that answers with an entry answers with its summary.
    for write in ["merge_enqueue", "merge_cancel", "merge_retry", "merge_revert"] {
        assert_eq!(answer(write, full.clone(), None), short, "{write}");
    }
    let repository = json!({"repositoryId":7,"paused":null,"enabled":true});
    assert_eq!(answer("merge_unpause", repository.clone(), None), repository, "an unpause answers with the repository, as it was");

    let mut listed = full.clone();
    for stored_apart in ["history", "lastEvidence"] {
        listed.as_object_mut().unwrap().remove(stored_apart);
    }
    let page = json!({"entries":[listed.clone(), listed.clone()],"nextBefore":5,"hasMore":true});
    let rows = answer("merge_list", page.clone(), Some("summary"));
    assert_eq!((rows["nextBefore"].clone(), rows["hasMore"].clone()), (json!(5), json!(true)));
    let row = &rows["entries"][0];
    assert_eq!(row.as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
        ["createdAt", "detail", "entryId", "headSha", "id", "merge", "number", "repository", "state", "taskId", "taskReference", "updatedAt", "url"]);
    assert_eq!(row["merge"], json!({"sha":"f".repeat(40),"mergedAt":"t3","mainCi":{"conclusion":"success","runId":95}}));
    is_part_of(row, &listed, "row");
    assert!(rows["more"].as_str().unwrap().contains("merge_get"));
    assert_eq!(answer("merge_list", page.clone(), Some("full")), page);
}
