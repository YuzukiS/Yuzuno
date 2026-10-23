import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { API_BASE } from "./api";
import "./history-composition.css";

/** The parts of a stored record, as GET /api/diagnostics/memory/history
 * names them (core/src/history_composition.rs), in the order shown. They are
 * disjoint, so they add up to the record. */
const RECORD = [
  { key: "items", label: "Item text" },
  { key: "payloads", label: "Large payloads" },
  { key: "turns", label: "Turns" },
  { key: "metadata", label: "Metadata" },
] as const;
/** Previews are a shorter copy of payloads: stored too, never in the record's sum. */
const PARTS = [...RECORD, { key: "previews", label: "Previews" }] as const;
type Key = (typeof PARTS)[number]["key"];
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
  for (const { key } of PARTS) {
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
const record = (p: Parts) => RECORD.reduce((n, { key }) => n + p[key].bytes, 0);

/** One row's cells: each part's bytes (rows), the record's sum, then previews. */
function Cells({ parts }: { parts: Parts }) {
  const cell = (key: Key) => <td key={key}>{size(parts[key].bytes)} ({parts[key].rows})</td>;
  return (
    <>
      {RECORD.map(({ key }) => cell(key))}
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
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "reading" } | { kind: "failed"; reason: string } | { kind: "read"; report: Report }
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
      if (!response.ok) throw new Error(response.status === 404 ? "this Core can't measure it" : `http ${response.status}`);
      const report = historyReport(await response.json());
      setState(report ? { kind: "read", report } : { kind: "failed", reason: "not an answer this window understands" });
    } catch (error) {
      setState({ kind: "failed", reason: controller.signal.aborted ? "no answer within 10 s" : error instanceof Error && error.message ? error.message : "Core did not answer" });
    } finally {
      window.clearTimeout(timer);
    }
  }
  const report = state.kind === "read" ? state.report : null;
  const stored = report?.available ? report.agents.filter((a): a is Agent & { parts: Parts } => a.parts !== null) : [];
  return (
    <section id="settings-history" className="settings-section history-section" aria-label="Stored history">
      <header className="settings-section-heading">
        <div>
          <h3>Stored history of held Agents</h3>
          <p>
            For the Agents whose records Core holds in memory now, how much of what they have stored is Item text,
            large tool payloads (command output, file changes) and the rest. Counted only when you ask. These are
            stored bytes, not the memory Core uses.
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void measure()} disabled={state.kind === "reading"}>
          {state.kind === "reading" ? "Measuring…" : "Measure"}
        </button>
      </header>
      {state.kind === "failed" && <p className="diagnostics-note" role="status">Not measured: {state.reason}.</p>}
      {report && !report.available && <p className="diagnostics-note" role="status">Not measured: {report.reason}</p>}
      {report?.available && report.held === 0 && (
        <p className="diagnostics-note" role="status">No Agent's record is held now, so there is nothing to measure.</p>
      )}
      {report?.available && report.held > 0 && (
        <>
          {stored.length > 0 && (
            <div className="history-chart" aria-label="Stored bytes by part, per held Agent; exact values in the table below">
              <ResponsiveContainer width="100%" height={Math.max(120, stored.length * 40 + 40)}>
                <BarChart
                  data={stored.map((a) => ({ label: label(a), ...Object.fromEntries(RECORD.map(({ key }) => [key, a.parts[key].bytes])) }))}
                  layout="vertical"
                  margin={{ top: 4, right: 18, bottom: 4, left: 0 }}
                  accessibilityLayer
                >
                  <CartesianGrid horizontal={false} stroke="var(--line)" />
                  <XAxis type="number" tickFormatter={size} tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="label" width={110} tick={{ fill: "var(--ink)", fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: "var(--paper)", borderColor: "var(--line)", color: "var(--ink)", borderRadius: 8 }}
                    cursor={{ fill: "var(--cream)" }}
                    formatter={(value, name) => [size(Number(value)), PARTS.find((p) => p.key === name)?.label ?? String(name)]}
                  />
                  {RECORD.map(({ key }) => (
                    <Bar key={key} dataKey={key} stackId="stored" fill={`var(--history-${key})`} maxBarSize={20} isAnimationActive={false} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <ul className="history-legend">
                {RECORD.map(({ key, label: name }) => (
                  <li key={key}><span className={`history-swatch history-swatch-${key}`} aria-hidden="true" />{name}</li>
                ))}
              </ul>
            </div>
          )}
          {/* Seven columns: on a narrow screen the table scrolls, not the page. */}
          <div className="history-table-scroll" tabIndex={0} role="region" aria-label="Stored bytes by Agent">
            <table className="history-table">
              <caption>Stored bytes (rows), read {report.readAt}</caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  {RECORD.map(({ key, label: name }) => <th key={key} scope="col">{name}</th>)}
                  <th scope="col">Record</th>
                  <th scope="col">Previews</th>
                </tr>
              </thead>
              <tbody>
                {report.agents.map((a) => (
                  <tr key={a.id}>
                    <th scope="row">{label(a)}{a.unwritten ? " *" : ""}{a.whole ? " †" : ""}</th>
                    {a.parts ? <Cells parts={a.parts} /> : <td colSpan={PARTS.length + 1}>No stored rows yet</td>}
                  </tr>
                ))}
                <tr className="history-total">
                  <th scope="row">All held</th>
                  <Cells parts={report.total} />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="diagnostics-note">
            Record is Item text, large payloads, Turns and metadata. Previews are a shorter copy of large payloads kept
            for clients, so they are not in it. The event journal, originals kept from before a conversion and
            salvaged rows are not counted.
          </p>
          {report.agents.some((a) => a.unwritten) && (
            <p className="diagnostics-note">* Has changes not written yet, so it holds more than is stored.</p>
          )}
          {report.agents.some((a) => a.whole) && (
            <p className="diagnostics-note">† Stored in the older layout: the whole record is in its metadata row.</p>
          )}
        </>
      )}
    </section>
  );
}
