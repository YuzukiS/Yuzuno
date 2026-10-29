import { boardText } from "./collaboration-text";
import { strings, type Language } from "./i18n";
import { callState, type CallState } from "./tool-capsules";
import type { NativeItem } from "./types";

/**
 * What one tool call's capsule says on its single line (T-9): a short result
 * from the call's own answer, and a state when one is worth saying. Only the
 * answer the row already holds is read, never fetched for it. A call that
 * returned is not work that succeeded, so `returned` is the quiet state.
 *
 * Yuzuno's own answers say more, and only these six are read; every other
 * tool says just its state. A refusal comes first: Core's `error` or
 * `problems`, or the harness's failure. A task's status is the task record,
 * not code merged or released; a mail's delivery is as it stood when it was
 * sent, never that it was read or acted on. A result the preview cut short,
 * or one that doesn't read as Core's answer, is "to expand", never guessed.
 */
export type CallTone = CallState | "refused" | "queued";

export type CallDetail = {
  label: string;
  value: string;
  /** What Core or an Agent wrote (titles, names, IDs, errors), in no
   * language of the page's. */
  given?: boolean;
};

export type CallFacts = {
  /** The tool's name on the capsule: an MCP call's server and tool. */
  name: string;
  /** The name as the harness gave it, when the capsule shortens it. */
  fullName: string;
  /** The short result, or null. */
  note: string | null;
  noteGiven: boolean;
  tone: CallTone | null;
  /** Said beside the note: a tone other than `returned`, or a mail's
   * delivery. */
  state: string | null;
  /** The answer here is cut short or doesn't read as Core's. */
  toExpand: boolean;
  /** A few more facts for hover, focus and the expanded row. */
  details: CallDetail[];
  /** What this answer does not mean. */
  caution: string | null;
};

const YUZUNO_TOOLS = ["task_comment", "task_update", "brief_get", "brief_update", "peer_read", "peer_send"] as const;
type YuzunoTool = (typeof YUZUNO_TOOLS)[number];
const isYuzunoTool = (name: string): name is YuzunoTool => (YUZUNO_TOOLS as readonly string[]).includes(name);

export const callWords = strings({
  tone: {
    running: "running",
    unconfirmed: "not confirmed",
    failed: "failed",
    refused: "refused",
    queued: "queued",
    returned: "returned",
  } as Record<CallTone, string>,
  toExpand: "result to expand",
  toExpandNote: "The result here is cut short or doesn't read as Yuzuno's answer. Show it in full to read it.",
  showRaw: "Open the row for the raw input and result.",
  hideRaw: "Close the row to hide the raw input and result.",
  tool: "Tool",
  state: "State",
  task: "Task",
  activity: "Activity",
  version: "Version",
  statusThen: "Status at receipt",
  reason: "Reason",
  latest: "Latest version",
  project: "Project",
  returnedWhat: "Returned",
  missing: "Not found",
  sections: "Sections",
  from: "From",
  readTo: "Read to",
  recipient: "To",
  deliveryThen: "Delivery when sent",
  message: "Message",
  priority: "Priority",
  urgent: "urgent",
  commentSaved: (task: string) => `comment saved on ${task}`,
  taskUpdated: (task: string, status: string) => `${task} updated · ${status}`,
  briefFull: (version: string, count: number) => `Brief v${version} · ${count} ${count === 1 ? "section" : "sections"} in full`,
  briefIndex: (version: string, count: number) => `Brief v${version} · index of ${count}, no bodies`,
  briefIndexAndFull: (version: string, count: number, full: number) => `Brief v${version} · index of ${count} · ${full} in full`,
  indexOnly: "the index, without bodies",
  everySection: "every section in full",
  indexAndSome: (full: number) => `the index, and ${full} in full`,
  briefUpdated: (version: string, count: number) => `Brief v${version} · ${count} ${count === 1 ? "section" : "sections"} updated`,
  briefNoChange: (version: string) => `Brief v${version} · no change recorded`,
  precheckPassed: "pre-check passed · nothing written",
  precheckFailed: "pre-check didn't pass · nothing written",
  noMail: "no new mail",
  mail: (count: number, more: boolean) => `${count} ${count === 1 ? "message" : "messages"}${more ? " · more to read" : ""}`,
  mailTo: (name: string) => `to ${name}`,
  delivery: {
    pending: "queued",
    sending: "sending",
    delivered: "delivered",
    uncertain: "delivery not confirmed",
    error: "delivery failed",
  } as Record<string, string>,
  taskCaution: "This is the task record as Core returned it; it doesn't mean code was merged or released.",
  mailCaution: "Delivery as it stood when sent. Delivered doesn't mean it was read or acted on.",
}, {
  tone: {
    running: "运行中",
    unconfirmed: "未确认",
    failed: "失败",
    refused: "被拒绝",
    queued: "排队中",
    returned: "已返回",
  },
  toExpand: "结果待展开",
  toExpandNote: "这里的结果被截短，或读不出 Yuzuno 的回执。展开完整内容再看。",
  showRaw: "展开这一行，查看原始输入与返回。",
  hideRaw: "收起这一行，隐藏原始输入与返回。",
  tool: "工具",
  state: "状态",
  task: "任务",
  activity: "活动",
  version: "版本",
  statusThen: "回执时状态",
  reason: "原因",
  latest: "最新版本",
  project: "项目",
  returnedWhat: "返回",
  missing: "未找到",
  sections: "区块",
  from: "来自",
  readTo: "读到",
  recipient: "收件人",
  deliveryThen: "发送时投递",
  message: "消息",
  priority: "优先级",
  urgent: "紧急",
  commentSaved: (task) => `${task} 备注已保存`,
  taskUpdated: (task, status) => `${task} 已更新 · ${status}`,
  briefFull: (version, count) => `Brief v${version} · ${count} 个完整区块`,
  briefIndex: (version, count) => `Brief v${version} · 索引 ${count} 个区块（无正文）`,
  briefIndexAndFull: (version, count, full) => `Brief v${version} · 索引 ${count} 个 · 完整 ${full} 个`,
  indexOnly: "只有索引，没有正文",
  everySection: "全部区块的完整内容",
  indexAndSome: (full) => `索引，以及 ${full} 个完整区块`,
  briefUpdated: (version, count) => `Brief v${version} · 已更新 ${count} 个区块`,
  briefNoChange: (version) => `Brief v${version} · 已记录无变化`,
  precheckPassed: "预检通过 · 未写入",
  precheckFailed: "预检未通过 · 未写入",
  noMail: "没有新消息",
  mail: (count, more) => `${count} 条消息${more ? " · 还有更多" : ""}`,
  mailTo: (name) => `给 ${name}`,
  delivery: {
    pending: "排队中",
    sending: "投递中",
    delivered: "已投递",
    uncertain: "投递未确认",
    error: "投递失败",
  },
  taskCaution: "这是 Core 返回的任务记录，不表示代码已合并或发布。",
  mailCaution: "这是发送时的投递状态；已投递也不表示对方已读或已处理。",
});

type Words = ReturnType<typeof callWords>;
type Answer = Record<string, unknown>;

const record = (value: unknown): value is Answer => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value ? value : null);
const count = (value: unknown) => (Array.isArray(value) ? value.length : null);
const scalar = (value: unknown) => (typeof value === "number" || (typeof value === "string" && value) ? String(value) : null);
/** At most `max` characters, for a detail line. */
const clip = (value: string, max = 240) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** A Yuzuno call this row can read: its tool, the harness's own name for
 * it, and the answer as the row holds it (undefined: none yet). */
function yuzunoCall(item: NativeItem): { tool: YuzunoTool; answer: unknown; field: string } | null {
  if (item.type === "mcpToolCall" && item.server === "yuzuno" && typeof item.tool === "string" && isYuzunoTool(item.tool))
    return { tool: item.tool, answer: item.result, field: "result" };
  const name = typeof item.name === "string" ? item.name : "";
  const tool = item.type === "claudeToolUse" ? name.match(/^mcp__yuzuno__(.+)$/)?.[1]
    : item.type === "opencodeTool" ? name.match(/^yuzuno_(.+)$/)?.[1] : undefined;
  return tool && isYuzunoTool(tool) ? { tool, answer: item.output, field: "output" } : null;
}

/** Which of the six Yuzuno tools `item` calls, if one. */
export const yuzunoTool = (item: NativeItem): YuzunoTool | null => yuzunoCall(item)?.tool ?? null;

/** The capsule's name: Claude's names for Yuzuno's tools, and OpenCode's for
 * the six above, read as Codex's do ("yuzuno/task_get"). Every other name
 * stays as the harness gave it. */
export function capsuleName(item: NativeItem, label: string): string {
  const name = typeof item.name === "string" ? item.name : "";
  const claude = item.type === "claudeToolUse" ? name.match(/^mcp__yuzuno__(.+)$/)?.[1] : undefined;
  if (claude) return `yuzuno/${claude}`;
  const call = item.type === "opencodeTool" ? yuzunoCall(item) : null;
  return call ? `yuzuno/${call.tool}` : label;
}

/** Core's answer from what the harness kept: Codex's structuredContent, or
 * the JSON text every harness keeps of it. null: it doesn't read as one. */
function coreAnswer(kept: unknown): Answer | null {
  if (record(kept) && record(kept.structuredContent)) return kept.structuredContent;
  const parts = record(kept) && Array.isArray(kept.content) ? kept.content : Array.isArray(kept) ? kept : null;
  const body = typeof kept === "string" ? kept
    : parts ? parts.map((part) => (record(part) && typeof part.text === "string" ? part.text : "")).join("") : null;
  if (body === null) return null;
  try {
    const answer: unknown = JSON.parse(body);
    return record(answer) ? answer : null;
  } catch {
    return null;
  }
}

/** Core's refusal in its own words: an `error`, problems, or an update it
 * did not accept. */
function refusal(answer: Answer, t: Words): { note: string; details: CallDetail[] } | null {
  const problems = Array.isArray(answer.problems) ? answer.problems.filter(record) : [];
  const codes = [...new Set(problems.map((problem) => text(problem.code)).filter((code): code is string => !!code))];
  const error = text(answer.error);
  if (!error && answer.accepted !== false && !(answer.validateOnly === true ? answer.valid === false : codes.length)) return null;
  const details: CallDetail[] = answer.validateOnly === true ? [{ label: t.state, value: t.precheckFailed }] : [];
  if (error) details.push({ label: t.reason, value: clip(error), given: true });
  else if (codes.length) details.push({ label: t.reason, value: codes.join(", "), given: true });
  const latest = record(answer.latest) ? scalar(answer.latest.version) : null;
  if (latest) details.push({ label: t.latest, value: latest, given: true });
  // An error's code, as Core writes it before its explanation.
  const code = error?.match(/^([a-z_]+):/)?.[1];
  const note = codes.length ? codes.join(", ") : code ?? (error ? error.split("\n")[0] : t.tone.refused);
  return { note, details };
}

type Read = Pick<CallFacts, "note" | "noteGiven" | "details" | "caution"> & { tone?: CallTone; state?: string };

function taskLine(answer: Answer, t: Words): { id: string; details: CallDetail[] } | null {
  const task = record(answer.task) ? answer.task : null;
  const id = task && text(task.id);
  if (!task || !id) return null;
  const title = text(task.title);
  return { id, details: [{ label: t.task, value: title ? `${id} · ${clip(title, 120)}` : id, given: true }] };
}

/** What each of the six answers says. null: it isn't the answer expected. */
const readers: Record<YuzunoTool, (answer: Answer, t: Words, language: Language) => Read | null> = {
  task_comment(answer, t) {
    const task = taskLine(answer, t);
    if (!task) return null;
    const activity = record(answer.activity) ? scalar(answer.activity.seq) : null;
    return {
      note: t.commentSaved(task.id), noteGiven: false, caution: null,
      details: [...task.details, ...(activity ? [{ label: t.activity, value: `#${activity}`, given: true }] : [])],
    };
  },
  task_update(answer, t, language) {
    const task = taskLine(answer, t);
    const status = record(answer.task) ? text(answer.task.status) : null;
    if (!task || !status) return null;
    const words = boardText(language).statuses as Record<string, string>;
    const version = record(answer.task) ? scalar(answer.task.version) : null;
    return {
      note: t.taskUpdated(task.id, words[status] ?? status), noteGiven: false, caution: t.taskCaution,
      details: [...task.details, { label: t.statusThen, value: words[status] ?? status, given: !words[status] },
        ...(version ? [{ label: t.version, value: version, given: true }] : [])],
    };
  },
  brief_get(answer, t) {
    const version = scalar(answer.version);
    const full = count(answer.sections);
    if (!version || full === null) return null;
    const index = count(answer.index);
    const missing = Array.isArray(answer.missingKeys) ? answer.missingKeys.filter((key) => typeof key === "string") : [];
    const project = text(answer.projectName);
    return {
      note: index === null ? t.briefFull(version, full) : full ? t.briefIndexAndFull(version, index, full) : t.briefIndex(version, index),
      noteGiven: false, caution: null,
      details: [
        ...(project ? [{ label: t.project, value: clip(project, 120), given: true }] : []),
        { label: t.returnedWhat, value: index === null ? t.everySection : full ? t.indexAndSome(full) : t.indexOnly },
        { label: t.version, value: version, given: true },
        ...(missing.length ? [{ label: t.missing, value: clip(missing.join(", ")), given: true }] : []),
      ],
    };
  },
  brief_update(answer, t) {
    if (answer.validateOnly === true && answer.valid === true)
      return { note: t.precheckPassed, noteGiven: false, caution: null, details: [] };
    const version = scalar(answer.version);
    if (answer.accepted !== true || !version) return null;
    const keys = Array.isArray(answer.sections)
      ? answer.sections.map((section) => (record(section) ? text(section.key) : null)).filter((key): key is string => !!key) : [];
    const unchanged = record(answer.receipt) && answer.receipt.kind === "noChange";
    return {
      note: unchanged ? t.briefNoChange(version) : t.briefUpdated(version, keys.length), noteGiven: false, caution: null,
      details: [{ label: t.version, value: version, given: true },
        ...(keys.length ? [{ label: t.sections, value: clip(keys.join(", ")), given: true }] : [])],
    };
  },
  peer_read(answer, t) {
    const messages = Array.isArray(answer.messages) ? answer.messages : null;
    if (!messages || typeof answer.hasMore !== "boolean") return null;
    const senders = [...new Set(messages.map((message) => (record(message) && record(message.sender) ? text(message.sender.name) : null))
      .filter((name): name is string => !!name))];
    const through = scalar(answer.nextAfterSeq);
    return {
      note: messages.length ? t.mail(messages.length, answer.hasMore) : t.noMail, noteGiven: false, caution: null,
      details: [
        ...(senders.length ? [{ label: t.from, value: clip(senders.join(", "), 120), given: true }] : []),
        ...(through && messages.length ? [{ label: t.readTo, value: `#${through}`, given: true }] : []),
      ],
    };
  },
  peer_send(answer, t) {
    const message = record(answer.message) ? answer.message : null;
    const name = message && record(message.recipient) ? text(message.recipient.name) ?? text(message.recipient.id) : null;
    const delivery = message && record(message.delivery) ? text(message.delivery.state) : null;
    if (!message || !name || !delivery) return null;
    const said = t.delivery[delivery] ?? delivery;
    const tone: CallTone = delivery === "pending" || delivery === "sending" ? "queued"
      : delivery === "uncertain" ? "unconfirmed" : delivery === "error" ? "failed" : "returned";
    const seq = scalar(message.seq);
    const task = text(message.taskId);
    return {
      note: t.mailTo(name), noteGiven: false, caution: t.mailCaution, tone, state: said,
      details: [
        { label: t.recipient, value: name, given: true },
        { label: t.deliveryThen, value: said, given: !t.delivery[delivery] },
        ...(seq && seq !== "0" ? [{ label: t.message, value: `#${seq}`, given: true }] : []),
        ...(task ? [{ label: t.task, value: task, given: true }] : []),
        ...(message.priority === "urgent" ? [{ label: t.priority, value: t.urgent }] : []),
      ],
    };
  },
};

/** The capsule of `item`, named `label` (toolLabel's). `executionUnconfirmed`
 * as for callState. */
export function callFacts(item: NativeItem, label: string, language: Language, executionUnconfirmed: boolean): CallFacts {
  const t = callWords(language);
  const name = capsuleName(item, label);
  const state = callState(item, executionUnconfirmed);
  const facts: CallFacts = {
    name, fullName: typeof item.name === "string" && item.name !== name ? item.name : name,
    note: null, noteGiven: false, tone: state, state: state && state !== "returned" ? t.tone[state] : null,
    toExpand: false, details: [], caution: null,
  };
  // The harness's own error for a call that failed before Core answered.
  const error = record(item.error) ? text(item.error.message) : null;
  if (state === "failed" && error) Object.assign(facts, { note: error.split("\n")[0], noteGiven: true, details: [{ label: t.reason, value: clip(error), given: true }] });
  const call = yuzunoCall(item);
  // Still running or not confirmed: there is no answer to read yet.
  if (!call || state === "running" || state === "unconfirmed" || call.answer == null) return facts;
  if (item._yuzunoTruncated?.[call.field]) return { ...facts, toExpand: true, note: facts.note ?? t.toExpand };
  const answer = coreAnswer(call.answer);
  if (!answer) return { ...facts, toExpand: true, note: facts.note ?? t.toExpand };
  const refused = refusal(answer, t);
  if (refused) return { ...facts, tone: "refused", state: t.tone.refused, note: refused.note, noteGiven: true, details: refused.details };
  // A failure the answer doesn't explain stays the harness's failure.
  if (state === "failed") return facts;
  const read = readers[call.tool](answer, t, language);
  if (!read) return { ...facts, toExpand: true, note: t.toExpand };
  return { ...facts, ...read, tone: read.tone ?? facts.tone, state: read.state ?? facts.state };
}

/** What a Tool activity's heading says of its calls: how many steps, and
 * how many failed, were refused or are not confirmed. A running call is the
 * heading's own spinner; a call that returned needs no count. */
const notable: readonly CallTone[] = ["failed", "refused", "unconfirmed"];
export function toolOverview(items: readonly NativeItem[], language: Language, executionUnconfirmed: boolean) {
  const seen = new Set<string>();
  const held = new Map<CallTone, number>();
  for (const item of items) {
    if (seen.has(item.id) || item.type === "userMessage" || item.type === "agentMessage") continue;
    seen.add(item.id);
    const { tone } = callFacts(item, "", language, executionUnconfirmed);
    if (tone && notable.includes(tone)) held.set(tone, (held.get(tone) ?? 0) + 1);
  }
  return { steps: seen.size, notable: notable.filter((tone) => held.has(tone)).map((tone) => ({ tone, count: held.get(tone)! })) };
}
