// A Task's workspaces (T-169): the Git working trees on the Core host that
// you registered or created for the Task, who uses each one now, and the
// cleanup of generated Cargo output you select there. Core checks again
// before removing anything; this only shows what it reports.
import { useCallback, useEffect, useState } from "react";
import { FolderGit2, RefreshCw } from "lucide-react";
import { api, errorText, post } from "./api";

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

function gitLine(view: WorkspaceView) {
  const git = view.git;
  if (!git) return null;
  if (git.problem) return `Git: ${git.problem}`;
  const where = git.branch ? `on ${git.branch}` : git.head ? `detached at ${git.head.slice(0, 8)}` : "no commit yet";
  const changes = git.changes?.complete
    ? git.changes.modified || git.changes.untracked
      ? `${git.changes.modified} changed, ${git.changes.untracked} untracked`
      : "no changes"
    : `changes unknown${git.changes?.reason ? ` (${git.changes.reason})` : ""}`;
  const repo = git.repositoryId ? git.origin : git.origin ? `${git.origin}, not linked to this task` : "no GitHub origin";
  return [where, git.head && git.branch ? git.head.slice(0, 8) : null, changes, repo].filter(Boolean).join(" · ");
}

function usersLine(users?: Users) {
  if (!users) return null;
  if (users.problem) return users.problem;
  const agents = (users.agents || []).map((a) => `${a.name} (${a.relation === "inside" ? a.status : `${a.status}, folder above`})`);
  const jobs = (users.liveJobs || []).map((j) => `Job ${j.name || j.id} (${j.status})`);
  const all = [...agents, ...jobs];
  return `${all.length ? `Used by ${all.join(", ")}` : "No Agent or live Job uses it"} · ${users.taskJobs ?? 0} Jobs of this task`;
}

/** Defaults for a new worktree beside the checkout: <checkout>-<branch>. */
function suggested(checkout: string, branch: string) {
  const trimmed = checkout.replace(/\/+$/, "");
  return trimmed && branch ? `${trimmed}-${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}` : "";
}

function Cleanup({ taskId, view }: { taskId: string; view: WorkspaceView }) {
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
      setPreview(await post<Preview>(`${base}/preview`));
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
      setRemoval(await post<Removal>(base, { previewId: preview.id, candidates: [...selected] }));
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
        Preview cleanup
      </button>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {preview && (
        <div className="task-workspace-preview">
          {preview.candidates.length === 0 ? (
            <p className="job-footnote">No Cargo build output was found here.</p>
          ) : (
            <ul aria-label="Cleanup candidates">
              {preview.candidates.map((c) => (
                <li key={c.id}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={c.protected.length > 0}
                      checked={selected.has(c.id)}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.target.checked) next.add(c.id);
                        else next.delete(c.id);
                        setSelected(next);
                      }}
                    />
                    <code>{c.relative}</code> · about {bytes(c.estimate.bytes)}
                    {c.estimate.sharedBytes > 0 && ` (+${bytes(c.estimate.sharedBytes)} hard-linked, may stay)`}
                    {!c.estimate.complete && " · size estimate incomplete"}
                  </label>
                  {c.protected.length > 0 && <p className="task-workspace-kept">Kept: {c.protected.join("; ")}</p>}
                </li>
              ))}
            </ul>
          )}
          {preview.kept.length > 0 && (
            <details>
              <summary>{preview.kept.length} kept</summary>
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
            <p className="job-footnote">The search stopped at its limit after {preview.bounds.visitedFolders} folders: more may exist.</p>
          )}
          <p className="job-footnote">{preview.scope}</p>
          <button type="button" className="secondary-button" disabled={busy || selected.size === 0} onClick={() => void remove()}>
            Remove selected
          </button>
        </div>
      )}
      {removal && (
        <div className="task-workspace-preview" role="status">
          <ul aria-label="Cleanup results">
            {removal.results.map((r) => (
              <li key={r.id}>
                <code>{r.relative || r.id}</code>: {r.state}
                {r.reason && ` · ${r.reason}`}
              </li>
            ))}
          </ul>
          {removal.freedBytes != null && (
            <p className="job-footnote">
              Free space changed by {bytes(Math.max(0, Number(removal.freedBytes)))}
              {Number(removal.freedBytes) < 0 && " (it went down: others wrote meanwhile)"}. {removal.note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskWorkspaces({ taskId, materialsWorktree }: { taskId: string; materialsWorktree?: string | null }) {
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
  const registered = listing?.workspaces.some((w) => w.path === named);
  return (
    <section className="collab-section task-workspaces" aria-label="Workspace">
      <div className="collab-section-heading">
        <h4>
          <FolderGit2 size={15} aria-hidden="true" />
          Workspace
        </h4>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={13} aria-hidden="true" />
          Check again
        </button>
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {listing?.workspaces.map((view) => (
        <div key={view.id} className="task-workspace">
          <p className="task-workspace-path">
            <code>{view.path}</code> · Core host · {view.origin === "created" ? `created on ${view.branch}` : "registered"}
          </p>
          {view.state !== "present" ? (
            <p className="inline-error">{view.problem}</p>
          ) : (
            <>
              <p className="task-workspace-git">{gitLine(view)}</p>
              <p className="task-workspace-users">{usersLine(view.users)}</p>
            </>
          )}
          <div className="task-workspace-actions">
            <Cleanup taskId={taskId} view={view} />
            <button
              type="button"
              className="quiet-button"
              disabled={busy}
              title="Removes only this registration; no file or branch is touched"
              onClick={() => void act(() => api(`${root}/${view.id}`, { method: "DELETE" }))}
            >
              Forget
            </button>
          </div>
        </div>
      ))}
      {listing && listing.workspaces.length === 0 && (
        <p className="job-footnote">No folder is registered for this task. Registering one lets you see who uses it and clean its build output.</p>
      )}
      {named && listing && !registered && (
        <p className="task-workspace-suggestion">
          The task's materials name <code>{named}</code> (information only).{" "}
          <button type="button" className="quiet-button" disabled={busy} onClick={() => void act(() => post(root, { path: named }))}>
            Register it
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
        <input aria-label="Folder to register" placeholder="/path/to/worktree" value={path} onChange={(e) => setPath(e.target.value)} />
        <button type="submit" className="secondary-button" disabled={busy || !path.trim()}>
          Register folder
        </button>
      </form>
      <details open={creating} onToggle={(event) => setCreating((event.target as HTMLDetailsElement).open)}>
        <summary>Create a worktree…</summary>
        <form
          className="task-workspace-create"
          onSubmit={(event) => {
            event.preventDefault();
            const path = target.trim() || suggested(checkout.trim(), branch.trim());
            void act(() => post(`${root}/create`, { repository: checkout.trim(), branch: branch.trim(), base: base.trim(), path }));
          }}
        >
          <label>
            Checkout of a linked repository
            <input value={checkout} onChange={(e) => setCheckout(e.target.value)} placeholder="/path/to/checkout" />
          </label>
          <label>
            New branch
            <input value={branch} onChange={(e) => setBranch(e.target.value)} />
          </label>
          <label>
            From
            <input value={base} onChange={(e) => setBase(e.target.value)} />
          </label>
          <label>
            New folder
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={suggested(checkout.trim(), branch.trim())} />
          </label>
          <button type="submit" className="secondary-button" disabled={busy || !checkout.trim() || !branch.trim()}>
            Create worktree
          </button>
          <p className="job-footnote">Git creates the branch and folder without running hooks; it is registered only once Core verified it.</p>
        </form>
      </details>
    </section>
  );
}
