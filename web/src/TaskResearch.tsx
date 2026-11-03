import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorText } from "./api";
import { formatTime } from "./home/brief/brief-catalog";
import { strings, useStrings } from "./i18n";
import { useTimeDisplay } from "./time-preferences";
import "./task-research.css";

/**
 * A research record in a task's activity (T-17): a method, a claim or an
 * observation as its author wrote it, fixed once written. Each source shows
 * the identity recorded with it; what holds now (the newest version, each
 * source's state, the method version a claim was made with) is read on
 * request from task_research_get, by the same resolver a Home research desk
 * uses: again at every opening, and with "Check again", because a record's
 * newest version and its sources' states change without the task changing
 * (a research record is a comment: the task's version stays). An answer is
 * kept for one record (Workspace, task and activity) and shown with when it
 * was read; a late answer for another record, or an older read, is dropped. Nothing here says a record is true: a claim's status is its author's,
 * a Job source is a recorded match of this task's Job, and an external source
 * is as stated.
 */
type Producer = { kind?: string; id?: string; name?: string };
export type ResearchSource =
  | { kind: "job"; label?: string; jobId: string; attempt: string; path: string; sha256: string; bytes?: number | null; recorded?: string; now?: { state?: string } }
  | { kind: "task"; label?: string; taskId: string; activitySeq: number; record?: { kind: string; type?: string; id?: string; title?: string; summary?: string; status?: string }; producer?: Producer; at?: string; now?: { state?: string } }
  | { kind: "external"; label?: string; url?: string; version?: string; observedAt?: string; sha256?: string; coverage?: string; checked?: boolean; now?: { state?: string } };
export type ResearchRecord = {
  schema?: string;
  type: "method" | "claim" | "observation" | "comparison";
  id: string;
  title: string;
  text: string;
  field?: string;
  status?: "supported" | "conditional" | "unsupported" | "open";
  conditions?: string[];
  limits?: string[];
  method?: { activitySeq: number; id?: string; title?: string };
  sources?: ResearchSource[];
  revises?: { activitySeq: number; reason: string; scope?: "narrows" | "withdraws" | "unchecked" };
  /** What its kind of study keeps apart (T-17 slice 5), by field; never required. */
  details?: Record<string, string | number | string[]>;
  /** What the record proposes next (T-17 slice 4): a proposal, never an action. */
  next?: { action: "check" | "stop"; text: string };
  /** A comparison's entries (T-17 slice 2), as their author gave them. */
  entries?: ResearchEntry[];
  comparability?: Comparability;
};
export type ResearchEntry = {
  id: string;
  label: string;
  status: "included" | "excluded" | "missing" | "not_done";
  reason?: string;
  source?: ResearchSource;
  method?: { activitySeq: number; id?: string; title?: string };
  definition?: string;
  unit?: string;
  level?: string;
  n?: number;
  value?: { value: number; low?: number; high?: number };
};
/** What the included entries share, as Core worked it out when they were written. */
type Comparability = {
  aligned: boolean;
  shared: Partial<Record<"unit" | "definition" | "level" | "method", string | number>>;
  differs: string[];
  unknown: string[];
  counts: Record<"included" | "excluded" | "missing" | "not_done", number>;
};
type ResearchView = {
  activitySeq: number;
  version: number | null;
  revisedBy: number | null;
  latestActivitySeq: number | null;
  research: ResearchRecord;
  method: (ResearchView & { at?: string }) | null;
  /** How the next version revised this one, as it said. */
  revision?: { activitySeq: number; scope: string | null; reason: string } | null;
};

const text = strings({
  type: { method: "Method", claim: "Claim", observation: "Observation", comparison: "Comparison" } as Record<string, string>,
  entries: "Compared",
  entryState: { included: "Included", excluded: "Excluded", missing: "Missing", not_done: "Not done" } as Record<string, string>,
  aspect: { unit: "unit", definition: "definition", level: "sample level", method: "method" } as Record<string, string>,
  aligned: (shared: string) => `The included entries share ${shared}. Yuzuno computes no difference: they are compared as their author compares them.`,
  sideBySide: (differs: string, unknown: string, unknowns: number) =>
    `Side by side only: ${[differs && `the included entries differ in ${differs}`, unknown && `${unknown} ${unknowns > 1 ? "are" : "is"} not given for every entry`].filter(Boolean).join("; ")}. Yuzuno computes no difference.`,
  tooFew: "Fewer than two included entries: nothing to compare yet.",
  counts: (counts: Record<string, number>) =>
    [`${counts.included} included`, `${counts.excluded} excluded`, `${counts.missing} missing`, `${counts.not_done} not done`].join(" · "),
  methodActivity: (seq: number) => `method in activity ${seq}`,
  // Each part of an entry as its author gave it; a missing part is said, never made up.
  n: (n: string) => `n = ${n}`,
  levelMissing: "sample level not given",
  lowMissing: "low not given",
  highMissing: "high not given",
  noValue: "No value given",
  inexact: "≈: past JavaScript's safe integer range, the value shown may have been rounded; Core keeps the value it parsed.",
  unit: (unit: string) => `unit ${unit}`,
  field: { theory: "Theory", systems: "Systems", ml: "ML", robotics: "Robotics", other: "Other" } as Record<string, string>,
  status: {
    supported: "Supported",
    conditional: "Holds under conditions",
    unsupported: "Not supported",
    open: "Open",
  } as Record<string, string>,
  authors: "the author's judgement",
  conditions: "Holds only under",
  limits: "Limits",
  madeWith: (title: string, seq: number) => `Made with the method “${title}” as written in activity ${seq}`,
  revises: (seq: number) => `Revises activity ${seq}`,
  // What a claim's new version says it does to the earlier scope (slice 5).
  revisesScope: {
    narrows: (seq: number) => `Narrows activity ${seq}`,
    withdraws: (seq: number) => `Withdraws activity ${seq}`,
    unchecked: (seq: number) => `Revises activity ${seq}; whether its scope still holds is not checked yet`,
  } as Record<string, (seq: number) => string>,
  revisedHow: (seq: number, scope: string | null) =>
    scope === "narrows" ? `Activity ${seq} narrows this scope`
      : scope === "withdraws" ? `Activity ${seq} withdraws it`
        : scope === "unchecked" ? `Activity ${seq} revises it; whether this scope still holds is not checked yet`
          : `Activity ${seq} revises it and leaves this scope as written`,
  // What each kind of study keeps apart (slice 5): as given, never judged.
  result: { proof: "Proof", counterexample: "Counterexample", conjecture: "Conjecture", partial: "Partial result" } as Record<string, string>,
  checkedHow: (how: string, bound?: string) =>
    ({ by_hand: "checked by hand", formal: "checked formally", enumeration: `checked by enumeration up to ${bound}`, none: "not checked" } as Record<string, string>)[how] ?? how,
  enumerationNote: "A finite enumeration is no general proof.",
  formalNote: "A formal check covers the formal statement; whether it answers the question is the author's judgement.",
  obligations: "Proof obligations",
  levels: "Levels",
  level: { machines: ["machine", "machines"], builds: ["build", "builds"], processes: ["process", "processes"],
    iterations: ["iteration", "iterations"] } as Record<string, string | [string, string]>,
  warmup: "Warm-up",
  iterationsNote: "Iterations within one process are not independent runs.",
  ml: { baseline: "Baseline", selection: "Selection", budget: "Budget", seeds: "Seeds", split: "Split" } as Record<string, string>,
  episodes: "Episodes",
  episode: { planned: "planned", executed: "executed", completed: "completed", intervened: "intervened", stopped: "stopped", excluded: "excluded" } as Record<string, string>,
  protocol: "Protocol",
  episodesNote: "These counts overlap: an intervened episode may also be completed, and the denominator is the protocol's.",
  next: { check: "Proposes a next check", stop: "Proposes to stop" } as Record<string, string>,
  nextNote: "A proposal: nothing runs or stops because of it.",
  sources: "Sources",
  job: "Job artifact",
  jobRecorded: "Matched this task's recorded Job check when written",
  task: (task: string, seq: number) => `${task} · activity ${seq}`,
  by: (name: string, at: string) => `by ${name}, ${at}`,
  external: "External",
  stated: "As its author stated it; Yuzuno did not check it",
  observed: (at: string) => `observed ${at}`,
  version: (version: string) => `version ${version}`,
  coverage: "Coverage",
  details: "Version and sources now",
  hide: "Hide",
  again: "Check again",
  checked: (at: string) => `Read ${at}`,
  loading: "Reading the record…",
  failed: (reason: string) => `The record couldn't be read: ${reason}`,
  versionOf: (version: number) => `Version ${version} of this record`,
  versionUnknown: "This record's version was not counted (its line is longer than Yuzuno follows)",
  newest: "This is the newest version",
  newer: (seq: number) => `A newer version is activity ${seq}`,
  // Past the length Core follows a newer version always exists; which one is
  // the latest is what is unknown. The next one, when known, is named.
  newerFrom: (seq: number) => `Activity ${seq} revises this one; the latest version is unknown`,
  newerUnknown: "A newer version exists; the latest version is unknown",
  methodVersion: (version: number | null, latest: number | null, seq: number, next: number | null) =>
    `The method as cited is ${version ? `version ${version}` : "a version not counted"}` +
    (latest == null
      ? next != null ? `; activity ${next} revises it, and its latest version is unknown` : "; a newer version exists, and its latest version is unknown"
      : latest === seq ? "; that is its newest version" : `; a newer version is activity ${latest}`),
  now: "Now",
  state: {
    recorded_match: "the Job's record still lists this file and hash; the file itself was not read",
    attempt_mismatch: "Job record no longer shows this attempt",
    artifact_missing: "Job record no longer lists this file",
    artifact_mismatch: "Job record now differs",
    job_missing: "Job record no longer kept",
    readable: "Record readable",
    missing: "Record no longer readable",
    stated: "Not checked",
  } as Record<string, string>,
}, {
  type: { method: "方法", claim: "主张", observation: "观察", comparison: "比较" },
  entries: "比较的条目",
  entryState: { included: "纳入", excluded: "排除", missing: "缺失", not_done: "未做" },
  aspect: { unit: "单位", definition: "定义", level: "样本层级", method: "方法" },
  aligned: (shared) => `纳入的条目共用${shared}。Yuzuno 不计算差异：按作者的方式比较。`,
  sideBySide: (differs, unknown) =>
    `仅并列展示：${[differs && `纳入的条目在${differs}上不同`, unknown && `并非每个条目都给出了${unknown}`].filter(Boolean).join("；")}。Yuzuno 不计算差异。`,
  tooFew: "纳入的条目不足两个：还没有可比较的内容。",
  counts: (counts) => [`纳入 ${counts.included}`, `排除 ${counts.excluded}`, `缺失 ${counts.missing}`, `未做 ${counts.not_done}`].join(" · "),
  methodActivity: (seq) => `活动 ${seq} 中的方法`,
  n: (n) => `n = ${n}`,
  levelMissing: "未给样本层级",
  lowMissing: "下限未给",
  highMissing: "上限未给",
  noValue: "未给数值",
  inexact: "≈：超出 JavaScript 安全整数范围，显示值可能已舍入；Core 保留它解析的数值。",
  unit: (unit) => `单位 ${unit}`,
  field: { theory: "理论", systems: "系统", ml: "ML", robotics: "机器人", other: "其他" },
  status: { supported: "得到支持", conditional: "在条件下成立", unsupported: "不支持", open: "未定" },
  authors: "作者的判断",
  conditions: "只在以下条件下成立",
  limits: "限制",
  madeWith: (title, seq) => `用活动 ${seq} 中写下的方法“${title}”得出`,
  revises: (seq) => `修订活动 ${seq}`,
  revisesScope: {
    narrows: (seq) => `收窄活动 ${seq}`,
    withdraws: (seq) => `撤回活动 ${seq}`,
    unchecked: (seq) => `修订活动 ${seq}；它的适用范围是否仍成立尚未核对`,
  },
  revisedHow: (seq, scope) =>
    scope === "narrows" ? `活动 ${seq} 收窄了这一适用范围`
      : scope === "withdraws" ? `活动 ${seq} 撤回了它`
        : scope === "unchecked" ? `活动 ${seq} 修订了它；这一适用范围是否仍成立尚未核对`
          : `活动 ${seq} 修订了它，这一适用范围保持原样`,
  result: { proof: "证明", counterexample: "反例", conjecture: "猜想", partial: "部分结果" },
  checkedHow: (how, bound) =>
    ({ by_hand: "人工核对", formal: "形式化核对", enumeration: `枚举核对至 ${bound}`, none: "未核对" } as Record<string, string>)[how] ?? how,
  enumerationNote: "有限枚举不是一般性证明。",
  formalNote: "形式化核对只覆盖形式化的命题；它是否回答了原问题是作者的判断。",
  obligations: "证明义务",
  levels: "层级",
  level: { machines: "台机器", builds: "次构建", processes: "个进程", iterations: "次迭代" },
  warmup: "预热",
  iterationsNote: "同一进程内的多次迭代不是相互独立的运行。",
  ml: { baseline: "基线", selection: "选模", budget: "预算", seeds: "种子数", split: "数据划分" },
  episodes: "回合",
  episode: { planned: "计划", executed: "执行", completed: "完成", intervened: "介入", stopped: "停止", excluded: "排除" },
  protocol: "协议",
  episodesNote: "这些计数会重叠：被介入的回合也可能完成，分母以协议为准。",
  next: { check: "提议下一项检查", stop: "提议停止" },
  nextNote: "只是提议：不会因此运行或停止任何东西。",
  sources: "来源",
  job: "Job 产物",
  jobRecorded: "写下时与本任务 Job 的记录检查一致",
  task: (task, seq) => `${task} · 活动 ${seq}`,
  by: (name, at) => `${name}，${at}`,
  external: "外部",
  stated: "按作者所述记录；Yuzuno 没有检查",
  observed: (at) => `观察于 ${at}`,
  version: (version) => `版本 ${version}`,
  coverage: "覆盖范围",
  details: "版本与来源现状",
  hide: "收起",
  again: "重新核对",
  checked: (at) => `读取于 ${at}`,
  loading: "正在读取记录…",
  failed: (reason) => `无法读取这条记录：${reason}`,
  versionOf: (version) => `这条记录的第 ${version} 版`,
  versionUnknown: "这条记录的版本数未计出（版本链超出 Yuzuno 追溯的长度）",
  newest: "这是最新版本",
  newer: (seq) => `较新的版本是活动 ${seq}`,
  newerFrom: (seq) => `活动 ${seq} 修订了它；最新版本未确定`,
  newerUnknown: "已有较新的版本；最新版本未确定",
  methodVersion: (version, latest, seq, next) =>
    `引用的方法是${version ? `第 ${version} 版` : "未计出版本数的一版"}` +
    (latest == null
      ? next != null ? `；活动 ${next} 修订了它，最新版本未确定` : "；已有较新的版本，最新版本未确定"
      : latest === seq ? "；这是它的最新版本" : `；较新的版本是活动 ${latest}`),
  now: "现在",
  state: {
    recorded_match: "Job 记录仍列出这个文件和哈希；没有读取文件本身",
    attempt_mismatch: "Job 记录不再显示这次尝试",
    artifact_missing: "Job 记录不再列出这个文件",
    artifact_mismatch: "Job 记录现在不同",
    job_missing: "Job 记录已不再保存",
    readable: "记录可读",
    missing: "记录已无法读取",
    stated: "未检查",
  },
});

const short = (sha: string) => sha.slice(0, 12);
/** Past JavaScript's safe integers (2^53 − 1) a browser cannot hold every
 * integer exactly: Core keeps the number it parsed, but this page has only
 * the nearest one it can hold, which may be rounded. One check for value,
 * low, high and n alike. */
const inexact = (n: number) => Number.isInteger(n) && !Number.isSafeInteger(n);
/** A number as its author gave it, with a true minus sign; marked ≈ when
 * this page cannot show it exactly. */
const figure = (n: number) => (inexact(n) ? "≈" : "") + String(n).replace("-", "−");

/** What a record's kind of study keeps apart (slice 5), as its author gave
 * it, with what each part cannot show. Never judged or reconciled. */
function Details({ field, details }: { field: string; details: Record<string, string | number | string[]> }) {
  const t = useStrings(text);
  const count = (key: string) => (typeof details[key] === "number" ? figure(details[key] as number) : undefined);
  const counted = (keys: Record<string, string | [string, string]>) =>
    Object.keys(keys)
      .filter((key) => count(key) !== undefined)
      .map((key) => {
        const label = keys[key];
        return `${count(key)} ${Array.isArray(label) ? label[details[key] === 1 ? 0 : 1] : label}`;
      })
      .join(" · ");
  const note = (line: string) => <span className="task-research-note">{line}</span>;
  let body: ReactNode = null;
  if (field === "theory") {
    const result = typeof details.result === "string" ? t.result[details.result] ?? details.result : undefined;
    const checked = typeof details.checked === "string" ? t.checkedHow(details.checked, details.bound as string | undefined) : undefined;
    body = (
      <>
        {(result || checked) && <span>{[result, checked].filter(Boolean).join(" · ")}</span>}
        {details.checked === "enumeration" && note(t.enumerationNote)}
        {details.checked === "formal" && note(t.formalNote)}
        {Array.isArray(details.obligations) && details.obligations.length > 0 && (
          <>
            <strong>{t.obligations}</strong>
            <ul>{details.obligations.map((item, n) => <li key={n}>{item}</li>)}</ul>
          </>
        )}
      </>
    );
  } else if (field === "systems") {
    const levels = counted(t.level);
    body = (
      <>
        {levels && <span>{t.levels}: {levels}</span>}
        {typeof details.warmup === "string" && <span>{t.warmup}: {details.warmup}</span>}
        {details.iterations !== undefined && note(t.iterationsNote)}
      </>
    );
  } else if (field === "ml") {
    body = (
      <dl>
        {Object.keys(t.ml).filter((key) => details[key] !== undefined).map((key) => (
          <div key={key}>
            <dt>{t.ml[key]}</dt>
            <dd>{count(key) ?? String(details[key])}</dd>
          </div>
        ))}
      </dl>
    );
  } else if (field === "robotics") {
    const episodes = counted(t.episode);
    body = (
      <>
        {episodes && <span>{t.episodes}: {episodes}</span>}
        {typeof details.protocol === "string" && <span>{t.protocol}: {details.protocol}</span>}
        {episodes && note(t.episodesNote)}
      </>
    );
  }
  return body ? <div className="task-research-details" data-field={field}>{body}</div> : null;
}

/** A comparison's entries: every one, left out or not, each with why. */
function Entries({ entries, comparability, now }: { entries: ResearchEntry[]; comparability?: Comparability; now?: ResearchEntry[] }) {
  const t = useStrings(text);
  const named = (fields: string[]) => fields.map((field) => t.aspect[field] ?? field).join(", ");
  const shared = comparability
    ? Object.entries(comparability.shared)
        .map(([field, value]) => (field === "method" ? `${t.aspect.method} (${t.methodActivity(Number(value))})` : `${t.aspect[field] ?? field} (${value})`))
        .join(", ")
    : "";
  return (
    <div className="task-research-entries">
      <strong>{t.entries}</strong>
      {comparability && (
        <p className="task-research-comparability" data-aligned={comparability.aligned || undefined}>
          {comparability.counts.included < 2
            ? t.tooFew
            : comparability.aligned
              ? t.aligned(shared)
              : t.sideBySide(named(comparability.differs), named(comparability.unknown), comparability.unknown.length)}
          <span>{t.counts(comparability.counts)}</span>
        </p>
      )}
      <ul>
        {entries.map((entry, n) => (
          <li key={entry.id} className="task-research-entry" data-state={entry.status}>
            <span className="task-research-entry-head">
              <span className="task-research-source-name">{entry.label}</span>
              <span className="task-research-tag" data-state={entry.status}>{t.entryState[entry.status] ?? entry.status}</span>
            </span>
            {entry.reason && <span className="task-research-note">{entry.reason}</span>}
            {entry.value ? (
              <span
                className="task-research-value"
                title={[entry.value.value, entry.value.low, entry.value.high].some((n) => n !== undefined && inexact(n)) ? t.inexact : undefined}
              >
                {figure(entry.value.value)}
                {(entry.value.low !== undefined || entry.value.high !== undefined) &&
                  ` [${entry.value.low !== undefined ? figure(entry.value.low) : t.lowMissing}, ${
                    entry.value.high !== undefined ? figure(entry.value.high) : t.highMissing
                  }]`}
                {entry.unit && ` ${entry.unit}`}
              </span>
            ) : (
              entry.unit && <span className="task-research-value">{t.noValue} · {t.unit(entry.unit)}</span>
            )}
            {(entry.level || entry.n !== undefined || entry.definition || entry.method) && (
              <span className="task-research-identity" title={entry.n !== undefined && inexact(entry.n) ? t.inexact : undefined}>
                {[
                  entry.level ?? (entry.n !== undefined && t.levelMissing),
                  entry.n !== undefined && t.n(figure(entry.n)),
                  entry.definition,
                  entry.method && t.methodActivity(entry.method.activitySeq),
                ]
                  .filter((part) => part !== false && part !== undefined && part !== "")
                  .join(" · ")}
              </span>
            )}
            {entry.source && (
              <ul className="task-research-entry-source">
                <SourceRow source={entry.source} now={now?.[n]?.source?.now?.state} />
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceRow({ source, now }: { source: ResearchSource; now?: string }) {
  const t = useStrings(text);
  const time = useTimeDisplay();
  return (
    <li className="task-research-source" data-kind={source.kind}>
      {source.kind === "job" && (
        <>
          <span className="task-research-source-name">
            {source.label ?? source.path}
            <span className="task-research-tag">{t.job}</span>
          </span>
          <span className="task-research-identity">
            <code>{source.jobId}</code> · <code title={source.attempt}>{source.attempt.slice(0, 8)}</code> · <code>{source.path}</code> · SHA-256{" "}
            <code title={source.sha256}>{short(source.sha256)}</code>
          </span>
          <span className="task-research-note">{t.jobRecorded}</span>
        </>
      )}
      {source.kind === "task" && (
        <>
          <span className="task-research-source-name">
            {source.label ?? source.record?.title ?? source.record?.summary}
            <span className="task-research-tag">
              {source.record?.type ? t.type[source.record.type] ?? source.record.type : source.record?.kind}
            </span>
          </span>
          <span className="task-research-identity">
            {t.task(source.taskId, source.activitySeq)}
            {source.producer?.name && source.at && <> · {t.by(source.producer.name, formatTime(source.at, time))}</>}
          </span>
        </>
      )}
      {source.kind === "external" && (
        <>
          <span className="task-research-source-name">
            {source.url ? (
              <a href={source.url} target="_blank" rel="noreferrer noopener">
                {source.label}
              </a>
            ) : (
              source.label
            )}
            <span className="task-research-tag">{t.external}</span>
          </span>
          {(source.version || source.observedAt || source.sha256) && (
            <span className="task-research-identity">
              {[source.version && t.version(source.version), source.observedAt && t.observed(source.observedAt)].filter(Boolean).join(" · ")}
              {source.sha256 && <> · SHA-256 <code title={source.sha256}>{short(source.sha256)}</code></>}
            </span>
          )}
          {source.coverage && (
            <span className="task-research-identity">
              {t.coverage}: {source.coverage}
            </span>
          )}
          <span className="task-research-note">{t.stated}</span>
        </>
      )}
      {now && (
        <span className="task-research-now" data-state={now}>
          {t.now}: {t.state[now] ?? now}
        </span>
      )}
    </li>
  );
}

type Read = { record: string; data?: ResearchView; error?: string; readAt?: string };

export function TaskResearch({ workspaceId, taskId, seq, record }: { workspaceId: string; taskId: string; seq: number; record: ResearchRecord }) {
  const t = useStrings(text);
  const time = useTimeDisplay();
  // The record this card is: an answer for any other is never shown here.
  const identity = `${workspaceId}\n${taskId}\n${seq}`;
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Read | null>(null);
  const reading = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const stop = () => {
    reading.current.generation += 1;
    reading.current.controller?.abort();
    reading.current.controller = null;
  };
  // Another record in this place (another Workspace, task or activity):
  // forget the answer, close, and drop any read still on its way.
  useEffect(() => {
    stop();
    setRead(null);
    setOpen(false);
    return stop;
  }, [identity]);
  const check = () => {
    stop();
    const generation = reading.current.generation;
    const controller = new AbortController();
    reading.current.controller = controller;
    const mine = () => reading.current.generation === generation && !controller.signal.aborted;
    setRead({ record: identity });
    api<ResearchView>("/collaboration/task_research_get", {
      method: "POST",
      body: JSON.stringify({ taskId, activitySeq: seq }),
      signal: controller.signal,
    })
      .then((data) => {
        if (mine()) setRead({ record: identity, data, readAt: new Date().toISOString() });
      })
      .catch((error) => {
        if (mine()) setRead({ record: identity, error: errorText(error) });
      });
  };
  const toggle = () => {
    if (open) {
      stop();
      setOpen(false);
    } else {
      setOpen(true);
      check();
    }
  };
  const view = read?.record === identity ? read : null;
  const now = view?.data?.research.sources;
  const id = `task-research-${seq}`;
  return (
    <section className="task-research" data-type={record.type} aria-labelledby={`${id}-title`}>
      <div className="task-research-head">
        <span className="task-research-kind">{t.type[record.type] ?? record.type}</span>
        <code className="task-research-id">{record.id}</code>
        {record.field && <span className="task-research-tag">{t.field[record.field] ?? record.field}</span>}
      </div>
      <h5 id={`${id}-title`}>{record.title}</h5>
      {record.status && (
        <p className="task-research-status" data-status={record.status}>
          {t.status[record.status]} <span>({t.authors})</span>
        </p>
      )}
      <p className="task-research-text">{record.text}</p>
      {record.revises && (
        <p className="task-research-revises" data-scope={record.revises.scope}>
          <strong>
            {(record.revises.scope && t.revisesScope[record.revises.scope]?.(record.revises.activitySeq)) ?? t.revises(record.revises.activitySeq)}
          </strong>{" "}
          {record.revises.reason}
        </p>
      )}
      {record.details && record.field && <Details field={record.field} details={record.details} />}
      {record.method && (
        <p className="task-research-method">{t.madeWith(record.method.title ?? record.method.id ?? "", record.method.activitySeq)}</p>
      )}
      {!!record.conditions?.length && (
        <div className="task-research-list">
          <strong>{t.conditions}</strong>
          <ul>{record.conditions.map((item, n) => <li key={n}>{item}</li>)}</ul>
        </div>
      )}
      {!!record.limits?.length && (
        <div className="task-research-list" data-limits="">
          <strong>{t.limits}</strong>
          <ul>{record.limits.map((item, n) => <li key={n}>{item}</li>)}</ul>
        </div>
      )}
      {record.next && (
        <p className="task-research-next" data-action={record.next.action} title={t.nextNote}>
          <strong>{t.next[record.next.action] ?? record.next.action}</strong> {record.next.text}
        </p>
      )}
      {!!record.entries?.length && <Entries entries={record.entries} comparability={record.comparability} now={view?.data?.research.entries} />}
      {!!record.sources?.length && (
        <div className="task-research-sources">
          <strong>{t.sources}</strong>
          <ul>
            {record.sources.map((source, n) => (
              <SourceRow key={n} source={source} now={now?.[n]?.now?.state} />
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        className="text-button task-research-toggle"
        aria-expanded={open}
        aria-controls={`${id}-now`}
        onClick={toggle}
      >
        {open ? t.hide : t.details}
      </button>
      {open && (
        <div className="task-research-details" id={`${id}-now`} role="status">
          {!view?.data && !view?.error && <p>{t.loading}</p>}
          {view?.error && <p className="task-research-failed">{t.failed(view.error)}</p>}
          {view?.data && (
            <>
              <p className="task-research-read">
                {view.readAt && t.checked(formatTime(view.readAt, time))}
                <button type="button" className="text-button task-research-again" onClick={check}>
                  {t.again}
                </button>
              </p>
              <p>
                {view.data.version ? t.versionOf(view.data.version) : t.versionUnknown}
                {" · "}
                {/* Newest only when the newest is this record; unknown is said, never shown as newest. */}
                {view.data.latestActivitySeq === seq
                  ? t.newest
                  : view.data.latestActivitySeq != null
                    ? t.newer(view.data.latestActivitySeq)
                    : view.data.revisedBy != null
                      ? t.newerFrom(view.data.revisedBy)
                      : t.newerUnknown}
              </p>
              {view.data.revision && (
                <p className="task-research-revised" data-scope={view.data.revision.scope ?? undefined}>
                  <strong>{t.revisedHow(view.data.revision.activitySeq, view.data.revision.scope)}:</strong> {view.data.revision.reason}
                </p>
              )}
              {view.data.method && (
                <p>{t.methodVersion(view.data.method.version, view.data.method.latestActivitySeq, view.data.method.activitySeq, view.data.method.revisedBy)}</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
