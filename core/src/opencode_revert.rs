//! Reverting an OpenCode Agent's session to before one of its Turns (T-10
//! Revert; contract on T-10 #3331 and its comments, Lead 3985, 3990, 4002,
//! 4016, 4019, 4036, 4037, 4051, 4092). A preview is read without a write.
//! What the revert would do to the Agent's files is worked out from
//! OpenCode's own snapshots (`opencode_revert_files`): every file it would
//! send back must come out known before anything is shown as revertable,
//! or nothing is. A preview lasts TTL and is what a confirm must read again
//! unchanged. A confirm keeps its attempt as a rewind's is kept
//! (`rewind::Attempt`), with what it checked (`Plan`), so that from before
//! its one request until its outcome is known nothing new reaches the Agent;
//! then backs up each file and asks OpenCode once. Its outcome comes only
//! from that request's own answer (Lead 4109): no later read, reconnect or
//! restart settles a request whose answer never came, as OpenCode's Git may
//! go on in processes of its own (`cross-spawn-spawner.ts`, detached).
use super::*;
use crate::opencode::RevertAnswer;
use crate::opencode_revert_files::{self as files, Entry, Outcome, Root, BOUNDS};
use crate::rewind::{Attempt, MAX_ARCHIVE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Instant;

const TTL: Duration = Duration::from_secs(600);
/// How long a confirm waits for OpenCode's answer before it answers itself
/// (Lead 3985 d): only how long it watches. The request goes on, and its
/// attempt stays unknown, holding the Agent back, until the answer comes.
/// (Shorter in tests, so that one can watch it pass.)
const WATCH: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 120 });
/// The backups an Agent keeps of its settled reverts, the newest ones (R5 of
/// #534): when a new one is made, older settled ones go. One whose outcome is
/// not yet known keeps its backup whatever its age.
const KEPT_BACKUPS: usize = 3;

/// A preview as it was read, for a confirm to match.
pub(super) struct Preview {
    pub owner: Weak<Workspace>,
    pub agent: String,
    pub generation: u64,
    pub session: String,
    pub turn: String,
    /// SHA-256 of the whole message list it was read from.
    pub messages: String,
    pub entries: Vec<Entry>,
    pub root: Option<Root>,
    pub at: Instant,
}

static PREVIEWS: LazyLock<std::sync::Mutex<HashMap<String, Preview>>> = LazyLock::new(Default::default);

/// Drops every preview past its TTL or whose Workspace is gone; how many.
pub(crate) fn expire_previews() -> usize {
    let mut previews = PREVIEWS.lock().unwrap();
    let before = previews.len();
    previews.retain(|_, p| p.at.elapsed() < TTL && p.owner.strong_count() > 0);
    before - previews.len()
}

/// What a confirm checked before it asked, kept with its attempt: what any
/// later read is held to (Lead 4109). `ended`, once the one request was
/// answered whole for this session: OpenCode's handler had ended then.
/// `held`, when that answer showed the session holding this revert: all that
/// is left then is to record it. `sent`, kept just before the one request goes
/// out: until then OpenCode was never asked (R4 of #534).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Plan {
    pub generation: u64,
    pub messages: String,
    pub entries: Vec<Entry>,
    pub root: Option<Root>,
    pub folder: String,
    /// The Turns it archived, which leave the record if it is kept.
    pub turns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub held: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sent: bool,
}

impl Plan {
    fn of(attempt: &Attempt) -> Result<Self> {
        Ok(serde_json::from_value(attempt.opencode.clone().context("The attempt keeps no plan")?)?)
    }
}

/// Tests only: holds the confirm of one attempt once its answer has reached
/// it, before anything of that answer is settled, until the test lets it go.
#[cfg(test)]
type Hold = (String, tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>);
#[cfg(test)]
static HOLD_ANSWERED: std::sync::Mutex<Option<Hold>> = std::sync::Mutex::new(None);
#[cfg(test)]
async fn hold_answered(attempt: &str) {
    let hold = HOLD_ANSWERED.lock().unwrap().take_if(|hold| hold.0 == attempt);
    if let Some((_, reached, proceed)) = hold {
        let _ = reached.send(());
        // Also goes on when the test drops its sender.
        let _ = proceed.await;
    }
}

/// Tests only: the attempt whose next record write fails, once.
#[cfg(test)]
static FAIL_RECORD: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Tests only: where one attempt's confirm ends as if Core had stopped
/// there, once, leaving it as Core had kept it.
#[cfg(test)]
#[derive(Clone, Copy, PartialEq)]
enum Stop {
    BeforeSent,
    AfterSent,
}
#[cfg(test)]
static STOP: std::sync::Mutex<Option<(String, Stop)>> = std::sync::Mutex::new(None);
#[cfg(test)]
fn stop_at(attempt: &str, at: Stop) -> bool {
    STOP.lock().unwrap().take_if(|stop| stop.0 == attempt && stop.1 == at).is_some()
}

/// What `rx` gives within `within`: its answer, or none once it is closed
/// (Lead 4124). An answer sent before the close is taken here, even one sent
/// as the watch ended; a send after it fails, so its sender keeps the answer
/// and settles the attempt itself. `at_end` runs between the watch's end and
/// the close (where a test sends, to make an answer arrive just then).
async fn watched<T>(rx: &mut tokio::sync::oneshot::Receiver<T>, within: Duration, at_end: impl FnOnce()) -> Option<T> {
    if let Ok(answer) = tokio::time::timeout(within, &mut *rx).await {
        return answer.ok();
    }
    at_end();
    rx.close();
    rx.try_recv().ok()
}

/// What a revert to before a Turn would do, as read now.
pub(super) struct Read {
    pub generation: u64,
    pub session: String,
    pub messages: String,
    /// The Agent's folder, resolved.
    pub folder: String,
    /// The session's messages from the Turn's own on, as read: what leaves.
    pub leaving: Vec<Value>,
    pub entries: Vec<Entry>,
    pub root: Option<Root>,
    /// The Turns that would leave the conversation (this one and later), and those kept.
    pub removed: usize,
    pub kept: usize,
    pub draft: String,
    /// The session's messages are 2.x's (T-61 slice 5): previewed, not yet confirmed.
    pub v2: bool,
}

impl Workspace {
    /// What reverting this OpenCode Agent's session to before `turn` would
    /// do, read without a write (see the module): the Turns that leave, and
    /// each file OpenCode would send back, with what it should become and
    /// what it is now. Kept for TTL under the ID it answers with.
    pub async fn opencode_revert_preview(self: &Arc<Self>, id: &str, turn: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        self.ensure_rewind_settled(id).await?;
        let read = self.opencode_revert_read(id, turn).await?;
        let preview = format!("revert_{}", uuid::Uuid::new_v4().simple());
        let view = json!({
            "previewId": preview.clone(), "available": true,
            "removedTurns": read.removed, "keptTurns": read.kept, "draft": read.draft,
            "files": read.entries.iter().map(|e| json!({"path": e.target.file, "expected": e.expected, "current": e.current})).collect::<Vec<_>>(),
        });
        PREVIEWS.lock().unwrap().insert(preview, Preview {
            owner: Arc::downgrade(self), agent: id.into(), generation: read.generation, session: read.session,
            turn: turn.into(), messages: read.messages, entries: read.entries, root: read.root, at: Instant::now(),
        });
        Ok(view)
    }

    /// Everything a revert to before `turn` needs, read now. Refused, with
    /// nothing read past the refusal, unless the Agent is an open, connected
    /// OpenCode one with nothing running, waiting or unconfirmed (no Turn in
    /// progress, no request pending, no rewind, revert, compaction or message
    /// whose outcome is not known), its session idle with no revert waiting in it, and `turn`
    /// one of its Turns whose message the session holds, and the session of
    /// the project OpenCode holds the Agent's folder for now (Lead 4092). With
    /// files to send back, also unless where OpenCode keeps its snapshots is
    /// known from how it was started, (1.19.3) its `/path` agrees with that,
    /// and every file comes out known (`opencode_revert_files::plan`). On 2.x
    /// (T-61 slice 5) the folder and its project are 2.x's `GET /api/location`
    /// for the Agent's folder, its snapshots under the project's Git top level
    /// (`targets_v2`), and the Turn's message for a command is the one 2.x
    /// admitted for it.
    pub(super) async fn opencode_revert_read(self: &Arc<Self>, id: &str, turn: &str) -> Result<Read> {
        // What a send checks, with this Turn among the Turns read; and where it is among all of them.
        let (agent, wanted) = (id.to_owned(), turn.to_owned());
        let d = self.stored(move |store| store.view(&agent, Sel::Turns(vec![wanted]))).await?;
        ensure_agent_open(&d.agent)?;
        ensure!(d.agent.harness == "opencode", "Agent 不是 OpenCode");
        if let Some(blocked) = compaction_blocks(&d, "没有预览回退") {
            bail!(blocked);
        }
        ensure!(!d.message_receipts.iter().any(|r| matches!(r.status.as_str(), "sending" | "uncertain")),
            "上一条消息的发送结果尚未确认，请先重连核对；没有预览回退");
        ensure!(!busy(&d), "OpenCode 正在执行或等待回应；回退只在空闲时进行，没有预览回退");
        let (agent, wanted) = (id.to_owned(), turn.to_owned());
        let (kept, total) = self.stored(move |store| store.turns_around(&agent, &wanted)).await?.context("这个 Agent 没有这个 Turn；没有预览回退")?;
        let index = d.turns.iter().position(|t| t["id"] == turn).context("这个 Agent 没有这个 Turn；没有预览回退")?;
        let c = self.opencodes.lock().unwrap().get(id).cloned().context("OpenCode Agent 尚未连接；连接后才能回退")?;
        let unread = "没有读到 OpenCode 会话现在的状态；没有预览回退";
        let session = c.server.session(&c.session).await.context(unread)?;
        ensure!(session["revert"].is_null(), "OpenCode 会话里已有一次尚未处理的回退；没有预览回退");
        ensure!(c.server.session_status(&c.session).await.context(unread)?["type"] == "idle", "OpenCode 会话不是空闲状态；没有预览回退");
        let messages = c.server.messages(&c.session).await.context(unread)?;
        let v2 = crate::opencode_v2::is_v2(&messages);
        let list = messages.as_array().context(unread)?;
        // The same folder however it is written (a link to it, a trailing
        // slash): OpenCode answers with its own resolved one (R3 of #534).
        // Each read of the disk here is on the blocking pool (R5 of #534).
        let cwd = d.agent.cwd.clone();
        let folder = tokio::task::spawn_blocking(move || std::fs::canonicalize(cwd)).await?.context("这个 Agent 的目录无法读取；没有预览回退")?
            .to_str().context("这个 Agent 的目录不是 UTF-8；没有预览回退")?.to_owned();
        // The Turn's own message: its ID, or, for a command, the message 2.x admitted for it (T-61 slice 3).
        let boundary = d.turns[index]["_opencodeCommand"]["native"].as_str().filter(|_| v2).unwrap_or(turn).to_owned();
        let (targets, project, worktree, path) = if v2 {
            let location = c.server.location(&folder).await.context(unread)?;
            let (named, top) = (location["directory"].as_str().map(PathBuf::from), location["project"]["directory"].as_str().map(PathBuf::from));
            let (directory, toplevel) = tokio::task::spawn_blocking(move || {
                (named.and_then(|d| std::fs::canonicalize(d).ok()), top.and_then(|t| std::fs::canonicalize(t).ok()))
            }).await?;
            ensure!(directory.as_deref() == Some(Path::new(&folder)), "OpenCode 的工作目录不是这个 Agent 的目录；没有预览回退");
            let project = location["project"]["id"].as_str().context("OpenCode 没有说它的项目；没有预览回退")?.to_owned();
            ensure!(session["projectID"] == project.as_str(), "OpenCode 会话不属于它现在的项目；没有预览回退");
            // Snapshots are of the project's Git top level, resolved (2.2.5 core/src/snapshot.ts).
            let toplevel = toplevel.and_then(|t| t.to_str().map(str::to_owned)).context("OpenCode 没有说这个目录所在的 Git 顶层；没有预览回退")?;
            (files::targets_v2(list, &boundary, &toplevel, &folder)?, project, toplevel, None)
        } else {
            let path = c.server.path().await.context(unread)?;
            let named = path["directory"].as_str().map(PathBuf::from);
            let directory = tokio::task::spawn_blocking(move || named.and_then(|d| std::fs::canonicalize(d).ok())).await?;
            ensure!(directory.as_deref() == Some(Path::new(&folder)), "OpenCode 的工作目录不是这个 Agent 的目录；没有预览回退");
            let worktree = path["worktree"].as_str().context("OpenCode 没有说它的 worktree；没有预览回退")?.to_owned();
            let project = c.server.project().await.context(unread)?;
            let project = project["id"].as_str().context("OpenCode 没有说它的项目；没有预览回退")?.to_owned();
            ensure!(session["projectID"] == project.as_str(), "OpenCode 会话不属于它现在的项目；没有预览回退");
            (files::targets(list, turn, &worktree, &folder)?, project, worktree, Some(path))
        };
        let (entries, root) = if targets.is_empty() {
            (Vec::new(), None)
        } else {
            let started = c.files.as_ref().as_ref()
                .map_err(|why| anyhow!("这次回退会改动文件，而无法事先核对它们会变成什么（{why}）；没有预览回退"))?;
            started.launcher.check()?;
            started.launcher.bound(c.server.pid().context("OpenCode's process has no ID")?)?;
            // 2.x names no data folder (no `/path`): Core set it, and the probe shows 2.x keeps its snapshots there.
            if let Some(path) = &path {
                started.roots.agrees(path)?;
            }
            let store = files::store(&started.roots.data, &project, &worktree)?;
            let at = PathBuf::from(&folder);
            let root = tokio::task::spawn_blocking(move || Root::of(&at)).await??;
            let (entries, _) = files::plan(&store, Path::new(&worktree), &[], &targets, Path::new(&folder), root, BOUNDS).await?;
            (entries, Some(root))
        };
        ensure!(self.opencode_current(id, c.generation).is_some(), "OpenCode 连接已变化；没有预览回退");
        let draft = d.turns[index]["items"].as_array().into_iter().flatten()
            .find(|item| item["type"] == "userMessage")
            .and_then(|item| item["content"].as_array())
            .map(|parts| parts.iter().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join(""))
            .unwrap_or_default();
        let digest: String = Sha256::digest(serde_json::to_vec(&messages)?).iter().map(|b| format!("{b:02x}")).collect();
        let from = list.iter().position(|m| if v2 { m["id"] == boundary.as_str() } else { m["info"]["id"] == turn })
            .context("OpenCode 会话里没有这一轮的消息；没有预览回退")?;
        Ok(Read { generation: c.generation, session: c.session.clone(), messages: digest, folder, leaving: list[from..].to_vec(), entries, root,
            removed: total - kept, kept, draft, v2 })
    }

    /// Reverts the session as the preview `key` showed it (see the module).
    /// Refused, with nothing written, unless everything the preview read is
    /// read again the same: the connection, the session, its whole message
    /// list and each file. Then the attempt is kept, `sending`; each file is
    /// backed up into this Agent's folder (if it cannot be, nothing is asked);
    /// and OpenCode is asked once, watched for WATCH. Asked again for the
    /// same preview, it answers that attempt as it stands and asks nothing.
    ///
    /// It runs in a task of its own. A client that goes away drops its
    /// request's handler, not the confirm: once the attempt is kept, its
    /// backup, its one request and the outcome that request's answer settles
    /// still end and are kept. Otherwise an answer that had reached it could
    /// be lost, leaving the attempt `sending` for good (R2 of #534).
    pub async fn opencode_revert_confirm(self: &Arc<Self>, id: &str, key: &str) -> Result<Value> {
        let permit = self.admission.enter_work()?;
        let (ws, id, key) = (self.clone(), id.to_owned(), key.to_owned());
        tokio::spawn(async move {
            let _permit = permit;
            ws.opencode_revert_run(&id, &key).await
        })
        .await?
    }

    /// `opencode_revert_confirm`, in its own task.
    async fn opencode_revert_run(self: &Arc<Self>, id: &str, key: &str) -> Result<Value> {
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let (agent, attempt) = (id.to_owned(), key.to_owned());
        if let Some(attempt) = self.stored(move |s| s.rewind_attempt(&agent, Some(&attempt))).await? {
            return Ok(attempt.outcome());
        }
        self.ensure_rewind_settled(id).await?;
        // Taken out under the lock, checked after it: used once, whatever comes of it.
        let taken = PREVIEWS.lock().unwrap().remove(key);
        let p = taken.filter(|p| p.agent == id && p.owner.ptr_eq(&Arc::downgrade(self)))
            .context("这个预览已用过或已过期；没有回退")?;
        ensure!(p.at.elapsed() < TTL, "这个预览已过期，请重新预览；没有回退");
        let read = self.opencode_revert_read(id, &p.turn).await?;
        // 2.x's revert is staged and committed (T-61 slice 6); until then a 2.x revert is only previewed.
        ensure!(!read.v2, "{}；没有回退", crate::opencode_v2::NOT_YET);
        ensure!(read.generation == p.generation && read.session == p.session, "OpenCode 的连接或会话在预览之后变了；没有回退");
        ensure!(read.messages == p.messages, "OpenCode 会话的消息在预览之后变了；没有回退");
        ensure!(read.entries == p.entries && read.root == p.root, "要送回的文件在预览之后变了；没有回退");
        let c = self.opencode_current(id, read.generation).context("OpenCode 连接已变化；没有回退")?;
        // Made now, sent only below: nothing past the attempt is refused before it is asked.
        let request = c.server.revert(&read.session, &p.turn)?;

        // What leaves, as OpenCode holds it and as this Agent's record does, kept with the attempt.
        let native = serde_json::to_string(&read.leaving)?;
        let room = MAX_ARCHIVE.saturating_sub(native.len());
        let (agent, turn) = (id.to_owned(), p.turn.clone());
        let (kept, leaving, local) = self.stored(move |s| {
            let ids = s.turn_ids(&agent)?;
            let at = ids.iter().position(|t| *t == turn).context("这个 Agent 没有这个 Turn；没有回退")?;
            Ok((ids[..at].to_vec(), ids[at..].to_vec(), s.archive(&agent, &ids[at..], room)?))
        }).await?;
        let local = local.context("要回退的内容超出可以留存的大小；没有回退")?;
        let mut plan = Plan { generation: read.generation, messages: read.messages.clone(), entries: read.entries.clone(), root: read.root,
            folder: read.folder.clone(), turns: leaving, ended: None, held: false, sent: false };
        let mut attempt = Attempt {
            id: key.into(), agent: id.into(), thread: read.session.clone(), target: p.turn.clone(), kept,
            draft: read.draft.clone(), state: "sending".into(), message: None, files: None, opencode: Some(serde_json::to_value(&plan)?),
        };
        let saved = attempt.clone();
        self.stored(move |s| s.begin_rewind(&saved, &native, &local)).await?;
        self.changed(id);

        // Each file as it is now, kept before anything is asked.
        let folder = PathBuf::from(&read.folder);
        if let Some(root) = read.root {
            let agent = id.to_owned();
            let settled = self.stored(move |s| s.settled_rewinds(&agent)).await?;
            let (dir, entries, at, key) = (self.data_dir.join("opencode").join(id).join("revert"), read.entries.clone(), folder.clone(), key.to_owned());
            let kept = tokio::task::spawn_blocking(move || {
                std::fs::create_dir_all(&dir)?;
                std::fs::File::open(dir.parent().context("The backups' folder has no parent")?)?.sync_all()?;
                prune(&dir, &settled);
                files::backup(&dir.join(&key), &entries, &at, root, BOUNDS)
            }).await.map_err(anyhow::Error::from).and_then(|kept| kept);
            if let Err(error) = kept {
                attempt.state = "failed".into();
                attempt.message = Some(format!("没有备份好要送回的文件，没有请求回退：{error:#}"));
                return self.opencode_revert_saved(id, &attempt).await;
            }
        }

        // Kept before the one request goes out: from here on OpenCode may have it,
        // and a Core that stops before here asked nothing (R4 of #534).
        #[cfg(test)]
        if stop_at(key, Stop::BeforeSent) {
            bail!("tests: Core ended before the request went out");
        }
        plan.sent = true;
        attempt.opencode = Some(serde_json::to_value(&plan)?);
        let saved = attempt.clone();
        self.stored(move |s| s.save_rewind(&saved)).await?;
        #[cfg(test)]
        if stop_at(key, Stop::AfterSent) {
            let _ = request.await;
            bail!("tests: Core ended once the request was out, before its answer was kept");
        }

        // One request, watched for WATCH. An answer after that settles the attempt when it comes.
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let (owner, agent, key_owned) = (Arc::downgrade(self), id.to_owned(), key.to_owned());
        tokio::spawn(async move {
            let answer = request.await;
            if let Err(answer) = tx.send(answer) {
                if let Some(ws) = owner.upgrade() {
                    if let Err(error) = ws.opencode_revert_late(&agent, &key_owned, answer).await {
                        eprintln!("Workspace OpenCode revert {key_owned} of {agent} answered late, not recorded: {error:#}");
                    }
                }
            }
        });
        match watched(&mut rx, WATCH, || ()).await {
            Some(answer) => {
                #[cfg(test)]
                hold_answered(key).await;
                self.opencode_revert_answered(id, attempt, answer).await
            }
            None => {
                attempt.state = "unknown".into();
                attempt.message = Some(format!("OpenCode 在 {} 秒内没有回答这次回退；结果确认之前这个 Agent 不会收到新的内容，回退也不会再请求一次", WATCH.as_secs()));
                self.opencode_revert_saved(id, &attempt).await
            }
        }
    }

    /// An answer that came after its confirm stopped watching: it settles
    /// the attempt, under the Agent's gate, if nothing else has.
    async fn opencode_revert_late(self: &Arc<Self>, id: &str, key: &str, answer: RevertAnswer) -> Result<Value> {
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let (agent, attempt) = (id.to_owned(), key.to_owned());
        let attempt = self.stored(move |s| s.rewind_attempt(&agent, Some(&attempt))).await?.context("no such attempt")?;
        if !matches!(attempt.state.as_str(), "sending" | "unknown") {
            return Ok(attempt.outcome());
        }
        self.opencode_revert_answered(id, attempt, answer).await
    }

    /// The attempt as the one request's own answer settles it (Lead 3990,
    /// 4109). Answered whole for this session, OpenCode's handler has ended,
    /// which the plan keeps. Reverted when that session holds this revert:
    /// then the Turns it removes leave this Agent's record too (they are in
    /// the attempt's archive), and each file is judged on its own, as it is
    /// now against what it should be and what it was. Holding none, see
    /// `opencode_revert_unmarked`. Failed only when OpenCode refused before
    /// doing anything. Anything else leaves it unknown: its files may have
    /// been sent back in part or whole, and nothing new reaches the Agent.
    async fn opencode_revert_answered(self: &Arc<Self>, id: &str, mut attempt: Attempt, answer: RevertAnswer) -> Result<Value> {
        let mut plan = Plan::of(&attempt)?;
        match answer {
            RevertAnswer::Answered(session) if session["id"] == attempt.thread.as_str() => {
                plan.ended = Some(crate::model::now());
                plan.held = session["revert"]["messageID"] == attempt.target.as_str();
                attempt.opencode = Some(serde_json::to_value(&plan)?);
                if plan.held {
                    self.opencode_revert_record(id, &mut attempt, &plan).await;
                } else {
                    self.opencode_revert_unmarked(id, &mut attempt, &plan).await;
                }
            }
            RevertAnswer::Answered(_) => {
                attempt.state = "unknown".into();
                attempt.message = Some("OpenCode 的回答不是这个会话的；这次回退的结果无法确认，回退不会再请求一次".into());
            }
            RevertAnswer::Refused(status) => {
                attempt.state = "failed".into();
                attempt.message = Some(format!("OpenCode 在开始回退之前拒绝了它，什么也没有做：{status}"));
            }
            RevertAnswer::Unknown(why) => {
                attempt.state = "unknown".into();
                attempt.message = Some(format!("这次回退的结果无法确认（{why}）；结果确认之前这个 Agent 不会收到新的内容，回退也不会再请求一次"));
            }
        }
        self.opencode_revert_saved(id, &attempt).await
    }

    /// Reverted, and recorded so (R3 of #534): once OpenCode has answered,
    /// nothing escapes. If the record cannot be written, the attempt is kept
    /// unknown with its plan's `ended` and `held`, so a later check records
    /// it then; nothing is asked again.
    async fn opencode_revert_record(self: &Arc<Self>, id: &str, attempt: &mut Attempt, plan: &Plan) {
        if let Err(error) = self.opencode_revert_reverted(id, attempt, plan).await {
            attempt.state = "unknown".into();
            attempt.message = Some(format!("OpenCode 已确认这次回退，但没能把它记下（{error:#}）；记下之前这个 Agent 不会收到新的内容，重新核对时会再记一次，回退不会再请求一次"));
        }
    }

    /// Reverted: the session holds it. Each file is judged as it is now.
    async fn opencode_revert_reverted(self: &Arc<Self>, id: &str, attempt: &mut Attempt, plan: &Plan) -> Result<()> {
        let outcomes = match plan.root {
            Some(root) => {
                let (entries, folder) = (plan.entries.clone(), PathBuf::from(&plan.folder));
                tokio::task::spawn_blocking(move || files::outcomes(&entries, &folder, root, BOUNDS)).await?
            }
            None => Vec::new(),
        };
        let mut listed = Vec::new();
        for (entry, outcome) in plan.entries.iter().zip(&outcomes) {
            let mut file = serde_json::to_value(outcome)?;
            file["path"] = entry.target.file.clone().into();
            listed.push(file);
        }
        attempt.files = Some(Value::Array(listed));
        self.opencode_revert_project(id, attempt, plan).await?;
        let unverified = outcomes.iter().filter(|o| !matches!(o, Outcome::Verified)).count();
        attempt.state = "completed".into();
        attempt.message = Some(if unverified == 0 {
            "已回退；OpenCode 会在这个会话收到下一条消息时删去这些消息".into()
        } else {
            format!("已回退，但有 {unverified} 个文件不是快照里的内容；没有自动覆盖，请查看每个文件的结果")
        });
        Ok(())
    }

    /// The request ended, yet the session holds no revert (Lead 4109 3):
    /// that alone does not say it changed nothing, since OpenCode changes the
    /// files before it keeps the revert. Read again, whole, under the gate:
    /// only if the Agent passes every check a preview makes, the session's
    /// messages are as the plan read them and every file is as it was before
    /// the request, nothing is kept of the revert and the attempt holds the
    /// Agent back no longer (no Turn leaves, no draft comes back). Otherwise
    /// it stays unknown, with what differs.
    async fn opencode_revert_unmarked(self: &Arc<Self>, id: &str, attempt: &mut Attempt, plan: &Plan) {
        let differs = match self.opencode_revert_read(id, &attempt.target).await {
            Ok(read) if read.session == attempt.thread && read.messages == plan.messages && read.entries == plan.entries && read.root == plan.root => None,
            Ok(read) if read.session != attempt.thread || read.messages != plan.messages => Some("会话或它的消息与执行前不同".to_owned()),
            Ok(_) => Some("要送回的文件与执行前不同".to_owned()),
            Err(error) => Some(format!("没能再次核对：{error:#}")),
        };
        match differs {
            None => {
                attempt.state = "unchanged".into();
                attempt.message = Some("OpenCode 的请求已结束，但没有确认回退；再次读到的会话消息和每个文件都与执行前一致，没有保留回退的结果，这个 Agent 可以照常使用".into());
            }
            Some(why) => {
                attempt.state = "unknown".into();
                attempt.message = Some(format!("OpenCode 的请求已结束，但没有确认回退；{why}。结果确认之前这个 Agent 不会收到新的内容，回退也不会再请求一次"));
            }
        }
    }

    /// An OpenCode attempt checked again (`/rewind/check`, under the gate,
    /// which a confirm holds while it runs: one still `sending` here is one
    /// whose confirm ended without settling it, as when Core stopped).
    /// - Never sent: nothing was asked, so it failed (R4 of #534).
    /// - Answered holding the revert but not recorded: recorded now.
    /// - Answered with no revert held: read again (`opencode_revert_unmarked`).
    /// - Sent with no answer kept: settled only by a session that holds this
    ///   revert (`opencode_revert_held`); otherwise it stays unknown.
    pub(crate) async fn opencode_revert_recheck(self: &Arc<Self>, id: &str, mut attempt: Attempt) -> Result<Value> {
        let mut plan = Plan::of(&attempt)?;
        let answered = plan.ended.is_some();
        match attempt.state.as_str() {
            "sending" if !plan.sent => {
                let backup = self.data_dir.join("opencode").join(id).join("revert").join(&attempt.id);
                attempt.state = "failed".into();
                attempt.message = Some(if plan.root.is_some() {
                    format!("Core 在请求回退之前停止了，OpenCode 没有被请求，什么也没有做；要送回的文件的备份（如果已写下）在 {}", backup.display())
                } else {
                    "Core 在请求回退之前停止了，OpenCode 没有被请求，什么也没有做".into()
                });
            }
            "unknown" if answered && plan.held => self.opencode_revert_record(id, &mut attempt, &plan).await,
            "unknown" if answered => self.opencode_revert_unmarked(id, &mut attempt, &plan).await,
            "sending" | "unknown" => self.opencode_revert_held(id, &mut attempt, &mut plan).await,
            _ => return Ok(attempt.outcome()),
        }
        self.opencode_revert_saved(id, &attempt).await
    }

    /// Sent, with no answer of it kept (Core stopped while it was out, or it
    /// never came or could not be read): the session read now. OpenCode keeps
    /// a revert only once it has sent the files back (`session/revert.ts`
    /// 71-79: `snap.revert`, then `setRevert`), so a session holding this one
    /// is recorded as reverted. Holding none, or not read, it stays unknown:
    /// OpenCode may have changed files before it stopped, and its Git may
    /// still be going on (Lead 4109); nothing is guessed or asked again.
    async fn opencode_revert_held(self: &Arc<Self>, id: &str, attempt: &mut Attempt, plan: &mut Plan) {
        let c = self.opencodes.lock().unwrap().get(id).cloned();
        let read = match c {
            Some(c) => c.server.session(&attempt.thread).await,
            None => Err(anyhow!("OpenCode Agent 尚未连接")),
        };
        match read {
            Ok(session) if session["id"] == attempt.thread.as_str() && session["revert"]["messageID"] == attempt.target.as_str() => {
                plan.ended = Some(crate::model::now());
                plan.held = true;
                match serde_json::to_value(&*plan) {
                    Ok(value) => {
                        attempt.opencode = Some(value);
                        self.opencode_revert_record(id, attempt, plan).await;
                    }
                    Err(error) => {
                        attempt.state = "unknown".into();
                        attempt.message = Some(format!("OpenCode 的会话保留着这次回退，但没能把它记下（{error:#}）；回退不会再请求一次"));
                    }
                }
            }
            Ok(_) => {
                attempt.state = "unknown".into();
                attempt.message = Some("这次回退的请求没有留下回答，OpenCode 的会话现在也没有保留它；它是否改过文件无从得知。这个 Agent 不会收到新的内容，回退也不会再请求一次".into());
            }
            Err(error) => {
                attempt.state = "unknown".into();
                attempt.message = Some(format!("没有读到 OpenCode 会话（{error:#}）；连接后再核对。回退不会再请求一次"));
            }
        }
    }

    /// The Turns a revert archived leave this Agent's record, with any
    /// request of theirs: exactly those, whatever else the record holds.
    /// Once none of them is left there, nothing more is written.
    async fn opencode_revert_project(&self, id: &str, attempt: &Attempt, plan: &Plan) -> Result<()> {
        #[cfg(test)]
        if FAIL_RECORD.lock().unwrap().take_if(|key| *key == attempt.id).is_some() {
            bail!("tests: the record write failed");
        }
        let (agent, kept, key, removed) = (id.to_owned(), attempt.kept.clone(), attempt.id.clone(), plan.turns.clone());
        self.stored(move |s| {
            let ids = s.turn_ids(&agent)?;
            if !removed.iter().any(|t| ids.contains(t)) {
                return Ok(());
            }
            let gone = removed.clone();
            s.record_event(&agent, "opencode/reverted", &json!({"attemptId": key, "keptTurnIds": kept}), Sel::Turns(removed), move |d| {
                let leaves = |turn: Option<&str>| turn.is_some_and(|turn| gone.iter().any(|g| g == turn));
                d.turns.retain(|t| !leaves(t["id"].as_str()));
                d.pending.retain(|p| !leaves(p.params["turnId"].as_str()));
            })?;
            Ok(())
        }).await
    }

    async fn opencode_revert_saved(&self, id: &str, attempt: &Attempt) -> Result<Value> {
        let saved = attempt.clone();
        self.stored(move |s| s.save_rewind(&saved)).await?;
        self.changed(id);
        Ok(attempt.outcome())
    }
}

/// Removes from `dir` the backups of `settled` attempts (newest first) past
/// the newest KEPT_BACKUPS of them that have one. Anything else there is
/// left: an attempt not yet settled, or a name no attempt of this Agent has.
/// What cannot be removed is said and left; it never stops a revert.
fn prune(dir: &Path, settled: &[String]) {
    let backups = settled.iter().filter(|id| {
        let mut parts = Path::new(id.as_str()).components();
        matches!((parts.next(), parts.next()), (Some(std::path::Component::Normal(_)), None))
            && std::fs::symlink_metadata(dir.join(id)).is_ok_and(|m| m.is_dir())
    });
    for id in backups.skip(KEPT_BACKUPS) {
        if let Err(error) = std::fs::remove_dir_all(dir.join(id)) {
            eprintln!("Workspace OpenCode revert backup {} not removed: {error}", dir.join(id).display());
        }
    }
}

#[cfg(test)]
#[path = "opencode_revert_tests.rs"]
mod tests;
