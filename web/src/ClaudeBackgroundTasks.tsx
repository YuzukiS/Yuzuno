import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, LoaderCircle, Square, Terminal } from "lucide-react";
import { errorText, post } from "./api";
import {
  claudeBackgroundTasks,
  STOP_WAIT_MS,
  stopPending,
  stopUnavailable,
  taskRunning,
  type ClaudeBackgroundTaskEntry,
  type ClaudeBackgroundTaskRecord,
} from "./claude-background-tasks";
import { moment } from "./conversation-time";
import { useTimeDisplay, type TimeDisplay } from "./time-preferences";
import { SubAgentDock, type DockGroup, type DockSubAgent } from "./SubAgentPanels";
import type { Agent, NativeTurn, RunningCall } from "./types";
import { withRunningCalls } from "./running-calls";
import { useLanguage, type Language } from "./i18n";
import { cardWords } from "./subagent-text";
import "./claude-background-tasks.css";

// The group's names, in the language shown.
const groupOf = (language: Language): DockGroup => {
  const t = cardWords(language);
  return { label: t.backgroundTasks, one: t.backgroundTask, icon: (size) => <Terminal size={size} /> };
};
const NONE: readonly DockSubAgent[] = [];
const NO_TURNS: readonly NativeTurn[] = [];

/** What a stop needs to know of a task: a background task's or a sub-agent's record. */
type Stoppable = Pick<ClaudeBackgroundTaskRecord, "taskId" | "stopRequestedAt" | "stopError"> & { status?: string };

/** Re-renders when a stop sent for `record` runs out of its wait. */
function useStopWait(record: Stoppable): number {
  const [now, setNow] = useState(() => Date.now());
  const pending = stopPending(record as ClaudeBackgroundTaskRecord, now);
  useEffect(() => {
    if (!pending) return;
    const left = Date.parse(record.stopRequestedAt!) + STOP_WAIT_MS - Date.now();
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, left) + 50);
    return () => clearTimeout(timer);
  }, [pending, record.stopRequestedAt]);
  return now;
}

/**
 * Stops this one task of Claude's, by its task id, only on this click: never
 * the Turn, another task or the session. Claude acknowledges any stop, so
 * "Stopping…" lasts until the task's own end arrives (or the wait runs out);
 * a second click meanwhile sends nothing.
 */
export function StopTaskButton({ agentId, record, live, label }: {
  agentId: string;
  record: Stoppable;
  live: boolean;
  label: string;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useStopWait(record);
  const language = useLanguage();
  const t = cardWords(language);
  const task = record as ClaudeBackgroundTaskRecord;
  if (!taskRunning(task)) return null;
  const unavailable = stopUnavailable(task, live, language);
  if (unavailable) return <p className="claude-task-stop-note">{unavailable}</p>;
  const pending = stopPending(task, now);
  const unconfirmed = !pending && !!record.stopRequestedAt && !record.stopError;
  async function stop() {
    if (sending || pending) return;
    setSending(true);
    setError(null);
    try {
      await post(`/agents/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(record.taskId!)}/stop`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  }
  const shown = error ?? record.stopError;
  return (
    <div className="claude-task-stop">
      <button type="button" className="secondary-button" disabled={sending || pending} aria-label={t.stop(label)} onClick={() => void stop()}>
        {sending || pending ? <LoaderCircle size={13} className="spin" aria-hidden /> : <Square size={11} fill="currentColor" aria-hidden />}
        {sending || pending ? t.stopping : unconfirmed || shown ? t.stopAgain : t.stopThis}
      </button>
      <p className="claude-task-stop-note">
        {pending ? t.sentWaiting : unconfirmed ? t.noEnd : t.onlyThis}
      </p>
      {shown && <p className="claude-subagent-error" role="alert">{t.couldntStop(shown)}</p>}
    </div>
  );
}

function when(at: string | undefined, time: TimeDisplay) {
  const ms = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(ms)) return null;
  const m = moment(ms, time);
  return <time dateTime={m.dateTime} title={m.title}>{m.label}</time>;
}

/** One background task's card: what Claude reported for it, its call's Turn, and its stop. */
export function ClaudeBackgroundTaskDetail({ agentId, entry, live, onNavigate }: {
  agentId: string;
  entry: ClaudeBackgroundTaskEntry;
  live: boolean;
  onNavigate?: (turnId: string) => void;
}) {
  const { record } = entry;
  const running = entry.status === "running";
  const time = useTimeDisplay();
  const t = cardWords(useLanguage());
  return <div className="claude-subagent claude-background-task" data-task-status={entry.status}>
    <dl className="claude-subagent-facts">
      <dt>{t.status}</dt><dd>{entry.state}</dd>
      <dt>{t.kind}</dt><dd>{entry.kind}{record.ambient ? t.housekeeping : ""}</dd>
      {record.startedAt && <><dt>{t.started}</dt><dd>{when(record.startedAt, time)}</dd></>}
      {record.endedAt && <><dt>{t.ended}</dt><dd>{when(record.endedAt, time)}</dd></>}
      {record.taskId && <><dt>{t.task}</dt><dd><code>{record.taskId}</code></dd></>}
    </dl>
    <section className="claude-subagent-part" aria-label={t.runsLabel}>
      <span className="section-eyebrow">{t.runs}</span>
      {entry.command && record.description && record.description !== entry.command && <p><strong>{record.description}</strong></p>}
      {entry.command || record.description ? <pre className="claude-task-command">{entry.command || record.description}</pre>
        : <p className="claude-subagent-muted">{t.notReported}</p>}
    </section>
    {running && (record.activity || record.progress) && (
      <p className="claude-subagent-muted">{[record.activity, record.progress].filter(Boolean).join(" · ")}</p>
    )}
    {record.error && <p className="claude-subagent-error" role="alert">{record.error}</p>}
    <section className="claude-subagent-part" aria-label={t.resultLabel}>
      <span className="section-eyebrow">{t.result}</span>
      {record.result ? <p className="claude-subagent-text">{record.result}{record.resultTruncated && <span className="claude-subagent-muted">{t.shortened}</span>}</p>
        : <p className="claude-subagent-muted">{running ? t.noResultYet : entry.status === "unknown" ? t.noResultUnknown : t.noResult}</p>}
      {record.outputFile && <p className="claude-subagent-muted">{t.outputOn}<code>{record.outputFile}</code></p>}
    </section>
    <StopTaskButton agentId={agentId} record={record} live={live} label={entry.label} />
    {onNavigate && (
      <div className="subagent-card-actions">
        <button type="button" className="quiet-button" onClick={() => onNavigate(entry.turnId)}>
          <ArrowUpRight size={12} aria-hidden /> {t.goTurn}
        </button>
      </div>
    )}
    <details className="claude-task-evidence">
      <summary>{t.asReported}</summary>
      <pre>{JSON.stringify(record, null, 2)}</pre>
    </details>
  </div>;
}

/** Claude's background tasks as the dock shows them, from the loaded Turns. */
export function claudeBackgroundDockEntries(agentId: string, turns: readonly NativeTurn[], live: boolean, now = Date.now(), language: Language = "en"): DockSubAgent[] {
  const t = cardWords(language);
  return claudeBackgroundTasks(turns, live, now, language).map((entry) => ({
    key: entry.key,
    turnId: entry.turnId,
    label: entry.label,
    // Unconfirmed is the dock's neutral node, as for sub-agents.
    status: entry.status === "unknown" ? "unconfirmed" : entry.status,
    state: entry.state,
    sub: entry.status === "running" ? (stopPending(entry.record, now) ? t.stopping : entry.kind) : entry.state,
    detail: entry.kind,
    waiting: entry.waiting,
    details: (onNavigate) => (
      <div key={entry.key} className="subagent-detail">
        <ClaudeBackgroundTaskDetail agentId={agentId} entry={entry} live={live} onNavigate={onNavigate} />
      </div>
    ),
  }));
}

/**
 * The left dock's "Background tasks" group for a Claude Agent: shells,
 * monitors, workflows and MCP tasks Claude runs in the background, read from
 * the loaded Turns (no request of its own). Sub-agents keep their own group.
 */
export function ConversationBackgroundTaskDock({ agent, turns: loaded, running, onNavigate }: {
  agent: Agent;
  turns: readonly NativeTurn[];
  /** Those Core lists from outside the loaded window while they run. */
  running?: readonly RunningCall[];
  onNavigate: (turnId: string) => void;
}) {
  const live = agent.connectionState === "connected";
  const claude = agent.harness === "claude";
  const [now, setNow] = useState(() => Date.now());
  const turns = useMemo(() => withRunningCalls(loaded, running), [loaded, running]);
  const language = useLanguage();
  const entries = useMemo(
    () => (claude ? claudeBackgroundDockEntries(agent.id, turns, live, now, language) : NONE),
    [agent.id, claude, turns, live, now, language],
  );
  // A "Stopping…" node becomes what Claude last reported once its wait ends.
  const nextExpiry = useMemo(() => {
    if (!claude) return null;
    const ends = claudeBackgroundTasks(turns, live, now)
      .filter((entry) => stopPending(entry.record, now))
      .map((entry) => Date.parse(entry.record.stopRequestedAt!) + STOP_WAIT_MS);
    return ends.length ? Math.min(...ends) : null;
  }, [claude, turns, live, now]);
  useEffect(() => {
    if (nextExpiry === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [nextExpiry]);
  if (!entries.length) return null;
  return <SubAgentDock agentId={agent.id} turns={NO_TURNS} entries={entries} onNavigate={onNavigate} group={groupOf(language)} />;
}
