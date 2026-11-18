import type { ReactNode } from "react";
import { FileText, GitPullRequest, MessageSquare, Tag } from "lucide-react";
import type { ReportLink } from "../deep-link";
import { useLanguage } from "../i18n";
import { Tip, TipText } from "../Tip";
import { openTask } from "./CardResponsible";
import type { Deliverable } from "./project-talk-api";
import { talkText } from "./talk-text";

/** Opens a report a card's task delivered (YN-208): the exact version its result named, by its identity on Home. */
export type OpenDeliveredReport = (link: Omit<ReportLink, "workspaceId" | "projectId">) => void;

/**
 * One thing a task delivered (YN-208), as a request's block lists it (RequestBlocks.tsx, YN-212): a report at the
 * version its result named, opened over Home, with where it stands now; a PR as GitHub was last read; a release; an
 * answer, whole. A report Home no longer keeps opens its task.
 */
export function DeliverableLine({ item, task, onReport, time, ago }: {
  item: Deliverable;
  task: string;
  onReport: OpenDeliveredReport;
  time: (at: string) => string;
  ago: (at: string) => string;
}) {
  const t = talkText(useLanguage());
  const body = (icon: ReactNode, title: string, meta: string, go: string | null) => (
    <>
      {icon}
      <span className="request-deliverable-title">{title}</span>
      {go && <span className="request-deliverable-go" aria-hidden="true">{go}</span>}
      <span className="request-deliverable-meta">{[meta, item.note].filter(Boolean).join(" · ")}</span>
    </>
  );
  const tip = (title: string, meta: string, extra?: string) => <TipText title={title} body={[item.note, extra].filter(Boolean).join("\n") || undefined} meta={meta} />;
  switch (item.kind) {
    case "report": {
      const open = item.state === "replaced" ? item.currentVersion : item.state === "gone" ? null : item.version;
      const newer = item.currentVersion !== null && item.currentVersion > item.version ? item.currentVersion : null;
      const meta = item.state === "history" ? t.reportInHistory(item.version, newer)
        : item.state === "replaced" ? t.reportReplaced(item.version, item.currentVersion ?? item.version)
          : item.state === "gone" ? t.reportGone(item.version) : t.reportVersion(item.version);
      const go = open === null ? t.openTask : open === item.version ? t.openReport : t.openVersion(open);
      return (
        <Tip content={tip(item.title, meta)} describe={false}>
          <button
            type="button"
            className="request-deliverable"
            data-kind="report"
            data-state={item.state}
            aria-label={open === null ? t.openTaskLabel(task) : t.openReportLabel(item.title, open)}
            onClick={(event) => {
              if (open === null) {
                openTask(task);
                return;
              }
              // Focus first, where a browser does not focus a clicked button (Safari): Back from the report returns here.
              event.currentTarget.focus({ preventScroll: true });
              onReport({ key: item.key, version: open, sectionId: item.sectionId });
            }}
          >
            {body(<FileText size={13} aria-hidden="true" />, item.title, meta, go)}
          </button>
        </Tip>
      );
    }
    case "pr": {
      const meta = t.prMeta(item.number, t.prState[item.state], item.observedAt ? ago(item.observedAt) : "");
      return (
        <Tip content={tip(item.title, meta, item.observedAt ? t.prObserved(time(item.observedAt)) : undefined)} describe={false}>
          <a className="request-deliverable" data-kind="pr" data-state={item.state} href={item.url} target="_blank" rel="noopener noreferrer">
            {body(<GitPullRequest size={13} aria-hidden="true" />, item.title, meta, t.openPr)}
          </a>
        </Tip>
      );
    }
    case "release": {
      const meta = t.releaseMeta(item.tag);
      return (
        <Tip content={tip(item.title, meta, t.releaseTip)} describe={false}>
          <a className="request-deliverable" data-kind="release" href={item.url} target="_blank" rel="noopener noreferrer">
            {body(<Tag size={13} aria-hidden="true" />, item.title, meta, t.openRelease)}
          </a>
        </Tip>
      );
    }
    case "answer":
      // Whole, wrapped: a phone has no tip to read the rest in.
      return (
        <p className="request-deliverable" data-kind="answer">
          {body(<MessageSquare size={13} aria-hidden="true" />, item.text, item.title ?? t.answer, null)}
        </p>
      );
  }
}
