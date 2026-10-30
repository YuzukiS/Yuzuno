import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowUpRight,
  ClipboardCheck,
  Download,
  FileText,
  History,
  Layers,
  LoaderCircle,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { api, API_BASE, errorText } from "./api";
import { Modal, Prose } from "./components";
import { openJobs } from "./Jobs";
import { useStrings } from "./i18n";
import { outcomeText } from "./task-outcome-text";
import {
  outcomeLink,
  reportCounts,
  resultVersion,
  type OutcomeArtifact,
  type OutcomePage,
  type OutcomePerson,
  type OutcomeResult,
  type OutcomeReport,
  type ReportedCriterion,
} from "./task-outcome";
import "./task-outcome.css";

type Text = ReturnType<typeof outcomeText>;
type Tab = "summary" | "evidence" | "versions";
type Task = {
  id: string;
  title: string;
  version: number;
  status: string;
  result?: OutcomeResult | null;
  blocker?: string | null;
  assignee?: OutcomePerson | null;
  materials?: { acceptance?: string | null } | null;
};
const date = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : "";
const tabs: Tab[] = ["summary", "evidence", "versions"];

/** Optional author statements use the existing result submission transaction. */
export function TaskOutcomeEditor({
  value,
  onChange,
  agents,
}: {
  value?: OutcomeReport;
  onChange: (value: OutcomeReport | undefined) => void;
  agents: { id: string; name: string }[];
}) {
  const t = useStrings(outcomeText);
  if (!value)
    return (
      <button
        type="button"
        className="text-button"
        onClick={() => onChange({ criteria: [] })}
      >
        {t.addReport}
      </button>
    );
  const update = (id: string, patch: Partial<ReportedCriterion>) =>
    onChange({
      ...value,
      criteria: value.criteria.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    });
  return (
    <details className="outcome-editor" open>
      <summary>{t.author}</summary>
      <p className="outcome-note">{t.notVerification}</p>
      {value.criteria.map((criterion, index) => (
        <div className="outcome-editor-item" key={criterion.id}>
          <label className="collab-field">
            <span>
              {t.criterionLabel} {index + 1}
            </span>
            <input
              required
              maxLength={300}
              value={criterion.label}
              onChange={(e) => update(criterion.id, { label: e.target.value })}
            />
          </label>
          <label className="collab-field">
            <span>{t.reportedStatus}</span>
            <select
              value={criterion.reportedStatus}
              onChange={(e) =>
                update(criterion.id, {
                  reportedStatus: e.target
                    .value as ReportedCriterion["reportedStatus"],
                })
              }
            >
              <option value="unknown">{t.unknown}</option>
              <option value="met">{t.met}</option>
              <option value="not_met">{t.notMet}</option>
            </select>
          </label>
          <label className="collab-field">
            <span>{t.criterionReport}</span>
            <textarea
              required
              rows={2}
              maxLength={2000}
              value={criterion.report}
              onChange={(e) => update(criterion.id, { report: e.target.value })}
            />
          </label>
          {!!criterion.artifacts?.length && (
            <div className="outcome-editor-artifacts">
              <p className="outcome-note">{t.keepReport}</p>
              {criterion.artifacts.map((artifact, n) => (
                <div key={`${artifact.jobId}:${artifact.path}`}>
                  <span>{artifact.path}</span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      update(criterion.id, {
                        artifacts: criterion.artifacts!.filter(
                          (_, i) => i !== n,
                        ),
                      })
                    }
                  >
                    {t.removeArtifact}
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            className="text-button"
            onClick={() =>
              onChange({
                ...value,
                criteria: value.criteria.filter((c) => c.id !== criterion.id),
              })
            }
          >
            {t.removeCriterion}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-button"
        disabled={value.criteria.length >= 20}
        onClick={() =>
          onChange({
            ...value,
            criteria: [
              ...value.criteria,
              {
                id: crypto.randomUUID(),
                label: "",
                report: "",
                reportedStatus: "unknown",
                artifacts: [],
              },
            ],
          })
        }
      >
        {t.addCriterion}
      </button>
      <label className="collab-field">
        <span>{t.remainingLabel}</span>
        <textarea
          rows={2}
          maxLength={2000}
          value={value.remaining || ""}
          onChange={(e) => onChange({ ...value, remaining: e.target.value })}
        />
      </label>
      <label className="collab-field">
        <span>{t.suggestedPerson}</span>
        <select
          value={value.nextAgentId || ""}
          onChange={(e) =>
            onChange({ ...value, nextAgentId: e.target.value || undefined })
          }
        >
          <option value="">{t.noSuggestion}</option>
          {value.nextAgentId &&
            !agents.some((a) => a.id === value.nextAgentId) && (
              <option value={value.nextAgentId}>
                {value.nextAgent?.name || value.nextAgentId}
              </option>
            )}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <label className="collab-field">
        <span>{t.nextStep}</span>
        <textarea
          rows={2}
          maxLength={2000}
          value={value.nextStep || ""}
          onChange={(e) => onChange({ ...value, nextStep: e.target.value })}
        />
      </label>
      <button
        type="button"
        className="text-button"
        onClick={() => onChange(undefined)}
      >
        {t.removeReport}
      </button>
    </details>
  );
}

function Deliverables({
  result,
  t,
}: {
  result?: OutcomeResult | null;
  t: Text;
}) {
  return result?.links?.length ? (
    <div className="outcome-deliverables" aria-label={t.links}>
      {result.links.map((link, index) => {
        const href = outcomeLink(link.url);
        return href ? (
          <a
            key={`${link.url}:${index}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            <FileText size={20} />
            <span>{link.label || link.url}</span>
            <ArrowUpRight size={16} />
          </a>
        ) : (
          <span key={index}>
            {link.label || link.url}
            <small>{t.unsafeLink}</small>
          </span>
        );
      })}
    </div>
  ) : null;
}

function Artifact({
  artifact,
  taskId,
  t,
}: {
  artifact: OutcomeArtifact;
  taskId: string;
  t: Text;
}) {
  const state =
    {
      recorded_match: t.recorded,
      job_missing: t.jobMissing,
      attempt_mismatch: t.attemptMismatch,
      artifact_missing: t.artifactMissing,
      artifact_mismatch: t.artifactMismatch,
    }[artifact.state] || t.unavailable;
  return (
    <article className="outcome-artifact">
      <div className="outcome-artifact-title">
        <FileText size={17} />
        <strong>{artifact.path}</strong>
      </div>
      <span
        className={`outcome-chip ${artifact.state === "recorded_match" ? "neutral" : "gap"}`}
      >
        {state}
      </span>
      <dl className="outcome-facts">
        <dt>{t.jobState}</dt>
        <dd>{artifact.jobStatus || t.unavailable}</dd>
        <dt>{t.attempt}</dt>
        <dd>
          <code>{artifact.attempt}</code>
        </dd>
        <dt>SHA-256</dt>
        <dd>
          <code>{artifact.sha256}</code>
        </dd>
        {artifact.machineName && (
          <>
            <dt>{t.machine}</dt>
            <dd>{artifact.machineName}</dd>
          </>
        )}
        {artifact.checkedAt && (
          <>
            <dt>{t.recordedAt}</dt>
            <dd>{date(artifact.checkedAt)}</dd>
          </>
        )}
        {artifact.finishedAt && (
          <>
            <dt>{t.finishedAt}</dt>
            <dd>{date(artifact.finishedAt)}</dd>
          </>
        )}
      </dl>
      <p className="outcome-note">{t.bytesNotChecked}</p>
      <div className="outcome-actions">
        <button
          type="button"
          onClick={() => openJobs({ taskId, jobId: artifact.jobId })}
        >
          {t.job}
          <ArrowUpRight size={14} />
        </button>
        {artifact.state === "recorded_match" &&
        artifact.downloadable &&
        artifact.index != null ? (
          <a
            href={`${API_BASE}/api/jobs/${encodeURIComponent(artifact.jobId)}/artifacts/${artifact.index}`}
            download
          >
            <Download size={14} />
            {t.download}
          </a>
        ) : (
          <span className="outcome-note">
            {artifact.state === "recorded_match" ? t.remote : t.noDownload}
          </span>
        )}
      </div>
    </article>
  );
}

function MissingRecords({ t }: { t: Text }) {
  return (
    <div className="outcome-verification">
      <section>
        <h4>{t.independent}</h4>
        <p>{t.noVerification}</p>
      </section>
      <section>
        <h4>{t.userAcceptance}</h4>
        <p>{t.noAcceptance}</p>
      </section>
    </div>
  );
}

export function TaskOutcome({
  task,
  onOpenAgent,
  availableAgents = [],
}: {
  task: Task;
  onOpenAgent?: (id: string, turnId?: string) => void;
  availableAgents?: string[];
}) {
  const t = useStrings(outcomeText);
  const [density, setDensity] = useState<"low" | "high">("low");
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("summary");
  const [page, setPage] = useState<OutcomePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const prefix = useId();
  useEffect(
    () => () => {
      generation.current++;
    },
    [task.id],
  );

  // Opened result identity stays fixed until the reader chooses another one.
  // An SSE/task refresh never swaps the drawer's result or drafts underneath it.
  const read = useCallback(
    async (resultId?: string | null, before?: number) => {
      const request = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const next = await api<OutcomePage>("/collaboration/task_result_get", {
          method: "POST",
          body: JSON.stringify({
            taskId: task.id,
            ...(resultId ? { resultId } : {}),
            ...(before == null ? {} : { before }),
            limit: 10,
          }),
        });
        if (request === generation.current)
          setPage((previous) => ({
            ...next,
            ...(before != null && previous
              ? { result: previous.result, artifacts: previous.artifacts }
              : {}),
            history:
              before != null && previous
                ? [
                    ...previous.history,
                    ...next.history.filter(
                      (row) =>
                        !previous.history.some((old) => old.seq === row.seq),
                    ),
                  ]
                : next.history,
          }));
      } catch (problem) {
        if (request === generation.current) setError(errorText(problem));
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [task.id],
  );
  const changeOpen = (value: boolean) => {
    setOpen(value);
    if (!value) {
      generation.current++;
      setLoading(false);
    }
  };
  const start = (button: HTMLButtonElement) => {
    trigger.current = button;
    setTab("summary");
    setPage(null);
    setOpen(true);
    void read(task.result?.id);
  };
  const keyboardTabs = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: Tab,
  ) => {
    const at = tabs.indexOf(current);
    const next =
      event.key === "ArrowRight"
        ? tabs[(at + 1) % 3]
        : event.key === "ArrowLeft"
          ? tabs[(at + 2) % 3]
          : event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs[2]
              : null;
    if (next) {
      event.preventDefault();
      setTab(next);
      tabRefs.current[next]?.focus();
    }
  };
  const result = task.result;
  const counts = reportCounts(result?.outcome);
  const gaps =
    result?.outcome?.remaining?.trim() ||
    task.blocker?.trim() ||
    result?.outcome?.criteria
      .filter((c) => c.reportedStatus !== "met")
      .map((c) => c.label)
      .join(" · ") ||
    t.noGaps;
  const selected = page?.result;
  const currentResultId =
    page && page.taskVersion >= task.version
      ? page.currentResultId
      : task.result?.id || null;
  const historical =
    !!selected && !!currentResultId && selected.id !== currentResultId;
  const hasUpdate =
    !!page &&
    task.version > page.taskVersion &&
    !!task.result?.id &&
    task.result.id !== page.currentResultId;
  const working = !!result && !["review", "done"].includes(task.status);
  const selectedCounts = reportCounts(selected?.outcome);

  return (
    <>
      <div
        className="task-outcome"
        data-density={density}
        data-result-id={result?.id || ""}
      >
        <div className="outcome-topline">
          <span className="outcome-chip">
            <Layers size={13} />
            {resultVersion(result) || t.unknownVersion}
          </span>
          <div className="outcome-density" role="group" aria-label={t.density}>
            {(["low", "high"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={density === value}
                onClick={() => setDensity(value)}
              >
                {t[value]}
              </button>
            ))}
          </div>
        </div>
        {working && <p className="outcome-context">{t.workingWarning}</p>}
        {result ? (
          <div className="outcome-preview">
            <Prose text={result.summary} />
          </div>
        ) : (
          <div className="outcome-empty">
            <FileText size={25} />
            <strong>{t.noResult}</strong>
            <p>{t.noResultBody}</p>
          </div>
        )}
        <Deliverables result={result} t={t} />
        <dl className="outcome-overview">
          <div>
            <dt>{t.missing}</dt>
            <dd>{gaps}</dd>
          </div>
          <div>
            <dt>
              <UserRound size={14} />
              {t.owner}
            </dt>
            <dd>{task.assignee?.name || t.unassigned}</dd>
          </div>
          {result?.outcome?.nextAgent && (
            <div>
              <dt>{t.proposed}</dt>
              <dd>{result.outcome.nextAgent.name}</dd>
            </div>
          )}
          {result?.outcome?.nextStep && (
            <div>
              <dt>{t.nextStep}</dt>
              <dd>{result.outcome.nextStep}</dd>
            </div>
          )}
        </dl>
        {counts.total > 0 && (
          <p className="outcome-counts">
            <ClipboardCheck size={14} />
            {t.counts(counts.reported, counts.total)}
            <span>{t.author}</span>
          </p>
        )}
        <div className="outcome-compact-meta">
          <span>
            {t.independent}: {t.unavailable}
          </span>
          <span>
            {t.userAcceptance}: {t.unavailable}
          </span>
          {result?.id && <code>{result.id}</code>}
        </div>
        <div className="outcome-footer">
          <span>
            {result?.reportedBy?.name || t.author}
            {result?.reportedAt && <> · {date(result.reportedAt)}</>}
          </span>
          {result?.source &&
            availableAgents.includes(result.source.agentId) && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  onOpenAgent?.(
                    result.source!.agentId,
                    result.source!.turnId || undefined,
                  )
                }
              >
                {t.original}
                <ArrowUpRight size={14} />
              </button>
            )}
          <button
            type="button"
            className="text-button"
            onClick={(event) => start(event.currentTarget)}
          >
            {t.open}
            <ArrowUpRight size={15} />
          </button>
        </div>
      </div>
      <Modal
        open={open}
        onOpenChange={changeOpen}
        title={task.title}
        description={`${task.id} · ${t.title}`}
        closeLabel={t.close}
        className="outcome-drawer"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger.current?.isConnected) trigger.current.focus();
        }}
      >
        <div className="outcome-drawer-content" data-density={density}>
          <div className="outcome-drawer-meta">
            <span className="outcome-chip">
              {resultVersion(selected) || t.unknownVersion}
            </span>
            <span>
              {historical
                ? t.historical
                : selected?.id
                  ? t.current
                  : selected
                    ? t.unknownVersion
                    : page
                      ? t.noResult
                      : t.loading}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={t.refresh}
              disabled={loading}
              onClick={() => void read(selected?.id)}
            >
              <RefreshCw size={16} className={loading ? "spin" : ""} />
            </button>
          </div>
          <div className="outcome-tabs" role="tablist" aria-label={t.title}>
            {tabs.map((value) => (
              <button
                key={value}
                type="button"
                id={`${prefix}-${value}-tab`}
                role="tab"
                aria-selected={tab === value}
                aria-controls={`${prefix}-${value}-pane`}
                tabIndex={tab === value ? 0 : -1}
                ref={(element) => {
                  tabRefs.current[value] = element;
                }}
                onKeyDown={(event) => keyboardTabs(event, value)}
                onClick={() => setTab(value)}
              >
                {t[value]}
              </button>
            ))}
          </div>
          {hasUpdate && (
            <div className="outcome-warning" role="status">
              {t.updates}
              <button
                type="button"
                disabled={loading}
                onClick={() => void read()}
              >
                {t.latest}
              </button>
            </div>
          )}
          {historical && (
            <div className="outcome-warning">
              {t.oldWarning}
              <button
                type="button"
                disabled={loading}
                onClick={() => void read()}
              >
                {t.latest}
              </button>
            </div>
          )}
          {error && (
            <div className="collab-error" role="alert">
              {error}
            </div>
          )}
          {loading && (
            <p className="outcome-loading" role="status">
              <LoaderCircle size={17} className="spin" />
              {t.loading}
            </p>
          )}
          {page && (
            <>
              <section
                id={`${prefix}-summary-pane`}
                role="tabpanel"
                aria-labelledby={`${prefix}-summary-tab`}
                hidden={tab !== "summary"}
              >
                {selected ? (
                  <>
                    <div className="outcome-section-label">
                      <span>{t.author}</span>
                      <span>
                        {selected.reportedBy?.name} ·{" "}
                        {date(selected.reportedAt)}
                      </span>
                    </div>
                    <div className="outcome-author-report">
                      <Prose text={selected.summary} />
                    </div>
                    <Deliverables result={selected} t={t} />
                    <div className="outcome-tiles">
                      <section className="gap">
                        <h4>{t.missing}</h4>
                        <p>
                          {selected.outcome?.remaining ||
                            selected.outcome?.criteria
                              .filter((c) => c.reportedStatus !== "met")
                              .map((c) => c.label)
                              .join(" · ") ||
                            t.noGaps}
                        </p>
                      </section>
                      <section>
                        <h4>{t.owner}</h4>
                        <p>{task.assignee?.name || t.unassigned}</p>
                      </section>
                      {selected.outcome?.nextAgent && (
                        <section>
                          <h4>{t.proposed}</h4>
                          <p>{selected.outcome.nextAgent.name}</p>
                        </section>
                      )}
                      {selected.outcome?.nextStep && (
                        <section>
                          <h4>{t.nextStep}</h4>
                          <p>{selected.outcome.nextStep}</p>
                        </section>
                      )}
                    </div>
                    <p className="outcome-note">{t.notVerification}</p>
                    {selected.source &&
                      availableAgents.includes(selected.source.agentId) && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            onOpenAgent?.(
                              selected.source!.agentId,
                              selected.source!.turnId || undefined,
                            )
                          }
                        >
                          {t.original}
                          <ArrowUpRight size={14} />
                        </button>
                      )}
                  </>
                ) : (
                  <div className="outcome-empty">
                    <FileText size={26} />
                    <strong>{t.noResult}</strong>
                    <p>{t.noResultBody}</p>
                  </div>
                )}
                <MissingRecords t={t} />
                <p className="outcome-note">{t.separateReview}</p>
              </section>
              <section
                id={`${prefix}-evidence-pane`}
                role="tabpanel"
                aria-labelledby={`${prefix}-evidence-tab`}
                hidden={tab !== "evidence"}
              >
                <div className="outcome-acceptance">
                  <h4>{t.acceptance}</h4>
                  {selected?.acceptanceContext?.text ? (
                    <>
                      <Prose text={selected.acceptanceContext.text} />
                      <p className="outcome-note">
                        {selected.acceptanceContext.source === "dispatch"
                          ? t.dispatch
                          : t.registration}
                      </p>
                    </>
                  ) : (
                    <p className="outcome-note">{t.noAcceptanceText}</p>
                  )}
                  {!selected && task.materials?.acceptance && (
                    <>
                      <h4>{t.currentAcceptance}</h4>
                      <Prose text={task.materials.acceptance} />
                    </>
                  )}
                </div>
                <div className="outcome-section-label">
                  <span>{t.author}</span>
                  <span>
                    {selectedCounts.total > 0 &&
                      t.counts(selectedCounts.reported, selectedCounts.total)}
                  </span>
                </div>
                <p className="outcome-note">{t.criterionNote}</p>
                {selected?.outcome?.criteria.length ? (
                  <div className="outcome-criteria">
                    {selected.outcome.criteria.map((criterion) => {
                      const artifacts = page.artifacts.filter(
                        (a) => a.criterionId === criterion.id,
                      );
                      return (
                        <details
                          className="outcome-criterion"
                          key={`${selected.id}:${criterion.id}`}
                        >
                          <summary>
                            <ClipboardCheck size={17} />
                            <strong>{criterion.label}</strong>
                            <span
                              className={`outcome-chip ${criterion.reportedStatus === "not_met" ? "gap" : "neutral"}`}
                            >
                              {criterion.reportedStatus === "met"
                                ? t.met
                                : criterion.reportedStatus === "not_met"
                                  ? t.notMet
                                  : t.unknown}
                            </span>
                          </summary>
                          <div className="outcome-criterion-body">
                            <p className="outcome-note">
                              {t.author} · {selected.reportedBy?.name} ·{" "}
                              {resultVersion(selected) || t.unknownVersion}
                            </p>
                            <Prose text={criterion.report} />
                            <h5>{t.artifacts}</h5>
                            {artifacts.length ? (
                              artifacts.map((a) => (
                                <Artifact
                                  key={`${a.jobId}:${a.attempt}:${a.path}`}
                                  artifact={a}
                                  taskId={task.id}
                                  t={t}
                                />
                              ))
                            ) : (
                              <p className="outcome-note">{t.noArtifacts}</p>
                            )}
                            <p className="outcome-note">{t.noVerification}</p>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                ) : (
                  <p className="outcome-empty-copy">{t.noChecklist}</p>
                )}
                <MissingRecords t={t} />
              </section>
              <section
                id={`${prefix}-versions-pane`}
                role="tabpanel"
                aria-labelledby={`${prefix}-versions-tab`}
                hidden={tab !== "versions"}
              >
                <p className="outcome-note">{t.historyHelp}</p>
                <div className="outcome-history">
                  {page.history.map((entry) => (
                    <article key={entry.seq}>
                      <span className="outcome-version-mark">
                        <History size={17} />
                        {resultVersion(entry) || "—"}
                      </span>
                      <div>
                        <div className="outcome-history-heading">
                          <strong>
                            {!entry.resultId
                              ? t.unknownVersion
                              : entry.resultId === currentResultId
                                ? t.current
                                : t.historical}
                          </strong>
                          <span>{date(entry.reportedAt)}</span>
                        </div>
                        <Prose text={entry.summary} />
                        <p className="outcome-note">
                          {t.reportBy}:{" "}
                          {entry.reportedBy?.name || t.unavailable}
                        </p>
                        {entry.resultId ? (
                          <button
                            type="button"
                            disabled={loading}
                            className="text-button"
                            onClick={() => {
                              setTab("evidence");
                              void read(entry.resultId);
                            }}
                          >
                            {t.evidence}
                            <ArrowUpRight size={14} />
                          </button>
                        ) : (
                          <p className="outcome-note">{t.unknownHistory}</p>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
                {!page.history.length && (
                  <p className="outcome-empty-copy">{t.noHistory}</p>
                )}
                {page.hasMore && (
                  <button
                    type="button"
                    disabled={loading || page.nextBefore == null}
                    className="text-button"
                    onClick={() => void read(selected?.id, page.nextBefore!)}
                  >
                    {t.loadMore}
                  </button>
                )}
              </section>
              {selected?.id && (
                <footer className="outcome-record-id">
                  <span>{t.resultId}</span>
                  <code>{selected.id}</code>
                </footer>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
