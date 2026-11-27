import { useRef, useState, type CSSProperties } from "react";
import { ChevronRight, Eye, LoaderCircle, MessageSquareReply } from "lucide-react";
import { errorText } from "../api";
import { strings, useLanguage } from "../i18n";
import { projectColour } from "../project-groups";
import { Tip, TipText } from "../Tip";
import { changedSinceSeen, readBefore, sectionDomId, unreadChange } from "./brief-layout";
import { CardReply, cardReplySlot, hasCardReply } from "./CardReply";
import { homeText } from "./home-text";
import { sectionSummary } from "./card-summary";
import type { InstalledFacts } from "./ProjectTalk";
import { useReportOpen } from "./report/report-open";
import { authorOf, forYouTodo, HEAD_CHANGES, splitLead, type BlockGroup, type HeadChange } from "./request-blocks";
import { ProjectDeck, When, type BlockCommon } from "./RequestBlocks";
import { RelatedRequests } from "./RequestProgress";
import { DataAsOf } from "./SectionCard";
import { MoreActions } from "./SummaryCard";
import type { Section } from "./types";

/** The Project's head (YN-237 ①), in English and Simplified Chinese. */
export const headText = strings(
  {
    label: "Across requests",
    running: (version: string) => `Running ${version}`,
    waitingRelease: (n: number) => `${n} merged ${n === 1 ? "PR waits" : "PRs wait"} for the next release`,
    needs: (n: number) => `${n} for you to decide`,
    doing: (n: number) => `${n} in progress`,
    done: "Done",
    groupLabel: (group: string) => `Show ${group}`,
    changes: "Changed since you last read",
    asks: (text: string) => `Waiting for you: ${text}`,
    moreChanges: (n: number) => `${n} more ${n === 1 ? "request" : "requests"} changed`,
    asOf: "as of",
    expired: "past its validity",
    whole: "Full text",
    wholeLabel: (title: string) => `Open “${title}”`,
    forYou: (n: number, title: string | null) => `${n} for you${title ? ` · ${title}` : ""}`,
    others: "Other",
    othersNote: "Cards of no request",
    newMark: "New",
  },
  {
    label: "跨请求",
    running: (version) => `运行 ${version}`,
    waitingRelease: (n) => `${n} 个已合入 PR 等下一版`,
    needs: (n) => `${n} 等你决定`,
    doing: (n) => `${n} 进行中`,
    done: "已完成",
    groupLabel: (group) => `查看「${group}」`,
    changes: "自上次查看以来的变化",
    asks: (text) => `等你决定：${text}`,
    moreChanges: (n) => `另 ${n} 个请求有变化`,
    asOf: "截至",
    expired: "已过有效期",
    whole: "全文",
    wholeLabel: (title) => `打开「${title}」`,
    forYou: (n, title) => `${n} 项待你${title ? ` · ${title}` : ""}`,
    others: "其他",
    othersNote: "不属于任何请求的卡",
    newMark: "新",
  },
);

/**
 * The Project's head, above its requests (YN-237 ①, the approved design's "项目顶部合成一个入口"): only what is across
 * requests. Its first line is the release this Core runs, how many merged PRs wait for the next one, and how many
 * requests need the user, are in progress and are done, each a way to its group. Then what changed in each request
 * since the user last read it, each a way to its block; then the lead's one line across requests (its card's first
 * sentence, as of when, its page one step away), with what its author asks of the user (`summary.forYou`) and the
 * requests its common items serve; then "Other", one row folded: the Project's cards that belong to no request, opened
 * as its deck of cards (their Reply, Seen and Pin), its Asks answered before this visit among them as their answer
 * cards; nothing is drawn while it is folded. With no change and no line from the lead, it is its first line alone.
 * The lead's card keeps its id on its line, so a jump to it lands there; a jump to another opens "Other".
 */
export function ProjectHead({ line, others, installed, counts, changes, related, onShowBlock, onGroup, othersOpen, onOthers, common }: {
  /** The lead's card across requests (projectLine), or none. */
  line: Section | null;
  /** The Project's cards of no request besides it, and its Asks answered before this visit. */
  others: readonly Section[];
  installed: InstalledFacts | null;
  counts: Record<BlockGroup, number>;
  changes: readonly HeadChange[];
  /** The requests its common items serve (R-38 §2.4), by the tasks its LiveRefs name. */
  related: readonly { task: string; n: number }[];
  onShowBlock: (n: number) => void;
  /** Shows a group of requests, opened. */
  onGroup: (group: BlockGroup) => void;
  /** Whether "Other" is open: the user's, or a jump's to one of its cards. */
  othersOpen: boolean;
  onOthers: (open: boolean) => void;
  common: BlockCommon;
}) {
  const language = useLanguage();
  const t = headText(language);
  const { projectId } = common;
  const release = installed?.release ?? null;
  const shown = changes.slice(0, HEAD_CHANGES);
  const unread = others.some(changedSinceSeen);
  return (
    <section className="project-head" aria-label={t.label} style={{ "--project-colour": projectColour(projectId) } as CSSProperties}>
      <p className="project-head-facts">
        {release && (
          <Tip content={<TipText title={`${release.releaseId} · ${release.gitSha.slice(0, 12)}`} />} describe={false}>
            <span className="project-head-release">{t.running(release.version || release.releaseId)}</span>
          </Tip>
        )}
        {installed?.mergedAfter ? <span className="project-head-pending">{t.waitingRelease(installed.mergedAfter)}</span> : null}
        <span className="project-head-counts">
          {counts.needs > 0 && (
            <button type="button" className="home-chip is-attention" data-group="needs" onClick={() => onGroup("needs")}>{t.needs(counts.needs)}</button>
          )}
          {counts.doing > 0 && (
            <button type="button" className="home-chip" data-group="doing" onClick={() => onGroup("doing")}>{t.doing(counts.doing)}</button>
          )}
          {counts.done > 0 && (
            <button type="button" className="home-chip is-quiet" data-group="done" onClick={() => onGroup("done")}>
              {t.done} <ChevronRight size={11} aria-hidden="true" />
            </button>
          )}
        </span>
      </p>
      {shown.length > 0 && (
        <ul className="project-head-changes" aria-label={t.changes}>
          {shown.map((change) => (
            <li key={change.n}>
              <button type="button" className="project-head-change" data-change={change.kind} onClick={() => onShowBlock(change.n)}>
                <span className="request-block-n">R-{change.n}</span>
                <span className="project-head-change-text">{change.kind === "ask" ? t.asks(change.text) : change.text}</span>
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
          {changes.length > shown.length && <li className="project-head-more">{t.moreChanges(changes.length - shown.length)}</li>}
        </ul>
      )}
      {line && <LeadLine line={line} related={related} onShowBlock={onShowBlock} common={common} />}
      {others.length > 0 && (
        <details className="project-head-others request-group project-cards" data-group="project" data-project-block="" data-block-key="project"
          data-open={othersOpen ? "" : undefined}
          open={othersOpen} onToggle={(event) => onOthers(event.currentTarget.open)}>
          <summary>
            {t.others} <span className="project-head-count">{others.length}</span>
            {unread && <span className="home-chip is-new">{t.newMark}</span>}
            <small className="request-group-note">{t.othersNote}</small>
          </summary>
          {othersOpen && <ProjectDeck sections={others} common={common} />}
        </details>
      )}
    </section>
  );
}

/**
 * The lead's one line across requests (YN-237 ①): who wrote it, its card's first sentence, as of when (past its
 * validity in the attention colour), and the card's page one step away; and, as the banner had them (the lead's call on
 * YN-218, seq 12072), the card's own New or Updated, Reply (its draft and recipient, CardReply), Seen and More actions
 * (Pin, Copy report), withheld on a read-only Home. Its id is the card's, so a link, a jump or a reply's "Open on Home"
 * lands here with its note. What its author names forYou, and the requests its common items serve, under it.
 */
function LeadLine({ line, related, onShowBlock, common }: {
  line: Section; related: readonly { task: string; n: number }[]; onShowBlock: (n: number) => void; common: BlockCommon;
}) {
  const { projectId, workspaceId, agents, readOnly } = common;
  const language = useLanguage();
  const t = headText(language);
  const home = homeText(language);
  const openReport = useReportOpen();
  const lead = splitLead(sectionSummary(line))?.head || line.title;
  const todo = forYouTodo(line);
  const stale = !!line.status?.stale;
  const changed = line.historyReason !== "archived" && unreadChange(line);
  const [replying, setReplying] = useState(() => hasCardReply(cardReplySlot(workspaceId, projectId, line.key)));
  const [replyOpened, setReplyOpened] = useState(false);
  const replyButton = useRef<HTMLButtonElement>(null);
  const [seeing, setSeeing] = useState(false);
  const [error, setError] = useState("");
  async function seen() {
    setSeeing(true);
    setError("");
    try {
      await common.onSeen([{ key: line.key, version: line.version }]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSeeing(false);
    }
  }
  return (
    <div className={`project-head-lead${stale ? " is-stale" : ""}`} id={sectionDomId(projectId, line.key)} data-now-key={line.key} tabIndex={-1}>
      {common.notice?.(line)}
      <p className="project-head-line">
        <span className="project-head-who">{authorOf(line)}</span>
        <span className="project-head-said">{lead}</span>
        <span className="project-head-meta">
          {/* As its card says it (SummaryCard): when its data is from, and past its validity. */}
          {line.status ? <DataAsOf status={line.status} stale={stale} /> : <>{t.asOf} <When at={line.updatedAt} /></>}
        </span>
        {changed && (
          <Tip content={<TipText body={home.changedTitle} />}>
            <span className="home-changed">{readBefore(line) ? home.updated : home.new}</span>
          </Tip>
        )}
        <span className="project-head-actions">
          {!readOnly && (
            <Tip content={<TipText title={home.replyTitle(line.owner.name)} />} describe={false}>
              <button type="button" className="icon-button home-reply-open" ref={replyButton} aria-expanded={replying}
                aria-label={home.replyLabel(line.title)} onClick={() => {
                  setReplyOpened(true);
                  setReplying((value) => !value);
                }}>
                <MessageSquareReply size={14} />
              </button>
            </Tip>
          )}
          {changedSinceSeen(line) && !readOnly && (
            <Tip content={<TipText title={home.seen} />} describe={false}>
              <button type="button" className="icon-button home-seen" disabled={seeing} aria-label={home.seenLabel(line.title)} onClick={() => void seen()}>
                {seeing ? <LoaderCircle size={14} className="spin" /> : <Eye size={14} />}
              </button>
            </Tip>
          )}
          <MoreActions section={line} projectId={projectId} readOnly={readOnly} />
          {openReport && (
            <button type="button" className="request-look-step home-report-open" data-step="lead" aria-label={t.wholeLabel(line.title)}
              onClick={(event) => openReport(projectId, line, event.currentTarget)}>
              {t.whole}
              <ChevronRight size={12} aria-hidden="true" />
            </button>
          )}
        </span>
      </p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {todo && (
        <p className="project-head-todo">
          <span className="now-todo-count">{todo.open}</span>
          {t.forYou(todo.open, todo.title)}
          {todo.items.slice(0, 2).map((item) => <span key={item.id} className="project-head-todo-item">{item.text}</span>)}
        </p>
      )}
      <RelatedRequests related={related} onShowBlock={onShowBlock} />
      {!readOnly && replying && (
        <div className="project-head-reply">
          <CardReply
            section={line}
            projectId={projectId}
            workspaceId={workspaceId}
            agents={agents}
            opened={replyOpened}
            onClose={() => {
              replyButton.current?.focus();
              setReplying(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
