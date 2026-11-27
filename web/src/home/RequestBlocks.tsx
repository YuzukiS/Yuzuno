import { useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleCheck, CircleDot, Hourglass, LoaderCircle, MessageSquare, PackageCheck, Reply, Send, TriangleAlert } from "lucide-react";
import { strings, useLanguage } from "../i18n";
import { MessageContent } from "../MessageContent";
import { Tip, TipText } from "../Tip";
import { settleWhenLanded } from "../settle";
import { useTimeDisplay } from "../time-preferences";
import type { Agent } from "../types";
import { changedSinceSeen, requestDomId } from "./brief-layout";
import { openTask } from "./CardResponsible";
import { CardAgents } from "./card-responsible";
import { DeckSizes } from "./card-sizes";
import { absolute, relative } from "./format";
import type { SeenMark } from "./home-api";
import { homeText } from "./home-text";
import { scrollWithinHome } from "./HomeJumps";
import { conversation, untitledHint } from "./project-talk";
import type { ProjectRequest } from "./project-talk-api";
import { DeliverableLine, type OpenDeliveredReport } from "./DeliverableLine";
import { deckCard, deckItems, useDeckPacking } from "./deck-packing";
import { talkText } from "./talk-text";
import {
  authorOf, openAsk, type BlockAction, type BlockFact, type BlockFollowUp, type BlockGroup, type LookResult, type ProjectBlock, type RequestBlock, type TaskRow,
  type Who,
} from "./request-blocks";
import { SectionCard } from "./SectionCard";
import { withoutFormIds } from "./AskReply";
import { HistoryBodyState } from "./HistoryBodyState";
import { SummaryCard } from "./SummaryCard";
import {
  DetailLists, EvidenceList, FollowUpZone, NextLine, NowLine, ProgressBar, ProjectWord, StaleLine, StateMark, progressText, useFollowUpName,
} from "./RequestProgress";
import { LookLines, RelatedLine, lookText } from "./RequestLook";
import type { Section } from "./types";
import "./project-talk.css";
import "./request-blocks.css";

/** A Project's page by request (YN-212 §3), in English and Simplified Chinese. */
export const blockText = strings(
  {
    groups: { needs: "Needs you", doing: "In progress", done: "Done" } as Record<BlockGroup, string>,
    views: "Show",
    requestsTab: "Requests",
    chatTab: "Conversation",
    project: "Project",
    projectCards: "Project cards",
    projectNote: "Not part of a request",
    nowLabel: "Where the project stands",
    now: "Now",
    nowStale: "Past its validity",
    nowOpen: (title: string | null) => `for you${title ? ` · ${title}` : ""}`,
    nowMore: (n: number) => `${n} more · on the status page`,
    nowCards: (n: number) => `Project cards ${n}`,
    untitled: (hint: string) => `Waiting for a title · ${hint}`,
    newMark: "New",
    actions: { answer: "Answer", resend: "Send again", confirm: "Confirm done", follow: "Follow up" } as Record<BlockAction, string>,
    /** Beside Confirm done (R-30): not done enough, add to the same request. */
    followOn: "Follow up",
    actionLabel: (action: string, n: number) => `${action}: R-${n}`,
    /** The foot's way to the block's cards view (R-45 §3.4), and its tab. */
    tasks: (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`,
    cardsTab: "Cards and deliverables",
    /** YN-237 ②: the unfolded block's first view, and what it holds under one Details. */
    progressTab: "Progress and results",
    proposal: "On “new”, Core opens this request:",
    opened: (title: string) => `What goes on in “${title}”`,
    details: "Details",
    decisions: "Your decisions",
    card: "Card",
    openCard: (title: string) => `Open the card “${title}”`,
    taskState: (status: string, archived: boolean) =>
      archived ? "archived" : ({ todo: "not started", doing: "in progress", blocked: "blocked", review: "in review", done: "done", cancelled: "cancelled" } as
        Record<string, string>)[status] ?? status,
    blockViews: (title: string) => `What “${title}” shows`,
    less: "Fold",
    fact: {
      unconfirmed: "Not confirmed delivered",
      ask: (title: string, n: number) => `Waiting for you: ${title}${n > 1 ? ` (+${n - 1} more)` : ""}`,
      askElsewhere: (title: string, n: number, home: number) => `Waiting for you under R-${home}: ${title}${n > 1 ? ` (+${n - 1} more)` : ""}`,
      result: (task: string, done: boolean, n: number) => `${task} ${done ? "is done · " : ""}delivered ${n} ${n === 1 ? "item" : "items"}`,
      going: (n: number) => ` · ${n} more in progress`,
      ended: (task: string, cancelled: boolean) => `${task} ${cancelled ? "was cancelled" : "ended"} with nothing to open`,
      answered: (text: string) => `The project answered: ${text}`,
      replied: (reply: string) => `You replied “${reply}”`,
      repliedNext: (who: string) => `${who} acts on it next`,
      taken: (who: string) => `${who} has taken your reply`,
      working: (who: string) => `With ${who}`,
      waiting: "Delivered · the project is looking at it",
      stale: "Card past its validity",
      by: (name: string) => `by ${name}`,
      settle: { waiting: "Waiting for you to confirm", confirmed: "Confirmed by you" } as Record<Settle, string>,
    },
    alsoFor: (ns: number[]) => `Also for ${ns.map((n) => `R-${n}`).join(", ")}`,
    joined: (task: string, title: string, home: number) => `Joined ${task} “${title}” · its card is under R-${home}`,
    asks: (title: string) => `Questions for you in “${title}”`,
    show: "Show →",
    noCardYet: (who: string) => `No card yet · with ${who}`,
    cardGone: "Its card is no longer on Home",
    earlier: (n: number) => `Earlier ${n === 1 ? "card" : "cards"} ${n}`,
    beforeReply: "Written before your reply",
    versions: (n: number) => `Earlier ${n === 1 ? "version" : "versions"} ${n}`,
    version: (version: number) => `Version ${version}`,
    openVersion: (title: string, version: number) => `Open version ${version} of “${title}”`,
    answeredAsk: (title: string, reply: string) => `Answered: ${title} → ${reply}`,
    thread: (n: number) => `Conversation ${n}`,
    you: "You",
    proposed: (n: number) => `The proposal from R-${n}, which you made a request`,
    followUp: (n: number) => `Your follow-up #${n}`,
    projectSaid: "Project",
    /** What each line of the conversation is, as to the follow-ups (R-45 §3.4); who, only in a tip. */
    tag: {
      delivered: "Delivered",
      waiting: "Waiting for a reply",
      answered: "Replied ↓",
      unsent: "Not confirmed delivered",
      failed: "Not delivered",
      answers: (ns: number[]) => `Replies to ${ns.map((n) => `#${n}`).join(", ")}`,
      unlinked: "Later note",
      core: "Core's record · not a reply",
    },
    line: { ask: (title: string) => `Asked: ${title}`, done: (title: string) => `Done: ${title}` },
    delivered: (title: string) => `What “${title}” delivered`,
    olderRequests: "Read older requests",
    needsNone: "Needs you · none",
    needsUnknown: "Needs you · requests could not be read",
  },
  {
    groups: { needs: "等你", doing: "进行中", done: "已完成" },
    views: "显示",
    requestsTab: "请求",
    chatTab: "对话",
    project: "项目",
    projectCards: "项目卡",
    projectNote: "不属于任何请求",
    nowLabel: "项目近况",
    now: "近况",
    nowStale: "已过有效期",
    nowOpen: (title) => `项待你${title ? ` · ${title}` : ""}`,
    nowMore: (n) => `另 ${n} 项 · 在状态页`,
    nowCards: (n) => `项目卡 ${n}`,
    untitled: (hint) => `等待标题 · ${hint}`,
    newMark: "新",
    actions: { answer: "回答", resend: "再发一次", confirm: "确认完成", follow: "追问" },
    followOn: "继续跟进",
    actionLabel: (action, n) => `${action}：R-${n}`,
    tasks: (n) => `${n} 个任务`,
    cardsTab: "卡片与交付",
    progressTab: "进展与结果",
    proposal: "选「新建」时，Core 会新建这个请求：",
    opened: (title) => `「${title}」的进展`,
    details: "详情",
    decisions: "你的决定",
    card: "卡片",
    openCard: (title) => `打开卡片「${title}」`,
    taskState: (status, archived) =>
      archived ? "已归档" : ({ todo: "未开始", doing: "进行中", blocked: "受阻", review: "待审", done: "已完成", cancelled: "已取消" } as Record<string, string>)[status]
        ?? status,
    blockViews: (title) => `「${title}」显示的内容`,
    less: "收起",
    fact: {
      unconfirmed: "没确认送达",
      ask: (title, n) => `等你决定：${title}${n > 1 ? `（另 ${n - 1} 项）` : ""}`,
      askElsewhere: (title, n, home) => `在 R-${home} 下等你决定：${title}${n > 1 ? `（另 ${n - 1} 项）` : ""}`,
      result: (task, done, n) => `${task} ${done ? "已完成 · " : ""}交付 ${n} 项`,
      going: (n) => ` · 另 ${n} 项进行中`,
      ended: (task, cancelled) => `${task} 已${cancelled ? "取消" : "结束"}，没有可打开的结果`,
      answered: (text) => `项目答复：${text}`,
      replied: (reply) => `你已答复「${reply}」`,
      repliedNext: (who) => `等 ${who} 接着做`,
      taken: (who) => `${who} 已接手你的答复`,
      working: (who) => `交给 ${who}`,
      waiting: "已送达 · 项目在看",
      stale: "卡片已过有效期",
      by: (name) => `${name} 写`,
      settle: { waiting: "等你确认", confirmed: "你已确认" },
    },
    alsoFor: (ns) => `也服务于 ${ns.map((n) => `R-${n}`).join("、")}`,
    joined: (task, title, home) => `并入 ${task}「${title}」· 卡片在 R-${home} 下`,
    asks: (title) => `「${title}」里等你回答的问题`,
    show: "查看 →",
    noCardYet: (who) => `还没有卡 · 交给 ${who}`,
    cardGone: "卡片已不在 Home",
    earlier: (n) => `更早的卡 ${n}`,
    beforeReply: "写于你答复之前",
    versions: (n) => `旧版本 ${n}`,
    version: (version) => `第 ${version} 版`,
    openVersion: (title, version) => `打开「${title}」第 ${version} 版`,
    answeredAsk: (title, reply) => `已答：${title} → ${reply}`,
    thread: (n) => `对话 ${n}`,
    you: "你",
    proposed: (n) => `R-${n} 的提议，你选了新建`,
    followUp: (n) => `你追问 #${n}`,
    projectSaid: "项目",
    tag: {
      delivered: "已送达",
      waiting: "等回复",
      answered: "已回复 ↓",
      unsent: "没确认送达",
      failed: "送达失败",
      answers: (ns) => `回复追问 ${ns.map((n) => `#${n}`).join("、")}`,
      unlinked: "后续留言",
      core: "Core 记录 · 不是回复",
    },
    line: { ask: (title) => `提问：${title}`, done: (title) => `完成：${title}` },
    delivered: (title) => `「${title}」交付的结果`,
    olderRequests: "读更早的请求",
    needsNone: "等你 · 无",
    needsUnknown: "等你 · 请求暂时读不到",
  },
);

/**
 * Whether the user has settled a request (R-30): delivered and waiting for the user's confirmation, or confirmed by
 * them (YN-184); a task being done is neither.
 */
type Settle = "waiting" | "confirmed";

/** What every block's cards need from the page. */
export type BlockCommon = {
  projectId: string;
  workspaceId: string;
  agents: Agent[];
  readOnly: boolean;
  onSeen: (marks: SeenMark[]) => Promise<void>;
  onChanged: () => void;
  onReport: OpenDeliveredReport;
  /** A note to show in a card (a reply's "Open on Home" landed there, T-9). */
  notice?: (section: Section) => ReactNode;
  /**
   * Whether an Ask is shown in its block's first look (W5): while it is open, and, once the user answered it in
   * this visit, where it was until the next visit. Each Ask is drawn there only, never again in the folded part.
   */
  upFront: (section: Section) => boolean;
  /** The tasks the lead's card names as common items (R-38 §2.4): a request waiting on one points to that card. */
  commonTasks?: ReadonlySet<string>;
  /** Shows the card the project's page leads with, its common items. */
  onShowNow?: () => void;
};

const FACT_ICON: Record<BlockFact["kind"], ReactNode> = {
  unconfirmed: <TriangleAlert size={14} aria-hidden="true" />,
  ask: <MessageSquare size={14} aria-hidden="true" />,
  result: <PackageCheck size={14} aria-hidden="true" />,
  ended: <CircleCheck size={14} aria-hidden="true" />,
  answered: <CircleCheck size={14} aria-hidden="true" />,
  replied: <Reply size={14} aria-hidden="true" />,
  card: <CircleDot size={14} aria-hidden="true" />,
  working: <LoaderCircle size={14} aria-hidden="true" />,
  waiting: <Hourglass size={14} aria-hidden="true" />,
};

/**
 * What a request's block shows unfolded (R-45 §3.4), one view at a time: its cards and what they delivered (R-38's
 * unfolded part, as it was), or its own conversation, unfolded. A request with no task has only its conversation.
 */
export type BlockView = "cards" | "thread";

/**
 * A jump into a request's conversation (R-45 §3.4): the follow-up `reply` it lands on, with the focus, and the other
 * lines it marks with it (`with`, by `threadItem`); `seq` is the jump, so the same one again is another. The marks
 * stay until the block folds or the next jump.
 */
export type ThreadFocus = { reply: number; with?: readonly string[]; seq: number };

/** A line of a request's conversation, as a jump names it: its words, a follow-up by its number, a note by its place. */
export const threadItem = {
  mine: "mine",
  reply: (n: number) => `reply:${n}`,
  /** The front desk's notes are numbered from 1 in the order Core lists them (progress.rs `notes`, by its n). */
  note: (n: number) => `note:${n}`,
  line: (index: number) => `line:${index}`,
};

/** A request's title, else the first of its words while the front desk has given none (§4.1). */
export const requestTitle = (request: ProjectRequest, untitled: (hint: string) => string) =>
  request.title?.trim() || untitled(untitledHint(request.text));

/** A time as the page says it, the exact one in its tip. */
export function When({ at }: { at: string | null | undefined }) {
  const language = useLanguage();
  const time = useTimeDisplay();
  if (!at) return null;
  return (
    <Tip content={<TipText title={absolute(at, time)} />} describe={false}>
      <time dateTime={at}>{relative(at, language)}</time>
    </Tip>
  );
}

/**
 * The fact's line and the line under it (§3.2). A settled request's line under it says so first (R-30): waiting for
 * the user's confirmation, or confirmed by them, then when they confirmed it.
 */
function FactLines({ fact, settle, confirmedAt }: { fact: BlockFact; settle: Settle | null; confirmedAt?: string | null }) {
  const t = blockText(useLanguage());
  const agents = useContext(CardAgents);
  const name = (who: Who | null, fallback: string) => (who ? agents.get(who.agentId)?.name || who.name : "") || fallback;
  let text: ReactNode;
  let meta: ReactNode = null;
  switch (fact.kind) {
    case "unconfirmed":
      text = t.fact.unconfirmed;
      break;
    case "ask":
      text = fact.home === null ? t.fact.ask(fact.title, fact.count) : t.fact.askElsewhere(fact.title, fact.count, fact.home);
      meta = <>{fact.task} · <When at={fact.at} /></>;
      break;
    case "answered":
      text = t.fact.answered(fact.text);
      meta = <When at={fact.at} />;
      break;
    case "result":
      text = <>{t.fact.result(fact.task, fact.ended, fact.count)}{fact.going ? t.fact.going(fact.going) : ""}</>;
      meta = <When at={fact.at} />;
      break;
    case "ended":
      text = t.fact.ended(fact.task, fact.status === "cancelled");
      meta = <When at={fact.at} />;
      break;
    case "waiting":
      text = fact.note ?? t.fact.waiting;
      meta = <When at={fact.at} />;
      break;
    case "replied":
      text = t.fact.replied(fact.reply);
      meta = <>{fact.taken ? t.fact.taken(name(fact.who, fact.task)) : t.fact.repliedNext(name(fact.who, fact.task))} · <When at={fact.at} /></>;
      break;
    case "card":
      // Who wrote it says which task (an executor is named for its task); a lead's card names its task too.
      text = fact.title;
      meta = (
        <>
          {fact.stale && <><span className="request-block-stale">{t.fact.stale}</span> · </>}
          {fact.author.startsWith(`${fact.task} `) ? "" : `${fact.task} · `}
          {t.fact.by(fact.author)} · <When at={fact.at} />
        </>
      );
      break;
    case "working":
      text = t.fact.working(name(fact.who, fact.task));
      meta = <When at={fact.at} />;
      break;
  }
  if (settle) {
    const mark = <span className="request-block-settle" data-confirmation={settle}>{t.fact.settle[settle]}</span>;
    meta = settle === "confirmed" && confirmedAt ? <>{mark} · <When at={confirmedAt} /></> : meta ? <>{mark} · {meta}</> : mark;
  }
  return (
    <p className="request-block-fact-text">
      <span className="request-block-fact-line">{text}</span>
      {meta && <span className="request-block-fact-meta">{meta}</span>}
    </p>
  );
}

/**
 * Whether an Ask is shown in its block's first look (W5, R-20 follow-up): while it is open; and one the page showed
 * open in this visit stays there once answered, the answer in its place (SectionCard's short reply), until the next
 * visit, as a block keeps its group (useHeldBlocks). A new visit starts afresh.
 *
 * Under each key only the newest Ask seen open in this visit is held, by Home's identity for the section, which an
 * answer's new version keeps and a new section under the same key does not (PR 1098 R1, R2): an Ask the Agent
 * resolved and asked again under its key gives way to the new one and is an Answered line again, never a second
 * card beside it. `asks` are every Ask on the page, read first so that this holds whichever block is drawn first.
 * An older Core names no identity: then only a live entry is held, by its key.
 */
export function useAsksUpFront(asks: readonly Section[]) {
  const sizes = useContext(DeckSizes);
  const visit = sizes?.visit ?? 0;
  const shown = useRef({ visit, latest: new Map<string, string>() });
  if (shown.current.visit !== visit) shown.current = { visit, latest: new Map() };
  const { latest } = shown.current;
  const identity = (section: Section) => (section.id === undefined ? `k:${section.key}` : `i:${section.id}`);
  for (const ask of asks) if (openAsk(ask)) latest.set(ask.key, identity(ask));
  return (section: Section) => {
    if (section.kind !== "ask") return false;
    if (openAsk(section)) {
      latest.set(section.key, identity(section));
      return true;
    }
    return latest.get(section.key) === identity(section) && (section.id !== undefined || !section.history);
  };
}

/**
 * An Ask of the task answered before this visit (YN-223): one compact line, the question and the reply; opened, by
 * pointer or keyboard, R-29's answer card in its place, so the question, the answer and the user's words can be read
 * whole when the user comes back to the request. Its card is the answer card whatever it waits for: read only when
 * Home is, and once its owner resolved it (History), when nothing more can be sent from it. One the block's first
 * look shows is never drawn here (useAsksUpFront).
 */
export function AnsweredAsk({ section, common }: { section: Section; common: BlockCommon }) {
  const t = blockText(useLanguage());
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="request-task-answered-ask" data-answered={section.key}>
      <button type="button" className="request-task-answered" aria-expanded={open} aria-controls={id} onClick={() => setOpen((was) => !was)}>
        <ChevronRight size={12} className="chev" aria-hidden="true" />
        <MessageSquare size={12} aria-hidden="true" />
        {/* A form's answers without the line of IDs Core reads them by (YN-213). */}
        <span>{t.answeredAsk(section.ask?.question || section.title, withoutFormIds(section.ask?.replyText ?? "").trim())}</span>
      </button>
      {open && (
        <div id={id} className="request-task-answered-card">
          {/* In Home's history index, its card is read whole as it is opened (YN-221 S2): until then, that it is read. */}
          {section.bodyOmitted ? (
            <HistoryBodyState projectId={common.projectId} section={section} title />
          ) : (
            <SectionCard
              section={section}
              answer
              // Opened from its line, the record of that answer is what the user asked for (YN-230).
              record
              projectId={common.projectId}
              workspaceId={common.workspaceId}
              agents={common.agents}
              readOnly={common.readOnly || section.history || section.ask?.state === "resolved"}
              onSeen={common.onSeen}
              onChanged={common.onChanged}
              notice={common.notice?.(section)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** An Ask as Home draws it, answerable where it stands (W5: the same card the block used to unfold to). */
function AskCard({ section, common }: { section: Section; common: BlockCommon }) {
  if (section.bodyOmitted) return <HistoryBodyState projectId={common.projectId} section={section} title />;
  return (
    <SectionCard
      section={section}
      projectId={common.projectId}
      workspaceId={common.workspaceId}
      agents={common.agents}
      readOnly={common.readOnly || section.history}
      onSeen={common.onSeen}
      onChanged={common.onChanged}
      notice={common.notice?.(section)}
    />
  );
}

/**
 * A lead's proposal of a new request (YN-237 ④), where it was made: what Core opens on "new" (its title and words, as
 * the lead wrote them), then the Ask itself, answered there; once the user chose "new", the request Core opened, one
 * step away. "merge" and "later" open nothing: the answered Ask says which the user chose.
 */
function ProposalAsk({ section, request, common, onShowBlock }: {
  section: Section; request: RequestBlock["request"]; common: BlockCommon; onShowBlock: (n: number) => void;
}) {
  const t = blockText(useLanguage());
  const l = lookText(useLanguage());
  const proposal = section.ask!.proposal!;
  const opened = (request.proposals ?? []).find((link) => link.key === section.key && (link.sectionId === null || link.sectionId === section.id));
  return (
    <div className="request-proposal" data-proposal={section.key}>
      <p className="request-proposal-preview">
        <span className="request-proposal-label">{t.proposal}</span>
        <b>{proposal.title}</b>
        <span className="request-proposal-text">{proposal.text}</span>
      </p>
      <AskCard section={section} common={common} />
      {opened && (
        <p className="request-proposal-opened">
          <button type="button" className="talk-link" data-related={opened.n} onClick={() => onShowBlock(opened.n)}>{l.openedHere(opened.n)}</button>
        </p>
      )}
    </div>
  );
}

/**
 * One request (YN-212 §3.2, YN-237 ②): its number and title, then, folded, four lines that say what goes on now and
 * since when, what needs the user, its newest result and its newest follow-up, each one step from the whole of it
 * (LookLines), and its one action. Unfolded, in place of those lines: its progress bar and next step, what goes on
 * now in full, its Asks (answerable there), its newest result's card and the follow-ups; under one Details, everything
 * else, one level deep: what it has and lacks, its tasks one line each, its PRs and deliverables, the decisions the
 * user made and its earlier cards. Its own conversation is the other view (R-45 §3.4).
 */
export function RequestBlockView({
  block,
  open,
  view = "cards",
  onToggle,
  onView,
  focus = null,
  onShowThread,
  onResendFollowUp,
  resendingFollowUps,
  onAction,
  onShowBlock,
  onDecide,
  busy = false,
  error,
  common,
}: {
  block: RequestBlock;
  open: boolean;
  /** What it shows unfolded; a request with no task shows its conversation whatever this says. */
  view?: BlockView;
  onToggle: () => void;
  /** Unfolds it showing `view`, or shows `view` in it unfolded (its foot, its tabs). */
  onView: (view: BlockView) => void;
  /** The jump that landed in its conversation, whose lines stay marked; none since it folded. */
  focus?: ThreadFocus | null;
  /** Shows request `n`'s conversation, landed on a follow-up (R-45 §3.4): the follow-up line's way there. */
  onShowThread?: (n: number, focus?: Omit<ThreadFocus, "seq">) => void;
  /** Sends the request's follow-up `m` again, as Core keeps it (R-45 §3.2). */
  onResendFollowUp?: (n: number, m: number) => void;
  /** Its follow-ups being sent again, by number. */
  resendingFollowUps?: ReadonlySet<number>;
  /** The block's action; `focusKey` names the Ask an answer goes to. */
  onAction: (action: BlockAction, n: number, focusKey?: string) => void;
  /** A joined task's line: shows the block its card is under. */
  onShowBlock: (n: number) => void;
  /** "Decide": unfolds it and lands on its open Ask `key` (YN-237 ②); without it, the block unfolds. */
  onDecide?: (key: string) => void;
  /** Its action is under way (a confirmation or a send again). */
  busy?: boolean;
  /** Why its action failed last, in Core's words, until the next try. */
  error?: string;
  common: BlockCommon;
}) {
  const language = useLanguage();
  const t = blockText(language);
  const timeDisplay = useTimeDisplay();
  const { request, fact, action } = block;
  const title = requestTitle(request, t.untitled);
  // The lines its conversation view shows, counted once, in its foot (R-45 §3.3).
  const said = conversation([request]).filter((item) => item.kind !== "looking").length;
  const tasks = block.tasks.length + block.joined.length;
  const shown: BlockView = tasks ? view : "thread";
  const viewsId = useId();
  const detailsId = useId();
  const [details, setDetails] = useState(false);
  // The jump its conversation landed last: once each, however often the view is shown again.
  const landed = useRef(0);
  // Its foot's two ways in: each unfolds the block at its view; the one shown folds it again.
  const toView = (to: BlockView) => (open && shown === to ? onToggle() : onView(to));
  const label = action ? t.actions[action] : "";
  const asks = block.asks.filter(common.upFront);
  const { look } = block;
  // Its follow-up not answered yet (R-45 §3.3): not the user's to confirm now, so nothing says it waits for them.
  const settle: Settle | null = action === "confirm" ? (block.state === "followUp" ? null : "waiting") : block.group === "done" ? "confirmed" : null;
  const p = progressText(language);
  // The now line from Core's fact (no status or progress of its tasks says it), unless another line says the same: its
  // own Ask, or its result. Where Core's fact is only whom it went to or a card's title, the front desk's newest reply is
  // what the project said (R-43).
  const factSaid = !(fact.kind === "ask" && fact.home === null) && !(look.result && (fact.kind === "result" || fact.kind === "card"));
  const replyNow = block.reply && (fact.kind === "card" || fact.kind === "working");
  const factLine = replyNow ? <ReplyNow reply={block.reply!} /> : factSaid || settle ? <FactLines fact={fact} settle={settle} confirmedAt={request.confirmedAt} /> : null;
  const follow = action === "follow" && !common.readOnly;
  const decide = (key: string) => (onDecide ? onDecide(key) : open ? undefined : onView("cards"));
  const openResult = (result: LookResult) => {
    const item = result.item;
    if (!item) return;
    if (item.kind === "report") common.onReport({ key: item.key, version: item.currentVersion ?? item.version, sectionId: item.sectionId });
    else if ((item.kind === "pr" || item.kind === "release") && item.url) window.open(item.url, "_blank", "noopener");
  };
  // Unfolded, the result's card, unless it is what goes on now.
  const resultCard = look.result?.section && !(look.now.kind === "status" && look.now.section.key === look.result.section.key) ? look.result.section : null;
  const nowSection = look.now.kind === "status" ? look.now.section : null;
  const nowRow = look.now.kind === "status" ? [...block.tasks, ...block.joined].find((row) => row.task.id === (look.now as { task: string }).task) : undefined;
  const progressRow = look.now.kind === "progress" ? [...block.tasks, ...block.joined].find((row) => row.task.id === (look.now as { task: string }).task) : undefined;
  const answered = [...block.tasks.flatMap((row) => row.asks.filter((a) => a.ask?.state !== "open" && !common.upFront(a)))];
  // The cards drawn whole above Details: their Details lines take no id of theirs, which is the card's.
  const drawn = new Set([nowSection?.key, resultCard?.key].filter((key): key is string => !!key));
  return (
    <article
      className="request-block"
      id={requestDomId(request.id)}
      data-block-key={block.key}
      data-request-block={request.n}
      data-group={block.group}
      data-fact={fact.kind}
      data-open={open ? "" : undefined}
      tabIndex={-1}
    >
      <header className="request-block-head">
        <span className="request-block-n">R-{request.n}</span>
        <button type="button" className="request-block-title" data-untitled={request.title ? undefined : ""} aria-expanded={open} onClick={onToggle}>
          {title}
        </button>
        {block.unread && <span className="request-updated">{p.updated}</span>}
        <StateMark state={block.state} />
        <span className="request-block-time"><When at={request.createdAt} /></span>
      </header>
      {!open && (
        <LookLines
          block={block}
          projectId={common.projectId}
          fact={factLine}
          onDecide={decide}
          onElsewhere={(home, key) => onAction("answer", home, key)}
          onThread={(m, marked) => onShowThread?.(request.n, { reply: m, with: marked })}
          onResult={openResult}
          onShowBlock={onShowBlock}
          onResend={onResendFollowUp ? (m) => onResendFollowUp(request.n, m) : undefined}
          resending={!!(block.follow && resendingFollowUps?.has(block.follow.latest.n))}
          readOnly={common.readOnly}
        />
      )}
      {action && action !== "follow" && !common.readOnly && (
        <div className="request-block-act">
          <span className="request-block-actions">
            <button
              type="button"
              className={`request-block-action${block.state === "followUp" ? "" : " is-primary"}`}
              data-action={action}
              aria-label={t.actionLabel(label, request.n)}
              disabled={busy}
              onClick={() => onAction(action, request.n, fact.kind === "ask" ? fact.key : undefined)}
            >
              {busy ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : null}
              {label}
            </button>
            {/* Not done enough (R-30): the same request's follow-up in the composer; it confirms nothing, and the
                request keeps what it delivered and keeps waiting for the confirmation. */}
            {action === "confirm" && (
              <button
                type="button"
                className="request-block-action"
                data-action="follow"
                aria-label={t.actionLabel(t.followOn, request.n)}
                disabled={busy}
                onClick={() => onAction("follow", request.n)}
              >
                <Send size={12} aria-hidden="true" />
                {t.followOn}
              </button>
            )}
          </span>
          {error && (
            <p className="inline-error request-block-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      {open && (
        <div className="request-block-body" data-view={shown}>
          {tasks > 0 && <ViewTabs id={viewsId} label={t.blockViews(title)} shown={shown} said={said} onView={onView} />}
          <div
            className="request-block-view"
            {...(tasks > 0 ? { role: "tabpanel", id: `${viewsId}-${shown}`, "aria-labelledby": `${viewsId}-${shown}-tab` } : {})}
          >
            {shown === "cards" ? (
              <>
                {block.now?.kind === "bar" ? (
                  <div className="request-block-now">
                    {block.stale && <StaleLine stale={block.stale} />}
                    <NowLine block={block} />
                    {block.next && <NextLine next={block.next} onShowBlock={onShowBlock} common={common} />}
                  </div>
                ) : block.track ? (
                  // No Plan names its outcomes: the bar Core draws from its tasks and PRs (YN-237 ③).
                  <div className="request-block-now" data-track="">
                    <ProgressBar now={block.track} dim={false} />
                    {block.next && <NextLine next={block.next} onShowBlock={onShowBlock} common={common} />}
                  </div>
                ) : null}
                <div className="request-opened" role="group" aria-label={t.opened(title)}>
                  {nowSection ? (
                    <div className="request-task-card" data-task={nowRow?.task.id}>
                      {nowRow?.cardBeforeReply && nowRow.card?.key === nowSection.key && <p className="request-task-before">{t.beforeReply}</p>}
                      <SummaryCard
                        section={nowSection}
                        projectId={common.projectId}
                        workspaceId={common.workspaceId}
                        agents={common.agents}
                        readOnly={common.readOnly || nowSection.history}
                        onSeen={common.onSeen}
                        notice={common.notice?.(nowSection)}
                      />
                      {nowSection.revisions && nowSection.revisions.length > 0 && <CardVersions section={nowSection} onReport={common.onReport} />}
                    </div>
                  ) : progressRow?.task.progress ? (
                    <p className="request-progress">
                      <span className="request-bar-label">{p.progress}</span>
                      <span>{progressRow.task.progress}</span>
                    </p>
                  ) : factLine ? (
                    <div className="request-block-fact">
                      <span className="request-block-fact-icon" data-kind={fact.kind}>{FACT_ICON[fact.kind]}</span>
                      {factLine}
                    </div>
                  ) : null}
                  {asks.length > 0 && (
                    <div className="request-block-asks" role="group" aria-label={t.asks(title)}>
                      {asks.map((ask) => ask.ask?.proposal ? (
                        <ProposalAsk key={ask.key} section={ask} request={request} common={common} onShowBlock={onShowBlock} />
                      ) : (
                        <AskCard key={ask.key} section={ask} common={common} />
                      ))}
                    </div>
                  )}
                  {block.askedElsewhere && (
                    <p className="request-block-joined">
                      <span>{t.fact.askElsewhere(block.askedElsewhere.title, block.askedElsewhere.count, block.askedElsewhere.home)}</span>
                      <button type="button" className="talk-link" onClick={() => onAction("answer", block.askedElsewhere!.home, block.askedElsewhere!.key)}>
                        {t.show}
                      </button>
                    </p>
                  )}
                  {resultCard?.bodyOmitted ? (
                    // In Home's history index (YN-221 S2): read whole where it is shown.
                    <HistoryBodyState projectId={common.projectId} section={resultCard} title />
                  ) : resultCard && (
                    <SummaryCard
                      section={resultCard}
                      projectId={common.projectId}
                      workspaceId={common.workspaceId}
                      agents={common.agents}
                      readOnly={common.readOnly || resultCard.history}
                      onSeen={common.onSeen}
                      notice={common.notice?.(resultCard)}
                    />
                  )}
                  {block.follow && (
                    <FollowUpZone
                      follow={block.follow}
                      front={request.frontAgentId}
                      readOnly={common.readOnly}
                      onShow={(m, marked) => onShowThread?.(request.n, { reply: m, with: marked })}
                      onResend={onResendFollowUp ? (m) => onResendFollowUp(request.n, m) : undefined}
                      resending={!!resendingFollowUps?.has(block.follow.latest.n)}
                    />
                  )}
                </div>
                <button type="button" className="request-block-more request-details-toggle" data-details="" aria-expanded={details} aria-controls={detailsId}
                  onClick={() => setDetails((was) => !was)}>
                  <ChevronDown size={13} aria-hidden="true" />
                  {t.details}
                </button>
                <div id={detailsId} className="request-block-details" hidden={!details}>
                  <DetailLists block={block} />
                  {block.tasks.map((row) => (
                    <TaskLine key={row.task.id} row={row} common={common} drawn={drawn} />
                  ))}
                  {block.joined.map((row) => (
                    <p key={row.task.id} className="request-block-joined">
                      <span>{t.joined(row.task.id, row.title, row.home)}</span>
                      <button type="button" className="talk-link" onClick={() => onShowBlock(row.home)}>
                        {t.show}
                      </button>
                    </p>
                  ))}
                  <EvidenceList block={block} />
                  {block.delivered.length > 0 && (
                    <ul className="request-block-delivered" aria-label={t.delivered(title)}>
                      {block.delivered.flatMap((group) =>
                        group.items.map((item, index) => (
                          <li key={`${group.task}:${index}`} data-task={group.task}>
                            <DeliverableLine
                              item={item}
                              task={group.task}
                              onReport={common.onReport}
                              time={(at) => absolute(at, timeDisplay)}
                              ago={(at) => relative(at, language)}
                            />
                          </li>
                        )),
                      )}
                    </ul>
                  )}
                  <RelatedLine block={block} onShowBlock={onShowBlock} />
                  {answered.length > 0 && (
                    <div className="request-details-decisions" role="group" aria-label={t.decisions}>
                      {answered.map((ask) => <AnsweredAsk key={ask.key} section={ask} common={common} />)}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <RequestThread request={request} follow={block.follow} focus={focus} landed={landed} />
            )}
          </div>
          <button type="button" className="request-block-fold" aria-expanded="true" onClick={onToggle}>
            <ChevronDown size={13} aria-hidden="true" />
            {t.less}
          </button>
        </div>
      )}
      <div className="request-block-foot">
        {follow && (
          <button
            type="button"
            className="request-block-follow"
            data-action="follow"
            aria-label={t.actionLabel(t.actions.follow, request.n)}
            disabled={busy}
            onClick={() => onAction("follow", request.n)}
          >
            {p.followUp}
          </button>
        )}
        {/* R-45 §3.4: its progress and results, and its conversation, each its own way in. */}
        {tasks > 0 && (
          <button type="button" className="request-block-more" data-view="cards" aria-expanded={open && shown === "cards"} onClick={() => toView("cards")}>
            <ChevronDown size={13} aria-hidden="true" />
            {t.progressTab}
          </button>
        )}
        <button type="button" className="request-block-more" data-view="thread" aria-expanded={open && shown === "thread"} onClick={() => toView("thread")}>
          <ChevronDown size={13} aria-hidden="true" />
          {t.thread(said)}
        </button>
      </div>
      {follow && error && (
        <p className="inline-error request-block-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

/** The front desk's newest reply as the now line (R-43): with no word of a task yet, the last the project said. */
function ReplyNow({ reply }: { reply: NonNullable<RequestBlock["reply"]> }) {
  const p = progressText(useLanguage());
  return (
    <p className="request-block-fact-text request-reply">
      <span className="request-block-fact-line request-reply-text">{reply.text}</span>
      <span className="request-block-fact-meta">
        <ProjectWord tip={p.follow.deskTip(reply.by.name)}>{p.follow.projectFirst}</ProjectWord> · <When at={reply.at} />
      </span>
    </p>
  );
}

/**
 * The two views of an unfolded block (R-45 §3.4) as tabs: its progress and results, and its conversation; the arrow
 * keys, Home and End move between them, as a tab list's do.
 */
function ViewTabs({ id, label, shown, said, onView }: {
  id: string; label: string; shown: BlockView; said: number; onView: (view: BlockView) => void;
}) {
  const t = blockText(useLanguage());
  const list = useRef<HTMLDivElement>(null);
  const views: BlockView[] = ["cards", "thread"];
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = views.indexOf(shown);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: views.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = views[(to + views.length) % views.length];
    onView(next);
    list.current?.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus();
  };
  return (
    <div ref={list} className="request-block-tabs" role="tablist" aria-label={label} onKeyDown={move}>
      {views.map((view) => (
        <button
          key={view}
          type="button"
          role="tab"
          id={`${id}-${view}-tab`}
          data-view={view}
          aria-selected={shown === view}
          aria-controls={shown === view ? `${id}-${view}` : undefined}
          tabIndex={shown === view ? 0 : -1}
          onClick={() => onView(view)}
        >
          {view === "cards" ? t.progressTab : t.thread(said)}
        </button>
      ))}
    </div>
  );
}

/**
 * One task of a request, under Details (YN-237 ②): one line of its key, its title, who answers for it and its state,
 * with its task; under it its one card whole (who answers for it, Reply, Reassign), unless that card is drawn above
 * Details already (what goes on now, or the result), then an open Ask not shown above, why it delivered nothing, and
 * its earlier cards, folded. A card in Home's history index is read whole where it shows (YN-221 S2).
 */
function TaskLine({ row, common, drawn }: { row: TaskRow; common: BlockCommon; drawn: ReadonlySet<string> }) {
  const language = useLanguage();
  const t = blockText(language);
  const tt = talkText(language);
  const agents = useContext(CardAgents);
  const who = row.responsible ? agents.get(row.responsible.agentId)?.name || row.responsible.name : null;
  const over = row.task.archived || row.task.status === "done" || row.task.status === "cancelled";
  const open = row.asks.filter((a) => a.ask?.state === "open" && !common.upFront(a));
  const card = row.card && !drawn.has(row.card.key) ? row.card : null;
  const whole = (section: Section) =>
    section.bodyOmitted ? (
      <HistoryBodyState key={section.key} projectId={common.projectId} section={section} title />
    ) : (
      <SummaryCard
        key={section.key}
        section={section}
        projectId={common.projectId}
        workspaceId={common.workspaceId}
        agents={common.agents}
        readOnly={common.readOnly || section.history}
        onSeen={common.onSeen}
        notice={common.notice?.(section)}
      />
    );
  return (
    <section className="request-task" data-task={row.task.id}>
      <p className="request-task-line">
        <span className="request-task-id">{row.task.id}</span>
        <span className="request-task-title">{row.title}</span>
        <span className="request-task-meta">
          {[who, t.taskState(row.task.status, row.task.archived)].filter(Boolean).join(" · ")}
          {row.alsoFor.length > 0 && <> · <span className="request-task-also">{t.alsoFor(row.alsoFor)}</span></>}
        </span>
        <button type="button" className="talk-link" aria-label={tt.openTaskLabel(row.task.id)} onClick={() => openTask(row.task.id)}>
          {tt.openTask}
        </button>
      </p>
      {open.map((ask) => <AskCard key={ask.key} section={ask} common={common} />)}
      {card && (
        <div className="request-task-card">
          {/* Older than the user's newest reply on the task while it goes on: what it says may be past (§3.3). */}
          {row.cardBeforeReply && <p className="request-task-before">{t.beforeReply}</p>}
          {whole(card)}
          {card.revisions && card.revisions.length > 0 && <CardVersions section={card} onReport={common.onReport} />}
        </div>
      )}
      {!row.card && !over && <p className="request-task-none">{t.noCardYet(who ?? row.task.id)}</p>}
      {!row.card && over && !row.nothing && <p className="request-task-none">{t.cardGone}</p>}
      {/* Ended with nothing delivered: why (YN-208). */}
      {row.nothing && <p className="request-deliverables-none"><span>{tt[row.nothing === "cancelled" ? "cancelledNone" : row.nothing]}</span></p>}
      {/* The task's other statuses and reports from before one task had one card (YN-212 §3.3), folded. */}
      {row.earlier.length > 0 && (
        <details className="request-task-earlier">
          <summary>{t.earlier(row.earlier.length)}</summary>
          {row.earlier.filter((section) => !drawn.has(section.key)).map(whole)}
        </details>
      )}
    </section>
  );
}

/**
 * A task's card's earlier versions (YN-212 C2), folded under it: each with who wrote it and when, opened on the
 * report page at that version by the card's identity, as a report link opens.
 */
function CardVersions({ section, onReport }: { section: Section; onReport: OpenDeliveredReport }) {
  const t = blockText(useLanguage());
  const revisions = section.revisions ?? [];
  return (
    <details className="request-task-versions">
      <summary>{t.versions(revisions.length)}</summary>
      <ol>
        {revisions.map((revision) => (
          <li key={revision.version}>
            <button
              type="button"
              className="talk-link"
              aria-label={t.openVersion(section.title, revision.version)}
              onClick={() => onReport({ key: section.key, version: revision.version, ...(typeof section.id === "number" ? { sectionId: section.id } : {}) })}
            >
              {t.version(revision.version)}
            </button>
            <span>{t.fact.by(revision.author.name)}</span>
            <When at={revision.at} />
          </li>
        ))}
      </ol>
    </details>
  );
}

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A conversation line's marks (R-45 §3.4), on a row of their own under its words; nothing without any. */
function Tags({ tags }: { tags: (ReactNode | null)[] | null }) {
  const shown = tags?.filter(Boolean) ?? [];
  return shown.length ? <span className="request-thread-tags">{shown}</span> : null;
}

/**
 * A request's own conversation, oldest first, unfolded in its view (R-45 §3.4): its words, the project's notes,
 * follow-ups and Core's lines. A jump (`focus`) lands once on its follow-up, in the middle of Home's scroller clear of
 * the dock, with the focus; that line and the ones it names stay marked, and flash once as it lands (not under reduced
 * motion). A follow-up it does not have lands on the conversation itself.
 */
function RequestThread({ request, follow, focus, landed }: {
  request: ProjectRequest; follow: BlockFollowUp | null; focus: ThreadFocus | null; landed: MutableRefObject<number>;
}) {
  const language = useLanguage();
  const t = blockText(language);
  const p = progressText(language).follow;
  const nameOf = useFollowUpName();
  const tag = (text: string, kind?: "ok" | "wait" | "link") => <span key={text} className="request-thread-tag" data-tag={kind}>{text}</span>;
  // What each line is, as to the follow-ups (R-45 §3.4): a follow-up's delivery (whom, in its tip) and whether the
  // project replied; a note, which follow-ups it replies to, or a later note naming none; Core's ending after the
  // first follow-up, no reply. Only "the project" speaks; who that was is in its tip.
  const firstFollowUp = Math.min(...request.replies.map((reply) => Date.parse(reply.at)));
  const followTags = (m: number) => {
    const item = follow?.items.find((i) => i.n === m);
    if (!item) return null;
    const delivered = (
      <Tip key="delivered" content={<TipText title={p.toTip(p.list(item.to.map(nameOf)))} />}>
        <span className="request-thread-tag">{t.tag.delivered}</span>
      </Tip>
    );
    return [
      item.state === "unsent" ? tag(item.failed ? t.tag.failed : t.tag.unsent, "wait") : delivered,
      item.state === "waiting" ? tag(t.tag.waiting, "wait") : item.state === "answered" ? tag(t.tag.answered, "ok") : null,
    ];
  };
  const noteTags = (note: ProjectRequest["notes"][number]) =>
    Array.isArray(note.replyTo) && note.replyTo.length ? [tag(t.tag.answers(note.replyTo), "ok")]
      : !Array.isArray(note.replyTo) && Date.parse(note.at) > firstFollowUp ? [tag(t.tag.unlinked, "link")]
        : null;
  const list = useRef<HTMLOListElement>(null);
  const flash = useRef<(() => void) | null>(null);
  const items = conversation([request]).filter((item) => item.kind !== "looking");
  const marked = new Set(focus ? [threadItem.reply(focus.reply), ...(focus.with ?? [])] : []);
  // Each jump lands once; its flash ends with the conversation's view.
  useEffect(() => () => flash.current?.(), []);
  useEffect(() => {
    const ol = list.current;
    if (!focus || !ol || landed.current === focus.seq) return;
    landed.current = focus.seq;
    const target = ol.querySelector<HTMLElement>(`:scope > li[data-reply="${focus.reply}"]`) ?? ol;
    const smooth = !reducedMotion();
    scrollWithinHome(target, "center", smooth);
    target.focus({ preventScroll: true });
    flash.current = settleWhenLanded(ol, "data-flash", smooth, "animation");
  }, [focus, landed]);
  // A note by its place among the request's notes, a line by its place among Core's lines: as Core lists them.
  const keyOf = (item: (typeof items)[number]) =>
    item.kind === "reply" ? threadItem.reply(item.reply.n)
      : item.kind === "note" ? threadItem.note(request.notes.indexOf(item.note) + 1)
        : item.kind === "line" ? threadItem.line(request.lines.indexOf(item.line))
          : threadItem.mine;
  return (
    <ol ref={list} className="request-thread" tabIndex={-1}>
      {items.map((item, index) => {
        const at = new Date(item.at).toISOString();
        const key = keyOf(item);
        const mark = { "data-thread-item": key, "data-focus": marked.has(key) ? "" : undefined };
        switch (item.kind) {
          case "mine":
            // Words a proposal opened (YN-237 ④) are the lead's, which the user chose to make a request: said so, never "You".
            return (
              <li key={index} data-who={request.from ? "proposal" : "you"} {...mark}>
                <b>{request.from ? t.proposed(request.from.n) : t.you}</b>
                <MessageContent text={request.text} blocks={request.textBlocks ?? undefined} />
                <When at={at} />
              </li>
            );
          case "reply":
            return (
              <li key={index} data-who="you" data-reply={item.reply.n} tabIndex={-1} {...mark}>
                <b>{t.followUp(item.reply.n)}</b>
                <MessageContent text={item.reply.text} blocks={item.reply.textBlocks ?? undefined} />
                <When at={at} />
                <Tags tags={followTags(item.reply.n)} />
              </li>
            );
          case "note":
            return (
              <li key={index} data-who="project" data-note={request.notes.indexOf(item.note) + 1} {...mark}>
                <ProjectWord tip={p.deskTip(nameOf(item.note.by))}>{t.projectSaid}</ProjectWord>
                <span>{item.note.note}</span>
                <When at={at} />
                <Tags tags={noteTags(item.note)} />
              </li>
            );
          case "line":
            return (
              <li key={index} data-who="core" {...mark}>
                <span>
                  {item.line.kind === "ask" ? t.line.ask(item.line.title) : t.line.done(item.line.title || item.line.task)}
                  {item.line.kind === "done" && item.at > firstFollowUp && <> {tag(t.tag.core, "link")}</>}
                </span>
                <When at={at} />
              </li>
            );
          default:
            return null;
        }
      })}
    </ol>
  );
}

/**
 * The Project's own open Asks in Needs you (R-27 §3.5): each its own entry, as an approval stands, saying it is the
 * Project's and who asked, answerable there. One answered in this visit stays where it was (useAsksUpFront).
 */
export function ProjectAsks({ block, common }: { block: ProjectBlock; common: BlockCommon }) {
  const language = useLanguage();
  const t = blockText(language);
  const th = homeText(language);
  return block.asks.filter(common.upFront).map((ask) => (
    <div key={ask.key} className="home-approval project-ask" data-project-ask={ask.key}>
      <span className="home-from">
        {t.project} · {th.from(authorOf(ask))}
      </span>
      <AskCard section={ask} common={common} />
    </div>
  ));
}

/** The Project's cards of no request, opened under "Other" in the page's head (YN-237 ①): they keep their authors'
 * sizes and are packed as the Project's deck packed them (YN-3, deck-packing.ts), in a deck of the head's width. An
 * answered Ask is its answer card there. */
export function ProjectDeck({ sections, common }: { sections: readonly Section[]; common: BlockCommon }) {
  const grid = useRef<HTMLDivElement>(null);
  useDeckPacking(grid, deckItems, deckCard);
  return (
    <div className="project-block-cards">
      <div ref={grid} className="home-brief">
        {sections.map((section) =>
          section.kind === "ask" ? (
            <AskCard key={section.key} section={section} common={common} />
          ) : (
            <SummaryCard
              key={section.key}
              section={section}
              projectId={common.projectId}
              workspaceId={common.workspaceId}
              agents={common.agents}
              deck
              readOnly={common.readOnly}
              onSeen={common.onSeen}
              notice={common.notice?.(section)}
            />
          ),
        )}
      </div>
    </div>
  );
}
