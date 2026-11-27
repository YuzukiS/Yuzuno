import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleCheck, LoaderCircle, MessageSquare, Send, X } from "lucide-react";
import { errorText } from "../api";
import { ImageAttachments } from "../ImageAttachments";
import { FileAttachments } from "../FileAttachments";
import { useLanguage } from "../i18n";
import { MessageContent } from "../MessageContent";
import type { TextBlock } from "../message-content";
import { settleWhenLanded } from "../settle";
import { arriveIn } from "../surface";
import { Tip, TipText } from "../Tip";
import { useTimeDisplay } from "../time-preferences";
import { CardAgents } from "./card-responsible";
import { absolute, duration, relative } from "./format";
import { HomeComposer, type HomeComposerHandle, type ReplyWords } from "./HomeComposer";
import { olderCoreFiles, olderCoreImages } from "./home-api";
import { homeImageUrl, takesImages, validHomeImages, type HomeImage } from "./home-images";
import { agentTakesFiles, homeFileUrl, validHomeFiles, type HomeFile } from "./home-files";
import type { HomeTarget } from "./home-navigation";
import { scrollWithinHome } from "./HomeJumps";
import { draftStore } from "./reply-drafts";
import { ReplyLength, replyTooLong } from "./reply-limit";
import { markArrived } from "./request-arrival";
import { conversation, earlierBefore, itemKey, replyDelivered, untitledHint, type TalkItem } from "./project-talk";
import {
  delivered,
  forgetWords,
  pendingWords,
  readFrontDesk,
  confirmRequest,
  readRequests,
  resendKept,
  sendWords,
  talkSlot,
  type FrontDesk,
  type ProjectRequest,
  type RequestPage,
  type InstalledRelease,
} from "./project-talk-api";
import { talkText } from "./talk-text";
import "./project-talk.css";

const reducedMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** What the user is writing to the project, kept in this browser until sent, as a card's reply is (CardReply.tsx);
 * with the images attached (YN-134), by their place in the Project's images, and the files (YN-145). */
type Draft = { text: string; blocks?: TextBlock[]; images?: HomeImage[]; files?: HomeFile[]; quote?: number; at: string };
const drafts = draftStore<Draft>("yuzuno.project-talk-drafts.v1");

/** A kept draft as read back: images and files that are not what this page keeps are left out. */
function loadDraft(slot: string): Draft {
  let kept = drafts.load()[slot];
  if (!kept) return { text: "", at: "" };
  if (kept.images !== undefined && !validHomeImages(kept.images)) {
    const { images: _dropped, ...rest } = kept;
    kept = rest;
  }
  if (kept.files !== undefined && !validHomeFiles(kept.files)) {
    const { files: _dropped, ...rest } = kept;
    kept = rest;
  }
  return kept;
}

/** A draft worth keeping: words, images, files or the request it follows up. */
const worthKeeping = (draft: Draft) => !!(draft.text.trim() || draft.images?.length || draft.files?.length || draft.quote !== undefined);

/**
 * What stays of the draft once Core has the words sent from `sent` (YN-226): what the user wrote, attached or chose
 * while they went. Nothing, when the draft is still the one sent. Words written after the words sent stay, without
 * them; words changed among them stay whole, so nothing the user wrote is lost. Images and files added meanwhile
 * stay, and so does another request chosen to follow up.
 */
function afterSent(now: Draft, sent: Draft): Draft {
  let text = now.text;
  let blocks = now.blocks;
  if (now.text === sent.text) {
    text = "";
    blocks = undefined;
  } else if (now.text.startsWith(sent.text)) {
    const rest = now.text.slice(sent.text.length);
    const cut = sent.text.length + rest.length - rest.trimStart().length;
    text = now.text.slice(cut);
    blocks = now.blocks?.filter((block) => block.start >= cut).map((block) => ({ ...block, start: block.start - cut, end: block.end - cut }));
  }
  const sentImages = new Set((sent.images ?? []).map((image) => image.id));
  const sentFiles = new Set((sent.files ?? []).map((file) => file.id));
  const images = (now.images ?? []).filter((image) => !sentImages.has(image.id));
  const files = (now.files ?? []).filter((file) => !sentFiles.has(file.id));
  const quote = now.quote === sent.quote ? undefined : now.quote;
  return {
    text,
    ...(blocks?.length ? { blocks } : {}),
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
    ...(quote !== undefined ? { quote } : {}),
    at: new Date().toISOString(),
  };
}

/** A read of the newest requests, with the requests Core answered this page's sends with that it does not list yet
 * (YN-226); those it lists are no longer kept. */
function withConfirmed(value: RequestPage, kept: Map<number, ProjectRequest>): RequestPage {
  for (const request of value.requests) kept.delete(request.n);
  if (!kept.size) return value;
  return { ...value, requests: [...kept.values(), ...value.requests].sort((a, b) => b.n - a.n) };
}

/** What the requests' page says of the release this Core runs (R-38 §2.6): null from an older Core or a source build. */
export type InstalledFacts = { release: InstalledRelease | null; mergedAfter: number | null };

/** The words as they are sent: trimmed, as every reply is (reply-limit.tsx), their pasted blocks moved with them. */
function trimmed(words: ReplyWords): { text: string; textBlocks?: TextBlock[] } {
  const start = words.text.length - words.text.trimStart().length;
  const text = words.text.trim();
  const blocks = (words.blocks ?? [])
    .map((block) => ({ ...block, start: Math.max(0, block.start - start), end: Math.min(text.length, block.end - start) }))
    .filter((block) => block.end > block.start);
  return { text, ...(blocks.length ? { textBlocks: blocks } : {}) };
}

/** What a request's block asks of "Talk to the project" (YN-212 §3.2), which keeps the draft and Core's answers:
 * follow it up in the composer, confirm it done, or send its words again, or its follow-up `reply` (R-45 §3.2);
 * another `seq` is another. */
export type TalkCommand = { kind: "follow" | "confirm" | "resend"; n: number; reply?: number; seq: number };

/** What the page's blocks show of the actions under way here: a confirmation, a send again (of a request's words, or
 * of its follow-ups by request and number), and their errors. */
export type TalkBusy = {
  confirming: ReadonlySet<number>; resending: ReadonlySet<number>; followUps: ReadonlyMap<number, ReadonlySet<number>>;
  errors: ReadonlyMap<number, string>;
};

/** Older requests than those read, for the page's blocks: whether there are, a read under way, and how to read them. */
export type TalkOlder = { hasMore: boolean; reading: boolean; read: () => void };

/**
 * What the user just sent has landed (YN-226), told once for each send, as soon as Core's answer or a read of the
 * requests has it: a new request R-n, or a follow-up to R-n. `fresh`: no block of R-n was on the page before this
 * send; `delivered`: Core says it reached its Agents.
 */
export type TalkArrival = { kind: "request" | "follow"; n: number; seq: number; fresh: boolean; delivered: boolean };

/** The send under way: its words' client ID, what it is, the requests shown before it, and whether it was told. */
type Going = { id: string; kind: TalkArrival["kind"]; n?: number; before: ReadonlySet<number>; told: boolean };

/**
 * "Talk to the project" on a Project's page (YN-86 §4.1; YN-212 §3–4): it
 * reads the project's requests and its front desk for the page, keeps the
 * composer in Home's dock, where what the user says goes to Core as a
 * request or a follow-up to the request quoted, and, as the page's
 * Conversation view, draws the conversation in time order, the newest last
 * next to the composer. The page's request blocks run their actions here.
 */
export function ProjectTalk({
  projectId,
  projectName,
  workspaceId,
  readOnly,
  revision,
  leadCount,
  onNavigate,
  reveal = null,
  onRequests,
  onInstalled,
  onOlder,
  onBusy,
  dock,
  mode = "chat",
  command = null,
  onShowRequest,
  onShowChat,
  onFocusTarget,
  onArrival,
  notice = null,
  onDismissNotice,
}: {
  projectId: string;
  projectName: string;
  workspaceId: string;
  readOnly: boolean;
  /** Home's reads: each one reads the requests again, so their progress follows the cards. */
  revision: number;
  /** The project's leads, to say why no front desk takes what is said. */
  leadCount: number;
  onNavigate: (target: HomeTarget) => void;
  /** A card's "See words" (§4.5): show request `n`'s words in the conversation; another `seq` is another ask. */
  reveal?: { n: number; seq: number } | null;
  /** The requests read, for the page's blocks and cards (talk-link.ts). */
  /**
   * The requests once read, and whether they were read (`known`): a read that failed gives none, which is not the
   * same as a Project with none (R-38 §2.1).
   */
  onRequests?: (requests: readonly ProjectRequest[], known: boolean) => void;
  /** The release this Core runs and how many PRs merged after it, as the requests' page says (R-38 §2.6). */
  onInstalled?: (installed: InstalledFacts) => void;
  onOlder?: (older: TalkOlder) => void;
  onBusy?: (busy: TalkBusy) => void;
  /** Home's dock under its scroller (YN-212 §4.1): the composer stays there on screen, whichever view shows. null
   * while it is not laid out yet (nothing is drawn); without one the composer stays under the conversation. */
  dock?: HTMLElement | null;
  /** What the page shows (YN-212 §3.1): its requests' blocks, or this conversation. */
  mode?: "requests" | "chat";
  /** A block's action, run here. */
  command?: TalkCommand | null;
  /** A request's link in the conversation: its block. */
  onShowRequest?: (n: number) => void;
  /** "See words" asks the page for its conversation. */
  onShowChat?: () => void;
  /** The composer took focus following up request `n`: the page keeps that request in view above the dock (§4.4). */
  onFocusTarget?: (n: number) => void;
  /** What the user just sent has landed (YN-226): the page marks its block, or shows `notice`. */
  onArrival?: (arrival: TalkArrival) => void;
  /** Where what was just sent went, said above the composer while its block is not in sight (YN-226). */
  notice?: TalkArrival | null;
  /** The notice goes: closed, its request shown, or another send under way. */
  onDismissNotice?: () => void;
}) {
  const language = useLanguage();
  const t = talkText(language);
  const time = useTimeDisplay();
  const agents = useContext(CardAgents);
  const root = useRef<HTMLElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const composer = useRef<HomeComposerHandle>(null);
  const wordRefs = useRef(new Map<number, HTMLLIElement>());

  // Core's facts: the front desk, the newest requests and any older ones read since.
  const [desk, setDesk] = useState<FrontDesk | null>(null);
  const [page, setPage] = useState<RequestPage | null>(null);
  const [older, setOlder] = useState<{ requests: ProjectRequest[]; hasMore: boolean } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reads, setReads] = useState(0);
  // Requests Core answered this page's sends with (YN-226), drawn before a read lists them. A read that does not list
  // one yet started before Core kept it: the page keeps it, so its block never leaves and comes back. Listed, it is
  // the read's.
  const confirmed = useRef({ projectId, requests: new Map<number, ProjectRequest>() });
  if (confirmed.current.projectId !== projectId) confirmed.current = { projectId, requests: new Map() };
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    readFrontDesk(projectId, signal).then((value) => !signal.aborted && setDesk(value)).catch(() => {});
    readRequests(projectId, undefined, signal)
      .then((value) => {
        if (signal.aborted) return;
        setPage(withConfirmed(value, confirmed.current.requests));
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
  // The older requests Core keeps beside the first page (YN-237: those going on, or that a live card is bound to):
  // drawn as blocks, each in its group, but not in the conversation, which pages as it did; read on their own page,
  // they are that page's.
  const withKept = useMemo(() => {
    const listed = new Set(requests.map((r) => r.n));
    return [...requests, ...(page?.kept ?? []).filter((r) => !listed.has(r.n))];
  }, [requests, page]);
  const hasMore = older ? older.hasMore : !!page?.hasMore;
  const [readingOlder, setReadingOlder] = useState(false);
  /** Reads the page of requests before those read; `onFailed` runs, if it fails, before reading is said to be over. */
  async function readOlder(onFailed?: () => void) {
    const lowest = Math.min(...requests.map((r) => r.n));
    if (!Number.isFinite(lowest)) return;
    setReadingOlder(true);
    try {
      const value = await readRequests(projectId, lowest);
      setOlder((was) => ({ requests: [...(was?.requests ?? []), ...value.requests], hasMore: value.hasMore }));
    } catch (e) {
      setLoadError(errorText(e));
      onFailed?.();
    } finally {
      setReadingOlder(false);
    }
  }

  useEffect(() => onOlder?.({ hasMore, reading: readingOlder, read: () => void readOlder() }),
    // readOlder reads the requests as they are when called.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasMore, readingOlder, requests, onOlder]);
  const [showEarlier, setShowEarlier] = useState(false);
  const items = useMemo(() => conversation(requests), [requests]);
  const cut = useMemo(() => earlierBefore(requests), [requests]);
  const earlier = items.filter((item) => item.at < cut);
  const byN = useMemo(() => new Map(requests.map((r) => [r.n, r])), [requests]);
  // Once read: the page waits for them to know which block holds a card it is asked to show. A read that fails
  // leaves it none to show (its error is under the field).
  useEffect(() => {
    if (page) onRequests?.(withKept, true);
    else if (loadError) onRequests?.([], false);
  }, [page, loadError, withKept, onRequests]);
  useEffect(() => {
    if (page) onInstalled?.({ release: page.installedRelease ?? null, mergedAfter: page.mergedAfterInstalled ?? null });
  }, [page, onInstalled]);

  // The conversation is the page (YN-212 §3.1): Home's scroller holds it, the newest last next to the dock. It opens
  // at its newest, goes there again after the user's own message, and stays there while the user is there as the
  // keyboard opens or the composer grows (§4.4); scrolled up, it stays where the user is.
  const scroller = () => root.current?.closest<HTMLElement>(".home-view") ?? null;
  const toBottom = useRef(true);
  useLayoutEffect(() => {
    if (mode === "chat") toBottom.current = true;
  }, [mode]);
  useLayoutEffect(() => {
    if (mode !== "chat" || !page || !toBottom.current) return;
    toBottom.current = false;
    const view = scroller();
    if (view) view.scrollTop = view.scrollHeight;
  }, [mode, page, items]);
  useEffect(() => {
    const view = scroller();
    if (mode !== "chat" || !view || typeof ResizeObserver === "undefined") return;
    let atEnd = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
    const scrolled = () => (atEnd = view.scrollHeight - view.scrollTop - view.clientHeight < 24);
    view.addEventListener("scroll", scrolled, { passive: true });
    const observer = new ResizeObserver(() => {
      if (atEnd) view.scrollTop = view.scrollHeight;
    });
    observer.observe(view);
    if (root.current) observer.observe(root.current);
    return () => {
      view.removeEventListener("scroll", scrolled);
      observer.disconnect();
    };
  }, [mode]);

  // A card's "See words": the conversation shown, request n's words in it, read from older pages until they are
  // there. A read that fails ends this ask, its error shown; the next "See words" asks again (#924 R1 7db7e3a9).
  const [wanted, setWanted] = useState<number | null>(null);
  const revealed = useRef(0);
  useEffect(() => {
    if (!reveal || revealed.current === reveal.seq || !page) return;
    if (!byN.has(reveal.n) && hasMore) {
      const seq = reveal.seq;
      if (!readingOlder) void readOlder(() => (revealed.current = seq));
      return;
    }
    revealed.current = reveal.seq;
    if (!byN.has(reveal.n)) return;
    const words = items.find((item) => item.kind === "mine" && item.request.n === reveal.n);
    if (words && words.at < cut) setShowEarlier(true);
    toBottom.current = false;
    setWanted(reveal.n);
    onShowChat?.();
    // The page is drawn by the time this runs; the words' place is read once shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, byN, hasMore, readingOlder, page]);
  useEffect(() => {
    if (wanted === null || mode !== "chat") return;
    const target = wordRefs.current.get(wanted);
    setWanted(null);
    if (!target) return;
    const smooth = !reducedMotion();
    scrollWithinHome(target, "center", smooth);
    target.focus({ preventScroll: true });
    settleWhenLanded(target, "data-home-highlight", smooth, "animation");
  }, [wanted, mode, showEarlier]);

  // What the user writes: one draft per project, a follow-up when it quotes a request.
  const draftSlot = talkSlot(workspaceId, projectId);
  const [draft, setDraft] = useState<Draft>(() => loadDraft(draftSlot));
  const draftNow = useRef(draft);
  draftNow.current = draft;
  // The request quoted, by its number: one not among those read (an older one, kept with the draft) is still that request.
  const quote = draft.quote !== undefined ? { n: draft.quote, title: titleOrNumber(draft.quote) } : null;
  const words: ReplyWords = { text: draft.text, ...(draft.blocks ? { blocks: draft.blocks } : {}), ...(draft.images?.length ? { images: draft.images } : {}), ...(draft.files?.length ? { files: draft.files } : {}) };
  const write = (next: Partial<Draft>) =>
    setDraft((was) => {
      const value: Draft = { ...was, ...next, at: new Date().toISOString() };
      drafts.save(draftSlot, worthKeeping(value) ? value : null);
      return value;
    });
  const sendSlot = talkSlot(workspaceId, projectId, quote?.n);
  const images = draft.images ?? [];
  const files = draft.files ?? [];
  const outgoing = {
    ...trimmed(words),
    ...(images.length ? { images: images.map((image) => image.id) } : {}),
    ...(files.length ? { files } : {}),
  };
  const [busy, setBusy] = useState(false);
  const kept = pendingWords(sendSlot);
  // Kept from a send Core did not answer; not the send under way, which is kept in the slot as it goes.
  const unanswered = !busy && !!kept && kept.text === outgoing.text && JSON.stringify(kept.images ?? []) === JSON.stringify(outgoing.images ?? []) &&
    JSON.stringify(kept.files ?? []) === JSON.stringify(outgoing.files ?? []);
  // Words Core keeps by now, listed with their own delivery, are no longer this page's to send.
  useEffect(() => {
    const ids = new Set(requests.flatMap((r) => [r.messageId, ...r.replies.map((reply) => reply.messageId)]));
    for (const slot of [talkSlot(workspaceId, projectId), ...requests.map((r) => talkSlot(workspaceId, projectId, r.n))]) {
      const words = pendingWords(slot);
      if (words && ids.has(words.clientMessageId)) forgetWords(slot);
    }
  }, [requests, workspaceId, projectId]);
  const [uploading, setUploading] = useState(false);
  const [sendError, setSendError] = useState("");
  const deskId = desk?.effectiveAgentId ?? null;
  const deskName = deskId ? agents.get(deskId)?.name || t.someone : "";
  const blocked = !quote && !deskId;
  // Who takes a new request is known here; a follow-up's Agents only Core knows, and it refuses for them (YN-134 D14, YN-145).
  const deskAgent = deskId ? agents.get(deskId) : undefined;
  const refusal = !quote && deskAgent && !takesImages(deskAgent.harness) ? t.deskNoImages(deskName) : null;
  const filesRefusal = !quote && deskAgent && !agentTakesFiles(deskAgent) ? t.deskNoFiles(deskName) : null;
  // The words could go now, but for a send under way (YN-226: the button shows it is ready, then that they go).
  const ready =
    !readOnly && !blocked && !uploading && !(images.length && refusal) && !(files.length && filesRefusal) && !!outgoing.text &&
    !replyTooLong(words.text);
  const canSend = ready && !busy;

  // Where what the user sends lands (YN-226), told once for each send, by Core's answer or by a read of the requests
  // that lists it first: the page marks its block, or says where it went. A send that fails tells nothing.
  const going = useRef<Going | null>(null);
  const told = useRef(0);
  const [landed, setLanded] = useState<{ selector: string; seq: number } | null>(null);
  const modeNow = useRef(mode);
  modeNow.current = mode;
  function tell(n: number, delivered: boolean, selector: string) {
    const now = going.current;
    if (!now || now.told) return;
    now.told = true;
    told.current += 1;
    // In the conversation the words themselves arrive; the page says where their request is.
    if (modeNow.current === "chat") setLanded({ selector, seq: told.current });
    onArrival?.({ kind: now.kind, n, seq: told.current, fresh: !now.before.has(n), delivered });
  }
  useEffect(() => {
    const now = going.current;
    if (!now || now.told) return;
    if (now.kind === "request") {
      const listed = requests.find((request) => request.messageId === now.id);
      if (listed) tell(listed.n, delivered(listed.delivery), `[data-words="${listed.n}"]`);
      return;
    }
    const request = requests.find((r) => r.n === now.n);
    const reply = request?.replies.find((r) => r.messageId === now.id);
    if (request && reply) tell(request.n, replyDelivered(reply), `[data-reply="${request.n}:${reply.n}"]`);
    // tell reads what is under way when called.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests]);
  const played = useRef(0);
  useLayoutEffect(() => {
    if (!landed || played.current === landed.seq || mode !== "chat") return;
    const said = root.current?.querySelector<HTMLElement>(landed.selector);
    // Drawn with the next read of the requests: this runs again then.
    if (!said) return;
    played.current = landed.seq;
    arriveIn(said, false);
    markArrived(said);
  }, [landed, mode, items]);

  async function send() {
    if (!canSend) return;
    // The draft as it goes: what the user writes, attaches or chooses meanwhile stays (afterSent).
    const sent = draft;
    setBusy(true);
    setSendError("");
    onDismissNotice?.();
    const sending = sendWords(sendSlot, projectId, workspaceId, outgoing, quote?.n);
    // The words' client ID, kept in their slot before anything goes.
    const id = pendingWords(sendSlot)?.clientMessageId;
    going.current = id
      ? { id, kind: quote ? "follow" : "request", n: quote?.n, before: new Set(requests.map((r) => r.n)), told: false }
      : null;
    try {
      const answer = await sending;
      const focused = !!formRef.current?.contains(document.activeElement);
      setDraft((was) => {
        const next = afterSent(was, sent);
        drafts.save(draftSlot, worthKeeping(next) ? next : null);
        return next;
      });
      // Words written meanwhile stay where the user was writing them, at their end.
      if (focused && afterSent(draftNow.current, sent).text) requestAnimationFrame(() => composer.current?.focusEnd());
      if (answer.request) {
        // Drawn from Core's answer at once; the read below lists it too.
        const request = answer.request;
        confirmed.current.requests.set(request.n, request);
        setPage((was) => (was ? withConfirmed(was, confirmed.current.requests) : was));
        tell(request.n, delivered(request.delivery), `[data-words="${request.n}"]`);
      } else if (quote && answer.reply !== null) {
        tell(quote.n, answer.receipts.length > 0 && answer.receipts.every((r) => delivered(r.status)), `[data-reply="${quote.n}:${answer.reply}"]`);
      }
      toBottom.current = true;
      setReads((n) => n + 1);
    } catch (e) {
      going.current = null;
      // An older Core refused the images or files before reading anything: nothing was sent, and the draft stays.
      if (olderCoreImages(e) || olderCoreFiles(e)) {
        forgetWords(sendSlot);
        setSendError(olderCoreFiles(e) ? t.olderCoreFiles : t.olderCoreImages);
      } else setSendError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function followUp(n: number) {
    write({ quote: n });
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

  // The user's confirmation that a request is done (YN-184): its error stays on the request until the next try.
  const [confirming, setConfirming] = useState<ReadonlySet<number>>(new Set());
  const [confirmErrors, setConfirmErrors] = useState<ReadonlyMap<number, string>>(new Map());
  async function confirm(n: number) {
    setConfirming((was) => new Set(was).add(n));
    setConfirmErrors((was) => {
      const next = new Map(was);
      next.delete(n);
      return next;
    });
    try {
      await confirmRequest(projectId, n, workspaceId);
    } catch (e) {
      setConfirmErrors((was) => new Map(was).set(n, errorText(e)));
    } finally {
      setConfirming((was) => {
        const next = new Set(was);
        next.delete(n);
        return next;
      });
      setReads((r) => r + 1);
    }
  }

  useEffect(() => {
    const numbers = new Set([...resending].filter((id) => id.startsWith("r:")).map((id) => Number(id.slice(2))));
    const followUps = new Map<number, Set<number>>();
    for (const id of resending) {
      if (!id.startsWith("f:")) continue;
      const [n, m] = id.slice(2).split(":").map(Number);
      followUps.set(n, (followUps.get(n) ?? new Set()).add(m));
    }
    onBusy?.({ confirming, resending: numbers, followUps, errors: confirmErrors });
  }, [confirming, resending, confirmErrors, onBusy]);
  // A block's action (YN-212 §3.2), once for each `seq`.
  const ran = useRef(0);
  useEffect(() => {
    if (!command || ran.current === command.seq) return;
    ran.current = command.seq;
    if (command.kind === "follow") followUp(command.n);
    else if (command.kind === "confirm") void confirm(command.n);
    else {
      const request = byN.get(command.n);
      const reply = command.reply === undefined ? undefined : request?.replies.find((r) => r.n === command.reply);
      // The same IDs the conversation sends them again by, so either shows the other's under way.
      if (request && reply) void resend(`f:${command.n}:${reply.n}`, request, reply);
      else if (request && command.reply === undefined) void resend(`r:${command.n}`, request);
    }
    // Run when a new command comes; the draft and the requests are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

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
  /** The images a request or follow-up took (YN-134), to open, or mark up into what is written now. */
  const sentImages = (ids: readonly string[], provenance: string) =>
    ids.length > 0 && (
      <ImageAttachments
        images={ids.map((id) => ({ id }))}
        imageUrl={(id, thumb) => homeImageUrl(projectId, id, thumb)}
        onAnnotate={readOnly ? undefined : (image) => composer.current?.markUp?.(image, provenance)}
      />
    );
  /** The files a request or follow-up took (YN-145), to download from the Project. */
  const sentFiles = (list: readonly HomeFile[]) =>
    list.length > 0 && (
      <FileAttachments files={list} href={(file) => homeFileUrl(projectId, file.id, file.name)} projectId={projectId} />
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
            {/* Words a proposal opened (YN-237 ④): the lead's, which the user chose to make a request. */}
            {request.from && <p className="project-talk-from">{t.openedFrom(request.from.n)}</p>}
            <div className="project-talk-bubble">
              <MessageContent text={request.text} blocks={request.textBlocks ?? undefined} />
              {sentImages(request.images, `an image in your request R-${n} to ${projectName}`)}
              {sentFiles(request.files)}
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
                aria-label={t.toRequestLabel(titleOf(request))}
                onClick={() => onShowRequest?.(n)}
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
              {sentImages(reply.images, `an image in your follow-up to request R-${n} to ${projectName}`)}
              {sentFiles(reply.files)}
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
              <button type="button" className="talk-link" onClick={() => onShowRequest?.(n)}>
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
  // The composer (YN-212 §4): in Home's dock when there is one, under the conversation otherwise.
  const form = (
    <form
      ref={formRef}
      className={`project-talk-compose${dock ? " project-dock-form" : ""}`}
      data-quoting={quote ? "" : undefined}
      data-state={busy ? "sending" : ready ? "ready" : "idle"}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onFocus={() => quote && onFocusTarget?.(quote.n)}
    >
      {/* Above the field, over the page (YN-226): where what was just sent went, while its block is not in sight; and,
          under reduced motion, that the words are going, which the spinner says otherwise. */}
      <div className="project-talk-arrival" role="status" data-sending={busy ? "" : undefined}>
        {busy ? (
          <span className="project-talk-notice" data-tone="quiet">{t.sending}</span>
        ) : notice ? (
          <span key={notice.seq} className="project-talk-notice" data-tone={notice.delivered ? undefined : "attention"}>
            <span className="project-talk-notice-text">
              {notice.kind === "follow" ? t.added(notice.n) : notice.delivered ? t.recorded(notice.n) : t.recordedUndelivered(notice.n)}
            </span>
            <button
              type="button"
              className="talk-link"
              aria-label={t.showArrivedLabel(notice.n)}
              onClick={() => {
                onDismissNotice?.();
                onShowRequest?.(notice.n);
              }}
            >
              {t.showArrived}
            </button>
            <button type="button" className="icon-button" aria-label={t.dismissArrived} onClick={() => onDismissNotice?.()}>
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ) : null}
      </div>
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
          oneLine
          onWords={(next) => write({ text: next.text, blocks: next.blocks, images: next.images, files: next.files })}
          onSubmit={() => void send()}
          readOnly={readOnly || blocked}
          onEscape={quote ? () => write({ quote: undefined }) : undefined}
          attach={readOnly ? undefined : { projectId, refusal, files: { refusal: filesRefusal } }}
          onUploading={setUploading}
        />
        <button
          type="submit"
          className="primary-button project-talk-send"
          aria-label={t.send}
          aria-busy={busy || undefined}
          disabled={!canSend}
          // A press of Send leaves the focus where it was (YN-226): the user writes on, and a phone's keyboard stays up.
          onMouseDown={(event) => event.preventDefault()}
        >
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
      {deskId && !quote ? (
        <p className="project-talk-hint">{t.hint(deskName)}</p>
      ) : desk && !deskId ? (
        // Why the field takes nothing, where it is.
        <p className="project-talk-hint" data-missing="">
          {leadCount > 0 ? t.noDesk : t.noLead}{" "}
          {!readOnly && (
            <button type="button" className="talk-link" onClick={() => onNavigate({ kind: "projectSettings", projectId })}>
              {t.chooseDesk}
            </button>
          )}
        </p>
      ) : null}
    </form>
  );
  return (
    <>
      <section
        ref={root}
        className="project-talk project-talk-page"
        id={`project-talk-chat-${projectId}`}
        aria-label={t.tabChat}
        hidden={mode !== "chat"}
      >
        {!page && !loadError && <p className="home-note">{t.reading}</p>}
        {page && !requests.length && <p className="home-note">{t.noRequests}</p>}
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
        {dock === undefined && form}
      </section>
      {dock && createPortal(form, dock)}
    </>
  );
}
