//! Reverting an OpenCode Agent's session to before one of its Turns (T-10
//! Revert; contract on T-10 #3331 and its comments, Lead 3985, 3990, 4002,
//! 4016, 4019, 4036, 4037, 4051, 4092). A preview is read without a write.
//! What the revert would do to the Agent's files is worked out from
//! OpenCode's own snapshots (`opencode_revert_files`): every file it would
//! send back must come out known before anything is shown as revertable,
//! or nothing is. A preview lasts TTL and is what a confirm must read again
//! unchanged. A confirm keeps its attempt as a rewind's is kept
//! (`rewind::Attempt`), so that from before its one request until its
//! outcome is known nothing new reaches the Agent; then backs up each file
//! and asks OpenCode once.
use super::*;
use crate::opencode::RevertAnswer;
use crate::opencode_revert_files::{self as files, Entry, Outcome, Root, BOUNDS};
use crate::rewind::{Attempt, MAX_ARCHIVE};
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

/// What a revert to before a Turn would do, as read now.
pub(super) struct Read {
    pub generation: u64,
    pub session: String,
    pub messages: String,
    /// The Agent's folder.
    pub folder: String,
    /// The session's messages from the Turn's own on, as read: what leaves.
    pub leaving: Vec<Value>,
    pub entries: Vec<Entry>,
    pub root: Option<Root>,
    /// The Turns that would leave the conversation (this one and later), and those kept.
    pub removed: usize,
    pub kept: usize,
    pub draft: String,
}

impl Workspace {
    /// What reverting this OpenCode Agent's session to before `turn` would
    /// do, read without a write (see the module): the Turns that leave, and
    /// each file OpenCode would send back, with what it should become and
    /// what it is now. Kept for TTL under the ID it answers with.
    pub async fn opencode_revert_preview(self: &Arc<Self>, id: &str, turn: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
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
    /// known from how it was started, its `/path` agrees with that, and every
    /// file comes out known (`opencode_revert_files::plan`).
    pub(super) async fn opencode_revert_read(self: &Arc<Self>, id: &str, turn: &str) -> Result<Read> {
        // What a send checks, with this Turn among the Turns read; and where it is among all of them.
        self.ensure_rewind_settled(id).await?;
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
        let list = messages.as_array().context(unread)?;
        let folder = d.agent.cwd.clone();
        let path = c.server.path().await.context(unread)?;
        ensure!(path["directory"] == folder.as_str(), "OpenCode 的工作目录不是这个 Agent 的目录；没有预览回退");
        let worktree = path["worktree"].as_str().context("OpenCode 没有说它的 worktree；没有预览回退")?.to_owned();
        let project = c.server.project().await.context(unread)?;
        let project = project["id"].as_str().context("OpenCode 没有说它的项目；没有预览回退")?.to_owned();
        ensure!(session["projectID"] == project.as_str(), "OpenCode 会话不属于它现在的项目；没有预览回退");
        let targets = files::targets(list, turn, &worktree, &folder)?;
        let (entries, root) = if targets.is_empty() {
            (Vec::new(), None)
        } else {
            let started = c.files.as_ref().as_ref()
                .map_err(|why| anyhow!("这次回退会改动文件，而无法事先核对它们会变成什么（{why}）；没有预览回退"))?;
            started.launcher.check()?;
            started.launcher.bound(c.server.pid().context("OpenCode's process has no ID")?)?;
            started.roots.agrees(&path)?;
            let store = files::store(&started.roots.data, &project, &worktree)?;
            let root = Root::of(Path::new(&folder))?;
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
        let from = list.iter().position(|m| m["info"]["id"] == turn).context("OpenCode 会话里没有这一轮的消息；没有预览回退")?;
        Ok(Read { generation: c.generation, session: c.session.clone(), messages: digest, folder, leaving: list[from..].to_vec(), entries, root,
            removed: total - kept, kept, draft })
    }

    /// Reverts the session as the preview `key` showed it (see the module).
    /// Refused, with nothing written, unless everything the preview read is
    /// read again the same: the connection, the session, its whole message
    /// list and each file. Then the attempt is kept, `sending`; each file is
    /// backed up into this Agent's folder (if it cannot be, nothing is asked);
    /// and OpenCode is asked once, watched for WATCH. Asked again for the
    /// same preview, it answers that attempt as it stands and asks nothing.
    pub async fn opencode_revert_confirm(self: &Arc<Self>, id: &str, key: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
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
        let (kept, local) = self.stored(move |s| {
            let ids = s.turn_ids(&agent)?;
            let at = ids.iter().position(|t| *t == turn).context("这个 Agent 没有这个 Turn；没有回退")?;
            Ok((ids[..at].to_vec(), s.archive(&agent, &ids[at..], room)?))
        }).await?;
        let local = local.context("要回退的内容超出可以留存的大小；没有回退")?;
        let mut attempt = Attempt {
            id: key.into(), agent: id.into(), thread: read.session.clone(), target: p.turn.clone(), kept,
            draft: read.draft.clone(), state: "sending".into(), message: None, files: None,
        };
        let saved = attempt.clone();
        self.stored(move |s| s.begin_rewind(&saved, &native, &local)).await?;
        self.changed(id);

        // Each file as it is now, kept before anything is asked.
        let folder = PathBuf::from(&read.folder);
        if let Some(root) = read.root {
            let (dir, entries, at, key) = (self.data_dir.join("opencode").join(id).join("revert"), read.entries.clone(), folder.clone(), key.to_owned());
            let kept = tokio::task::spawn_blocking(move || {
                std::fs::create_dir_all(&dir)?;
                std::fs::File::open(dir.parent().context("The backups' folder has no parent")?)?.sync_all()?;
                files::backup(&dir.join(&key), &entries, &at, root, BOUNDS)
            }).await.map_err(anyhow::Error::from).and_then(|kept| kept);
            if let Err(error) = kept {
                attempt.state = "failed".into();
                attempt.message = Some(format!("没有备份好要送回的文件，没有请求回退：{error:#}"));
                return self.opencode_revert_saved(id, &attempt).await;
            }
        }

        // One request, watched for WATCH. An answer after that settles the attempt when it comes.
        let (tx, rx) = tokio::sync::oneshot::channel();
        let (owner, agent, key_owned, entries, root, at) = (Arc::downgrade(self), id.to_owned(), key.to_owned(), read.entries.clone(), read.root, folder.clone());
        tokio::spawn(async move {
            let answer = request.await;
            if let Err(answer) = tx.send(answer) {
                if let Some(ws) = owner.upgrade() {
                    if let Err(error) = ws.opencode_revert_late(&agent, &key_owned, answer, &entries, root, &at).await {
                        eprintln!("Workspace OpenCode revert {key_owned} of {agent} answered late, not recorded: {error:#}");
                    }
                }
            }
        });
        match tokio::time::timeout(WATCH, rx).await {
            Ok(Ok(answer)) => self.opencode_revert_answered(id, attempt, answer, &read.entries, read.root, &folder).await,
            _ => {
                attempt.state = "unknown".into();
                attempt.message = Some(format!("OpenCode 在 {} 秒内没有回答这次回退；结果确认之前这个 Agent 不会收到新的内容，回退也不会再请求一次", WATCH.as_secs()));
                self.opencode_revert_saved(id, &attempt).await
            }
        }
    }

    /// An answer that came after its confirm stopped watching: it settles
    /// the attempt, under the Agent's gate, if nothing else has.
    async fn opencode_revert_late(self: &Arc<Self>, id: &str, key: &str, answer: RevertAnswer, entries: &[Entry], root: Option<Root>, folder: &Path) -> Result<Value> {
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let (agent, attempt) = (id.to_owned(), key.to_owned());
        let attempt = self.stored(move |s| s.rewind_attempt(&agent, Some(&attempt))).await?.context("no such attempt")?;
        if !matches!(attempt.state.as_str(), "sending" | "unknown") {
            return Ok(attempt.outcome());
        }
        self.opencode_revert_answered(id, attempt, answer, entries, root, folder).await
    }

    /// The attempt as OpenCode's answer settles it (Lead 3990). Reverted
    /// only when the session it answers holds this revert: then the Turns it
    /// removes leave this Agent's record too (they are in the attempt's
    /// archive), and each file is judged as it is now against what it should
    /// be and what it was. Failed only when OpenCode refused before doing
    /// anything. Anything else leaves it unknown: its files may have been
    /// sent back in part or whole, and nothing new reaches the Agent.
    async fn opencode_revert_answered(self: &Arc<Self>, id: &str, mut attempt: Attempt, answer: RevertAnswer, entries: &[Entry], root: Option<Root>, folder: &Path) -> Result<Value> {
        match answer {
            RevertAnswer::Answered(session) if session["revert"]["messageID"] == attempt.target.as_str() => {
                let outcomes = match root {
                    Some(root) => {
                        let (entries, folder) = (entries.to_vec(), folder.to_path_buf());
                        tokio::task::spawn_blocking(move || files::outcomes(&entries, &folder, root, BOUNDS)).await?
                    }
                    None => Vec::new(),
                };
                let mut listed = Vec::new();
                for (entry, outcome) in entries.iter().zip(&outcomes) {
                    let mut file = serde_json::to_value(outcome)?;
                    file["path"] = entry.target.file.clone().into();
                    listed.push(file);
                }
                attempt.files = Some(Value::Array(listed));
                self.opencode_revert_project(id, &attempt).await?;
                let unverified = outcomes.iter().filter(|o| !matches!(o, Outcome::Verified)).count();
                attempt.state = "completed".into();
                attempt.message = Some(if unverified == 0 {
                    "已回退；OpenCode 会在这个会话收到下一条消息时删去这些消息".into()
                } else {
                    format!("已回退，但有 {unverified} 个文件不是快照里的内容；没有自动覆盖，请查看每个文件的结果")
                });
            }
            RevertAnswer::Answered(_) => {
                attempt.state = "unknown".into();
                attempt.message = Some("OpenCode 回答了，但会话里没有这次回退；它是否改动了文件无法确认，回退不会再请求一次".into());
            }
            RevertAnswer::Refused(status) => {
                attempt.state = "failed".into();
                attempt.message = Some(format!("OpenCode 没有接受这次回退，什么也没有做：{status}"));
            }
            RevertAnswer::Unknown(why) => {
                attempt.state = "unknown".into();
                attempt.message = Some(format!("这次回退的结果无法确认（{why}）；结果确认之前这个 Agent 不会收到新的内容，回退也不会再请求一次"));
            }
        }
        self.opencode_revert_saved(id, &attempt).await
    }

    /// The Turns a revert removed (all but those it keeps) leave this
    /// Agent's record, with any request of theirs.
    async fn opencode_revert_project(&self, id: &str, attempt: &Attempt) -> Result<()> {
        let (agent, kept, key) = (id.to_owned(), attempt.kept.clone(), attempt.id.clone());
        self.stored(move |s| {
            let removed: Vec<String> = s.turn_ids(&agent)?.into_iter().filter(|t| !kept.contains(t)).collect();
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

#[cfg(test)]
#[path = "opencode_revert_tests.rs"]
mod tests;
