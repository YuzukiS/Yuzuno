import { useEffect, useRef, useState } from "react";
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
  revises?: { activitySeq: number; reason: string };
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
};

const text = strings({
  type: { method: "Method", claim: "Claim", observation: "Observation", comparison: "Comparison" } as Record<string, string>,
  entries: "Compared",
  entryState: { included: "Included", excluded: "Excluded", missing: "Missing", not_done: "Not done" } as Record<string, string>,
  aspect: { unit: "unit", definition: "definition", level: "sample level", method: "method" } as Record<string, string>,
  aligned: (shared: string) => `The included entries share ${shared}. Yuzuno computes no difference: they are compared as their author compares them.`,
  sideBySide: (differs: string, unknown: string) =>
    `Side by side only: ${[differs && `the included entries differ in ${differs}`, unknown && `${unknown} is not given for every entry`].filter(Boolean).join("; ")}. Yuzuno computes no difference.`,
  tooFew: "Fewer than two included entries: nothing to compare yet.",
  counts: (counts: Record<string, number>) =>
    [`${counts.included} included`, `${counts.excluded} excluded`, `${counts.missing} missing`, `${counts.not_done} not done`].join(" · "),
  methodActivity: (seq: number) => `method in activity ${seq}`,
  level: (level: string, n?: number) => (n === undefined ? level : `${level} · n = ${n}`),
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
  level: (level, n) => (n === undefined ? level : `${level} · n = ${n}`),
  field: { theory: "理论", systems: "系统", ml: "ML", robotics: "机器人", other: "其他" },
  status: { supported: "得到支持", conditional: "在条件下成立", unsupported: "不支持", open: "未定" },
  authors: "作者的判断",
  conditions: "只在以下条件下成立",
  limits: "限制",
  madeWith: (title, seq) => `用活动 ${seq} 中写下的方法“${title}”得出`,
  revises: (seq) => `修订活动 ${seq}`,
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
/** A number as its author gave it, with a true minus sign. */
const figure = (n: number) => String(n).replace("-", "−");

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
              : t.sideBySide(named(comparability.differs), named(comparability.unknown))}
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
            {entry.value && (
              <span className="task-research-value">
                {figure(entry.value.value)}
                {entry.value.low !== undefined && entry.value.high !== undefined && ` [${figure(entry.value.low)}, ${figure(entry.value.high)}]`}
                {entry.unit && ` ${entry.unit}`}
              </span>
            )}
            {(entry.level || entry.definition || entry.method) && (
              <span className="task-research-identity">
                {[entry.level && t.level(entry.level, entry.n), entry.definition, entry.method && t.methodActivity(entry.method.activitySeq)]
                  .filter(Boolean)
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
        <p className="task-research-revises">
          <strong>{t.revises(record.revises.activitySeq)}</strong> {record.revises.reason}
        </p>
      )}
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
