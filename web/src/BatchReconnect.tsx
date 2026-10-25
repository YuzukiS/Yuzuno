import { useEffect, useState } from "react";
import { LoaderCircle, RotateCw } from "lucide-react";
import { reconnectOffer } from "./agent-actions";
import {
  batchCandidates,
  busy,
  choose,
  choosable,
  forgetSettled,
  forgetStale,
  reconnectBatch,
  remember,
  useBatch,
  type BatchOutcome,
} from "./batch-reconnect";
import { Modal } from "./components";
import { langTag, strings, useLanguage } from "./i18n";
import { ALL_PROJECTS, inScope, type ProjectScope } from "./projects";
import type { Agent } from "./types";
import "./batch-reconnect.css";

// The dialog's own words (T-189); Agent and machine names, and what Core
// answered a reconnect, as they came.
const text = strings({
  reported: {
    idle: "Ready",
    working: "Working",
    waiting: "Waiting for you",
    offline: "Offline",
    error: "Needs a look",
    uncertain: "Result unconfirmed",
  } as Record<Agent["status"], string>,
  skipped: {
    gone: "no longer in this workspace",
    closed: "closed since, and not reopened here",
    session: "its session changed; choose it again",
    connecting: "Core is already connecting it",
    connected: "already connected",
  } as Record<"gone" | "closed" | "session" | "connecting" | "connected", string>,
  queued: "Waiting…",
  reconnecting: "Reconnecting…",
  failed: (error: string) => `Couldn’t reconnect: ${error}`,
  skippedAs: (why: string) => `Skipped: ${why}`,
  reconnected: "Reconnected",
  stillConnecting: "Core is still connecting",
  unconfirmed: "Result unconfirmed",
  stillOffline: "Still offline",
  connected: (state: string) => `Connected · ${state}`,
  disconnectedUnconfirmed: "Disconnected by you, stop not confirmed; nothing starts it automatically. Tick it to reconnect it",
  disconnected: "Disconnected by you; tick it to reconnect it",
  offline: "Offline",
  summary: {
    reconnected: (count: number) => `${count} reconnected`,
    notYet: (count: number) => `${count} not connected yet`,
    failed: (count: number) => `${count} couldn’t reconnect`,
    skipped: (count: number) => `${count} skipped`,
    going: (count: number) => `${count} on the way`,
  },
  buttonLabel: (count: number) => (count ? `Reconnect agents: ${count} not connected` : "Reconnect agents: reconnecting"),
  title: "Reconnect agents",
  description: "Agents whose session isn’t connected, for example after Core restarted. Reconnecting opens the same session; nothing is sent and drafts stay.",
  include: (count: number) => `Include other projects (${count})`,
  allConnected: "Every agent here is connected.",
  list: "Agents to reconnect",
  host: "Core host",
  retry: "Retry",
  close: "Close dialog",
  closing: "Closing this doesn’t cancel anything: reconnects already started or queued go on, and their results stay here.",
  selectAll: "Select all",
  clear: "Clear",
  reconnectCount: (count: number) => `Reconnect ${count}`,
  reconnect: "Reconnect",
}, {
  reported: {
    idle: "就绪",
    working: "工作中",
    waiting: "等待你",
    offline: "离线",
    error: "需要查看",
    uncertain: "结果未确认",
  },
  skipped: {
    gone: "已不在此 Workspace 中",
    closed: "之后已关闭，且未在此处重新打开",
    session: "它的会话已改变；请重新选择",
    connecting: "Core 已在连接它",
    connected: "已连接",
  },
  queued: "等待中…",
  reconnecting: "正在重新连接…",
  failed: (error) => `无法重新连接：${error}`,
  skippedAs: (why) => `已跳过：${why}`,
  reconnected: "已重新连接",
  stillConnecting: "Core 仍在连接",
  unconfirmed: "结果未确认",
  stillOffline: "仍然离线",
  connected: (state) => `已连接 · ${state}`,
  disconnectedUnconfirmed: "由你断开，停止尚未确认；不会自动启动。勾选它即可重新连接",
  disconnected: "由你断开；勾选它即可重新连接",
  offline: "离线",
  summary: {
    reconnected: (count) => `${count} 个已重新连接`,
    notYet: (count) => `${count} 个尚未连接`,
    failed: (count) => `${count} 个无法重新连接`,
    skipped: (count) => `${count} 个已跳过`,
    going: (count) => `${count} 个进行中`,
  },
  buttonLabel: (count) => (count ? `重新连接 Agent：${count} 个未连接` : "重新连接 Agent：正在重新连接"),
  title: "重新连接 Agent",
  description: "会话未连接的 Agent，例如在 Core 重启之后。重新连接会打开同一会话；不会发送任何内容，草稿会保留。",
  include: (count) => `包括其他项目（${count}）`,
  allConnected: "这里的每个 Agent 都已连接。",
  list: "要重新连接的 Agent",
  host: "Core 主机",
  retry: "重试",
  close: "关闭对话框",
  closing: "关闭此窗口不会取消任何操作：已开始或排队的重新连接会继续，结果会保留在这里。",
  selectAll: "全选",
  clear: "清除",
  reconnectCount: (count) => `重新连接 ${count} 个`,
  reconnect: "重新连接",
});
type Text = ReturnType<typeof text>;

/** What a row says: what its reconnect answered, or how Core lists it now. */
function stateText(agent: Agent, outcome: BatchOutcome | undefined, t: Text): string {
  switch (outcome?.state) {
    case "waiting":
      return t.queued;
    case "running":
      return t.reconnecting;
    case "failed":
      return t.failed(outcome.error);
    case "skipped":
      return t.skippedAs(t.skipped[outcome.why]);
    case "done": {
      const after = outcome.agent;
      if (!after) return t.reconnected;
      const offer = reconnectOffer(after);
      if (offer === "connecting") return t.stillConnecting;
      if (offer === "check") return t.unconfirmed;
      if (offer === "reconnect") return t.stillOffline;
      return t.connected(t.reported[after.status]);
    }
  }
  const offer = reconnectOffer(agent);
  if (offer === "reconnect" && agent.disconnectedAt)
    return agent.disconnectUnconfirmed ? t.disconnectedUnconfirmed : t.disconnected;
  return offer === "connecting" ? t.reconnecting : offer === "check" ? t.unconfirmed : t.offline;
}

/**
 * Reconnecting several Agents at once, for example after Core restarted
 * (T-184): a rail button, shown while any Agent can be reconnected, opens a
 * list of them. Nothing is chosen for the user. Each chosen Agent goes
 * through the same reconnect as its own menu, a few at a time; nothing is
 * sent, closed Agents are not listed, and each row says what Core answered.
 */
export function BatchReconnect({
  workspaceId,
  agents,
  scope,
  onSettled,
}: {
  workspaceId: string;
  /** The Workspace's Agents, closed ones included (they are left out). */
  agents: Agent[];
  /** The list's project scope: the dialog's default view. */
  scope: ProjectScope;
  /** After each reconnect, to read the Workspace again. */
  onSettled: () => void;
}) {
  const language = useLanguage();
  const t = text(language);
  const [open, setOpen] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const batch = useBatch(workspaceId);
  // What a queued reconnect is checked against before it is sent.
  useEffect(() => remember(workspaceId, agents), [workspaceId, agents]);
  const candidates = batchCandidates(agents);
  const count = candidates.filter(choosable).length;
  const running = busy(batch);
  // Kept while a batch runs, so its results can be opened again.
  if (!count && !open && !running) return null;

  const wide = everywhere || scope === ALL_PROJECTS;
  // A failure stays listed while the Agent still needs a reconnect; one
  // reconnected since (from its menu, say) is not shown as failed again.
  const listed = (agent: Agent) => {
    const outcome = batch.outcomes.get(agent.id);
    return candidates.includes(agent) || (!!outcome && outcome.state !== "failed");
  };
  const rows = agents.filter((agent) => listed(agent) && (wide || inScope(agent, scope)));
  const elsewhere = scope === ALL_PROJECTS ? 0 : candidates.filter((agent) => !inScope(agent, scope)).length;
  const pending = (id: string) => {
    const state = batch.outcomes.get(id)?.state;
    return state === "waiting" || state === "running";
  };
  // Only what the dialog shows runs: a choice hidden by the scope does not.
  const ready = rows.filter((agent) => batch.selected.has(agent.id) && choosable(agent) && !pending(agent.id));
  // One the user disconnected is reconnected only when they tick it
  // themselves, never by Select all (T-184).
  const offered = rows.filter((agent) => choosable(agent) && !pending(agent.id) && !agent.disconnectedAt);
  const readyOffered = ready.filter((agent) => !agent.disconnectedAt);
  // Said again for a screen reader as answers come in.
  const counts = { reconnected: 0, notYet: 0, failed: 0, skipped: 0, going: 0 };
  for (const agent of rows) {
    const outcome = batch.outcomes.get(agent.id);
    if (outcome?.state === "waiting" || outcome?.state === "running") counts.going++;
    else if (outcome?.state === "failed") counts.failed++;
    else if (outcome?.state === "skipped") counts.skipped++;
    else if (outcome?.state === "done") {
      if (outcome.agent && reconnectOffer(outcome.agent) === null) counts.reconnected++;
      else counts.notYet++;
    }
  }
  const summary = [
    counts.reconnected ? t.summary.reconnected(counts.reconnected) : "",
    counts.notYet ? t.summary.notYet(counts.notYet) : "",
    counts.failed ? t.summary.failed(counts.failed) : "",
    counts.skipped ? t.summary.skipped(counts.skipped) : "",
    counts.going ? t.summary.going(counts.going) : "",
  ].filter(Boolean).join(" · ");

  return (
    <>
      <button
        type="button"
        className="icon-button rail-reconnect"
        aria-label={t.buttonLabel(count)}
        title={t.title}
        onClick={() => {
          forgetStale(workspaceId, new Set(candidates.filter(choosable).map((agent) => agent.id)));
          setOpen(true);
        }}
      >
        {count ? (
          <>
            <RotateCw size={13} />
            <span>{count}</span>
          </>
        ) : (
          <LoaderCircle size={13} className="spin" />
        )}
      </button>
      <Modal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) forgetSettled(workspaceId);
        }}
        title={t.title}
        description={t.description}
        className="batch-reconnect"
        lang={langTag(language)}
        closeLabel={t.close}
      >
        {elsewhere > 0 && (
          <label className="batch-scope">
            <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} />
            {t.include(elsewhere)}
          </label>
        )}
        {rows.length === 0 ? (
          <p className="batch-empty">{t.allConnected}</p>
        ) : (
          <ul className="batch-list" aria-label={t.list}>
            {rows.map((agent) => {
              const outcome = batch.outcomes.get(agent.id);
              const can = choosable(agent) && !pending(agent.id);
              return (
                <li key={agent.id} className="batch-row" data-state={outcome?.state ?? (can ? "idle" : "busy")}>
                  <label>
                    <input
                      type="checkbox"
                      checked={can && batch.selected.has(agent.id)}
                      disabled={!can}
                      onChange={(e) => choose(workspaceId, [agent.id], e.target.checked)}
                    />
                    <span className="batch-name">{agent.name}</span>
                    <span className="batch-machine">{agent.remote?.machine.name || t.host}</span>
                  </label>
                  <span className="batch-state">
                    {(outcome?.state === "running" || outcome?.state === "waiting") && (
                      <LoaderCircle size={13} className="spin" aria-hidden="true" />
                    )}
                    {stateText(agent, outcome, t)}
                  </span>
                  {outcome?.state === "failed" && can && (
                    <button
                      type="button"
                      className="quiet-button"
                      onClick={() => reconnectBatch(workspaceId, [agent], onSettled)}
                    >
                      {t.retry}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="batch-summary" role="status">
          {summary}
        </p>
        {running && (
          <p className="batch-note">{t.closing}</p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={!offered.length && !ready.length}
            // Select all chooses what it offers; Clear unchooses every row,
            // one the user ticked themselves too (T-184).
            onClick={() =>
              readyOffered.length < offered.length
                ? choose(workspaceId, offered.map((agent) => agent.id), true)
                : choose(workspaceId, ready.map((agent) => agent.id), false)
            }
          >
            {readyOffered.length < offered.length ? t.selectAll : t.clear}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!ready.length}
            onClick={() => reconnectBatch(workspaceId, ready, onSettled)}
          >
            {running && <LoaderCircle size={15} className="spin" />}
            {ready.length ? t.reconnectCount(ready.length) : running ? t.reconnecting : t.reconnect}
          </button>
        </div>
      </Modal>
    </>
  );
}
