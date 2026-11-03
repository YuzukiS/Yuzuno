import { useEffect, useState } from "react";
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
 * uses. Nothing here says a record is true: a claim's status is its author's,
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
  type: "method" | "claim" | "observation";
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
  type: { method: "Method", claim: "Claim", observation: "Observation" } as Record<string, string>,
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
  loading: "Reading the record…",
  failed: (reason: string) => `The record couldn't be read: ${reason}`,
  versionOf: (version: number) => `Version ${version} of this record`,
  newest: "This is the newest version",
  newer: (seq: number) => `A newer version is activity ${seq}`,
  methodVersion: (version: number | null, latest: number | null, seq: number) =>
    `The method as cited is version ${version ?? "?"}` + (latest && latest !== seq ? `; a newer version is activity ${latest}` : ""),
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
  type: { method: "方法", claim: "主张", observation: "观察" },
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
  loading: "正在读取记录…",
  failed: (reason) => `无法读取这条记录：${reason}`,
  versionOf: (version) => `这条记录的第 ${version} 版`,
  newest: "这是最新版本",
  newer: (seq) => `较新的版本是活动 ${seq}`,
  methodVersion: (version, latest, seq) =>
    `引用的方法是第 ${version ?? "?"} 版` + (latest && latest !== seq ? `；较新的版本是活动 ${latest}` : ""),
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

export function TaskResearch({ taskId, seq, record }: { taskId: string; seq: number; record: ResearchRecord }) {
  const t = useStrings(text);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ data?: ResearchView; error?: string } | null>(null);
  useEffect(() => {
    if (!open || view) return;
    const controller = new AbortController();
    api<ResearchView>("/collaboration/task_research_get", {
      method: "POST",
      body: JSON.stringify({ taskId, activitySeq: seq }),
      signal: controller.signal,
    })
      .then((data) => setView({ data }))
      .catch((error) => {
        if (!controller.signal.aborted) setView({ error: errorText(error) });
      });
    return () => controller.abort();
  }, [open, view, taskId, seq]);
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
        onClick={() => setOpen((shown) => !shown)}
      >
        {open ? t.hide : t.details}
      </button>
      {open && (
        <div className="task-research-details" id={`${id}-now`} role="status">
          {!view && <p>{t.loading}</p>}
          {view?.error && <p className="task-research-failed">{t.failed(view.error)}</p>}
          {view?.data && (
            <>
              <p>
                {view.data.version ? t.versionOf(view.data.version) : null}
                {" · "}
                {view.data.latestActivitySeq && view.data.latestActivitySeq !== seq ? t.newer(view.data.latestActivitySeq) : t.newest}
              </p>
              {view.data.method && (
                <p>{t.methodVersion(view.data.method.version, view.data.method.latestActivitySeq, view.data.method.activitySeq)}</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
