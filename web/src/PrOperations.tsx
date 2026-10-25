import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import { strings, useStrings } from "./i18n";
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
// A task's PR operations in the interface language (T-189). Repositories,
// branches, PR titles and bodies, the action, GitHub's PR state, the outcome,
// Core's phase, IDs, names and errors are shown as they are.
const operationsText = strings({
  states: {
    accepted: "Accepted",
    running: "Working",
    completed: "Completed",
    failed: "Failed",
    unknown: "Outcome unconfirmed",
    needs_selection: "Choose a matching PR",
    link_pending: "PR confirmed · link needs repair",
  } as Record<string, string>,
  region: "PR operations",
  title: "Create or update a PR",
  hint: "Use pushed branches in the same linked repository. Existing matching PRs are reused. Completion and task association appear here; reviews, CI and merge remain separate.",
  action: "Action",
  create: "Create or reuse PR",
  updateText: "Update title and body",
  repository: "PR repository",
  chooseRepository: "Choose repository",
  linkFirst: "Link a repository in the Project settings first.",
  base: "Base branch",
  head: "Head branch",
  number: "PR number",
  numberOptional: "(optional existing selection)",
  numberRequired: "(required)",
  prTitle: "PR title",
  prBody: "PR body",
  draft: "Create as draft",
  updateNote: "Updates preserve the PR’s draft state and branches. Base/head must match the selected PR.",
  recipient: "PR result recipient",
  taskOnly: "Show in this task only",
  submitting: "Submitting…",
  update: "Update PR",
  accepted: (id: string, state: string) => `Operation ${id} · ${state}. Core continues after this window closes.`,
  attempt: (attempt: number) => `Attempt ${attempt}`,
  isDraft: "Draft",
  association: (linked: boolean) => `Task association at completion: ${linked ? "linked" : "not linked"}`,
  observed: (head: string, base: string) => `Observed head ${head} · base ${base}`,
  taskLink: (error: string) => `Task link: ${error}`,
  recorded: (name: string) => `Result recorded in mailbox for ${name}`,
  resultRecipient: (name: string) => `Result recipient: ${name}`,
  shownHere: "Result shown in this task only",
  operationId: (id: string) => `Operation ID: ${id}`,
  check: "Check outcome / repair link",
  select: (number: number, title: string) => `Select #${number}: ${title}`,
  history: "Submitted content and recovery history",
  predates: "This detail predates the latest operation result. Refresh operation detail to load it.",
  submittedTitle: "Submitted title",
  submittedBody: "Submitted body",
  empty: "(empty)",
  observedBody: "Last observed PR body",
  writeReply: (reply: string) => `Write reply: ${reply}`,
  attemptOf: (attempt: number, state: string) => `Attempt ${attempt}: ${state}`,
  refresh: "Refresh operation detail",
  loading: "Loading…",
  older: "Older PR operations",
}, {
  states: {
    accepted: "已接受",
    running: "进行中",
    completed: "已完成",
    failed: "失败",
    unknown: "结果未确认",
    needs_selection: "请选择匹配的 PR",
    link_pending: "PR 已确认 · 链接需要修复",
  },
  region: "PR 操作",
  title: "创建或更新 PR",
  hint: "使用同一已链接仓库中已推送的分支。会复用已有的匹配 PR。完成情况和任务关联显示在这里；审查、CI 和合并仍是分开的。",
  action: "操作",
  create: "创建或复用 PR",
  updateText: "更新标题和正文",
  repository: "PR 仓库",
  chooseRepository: "选择仓库",
  linkFirst: "请先在项目设置中链接一个仓库。",
  base: "Base 分支",
  head: "Head 分支",
  number: "PR 编号",
  numberOptional: "（可选，选择已有 PR）",
  numberRequired: "（必填）",
  prTitle: "PR 标题",
  prBody: "PR 正文",
  draft: "创建为草稿",
  updateNote: "更新会保留 PR 的草稿状态和分支。Base/head 必须与所选 PR 一致。",
  recipient: "PR 结果的接收方",
  taskOnly: "只在此任务中显示",
  submitting: "正在提交…",
  update: "更新 PR",
  accepted: (id, state) => `操作 ${id} · ${state}。关闭此窗口后 Core 会继续。`,
  attempt: (attempt) => `第 ${attempt} 次尝试`,
  isDraft: "草稿",
  association: (linked) => `完成时的任务关联：${linked ? "已关联" : "未关联"}`,
  observed: (head, base) => `观察到的 head ${head} · base ${base}`,
  taskLink: (error) => `任务链接：${error}`,
  recorded: (name) => `结果已记入 ${name} 的邮箱`,
  resultRecipient: (name) => `结果接收方：${name}`,
  shownHere: "结果只在此任务中显示",
  operationId: (id) => `操作 ID：${id}`,
  check: "检查结果 / 修复链接",
  select: (number, title) => `选择 #${number}：${title}`,
  history: "提交的内容与恢复记录",
  predates: "此详情早于最新的操作结果。刷新操作详情即可加载。",
  submittedTitle: "提交的标题",
  submittedBody: "提交的正文",
  empty: "（空）",
  observedBody: "上次观察到的 PR 正文",
  writeReply: (reply) => `写入回复：${reply}`,
  attemptOf: (attempt, state) => `第 ${attempt} 次尝试：${state}`,
  refresh: "刷新操作详情",
  loading: "正在加载…",
  older: "更早的 PR 操作",
});
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
  const t = useStrings(operationsText);
  const [page, setPage] = useState<Page | null>(null);
  const [form, setForm] = useState(initial);
  const [peers, setPeers] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  // The accepted operation, worded when shown, so a language change rewords it.
  const [notice, setNotice] = useState<{ id: string; status: string } | null>(null);
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
    setNotice(null);
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
    setNotice(null);
    const result = await request<Operation>(path, {
      method: "POST",
      body: JSON.stringify({ ...payload, requestId }),
    });
    if (!mounted.current || stamp !== generation.current) return;
    if (result) {
      pending.current.delete(key);
      setNotice({ id: result.id, status: result.status });
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
    <section className="pr-operations" aria-label={t.region}>
      <h4>{t.title}</h4>
      <p className="github-hint">{t.hint}</p>
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
            {t.action}
            <select
              aria-label={t.action}
              value={form.action}
              onChange={(e) => update("action", e.target.value)}
            >
              <option value="create">{t.create}</option>
              <option value="update">{t.updateText}</option>
            </select>
          </label>
          <label>
            {t.repository}
            <select
              aria-label={t.repository}
              required
              value={form.repositoryId}
              onChange={(e) => update("repositoryId", e.target.value)}
            >
              <option value="">{t.chooseRepository}</option>
              {page?.repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.fullName}
                </option>
              ))}
            </select>
          </label>
          {page && !page.repositories.length && (
            <p className="github-hint">{t.linkFirst}</p>
          )}
          <div className="pr-operation-fields">
            <label>
              {t.base}
              <input
                required
                value={form.base}
                maxLength={240}
                onChange={(e) => update("base", e.target.value)}
              />
            </label>
            <label>
              {t.head}
              <input
                required
                value={form.head}
                maxLength={240}
                onChange={(e) => update("head", e.target.value)}
              />
            </label>
          </div>
          <label>
            {t.number}{" "}
            {form.action === "create" ? t.numberOptional : t.numberRequired}
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
            {t.prTitle}
            <input
              required
              value={form.title}
              maxLength={256}
              onChange={(e) => update("title", e.target.value)}
            />
          </label>
          <label>
            {t.prBody}
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
              {t.draft}
            </label>
          ) : (
            <p className="github-hint">{t.updateNote}</p>
          )}
          <label>
            {t.recipient}
            <select
              aria-label={t.recipient}
              value={form.notifyAgentId}
              onChange={(e) => update("notifyAgentId", e.target.value)}
            >
              <option value="">{t.taskOnly}</option>
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
              ? t.submitting
              : form.action === "create"
                ? t.create
                : t.update}
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
          {t.accepted(notice.id, t.states[notice.status] || notice.status)}
        </p>
      )}
      {page?.operations.map((r) => (
        <article key={r.id} className="pr-operation" data-operation-id={r.id}>
          <header>
            <strong>
              {r.repository} · {r.input.action}
            </strong>
            <span>{t.states[r.status] || r.status}</span>
          </header>
          <p>
            {r.input.head} → {r.input.base}
          </p>
          <small>
            {new Date(r.createdAt).toLocaleString()} · {t.attempt(r.attempt)}
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
                · {r.remote.draft ? t.isDraft : r.remote.state}
                {r.outcome ? ` · ${r.outcome}` : ""}
              </p>
              <p>{t.association(r.linked)}</p>
              <small>
                {t.observed(r.remote.headSha.slice(0, 8), r.remote.baseSha.slice(0, 8))}
              </small>
            </>
          )}
          {r.error && <p className="github-error">{r.error}</p>}
          {r.associationError && (
            <p className="github-error">{t.taskLink(r.associationError)}</p>
          )}
          <p className="github-hint">
            {r.notificationRecipient
              ? r.notificationId
                ? t.recorded(r.notificationRecipient.name)
                : t.resultRecipient(r.notificationRecipient.name)
              : t.shownHere}
          </p>
          <small>{t.operationId(r.id)}</small>
          {!active(r) && r.status !== "completed" && (
            <div className="pr-operation-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={disabled || busy}
                onClick={() => void check(r)}
              >
                {t.check}
              </button>
              {r.candidates.map((candidate) => (
                <button
                  key={candidate.number}
                  type="button"
                  className="secondary-button"
                  disabled={disabled || busy}
                  onClick={() => void check(r, candidate.number)}
                >
                  {t.select(candidate.number, candidate.title)}
                </button>
              ))}
            </div>
          )}
          <details
            onToggle={(event) => {
              if (event.currentTarget.open) void original(r.id);
            }}
          >
            <summary>{t.history}</summary>
            {details[r.id] ? (
              <>
                {(details[r.id].attempt !== r.attempt ||
                  details[r.id].status !== r.status) && (
                  <p className="github-stale">{t.predates}</p>
                )}
                <strong>{t.submittedTitle}</strong>
                <p>{details[r.id].input.title}</p>
                <strong>{t.submittedBody}</strong>
                <pre>{details[r.id].input.body || t.empty}</pre>
                {details[r.id].remote && (
                  <>
                    <strong>{t.observedBody}</strong>
                    <pre>{details[r.id].remote?.body || t.empty}</pre>
                  </>
                )}
                {details[r.id].writeError && (
                  <p>{t.writeReply(details[r.id].writeError!)}</p>
                )}
                {details[r.id].history?.map((h) => (
                  <p key={h.attempt}>
                    {t.attemptOf(h.attempt, t.states[h.status] || h.status)} ·{" "}
                    {new Date(h.finishedAt).toLocaleString()}
                    {h.error ? ` · ${h.error}` : ""}
                  </p>
                ))}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void original(r.id)}
                >
                  {t.refresh}
                </button>
              </>
            ) : (
              t.loading
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
          {t.older}
        </button>
      )}
    </section>
  );
}
