import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, Plug } from "lucide-react";
import { api } from "./api";
import { strings, type Language } from "./i18n";
import type { Agent } from "./types";
import "./claude-mcp-status.css";

type Server = { name: string; status: string; reason?: string };
type View = {
  state: string; reason: string; generation: number | null; sessionId: string | null;
  checkedAt: string | null; stale: boolean; freshForSeconds: number;
  observation: { observedAt: string; servers: Server[]; total: number; truncated: boolean } | null;
};

// The panel's own words: English unless the page that shows it passes its
// language (T-189: Settings → Runtime & versions). Service names come as
// reported.
const text = strings({
  statuses: {
    connected: "Connected", failed: "Failed", "needs-auth": "Needs authentication",
    pending: "Connecting", disabled: "Disabled", unknown: "Unknown",
  } as Record<string, string>,
  reasons: {
    authentication: "Authentication was rejected. Check this service in Claude Code.",
    timeout: "The service did not respond in time.",
    executable: "Claude Code could not start the service executable.",
    connection: "Claude Code could not connect to the service.",
    configuration: "Claude Code reported a configuration problem.",
    failed: "Claude Code reported a failure. Check its MCP settings for details.",
  } as Record<string, string>,
  notices: {
    closed: "This Agent is closed. Current MCP status is unavailable.",
    remote_unavailable: "MCP status is unavailable for this remote runtime.",
    initializing: "Claude Code is still connecting. Refresh when it is ready.",
    not_connected: "Claude Code is disconnected or has not started. Current MCP status is unavailable.",
    unsupported: "This Claude runtime does not support MCP status queries.",
    changed: "The Claude session changed during the read. Refresh to check the current session.",
    read_failed: "Could not read MCP status. Try refreshing.",
    expired: "This observation is over a minute old. Refresh to check current status.",
    not_observed: "MCP status has not been checked for this connection.",
  } as Record<string, string>,
  heading: "MCP services",
  section: "Claude MCP services",
  refresh: "Refresh MCP status",
  reading: "Reading Claude Code status…",
  reported: "Reported by this Claude Code session.",
  unknown: "Status unknown.",
  previous: "Previous observation",
  observed: "Observed",
  noneThen: "No services were reported then.",
  none: "No MCP services reported.",
  showing: (shown: number, total: number) => `Showing ${shown} of ${total} reported services.`,
  authBefore: "Authenticate through ",
  authAfter: " in Claude Code on the Core host, in this Agent’s folder, then refresh.",
  authHelp: "Authentication help",
}, {
  statuses: { connected: "已连接", failed: "失败", "needs-auth": "需要认证", pending: "正在连接", disabled: "已停用", unknown: "未知" },
  reasons: {
    authentication: "认证被拒绝。请在 Claude Code 中检查此服务。",
    timeout: "服务没有及时响应。",
    executable: "Claude Code 无法启动服务的可执行文件。",
    connection: "Claude Code 无法连接到服务。",
    configuration: "Claude Code 报告了配置问题。",
    failed: "Claude Code 报告了失败。请查看其 MCP 设置了解详情。",
  },
  notices: {
    closed: "此 Agent 已关闭。当前 MCP 状态不可用。",
    remote_unavailable: "此远程运行环境的 MCP 状态不可用。",
    initializing: "Claude Code 仍在连接。就绪后请刷新。",
    not_connected: "Claude Code 已断开或尚未启动。当前 MCP 状态不可用。",
    unsupported: "此 Claude 运行环境不支持查询 MCP 状态。",
    changed: "读取期间 Claude 会话发生了变化。请刷新以检查当前会话。",
    read_failed: "无法读取 MCP 状态。请尝试刷新。",
    expired: "这次观察已超过一分钟。请刷新以检查当前状态。",
    not_observed: "尚未为此连接检查 MCP 状态。",
  },
  heading: "MCP 服务",
  section: "Claude MCP 服务",
  refresh: "刷新 MCP 状态",
  reading: "正在读取 Claude Code 状态…",
  reported: "由此 Claude Code 会话报告。",
  unknown: "状态未知。",
  previous: "上一次观察",
  observed: "观察于",
  noneThen: "当时没有报告服务。",
  none: "没有报告 MCP 服务。",
  showing: (shown, total) => `显示报告的 ${total} 个服务中的 ${shown} 个。`,
  authBefore: "在 Core 主机上此 Agent 的文件夹中，通过 Claude Code 的 ",
  authAfter: " 认证，然后刷新。",
  authHelp: "认证帮助",
});

type Options = {
  /** Open with what the last read found and ask Claude Code only on Refresh
   * (Settings, T-191); the inspector asks once when nothing was read yet. */
  cachedOnOpen?: boolean;
  heading?: string;
  headingLevel?: 2 | 5;
  /** The page's language, where it translates this panel; English otherwise. */
  language?: Language;
};

/** Remount before painting a different Agent/session/environment's observation. */
export function ClaudeMcpStatus({ agent, ...options }: { agent: Agent } & Options) {
  const identity = JSON.stringify([agent.id, agent.cwd, agent.claudeSessionId,
    agent.remote?.machine.id, agent.remote?.runtime?.instanceId, agent.connectionState, agent.closedAt]);
  return <StatusPanel key={identity} agent={agent} {...options} />;
}

function StatusPanel({ agent, cachedOnOpen = false, heading, headingLevel = 2, language = "en" }: { agent: Agent } & Options) {
  const t = text(language);
  const { statuses, reasons, notices } = t;
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const active = useRef(true);
  const pending = useRef(false);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const path = `/agents/${encodeURIComponent(agent.id)}/claude/mcp-status`;
  const load = async (refresh: boolean) => {
    if (pending.current) return;
    pending.current = true;
    const sequence = ++request.current;
    const abort = new AbortController();
    controller.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 45_000);
    setBusy(true);
    try {
      const result = await api<View>(refresh || !cachedOnOpen ? path : `${path}?cached=true`, { signal: abort.signal,
        ...(refresh ? { method: "POST", body: "{}" } : {}) });
      if (active.current && sequence === request.current) {
        setView(result); setFailed(false); setNow(Date.now());
      }
    } catch {
      // Native or proxy error text is not a display-safe status response.
      if (active.current && sequence === request.current) setFailed(true);
    } finally {
      window.clearTimeout(timeout);
      if (active.current && sequence === request.current) { pending.current = false; setBusy(false); }
    }
  };
  useEffect(() => {
    active.current = true;
    void load(false);
    // Age the label locally; this timer makes no API/native requests.
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => { active.current = false; ++request.current; pending.current = false;
      controller.current?.abort(); window.clearInterval(timer); };
  }, [path]);

  const observation = view?.observation;
  const expired = !!observation && now - Date.parse(observation.observedAt) >= (view?.freshForSeconds ?? 60) * 1000;
  const disconnected = agent.connectionState !== "connected" || !!agent.closedAt;
  const stale = failed || disconnected || view?.stale || expired;
  const notice = failed ? notices.read_failed : disconnected
    ? (agent.closedAt ? notices.closed : agent.connectionState === "connecting" ? notices.initializing : notices.not_connected)
    : expired && view?.state === "ready" ? notices.expired : notices[view?.reason ?? ""];
  const hasAuth = observation?.servers.some(server => server.status === "needs-auth");
  const Heading = headingLevel === 5 ? "h5" : "h2";
  return <section className="inspector-section claude-mcp-status" aria-label={t.section}>
    <div className="section-title">
      <Heading><Plug size={14} />{heading ?? t.heading}</Heading>
      <button type="button" className="icon-button" aria-label={t.refresh} title={t.refresh}
        disabled={busy || disconnected} onClick={() => void load(true)}>
        <RefreshCw size={13} className={busy ? "mcp-refreshing" : undefined} />
      </button>
    </div>
    <p className="mcp-status-note" role="status">
      {busy ? t.reading : notice ?? (view?.state === "ready" ? t.reported : t.unknown)}
    </p>
    {observation && <>
      <p className="mcp-observed">{stale ? t.previous : t.observed} · <time dateTime={observation.observedAt}>
        {new Date(observation.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </time></p>
      {observation.servers.length === 0 ? <p className="mcp-status-note">{stale ? t.noneThen : t.none}</p> :
        <ul className="mcp-server-list" data-stale={stale || undefined}>
          {observation.servers.map((server, index) => <li key={`${index}:${server.name}`}>
            <div className="mcp-server-heading"><span className="mcp-server-name">{server.name}</span>
              <span className="mcp-server-state" data-state={stale ? "unknown" : server.status}>
                {statuses[server.status] ?? statuses.unknown}
              </span></div>
            {server.status === "failed" && <p>{reasons[server.reason ?? "failed"] ?? reasons.failed}</p>}
          </li>)}
        </ul>}
      {observation.truncated && <p className="mcp-status-note">{t.showing(observation.servers.length, observation.total)}</p>}
    </>}
    {hasAuth && <p className="mcp-auth-help">{t.authBefore}<code>/mcp</code>{t.authAfter}
      {" "}<a href="https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers" target="_blank" rel="noreferrer">{t.authHelp} <ExternalLink size={11} /></a>
    </p>}
  </section>;
}
