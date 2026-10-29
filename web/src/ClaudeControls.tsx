import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Bot, ChevronRight, ClipboardList, LoaderCircle, MessageSquare, ShieldCheck, SquareTerminal } from "lucide-react";
import { api, errorText, NO_ANSWER_REPLY, respondToRequest } from "./api";
import { AnswerAgain, DraftNotSaved, useUnconfirmedAnswer } from "./unconfirmed-answer";
import { choiceAnswers, choiceEmpty, useRequestDraft } from "./request-draft";
import { claudeCodeFacts } from "./claude-runtime";
import { langTag, strings, useLanguage, useStrings } from "./i18n";
import { cardWords } from "./subagent-text";
import { callFacts } from "./tool-call";
import { CallDetails, CallName, ToolCallSummary, callIcon } from "./ToolCall";
import { requestWords, shownError, type RequestWords } from "./request-text";
import { callToward, formatUsage, turnSubAgents, type ClaudeSubAgentEntry, type ClaudeSubAgentRecord } from "./claude-subagents";
import { Prose } from "./components";
import { ConversationRows, useConversationDisclosure, useConversationReveal } from "./ConversationWindow";
import { payloadLimits, useFullItem } from "./item-payload";
import type { ClaudeRuntime, NativeItem, NativeTurn, PendingRequest } from "./types";
import "./claude.css";

type PermissionUpdate = { type?: string; behavior?: string; mode?: string; rules?: { toolName?: string; ruleContent?: string }[]; directories?: string[] };

/** Describe the bridge's session offer; the bridge alone decides what it is. */
function sessionGrant(offer: unknown, t: RequestWords): { grants: string[]; acceptEdits: boolean } {
  const updates = Array.isArray(offer) ? (offer as PermissionUpdate[]) : [];
  const acceptEdits = updates.some(update => update?.type === "setMode") && !updates.some(update => update?.type === "addRules");
  const grants = updates.flatMap(update => {
    if (update?.type === "addRules") return (update.rules || []).map(rule => rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : String(rule.toolName));
    if (update?.type === "addDirectories") return (update.directories || []).map(directory => t.accessTo(directory));
    if (update?.type === "setMode") return [t.allEdits(update.mode)];
    return [];
  });
  return { grants, acceptEdits };
}

/** Claude Code's permission modes, as people read them. */
const modeNames: Record<string, string> = {
  default: "Default", auto: "Auto", plan: "Plan", acceptEdits: "Accept edits", dontAsk: "Don't ask", bypassPermissions: "Bypass permissions",
};
export const modeName = (mode: string) => modeNames[mode] || mode;

const limitNames: Record<string, string> = { five_hour: "5h", seven_day: "7d", seven_day_opus: "7d Opus", seven_day_sonnet: "7d Sonnet" };
const windowName = (key: string) => limitNames[key] || key.replace(/_/g, " ");

export function limitWindows(info: ClaudeRuntime["rateLimits"], now: number) {
  if (!info) return [];
  const windows: [string, { utilization?: number; resetsAt?: number }][] = info.unifiedWindows && typeof info.unifiedWindows === "object"
    ? Object.entries(info.unifiedWindows)
    : typeof info.utilization === "number" && info.rateLimitType ? [[info.rateLimitType, info]] : [];
  return windows.filter(([, w]) => typeof w?.utilization === "number").map(([key, w]) => {
    const resetsAt = typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null;
    return {
      name: windowName(key),
      percent: Math.round(w.utilization! * 100),
      // A window that has reset since the report says nothing about now.
      expired: resetsAt !== null && resetsAt <= now,
      resets: resetsAt === null ? null : new Date(resetsAt).toLocaleString(),
    };
  });
}

// The rows' own words (T-189). Window names, modes, effort levels, the
// account and what Claude Code says of its version are shown as reported.
const factsText = strings({
  limitReached: (window: string) => ` · ${window}limit reached`,
  nearingLimit: (window: string) => ` · ${window}nearing limit`,
  reportedAt: (when: string) => `Reported by Claude Code ${when}.`,
  mode: "Mode",
  modeTitle: "Reported by Claude Code for this session, including modes Claude switches to itself, such as plan. Your choice is in Agent settings.",
  reported: " · reported",
  effort: "Effort",
  effortTitle: "Reported by Claude Code for the last turn it finished. Your choice is in Agent settings.",
  account: "Account",
  planUsage: "Plan usage",
  windowWaiting: (name: string, resets: string | null) => `${name}: reset ${resets}; waiting for a new report`,
  windowUsed: (name: string, percent: number, resets: string | null) => `${name}: ${percent}% used${resets ? `, resets ${resets}` : ""}`,
  windowReset: (name: string) => `${name} reset`,
}, {
  limitReached: (window) => ` · ${window}已达限额`,
  nearingLimit: (window) => ` · ${window}接近限额`,
  reportedAt: (when) => `由 Claude Code 于 ${when} 报告。`,
  mode: "模式",
  modeTitle: "由 Claude Code 为此会话报告，包括 Claude 自行切换的模式（例如 plan）。你的选择在 Agent 设置中。",
  reported: " · 已报告",
  effort: "推理强度",
  effortTitle: "由 Claude Code 为它完成的上一个 Turn 报告。你的选择在 Agent 设置中。",
  account: "账户",
  planUsage: "套餐用量",
  windowWaiting: (name, resets) => `${name}：已于 ${resets} 重置；正在等待新的报告`,
  windowUsed: (name, percent, resets) => `${name}：已用 ${percent}%${resets ? `，${resets} 重置` : ""}`,
  windowReset: (name) => `${name} 已重置`,
});

/** Account and plan usage rows for the agent's information list. */
export function ClaudeRuntimeFacts({ runtime }: { runtime?: ClaudeRuntime | null }) {
  const t = useStrings(factsText);
  const account = runtime?.account;
  const who = [account?.email || account?.organization, account?.subscriptionType].filter(Boolean).join(" · ");
  const now = Date.now();
  const info = runtime?.rateLimits;
  const limits = limitWindows(info, now);
  // A warning belongs to the window it reports, and only until that resets.
  const statusLive = typeof info?.resetsAt !== "number" || info.resetsAt * 1000 > now;
  const statusWindow = info?.rateLimitType ? `${windowName(info.rateLimitType)} ` : "";
  const status = !statusLive ? "" : info?.status === "rejected" ? t.limitReached(statusWindow) : info?.status === "allowed_warning" ? t.nearingLimit(statusWindow) : "";
  const reported = runtime?.rateLimitsAt ? t.reportedAt(new Date(runtime.rateLimitsAt).toLocaleString()) : "";
  const cli = claudeCodeFacts(runtime);
  return <>
    {runtime?.permissionMode && <div><dt>{t.mode}</dt>
      <dd title={t.modeTitle}>{modeName(runtime.permissionMode)}{t.reported}</dd>
    </div>}
    {runtime?.effort?.level && <div><dt>{t.effort}</dt>
      <dd title={t.effortTitle}>{runtime.effort.level}{t.reported}</dd>
    </div>}
    {who && <div><dt>{t.account}</dt><dd title={[who, runtime?.version && `Claude Code ${runtime.version}`].filter(Boolean).join("\n")}>{who}</dd></div>}
    {limits.length > 0 && <div><dt>{t.planUsage}</dt>
      <dd title={[...limits.map(l => l.expired ? t.windowWaiting(l.name, l.resets) : t.windowUsed(l.name, l.percent, l.resets)), reported].filter(Boolean).join("\n")}>
        {limits.map(l => l.expired ? t.windowReset(l.name) : `${l.name} ${l.percent}%`).join(" · ")}{status}
      </dd>
    </div>}
    {cli && <div><dt>Claude Code</dt><dd title={cli.title}>{cli.text}</dd></div>}
  </>;
}

type SubAgentScope = {
  agentId: string; turnId: string; live: boolean;
  entries: Map<string, ClaudeSubAgentEntry>;
  /** The Turn's Items by id, to find the way to a nested call. */
  items: Map<string, NativeItem>;
};
const SubAgentScopeContext = createContext<SubAgentScope | null>(null);

/** False where Claude's tool rows are shown away from their Turn (the
 *  sub-agent card beside the dock): they carry no `item-<id>` anchor there,
 *  so a source link always finds the Turn's own row. */
const AnchorsContext = createContext(true);

/** Claude's calls shown away from their Turn, without its anchors. */
export function ClaudeAwayFromTurn({ children }: { children: ReactNode }) {
  return <AnchorsContext.Provider value={false}>{children}</AnchorsContext.Provider>;
}

/**
 * The Claude sub-agents of one Turn, for its Agent call rows. `live`:
 * Claude's runtime is connected, so a sub-agent still running can report.
 */
export function ClaudeSubAgentScope({ agentId, turn, live, children }: {
  agentId: string; turn: NativeTurn; live: boolean; children: ReactNode;
}) {
  const language = useLanguage();
  const value = useMemo(() => ({
    agentId, turnId: turn.id, live, entries: new Map(turnSubAgents(turn, live, language).map(entry => [entry.key, entry])),
    items: new Map(turn.items.map(item => [item.id, item])),
  }), [agentId, turn, live, language]);
  return <SubAgentScopeContext.Provider value={value}>{children}</SubAgentScopeContext.Provider>;
}

/** A plan this long opens on request; a shorter one is shown whole. By
 *  length, not layout, so a short plan is never cut without a way to open it. */
const PLAN_LINES = 18;
const PLAN_CHARS = 1800;

/** A plan as Markdown: the one Claude sent with ExitPlanMode (`input.plan`),
 *  or a Codex plan Item's text. `empty` says there is none. */
export function PlanText({ plan, id, empty }: { plan: string; id: string; empty?: string }) {
  const [open, setOpen] = useState(false);
  const t = useStrings(cardWords);
  const long = plan.split("\n").length > PLAN_LINES || plan.length > PLAN_CHARS;
  if (!plan.trim()) return <p className="claude-plan-empty">{empty ?? t.noPlan}</p>;
  return <div className="claude-plan-text">
    <div id={id} className="claude-plan-body" data-collapsed={long && !open ? true : undefined}>
      <Prose text={plan} />
    </div>
    {long && <button type="button" className="inline-link claude-plan-toggle" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}>{open ? t.showLess : t.showFullPlan}</button>}
  </div>;
}

/** Where Claude saved the plan (`input.planFilePath`), if it said. */
function PlanFile({ path }: { path: unknown }) {
  const t = useStrings(cardWords);
  return typeof path === "string" && path ? <p className="claude-plan-file">{t.savedAt}<span className="mono-small">{path}</span></p> : null;
}

/** `notice` says when Core sent only a preview of the input or result. An
 *  Agent call shows the sub-agent it started (`ClaudeSubAgentScope`). */
export function ClaudeTool({ item, unconfirmed, notice, opened, onOpenChange }: {
  item: NativeItem; unconfirmed: boolean; notice?: ReactNode;
  opened?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const scope = useContext(SubAgentScopeContext);
  const anchored = useContext(AnchorsContext);
  const language = useLanguage();
  const t = cardWords(language);
  const entry = scope?.entries.get(item.id);
  const target = useConversationReveal(scope?.turnId ?? "");
  // A source link to one of its calls, or to a call of a sub-agent it
  // started, opens it.
  const revealing = !!entry && !!scope && !!callToward(scope.items, target?.itemId, item.id);
  useLayoutEffect(() => { if (revealing && !opened) onOpenChange?.(true); }, [revealing]);
  const input = (item.input || {}) as Record<string, unknown>;
  const name = String(item.name || t.tool);
  const plan = name === "ExitPlanMode" && typeof input.plan === "string" ? input.plan : null;
  const hint = plan !== null ? planTitle(plan) : input.command || input.file_path || input.pattern || input.description || "";
  const running = entry ? entry.status === "running" : !unconfirmed && /inProgress|running/.test(item.status || "");
  // What Claude says of a sub-agent or a plan, and of a call not done; any
  // other call says what its capsule reads of it (tool-call.ts).
  const result = entry ? entry.record?.background && entry.status === "running" ? t.runningBackground : t.claudeSub[entry.status]
    : unconfirmed || item.status === "unknown" ? t.unconfirmed : item.status === "inProgress" ? plan !== null ? t.waitingReview : t.running
      // Claude Code completes ExitPlanMode only when the plan is approved.
      : plan !== null && item.status === "completed" ? t.approved : plan !== null && item.status === "failed" ? t.notApproved : undefined;
  const facts = callFacts(item, name, language, unconfirmed);
  return <details className="tool-item claude-tool" id={anchored ? `item-${item.id}` : undefined} data-running={running || undefined}
    data-subagent-status={entry?.status} open={opened} onToggle={event => {
      if (event.target === event.currentTarget && event.currentTarget.open !== opened) onOpenChange?.(event.currentTarget.open);
    }}>
    <ToolCallSummary open={!!opened} facts={facts} result={result} raw={!entry && plan === null}
      icon={entry ? <Bot size={14} /> : callIcon(item, <SquareTerminal size={14} />)}
      name={facts.name !== name ? <CallName name={facts.name} /> : <><strong>{name}</strong>{hint ? ` · ${String(hint)}` : ""}</>} />
    <div className="tool-content">
      {notice}
      {!entry && plan === null && <CallDetails facts={facts} />}
      {entry && scope ? (opened ?? true) && <ClaudeSubAgentDetail agentId={scope.agentId} entry={entry} live={scope.live} item={item} /> : <>
        {plan !== null ? <>
          <span className="section-eyebrow">{t.plan}</span><PlanText plan={plan} id={`plan-${item.id}`} /><PlanFile path={input.planFilePath} />
        </> : <><span className="section-eyebrow">{t.input}</span><pre>{JSON.stringify(input, null, 2)}</pre></>}
        <span className="section-eyebrow">{t.result}</span><pre>{item.output == null ? t.noResultYet : typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2)}</pre>
      </>}
    </div>
  </details>;
}

/** A plan's first heading, or its first line, for the call's summary. */
export function planTitle(plan: string) {
  const lines = plan.split("\n").map(line => line.trim()).filter(Boolean);
  const title = (lines.find(line => /^#{1,6}\s/.test(line)) || lines[0] || "").replace(/^#{1,6}\s+/, "");
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function isRecord(value: unknown): value is ClaudeSubAgentRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A tool result as text: a string, or its text blocks. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output.map(block => (typeof block?.text === "string" ? block.text : "")).filter(Boolean).join("\n");
}

/**
 * One Claude sub-agent as Claude reported it: goal, status, result and, when
 * asked, its own tool calls. Content only: the row or card around it is the
 * caller's. `item`: the Agent call as its row already shows it (whole once
 * expanded there); otherwise its full fields are read here on request.
 * `onNavigate`: offered where the detail is shown away from its Turn.
 */
export function ClaudeSubAgentDetail({ agentId, entry, live, item, onNavigate }: {
  agentId: string; entry: ClaudeSubAgentEntry; live: boolean; item?: NativeItem;
  onNavigate?: (turnId: string) => void;
}) {
  const view = useFullItem(agentId, entry.turnId, entry.item);
  const language = useLanguage();
  const t = cardWords(language);
  // An Agent call too large for the conversation window came as a preview
  // keeping its sub-agent's facts; its goal and result are in the original.
  // Once read, the preview's facts stay current from Core and are laid over
  // it. When they change it is read again: at once for a new status (a
  // result may have come), otherwise no more often than any running Item.
  const isPreview = entry.item.type === "historyPreview";
  const status = entry.record?.status ?? entry.item.status ?? null;
  const facts = JSON.stringify([entry.item.status ?? null, entry.record]);
  const [original, setOriginal] = useState<{ item: NativeItem; facts: string; status: string | null; at: number } | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<{ facts: string; text: string } | null>(null);
  const asked = useRef(0);
  const preview = isPreview && !original;
  async function readOriginal() {
    const request = ++asked.current, read = { facts, status };
    setReading(true);
    setReadError(null);
    try {
      const item = await api<NativeItem>(`/agents/${encodeURIComponent(agentId)}/items/${encodeURIComponent(entry.itemId)}/original?${new URLSearchParams({ turnId: entry.turnId })}`);
      if (request === asked.current) setOriginal({ item, ...read, at: Date.now() });
    } catch (e) {
      if (request === asked.current) setReadError({ facts: read.facts, text: errorText(e) });
    } finally {
      if (request === asked.current) setReading(false);
    }
  }
  const behind = isPreview && !!original && original.facts !== facts;
  useEffect(() => {
    // Not again for the same facts after a failure; the button retries.
    if (!behind || readError?.facts === facts) return;
    const delay = original!.status !== status ? 0 : Math.max(0, original!.at + payloadLimits.runningRefetchMs - Date.now());
    const timer = setTimeout(() => void readOriginal(), delay);
    return () => clearTimeout(timer);
  }, [behind, facts]);
  const current: NativeItem | null = isPreview && original ? { ...original.item, status: entry.item.status,
    subAgent: isRecord(original.item.subAgent) ? { ...original.item.subAgent, ...entry.record } : entry.record } : null;
  const shown = current ?? item ?? view.item;
  const record = isRecord(shown.subAgent) ? shown.subAgent : entry.record;
  const input = (shown.input || {}) as Record<string, unknown>;
  const description = record?.description || (typeof input.description === "string" ? input.description : "");
  const goal = record?.prompt || (typeof input.prompt === "string" ? input.prompt : "");
  const usage = formatUsage(record?.usage, language);
  const scope = useContext(SubAgentScopeContext);
  const target = useConversationReveal(entry.turnId);
  // Its call on the way to a source link's target, however deeply nested.
  const items = scope?.turnId === entry.turnId ? scope.items : new Map(entry.calls.map(call => [call.id, call]));
  const targetCall = callToward(items, target?.itemId, entry.key);
  const [callsOpen, setCallsOpen] = useConversationDisclosure(`claude-subagent:${entry.turnId}:${entry.key}`, false);
  const showCalls = callsOpen || !!targetCall;
  const running = entry.status === "running";
  // Without a reported result, what the Agent call itself returned: a
  // foreground sub-agent's answer, or a failure given only as text. A
  // background call returns only that it was launched.
  const returned = !record?.result && !running && (!record?.background || shown.status === "failed") ? outputText(shown.output) : "";
  return <div className="claude-subagent" data-subagent-status={entry.status}>
    <dl className="claude-subagent-facts">
      <dt>{t.status}</dt><dd>{entry.state}</dd>
      {record?.type && <><dt>{t.type}</dt><dd>{record.type}</dd></>}
      <dt>{t.runsLabel}</dt><dd>{record?.remote ? t.remotely : record?.background ? t.inBackground : t.inForeground}</dd>
      {usage && <><dt>{t.usage}</dt><dd>{usage}</dd></>}
      {record?.taskId && <><dt>{t.task}</dt><dd><code>{record.taskId}</code></dd></>}
    </dl>
    <section className="claude-subagent-part" aria-label={t.goalLabel}>
      <span className="section-eyebrow">{t.goalEyebrow}</span>
      {description && <p><strong>{description}</strong></p>}
      {goal ? <p className="claude-subagent-text">{goal}{record?.promptTruncated && <span className="claude-subagent-muted">{t.shortened}</span>}</p>
        : <p className="claude-subagent-muted">{preview ? t.inOriginal : t.notReported}</p>}
    </section>
    {running && (record?.activity || record?.progress) && (
      <p className="claude-subagent-muted">{[record.activity, record.progress].filter(Boolean).join(" · ")}</p>
    )}
    {record?.error && <p className="claude-subagent-error" role="alert">{record.error}</p>}
    <section className="claude-subagent-part" aria-label={t.resultLabel}>
      <span className="section-eyebrow">{t.result}</span>
      {record?.result ? <p className="claude-subagent-text">{record.result}{record.resultTruncated && <span className="claude-subagent-muted">{t.shortened}</span>}</p>
        : returned ? <p className={`claude-subagent-text${shown.status === "failed" ? " claude-subagent-error" : ""}`}>{returned}</p>
          : <p className="claude-subagent-muted">{(preview || behind) && !running ? t.inOriginal
            : running ? t.noResultYet : entry.status === "unknown" ? t.noResultUnknown : t.noResult}</p>}
    </section>
    {(preview || reading || readError) && (
      <button type="button" className="inline-link" disabled={reading} onClick={() => void readOriginal()}>
        {reading ? t.readingCall : t.readCall}
      </button>
    )}
    {readError && <p className="claude-subagent-error" role="alert">{readError.text}</p>}
    {!item && view.truncated && !view.expanded && (
      <button type="button" className="inline-link" onClick={view.expand}>{t.showGoalResult}</button>
    )}
    {!item && view.error && <p className="claude-subagent-error" role="alert">{view.error}</p>}
    {onNavigate && (
      // As the dock card's Codex details do (SubAgentPanels.tsx).
      <div className="subagent-card-actions">
        <button type="button" className="quiet-button" onClick={() => onNavigate(entry.turnId)}>
          <ArrowUpRight size={12} aria-hidden /> {t.goTurn}
        </button>
      </div>
    )}
    {entry.calls.length > 0 && <div className="claude-subagent-calls">
      <button type="button" className="claude-subagent-calls-toggle" aria-expanded={showCalls} onClick={() => setCallsOpen(!showCalls)}>
        <ChevronRight size={12} aria-hidden />{t.itsCalls(entry.calls.length)}
      </button>
      {showCalls && <ConversationRows id={`claude-subagent:${entry.turnId}:${entry.key}`} items={entry.calls} itemKey={call => call.id}
        estimate={() => 44} targetKey={targetCall}>
        {call => <SubAgentCall key={call.id} agentId={agentId} turnId={entry.turnId} item={call}
          unconfirmed={!live || !running} />}
      </ConversationRows>}
    </div>}
  </div>;
}

type CallProps = { agentId: string; turnId: string; item: NativeItem; unconfirmed: boolean };

/** One of a sub-agent's own calls. */
function SubAgentCall(props: CallProps) {
  return props.item.type === "historyPreview" ? <PreviewCall {...props} /> : <ToolCall {...props} />;
}

/** A call too large for the conversation window: its saved original on request. */
function PreviewCall({ agentId, turnId, item, unconfirmed }: CallProps) {
  const [original, setOriginal] = useState<NativeItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useConversationDisclosure(`tool:${turnId}:${item.id}`, true);
  const anchored = useContext(AnchorsContext);
  const t = useStrings(cardWords);
  async function load() {
    setLoading(true);
    setError("");
    try {
      setOriginal(await api<NativeItem>(`/agents/${encodeURIComponent(agentId)}/items/${encodeURIComponent(item.id)}/original?${new URLSearchParams({ turnId })}`));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  if (original) return <ClaudeTool item={original} opened={opened} onOpenChange={setOpened}
    unconfirmed={unconfirmed && /inProgress|running/.test(original.status || "")} />;
  return <div className="history-item-preview" id={anchored ? `item-${item.id}` : undefined}
    data-item-id={anchored ? item.id : undefined} tabIndex={-1}>
    <p>{t.largeCall}</p><pre>{item.text || t.openCall}</pre>
    <button type="button" className="inline-link" disabled={loading} onClick={() => void load()}>
      {loading ? t.loadingCall : t.viewCall}
    </button>
    {error && <p className="claude-subagent-error" role="alert">{error}</p>}
  </div>;
}

/** A call as Core sent it; its full input and result on request. */
function ToolCall({ agentId, turnId, item, unconfirmed }: CallProps) {
  const view = useFullItem(agentId, turnId, item);
  const [opened, setOpened] = useConversationDisclosure(`tool:${turnId}:${item.id}`, false);
  const targeted = useConversationReveal(turnId)?.itemId === item.id;
  const t = useStrings(cardWords);
  useLayoutEffect(() => { if (targeted && !opened) setOpened(true); }, [targeted]);
  const notice = view.error ? <p className="claude-subagent-error" role="alert">{view.error}</p>
    : view.loading ? <p className="claude-subagent-muted">{t.loadingIO}</p>
      : view.truncated && !view.expanded ? <button type="button" className="inline-link" onClick={view.expand}>{t.showIO}</button>
        : null;
  return <ClaudeTool item={view.item} notice={notice} opened={opened} onOpenChange={setOpened}
    unconfirmed={unconfirmed && /inProgress|running/.test(item.status || "")} />;
}

type Question = { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] };

function ProposedAction({ name, input, t }: { name: string; input: Record<string, unknown>; t: RequestWords }) {
  if (name === "Bash" && typeof input.command === "string")
    return <pre className="claude-permission-input">{input.command}</pre>;
  if (["Write", "Edit", "MultiEdit"].includes(name) && typeof input.file_path === "string")
    return <div className="claude-file-proposal">
      <p className="mono-small">{input.file_path}</p>
      {typeof input.content === "string" ? <pre className="claude-permission-input">{input.content}</pre> :
        typeof input.old_string === "string" && typeof input.new_string === "string" ? <>
          <span className="section-eyebrow">{t.before}</span><pre className="claude-permission-input">{input.old_string || t.empty}</pre>
          <span className="section-eyebrow">{t.after}</span><pre className="claude-permission-input">{input.new_string || t.empty}</pre>
        </> : <pre className="claude-permission-input">{JSON.stringify(input, null, 2)}</pre>}
    </div>;
  return <pre className="claude-permission-input">{JSON.stringify(input, null, 2)}</pre>;
}

/** `permissionMode` is the mode Claude reports for the session, not the
 *  user's choice; an ExitPlanMode card says it as reported. */
export function ClaudePermission({ request, refresh, disabled, highlightSource, permissionMode, draftScope = null }: {
  request: PendingRequest; refresh: () => void; disabled: boolean; highlightSource?: boolean; permissionMode?: string | null; draftScope?: string | null;
}) {
  const input = request.params.input || {};
  const language = useLanguage();
  const t = requestWords(language);
  const questions: Question[] = request.params.toolName === "AskUserQuestion" && Array.isArray(input.questions) ? input.questions : [];
  // An unsent answer to a question survives a refresh (T-170).
  const draft = useRequestDraft(questions.length ? draftScope : null, request, saved => choiceAnswers(saved, questions.map(q => q.question)));
  const [sending, setSending] = useState(false);
  // Set before the first await, so a second click in the same moment finds
  // it; kept after a delivered answer until Core marks the request sent.
  const answering = useRef(draft.attempted);
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState(draft.attempted ? NO_ANSWER_REPLY : "");
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => draft.initial?.answers ?? {});
  const [free, setFree] = useState<Record<string, string>>(() => draft.initial?.free ?? {});
  const [reason, setReason] = useState("");
  const kept = { answers, free };
  useEffect(() => { draft.save(kept, choiceEmpty(kept)); }, [answers, free]);
  // Claude Code sends the plan it wants approved as input.plan.
  const plan = request.params.toolName === "ExitPlanMode" ? (typeof input.plan === "string" ? input.plan : "") : null;
  const { grants: grant, acceptEdits } = questions.length ? { grants: [], acceptEdits: false } : sessionGrant(request.params.sessionPermissions, t);
  const reasonText = reason.trim();
  const reasonTooLong = new TextEncoder().encode(reasonText).length > 2000;
  const unconfirmedAnswer = useUnconfirmedAnswer(refresh, answering, draft.attempted);
  const locked = disabled || !!request.stale || !!request.params._responseSent || sending || answered || unconfirmedAnswer.unconfirmed;
  const answer = (q: Question) => [...(answers[q.question] || []), ...(free[q.question]?.trim() ? [free[q.question].trim()] : [])].join(", ");
  async function respond(decision: "allow" | "deny", scope?: "session") {
    if (locked || answering.current) return;
    answering.current = true;
    setSending(true); setError("");
    draft.attempt(true, kept, choiceEmpty(kept));
    try {
      await respondToRequest(request.id, {
        decision,
        ...(scope ? { scope } : {}),
        ...(decision === "deny" && reasonText && !questions.length ? { message: reasonText } : {}),
        ...(decision === "allow" && questions.length ? { updatedInput: { ...input, answers: Object.fromEntries(questions.map(q => [q.question, answer(q)])) } } : {}),
      });
      draft.remove();
      setAnswered(true);
      refresh();
    } catch (e) {
      if (!unconfirmedAnswer.noReply(e)) { answering.current = false; draft.attempt(false, kept, choiceEmpty(kept)); }
      setError(errorText(e));
    } finally { setSending(false); }
  }
  const sessionLabel = plan !== null ? acceptEdits ? t.approveEditsSession : t.approveSession
    : acceptEdits ? t.editsSession : t.allowSession;
  return <section className={`pending-card claude-permission${plan !== null ? " claude-plan" : ""}${highlightSource ? " source-highlight" : ""}`}
    id={`request-${request.id}`} tabIndex={-1} lang={langTag(language)}>
    <div className="pending-heading">
      {questions.length ? <MessageSquare size={17} /> : plan !== null ? <ClipboardList size={17} /> : <ShieldCheck size={17} />}
      <strong>{questions.length ? t.claudeQuestion : plan !== null ? t.claudePlan : t.claudePermission}</strong>
      <span className="pending-tag">{t.needsYou}</span>
    </div>
    {request.stale && <p className="inline-error">{t.staleClaude}</p>}
    {request.params._responseSent && <p className="field-hint">{t.sentClaude}</p>}
    {questions.length ? <form onSubmit={e => { e.preventDefault(); void respond("allow"); }}>
      <fieldset disabled={locked} className="claude-question-fields">
        {questions.map(q => <fieldset key={q.question}>
          <legend lang="">{q.question}</legend>
          {q.multiSelect && <p className="field-hint">{t.chooseAny}</p>}
          {q.options?.map(option => <label className="answer-option" key={option.label}>
            <input type={q.multiSelect ? "checkbox" : "radio"} name={`${request.id}-${q.question}`} checked={(answers[q.question] || []).includes(option.label)}
              onChange={e => { setAnswers(old => ({ ...old, [q.question]: q.multiSelect ? e.target.checked ? [...(old[q.question] || []), option.label] : (old[q.question] || []).filter(x => x !== option.label) : [option.label] })); if (!q.multiSelect) setFree(old => ({ ...old, [q.question]: "" })); }} />
            <span lang=""><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          </label>)}
          <input aria-label={t.yourAnswer(q.question)} placeholder={t.ownAnswer} value={free[q.question] || ""}
            onChange={e => { setFree(old => ({ ...old, [q.question]: e.target.value })); if (!q.multiSelect) setAnswers(old => ({ ...old, [q.question]: [] })); }} />
        </fieldset>)}
      </fieldset>
      {draft.notSaved && <DraftNotSaved />}
      <div className="claude-permission-actions">
        <button className="primary-button" disabled={locked || questions.some(q => !answer(q))}>{sending && <LoaderCircle size={14} className="spin" />}{t.sendAnswer}</button>
        <button type="button" className="secondary-button" disabled={locked} onClick={() => void respond("deny")}>{t.decline}</button>
      </div>
    </form> : plan !== null ? <>
      {permissionMode && <p className="claude-plan-mode">{t.reportsBefore}<strong>{modeName(permissionMode)}</strong>{t.reportsAfter}</p>}
      <PlanText plan={plan} id={`plan-${request.id}`} />
      <PlanFile path={input.planFilePath} />
      <label className="claude-deny-reason">
        <span>{t.feedback}<small>{t.feedbackNote}</small></span>
        <input type="text" value={reason} disabled={locked} placeholder={t.feedbackExample} onChange={e => setReason(e.target.value)} />
      </label>
      {reasonTooLong && <p role="alert" className="inline-error">{t.feedbackLong}</p>}
      <div className="claude-permission-actions">
        <button className="primary-button" disabled={locked} onClick={() => void respond("allow")}>{sending && <LoaderCircle size={14} className="spin" />}{t.approvePlan}</button>
        {grant.length > 0 && <button className="secondary-button" disabled={locked} onClick={() => void respond("allow", "session")}>{sessionLabel}</button>}
        <button className="secondary-button" disabled={locked || reasonTooLong} onClick={() => void respond("deny")}>{reasonText ? t.keepPlanningFeedback : t.keepPlanning}</button>
      </div>
      <p className="field-hint">{t.planHint(sessionLabel, grant.length ? grant.join(t.grantsJoin) : null)}</p>
    </> : <>
      <p>{t.reviewBefore}<strong>{request.params.toolName || t.tool}</strong>{t.reviewAfter}</p>
      <ProposedAction name={request.params.toolName} input={input} t={t} />
      <label className="claude-deny-reason">
        <span>{t.reason}<small>{t.reasonNote}</small></span>
        <input type="text" value={reason} disabled={locked} placeholder={t.reasonExample} onChange={e => setReason(e.target.value)} />
      </label>
      {reasonTooLong && <p role="alert" className="inline-error">{t.reasonLong}</p>}
      <div className="claude-permission-actions">
        <button className="primary-button" disabled={locked} onClick={() => void respond("allow")}>{sending && <LoaderCircle size={14} className="spin" />}{t.allowOnce}</button>
        {grant.length > 0 && <button className="secondary-button" disabled={locked} onClick={() => void respond("allow", "session")}>{sessionLabel}</button>}
        <button className="secondary-button" disabled={locked || reasonTooLong} onClick={() => void respond("deny")}>{reasonText ? t.denyReason : t.deny}</button>
      </div>
      <p className="field-hint">{grant.length ? t.grantHint(sessionLabel, grant.join(t.grantsJoin)) : t.onlyAction}</p>
    </>}
    {error && !(unconfirmedAnswer.unconfirmed && request.params._responseSent) && <p role="alert" className="inline-error">{shownError(error, t)}</p>}
    {unconfirmedAnswer.unconfirmed && !request.params._responseSent && <AnswerAgain onClick={() => { setError(""); unconfirmedAnswer.answerAgain(); }} />}
  </section>;
}
