import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CircleCheck, LoaderCircle, MessageSquare, Send, X } from "lucide-react";
import { errorText } from "../api";
import type { ComposerHandle } from "../PastedTextComposer";
import { useLanguage } from "../i18n";
import { MessageContent } from "../MessageContent";
import type { TextBlock } from "../message-content";
import { settleWhenLanded } from "../settle";
import { Tip, TipText } from "../Tip";
import { useTimeDisplay } from "../time-preferences";
import { CardAgents } from "./card-responsible";
import { absolute, duration, relative } from "./format";
import { HomeComposer, type ReplyWords } from "./HomeComposer";
import type { HomeTarget } from "./home-navigation";
import { draftStore } from "./reply-drafts";
import { ReplyLength, replyTooLong } from "./reply-limit";
import {
  conversation,
  earlierBefore,
  itemKey,
  replyDelivered,
  requestGroups,
  savedView,
  saveView,
  shownView,
  sideOpen,
  TALK_NARROW,
  untitledHint,
  type TalkItem,
  type TalkView,
} from "./project-talk";
import {
  delivered,
  forgetWords,
  pendingWords,
  readFrontDesk,
  readRequests,
  resendKept,
  sendWords,
  talkSlot,
  type FrontDesk,
  type ProjectRequest,
  type RequestPage,
} from "./project-talk-api";
import { RequestCard } from "./RequestCard";
import { talkText } from "./talk-text";
import "./project-talk.css";

const reducedMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Side = "requests" | "chat";
/** How a side's content comes or goes (§4.1): in or out beside the other, or the narrow tabs' switch. */
type Motion = "in" | "out" | "switch" | null;

/** What the user is writing to the project, kept in this browser until sent, as a card's reply is (CardReply.tsx). */
type Draft = { text: string; blocks?: TextBlock[]; quote?: number; at: string };
const drafts = draftStore<Draft>("yuzuno.project-talk-drafts.v1");

/** The words as they are sent: trimmed, as every reply is (reply-limit.tsx), their pasted blocks moved with them. */
function trimmed(words: ReplyWords): { text: string; textBlocks?: TextBlock[] } {
  const start = words.text.length - words.text.trimStart().length;
  const text = words.text.trim();
  const blocks = (words.blocks ?? [])
    .map((block) => ({ ...block, start: Math.max(0, block.start - start), end: Math.min(text.length, block.end - start) }))
    .filter((block) => block.end > block.start);
  return { text, ...(blocks.length ? { textBlocks: blocks } : {}) };
}

/** Scrolls `scroller` so `target` is in its middle, without moving the page. */
function scrollInside(scroller: HTMLElement | null, target: HTMLElement, smooth: boolean) {
  if (!scroller) return;
  const outer = scroller.getBoundingClientRect();
  const inner = target.getBoundingClientRect();
  const top = Math.max(0, scroller.scrollTop + inner.top - outer.top - (outer.height - inner.height) / 2);
  if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
  else scroller.scrollTop = top;
}

/** Whether the window is too narrow for the two sides side by side (§4.1, as the approved preview v8 measures it). */
function useNarrowWindow() {
  const query = `(max-width: ${TALK_NARROW}px)`;
  const read = () => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const changed = () => setNarrow(list.matches);
    changed();
    list.addEventListener?.("change", changed);
    return () => list.removeEventListener?.("change", changed);
    // The query is a constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return narrow;
}

/** Runs `then` once `grid` has finished moving its columns: at once when it moves none (reduced motion, no change). */
function afterColumns(grid: HTMLElement | null, then: () => void) {
  if (!grid || reducedMotion()) return then();
  const seconds = Number.parseFloat(getComputedStyle(grid).transitionDuration) || 0;
  if (!seconds) return then();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    grid.removeEventListener("transitionend", ended);
    clearTimeout(timer);
    then();
  };
  const ended = (event: TransitionEvent) => {
    if (event.target === grid) finish();
  };
  grid.addEventListener("transitionend", ended);
  // The transition's own length and a frame: a transition that never ends (none ran) does not keep it waiting.
  const timer = setTimeout(finish, seconds * 1000 + 50);
}

/**
 * "Talk to the project" on a Project's page (YN-86 §4.1, v8): the requests
 * on one side, the conversation on the other, linked by selection; one
 * switch shows either side across the whole width, or both. What the user
 * says goes to Core as a request, or as a follow-up to the request quoted,
 * and from there to the project's front desk, shown as "the project".
 * Columns open and close as the task window's list and detail do
 * (collaboration.css), and not at all with reduced motion.
 */
export function ProjectTalk({
  projectId,
  projectName,
  workspaceId,
  readOnly,
  revision,
  leadCount,
  onCard,
  onNavigate,
}: {
  projectId: string;
  projectName: string;
  workspaceId: string;
  readOnly: boolean;
  /** Home's reads: each one reads the requests again, so their progress follows the cards. */
  revision: number;
  /** The project's leads, to say why no front desk takes what is said. */
  leadCount: number;
  /** Shows one of the project's cards on the page. */
  onCard: (key: string) => void;
  onNavigate: (target: HomeTarget) => void;
}) {
  const language = useLanguage();
  const t = talkText(language);
  const time = useTimeDisplay();
  const agents = useContext(CardAgents);
  const root = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const requestsScroll = useRef<HTMLDivElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const requestRefs = useRef(new Map<number, HTMLDivElement>());
  const wordRefs = useRef(new Map<number, HTMLLIElement>());

  // Core's facts: the front desk, the newest requests and any older ones read since.
  const [desk, setDesk] = useState<FrontDesk | null>(null);
  const [page, setPage] = useState<RequestPage | null>(null);
  const [older, setOlder] = useState<{ requests: ProjectRequest[]; hasMore: boolean } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reads, setReads] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    readFrontDesk(projectId, signal).then((value) => !signal.aborted && setDesk(value)).catch(() => {});
    readRequests(projectId, undefined, signal)
      .then((value) => {
        if (signal.aborted) return;
        setPage(value);
        setLoadError("");
      })
      .catch((e) => !signal.aborted && setLoadError(errorText(e)));
    return () => controller.abort();
  }, [projectId, revision, reads]);
  const requests = useMemo(() => {
    const newest = page?.requests ?? [];
    const lowest = Math.min(...newest.map((r) => r.n));
    return [...newest, ...(older?.requests.filter((r) => r.n < lowest) ?? [])];
  }, [page, older]);
  const hasMore = older ? older.hasMore : !!page?.hasMore;
  const [readingOlder, setReadingOlder] = useState(false);
  async function readOlder() {
    const lowest = Math.min(...requests.map((r) => r.n));
    if (!Number.isFinite(lowest)) return;
    setReadingOlder(true);
    try {
      const value = await readRequests(projectId, lowest);
      setOlder((was) => ({ requests: [...(was?.requests ?? []), ...value.requests], hasMore: value.hasMore }));
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setReadingOlder(false);
    }
  }

  // Which side shows: this device's choice for the project, one side at a time where the two do not fit.
  const [view, setView] = useState<TalkView>(() => savedView(workspaceId, projectId));
  const narrow = useNarrowWindow();
  const shown = shownView(view, narrow);
  // A side opening or closing moves its content as it goes; the window crossing the narrow line does not.
  const [motion, setMotion] = useState<Record<Side, Motion>>({ requests: null, chat: null });
  const last = useRef({ shown, narrow });
  useLayoutEffect(() => {
    const was = last.current;
    last.current = { shown, narrow };
    if (was.shown === shown && was.narrow === narrow) return;
    if (was.narrow !== narrow) {
      setMotion({ requests: null, chat: null });
      return;
    }
    const next = (side: Side, before: Motion): Motion => {
      const open = sideOpen(shown, side);
      if (sideOpen(was.shown, side) === open) return before;
      if (narrow) return open ? "switch" : null;
      return open ? "in" : "out";
    };
    setMotion((before) => ({ requests: next("requests", before.requests), chat: next("chat", before.chat) }));
  }, [shown, narrow]);
  const choose = (next: TalkView) => {
    setView(next);
    saveView(workspaceId, projectId, next);
  };
  const tabs: TalkView[] = narrow ? ["requests", "chat"] : ["requests", "both", "chat"];
  const tabLabel = (tab: TalkView) =>
    tab === "requests" ? t.tabRequests(requests.length) : tab === "both" ? t.tabBoth : t.tabChat;
  const tabRefs = useRef(new Map<TalkView, HTMLButtonElement>());
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const at = tabs.indexOf(shown);
    const to =
      event.key === "ArrowRight" ? tabs[(at + 1) % tabs.length]
        : event.key === "ArrowLeft" ? tabs[(at - 1 + tabs.length) % tabs.length]
          : event.key === "Home" ? tabs[0]
            : event.key === "End" ? tabs[tabs.length - 1]
              : null;
    if (!to) return;
    event.preventDefault();
    choose(to);
    tabRefs.current.get(to)?.focus();
  }

  // Selection links the two sides: a request on one, its words on the other (§4.1).
  const [selected, setSelected] = useState<number | null>(null);
  const [trails, setTrails] = useState<ReadonlySet<number>>(new Set());
  const [doneOpen, setDoneOpen] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const pending = useRef<{ side: Side; n: number; moved: boolean } | null>(null);
  const items = useMemo(() => conversation(requests), [requests]);
  const cut = useMemo(() => earlierBefore(requests), [requests]);
  const earlier = items.filter((item) => item.at < cut);
  const groups = useMemo(() => requestGroups(requests), [requests]);
  const byN = useMemo(() => new Map(requests.map((r) => [r.n, r])), [requests]);
  /** Selects a request in the requests side, from the conversation. */
  function showRequest(n: number) {
    setSelected(n);
    if (groups.done.some((r) => r.n === n)) setDoneOpen(true);
    const moved = !sideOpen(shown, "requests");
    if (moved) setView("requests");
    pending.current = { side: "requests", n, moved };
  }
  /** Shows the user's own words of a request in the conversation, from its title. */
  function showWords(n: number) {
    setSelected(n);
    const words = items.find((item) => item.kind === "mine" && item.request.n === n);
    if (words && words.at < cut) setShowEarlier(true);
    const moved = !sideOpen(shown, "chat");
    if (moved) setView("chat");
    pending.current = { side: "chat", n, moved };
  }
  useEffect(() => {
    const want = pending.current;
    if (!want) return;
    pending.current = null;
    // A side that opens is scrolled once its column has: its text reflows as it widens.
    afterColumns(want.moved ? grid.current : null, () => {
      const target = want.side === "requests" ? requestRefs.current.get(want.n) : wordRefs.current.get(want.n);
      if (!target) return;
      const smooth = !reducedMotion();
      scrollInside(want.side === "requests" ? requestsScroll.current : chatScroll.current, target, smooth);
      target.focus({ preventScroll: true });
      settleWhenLanded(target, "data-home-highlight", smooth, "animation");
    });
  });
  // The conversation opens at its newest, and goes there again after the user's own message.
  const toBottom = useRef(true);
  useLayoutEffect(() => {
    if (!page || !toBottom.current) return;
    toBottom.current = false;
    const scroller = chatScroll.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [page]);

  // What the user writes: one draft per project, a follow-up when it quotes a request.
  const draftSlot = talkSlot(workspaceId, projectId);
  const [draft, setDraft] = useState<Draft>(() => drafts.load()[draftSlot] ?? { text: "", at: "" });
  // The request quoted, by its number: one not among those read (an older one, kept with the draft) is still that request.
  const quote = draft.quote !== undefined ? { n: draft.quote, title: titleOrNumber(draft.quote) } : null;
  const words: ReplyWords = { text: draft.text, ...(draft.blocks ? { blocks: draft.blocks } : {}) };
  const write = (next: Partial<Draft>) =>
    setDraft((was) => {
      const value: Draft = { ...was, ...next, at: new Date().toISOString() };
      drafts.save(draftSlot, value.text.trim() || value.quote !== undefined ? value : null);
      return value;
    });
  const sendSlot = talkSlot(workspaceId, projectId, quote?.n);
  const outgoing = trimmed(words);
  const kept = pendingWords(sendSlot);
  const unanswered = !!kept && kept.text === outgoing.text;
  // Words Core keeps by now, listed with their own delivery, are no longer this page's to send.
  useEffect(() => {
    const ids = new Set(requests.flatMap((r) => [r.messageId, ...r.replies.map((reply) => reply.messageId)]));
    for (const slot of [talkSlot(workspaceId, projectId), ...requests.map((r) => talkSlot(workspaceId, projectId, r.n))]) {
      const words = pendingWords(slot);
      if (words && ids.has(words.clientMessageId)) forgetWords(slot);
    }
  }, [requests, workspaceId, projectId]);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState("");
  const deskId = desk?.effectiveAgentId ?? null;
  const deskName = deskId ? agents.get(deskId)?.name || t.someone : "";
  const blocked = !quote && !deskId;
  const canSend = !readOnly && !busy && !blocked && !!outgoing.text && !replyTooLong(words.text);
  async function send() {
    if (!canSend) return;
    setBusy(true);
    setSendError("");
    try {
      await sendWords(sendSlot, projectId, workspaceId, outgoing, quote?.n);
      const empty: Draft = { text: "", at: new Date().toISOString() };
      setDraft(empty);
      drafts.save(draftSlot, null);
      toBottom.current = true;
      setReads((n) => n + 1);
    } catch (e) {
      setSendError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function followUp(n: number) {
    write({ quote: n });
    if (!sideOpen(shown, "chat")) setView("chat");
    requestAnimationFrame(() => composer.current?.focusEnd());
  }
  // A request or follow-up Core keeps that did not reach its Agent: sent again as it was.
  const [resending, setResending] = useState<ReadonlySet<string>>(new Set());
  async function resend(id: string, request: ProjectRequest, reply?: ProjectRequest["replies"][number]) {
    setResending((was) => new Set(was).add(id));
    setSendError("");
    try {
      await resendKept(projectId, workspaceId, reply ?? request, reply ? request.n : undefined);
    } catch (e) {
      setSendError(errorText(e));
    } finally {
      setResending((was) => {
        const next = new Set(was);
        next.delete(id);
        return next;
      });
      setReads((n) => n + 1);
    }
  }

  function titleOrNumber(n: number) {
    const request = byN.get(n);
    return request ? titleOf(request) : `R-${n}`;
  }
  function titleOf(request: ProjectRequest) {
    return request.title?.trim() || t.untitled(untitledHint(request.text));
  }
  const nameOf = (agentId: string) => agents.get(agentId)?.name || t.someone;
  const when = (iso: string | null | undefined) =>
    iso ? (
      <Tip content={<TipText title={absolute(iso, time)} />} describe={false}>
        <time dateTime={iso}>{relative(iso, language)}</time>
      </Tip>
    ) : null;
  const unconfirmed = (id: string, request: ProjectRequest, reply?: ProjectRequest["replies"][number]) => (
    <span className="project-talk-unconfirmed" role="status">
      {t.state.unconfirmed}
      {!readOnly && (
        <>
          {" · "}
          <button type="button" className="talk-link" disabled={resending.has(id)} onClick={() => void resend(id, request, reply)}>
            {resending.has(id) && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
            {t.resend}
          </button>
        </>
      )}
    </span>
  );
  function item(entry: TalkItem) {
    const { request } = entry;
    const n = request.n;
    switch (entry.kind) {
      case "mine":
        return (
          <li
            key={itemKey(entry)}
            className="project-talk-mine"
            data-words={n}
            tabIndex={-1}
            ref={(element) => {
              if (element) wordRefs.current.set(n, element);
              else wordRefs.current.delete(n);
            }}
          >
            <div className="project-talk-bubble">
              <MessageContent text={request.text} blocks={request.textBlocks ?? undefined} />
            </div>
            <span className="project-talk-meta">
              {when(request.createdAt)}
              {!delivered(request.delivery) && unconfirmed(`r:${n}`, request)}
            </span>
          </li>
        );
      case "looking":
        return (
          <li key={itemKey(entry)} className="project-talk-project" data-looking="">
            {speaker(request.frontAgentId)}
            <p>
              {t.looking} <small>{duration(Math.max(0, (Date.now() - entry.at) / 1000), language)}</small>
            </p>
          </li>
        );
      case "note":
        return (
          <li key={itemKey(entry)} className="project-talk-project">
            {speaker(entry.note.by.agentId)}
            <p>
              {entry.note.note}{" "}
              <button
                type="button"
                className="project-talk-chip"
                data-on={selected === n ? "" : undefined}
                aria-label={t.toRequestLabel(titleOf(request))}
                onClick={() => showRequest(n)}
              >
                {t.toRequest}
              </button>
            </p>
          </li>
        );
      case "reply": {
        const reply = entry.reply;
        return (
          <li key={itemKey(entry)} className="project-talk-mine" data-reply={`${n}:${reply.n}`}>
            <span className="project-talk-quote-ref">{t.followUpOf(titleOf(request))}</span>
            <div className="project-talk-bubble">
              <MessageContent text={reply.text} blocks={reply.textBlocks ?? undefined} />
            </div>
            <span className="project-talk-meta">
              {when(reply.at)}
              {replyDelivered(reply)
                ? <span className="project-talk-receipt">{t.passedTo(reply.deliveredTo.map((to) => nameOf(to.agentId)).join(language === "zh-Hans" ? "、" : ", "))}</span>
                : unconfirmed(`f:${n}:${reply.n}`, request, reply)}
            </span>
          </li>
        );
      }
      case "line": {
        const line = entry.line;
        const ask = line.kind === "ask";
        const title = ask ? line.title : line.title || line.task;
        const text = ask
          ? line.state === "open" ? t.askLine(title) : t.askAnswered(title)
          : line.status === "done" ? t.doneLine(title) : line.status === "cancelled" ? t.cancelledLine(title) : t.archivedLine(title);
        return (
          <li key={itemKey(entry)} className="project-talk-line" data-line={line.kind}>
            <span className="project-talk-line-icon" aria-hidden="true">
              {ask ? <MessageSquare size={12} /> : <CircleCheck size={12} />}
            </span>
            <span className="project-talk-line-text">{text}</span>
            {(!ask || line.state === "open") && (
              <button type="button" className="talk-link" onClick={() => showRequest(n)}>
                {ask ? t.goAnswer : t.seeResult}
              </button>
            )}
            {when(line.at)}
          </li>
        );
      }
    }
  }
  /** "Project", the front desk behind it on hover; it opens that session. */
  function speaker(agentId: string) {
    const name = nameOf(agentId);
    return (
      <Tip content={<TipText title={t.projectTip(name)} />} describe={false}>
        <button type="button" className="project-talk-who" onClick={() => onNavigate({ kind: "agent", agentId })}>
          {t.project}
        </button>
      </Tip>
    );
  }
  const card = (request: ProjectRequest) => (
    <li key={request.id}>
      <RequestCard
        ref={(element) => {
          if (element) requestRefs.current.set(request.n, element);
          else requestRefs.current.delete(request.n);
        }}
        request={request}
        selected={selected === request.n}
        trailOpen={trails.has(request.n)}
        readOnly={readOnly}
        resending={resending.has(`r:${request.n}`)}
        onTitle={() => showWords(request.n)}
        onFollowUp={() => followUp(request.n)}
        onTrail={() =>
          setTrails((was) => {
            const next = new Set(was);
            if (!next.delete(request.n)) next.add(request.n);
            return next;
          })
        }
        onResend={() => void resend(`r:${request.n}`, request)}
        onCard={onCard}
      />
    </li>
  );
  const open = { requests: sideOpen(shown, "requests"), chat: sideOpen(shown, "chat") };
  const listId = `project-talk-requests-${projectId}`;
  const chatId = `project-talk-chat-${projectId}`;
  return (
    <section
      ref={root}
      className="project-talk"
      aria-labelledby={`project-talk-title-${projectId}`}
      data-view={shown}
      data-narrow={narrow ? "" : undefined}
    >
      <header className="project-talk-head">
        <h2 id={`project-talk-title-${projectId}`}>{t.title}</h2>
        {deskId ? (
          <span className="project-talk-desk">{t.deskNote(deskName)}</span>
        ) : desk ? (
          <span className="project-talk-desk" data-missing="">
            {leadCount > 0 ? t.noDesk : t.noLead}{" "}
            {!readOnly && (
              <button type="button" className="talk-link" onClick={() => onNavigate({ kind: "projectSettings", projectId })}>
                {t.chooseDesk}
              </button>
            )}
          </span>
        ) : null}
        <div className="project-talk-tabs" role="tablist" aria-label={t.views}>
          {tabs.map((tab) => (
            <button
              key={tab}
              ref={(element) => {
                if (element) tabRefs.current.set(tab, element);
                else tabRefs.current.delete(tab);
              }}
              type="button"
              role="tab"
              data-tab={tab}
              aria-selected={shown === tab}
              aria-controls={tab === "requests" ? listId : tab === "chat" ? chatId : `${listId} ${chatId}`}
              tabIndex={shown === tab ? 0 : -1}
              onKeyDown={onTabKey}
              onClick={() => choose(tab)}
            >
              {tabLabel(tab)}
            </button>
          ))}
        </div>
      </header>
      <div className="project-talk-columns" ref={grid}>
        <div
          id={listId}
          className="project-talk-side project-talk-requests"
          role="tabpanel"
          aria-label={t.requests}
          inert={!open.requests}
          data-open={open.requests ? "" : undefined}
          data-motion={motion.requests ?? undefined}
        >
          <div className="project-talk-scroll" ref={requestsScroll}>
            <h3 className="project-talk-requests-title">
              {t.requests} <span>{t.going(groups.open.length)}</span>
            </h3>
            {!page && !loadError && <p className="home-note">{t.reading}</p>}
            {page && !requests.length && <p className="home-note">{t.noRequests}</p>}
            {groups.open.length > 0 && <ol className="project-talk-list">{groups.open.map(card)}</ol>}
            {groups.done.length > 0 && (
              <details className="project-talk-done" open={doneOpen} onToggle={(event) => setDoneOpen(event.currentTarget.open)}>
                <summary>{t.done(groups.done.length)}</summary>
                <ol className="project-talk-list">{groups.done.map(card)}</ol>
              </details>
            )}
          </div>
        </div>
        <div
          id={chatId}
          className="project-talk-side project-talk-chat"
          role="tabpanel"
          aria-label={t.tabChat}
          inert={!open.chat}
          data-open={open.chat ? "" : undefined}
          data-motion={motion.chat ?? undefined}
        >
          <div className="project-talk-scroll" ref={chatScroll}>
            {earlier.length > 0 && !showEarlier && (
              <button type="button" className="project-talk-earlier" onClick={() => setShowEarlier(true)}>
                {t.earlier(earlier.length)}
              </button>
            )}
            {hasMore && (showEarlier || !earlier.length) && (
              <button type="button" className="project-talk-earlier" disabled={readingOlder} onClick={() => void readOlder()}>
                {readingOlder && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
                {t.loadEarlier}
              </button>
            )}
            <ol className="project-talk-thread">{(showEarlier ? items : items.filter((entry) => entry.at >= cut)).map(item)}</ol>
          </div>
          <form
            className="project-talk-compose"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {quote && (
              <p className="project-talk-quoting">
                <span>{t.followUpOf(quote.title)}</span>
                <button type="button" className="icon-button" aria-label={t.cancelFollowUp} onClick={() => write({ quote: undefined })}>
                  <X size={13} aria-hidden="true" />
                </button>
              </p>
            )}
            <div className="project-talk-field">
              <HomeComposer
                ref={composer}
                slot={draftSlot}
                label={quote ? t.followUpLabel(quote.title) : t.field(projectName)}
                placeholder={quote ? t.followUpPlaceholder : t.placeholder(projectName)}
                words={words}
                onWords={(next) => write({ text: next.text, blocks: next.blocks })}
                onSubmit={() => void send()}
                readOnly={readOnly || blocked}
                onEscape={quote ? () => write({ quote: undefined }) : undefined}
              />
              <button type="submit" className="primary-button project-talk-send" aria-label={t.send} disabled={!canSend}>
                {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
              </button>
            </div>
            <ReplyLength text={words.text} />
            {unanswered && <p className="home-note" role="status">{t.kept}</p>}
            {(sendError || loadError) && (
              <p className="inline-error" role="alert">
                {sendError || loadError}
              </p>
            )}
            {deskId && !quote && <p className="project-talk-hint">{t.hint(deskName)}</p>}
          </form>
        </div>
      </div>
    </section>
  );
}
