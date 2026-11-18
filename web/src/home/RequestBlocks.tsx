import { useContext, type ReactNode } from "react";
import { ChevronDown, CircleCheck, CircleDot, Hourglass, LoaderCircle, MessageSquare, PackageCheck, Reply, Send, TriangleAlert } from "lucide-react";
import { strings, useLanguage } from "../i18n";
import { MessageContent } from "../MessageContent";
import { Tip, TipText } from "../Tip";
import { useTimeDisplay } from "../time-preferences";
import type { Agent } from "../types";
import { requestDomId } from "./brief-layout";
import { CardAgents } from "./card-responsible";
import { absolute, relative } from "./format";
import type { SeenMark } from "./home-api";
import { conversation, untitledHint } from "./project-talk";
import type { ProjectRequest } from "./project-talk-api";
import { DeliverableLine, type OpenDeliveredReport } from "./RequestCard";
import type { BlockAction, BlockFact, BlockGroup, ProjectBlock, RequestBlock, TaskRow, Who } from "./request-blocks";
import { SectionCard } from "./SectionCard";
import { SummaryCard } from "./SummaryCard";
import type { Section } from "./types";
import "./project-talk.css";
import "./request-blocks.css";

/** A Project's page by request (YN-212 §3), in English and Simplified Chinese. */
export const blockText = strings(
  {
    groups: { needs: "Needs you", doing: "In progress", done: "Done" } as Record<BlockGroup, string>,
    views: "Show",
    requestsTab: (n: number) => `Requests ${n}`,
    chatTab: "Conversation",
    project: "Project",
    projectNote: "Not part of a request",
    untitled: (hint: string) => `Waiting for a title · ${hint}`,
    newMark: "New",
    actions: { answer: "Answer", resend: "Send again", confirm: "Confirm done", follow: "Follow up" } as Record<BlockAction, string>,
    actionLabel: (action: string, n: number) => `${action}: R-${n}`,
    more: (tasks: number, said: number) => `${tasks ? `${tasks} ${tasks === 1 ? "task" : "tasks"} · ` : ""}${said} in the conversation`,
    projectMore: (n: number) => `${n} ${n === 1 ? "card" : "cards"}`,
    less: "Fold",
    fact: {
      unconfirmed: "Not confirmed delivered",
      ask: (title: string, n: number) => `Waiting for you: ${title}${n > 1 ? ` (+${n - 1} more)` : ""}`,
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
    },
    alsoFor: (ns: number[]) => `Also for ${ns.map((n) => `R-${n}`).join(", ")}`,
    joined: (task: string, title: string, home: number) => `Joined ${task} “${title}” · its card is under R-${home}`,
    show: "Show →",
    noCardYet: (who: string) => `No card yet · with ${who}`,
    answeredAsk: (title: string, reply: string) => `Answered: ${title} → ${reply}`,
    thread: (n: number) => `Conversation ${n}`,
    you: "You",
    followUp: "Your follow-up",
    projectSaid: "Project",
    line: { ask: (title: string) => `Asked: ${title}`, done: (title: string) => `Done: ${title}` },
    delivered: (title: string) => `What “${title}” delivered`,
  },
  {
    groups: { needs: "等你", doing: "进行中", done: "已完成" },
    views: "显示",
    requestsTab: (n) => `请求 ${n}`,
    chatTab: "对话",
    project: "项目",
    projectNote: "不属于任何请求",
    untitled: (hint) => `等待标题 · ${hint}`,
    newMark: "新",
    actions: { answer: "回答", resend: "再发一次", confirm: "确认完成", follow: "追问" },
    actionLabel: (action, n) => `${action}：R-${n}`,
    more: (tasks, said) => `${tasks ? `${tasks} 个任务 · ` : ""}对话 ${said} 条`,
    projectMore: (n) => `${n} 张卡`,
    less: "收起",
    fact: {
      unconfirmed: "没确认送达",
      ask: (title, n) => `等你决定：${title}${n > 1 ? `（另 ${n - 1} 项）` : ""}`,
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
    },
    alsoFor: (ns) => `也服务于 ${ns.map((n) => `R-${n}`).join("、")}`,
    joined: (task, title, home) => `并入 ${task}「${title}」· 卡片在 R-${home} 下`,
    show: "查看 →",
    noCardYet: (who) => `还没有卡 · 交给 ${who}`,
    answeredAsk: (title, reply) => `已答：${title} → ${reply}`,
    thread: (n) => `对话 ${n}`,
    you: "你",
    followUp: "你追问",
    projectSaid: "项目",
    line: { ask: (title) => `提问：${title}`, done: (title) => `完成：${title}` },
    delivered: (title) => `「${title}」交付的结果`,
  },
);

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

/** A request's title, else the first of its words while the front desk has given none (§4.1). */
export const requestTitle = (request: ProjectRequest, untitled: (hint: string) => string) =>
  request.title?.trim() || untitled(untitledHint(request.text));

/** A time as the page says it, the exact one in its tip. */
function When({ at }: { at: string | null | undefined }) {
  const language = useLanguage();
  const time = useTimeDisplay();
  if (!at) return null;
  return (
    <Tip content={<TipText title={absolute(at, time)} />} describe={false}>
      <time dateTime={at}>{relative(at, language)}</time>
    </Tip>
  );
}

/** The fact's line and the line under it (§3.2). */
function FactLines({ fact }: { fact: BlockFact }) {
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
      text = t.fact.ask(fact.title, fact.count);
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
          {fact.author.startsWith(fact.task) ? "" : `${fact.task} · `}
          {t.fact.by(fact.author)} · <When at={fact.at} />
        </>
      );
      break;
    case "working":
      text = t.fact.working(name(fact.who, fact.task));
      meta = <When at={fact.at} />;
      break;
  }
  return (
    <p className="request-block-fact-text">
      <span className="request-block-fact-line">{text}</span>
      {meta && <span className="request-block-fact-meta">{meta}</span>}
    </p>
  );
}

/**
 * One request (YN-212 §3.2): its number and title; one latest fact and one
 * action; what its tasks delivered, each openable; folded, its tasks (one
 * card each), the tasks it joined, and its own conversation.
 */
export function RequestBlockView({
  block,
  open,
  onToggle,
  onAction,
  onShowBlock,
  busy = false,
  common,
}: {
  block: RequestBlock;
  open: boolean;
  onToggle: () => void;
  /** The block's action; `focusKey` names the Ask an answer goes to. */
  onAction: (action: BlockAction, n: number, focusKey?: string) => void;
  /** A joined task's line: shows the block its card is under. */
  onShowBlock: (n: number) => void;
  /** Its action is under way (a confirmation or a send again). */
  busy?: boolean;
  common: BlockCommon;
}) {
  const language = useLanguage();
  const t = blockText(language);
  const timeDisplay = useTimeDisplay();
  const { request, fact, action } = block;
  const title = requestTitle(request, t.untitled);
  const said = conversation([request]).length;
  const tasks = block.tasks.length + block.joined.length;
  const label = action ? t.actions[action] : "";
  return (
    <article
      className="request-block"
      id={requestDomId(request.id)}
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
        {block.unread && <span className="home-chip is-new">{t.newMark}</span>}
        <span className="request-block-time"><When at={request.createdAt} /></span>
      </header>
      <div className="request-block-fact">
        <span className="request-block-fact-icon" data-kind={fact.kind}>{FACT_ICON[fact.kind]}</span>
        <FactLines fact={fact} />
      </div>
      {action && !common.readOnly && (
        <div className="request-block-act">
          <button
            type="button"
            className={action === "follow" ? "request-block-action" : "request-block-action is-primary"}
            data-action={action}
            aria-label={t.actionLabel(label, request.n)}
            disabled={busy}
            onClick={() => onAction(action, request.n, fact.kind === "ask" ? fact.key : undefined)}
          >
            {busy ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : action === "follow" ? <Send size={12} aria-hidden="true" /> : null}
            {label}
          </button>
        </div>
      )}
      {block.delivered.length > 0 && (
        <ul className="request-block-delivered" aria-label={t.delivered(title)}>
          {block.delivered.flatMap((group) =>
            group.items.map((item, index) => (
              <li key={`${group.task}:${index}`}>
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
      <button type="button" className="request-block-more" aria-expanded={open} onClick={onToggle}>
        <ChevronDown size={13} aria-hidden="true" />
        {open ? t.less : t.more(tasks, said)}
      </button>
      {open && (
        <div className="request-block-body">
          {block.tasks.map((row) => (
            <TaskRowView key={row.task.id} row={row} common={common} />
          ))}
          {block.joined.map((row) => (
            <p key={row.task.id} className="request-block-joined">
              <span>{t.joined(row.task.id, row.title, row.home)}</span>
              <button type="button" className="talk-link" onClick={() => onShowBlock(row.home)}>
                {t.show}
              </button>
            </p>
          ))}
          <RequestThread request={request} />
        </div>
      )}
    </article>
  );
}

/** One task of a request: its open Asks, its one card (or whom it went to), and the Asks it had answered. */
function TaskRowView({ row, common }: { row: TaskRow; common: BlockCommon }) {
  const t = blockText(useLanguage());
  const agents = useContext(CardAgents);
  const who = row.responsible ? agents.get(row.responsible.agentId)?.name || row.responsible.name : row.task.id;
  const asks = { open: row.asks.filter((a) => a.ask?.state === "open"), answered: row.asks.filter((a) => a.ask?.state !== "open") };
  const card = (section: Section) =>
    section.kind === "ask" ? (
      <SectionCard
        key={section.key}
        section={section}
        projectId={common.projectId}
        workspaceId={common.workspaceId}
        agents={common.agents}
        readOnly={common.readOnly || section.history}
        onSeen={common.onSeen}
        onChanged={common.onChanged}
        notice={common.notice?.(section)}
      />
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
      {row.alsoFor.length > 0 && <p className="request-task-also">{t.alsoFor(row.alsoFor)}</p>}
      {asks.open.map(card)}
      {row.card ? (
        <div className="request-task-card">{card(row.card)}</div>
      ) : (
        <p className="request-task-none">{t.noCardYet(who)}</p>
      )}
      {asks.answered.map((ask) => (
        <p key={ask.key} className="request-task-answered">
          <MessageSquare size={12} aria-hidden="true" />
          <span>{t.answeredAsk(ask.ask?.question || ask.title, ask.ask?.replyText ?? "")}</span>
        </p>
      ))}
    </section>
  );
}

/** A request's own conversation, oldest first, folded: its words, the project's notes, follow-ups and Core's lines. */
function RequestThread({ request }: { request: ProjectRequest }) {
  const language = useLanguage();
  const t = blockText(language);
  const items = conversation([request]).filter((item) => item.kind !== "looking");
  return (
    <details className="request-thread">
      <summary>{t.thread(items.length)}</summary>
      <ol>
        {items.map((item, index) => {
          const at = new Date(item.at).toISOString();
          switch (item.kind) {
            case "mine":
              return (
                <li key={index} data-who="you">
                  <b>{t.you}</b>
                  <MessageContent text={request.text} blocks={request.textBlocks ?? undefined} />
                  <When at={at} />
                </li>
              );
            case "reply":
              return (
                <li key={index} data-who="you">
                  <b>{t.followUp}</b>
                  <MessageContent text={item.reply.text} blocks={item.reply.textBlocks ?? undefined} />
                  <When at={at} />
                </li>
              );
            case "note":
              return (
                <li key={index} data-who="project">
                  <b>{t.projectSaid}</b>
                  <span>{item.note.note}</span>
                  <When at={at} />
                </li>
              );
            case "line":
              return (
                <li key={index} data-who="core">
                  <span>{item.line.kind === "ask" ? t.line.ask(item.line.title) : t.line.done(item.line.title || item.line.task)}</span>
                  <When at={at} />
                </li>
              );
            default:
              return null;
          }
        })}
      </ol>
    </details>
  );
}

/** The Project's own block (§2.2 rule 3): what belongs to no request, one line each until opened. */
export function ProjectBlockView({ block, open, onToggle, common }: { block: ProjectBlock; open: boolean; onToggle: () => void; common: BlockCommon }) {
  const language = useLanguage();
  const t = blockText(language);
  const all: Section[] = [...block.asks, ...block.sections];
  return (
    <article className="request-block" data-project-block="" data-group={block.group} data-open={open ? "" : undefined} tabIndex={-1}>
      <header className="request-block-head">
        <span className="request-block-n">{t.project}</span>
        <button type="button" className="request-block-title" aria-expanded={open} onClick={onToggle}>
          {t.projectNote}
        </button>
        {block.unread && <span className="home-chip is-new">{t.newMark}</span>}
      </header>
      {open ? (
        <div className="request-block-body project-block-cards">
          {all.map((section) =>
            section.kind === "ask" ? (
              <SectionCard
                key={section.key}
                section={section}
                projectId={common.projectId}
                workspaceId={common.workspaceId}
                agents={common.agents}
                readOnly={common.readOnly}
                onSeen={common.onSeen}
                onChanged={common.onChanged}
                notice={common.notice?.(section)}
              />
            ) : (
              <SummaryCard
                key={section.key}
                section={section}
                projectId={common.projectId}
                workspaceId={common.workspaceId}
                agents={common.agents}
                readOnly={common.readOnly}
                onSeen={common.onSeen}
                notice={common.notice?.(section)}
              />
            ),
          )}
        </div>
      ) : (
        <ul className="project-block-lines">
          {all.map((section) => (
            <li key={section.key}>
              <button type="button" onClick={onToggle}>
                <span className="project-block-line-title">{section.title}</span>
                <span className="project-block-line-time">{relative(section.updatedAt, language)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="request-block-more" aria-expanded={open} onClick={onToggle}>
        <ChevronDown size={13} aria-hidden="true" />
        {open ? t.less : t.projectMore(all.length)}
      </button>
    </article>
  );
}
