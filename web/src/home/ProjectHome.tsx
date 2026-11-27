import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Eye, LoaderCircle, Settings } from "lucide-react";
import { errorText } from "../api";
import { PendingCard } from "../components";
import { useMessageLinks } from "../deep-link";
import { lifecycleText } from "../executor-lifecycle";
import { useLanguage, useStrings } from "../i18n";
import { projectColour } from "../project-groups";
import type { Agent, PendingRequest } from "../types";
import { changedSinceSeen, requestDomId, sectionDomId } from "./brief-layout";
import { settleWhenLanded } from "../settle";
import { arriveIn } from "../surface";
import { inSight, markArrived, whenInSight } from "./request-arrival";
import { unfoldAround } from "./card-fold";
import { DeckSizes } from "./card-sizes";
import { relative } from "./format";
import { homeText } from "./home-text";
import type { HomeTarget } from "./home-navigation";
import type { SeenMark } from "./home-api";
import { askKey, HomeJumps, nextAsk, scrollWithinHome, waitingAsks } from "./HomeJumps";
import { RefreshHome } from "./home-tools";
import { History30, ProjectFacts, RepoBlock } from "./HomePanel";
import { ProjectTalk, type InstalledFacts, type TalkArrival, type TalkBusy, type TalkCommand, type TalkOlder } from "./ProjectTalk";
import { savedView, saveView, type TalkView } from "./project-talk";
import type { ProjectRequest } from "./project-talk-api";
import { ProjectTalkLink, type TalkLink } from "./talk-link";
import { talkText } from "./talk-text";
import { openTask } from "./CardResponsible";
import { KeptCardReplies, referableHistory } from "./CardReply";
import {
  askUpFront, blockCounts, blockOfSection, headChanges, openAsk, pageBlocks, projectLine, type BlockAction, type BlockGroup, type RequestBlock, commonTasks,
  relatedRequests,
} from "./request-blocks";
import { blockText, ProjectAsks, RequestBlockView, useAsksUpFront, type BlockCommon, type BlockView, type ThreadFocus } from "./RequestBlocks";
import { ProjectHead } from "./ProjectHead";
import type { OpenDeliveredReport } from "./DeliverableLine";
import { projectUnseen } from "./unseen";
import type { NeedsYouItem, ProjectPanel, Section } from "./types";
import "./project-home.css";
import { Tip, TipText } from "../Tip";

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The width at which the team's facts stand beside the requests, not below them (YN-86 §2.2): the blocks' 920 px
 * at most and the cards in them, the gap (18) and the team's own 300 px (YN-157). */
const TEAM_BESIDE = 1250;

/**
 * Where each request's block stands in this visit (YN-212 §3.1), as the cards' places were held (card-sizes.ts): its
 * group and its place in it as first shown, so a block the user just answered does not move from under their
 * finger. A request the user confirms goes to Done. One shown later comes in at the top of its group when it is newer
 * than every request shown so far, in the page's own order; older ones read from the pages before (Read older
 * requests) come after those shown, newest first (PR 1093 R1). The Project's own block is in no group (R-27): its
 * Asks keep their places in Needs you by themselves (useAsksUpFront).
 *
 * Nothing is held until the page has read both its sections and its requests (ready): before the requests, the
 * Project's own block holds every card, a request's open Ask among them, so the groups shown then are not the
 * page's. A new visit holds them afresh, as it does the groups.
 */
function useHeldBlocks(projectId: string, blocks: readonly RequestBlock[], ready: boolean) {
  const sizes = useContext(DeckSizes);
  const visit = sizes?.visit ?? 0;
  const order = useRef({ visit, place: new Map<string, number>(), newest: 0 });
  if (order.current.visit !== visit) order.current = { visit, place: new Map(), newest: 0 };
  if (!ready) {
    const now = (group: BlockGroup) => blocks.filter((block) => block.group === group);
    return { needs: now("needs"), doing: now("doing"), done: now("done") };
  }
  const now = blocks.map((block) => [block.key, block.group] as const);
  const held = sizes ? sizes.groups(`${projectId}#requests`, now) : new Map(now);
  const groupOf = (block: RequestBlock): BlockGroup => {
    const first = held.get(block.key) ?? block.group;
    return block.group === "done" || first === "done" ? block.group : first;
  };
  const { place } = order.current;
  const fresh = place.size === 0;
  let top = Math.min(0, ...place.values());
  let bottom = Math.max(0, ...place.values());
  const unseen = blocks.filter((block) => !place.has(block.key));
  const newer = unseen.filter((block) => !fresh && block.request.n > order.current.newest);
  // The newer ones above all, the newest first: placed from the oldest up.
  for (const block of [...newer].reverse()) place.set(block.key, --top);
  unseen.forEach((block, index) => {
    if (!place.has(block.key)) place.set(block.key, fresh ? index : ++bottom);
  });
  order.current.newest = Math.max(order.current.newest, ...blocks.map((block) => block.request.n));
  const sorted = (group: BlockGroup) =>
    blocks.filter((block) => groupOf(block) === group).sort((a, b) => place.get(a.key)! - place.get(b.key)!);
  return {
    needs: sorted("needs"),
    doing: sorted("doing"),
    done: sorted("done"),
  };
}

/**
 * One Project's page on Home (YN-212 §3, by request; YN-86 §2.2): its header
 * and tools, where the project stands (R-27, in both views), its own jumps
 * with "Requests | Conversation" beside them in one bar (R-36), then each request once
 * in three groups (needs you, in progress, done), what belongs to no request
 * (its Asks in Needs you, its cards in a group of their own after In progress,
 * R-27), and the team and its running work beside them
 * where the page is wide enough; or the conversation with the project. Its
 * composer stays in Home's dock (§4). It shows the same Brief sections as its
 * panel on Home, never a copy; every card is read on its own page and answered
 * in place.
 */
export function ProjectHome({
  projectId,
  panel,
  workspaceId,
  agents,
  needsYou,
  readOnly,
  refreshing,
  onRefresh,
  onNavigate,
  onChanged,
  onSeen,
  focus = null,
  arrival = null,
  revision = 0,
  onExit,
  dock,
}: {
  projectId: string;
  /** The project's facts as read; null when Core no longer lists it. */
  panel: ProjectPanel | null;
  workspaceId: string;
  /** The project's open Agents, the ones a reply can go to. */
  agents: Agent[];
  /** Core's Needs you, for this project only. */
  needsYou: NeedsYouItem[];
  readOnly: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onNavigate: (target: HomeTarget) => void;
  onChanged: () => void;
  onSeen: (projectId: string, marks: SeenMark[]) => Promise<void>;
  /** A card to show, or the top of the page: another jump is another `n`. */
  focus?: { key?: string; n: number } | null;
  /** Where a reply's "Open on Home" landed on this page (T-9): the note in the card it answered, or above the
   * requests when that card is gone. */
  arrival?: { key: string; inCard: boolean; note: ReactNode } | null;
  /** Home's reads: "Talk to the project" reads its requests again with each. */
  revision?: number;
  /** Back to the whole of Home. */
  onExit: () => void;
  /** Home's dock under its scroller (YN-212 §4.1), where "Talk to the project" keeps its composer; null until it is
   * laid out. Without one the composer stays in the conversation. */
  dock?: HTMLElement | null;
}) {
  const language = useLanguage();
  const t = homeText(language);
  const tb = blockText(language);
  const tt = talkText(language);
  const life = useStrings(lifecycleText);
  const root = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [seeingAll, setSeeingAll] = useState(false);
  const [seenError, setSeenError] = useState("");
  const lastAsk = useRef<string | null>(null);
  const id = panel?.project.id ?? projectId;
  // The requests "Talk to the project" reads, for the blocks and the cards' "See words" (YN-86 §4.5).
  // null until "Talk to the project" has read them once.
  const [talkRequests, setTalkRequests] = useState<readonly ProjectRequest[] | null>(null);
  // Whether they were read: none read because the read failed is not none to read (R-38 §2.1, the lead's 12534).
  const [requestsKnown, setRequestsKnown] = useState(false);
  const takeRequests = useCallback((read: readonly ProjectRequest[], known: boolean) => {
    setTalkRequests(read);
    setRequestsKnown(known);
  }, []);
  const [installed, setInstalled] = useState<InstalledFacts | null>(null);
  const requests = useMemo(() => talkRequests ?? [], [talkRequests]);
  const [reveal, setReveal] = useState<{ n: number; seq: number } | null>(null);
  const [older, setOlder] = useState<TalkOlder | null>(null);
  const [busy, setBusy] = useState<TalkBusy | null>(null);
  const [command, setCommand] = useState<TalkCommand | null>(null);
  // What the user just sent (YN-226), and, while its block is not in sight, where it went, said above the composer.
  const [justSent, setJustSent] = useState<TalkArrival | null>(null);
  const [sentNotice, setSentNotice] = useState<TalkArrival | null>(null);
  // Requests or Conversation (§3.1), this device's choice for the project; "both" from before reads as Requests.
  const [view, setView] = useState<TalkView>(() => savedView(workspaceId, projectId));
  const chooseView = (next: TalkView) => {
    setView(next);
    saveView(workspaceId, projectId, next);
  };
  const talkLink = useMemo<TalkLink>(
    () => ({ requests, reveal: (n) => setReveal((was) => ({ n, seq: (was?.seq ?? 0) + 1 })), showCard }),
    // showCard reads the page when called.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requests, id],
  );
  const sections = panel?.brief.sections ?? [];
  const team = panel?.brief.teamSections;
  const history = panel?.brief.history;
  // Every section the requests' tasks may have: the leads', the team's, and History's (a card archived with its task).
  const all = useMemo(() => [...sections, ...(team ?? []), ...(history ?? [])], [sections, team, history]);
  const { blocks, project: projectBlock } = useMemo(() => pageBlocks(requests, all), [requests, all]);
  const groups = useHeldBlocks(id, blocks, panel !== null && talkRequests !== null);
  const upFront = useAsksUpFront([...blocks.flatMap((block) => block.asks), ...(projectBlock?.asks ?? [])]);
  // Requests only (R-27 §3.7): the Project's own Asks are counted on their own, its cards not at all.
  const counts = blockCounts(blocks);
  const projectAsks = projectBlock?.asks ?? [];
  // With no request on the page, the Project's cards are all of it: Other starts open, as its cards were. A block the
  // user opened or closed, or a jump opened, stays as it was left.
  const alone = talkRequests !== null && blocks.length === 0;
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const isOpen = (key: string) => chosen.get(key) ?? (key === "project" && alone);
  const choose = (key: string, open: boolean) =>
    setChosen((was) => {
      if (was.get(key) === open) return was;
      const next = new Map(was);
      next.set(key, open);
      return next;
    });
  const openBlock = (key: string) => choose(key, true);
  // What each request's block shows unfolded (R-45 §3.4), as the user or a jump last chose it; its cards at first.
  const [views, setViews] = useState<ReadonlyMap<string, BlockView>>(() => new Map());
  const showView = (key: string, to: BlockView) => {
    setViews((was) => (was.get(key) === to ? was : new Map(was).set(key, to)));
    openBlock(key);
  };
  // The jump that landed in a request's conversation: its lines stay marked until that block folds or the next jump.
  const [thread, setThread] = useState<(ThreadFocus & { block: string }) | null>(null);
  // Each jump its own number, also after a fold cleared the last one: a block lands each once (RequestThread).
  const jumps = useRef(0);
  const toggleBlock = (key: string) => {
    if (isOpen(key)) setThread((was) => (was?.block === key ? null : was));
    choose(key, !isOpen(key));
  };
  const editorIds = panel?.contentEditors?.editorAgentIds ?? null;
  // The Project's head (YN-237 ①): the lead's one line across requests, and "Other", the Project's cards of no request
  // besides it with its Asks answered before this visit; what changed in each request since the user last read it.
  // Of the leads' own sections only: the team's (a member no longer a lead) are no line across requests.
  const line = useMemo(() => {
    const leads = new Set(sections.map((s) => s.key));
    return projectBlock ? projectLine(projectBlock.sections.filter((s) => leads.has(s.key)), editorIds) : null;
  }, [projectBlock, editorIds, sections]);
  const others = [...(projectBlock?.sections ?? []).filter((section) => section.key !== line?.key), ...projectAsks.filter((ask) => !upFront(ask))];
  const changes = useMemo(() => headChanges(blocks), [blocks]);
  const executors = needsYou.filter((item) => item.kind === "executor");
  const pending = panel?.pending ?? [];
  // What needs the user (§3.4): the blocks in Needs you, the approvals, the executors' matters and the Project's
  // own open Asks (R-27 §3.7).
  const needsCount = counts.needs + pending.length + executors.length + projectAsks.filter(openAsk).length;
  // What the Needs you group holds on the page: its blocks as this visit holds them (useHeldBlocks), so a block
  // whose Ask the user just answered stays where it was, the approvals, the executors' matters and the Project's
  // own Asks shown up front, one answered in this visit among them. The chip above counts what needs the user now
  // (needsCount).
  const needsShown = groups.needs.length + pending.length + executors.length + projectAsks.filter(upFront).length;
  const unseen = panel ? projectUnseen(panel) : 0;
  const changed = sections.filter(changedSinceSeen).length;
  const asks = waitingAsks(needsYou);
  // Live sections, shown or kept out of view, and the History entries a reply may still refer to (T-174).
  const live = useMemo(() => [...sections, ...(team ?? [])], [sections, team]);
  const referable = useMemo(() => referableHistory(history ?? [], live.map((s) => s.key)), [history, live]);
  // History the blocks do not show: a report seen, a section removed, an Ask resolved, bound to no request's task.
  const shownKeys = useMemo(
    () => new Set(blocks.flatMap((block) => block.tasks.flatMap((row) => [row.card, ...row.asks, ...row.earlier]).map((s) => s?.key))),
    [blocks],
  );
  const restOfHistory = useMemo(() => (history ?? []).filter((s) => !shownKeys.has(s.key)), [history, shownKeys]);
  // The live report updated last on this project, as Home's jump goes to it.
  const latest = useMemo(() => {
    let found: { section: Section; at: number } | null = null;
    for (const section of sections) {
      if (section.kind !== "report" || section.history) continue;
      const at = Date.parse(section.updatedAt);
      if (!Number.isFinite(at) || (found && at <= found.at)) continue;
      found = { section, at };
    }
    return found?.section ?? null;
  }, [sections]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const read = () => setWide(element.clientWidth >= TEAM_BESIDE);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  /**
   * Scrolls to `target`, opens the card or fold that holds it, and settles once it has landed. `keepFolded`: the
   * user folded it while this landing waited, and it stays as they left it (YN-227, the lead's comment 12405).
   */
  function jumpTo(target: HTMLElement | null, block: ScrollLogicalPosition = "center", keepFolded = false) {
    if (!target) return;
    const smooth = !reducedMotion();
    const show = () => {
      scrollWithinHome(target, block, smooth);
      target.focus({ preventScroll: true });
      settleWhenLanded(target, "data-home-highlight", smooth);
    };
    if (!keepFolded && unfoldAround(target)) requestAnimationFrame(show);
    else show();
  }
  // A jump into a block (§3.4): the requests shown, the block opened, then the jump once it is drawn.
  const [landing, setLanding] = useState<{ key: string | null; block: string; seq: number; keepFolded?: boolean } | null>(null);
  const landed = useRef(0);
  useEffect(() => {
    if (!landing || landed.current === landing.seq) return;
    landed.current = landing.seq;
    const target = landing.key
      ? document.getElementById(sectionDomId(id, landing.key))
      : root.current?.querySelector<HTMLElement>(`[data-block-key="${landing.block}"]`) ?? null;
    jumpTo(target, landing.key ? "center" : "start", landing.keepFolded);
    // Run once the block it opened is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing, chosen, view]);
  /**
   * Shows the block a section is in, opened, and lands on the section; false when no block holds it. An open Ask is
   * in its block's first look (W5): the jump lands on it and opens nothing.
   */
  function showSection(key: string, keepFolded = false) {
    const block = blockOfSection(key, blocks, projectBlock);
    if (!block) return false;
    if (view !== "requests") setView("requests");
    // A card or an Ask of a request's task is in its unfolded block (R-45 §3.4, YN-237 ②); the Project's cards are
    // under the head's "Other", opened; the lead's card is its line there.
    if (block === "project") {
      if (key !== line?.key) openBlock(block);
    } else if (!askUpFront(key, blocks, projectBlock)) showView(block, "cards");
    setLanding((was) => ({ key, block, seq: (was?.seq ?? 0) + 1, keepFolded }));
    return true;
  }
  /** The head's count of a group (YN-237 ①): the requests shown, that group at the top, Done opened. */
  function showGroup(group: BlockGroup) {
    if (view !== "requests") setView("requests");
    requestAnimationFrame(() => {
      const element = root.current?.querySelector<HTMLElement>(`.request-group[data-group="${group}"]`);
      if (!element) return;
      if (element instanceof HTMLDetailsElement) element.open = true;
      scrollWithinHome(element, "start", !reducedMotion());
      // Tab goes on from the group: its summary (Done), else its first request's title.
      element.querySelector<HTMLElement>("summary.request-group-title, .request-block-title")?.focus({ preventScroll: true });
    });
  }
  /** Shows request `n`'s block, opened at its cards, at the top of the page. */
  function showBlock(n: number) {
    if (view !== "requests") setView("requests");
    showView(`r${n}`, "cards");
    setLanding((was) => ({ key: null, block: `r${n}`, seq: (was?.seq ?? 0) + 1 }));
  }
  /**
   * Shows request `n`'s conversation (R-45 §3.4): the requests shown, its block opened at its conversation; with
   * `focus`, landed on that follow-up (RequestThread), it and the lines named with it marked.
   */
  function showThread(n: number, focus?: Omit<ThreadFocus, "seq">) {
    if (view !== "requests") setView("requests");
    showView(`r${n}`, "thread");
    if (focus) setThread({ ...focus, block: `r${n}`, seq: ++jumps.current });
  }
  /** A card a request went to: shown in its block; where it is no longer here, its task, which keeps its result. */
  function showCard(key: string | null, task?: string | null) {
    if (key && showSection(key)) return;
    const card = key ? document.getElementById(sectionDomId(id, key)) : null;
    if (card) jumpTo(card);
    else if (task) openTask(task);
  }
  // A block's action (§3.2): Answer goes to its Ask; the rest run where the draft and Core's answers are kept.
  function blockAction(action: BlockAction, n: number, focusKey?: string) {
    if (action === "answer" && focusKey && showSection(focusKey)) return;
    if (action === "answer") return showBlock(n);
    setCommand((was) => ({ kind: action, n, seq: (was?.seq ?? 0) + 1 }));
  }
  /** The composer took focus following up request `n` (§4.4): its block stays in view above the dock and keyboard. */
  const keepTarget = useCallback((n: number) => {
    window.setTimeout(() => {
      const element = document.querySelector<HTMLElement>(`[data-request-block="${n}"]`);
      if (element) scrollWithinHome(element, "nearest", !reducedMotion());
    }, 320);
  }, []);
  // What the user just sent lands (YN-226), once its block is drawn: a new request's block arrives in its place, from
  // a little below, its gap opening; one already on the page before the send (the same words sent again) or the one
  // followed up is only marked. Not in sight (scrolled past, under the keyboard, or the conversation shown), the page
  // says where it went above the composer, without moving or taking the focus, and marks the block once it comes
  // into sight. Nothing else arrives this way: what a read brings is drawn as it is.
  const shownSent = useRef(0);
  const watching = useRef<(() => void) | null>(null);
  const dismissNotice = useCallback(() => {
    watching.current?.();
    watching.current = null;
    setSentNotice(null);
  }, []);
  useEffect(() => () => watching.current?.(), []);
  useLayoutEffect(() => {
    if (!justSent || shownSent.current === justSent.seq) return;
    const block = root.current?.querySelector<HTMLElement>(`[data-request-block="${justSent.n}"]`) ?? null;
    // Not drawn yet (in either view; the conversation's page keeps the blocks, hidden): its requests are read next,
    // and this runs again. Read and still not drawn: shown nowhere here.
    if (!block && !requests.some((request) => request.n === justSent.n)) return;
    shownSent.current = justSent.seq;
    watching.current?.();
    watching.current = null;
    if (!block || view === "chat" || !inSight(block)) {
      setSentNotice(justSent);
      if (block)
        watching.current = whenInSight(block, block.closest<HTMLElement>(".home-view"), () => {
          watching.current = null;
          setSentNotice((was) => (was?.seq === justSent.seq ? null : was));
          markArrived(block);
        });
      return;
    }
    setSentNotice(null);
    if (justSent.kind === "request" && justSent.fresh) arriveIn(block, true);
    markArrived(block);
  }, [justSent, view, requests, blocks]);
  /** The page opened, not a card on it: its top, with the focus on its heading so Tab goes on from there. The page
   * is no card and takes no card's mark (R-23): that mark would frame the whole page. */
  function toTop() {
    const page = root.current;
    if (!page) return;
    scrollWithinHome(page, "start", !reducedMotion());
    page.querySelector<HTMLElement>(".project-home-head h1")?.focus({ preventScroll: true });
  }
  const jumped = useRef(0);
  // A card a landing waits for (the requests not read yet) may already be drawn (W5), and the user may fold it
  // meanwhile: that fold is theirs, and the landing that comes later keeps it (YN-227, the lead's comment 12405).
  // Another "Open on Home" is another landing, and unfolds it.
  const foldedWhileLanding = useRef<{ n: number; key: string } | null>(null);
  useEffect(() => {
    const page = root.current;
    if (!focus?.key || jumped.current === focus.n || !page) return;
    const { n, key } = focus;
    const onFold = (event: Event) => {
      const fold = (event.target as Element | null)?.closest?.(".home-fold");
      const card = document.getElementById(sectionDomId(id, key));
      if (!fold || !card?.contains(fold)) return;
      // The user's last choice counts (review 63e8f668): a fold opened again is no fold to keep.
      foldedWhileLanding.current = fold.getAttribute("aria-expanded") === "true" ? { n, key } : null;
    };
    page.addEventListener("click", onFold, true);
    return () => page.removeEventListener("click", onFold, true);
  }, [focus, id]);
  useEffect(() => {
    if (!focus || jumped.current === focus.n) return;
    // A card is in its request's block: wait until the requests are read to know which.
    if (focus.key && talkRequests === null) return;
    jumped.current = focus.n;
    if (!focus.key) return toTop();
    const keepFolded = foldedWhileLanding.current?.n === focus.n && foldedWhileLanding.current.key === focus.key;
    if (showSection(focus.key, keepFolded)) return;
    jumpTo(document.getElementById(sectionDomId(id, focus.key)), "center", keepFolded);
    // The page is drawn by the time this runs, its read or its first render; a card in a block waits for the requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, talkRequests]);
  const toAsk = () => {
    const item = nextAsk(asks, lastAsk.current);
    if (!item?.sectionKey) return;
    lastAsk.current = askKey(item);
    if (showSection(item.sectionKey)) return;
    jumpTo(document.getElementById(sectionDomId(id, item.sectionKey)));
  };
  const toReport = () => {
    if (!latest || showSection(latest.key)) return;
    jumpTo(document.getElementById(sectionDomId(id, latest.key)));
  };
  async function seenAll() {
    setSeeingAll(true);
    setSeenError("");
    try {
      await onSeen(id, sections.map((section) => ({ key: section.key, version: section.version })));
    } catch (e) {
      setSeenError(errorText(e));
    } finally {
      setSeeingAll(false);
    }
  }
  const links = useMessageLinks();
  const onReport: OpenDeliveredReport = (link) => links?.openReport({ workspaceId, projectId: id, ...link });
  if (!panel) {
    return (
      <div className="project-home" data-project-home={id}>
        <p className="home-note">{t.projectMissing}</p>
        <button type="button" className="quiet-button" onClick={onExit}>
          {t.allProjects}
        </button>
      </div>
    );
  }
  // The team's members: leads first, then the other Agents, then its executors (YN-86 §2.2).
  const members = [...agents].sort((a, b) => {
    const rank = (agent: Agent) =>
      editorIds?.includes(agent.id) ? 0 : agent.kind === "lead" ? 1 : agent.executor ? 3 : 2;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  const notice = (section: Section) => (arrival?.inCard && arrival.key === section.key ? arrival.note : undefined);
  const taskLine = (agent: Agent) => {
    const task = agent.executor?.task;
    const name = task ? `${task.id} · ${task.shortName || task.title}` : t.noTask;
    const state = agent.executor?.state ? life.states[agent.executor.state] : "";
    return [name, state].filter(Boolean).join(" · ");
  };
  // R-38 §2.4: what the lead's card names as common items, by task; a request waiting on one points to it.
  const common: BlockCommon = { projectId: id, workspaceId, agents, readOnly, onSeen: (marks) => onSeen(id, marks), onChanged, onReport, notice, upFront,
    commonTasks: new Set(commonTasks(line)), onShowNow: () => jumpTo(root.current?.querySelector<HTMLElement>(".now-hero") ?? null, "start") };
  const teamFacts = (
    <>
      <ul className="project-team-members">
        {members.map((agent) => (
          <li key={agent.id}>
            <button type="button" className="project-team-member" onClick={() => onNavigate({ kind: "agent", agentId: agent.id })}>
              <span className={`status-dot ${agent.status}`} aria-hidden />
              <span className="project-team-name">{agent.name}</span>
              <span className="project-team-badge">
                {editorIds?.includes(agent.id) || agent.kind === "lead"
                  ? t.leadBadge
                  : agent.executor
                    ? t.executorBadge
                    : null}
              </span>
              {agent.executor && <small>{taskLine(agent)}</small>}
            </button>
          </li>
        ))}
      </ul>
      <ProjectFacts panel={panel} onNavigate={onNavigate} />
      <RepoBlock projectId={id} readOnly={readOnly} onManage={() => onNavigate({ kind: "projectSettings", projectId: id })} />
    </>
  );
  const viewChanges = (request: PendingRequest) => () =>
    onNavigate({
      kind: "changes",
      agentId: request.agentId,
      requestId: request.id,
      turnId: typeof request.params.turnId === "string" ? request.params.turnId : undefined,
      itemId: typeof request.params.itemId === "string" ? request.params.itemId : undefined,
    });
  const blockView = (block: RequestBlock) => (
    <RequestBlockView
      key={block.key}
      block={block}
      open={isOpen(block.key)}
      view={views.get(block.key)}
      onToggle={() => toggleBlock(block.key)}
      onView={(to) => showView(block.key, to)}
      focus={thread?.block === block.key ? thread : null}
      onShowThread={showThread}
      onResendFollowUp={(n, m) => setCommand((was) => ({ kind: "resend", n, reply: m, seq: (was?.seq ?? 0) + 1 }))}
      resendingFollowUps={busy?.followUps.get(block.request.n)}
      onAction={blockAction}
      onShowBlock={showBlock}
      onDecide={(key) => showSection(key)}
      busy={!!busy && (busy.confirming.has(block.request.n) || busy.resending.has(block.request.n))}
      error={busy?.errors.has(block.request.n) ? tt.confirmFailed(busy.errors.get(block.request.n)!) : undefined}
      common={common}
    />
  );
  // Needs you (§3.1): the approvals and executors' matters, then the blocks waiting for the user, then the Project's
  // own Asks, each on its own (R-27 §3.5).
  const needs = (
    <>
      {pending.map((request) => (
        <div key={request.id} id={requestDomId(request.id)} tabIndex={-1} className="home-approval">
          <span className="home-from">{t.from(request.agentName)}</span>
          <PendingCard request={request} refresh={onChanged} disabled={readOnly} onViewChanges={viewChanges(request)} />
        </div>
      ))}
      {executors.map((item) => (
        <button
          key={`${item.agentId}:${item.state}`}
          type="button"
          className="project-deck-executor"
          onClick={() => onNavigate({ kind: "agent", agentId: item.agentId })}
        >
          <span className="home-needs-source">
            {t.from(item.agentName)} · {item.state ? t.executorNeeds[item.state] : ""}
          </span>
          <strong>{item.taskId ? `${item.taskId} · ${item.title}` : item.title}</strong>
          <small>{relative(item.since, language)}</small>
        </button>
      ))}
      {groups.needs.map(blockView)}
      {projectBlock && <ProjectAsks block={projectBlock} common={common} />}
    </>
  );
  // The requests' read failed: neither "none" nor "nothing here" can be said.
  const unread = talkRequests !== null && !requestsKnown;
  const empty = !needsShown && !groups.doing.length && !groups.done.length && !projectBlock && !restOfHistory.length;
  return (
    <ProjectTalkLink.Provider value={talkLink}>
    <div className="project-home" data-project-home={id} data-view={view} ref={root}>
      <header className="home-header project-home-head">
        {/* Where focus returns from a report whose card has left the page (Home.tsx). */}
        <h1 tabIndex={-1}>
          <span className="project-dot" style={{ background: projectColour(id) }} aria-hidden />
          {panel.project.name}
          <span className="home-panel-chips">
            {needsCount > 0 && <span className="home-chip is-attention">{t.needCount(needsCount)}</span>}
            {/* R-38 §2.7: updated, never a to-do: a quiet chip, not counted with Needs you. */}
            {unseen > 0 && <span className="home-chip is-new is-quiet">{t.newCount(unseen)}</span>}
          </span>
        </h1>
        <span className="home-header-tools">
          {changed > 0 && !readOnly && (
            <button type="button" className="quiet-button" disabled={seeingAll} onClick={() => void seenAll()}>
              {seeingAll ? <LoaderCircle size={13} className="spin" /> : <Eye size={13} />}
              {t.seenAll}
            </button>
          )}
          <Tip content={<TipText title={t.projectSettings} />} describe={false} side="bottom">
            <button
              type="button"
              className="icon-button"
              aria-label={t.projectSettings}
              onClick={() => onNavigate({ kind: "projectSettings", projectId: id })}
            >
              <Settings size={14} />
            </button>
          </Tip>
          {!readOnly && <RefreshHome busy={refreshing} onRefresh={onRefresh} />}
        </span>
      </header>
      <ProjectHead line={line} others={others} installed={installed} counts={counts} changes={changes}
        related={line ? relatedRequests(line, blocks) : []} onShowBlock={showBlock} onGroup={showGroup}
        othersOpen={isOpen("project")} onOthers={(open) => choose("project", open)} common={common} />
      {/* The page's one bar (R-36): the jumps, then Requests or Conversation beside them, stuck together at the top of
          Home's scroller as R-25's tabs were; its measured height is what a jump keeps clear (HomeJumps.tsx). */}
      <HomeJumps
        asks={asks.length}
        report={latest ? { title: latest.title, projectName: panel.project.name } : null}
        onAsk={toAsk}
        onReport={toReport}
        views={
          <div className="project-view-tabs" role="tablist" aria-label={tb.views}>
            {(["requests", "chat"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                data-tab={tab}
                aria-selected={view === tab}
                aria-controls={tab === "chat" ? `project-talk-chat-${id}` : `project-requests-${id}`}
                onClick={() => chooseView(tab)}
              >
                <span className="project-view-label">{tab === "requests" ? tb.requestsTab : tb.chatTab}</span>
                {tab === "requests" && (
                  <>
                    {" "}
                    <span className="project-view-count">{counts.needs + counts.doing}</span>
                  </>
                )}
              </button>
            ))}
          </div>
        }
      />
      {seenError && (
        <p className="inline-error" role="alert">
          {seenError}
        </p>
      )}
      <ProjectTalk
        projectId={id}
        projectName={panel.project.name}
        workspaceId={workspaceId}
        readOnly={readOnly}
        revision={revision}
        leadCount={editorIds?.length ?? 0}
        onNavigate={onNavigate}
        reveal={reveal}
        onRequests={takeRequests}
        onInstalled={setInstalled}
        onOlder={setOlder}
        onBusy={setBusy}
        dock={dock}
        mode={view === "chat" ? "chat" : "requests"}
        command={command}
        onShowRequest={showBlock}
        onShowChat={() => setView("chat")}
        onFocusTarget={keepTarget}
        onArrival={setJustSent}
        notice={sentNotice}
        onDismissNotice={dismissNotice}
      />
      <div className="project-home-body" hidden={view === "chat"}>
        <div className="project-home-main" id={`project-requests-${id}`}>
          {arrival && !arrival.inCard && arrival.note}
          {empty && !unread && <p className="home-note home-brief-empty">{t.noContent}</p>}
          <div className="request-blocks">
            {needsShown > 0 ? (
              <section className="request-group" data-group="needs" aria-label={tb.groups.needs}>
                <h2 className="request-group-title">
                  {tb.groups.needs} <span>{needsShown}</span>
                </h2>
                {needs}
              </section>
            ) : unread ? (
              // The requests could not be read: what waits for the user is not known, so never "none" (R-38 §2.1).
              <p className="request-group-none" data-group="needs" data-unknown="">{tb.needsUnknown}</p>
            ) : talkRequests !== null && !empty ? (
              // R-38 §2.1: nothing for the user is said once, quietly; nothing counts it.
              <p className="request-group-none" data-group="needs">{tb.needsNone}</p>
            ) : null}
            {groups.doing.length > 0 ? (
              <section className="request-group" data-group="doing" aria-label={tb.groups.doing}>
                <h2 className="request-group-title">
                  {tb.groups.doing} <span>{groups.doing.length}</span>
                </h2>
                {groups.doing.map(blockView)}
              </section>
            ) : null}
            {(groups.done.length > 0 || restOfHistory.length > 0) && (
              <details className="request-group request-done" data-group="done">
                <summary className="request-group-title">
                  {tb.groups.done} <span>{groups.done.length}</span>
                </summary>
                {groups.done.map(blockView)}
                <History30 sections={restOfHistory} projectId={id} reply={readOnly ? undefined : { workspaceId, agents, referable }} />
              </details>
            )}
            {older?.hasMore && (
              <button type="button" className="project-talk-earlier" disabled={older.reading} onClick={older.read}>
                {older.reading && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
                {tb.olderRequests}
              </button>
            )}
          </div>
          {/* Replies begun on cards no longer live here: kept, and sent only to their own card (T-174). */}
          {!readOnly && (
            <KeptCardReplies
              projectId={id}
              workspaceId={workspaceId}
              agents={agents}
              cardKeys={live.filter((s) => s.kind !== "ask").map((s) => s.key)}
              referable={referable}
            />
          )}
        </div>
        {wide ? (
          <aside className="project-team" aria-label={t.teamAndRun}>
            <h3 className="project-team-title">{t.teamAndRun}</h3>
            {teamFacts}
          </aside>
        ) : (
          <details className="project-team">
            <summary>{t.teamAndRun}</summary>
            {teamFacts}
          </details>
        )}
      </div>
    </div>
    </ProjectTalkLink.Provider>
  );
}
