//! T-81: real release Store and HTTP handler on an isolated, masked fixture.
//! No harness is started. No connection to the daily Core or its database.
use anyhow::{ensure, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed},
        Arc,
    },
    time::{Duration, Instant},
};
use yuzuno_workspace::{
    conversation_window::{self, Query},
    model::AgentDetail,
    record_rows::{self, Stored},
    server,
    store::Route,
    workspace::Workspace,
};

// Counts Rust allocations, not SQLite's C allocations or process RSS. The
// peak is process-wide; HTTP samples also include client/runtime buffers.
struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() {
            let n = LIVE.fetch_add(layout.size(), Relaxed) + layout.size();
            PEAK.fetch_max(n, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        System.dealloc(p, layout);
        LIVE.fetch_sub(layout.size(), Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, old: Layout, size: usize) -> *mut u8 {
        let next = System.realloc(p, old, size);
        if !next.is_null() {
            if size >= old.size() {
                let n = LIVE.fetch_add(size - old.size(), Relaxed) + size - old.size();
                PEAK.fetch_max(n, Relaxed);
            } else {
                LIVE.fetch_sub(old.size() - size, Relaxed);
            }
        }
        next
    }
}
#[global_allocator]
static ALLOC: Counting = Counting;
const RUNS: usize = 9;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    ms: f64,
    rust_peak_added_bytes: usize,
}
fn start() -> (Instant, usize) {
    let live = LIVE.load(Relaxed);
    PEAK.store(live, Relaxed);
    (Instant::now(), live)
}
fn finish((time, live): (Instant, usize)) -> Sample {
    Sample {
        ms: time.elapsed().as_secs_f64() * 1000.,
        rust_peak_added_bytes: PEAK.load(Relaxed).saturating_sub(live),
    }
}
fn measure<T>(f: impl FnOnce() -> Result<T>) -> Result<(T, Sample)> {
    let mark = start();
    let value = f()?;
    Ok((value, finish(mark)))
}
fn summary(samples: &[Sample]) -> Value {
    let mut times: Vec<_> = samples.iter().map(|s| s.ms).collect();
    times.sort_by(f64::total_cmp);
    json!({"runs":samples.len(),"medianMs":times[times.len()/2],"minMs":times[0],"maxMs":times[times.len()-1],
        "maxRustPeakAddedBytes":samples.iter().map(|s|s.rust_peak_added_bytes).max(),"samples":samples})
}
/// The stored JSON text a read of the rows went through, in bytes. Payloads
/// are parsed where they are read and their text is not kept, so for a read
/// with payloads their bytes are counted in the database, inside the read's
/// own transaction (the same snapshot), as the bytes SQLite holds.
fn json_bytes(db: &rusqlite::Connection, id: &str, stored: &Stored) -> Result<usize> {
    Ok(match stored {
        Stored::Whole(s) => s.len(),
        Stored::Rows(r, fields) => {
            let payloads: i64 = if fields.is_empty() {
                0
            } else {
                ensure!(!db.is_autocommit(), "payload bytes are counted in the read's own snapshot");
                db.query_row("SELECT COALESCE(SUM(LENGTH(CAST(data AS BLOB))),0) FROM agent_payloads WHERE agent_id=?1",
                    [id], |r| r.get(0))?
            };
            r.meta.len()
                + r.turns.iter().map(|t| t.data.len()).sum::<usize>()
                + r.items
                    .iter()
                    .map(|i| i.data.len() + i.previews.as_ref().map_or(0, String::len))
                    .sum::<usize>()
                + usize::try_from(payloads)?
        }
    })
}
#[derive(Serialize)]
struct View<'a> {
    #[serde(flatten)]
    detail: &'a AgentDetail,
    conversation: &'a Value,
}
fn fixture(mut source: AgentDetail, shape: &str) -> AgentDetail {
    if shape == "long4" {
        let old = std::mem::take(&mut source.turns);
        source.turns = (0..4)
            .flat_map(|copy| {
                old.iter().map(move |t| {
                    let mut t = t.clone();
                    t["id"] = json!(format!("copy{copy}-{}", t["id"].as_str().unwrap()));
                    t
                })
            })
            .collect();
    } else if shape == "giant" {
        let mut items: Vec<_> = source
            .turns
            .iter()
            .enumerate()
            .flat_map(|(n, t)| {
                t["items"].as_array().unwrap().iter().map(move |i| {
                    let mut i = i.clone();
                    i["id"] = json!(format!("giant-{n}-{}", i["id"].as_str().unwrap()));
                    i
                })
            })
            .collect();
        items.push(json!({"id":"huge-text","type":"agentMessage","text":"T81 original line\n".repeat(50_000)}));
        source.turns = vec![json!({"id":"giant","status":"completed","items":items})];
    }
    source.agent.id = "t81-fixture".into();
    source.agent.name = "T81 isolated fixture".into();
    source.agent.project_id = None;
    source.agent.thread_id = None;
    source.agent.claude_session_id = None;
    source.agent.status = "working".into();
    source.agent.last_seq = 0;
    source.agent.reviewed_seq = 0;
    source.pending.clear();
    source.message_receipts.clear();
    let last = source.turns.last_mut().unwrap();
    last["status"] = json!("inProgress");
    last["items"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"t81-live","type":"agentMessage","text":"live"}));
    source
}
async fn http(client: &reqwest::Client, url: reqwest::Url) -> Result<(usize, Sample)> {
    let mark = start();
    let response = client.get(url).send().await?;
    ensure!(
        response.status().is_success(),
        "HTTP status {}",
        response.status()
    );
    let bytes = response.bytes().await?;
    let sample = finish(mark);
    // Decode/verify outside the timed request. This is the production API,
    // not a replay of saved JSON; all bytes cross the loopback socket.
    let body: Value = serde_json::from_slice(&bytes)?;
    ensure!(
        body["conversation"]["totalItems"].as_u64().is_some(),
        "missing window metadata"
    );
    ensure!(
        body["turns"]
            .as_array()
            .context("turns")?
            .iter()
            .map(|t| t["items"].as_array().map_or(0, Vec::len))
            .sum::<usize>()
            <= 96
    );
    Ok((bytes.len(), sample))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    ensure!(!cfg!(debug_assertions), "run this benchmark with --release");
    let mut args = std::env::args().skip(1);
    let input = PathBuf::from(args.next().context("fixture path")?);
    let output = PathBuf::from(args.next().context("new output directory")?);
    let candidate = args.next().as_deref() == Some("candidate");
    ensure!(!output.exists(), "preserve previous benchmark output");
    std::fs::create_dir_all(&output)?;
    let raw = std::fs::read(input)?;
    let sha = format!("{:x}", Sha256::digest(&raw));
    ensure!(
        sha == "b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d",
        "fixture hash"
    );
    let document: Value = serde_json::from_slice(&raw)?;
    let source: AgentDetail = serde_json::from_value(document["details"]["a"].clone())?;
    drop(document);
    drop(raw);
    let mut cases = Vec::new();
    for shape in ["long", "long4", "giant"] {
        let record = fixture(source.clone(), shape);
        let id = record.agent.id.clone();
        let dir = output.join(shape);
        let ws = Workspace::new(
            dir.clone(),
            "/isolated-t81".into(),
            "unused-t81-harness".into(),
        )?;
        ws.store.insert(&record)?;
        ensure!(
            ws.store.streamed_records() == 0,
            "rows case must not be held"
        );
        let db = Connection::open_with_flags(
            dir.join("workspace.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        if candidate {
            let (window, sample) = measure(|| {
                ws.store
                    .client_window(&id, &Query::default())?
                    .map_err(|e| anyhow::anyhow!(e.message()))
            })?;
            let cache_bytes: i64 = db.query_row(
                "SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM agent_window_items",
                [],
                |r| r.get(0),
            )?;
            cases.push(json!({"shape":shape,"coldIndexBuild":sample,"readStats":window.stats,"cacheJsonBytes":cache_bytes}));
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let router = server::router_on_port(ws.clone(), dir.join("no-assets"), port);
        let serving = tokio::spawn(async move { axum::serve(listener, router).await });
        let client = reqwest::Client::builder().no_proxy().build()?;
        let turn = record.turns.last().unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let middle = &record.turns[record.turns.len() / 2];
        let middle_id = middle["id"].as_str().unwrap().to_owned();
        let mi = middle["items"].as_array().unwrap();
        let middle_item = mi
            .get(mi.len() / 2)
            .and_then(|i| i["id"].as_str())
            .map(str::to_owned);
        let body_bytes = serde_json::to_vec(&record)?.len();
        for held in [false, true] {
            if held {
                ws.store.record_stream(
                    &id,
                    Route::Ephemeral,
                    "item/agentMessage/delta",
                    &json!({"turnId":turn,"itemId":"t81-live","delta":"x"}),
                )?;
                ensure!(ws.store.streamed_records() == 1, "held case missing");
            }
            let mut sql_samples = Vec::new();
            let mut decode_samples = Vec::new();
            let mut clone_samples = Vec::new();
            let mut read_bytes = 0;
            if !held && !candidate {
                for _ in 0..RUNS {
                    let (rows, sample) =
                        measure(|| Ok(record_rows::read(&db, &id, false)?.context("rows")?))?;
                    read_bytes = json_bytes(&db, &id, &rows)?;
                    sql_samples.push(sample);
                    let (_, sample) = measure(|| record_rows::assemble_stored(&id, rows, false))?;
                    decode_samples.push(sample);
                }
            } else if !candidate {
                for _ in 0..RUNS {
                    let (_, sample) = measure(|| {
                        ws.store
                            .payload_view(&id, None, None, |detail| detail.clone())
                    })?;
                    clone_samples.push(sample);
                }
            }
            for destination in ["latest", "middle", "direct"] {
                let q = Query {
                    view: Some("window".into()),
                    turn_id: (destination != "latest").then(|| middle_id.clone()),
                    item_id: (destination == "direct")
                        .then(|| middle_item.clone())
                        .flatten(),
                    ..Default::default()
                };
                let mut url = reqwest::Url::parse(&format!(
                    "http://127.0.0.1:{port}/api/agents/{id}?view=window"
                ))?;
                if let Some(t) = &q.turn_id {
                    url.query_pairs_mut().append_pair("turnId", t);
                }
                if let Some(i) = &q.item_id {
                    url.query_pairs_mut().append_pair("itemId", i);
                }
                let mut reads = Vec::new();
                let mut projects = Vec::new();
                let mut serializes = Vec::new();
                let mut apis = Vec::new();
                let mut read_stats = Vec::new();
                let mut response_bytes = 0;
                let mut selected_bytes = 0;
                // Warm caches/HTTP once; all reported requests follow that.
                http(&client, url.clone()).await?;
                for _ in 0..RUNS {
                    let (detail, meta) = if candidate {
                        let (window, sample) = measure(|| {
                            ws.store
                                .client_window(&id, &q)?
                                .map_err(|e| anyhow::anyhow!(e.message()))
                        })?;
                        reads.push(sample);
                        read_stats.push(serde_json::to_value(window.stats)?);
                        (window.detail, window.conversation)
                    } else {
                        let (mut detail, sample) = measure(|| ws.store.client_detail(&id))?;
                        reads.push(sample);
                        let (meta, sample) = measure(|| {
                            conversation_window::project(&mut detail, &q)
                                .map_err(|e| anyhow::anyhow!(e.message()))
                        })?;
                        projects.push(sample);
                        (detail, meta)
                    };
                    let (bytes, sample) = measure(|| {
                        Ok(serde_json::to_vec(&View {
                            detail: &detail,
                            conversation: &meta,
                        })?)
                    })?;
                    selected_bytes = bytes.len();
                    serializes.push(sample);
                    drop(bytes);
                    drop(meta);
                    drop(detail);
                    let (bytes, sample) = http(&client, url.clone()).await?;
                    response_bytes = bytes;
                    apis.push(sample);
                }
                cases.push(json!({"shape":shape,"held":held,"destination":destination,"turns":record.turns.len(),
                    "items":record.turns.iter().map(|t|t["items"].as_array().map_or(0,Vec::len)).sum::<usize>(),
                    "fullRecordBytes":body_bytes,"rowsJsonReadAndDecodedBytes":(!candidate).then_some(read_bytes),"rowsSql":(!sql_samples.is_empty()).then(||summary(&sql_samples)),
                    "rowsDecode":(!decode_samples.is_empty()).then(||summary(&decode_samples)),"heldClone":(!clone_samples.is_empty()).then(||summary(&clone_samples)),
                    "clientDetail":(!candidate).then(||summary(&reads)),"windowReadAndProjection":candidate.then(||summary(&reads)),"readStats":read_stats,
                    "projection":(!projects.is_empty()).then(||summary(&projects)),
                    "serialization":summary(&serializes),"http":summary(&apis),"responseBytes":response_bytes,"viewBytes":selected_bytes}));
            }
        }
        // A bounded stream overlaps repeated real HTTP reads. Record its
        // call latency too: a faster response must not just block the writer.
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let stream_ws = ws.clone();
        let stream_id = id.clone();
        let writer = std::thread::spawn(move || -> Result<Vec<Sample>> {
            let mut samples = Vec::new();
            for _ in 0..400 {
                if done.load(Relaxed) {
                    break;
                }
                let mark = Instant::now();
                stream_ws.store.record_stream(
                    &stream_id,
                    Route::Ephemeral,
                    "item/agentMessage/delta",
                    &json!({"turnId":turn,"itemId":"t81-live","delta":" streamed"}),
                )?;
                samples.push(Sample {
                    ms: mark.elapsed().as_secs_f64() * 1000.,
                    rust_peak_added_bytes: 0,
                });
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(samples)
        });
        let mut apis = Vec::new();
        let url = reqwest::Url::parse(&format!(
            "http://127.0.0.1:{port}/api/agents/{id}?view=window"
        ))?;
        for _ in 0..RUNS {
            apis.push(http(&client, url.clone()).await?.1);
        }
        stop.store(true, Relaxed);
        let writes = writer.join().expect("stream thread")?;
        ensure!(!writes.is_empty(), "no concurrent stream samples");
        cases.push(json!({"shape":shape,"held":true,"streaming":true,"http":summary(&apis),"streamWrites":summary(&writes)}));
        serving.abort();
        let _ = serving.await;
        drop(db);
        drop(ws);
        // Reports contain sizes/IDs of synthetic cases, never fixture text.
        let process_memory: Vec<_> = std::fs::read_to_string("/proc/self/status")
            .unwrap_or_default()
            .lines()
            .filter(|line| line.starts_with("VmHWM:") || line.starts_with("VmRSS:"))
            .map(str::to_owned)
            .collect();
        std::fs::write(
            output.join("report.json"),
            serde_json::to_vec_pretty(
                &json!({"candidate":candidate,"fixtureSha256":sha,"runs":RUNS,"cases":cases,"processMemory":process_memory,
            "notes":["Release Core library, Store, production server router and loopback HTTP; no mock responses, native harness or daily data",
                "Allocator peak is process-wide Rust heap above pre-operation live bytes, not RSS; HTTP includes client/runtime, streaming includes writer",
                "Rows JSON counts actual returned metadata/turn/item/preview strings; excludes SQLite page traffic and ancillary annotation queries",
                "Warm repeated samples are descriptive, not a p95 guarantee or Windows result",
                "Candidate coldIndexBuild is one initial Store call with absent cache; warm Rows use persisted metadata. Body bytes include at most three rail source items and the rejected boundary candidate",
                "Candidate body/index byte counters exclude ancillary provenance/result queries and physical page IO. Held has no JSON read/decode; its complete light metadata still scales with item count"]}),
            )?,
        )?;
        println!("completed {shape}");
    }
    Ok(())
}
