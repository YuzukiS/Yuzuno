import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { API_BASE } from "./api";
import { strings, useStrings } from "./i18n";
import "./history-composition.css";

/** The parts of a stored record, as GET /api/diagnostics/memory/history
 * names them (core/src/history_composition.rs), in the order shown. They are
 * disjoint, so they add up to the record. */
const RECORD = ["items", "payloads", "turns", "metadata"] as const;
/** Previews are a shorter copy of payloads: stored too, never in the record's sum. */
const PARTS = [...RECORD, "previews"] as const;
type Key = (typeof PARTS)[number];
type Part = { rows: number; bytes: number };
type Parts = Record<Key, Part>;
type Agent = { id: string; name: string | null; unwritten: boolean; whole: boolean; parts: Parts | null };
type Report =
  | { available: true; readAt: string; held: number; agents: Agent[]; total: Parts }
  | { available: false; readAt: string; reason: string };

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const text = (value: unknown, max: number) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);

function parts(value: unknown): Parts | null {
  const v = (value ?? {}) as Record<string, unknown>;
  const out = {} as Parts;
  for (const key of PARTS) {
    const p = (v[key] ?? {}) as Record<string, unknown>;
    const rows = number(p.rows), bytes = number(p.bytes);
    if (rows === null || bytes === null) return null;
    out[key] = { rows, bytes };
  }
  return out;
}

/** Only numbers, names and Core's own reason are taken from the answer. */
export function historyReport(value: unknown): Report | null {
  const v = (value ?? {}) as Record<string, unknown>;
  const readAt = text(v.readAt, 64), held = number(v.heldAgents);
  if (v.format !== 1 || readAt === null) return null;
  if (v.available === false) {
    const reason = text(v.reason, 300);
    return reason === null ? null : { available: false, readAt, reason };
  }
  if (v.available !== true || held === null || !Array.isArray(v.agents)) return null;
  const total = parts(v.total);
  if (!total) return null;
  const agents: Agent[] = [];
  for (const a of v.agents as Record<string, unknown>[]) {
    const id = text(a?.agentId, 128);
    const found = a?.stored === true ? parts(a) : null;
    if (id === null || (a.stored === true && found === null)) return null;
    agents.push({ id, name: text(a.name, 80), unwritten: a.unwrittenChanges === true, whole: found !== null && a.layout === 0, parts: found });
  }
  return { available: true, readAt, held, agents, total };
}

const MiB = 1024 * 1024;
function size(bytes: number) {
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
const label = (a: Agent) => a.name ?? `Agent ${a.id.slice(0, 8)}`;
/** Why it wasn't measured, worded where it is shown: an error is in its own words. */
type Failure = { kind: "older" } | { kind: "http"; status: number } | { kind: "unreadable" } | { kind: "timeout" } | { kind: "error"; message: string } | { kind: "silent" };

// What Core reports (its reason, names, numbers) is shown as it came.
const words = strings({
  parts: { items: "Item text", payloads: "Large payloads", turns: "Turns", metadata: "Metadata", previews: "Previews" } as Record<Key, string>,
  region: "Stored history",
  title: "Stored history of held Agents",
  intro:
    "For the Agents whose records Core holds in memory now, how much of what they have stored is Item text, large tool payloads (command output, file changes) and the rest. Counted only when you ask. These are stored bytes, not the memory Core uses.",
  measure: "Measure",
  measuring: "Measuring…",
  failed: (why: string) => `Not measured: ${why}.`,
  notMeasured: (reason: string) => `Not measured: ${reason}`,
  older: "this Core can't measure it",
  http: (status: number) => `http ${status}`,
  unreadable: "not an answer this window understands",
  timeout: "no answer within 10 s",
  silent: "Core did not answer",
  noneHeld: "No Agent's record is held now, so there is nothing to measure.",
  chart: "Stored bytes by part, per held Agent; exact values in the table below",
  table: "Stored bytes by Agent",
  caption: "Stored bytes (rows), read ",
  agent: "Agent",
  record: "Record",
  noRows: "No stored rows yet",
  allHeld: "All held",
  recordNote:
    "Record is Item text, large payloads, Turns and metadata. Previews are a shorter copy of large payloads kept for clients, so they are not in it. The event journal, originals kept from before a conversion and salvaged rows are not counted.",
  unwrittenNote: "* Has changes that may not yet be included in this report.",
  wholeNote: "† Stored in the older layout: the whole record is in its metadata row.",
}, {
  parts: { items: "条目文本", payloads: "大型载荷", turns: "Turn", metadata: "元数据", previews: "预览" },
  region: "已存储的历史",
  title: "Core 持有的 Agent 的已存储历史",
  intro:
    "对于 Core 当前在内存中持有其记录的 Agent，显示它们已存储的内容中有多少是条目文本、大型工具载荷（命令输出、文件更改）以及其余部分。只在你要求时统计。这些是已存储的字节，不是 Core 使用的内存。",
  measure: "测量",
  measuring: "正在测量…",
  failed: (why) => `未测量：${why}。`,
  notMeasured: (reason) => `未测量：${reason}`,
  older: "此 Core 无法测量",
  http: (status) => `Core 返回 HTTP ${status}`,
  unreadable: "此窗口无法理解这个回答",
  timeout: "10 秒内没有回答",
  silent: "Core 没有回答",
  noneHeld: "Core 当前没有持有任何 Agent 的记录，因此没有可测量的内容。",
  chart: "每个持有的 Agent 按部分划分的已存储字节；确切数值见下表",
  table: "按 Agent 划分的已存储字节",
  caption: "已存储字节（行数），读取于 ",
  record: "记录",
  noRows: "尚无已存储的行",
  allHeld: "全部持有",
  recordNote:
    "“记录”是条目文本、大型载荷、Turn 与元数据之和。预览是为客户端保留的大型载荷的较短副本，因此不计入其中。事件日志、转换前保留的原件以及抢救出的行都不计入统计。",
  unwrittenNote: "* 有更改可能尚未包含在此报告中。",
  wholeNote: "† 以旧版布局存储：整条记录都在其元数据行中。",
});
type Words = ReturnType<typeof words>;
function failureText(why: Failure, t: Words) {
  if (why.kind === "http") return t.http(why.status);
  return why.kind === "error" ? why.message : t[why.kind];
}
/** When Core read it, in this device's time; Core's own text if it isn't a time. */
function readTime(readAt: string) {
  const at = new Date(readAt);
  return Number.isNaN(at.getTime()) ? readAt : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
const record = (p: Parts) => RECORD.reduce((n, key) => n + p[key].bytes, 0);

/** One row's cells: each part's bytes (rows), the record's sum, then previews. */
function Cells({ parts }: { parts: Parts }) {
  const cell = (key: Key) => <td key={key}>{size(parts[key].bytes)} ({parts[key].rows})</td>;
  return (
    <>
      {RECORD.map((key) => cell(key))}
      <td>{size(record(parts))}</td>
      {cell("previews")}
    </>
  );
}

/**
 * What the held Agents' stored history is made of (T-140): read only when
 * the user presses Measure, once per press, never on a timer or with the
 * diagnostics text.
 */
export function HistoryComposition() {
  const t = useStrings(words);
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "reading" } | { kind: "failed"; why: Failure } | { kind: "read"; report: Report }
  >({ kind: "idle" });
  async function measure() {
    if (state.kind === "reading") return;
    setState({ kind: "reading" });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${API_BASE}/api/diagnostics/memory/history`, {
        headers: { "X-Yuzuno-Client": "desktop" }, cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) return setState({ kind: "failed", why: response.status === 404 ? { kind: "older" } : { kind: "http", status: response.status } });
      const report = historyReport(await response.json());
      setState(report ? { kind: "read", report } : { kind: "failed", why: { kind: "unreadable" } });
    } catch (error) {
      setState({ kind: "failed", why: controller.signal.aborted ? { kind: "timeout" } : error instanceof Error && error.message ? { kind: "error", message: error.message } : { kind: "silent" } });
    } finally {
      window.clearTimeout(timer);
    }
  }
  const report = state.kind === "read" ? state.report : null;
  const stored = report?.available ? report.agents.filter((a): a is Agent & { parts: Parts } => a.parts !== null) : [];
  // The chart's unit, so its ticks are round numbers of it.
  const scale = stored.some((a) => record(a.parts) >= MiB) ? { bytes: MiB, name: "MiB" } : { bytes: 1024, name: "KiB" };
  return (
    <section id="settings-history" className="settings-section history-section" aria-label={t.region}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.title}</h3>
          <p>{t.intro}</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void measure()} disabled={state.kind === "reading"}>
          {state.kind === "reading" ? t.measuring : t.measure}
        </button>
      </header>
      {state.kind === "failed" && <p className="diagnostics-note" role="status">{t.failed(failureText(state.why, t))}</p>}
      {report && !report.available && <p className="diagnostics-note" role="status">{t.notMeasured(report.reason)}</p>}
      {report?.available && report.held === 0 && <p className="diagnostics-note" role="status">{t.noneHeld}</p>}
      {report?.available && report.held > 0 && (
        <>
          {stored.length > 0 && (
            <div className="history-chart" aria-label={t.chart}>
              <ResponsiveContainer width="100%" height={Math.max(120, stored.length * 40 + 40)}>
                <BarChart
                  data={stored.map((a) => ({ label: label(a), ...Object.fromEntries(RECORD.map((key) => [key, a.parts[key].bytes / scale.bytes])) }))}
                  layout="vertical"
                  margin={{ top: 4, right: 18, bottom: 4, left: 0 }}
                  accessibilityLayer
                >
                  <CartesianGrid horizontal={false} stroke="var(--line)" />
                  <XAxis type="number" tickFormatter={(value) => `${value} ${scale.name}`} tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="label" width={110} tick={{ fill: "var(--ink)", fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: "var(--paper)", borderColor: "var(--line)", color: "var(--ink)", borderRadius: 8 }}
                    cursor={{ fill: "var(--cream)" }}
                    formatter={(value, name) => [size(Number(value) * scale.bytes), PARTS.includes(name as Key) ? t.parts[name as Key] : String(name)]}
                  />
                  {RECORD.map((key) => (
                    <Bar key={key} dataKey={key} stackId="stored" fill={`var(--history-${key})`} maxBarSize={20} isAnimationActive={false} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <ul className="history-legend">
                {RECORD.map((key) => (
                  <li key={key}><span className={`history-swatch history-swatch-${key}`} aria-hidden="true" />{t.parts[key]}</li>
                ))}
              </ul>
            </div>
          )}
          {/* Seven columns: on a narrow screen the table scrolls, not the page. */}
          <div className="history-table-scroll" tabIndex={0} role="region" aria-label={t.table}>
            <table className="history-table">
              <caption>{t.caption}<time dateTime={report.readAt}>{readTime(report.readAt)}</time></caption>
              <thead>
                <tr>
                  <th scope="col">{t.agent}</th>
                  {RECORD.map((key) => <th key={key} scope="col">{t.parts[key]}</th>)}
                  <th scope="col">{t.record}</th>
                  <th scope="col">{t.parts.previews}</th>
                </tr>
              </thead>
              <tbody>
                {report.agents.map((a) => (
                  <tr key={a.id}>
                    <th scope="row">{label(a)}{a.unwritten ? " *" : ""}{a.whole ? " †" : ""}</th>
                    {a.parts ? <Cells parts={a.parts} /> : <td colSpan={PARTS.length + 1}>{t.noRows}</td>}
                  </tr>
                ))}
                <tr className="history-total">
                  <th scope="row">{t.allHeld}</th>
                  <Cells parts={report.total} />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="diagnostics-note">{t.recordNote}</p>
          {report.agents.some((a) => a.unwritten) && <p className="diagnostics-note">{t.unwrittenNote}</p>}
          {report.agents.some((a) => a.whole) && <p className="diagnostics-note">{t.wholeNote}</p>}
        </>
      )}
    </section>
  );
}
