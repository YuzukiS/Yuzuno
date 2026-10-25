import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, post } from "./api";
import type { Agent } from "./types";
import { strings, useStrings } from "./i18n";
import "./codex-plan-usage.css";

type Window = {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
  observedAt: string;
};
export type CodexUsage = {
  revision: number;
  status:
    | "ready"
    | "unknown"
    | "unavailable"
    | "unsupported"
    | "disconnected"
    | "error";
  account: {
    type: string | null;
    label: string | null;
    planType: string | null;
  } | null;
  accountId: string | null;
  source: {
    generation: string;
    label: string;
    machineId: string | null;
    runtimeId: string | null;
  };
  checkedAt: string | null;
  observedAt: string | null;
  ordinaryUsageAllowed: boolean | null;
  error: string | null;
  buckets: {
    limitId: string;
    limitName: string | null;
    planType: string | null;
    primary: Window | null;
    secondary: Window | null;
    observedAt: string;
    credits: {
      hasCredits: boolean | null;
      unlimited: boolean | null;
      balance: string | null;
    } | null;
  }[];
};

// StrictMode and concurrent mounts share one read. No persistent account cache
// and no sharing across Agents or Core origins.
const reads = new Map<string, Promise<CodexUsage>>();
function read(agentId: string, force: boolean) {
  const pending = reads.get(agentId);
  if (pending) return pending;
  const path = `/agents/${encodeURIComponent(agentId)}/codex/usage`;
  const promise = (
    force ? post<CodexUsage>(path) : api<CodexUsage>(path)
  ).finally(() => {
    if (reads.get(agentId) === promise) reads.delete(agentId);
  });
  reads.set(agentId, promise);
  return promise;
}
export function duration(mins: number | null) {
  if (!mins) return "Window";
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}
function date(value: string | number | null, unknown = "unknown") {
  if (value === null) return unknown;
  const result = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isFinite(result.getTime())
    ? result.toLocaleString()
    : unknown;
}

// The panel's own words (T-189). A window's name and the detail of each
// window stay as usageWindows words them, as in the status bar.
const text = strings({
  noConnection: "Native connection unavailable",
  noLive: "Live updates disconnected",
  keptPrevious: "Could not refresh; previous report retained",
  noApiKey: "Not available for API-key authentication",
  notFor: (type: string) => `Not available for ${type}`,
  notSignedIn: "Not signed in",
  accountChanged: "Account changed; waiting for a new report",
  checking: "Checking…",
  unknown: "Unknown",
  noWindows: "No quota windows reported",
  source: (label: string, generation: string, account: string | null) =>
    `${label} · native connection ${generation}${account ? ` · account ${account}` : " · account ID not supplied"}`,
  coreHost: "Core host",
  account: "Account",
  planUsage: "Plan usage",
  waiting: "Waiting for update",
  lastReport: "Last report",
  used: (percent: number) => `${percent}% used`,
  detailsTitle: "Account source, reset times and observation time",
  details: "Details",
  shared: (source: string) => `Shared account quota · ${source}`,
  credits: (name: string) => `${name} credits: `,
  unlimited: "unlimited (reported)",
  noneReported: "none reported",
  unknownValue: "unknown",
  ordinary: "Ordinary usage: ",
  allowed: "allowed (reported)",
  notAllowed: "not allowed (reported)",
  observed: (observed: string, checked: string) => `Observed: ${observed} · Checked: ${checked}`,
  refresh: "Refresh Codex plan usage",
  cooldown: "Recently checked; refresh available shortly",
  read: "Read account usage from this Agent’s native connection",
}, {
  noConnection: "原生连接不可用",
  noLive: "实时更新已断开",
  keptPrevious: "无法刷新；保留了之前的报告",
  noApiKey: "使用 API 密钥认证时不可用",
  notFor: (type) => `${type} 不可用`,
  notSignedIn: "未登录",
  accountChanged: "账户已更改；正在等待新的报告",
  checking: "正在检查…",
  unknown: "未知",
  noWindows: "未报告任何额度窗口",
  source: (label, generation, account) => `${label} · 原生连接 ${generation}${account ? ` · 账户 ${account}` : " · 未提供账户 ID"}`,
  coreHost: "Core 主机",
  account: "账户",
  planUsage: "套餐用量",
  waiting: "等待更新",
  lastReport: "上次报告",
  used: (percent) => `已用 ${percent}%`,
  detailsTitle: "账户来源、重置时间和观测时间",
  details: "详情",
  shared: (source) => `共享账户额度 · ${source}`,
  credits: (name) => `${name} 额度：`,
  unlimited: "无限（据报告）",
  noneReported: "未报告",
  unknownValue: "未知",
  ordinary: "普通用量：",
  allowed: "允许（据报告）",
  notAllowed: "不允许（据报告）",
  observed: (observed, checked) => `观测：${observed} · 检查：${checked}`,
  refresh: "刷新 Codex 套餐用量",
  cooldown: "刚检查过；稍后即可刷新",
  read: "从此 Agent 的原生连接读取账户用量",
});
export function usageWindows(usage: CodexUsage, now: number) {
  return usage.buckets.flatMap((bucket) =>
    [bucket.primary, bucket.secondary].flatMap((w, index) => {
      if (!w) return [];
      const expired = w.resetsAt !== null && w.resetsAt * 1000 <= now;
      const stale =
        !Number.isFinite(Date.parse(w.observedAt)) ||
        now - Date.parse(w.observedAt) > 300_000;
      const unavailable = usage.status !== "ready";
      return [
        {
          key: `${bucket.limitId}:${index}`,
          name: `${bucket.limitName || bucket.limitId} · ${duration(w.windowDurationMins)}`,
          text: expired
            ? "Waiting for update"
            : stale || unavailable
              ? "Last report"
              : w.usedPercent === null
                ? "Unknown"
                : `${w.usedPercent}% used`,
          percent: w.usedPercent,
          expired,
          stale: stale || unavailable,
          detail: `${bucket.limitName || bucket.limitId}: ${w.usedPercent === null ? "usage unknown" : `${w.usedPercent}% used at last report`}. ${expired ? "Reset time passed; waiting for a new report." : ""} Resets: ${date(w.resetsAt)}. Observed: ${date(w.observedAt)}.`,
        },
      ];
    }),
  );
}

/**
 * One Agent's Codex plan usage as its native connection reports it: read
 * while shown, kept current by usage events, cleared on a stream reset or
 * for another Agent. Never kept on the device or shared across Agents.
 * `tick` is how often time alone rechecks the reset and staleness labels.
 * No Agent (null) reads nothing.
 *
 * A report belongs to the Agent and connection it was read for: a render
 * for any other (before the effect clears it, as when an unkeyed caller
 * switches Agents) gets none.
 */
export function useCodexUsage(
  agent: Agent | null,
  streamConnected: boolean,
  tick = 1000,
) {
  const [usage, setUsage] = useState<{
    scope: string;
    value: CodexUsage;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const request = useRef<(force?: boolean) => void>(() => {});
  const id = agent?.id ?? null;
  const connected =
    !!agent && agent.connectionState === "connected" && !agent.closedAt;
  const scope = `${id}|${connected}|${streamConnected}`;
  const previousConnection = useRef({
    id,
    connected,
    streamConnected,
  });
  useEffect(() => {
    let alive = true,
      pending = false,
      invalidated = false;
    let epoch = 0,
      latest: CodexUsage | null = null;
    const previous = previousConnection.current;
    if (
      id &&
      previous.id === id &&
      (previous.connected !== connected ||
        previous.streamConnected !== streamConnected)
    )
      reads.delete(id);
    previousConnection.current = { id, connected, streamConnected };
    setUsage(null);
    setError(false);
    setBusy(false);
    request.current = () => {};
    if (!id) return;
    const accept = (value: CodexUsage) => {
      if (latest && latest.revision > value.revision) return false;
      latest = value;
      setUsage({ scope, value });
      setError(false);
      return true;
    };
    const load = (force = false) => {
      if (!alive || pending || !connected || !streamConnected) return;
      const requestedEpoch = epoch;
      pending = true;
      setBusy(true);
      void read(id, force)
        .then(
          (value) => {
            if (alive && requestedEpoch === epoch) accept(value);
          },
          () => {
            if (alive && requestedEpoch === epoch) setError(true);
          },
        )
        .finally(() => {
          pending = false;
          if (alive) {
            setBusy(false);
            if (invalidated) {
              invalidated = false;
              load();
            }
          }
        });
    };
    request.current = load;
    const update = (event: Event) => {
      const data = (
        event as CustomEvent<{ agentId: string; usage: CodexUsage } | null>
      ).detail;
      if (!data) {
        epoch++;
        latest = null;
        setUsage(null);
        setError(false);
        if (pending) invalidated = true;
        else load();
        return;
      }
      if (data.agentId !== id) return;
      if (!accept(data.usage)) return;
      if (
        data.usage.status === "unknown" ||
        data.usage.status === "disconnected"
      )
        epoch++;
      if (data.usage.status === "unknown") {
        if (pending) invalidated = true;
        else load();
      }
    };
    window.addEventListener("yuzuno:codex-usage", update);
    load();
    // Time alone can make a reset/staleness label obsolete; never polls Core.
    const timer = window.setInterval(() => setClock(Date.now()), tick);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("yuzuno:codex-usage", update);
    };
  }, [id, connected, streamConnected, tick]);
  return {
    usage: usage?.scope === scope ? usage.value : null,
    busy,
    error,
    clock,
    connected,
    refresh: (force?: boolean) => request.current(force),
  };
}

/** Account facts only: does not mark the conversation read or refetch detail. */
export function CodexPlanUsage({
  agent,
  streamConnected,
}: {
  agent: Agent;
  streamConnected: boolean;
}) {
  const { usage, busy, error, clock, connected, refresh } = useCodexUsage(
    agent,
    streamConnected,
  );
  const t = useStrings(text);
  const live = connected && streamConnected;
  const windows = usage ? usageWindows(usage, clock) : [];
  const cooldown = usage?.checkedAt
    ? Math.max(0, 5000 - (clock - Date.parse(usage.checkedAt)))
    : 0;
  const reason = !connected
    ? t.noConnection
    : !streamConnected
      ? t.noLive
      : error
        ? t.keptPrevious
        : usage?.error ||
          (usage?.status === "unavailable"
            ? usage.account?.type === "apiKey"
              ? t.noApiKey
              : usage.account?.type
                ? t.notFor(usage.account.type)
                : t.notSignedIn
            : usage?.status === "unknown"
              ? t.accountChanged
              : usage?.status === "disconnected"
                ? t.noConnection
                : !usage
                  ? busy
                    ? t.checking
                    : t.unknown
                  : windows.length === 0
                    ? t.noWindows
                    : null);
  const who = [
    usage?.account?.label || usage?.account?.type,
    usage?.account?.planType,
  ]
    .filter(Boolean)
    .join(" · ");
  const source = usage
    ? t.source(usage.source.label, usage.source.generation, usage.accountId)
    : agent.remote?.machine.name || t.coreHost;
  return (
    <>
      {who && (
        <div className="codex-account">
          <dt>{t.account}</dt>
          <dd title={`${who}\n${source}`}>{who}</dd>
        </div>
      )}
      <div className="codex-plan-usage" id="agent-plan-usage">
        <dt>{t.planUsage}</dt>
        <dd>
          <div className="codex-plan-values" aria-live="polite">
            {reason && <span className="codex-plan-note">{reason}</span>}
            {live &&
              windows.map((w) => (
                <span
                  key={w.key}
                  title={w.detail}
                  className="codex-plan-window"
                >
                  <span>{w.name}</span>
                  <span>
                    {w.expired ? t.waiting : w.stale ? t.lastReport : w.percent === null ? t.unknown : t.used(w.percent)}
                    {w.stale && !w.expired && w.percent !== null
                      ? ` · ${w.percent}%`
                      : ""}
                  </span>
                </span>
              ))}
            {usage && live && (
              <details className="codex-plan-details">
                <summary title={t.detailsTitle}>{t.details}</summary>
                <span>{t.shared(source)}</span>
                {windows.map((w) => (
                  <span key={w.key}>{w.detail}</span>
                ))}
                {usage.buckets.map(
                  (b) =>
                    b.credits && (
                      <span key={b.limitId}>
                        {t.credits(b.limitName || b.limitId)}
                        {b.credits.unlimited === true
                          ? t.unlimited
                          : b.credits.balance !== null
                            ? b.credits.balance
                            : b.credits.hasCredits === false
                              ? t.noneReported
                              : t.unknownValue}
                      </span>
                    ),
                )}
                <span>
                  {t.ordinary}
                  {usage.ordinaryUsageAllowed === null
                    ? t.unknownValue
                    : usage.ordinaryUsageAllowed
                      ? t.allowed
                      : t.notAllowed}
                </span>
                <span>{t.observed(date(usage.observedAt, t.unknownValue), date(usage.checkedAt, t.unknownValue))}</span>
              </details>
            )}
          </div>
          <button
            type="button"
            className="codex-plan-refresh"
            aria-label={t.refresh}
            aria-busy={busy}
            disabled={busy || !live || cooldown > 0}
            title={
              cooldown > 0 ? t.cooldown : t.read
            }
            onClick={() => refresh(true)}
          >
            <RefreshCw
              size={13}
              className={busy ? "codex-plan-spinning" : undefined}
            />
          </button>
        </dd>
      </div>
    </>
  );
}
