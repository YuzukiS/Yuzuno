// A Task's workspaces (T-169): the Git working trees on the Core host that
// you registered or created for the Task, who uses each one now, and the
// cleanup of generated Cargo output you select there. Core checks again
// before removing anything; this only shows what it reports.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FolderGit2, RefreshCw } from "lucide-react";
import { api, errorText, post } from "./api";
import { strings, useStrings } from "./i18n";

type Users = {
  agents?: { id: string; name: string; status: string; relation: "inside" | "above"; working: boolean }[];
  liveJobs?: { id: string; name: string | null; status: string }[];
  taskJobs?: number;
  problem?: string;
};
type WorkspaceView = {
  id: string;
  path: string;
  origin: "created" | "registered";
  branch?: string | null;
  baseSha?: string;
  state: "present" | "changed" | "unknown";
  problem?: string;
  git?: {
    branch?: string | null;
    head?: string | null;
    origin?: string | null;
    repositoryId?: number | null;
    sameRepository?: boolean;
    changes?: { modified?: number; untracked?: number; complete: boolean; reason?: string };
    problem?: string;
  };
  users?: Users;
};
type Listing = { taskId: string; workspaces: WorkspaceView[]; repositories: { id: number; fullName: string }[] };
type Candidate = {
  id: string;
  relative: string;
  kind: string;
  estimate: { bytes: number; sharedBytes: number; files: number; complete: boolean };
  protected: string[];
};
type Preview = {
  id: string;
  expiresAt: string;
  candidates: Candidate[];
  kept: { path: string; reason: string }[];
  bounds: { complete: boolean; visitedFolders: number };
  scope: string;
};
type Removal = {
  results: { id: string; relative?: string; state: "removed" | "refused" | "partial" | "failed"; reason?: string }[];
  freedBytes?: string | null;
  note: string;
};

export function bytes(n: number) {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GiB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MiB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KiB`;
  return `${n} B`;
}

// A task's workspaces in the interface language (T-189). Paths, branches,
// commits, the origin, names, Agent and Job states, cleanup states' reasons,
// and what Core and Git said are shown as they are.
const workspacesText = strings({
  title: "Workspace",
  checkAgain: "Check again",
  host: "Core host",
  createdOn: (branch: string | null | undefined) => `created on ${branch}`,
  registered: "registered",
  git: (problem: string) => `Git: ${problem}`,
  on: (branch: string) => `on ${branch}`,
  detached: (sha: string) => `detached at ${sha}`,
  noCommit: "no commit yet",
  changes: (modified: number | undefined, untracked: number | undefined) => `${modified} changed, ${untracked} untracked`,
  noChanges: "no changes",
  changesUnknown: (reason: string | undefined) => `changes unknown${reason ? ` (${reason})` : ""}`,
  notLinked: (origin: string) => `${origin}, not linked to this task`,
  noOrigin: "no GitHub origin",
  agent: (name: string, status: string, above: boolean) => `${name} (${above ? `${status}, folder above` : status})`,
  job: (name: string, status: string) => `Job ${name} (${status})`,
  usedBy: (users: string) => `Used by ${users}`,
  unused: "No Agent or live Job uses it",
  taskJobs: (count: number) => `${count} Jobs of this task`,
  list: ", ",
  preview: "Preview cleanup",
  noOutput: "No Cargo build output was found here.",
  candidates: "Cleanup candidates",
  about: (size: string) => `about ${size}`,
  shared: (size: string) => ` (+${size} hard-linked, may stay)`,
  incomplete: " · size estimate incomplete",
  kept: (reasons: string) => `Kept: ${reasons}`,
  keptCount: (count: number) => `${count} kept`,
  stopped: (folders: number) => `The search stopped at its limit after ${folders} folders: more may exist.`,
  remove: "Remove selected",
  results: "Cleanup results",
  states: { removed: "removed", refused: "refused", partial: "partial", failed: "failed" } as Record<string, string>,
  freed: (size: string, down: boolean, note: string) => `Free space changed by ${size}${down ? " (it went down: others wrote meanwhile)" : ""}. ${note}`,
  forget: "Forget",
  forgetTip: "Removes only this registration; no file or branch is touched",
  none: "No folder is registered for this task. Registering one lets you see who uses it and clean its build output.",
  materials: (path: ReactNode): ReactNode => <>The task's materials name {path} (information only).</>,
  registerIt: "Register it",
  folder: "Folder to register",
  register: "Register folder",
  create: "Create a worktree…",
  checkout: "Checkout of a linked repository",
  branch: "New branch",
  from: "From",
  newFolder: "New folder",
  createWorktree: "Create worktree",
  createNote: "Git creates the branch and folder without running hooks; it is registered only once Core verified it.",
}, {
  title: "工作区",
  checkAgain: "再次检查",
  host: "Core 主机",
  createdOn: (branch) => `在 ${branch} 上创建`,
  registered: "已登记",
  git: (problem) => `Git：${problem}`,
  on: (branch) => `在 ${branch} 上`,
  detached: (sha) => `分离于 ${sha}`,
  noCommit: "还没有提交",
  changes: (modified, untracked) => `${modified} 个已修改，${untracked} 个未跟踪`,
  noChanges: "没有改动",
  changesUnknown: (reason) => `改动未知${reason ? `（${reason}）` : ""}`,
  notLinked: (origin) => `${origin}，未链接到此任务`,
  noOrigin: "没有 GitHub origin",
  agent: (name, status, above) => `${name}（${above ? `${status}，在上层文件夹` : status}）`,
  job: (name, status) => `Job ${name}（${status}）`,
  usedBy: (users) => `正在使用：${users}`,
  unused: "没有 Agent 或运行中的 Job 在使用",
  taskJobs: (count) => `此任务的 ${count} 个 Job`,
  list: "、",
  preview: "预览清理",
  noOutput: "这里没有找到 Cargo 构建输出。",
  candidates: "清理候选",
  about: (size) => `约 ${size}`,
  shared: (size) => `（另有 ${size} 为硬链接，可能保留）`,
  incomplete: " · 大小估计不完整",
  kept: (reasons) => `保留：${reasons}`,
  keptCount: (count) => `保留 ${count} 项`,
  stopped: (folders) => `搜索在 ${folders} 个文件夹后达到上限：可能还有更多。`,
  remove: "删除所选",
  results: "清理结果",
  states: { removed: "已删除", refused: "被拒绝", partial: "部分删除", failed: "失败" },
  freed: (size, down, note) => `可用空间变化了 ${size}${down ? "（减少了：期间有其他写入）" : ""}。${note}`,
  forget: "移除登记",
  forgetTip: "只移除此登记；不会动任何文件或分支",
  none: "此任务还没有登记文件夹。登记后可以看到谁在使用它，并清理它的构建输出。",
  materials: (path) => <>任务材料中提到了 {path}（仅供参考）。</>,
  registerIt: "登记它",
  folder: "要登记的文件夹",
  register: "登记文件夹",
  create: "创建 worktree…",
  checkout: "已链接仓库的 checkout",
  branch: "新分支",
  from: "起点",
  newFolder: "新文件夹",
  createWorktree: "创建 worktree",
  createNote: "Git 创建分支和文件夹时不运行 hooks；Core 核实之后才会登记。",
});
type WorkspacesText = ReturnType<typeof workspacesText>;

function gitLine(view: WorkspaceView, t: WorkspacesText) {
  const git = view.git;
  if (!git) return null;
  if (git.problem) return t.git(git.problem);
  const where = git.branch ? t.on(git.branch) : git.head ? t.detached(git.head.slice(0, 8)) : t.noCommit;
  const changes = git.changes?.complete
    ? git.changes.modified || git.changes.untracked
      ? t.changes(git.changes.modified, git.changes.untracked)
      : t.noChanges
    : t.changesUnknown(git.changes?.reason);
  const repo = git.repositoryId ? git.origin : git.origin ? t.notLinked(git.origin) : t.noOrigin;
  return [where, git.head && git.branch ? git.head.slice(0, 8) : null, changes, repo].filter(Boolean).join(" · ");
}

function usersLine(users: Users | undefined, t: WorkspacesText) {
  if (!users) return null;
  if (users.problem) return users.problem;
  const agents = (users.agents || []).map((a) => t.agent(a.name, a.status, a.relation !== "inside"));
  const jobs = (users.liveJobs || []).map((j) => t.job(j.name || j.id, j.status));
  const all = [...agents, ...jobs];
  return `${all.length ? t.usedBy(all.join(t.list)) : t.unused} · ${t.taskJobs(users.taskJobs ?? 0)}`;
}

/** Defaults for a new worktree beside the checkout: <checkout>-<branch>. */
function suggested(checkout: string, branch: string) {
  const trimmed = checkout.replace(/\/+$/, "");
  return trimmed && branch ? `${trimmed}-${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}` : "";
}

function Cleanup({ taskId, view }: { taskId: string; view: WorkspaceView }) {
  const t = useStrings(workspacesText);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/tasks/${encodeURIComponent(taskId)}/workspaces/${view.id}/cleanup`;
  async function look() {
    setBusy(true);
    setError("");
    setRemoval(null);
    setSelected(new Set());
    try {
      const value = await post<Preview>(`${base}/preview`);
      setPreview({ ...value, candidates: value?.candidates ?? [], kept: value?.kept ?? [], bounds: value?.bounds ?? { complete: false, visitedFolders: 0 } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const value = await post<Removal>(base, { previewId: preview.id, candidates: [...selected] });
      setRemoval({ ...value, results: value?.results ?? [] });
      // A preview is used once: what remains is looked at again.
      setPreview(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="task-workspace-cleanup">
      <button type="button" className="secondary-button" disabled={busy || view.state !== "present"} onClick={() => void look()}>
        {t.preview}
      </button>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {preview && (
        <div className="task-workspace-preview">
          {preview.candidates.length === 0 ? (
            <p className="job-footnote">{t.noOutput}</p>
          ) : (
            <ul aria-label={t.candidates}>
              {preview.candidates.map((c) => (
                <li key={c.id}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={c.protected?.length !== 0}
                      checked={selected.has(c.id)}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.target.checked) next.add(c.id);
                        else next.delete(c.id);
                        setSelected(next);
                      }}
                    />
                    <code>{c.relative}</code> · {t.about(bytes(c.estimate?.bytes ?? 0))}
                    {(c.estimate?.sharedBytes ?? 0) > 0 && t.shared(bytes(c.estimate.sharedBytes))}
                    {!c.estimate?.complete && t.incomplete}
                  </label>
                  {!!c.protected?.length && <p className="task-workspace-kept">{t.kept(c.protected.join("; "))}</p>}
                </li>
              ))}
            </ul>
          )}
          {preview.kept.length > 0 && (
            <details>
              <summary>{t.keptCount(preview.kept.length)}</summary>
              <ul>
                {preview.kept.map((k) => (
                  <li key={k.path}>
                    <code>{k.path}</code>: {k.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!preview.bounds.complete && (
            <p className="job-footnote">{t.stopped(preview.bounds.visitedFolders)}</p>
          )}
          <p className="job-footnote">{preview.scope}</p>
          <button type="button" className="secondary-button" disabled={busy || selected.size === 0} onClick={() => void remove()}>
            {t.remove}
          </button>
        </div>
      )}
      {removal && (
        <div className="task-workspace-preview" role="status">
          <ul aria-label={t.results}>
            {removal.results.map((r) => (
              <li key={r.id}>
                <code>{r.relative || r.id}</code>: {t.states[r.state] || r.state}
                {r.reason && ` · ${r.reason}`}
              </li>
            ))}
          </ul>
          {removal.freedBytes != null && (
            <p className="job-footnote">
              {t.freed(bytes(Math.max(0, Number(removal.freedBytes))), Number(removal.freedBytes) < 0, removal.note)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskWorkspaces({ taskId, materialsWorktree, focused = false }: {
  taskId: string;
  materialsWorktree?: string | null;
  /** Opened here (from Data & storage): brought into view; nothing is run. */
  focused?: boolean;
}) {
  const t = useStrings(workspacesText);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focused) return;
    section.current?.scrollIntoView?.({ block: "start" });
    section.current?.querySelector<HTMLElement>("h4")?.focus();
  }, [focused]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState("");
  const [creating, setCreating] = useState(false);
  const [checkout, setCheckout] = useState(materialsWorktree || "");
  const [branch, setBranch] = useState(taskId.toLowerCase());
  const [base, setBase] = useState("origin/main");
  const [target, setTarget] = useState("");
  const root = `/tasks/${encodeURIComponent(taskId)}/workspaces`;
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setListing(await api<Listing>(root));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [root]);
  useEffect(() => {
    void load();
  }, [load]);
  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await run();
      await load();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  const named = materialsWorktree?.trim();
  // Whatever Core answers, the task page keeps rendering.
  const workspaces = Array.isArray(listing?.workspaces) ? listing.workspaces : [];
  const registered = workspaces.some((w) => w.path === named);
  return (
    <section ref={section} className="collab-section task-workspaces" aria-label={t.title}>
      <div className="collab-section-heading">
        <h4 tabIndex={-1}>
          <FolderGit2 size={15} aria-hidden="true" />
          {t.title}
        </h4>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={13} aria-hidden="true" />
          {t.checkAgain}
        </button>
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {workspaces.map((view) => (
        <div key={view.id} className="task-workspace">
          <p className="task-workspace-path">
            <code>{view.path}</code> · {t.host} · {view.origin === "created" ? t.createdOn(view.branch) : t.registered}
          </p>
          {view.state !== "present" ? (
            <p className="inline-error">{view.problem}</p>
          ) : (
            <>
              <p className="task-workspace-git">{gitLine(view, t)}</p>
              <p className="task-workspace-users">{usersLine(view.users, t)}</p>
            </>
          )}
          <div className="task-workspace-actions">
            <Cleanup taskId={taskId} view={view} />
            <button
              type="button"
              className="quiet-button"
              disabled={busy}
              title={t.forgetTip}
              onClick={() => void act(() => api(`${root}/${view.id}`, { method: "DELETE" }))}
            >
              {t.forget}
            </button>
          </div>
        </div>
      ))}
      {listing && workspaces.length === 0 && (
        <p className="job-footnote">{t.none}</p>
      )}
      {named && listing && !registered && (
        <p className="task-workspace-suggestion">
          {t.materials(<code>{named}</code>)}{" "}
          <button type="button" className="quiet-button" disabled={busy} onClick={() => void act(() => post(root, { path: named }))}>
            {t.registerIt}
          </button>
        </p>
      )}
      <form
        className="task-workspace-form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await post(root, { path: path.trim() });
            setPath("");
          });
        }}
      >
        <input aria-label={t.folder} placeholder="/path/to/worktree" value={path} onChange={(e) => setPath(e.target.value)} />
        <button type="submit" className="secondary-button" disabled={busy || !path.trim()}>
          {t.register}
        </button>
      </form>
      <details open={creating} onToggle={(event) => setCreating((event.target as HTMLDetailsElement).open)}>
        <summary>{t.create}</summary>
        <form
          className="task-workspace-create"
          onSubmit={(event) => {
            event.preventDefault();
            const path = target.trim() || suggested(checkout.trim(), branch.trim());
            void act(() => post(`${root}/create`, { repository: checkout.trim(), branch: branch.trim(), base: base.trim(), path }));
          }}
        >
          <label>
            {t.checkout}
            <input value={checkout} onChange={(e) => setCheckout(e.target.value)} placeholder="/path/to/checkout" />
          </label>
          <label>
            {t.branch}
            <input value={branch} onChange={(e) => setBranch(e.target.value)} />
          </label>
          <label>
            {t.from}
            <input value={base} onChange={(e) => setBase(e.target.value)} />
          </label>
          <label>
            {t.newFolder}
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={suggested(checkout.trim(), branch.trim())} />
          </label>
          <button type="submit" className="secondary-button" disabled={busy || !checkout.trim() || !branch.trim()}>
            {t.createWorktree}
          </button>
          <p className="job-footnote">{t.createNote}</p>
        </form>
      </details>
    </section>
  );
}
