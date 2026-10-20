import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import "./pr-operations.css";

type Remote = {
  number: number;
  url: string;
  title: string;
  body?: string;
  draft: boolean;
  state: string;
  baseSha: string;
  headSha: string;
};
type Operation = {
  id: string;
  cursor: number;
  requestId: string;
  attempt: number;
  status: string;
  phase: string;
  repository: string;
  input: {
    action: string;
    base: string;
    head: string;
    title: string;
    body?: string;
    draft?: boolean;
    number?: number;
  };
  createdAt: string;
  finishedAt: string | null;
  remote: Remote | null;
  candidates: Remote[];
  outcome?: string;
  linked: boolean;
  error: string | null;
  associationError: string | null;
  notificationRecipient: { id: string; name: string } | null;
  notificationId: string | null;
  writeError?: string;
  history?: {
    attempt: number;
    status: string;
    finishedAt: string;
    error?: string;
  }[];
};
type Page = {
  operations: Operation[];
  repositories: { id: number; fullName: string }[];
  hasMore: boolean;
  nextBefore: number | null;
};
const active = (r: Operation) => ["accepted", "running"].includes(r.status);
const labels: Record<string, string> = {
  accepted: "Accepted",
  running: "Working",
  completed: "Completed",
  failed: "Failed",
  unknown: "Outcome unconfirmed",
  needs_selection: "Choose a matching PR",
  link_pending: "PR confirmed · link needs repair",
};
const initial = {
  action: "create",
  repositoryId: "",
  base: "main",
  head: "",
  title: "",
  body: "",
  draft: true,
  number: "",
  notifyAgentId: "",
};
const safeUrl = (url: string) =>
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(
    url,
  )
    ? url
    : undefined;

export function PrOperations({
  taskId,
  disabled,
  onLinked,
}: {
  taskId: string;
  disabled: boolean;
  onLinked?: () => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [form, setForm] = useState(initial);
  const [peers, setPeers] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<Record<string, Operation>>({});
  const generation = useRef(0);
  const mounted = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const boundary = useRef<number | null>(null);
  const pending = useRef(new Map<string, string>());
  const loadSequence = useRef(0);
  const appliedSequence = useRef(0);
  const linkedCallback = useRef(onLinked);
  linkedCallback.current = onLinked;
  const linkedResults =
    page?.operations
      .filter((r) => r.linked && !active(r))
      .map((r) => `${r.id}:${r.attempt}`)
      .join("|") || "";
  useEffect(() => {
    if (linkedResults) linkedCallback.current?.();
  }, [linkedResults]);
  const request = useCallback(
    async <T,>(path: string, options?: RequestInit): Promise<T | null> => {
      const stamp = generation.current;
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const value = await api<T>(path, {
          ...options,
          signal: controller.signal,
        });
        return mounted.current && stamp === generation.current ? value : null;
      } catch (e) {
        if (
          !controller.signal.aborted &&
          mounted.current &&
          stamp === generation.current
        )
          setError(errorText(e));
        return null;
      } finally {
        controllers.current.delete(controller);
      }
    },
    [],
  );
  const load = useCallback(
    async (before?: number) => {
      const sequence = ++loadSequence.current;
      const through = boundary.current;
      const value = await request<Page>(
        `/pr-operations?taskId=${encodeURIComponent(taskId)}${before != null ? `&before=${before}` : through != null ? `&through=${through}` : ""}`,
      );
      if (!value || !Array.isArray(value.operations)) return;
      const previousBoundary = boundary.current;
      const extendsHistory =
        previousBoundary == null ||
        (value.nextBefore != null && value.nextBefore <= previousBoundary);
      if (extendsHistory)
        boundary.current = value.nextBefore ?? previousBoundary;
      const newest = sequence >= appliedSequence.current;
      appliedSequence.current = Math.max(sequence, appliedSequence.current);
      setPage((old) => {
        if (!old) return value;
        const records = new Map(old.operations.map((r) => [r.id, r]));
        for (const r of value.operations) {
          const previous = records.get(r.id);
          // An older page response may add history, but cannot roll back a
          // result that a newer refresh has already observed.
          if (!previous || (newest && r.attempt >= previous.attempt))
            records.set(r.id, r);
        }
        return {
          ...value,
          operations: [...records.values()].sort((a, b) => b.cursor - a.cursor),
          hasMore: extendsHistory ? value.hasMore : old.hasMore,
          nextBefore: boundary.current,
        };
      });
    },
    [request, taskId],
  );
  useEffect(() => {
    mounted.current = true;
    boundary.current = null;
    pending.current.clear();
    setPage(null);
    setForm(initial);
    setPeers([]);
    setError("");
    setNotice("");
    setBusy(false);
    setDetails({});
    void load();
    void request<{ peers: { id: string; name: string }[] }>(
      "/collaboration/peers_list",
      { method: "POST", body: "{}" },
    ).then((value) => {
      if (value?.peers) setPeers(value.peers);
    });
    return () => {
      mounted.current = false;
      generation.current++;
      for (const c of controllers.current) c.abort();
      controllers.current.clear();
    };
  }, [load, request]);
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        if (document.visibilityState !== "hidden") void load();
      },
      page?.operations.some(active) ? 1500 : 5000,
    );
    return () => window.clearInterval(timer);
  }, [page, load]);
  const mutate = async (path: string, payload: object) => {
    if (busy) return;
    const stamp = generation.current;
    const key = JSON.stringify({ path, ...payload });
    const requestId = pending.current.get(key) || crypto.randomUUID();
    pending.current.set(key, requestId);
    setBusy(true);
    setError("");
    setNotice("");
    const result = await request<Operation>(path, {
      method: "POST",
      body: JSON.stringify({ ...payload, requestId }),
    });
    if (!mounted.current || stamp !== generation.current) return;
    if (result) {
      pending.current.delete(key);
      setNotice(
        `Operation ${result.id} · ${labels[result.status] || result.status}. Core continues after this window closes.`,
      );
    }
    await load();
    if (mounted.current && stamp === generation.current) setBusy(false);
  };
  const check = (r: Operation, number?: number) =>
    mutate(`/pr-operations/${r.id}/check`, {
      taskId,
      ...(number ? { number } : {}),
    });
  const original = async (id: string) => {
    const value = await request<Operation>(
      `/pr-operations/${id}?taskId=${encodeURIComponent(taskId)}`,
    );
    if (value) setDetails((old) => ({ ...old, [id]: value }));
  };
  const update = (key: keyof typeof initial, value: string | boolean) =>
    setForm((old) => ({ ...old, [key]: value }));
  return (
    <section className="pr-operations" aria-label="PR operations">
      <h4>Create or update a PR</h4>
      <p className="github-hint">
        Use pushed branches in the same linked repository. Existing matching PRs
        are reused. Completion and task association appear here; reviews, CI and
        merge remain separate.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutate("/pr-operations", {
            taskId,
            action: form.action,
            repositoryId: Number(form.repositoryId),
            base: form.base,
            head: form.head,
            title: form.title,
            body: form.body,
            ...(form.action === "create" ? { draft: form.draft } : {}),
            ...(form.number ? { number: Number(form.number) } : {}),
            notifyAgentId: form.notifyAgentId || null,
          });
        }}
      >
        <fieldset disabled={disabled || busy || !page}>
          <label>
            Action
            <select
              aria-label="Action"
              value={form.action}
              onChange={(e) => update("action", e.target.value)}
            >
              <option value="create">Create or reuse PR</option>
              <option value="update">Update title and body</option>
            </select>
          </label>
          <label>
            PR repository
            <select
              aria-label="PR repository"
              required
              value={form.repositoryId}
              onChange={(e) => update("repositoryId", e.target.value)}
            >
              <option value="">Choose repository</option>
              {page?.repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.fullName}
                </option>
              ))}
            </select>
          </label>
          {page && !page.repositories.length && (
            <p className="github-hint">
              Link a repository in the Project settings first.
            </p>
          )}
          <div className="pr-operation-fields">
            <label>
              Base branch
              <input
                required
                value={form.base}
                maxLength={240}
                onChange={(e) => update("base", e.target.value)}
              />
            </label>
            <label>
              Head branch
              <input
                required
                value={form.head}
                maxLength={240}
                onChange={(e) => update("head", e.target.value)}
              />
            </label>
          </div>
          <label>
            PR number{" "}
            {form.action === "create"
              ? "(optional existing selection)"
              : "(required)"}
            <input
              type="number"
              min="1"
              max="2147483647"
              step="1"
              required={form.action === "update"}
              value={form.number}
              onChange={(e) => update("number", e.target.value)}
            />
          </label>
          <label>
            PR title
            <input
              required
              value={form.title}
              maxLength={256}
              onChange={(e) => update("title", e.target.value)}
            />
          </label>
          <label>
            PR body
            <textarea
              rows={5}
              value={form.body}
              maxLength={60000}
              onChange={(e) => update("body", e.target.value)}
            />
          </label>
          {form.action === "create" ? (
            <label className="pr-operation-draft">
              <input
                type="checkbox"
                checked={form.draft}
                onChange={(e) => update("draft", e.target.checked)}
              />
              Create as draft
            </label>
          ) : (
            <p className="github-hint">
              Updates preserve the PR’s draft state and branches. Base/head must
              match the selected PR.
            </p>
          )}
          <label>
            PR result recipient
            <select
              aria-label="PR result recipient"
              value={form.notifyAgentId}
              onChange={(e) => update("notifyAgentId", e.target.value)}
            >
              <option value="">Show in this task only</option>
              {peers.map((peer) => (
                <option key={peer.id} value={peer.id}>
                  {peer.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="secondary-button"
            disabled={
              !form.repositoryId ||
              !form.head.trim() ||
              !form.title.trim() ||
              (form.action === "update" && !form.number)
            }
          >
            {busy
              ? "Submitting…"
              : form.action === "create"
                ? "Create or reuse PR"
                : "Update PR"}
          </button>
        </fieldset>
      </form>
      {error && (
        <p className="github-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="github-notice" role="status">
          {notice}
        </p>
      )}
      {page?.operations.map((r) => (
        <article key={r.id} className="pr-operation" data-operation-id={r.id}>
          <header>
            <strong>
              {r.repository} · {r.input.action}
            </strong>
            <span>{labels[r.status] || r.status}</span>
          </header>
          <p>
            {r.input.head} → {r.input.base}
          </p>
          <small>
            {new Date(r.createdAt).toLocaleString()} · Attempt {r.attempt}
          </small>
          {active(r) && <p role="status">{r.phase}</p>}
          {r.remote && (
            <>
              <p>
                <a
                  href={safeUrl(r.remote.url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{r.remote.number} {r.remote.title}
                </a>{" "}
                · {r.remote.draft ? "Draft" : r.remote.state}
                {r.outcome ? ` · ${r.outcome}` : ""}
              </p>
              <p>
                Task association at completion:{" "}
                {r.linked ? "linked" : "not linked"}
              </p>
              <small>
                Observed head {r.remote.headSha.slice(0, 8)} · base{" "}
                {r.remote.baseSha.slice(0, 8)}
              </small>
            </>
          )}
          {r.error && <p className="github-error">{r.error}</p>}
          {r.associationError && (
            <p className="github-error">Task link: {r.associationError}</p>
          )}
          <p className="github-hint">
            {r.notificationRecipient
              ? `${r.notificationId ? "Result recorded in mailbox for" : "Result recipient:"} ${r.notificationRecipient.name}`
              : "Result shown in this task only"}
          </p>
          <small>Operation ID: {r.id}</small>
          {!active(r) && r.status !== "completed" && (
            <div className="pr-operation-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={disabled || busy}
                onClick={() => void check(r)}
              >
                Check outcome / repair link
              </button>
              {r.candidates.map((candidate) => (
                <button
                  key={candidate.number}
                  type="button"
                  className="secondary-button"
                  disabled={disabled || busy}
                  onClick={() => void check(r, candidate.number)}
                >
                  Select #{candidate.number}: {candidate.title}
                </button>
              ))}
            </div>
          )}
          <details
            onToggle={(event) => {
              if (event.currentTarget.open) void original(r.id);
            }}
          >
            <summary>Submitted content and recovery history</summary>
            {details[r.id] ? (
              <>
                {(details[r.id].attempt !== r.attempt ||
                  details[r.id].status !== r.status) && (
                  <p className="github-stale">
                    This detail predates the latest operation result. Refresh
                    operation detail to load it.
                  </p>
                )}
                <strong>Submitted title</strong>
                <p>{details[r.id].input.title}</p>
                <strong>Submitted body</strong>
                <pre>{details[r.id].input.body || "(empty)"}</pre>
                {details[r.id].remote && (
                  <>
                    <strong>Last observed PR body</strong>
                    <pre>{details[r.id].remote?.body || "(empty)"}</pre>
                  </>
                )}
                {details[r.id].writeError && (
                  <p>Write reply: {details[r.id].writeError}</p>
                )}
                {details[r.id].history?.map((h) => (
                  <p key={h.attempt}>
                    Attempt {h.attempt}: {labels[h.status] || h.status} ·{" "}
                    {new Date(h.finishedAt).toLocaleString()}
                    {h.error ? ` · ${h.error}` : ""}
                  </p>
                ))}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void original(r.id)}
                >
                  Refresh operation detail
                </button>
              </>
            ) : (
              "Loading…"
            )}
          </details>
        </article>
      ))}
      {page?.hasMore && page.nextBefore != null && (
        <button
          type="button"
          className="secondary-button"
          onClick={() => void load(page.nextBefore!)}
        >
          Older PR operations
        </button>
      )}
    </section>
  );
}
