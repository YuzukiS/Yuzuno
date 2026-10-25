import { useEffect, useRef, useState } from "react";
import { Plug, RefreshCw } from "lucide-react";
import { api } from "./api";
import { strings, type Language } from "./i18n";
import type { Agent } from "./types";
import "./claude-mcp-status.css";

type Server = { name: string; status: string; error: string | null; failureReason: string | null; observedAt: string };
type View = { state: string; reason: string; generation: number | null; servers: Server[]; more: number };

/** Codex's startup states, and the colour each takes in the shared list. */
const states: Record<string, string> = { starting: "pending", ready: "connected", failed: "failed", cancelled: "disabled", unknown: "unknown" };

// The panel's own words: English unless the page that shows it passes its
// language (T-189: Settings → Runtime & versions). Server names and the
// errors Codex reported come as they are.
const text = strings({
  statuses: {
    starting: "Starting", ready: "Ready at startup", failed: "Failed to start", cancelled: "Start cancelled", unknown: "Unknown state",
  } as Record<string, string>,
  heading: "MCP services",
  section: "Codex MCP services",
  readAgain: "Read MCP startup reports again",
  readAgainTitle: "Read again (asks Codex nothing)",
  note: "Startup states this connection received, with when each was last seen. Codex is not asked here: ready means ready when it started, not checked since; tools and sign-in are not shown.",
  closed: "This Agent is closed.",
  notConnected: "Codex is not connected. Its MCP services report here once this Agent connects.",
  failed: "Could not read the startup reports. Try again.",
  unavailable: "MCP status is unavailable.",
  noReport: "No startup report received on this connection yet. That does not mean none are configured, or that all are fine.",
  seen: "Seen ",
  reauth: "Codex needs this server signed in again. Sign in with Codex on that machine, then reconnect this Agent.",
  more: (n: number) => `${n} more startup ${n === 1 ? "report" : "reports"} came in and ${n === 1 ? "is" : "are"} not shown.`,
}, {
  statuses: { starting: "正在启动", ready: "启动时就绪", failed: "启动失败", cancelled: "启动已取消", unknown: "状态未知" },
  heading: "MCP 服务",
  section: "Codex MCP 服务",
  readAgain: "重新读取 MCP 启动报告",
  readAgainTitle: "重新读取（不会询问 Codex）",
  note: "此连接收到的启动状态，以及每项最后一次出现的时间。这里不会询问 Codex：“就绪”指启动时就绪，之后没有再检查；不显示工具和登录状态。",
  closed: "此 Agent 已关闭。",
  notConnected: "Codex 未连接。此 Agent 连接后，它的 MCP 服务会在这里报告。",
  failed: "无法读取启动报告。请重试。",
  unavailable: "MCP 状态不可用。",
  noReport: "此连接尚未收到启动报告。这不代表没有配置任何服务，也不代表一切正常。",
  seen: "最后出现于 ",
  reauth: "Codex 需要重新登录此服务器。请在那台机器上用 Codex 登录，然后重新连接此 Agent。",
  more: (n) => `另有 ${n} 份启动报告已收到但未显示。`,
});

const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * `/mcp` for a Codex Agent (T-29): its MCP services as they reported starting
 * on this connection, kept by Core for this connection only. Reading, or
 * Refresh, asks Codex nothing: Codex's own status list would start every
 * configured server to list it. So "ready" is what a server reported as it
 * started, not a later health check; there are no tools or sign-in states;
 * and an empty list means no report yet, not that none are configured.
 * Remounts for another Agent or connection; reads nothing while there is no
 * connection to have reported.
 */
type Options = {
  heading?: string;
  headingLevel?: 2 | 5;
  /** The inspector's /mcp scrolls to this panel by its id; another copy
   * (Settings, T-191) must not take it. */
  anchor?: boolean;
  /** The page's language, where it translates this panel; English otherwise. */
  language?: Language;
};

export function CodexMcpStatus({ agent, ...options }: { agent: Agent } & Options) {
  return <StatusPanel key={JSON.stringify([agent.id, agent.connectionState, agent.closedAt])} agent={agent} {...options} />;
}

function StatusPanel({ agent, heading, headingLevel = 2, anchor = true, language = "en" }: { agent: Agent } & Options) {
  const t = text(language);
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const connected = agent.connectionState === "connected" && !agent.closedAt;
  const path = `/agents/${encodeURIComponent(agent.id)}/codex/mcp`;
  const load = async () => {
    const sequence = ++request.current;
    setBusy(true);
    try {
      const result = await api<View>(path);
      if (sequence === request.current) { setView(result); setFailed(false); }
    } catch {
      if (sequence === request.current) setFailed(true);
    } finally {
      if (sequence === request.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (connected) void load();
    return () => { ++request.current; };
  }, [path, connected]);

  const servers = connected && view?.state === "observed" ? view.servers : [];
  const notice = agent.closedAt ? t.closed
    : !connected || view?.reason === "not_connected" ? t.notConnected
      : failed ? t.failed
        : view && view.state !== "observed" ? t.unavailable
          : view && !servers.length ? t.noReport
            : null;
  const Heading = headingLevel === 5 ? "h5" : "h2";
  return <section id={anchor ? "agent-mcp-status" : undefined} tabIndex={anchor ? -1 : undefined} className="inspector-section claude-mcp-status" aria-label={t.section}>
    <div className="section-title">
      <Heading><Plug size={14} />{heading ?? t.heading}</Heading>
      <button type="button" className="icon-button" aria-label={t.readAgain} title={t.readAgainTitle}
        disabled={busy || !connected} onClick={() => void load()}>
        <RefreshCw size={13} className={busy ? "mcp-refreshing" : undefined} />
      </button>
    </div>
    <p className="mcp-status-note">{t.note}</p>
    {notice && <p className="mcp-status-note" role="status">{notice}</p>}
    {servers.length > 0 && <ul className="mcp-server-list">
      {servers.map((server) => {
        const label = t.statuses[server.status] ?? t.statuses.unknown;
        const state = states[server.status] ?? states.unknown;
        return <li key={server.name}>
          <div className="mcp-server-heading"><span className="mcp-server-name">{server.name}</span>
            <span className="mcp-server-state" data-state={state}>{label}</span></div>
          <p className="mcp-observed">{t.seen}<time dateTime={server.observedAt}>{time(server.observedAt)}</time></p>
          {server.failureReason === "reauthenticationRequired" && <p>{t.reauth}</p>}
          {server.error && <p>{server.error}</p>}
        </li>;
      })}
    </ul>}
    {/* Counted per report, not per server: a server may report more than once. */}
    {!!view?.more && <p className="mcp-status-note">{t.more(view.more)}</p>}
  </section>;
}
