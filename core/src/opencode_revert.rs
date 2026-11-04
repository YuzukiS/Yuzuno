//! Reverting an OpenCode Agent's session to before one of its Turns (T-10
//! Revert; contract on T-10 #3331 and its comments, Lead 3985, 3990, 4002,
//! 4016, 4019, 4036, 4037, 4051). This is the preview, read without a
//! write. What the revert would do to the Agent's files is worked out from
//! OpenCode's own snapshots (`opencode_revert_files`): every file it would
//! send back must come out known before anything is shown as revertable,
//! or nothing is. A preview lasts TTL and is what a confirm must read again
//! unchanged.
use super::*;
use crate::opencode_revert_files::{self as files, Entry, Root, BOUNDS};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::LazyLock;
use std::time::Instant;

const TTL: Duration = Duration::from_secs(600);

/// A preview as it was read, for a confirm to match.
#[allow(dead_code)]
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
    /// progress, no request pending, no compaction or message whose outcome is
    /// not known), its session idle with no revert waiting in it, and `turn`
    /// one of its Turns whose message the session holds. With files to send
    /// back, also unless where OpenCode keeps its snapshots is known from how
    /// it was started, its `/path` agrees with that, the session is its
    /// project's, and every file comes out known (`opencode_revert_files::plan`).
    pub(super) async fn opencode_revert_read(self: &Arc<Self>, id: &str, turn: &str) -> Result<Read> {
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        ensure!(d.agent.harness == "opencode", "Agent 不是 OpenCode");
        if let Some(blocked) = compaction_blocks(&d, "没有预览回退") {
            bail!(blocked);
        }
        ensure!(!d.message_receipts.iter().any(|r| matches!(r.status.as_str(), "sending" | "uncertain")),
            "上一条消息的发送结果尚未确认，请先重连核对；没有预览回退");
        ensure!(!busy(&d), "OpenCode 正在执行或等待回应；回退只在空闲时进行，没有预览回退");
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
        let targets = files::targets(list, turn, &worktree, &folder)?;
        let (entries, root) = if targets.is_empty() {
            (Vec::new(), None)
        } else {
            let started = c.files.as_ref().as_ref()
                .map_err(|why| anyhow!("这次回退会改动文件，而无法事先核对它们会变成什么（{why}）；没有预览回退"))?;
            started.launcher.check()?;
            started.launcher.bound(c.server.pid().context("OpenCode's process has no ID")?)?;
            started.roots.agrees(&path)?;
            let project = c.server.project().await.context(unread)?;
            let project = project["id"].as_str().context("OpenCode 没有说它的项目；没有预览回退")?.to_owned();
            ensure!(session["projectID"] == project.as_str(), "OpenCode 会话不属于它现在的项目；没有预览回退");
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
        Ok(Read { generation: c.generation, session: c.session.clone(), messages: digest, entries, root,
            removed: d.turns.len() - index, kept: index, draft })
    }
}

#[cfg(test)]
#[path = "opencode_revert_tests.rs"]
mod tests;
