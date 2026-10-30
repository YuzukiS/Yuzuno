import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Bot,
  ClipboardList,
  Cpu,
  GitPullRequest,
  ScanSearch,
  Server,
  UserRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { openJobs } from "../../Jobs";
import { boardText } from "../../collaboration-text";
import { useBriefDensity } from "../home-density";
import { useHomeRead } from "../home-read";
import { sourceTarget } from "../../intelligent-ui/contract.ts";
import { useBrief, type BriefContextValue } from "./BriefContext";
import type { LiveRefState, Section } from "../types";
import { formatTime, type LiveRef, type LiveRefKind, type LiveRefsProps } from "./brief-catalog";
import { useTimeDisplay } from "../../time-preferences";
import { useLanguage, useStrings } from "../../i18n";
import { briefText } from "./brief-text";

const kinds: Record<LiveRefKind, { icon: LucideIcon }> = {
  task: { icon: ClipboardList },
  pr: { icon: GitPullRequest },
  ci: { icon: Workflow },
  job: { icon: Cpu },
  review: { icon: ScanSearch },
  agent: { icon: Bot },
  machine: { icon: Server },
};

/** A GitHub page, checked by the same rule as result sources; anything else is not a link. */
function githubPage(href: string): string | null {
  const target = sourceTarget(href);
  if (target?.kind !== "web") return null;
  const url = new URL(target.path);
  return url.protocol === "https:" && url.hostname === "github.com" ? url.href : null;
}
/** `owner/repo#123` names a pull request as GitHub writes it. */
const shortPr = (id: string) => {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(id);
  return match ? githubPage(`https://github.com/${match[1]}/pull/${match[2]}`) : null;
};

type Opening = { href: string } | { open: () => void } | null;
/**
 * Where a reference leads: the panel the app already opens for it, or a
 * GitHub page in a new tab. Opening only shows something; it never starts,
 * approves or changes anything. Core's current state, when it sent one,
 * supplies the PR or run URL and a review's task; without it (an older
 * Core) the reference's own id is all there is.
 */
function opening(ref: LiveRef, brief: BriefContextValue, state: LiveRefState | undefined): Opening {
  const { id } = ref;
  if (state && !state.found) return null;
  const known = state?.url ? githubPage(state.url) : null;
  switch (ref.kind) {
    case "task":
      // App opens the task on the board (its review, when one is named).
      return {
        open: () => window.dispatchEvent(new CustomEvent("yuzuno:open-task-review", { detail: { taskId: id } })),
      };
    case "job":
      return { open: () => openJobs({ jobId: id }) };
    case "review":
      // Jobs opens one review directly only within its task.
      return state?.taskId
        ? { open: () => openJobs({ source: "reviews", taskId: state.taskId, reviewId: id }) }
        : { open: () => openJobs({ source: "reviews", reviewId: id }) };
    case "ci": {
      const href = known ?? githubPage(id);
      return href ? { href } : { open: () => openJobs({ source: "github_actions", runKey: id }) };
    }
    case "pr": {
      const href = known ?? githubPage(id) ?? shortPr(id);
      return href ? { href } : null;
    }
    case "agent":
      return brief.onOpenAgent ? { open: () => brief.onOpenAgent!(id) } : null;
    case "machine":
      return brief.onOpenMachine ? { open: () => brief.onOpenMachine!(id) } : null;
    default:
      return null;
  }
}

function Chip({ item }: { item: LiveRef }) {
  const time = useTimeDisplay();
  const t = useStrings(briefText);
  const brief = useBrief();
  const kind = kinds[item.kind];
  if (!kind) return null;
  const Icon = kind.icon;
  // Older Cores send no current state; the chip then shows what the Agent wrote.
  const state = (brief.section.refs as Section["refs"] | undefined)?.[`${item.kind}:${item.id}`];
  const target = opening(item, brief, state);
  // The Agent's short label leads; the current title is in the tooltip and
  // read out after it (T-173). Without a label, the current title shows.
  const name = item.label || state?.title || item.id;
  const full = item.label && state?.title && state.title !== item.label ? state.title : null;
  const title = `${t.refKind[item.kind]} ${item.id}${full ? `: ${full}` : ""}${state?.observedAt ? t.refAsOf(formatTime(state.observedAt, time)) : ""}`;
  const content = (
    <>
      <Icon size={13} aria-hidden="true" />
      <span>{name}</span>
      {full && <span className="sr-only">: {full}</span>}
      {name !== item.id && <small>{item.id}</small>}
      {state && !state.found ? (
        // Core said it couldn't read the item (T-9): not the same as not found.
        <em className="brief-ref-state" data-tone="missing">
          {state.unavailable ? t.refUnavailable : t.notFound}
        </em>
      ) : (
        state?.state && (
          <em className="brief-ref-state" data-tone={state.tone || "neutral"}>
            {state.state}
          </em>
        )
      )}
    </>
  );
  const attributes = {
    className: "brief-ref",
    "data-kind": item.kind,
    "data-tone": state ? (state.found ? state.tone || "neutral" : "missing") : undefined,
  };
  if (target && "href" in target)
    return (
      <a {...attributes} href={target.href} target="_blank" rel="noopener noreferrer" title={title}>
        {content}
        <ArrowUpRight size={11} aria-hidden="true" />
      </a>
    );
  if (target)
    return (
      <button type="button" {...attributes} title={t.open(title)} onClick={target.open}>
        {content}
      </button>
    );
  return (
    <span {...attributes} title={title}>
      {content}
    </span>
  );
}

/** What Core says of one item now, as a list row shows it; a change in it
 * is a change the reader is told about. */
const factsOf = (state: LiveRefState | undefined) =>
  state ? JSON.stringify([state.found, state.unavailable, state.title, state.state, state.assignee?.id, state.updatedAt, state.archived]) : "";

/**
 * One item as a row of a list the Agent ordered (T-9): Core's title and
 * state lead; a task says who is responsible for it at either density, and,
 * shown in full, when the task itself last changed and the Agent's note,
 * marked as the Agent's. A task's state and assignee are the task record,
 * not what an Agent is doing now. A row Core's latest read changed carries a
 * quiet mark until a later read finds it unchanged; nothing flashes.
 * Opening it does what the chip does.
 */
function Row({ item, stale, readAt }: { item: LiveRef; stale: boolean; readAt: string | null }) {
  const time = useTimeDisplay();
  const language = useLanguage();
  const t = briefText(language);
  const density = useBriefDensity();
  const brief = useBrief();
  const state = (brief.section.refs as Section["refs"] | undefined)?.[`${item.kind}:${item.id}`];
  const facts = factsOf(state);
  const seen = useRef({ facts, readAt });
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    const before = seen.current;
    seen.current = { facts, readAt };
    if (before.facts !== facts) setChanged(true);
    else if (before.readAt !== readAt) setChanged(false);
  }, [facts, readAt]);
  const kind = kinds[item.kind];
  if (!kind) return null;
  const Icon = kind.icon;
  const target = opening(item, brief, state);
  const missing = !!state && !state.found;
  const name = (state?.found && state.title) || item.label || item.id;
  // A task's state in the board's own words; others as Core reports them.
  const word = state?.state
    ? item.kind === "task" ? (boardText(language).statuses as Record<string, string>)[state.state] ?? state.state : state.state
    : null;
  const tone = state ? (state.found ? state.tone || "neutral" : "missing") : undefined;
  const lead = (
    <>
      <Icon size={13} aria-hidden="true" />
      <small>{item.id}</small>
      <span className="brief-ref-row-title" lang={state?.found && state.title ? "" : undefined}>{name}</span>
    </>
  );
  const title = `${t.refKind[item.kind]} ${item.id}${state?.found && state.title ? `: ${state.title}` : ""}`;
  const opener: ReactNode = target && "href" in target ? (
    <a className="brief-ref-row-open" href={target.href} target="_blank" rel="noopener noreferrer" title={title}>
      {lead}
      <ArrowUpRight size={11} aria-hidden="true" />
    </a>
  ) : target ? (
    <button type="button" className="brief-ref-row-open" title={t.open(title)} onClick={target.open}>
      {lead}
    </button>
  ) : (
    <span className="brief-ref-row-open" title={title}>
      {lead}
    </span>
  );
  // Who is responsible: the task record's assignee, at either density.
  const responsible = state?.found && item.kind === "task" ? (
    <span className="brief-ref-row-who">
      <UserRound size={12} aria-hidden="true" />
      {state.assignee ? (
        <>
          {t.refAssignee}
          <span lang="">{state.assignee.name}</span>
        </>
      ) : (
        t.refUnassigned
      )}
    </span>
  ) : null;
  const meta: ReactNode[] = [];
  if (density === "high" && state?.found && item.kind === "task" && state.updatedAt)
    meta.push(<span key="when">{t.refTaskUpdated(formatTime(state.updatedAt, time))}</span>);
  if (density === "high" && state?.observedAt) meta.push(<span key="seen">{t.refObserved(formatTime(state.observedAt, time))}</span>);
  if (density === "high" && item.note)
    meta.push(
      <span key="note" className="brief-ref-row-note">
        <span className="brief-ref-row-note-by">{t.refNoteBy(brief.section.owner.name)}</span>
        <span lang="">{item.note}</span>
      </span>,
    );
  return (
    <li className="brief-ref-row" data-kind={item.kind} data-tone={tone} data-changed={changed || undefined} data-stale={stale || undefined}>
      <div className="brief-ref-row-main">
        {opener}
        {missing ? (
          <em className="brief-ref-state" data-tone="missing">{state!.unavailable ? t.refUnavailable : t.notFound}</em>
        ) : (
          word && <em className="brief-ref-state" data-tone={tone}>{word}{state?.archived ? ` · ${t.refArchived}` : ""}</em>
        )}
        {responsible}
        {changed && <span className="brief-ref-row-changed">{t.refChanged}</span>}
      </div>
      {meta.length > 0 && <div className="brief-ref-row-meta">{meta}</div>}
    </li>
  );
}

/** A list of references in the Agent's order (layout list). It says when
 * Core's facts in it were read, apart from when each task changed; when
 * Home's latest read failed, it keeps the last facts and says they are out
 * of date. */
function RefList({ items }: { items: LiveRef[] }) {
  const t = useStrings(briefText);
  const time = useTimeDisplay();
  const read = useHomeRead();
  const density = useBriefDensity();
  const stale = !!read?.failed;
  const readAt = read?.at ?? null;
  return (
    <div className="brief-ref-list-block" data-density={density}>
      {stale && (
        <p className="brief-ref-list-stale" role="note">
          {readAt ? t.refNotCurrent(formatTime(readAt, time)) : t.refNotRead}
        </p>
      )}
      <ol className="brief-ref-list" aria-label={t.references}>
        {items.map((item, index) => (
          <Row key={`${item.kind}:${item.id}:${index}`} item={item} stale={stale} readAt={readAt} />
        ))}
      </ol>
      {readAt && !stale && <p className="brief-ref-list-read">{t.refReadAt(formatTime(readAt, time))}</p>}
    </div>
  );
}

export function BriefLiveRefs({ items, layout }: LiveRefsProps) {
  const t = useStrings(briefText);
  if (layout === "list") return <RefList items={items} />;
  return (
    <ul className="brief-refs" aria-label={t.references}>
      {items.map((item, index) => (
        <li key={`${item.kind}:${item.id}:${index}`}>
          <Chip item={item} />
        </li>
      ))}
    </ul>
  );
}
