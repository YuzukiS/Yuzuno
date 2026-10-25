import {
  ArrowUpRight,
  Bot,
  ClipboardList,
  Cpu,
  GitPullRequest,
  ScanSearch,
  Server,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { openJobs } from "../../Jobs";
import { sourceTarget } from "../../intelligent-ui/contract.ts";
import { useBrief, type BriefContextValue } from "./BriefContext";
import type { LiveRefState, Section } from "../types";
import { formatTime, type LiveRef, type LiveRefKind, type LiveRefsProps } from "./brief-catalog";
import { useTimeDisplay } from "../../time-preferences";

const kinds: Record<LiveRefKind, { label: string; icon: LucideIcon }> = {
  task: { label: "Task", icon: ClipboardList },
  pr: { label: "Pull request", icon: GitPullRequest },
  ci: { label: "CI run", icon: Workflow },
  job: { label: "Job", icon: Cpu },
  review: { label: "Review", icon: ScanSearch },
  agent: { label: "Agent", icon: Bot },
  machine: { label: "Machine", icon: Server },
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
  const title = `${kind.label} ${item.id}${full ? `: ${full}` : ""}${state?.observedAt ? ` · as of ${formatTime(state.observedAt, time)}` : ""}`;
  const content = (
    <>
      <Icon size={13} aria-hidden="true" />
      <span>{name}</span>
      {full && <span className="sr-only">: {full}</span>}
      {name !== item.id && <small>{item.id}</small>}
      {state && !state.found ? (
        <em className="brief-ref-state" data-tone="missing">
          not found
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
      <button type="button" {...attributes} title={`Open ${title}`} onClick={target.open}>
        {content}
      </button>
    );
  return (
    <span {...attributes} title={title}>
      {content}
    </span>
  );
}

export function BriefLiveRefs({ items }: LiveRefsProps) {
  return (
    <ul className="brief-refs" aria-label="References">
      {items.map((item, index) => (
        <li key={`${item.kind}:${item.id}:${index}`}>
          <Chip item={item} />
        </li>
      ))}
    </ul>
  );
}
