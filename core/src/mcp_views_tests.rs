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

#[test]
fn an_agents_task_list_is_compact_unless_it_asks_for_whole_rows() {
    let mut plain = arguments(json!({"statuses":["doing"]}));
    assert_eq!(prepare("task_list", &mut plain), Ok(None));
    assert_eq!(plain["compact"], true, "an Agent's task_list lists short rows by default (YN-69)");
    let mut whole = arguments(json!({"compact":false}));
    prepare("task_list", &mut whole).unwrap();
    assert_eq!(whole["compact"], false, "compact:false still lists whole rows");
}

/// A mailbox page as peer_read reads it: a delivered job mail with the
/// wake-up's bookkeeping, a dispatch, and a reply in another's thread.
fn mailbox() -> Value {
    let me = json!({"kind":"agent","id":"dev","name":"Dev"});
    let detail = json!({"afterSeq":40,"agentId":"dev","clientMessageId":"peer-mail-1","mode":"start","priority":"normal",
        "sessionId":"s","turnId":"t","mailbox":{"afterSeq":40,"count":1,"groups":[{"count":1,"kind":"job","name":"build","status":"failed"}],
            "memberSeqs":[41],"messageCount":1,"priority":"normal","recipientId":"dev","remainingCount":0,"throughSeq":41,"version":1}});
    json!({"messages":[
        {"id":"m41","seq":41,"threadId":"m41","replyTo":null,"sender":{"kind":"system","id":"core","name":"Yuzuno Core"},"recipient":me,
         "body":"Local job build is failed.","taskId":"T-1","createdAt":"t41","source":{"jobId":"j","attempt":"a"},"priority":"normal",
         "jobId":"j","metadata":{"kind":"job","name":"build","status":"failed","jobId":"j"},
         "notice":{"key":"[\"job\",\"j\",\"a\",\"failed\"]","kind":"job","name":"build","status":"failed"},
         "delivery":{"state":"delivered","detail":detail},"firstReadAt":"t42","wake":"ring"},
        {"id":"m42","seq":42,"threadId":"m42","replyTo":null,"sender":{"kind":"agent","id":"lead","name":"Lead"},"recipient":me,
         "body":"Work on task T-1.","taskId":"T-1","createdAt":"t42","source":{"agentId":"lead","turnId":"lt"},"priority":"normal",
         "dispatchId":"d1","materialsRef":{"schemaVersion":1,"taskId":"T-1","dispatchId":"d1","taskVersion":2,"capturedAt":"t42"},
         "resultInstructions":"Pass this message's dispatchId to task_submit_result.",
         "notice":{"key":"m42","kind":"peer","name":"Lead","status":""},"delivery":{"state":"pending","detail":{}},"firstReadAt":null},
        {"id":"m43","seq":43,"threadId":"m40","replyTo":"m40","sender":{"kind":"agent","id":"lead","name":"Lead"},"recipient":me,
         "body":"Approved.","taskId":"T-1","createdAt":"t43","source":{"agentId":"lead"},"priority":"urgent",
         "notice":{"key":"m43","kind":"peer","name":"Lead","status":""},"delivery":{"state":"delivered","detail":detail},
         "firstReadAt":"t44","wake":"quiet","wakeReason":"a receipt"}],
        "nextAfterSeq":43,"hasMore":false})
}

#[test]
fn an_agents_mail_keeps_each_message_and_leaves_out_the_wake_up_bookkeeping() {
    let full = mailbox();
    let short = answer("peer_read", full.clone(), None);
    assert_eq!((short["nextAfterSeq"].clone(), short["hasMore"].clone()), (json!(43), json!(false)));
    let messages = short["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    for (n, message) in messages.iter().enumerate() {
        let whole = &full["messages"][n];
        assert_eq!(message["delivery"], json!({"state":whole["delivery"]["state"]}), "its delivery, not the wake-up's record");
        for gone in ["recipient", "notice"] {
            assert!(message.get(gone).is_none(), "{gone}: the reader, and the GUI's grouping: {message}");
        }
        for kept in ["id", "seq", "sender", "body", "taskId", "createdAt", "source", "priority", "firstReadAt"] {
            assert_eq!(message.get(kept), whole.get(kept), "{kept}");
        }
        is_part_of(message, whole, &format!("messages[{n}]"));
    }
    assert!(messages[0].get("threadId").is_none() && messages[0].get("replyTo").is_none(), "a thread of its own, no reply");
    assert_eq!((messages[2]["threadId"].clone(), messages[2]["replyTo"].clone()), (json!("m40"), json!("m40")));
    for kept in ["dispatchId", "materialsRef", "resultInstructions"] {
        assert_eq!(messages[1][kept], full["messages"][1][kept], "a dispatch keeps {kept}");
    }
    assert_eq!((messages[0]["metadata"].clone(), messages[0]["jobId"].clone()), (full["messages"][0]["metadata"].clone(), json!("j")));
    assert_eq!((messages[2]["wake"].clone(), messages[2]["wakeReason"].clone()), (json!("quiet"), json!("a receipt")));
    assert!(short.to_string().len() * 3 < full.to_string().len() * 2, "{} of {}", short.to_string().len(), full.to_string().len());
}

#[test]
fn a_full_task_says_its_registered_materials_once() {
    let materials = json!({"acceptance":"a".repeat(2000),"baseline":"b"});
    let full = json!({"task":{"id":"T-1","materials":materials},"activities":[{"seq":1,"kind":"created","changes":{"materials":materials}}],
        "materialsSource":{"value":materials,"taskVersion":1,"activitySeq":1,"at":"t1","actor":{"kind":"user"}},"keys":{"global":"T-1"}});
    let short = answer("task_get", full.clone(), None);
    assert_eq!(short["materialsSource"], json!({"valueIn":"task.materials","taskVersion":1,"activitySeq":1,"at":"t1","actor":{"kind":"user"}}));
    assert_eq!((short["task"].clone(), short["activities"].clone()), (full["task"].clone(), full["activities"].clone()),
        "the task and its history stay whole");
    // A registration that is not the task's materials (none, or another) stays as it is.
    let mut other = full.clone();
    other["task"]["materials"] = json!({"acceptance":"x"});
    assert_eq!(answer("task_get", other.clone(), None), other);
    let current = json!({"current":{"taskId":"T-1","materialsRegistered":true},"keys":{"global":"T-1"}});
    assert_eq!(answer("task_get", current.clone(), None), current);
}

/// What one MCP answer holds (YN-69 S8: mcp_views::BUDGET), in bytes of compact JSON.
const PAGE_BUDGET: usize = 49_152;

fn message(seq: i64, body: &str) -> Value {
    json!({"id":format!("m{seq}"),"seq":seq,"threadId":format!("m{seq}"),"sender":{"kind":"agent","id":"lead","name":"Lead"},
        "body":body,"taskId":"T-1","createdAt":"t","priority":"normal","delivery":{"state":"delivered","detail":{}},"firstReadAt":null})
}

/// YN-69 S8: a mailbox page larger than an answer holds ends early, at a seq:
/// every message up to nextAfterSeq is in it and none after, whatever order
/// the page lists them in, so paging on reads each message once.
#[test]
fn a_mailbox_page_larger_than_an_answer_ends_early_at_a_seq_and_pages_on() {
    let body = "b".repeat(3000);
    // A session notice (seq 40) is listed first, as peer_read lists them.
    let mut messages: Vec<Value> = vec![message(40, &body)];
    messages.extend((1..40).map(|seq| message(seq, &body)));
    let page = json!({"messages":messages,"nextAfterSeq":40,"hasMore":false});
    let short = answer("peer_read", page.clone(), None);
    assert!(short.to_string().len() <= PAGE_BUDGET, "{}", short.to_string().len());
    let next = short["nextAfterSeq"].as_i64().unwrap();
    let seqs: Vec<i64> = short["messages"].as_array().unwrap().iter().map(|m| m["seq"].as_i64().unwrap()).collect();
    assert!(next < 40 && short["hasMore"] == true, "{next}");
    let mut sorted = seqs.clone();
    sorted.sort();
    assert_eq!(sorted, (1..=next).collect::<Vec<_>>(), "every message up to nextAfterSeq, none after");
    assert!(short["messages"].as_array().unwrap().iter().all(|m| m["body"] == json!(body)), "bodies are whole");
    assert!(short["more"].as_str().unwrap().contains("nextAfterSeq"));
    // Paging on, as peer_read gives what is after nextAfterSeq: every message once.
    let mut all = seqs;
    let mut after = next;
    loop {
        let rest: Vec<Value> = page["messages"].as_array().unwrap().iter().filter(|m| m["seq"].as_i64().unwrap() > after).cloned().collect();
        let more = answer("peer_read", json!({"messages":rest,"nextAfterSeq":40,"hasMore":false}), None);
        assert!(more.to_string().len() <= PAGE_BUDGET);
        all.extend(more["messages"].as_array().unwrap().iter().map(|m| m["seq"].as_i64().unwrap()));
        let next = more["nextAfterSeq"].as_i64().unwrap();
        assert!(next > after, "each page moves on");
        after = next;
        if more["hasMore"] != true {
            break;
        }
    }
    all.sort();
    assert_eq!(all, (1..=40).collect::<Vec<_>>(), "every message once");
    // A page that fits is as it was, projected.
    let small = json!({"messages":[message(1, "hi")],"nextAfterSeq":1,"hasMore":false});
    assert_eq!((answer("peer_read", small.clone(), None)["hasMore"].clone(), answer("peer_read", small, None).get("more").is_none()), (json!(false), true));
}

#[test]
fn one_message_larger_than_an_answer_is_cut_and_says_so() {
    let page = json!({"messages":[message(7, &"x".repeat(70_000))],"nextAfterSeq":7,"hasMore":false});
    let short = answer("peer_read", page, None);
    assert!(short.to_string().len() <= PAGE_BUDGET, "{}", short.to_string().len());
    assert_eq!((short["nextAfterSeq"].clone(), short["messages"][0]["seq"].clone()), (json!(7), json!(7)));
    let body = short["messages"][0]["body"].as_str().unwrap();
    assert!(body.starts_with("xxx") && body.contains("more characters"), "{}", &body[body.len() - 80..]);
    assert!(short["more"].as_str().unwrap().contains("m7"), "{}", short["more"]);
}

fn activity(seq: i64, body: &str) -> Value {
    json!({"seq":seq,"kind":"comment","at":"t","taskId":"T-1","actor":{"kind":"agent","id":"dev","name":"Dev"},"body":body})
}

/// YN-69 S8: a history page, or a full task, larger than an answer holds ends
/// at an activity; nextAfterSeq pages on from there.
#[test]
fn a_task_history_larger_than_an_answer_pages_by_bytes() {
    let body = "n".repeat(2000);
    let page = json!({"taskId":"T-1","version":9,"activities":(1..=50).map(|seq| activity(seq, &body)).collect::<Vec<_>>(),
        "nextAfterSeq":50,"hasMore":true,"keys":{"global":"T-1"}});
    let short = answer("task_get", page.clone(), None);
    assert!(short.to_string().len() <= PAGE_BUDGET, "{}", short.to_string().len());
    let kept = short["activities"].as_array().unwrap();
    let next = short["nextAfterSeq"].as_i64().unwrap();
    assert!(!kept.is_empty() && kept.len() < 50 && short["hasMore"] == true);
    assert_eq!(kept.last().unwrap()["seq"].as_i64(), Some(next), "the page ends at nextAfterSeq");
    assert_eq!(kept[..], page["activities"].as_array().unwrap()[..kept.len()], "whole activities, in order");
    // A full task keeps its record whole and fills the rest with history.
    let full = json!({"task":{"id":"T-1","description":"d".repeat(20_000)},"activities":page["activities"],"executions":[],
        "nextAfterSeq":50,"hasMore":false,"mailProblems":[],"keys":{"global":"T-1"}});
    let short = answer("task_get", full.clone(), None);
    assert!(short.to_string().len() <= PAGE_BUDGET, "{}", short.to_string().len());
    assert_eq!((short["task"].clone(), short["hasMore"].clone()), (full["task"].clone(), json!(true)));
    let kept = short["activities"].as_array().unwrap().len();
    assert!(kept > 0 && kept < 50 && short["nextAfterSeq"] == json!(kept as i64), "{kept}");
    // A task whose own record is more than an answer: the record whole, its
    // history from the first activity on with view "activity", and it says so.
    let huge = json!({"task":{"id":"T-1","description":"d".repeat(60_000)},"activities":page["activities"],"executions":[],
        "nextAfterSeq":50,"hasMore":false,"mailProblems":[],"keys":{"global":"T-1"}});
    let short = answer("task_get", huge, None);
    assert_eq!((short["activities"].clone(), short["nextAfterSeq"].clone(), short["hasMore"].clone()), (json!([]), json!(0), json!(true)));
    assert!(short["more"].as_str().unwrap().contains("view \"activity\""));
    // A page that fits is as it was.
    let small = json!({"taskId":"T-1","version":1,"activities":[activity(1, "hi")],"nextAfterSeq":1,"hasMore":false,"keys":{}});
    assert_eq!(answer("task_get", small.clone(), None), small);
}
