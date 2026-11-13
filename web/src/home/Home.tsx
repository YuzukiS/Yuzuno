import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { House, ListOrdered, LoaderCircle } from "lucide-react";
import { errorText } from "../api";
import { langTag, useLanguage } from "../i18n";
import { shellText } from "../shell-text";
import type { Agent, HomeReplyOrigin, Project } from "../types";
import { reportLinkHref, type MessageLink, type ReportLink } from "../deep-link";
import { arrivalOf, sameSectionLive } from "../home-reply/home-reply-model";
import { ReplyArrival } from "../home-reply/ReplyArrival";
import { rememberSeenBlocks } from "./brief/block-changes";
import { keepUnchanged, projectDomId, sectionDomId, widgetsDomId } from "./brief-layout";
import { markOpened, markSeen, readHome, saveHomeOrder, type SeenMark } from "./home-api";
import { usePhone } from "../phone-layout";
import { useDelayedPresence, useSurfaceIn } from "../surface";
import { ProjectGlance } from "./ProjectGlance";
import { ProjectHome } from "./ProjectHome";
import { HomeDensity, RefreshHome } from "./home-tools";
import { HomeNavigation, type HomeTarget } from "./home-navigation";
import { HomeReadContext, type HomeRead } from "./home-read";
import { arrangeWidgets, HomeWidgets, type HomeWidget } from "./HomeWidgets";
import { askKey, HomeJumps, latestReport, nextAsk, scrollWithinHome, waitingAsks } from "./HomeJumps";
import { MachineWidget } from "./MachineWidget";
import { NeedsYou, needsYouKey } from "./NeedsYou";
import { PinNotes, PinnedSection } from "./PinnedSection";
import { previewHome, previewProjectAgents } from "./preview-home";
import type { HomeData, NeedsYouItem, Section } from "./types";
import { PinsContext, pinSource, pinWidgetId, resolvePin, useWidgetLayout, type PinControl } from "./widget-layout";
import { DeckSizes, sizable, useHeldSizes } from "./card-sizes";
import { cardContent, shownSize, type CardSize } from "./card-preview";
import { SummaryCard } from "./SummaryCard";
import { replyableIn } from "./CardReply";
import { CardAgents } from "./card-responsible";
import "./home.css";
import { CardFoldWorkspace, unfoldAround } from "./card-fold";
import { homeText } from "./home-text";
import { BriefDensity, useHomeDensity, useHomeDensityRefusal } from "./home-density";
import { ReportPage } from "./report/ReportPage";
import { linkTo } from "./report/report-model";
import { ReportOpen, type ReportOpener } from "./report/report-open";
import { settleWhenLanded } from "../settle";

export type { HomeTarget } from "./home-navigation";

type HomeError = { kind: "unavailable" | "order" | "read"; reason: string };

/** Brief changes have no event of their own yet; this catches what the
 * Agent and Job events do not. */
const SAFETY_NET_MS = 30_000;

/** Core's order, with any project it did not place kept after, in its list order. */
function displayOrder(data: HomeData, local: string[] | null) {
  const present = new Set(data.projects.map((p) => p.project.id));
  const order = (local || data.order).filter((id) => present.has(id));
  const placed = new Set(order);
  return [...order, ...data.projects.map((p) => p.project.id).filter((id) => !placed.has(id))];
}

/**
 * A report open over Home (T-18): where Back goes, and its history entry.
 * `push`: opened here, in an entry of its own, which Back leaves. `replace`:
 * opened from the address (a link, a reload, the browser's Forward), in the
 * entry it came in, which closing turns back into Home's.
 */
type OpenReport = { link: ReportLink; back: MessageLink | null; from: HTMLElement | null; entry: number; mode: "push" | "replace" };
const REPORT_STATE = "yuzunoReport";
const historyState = (): Record<string, unknown> =>
  history.state && typeof history.state === "object" ? { ...history.state } : {};
const reportEntryOnTop = (open: OpenReport | null) => !!open && historyState()[REPORT_STATE] === open.entry;
const here = () => window.location.pathname + window.location.search;
/** The entry a report was in, as Home's again: no report state, no report link. */
function leaveReportEntry(open: OpenReport | null) {
  if (!reportEntryOnTop(open)) return;
  const { [REPORT_STATE]: _entry, ...rest } = historyState();
  history.replaceState(Object.keys(rest).length ? rest : null, "", here());
}

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Home: what needs you across projects, answered in place, then each
 * project at a glance in Project Priority, then My widgets (this machine's
 * load and the sections the user pinned); or one Project's page (YN-86).
 * It reads Core's facts and the Agents' Briefs; it never mounts a
 * conversation.
 */
export function Home({
  revision,
  jobsRevision,
  workspaceId,
  agents,
  projects,
  readOnly,
  onNavigate,
  onChanged,
  onNeedsYou,
  jumpTo = null,
  arrival = null,
  onBackToReply,
  report: incomingReport = null,
  visit = 0,
  project = null,
  onOpenProject,
  onCloseProject,
}: {
  /** Bumped (debounced) on Agent changes and anything else Home shows. */
  revision: number;
  jobsRevision: number;
  workspaceId: string;
  agents: Agent[];
  projects: Project[];
  readOnly: boolean;
  onNavigate: (target: HomeTarget) => void;
  /** After the user's own action here (an approval, a reply): refresh the rest. */
  onChanged: () => void;
  /** Each read's Needs you, for the Home tab's count. */
  onNeedsYou?: (items: NeedsYouItem[]) => void;
  /** An Ask "next needs you" goes to, or an Agent whose ring in the Agent
   * list asked for its place here (T-43 v10.2); another jump is another `n`. */
  jumpTo?: { projectId: string | null; sectionKey?: string; agentId?: string; n: number } | null;
  /** "Open on Home" on a reply from Home (T-9): the section and version it
   * answered, and the message to go back to; another opening is another `n`. */
  arrival?: { origin: HomeReplyOrigin; back: MessageLink; n: number } | null;
  onBackToReply?: (link: MessageLink) => void;
  /** A report link opened elsewhere (T-18): the report, the message it was
   * opened from if any, for Back, and whether it came from the address;
   * another opening is another `n`. */
  report?: { link: ReportLink; back: MessageLink | null; fromAddress: boolean; n: number } | null;
  /** Bumped on each explicit way to Home (the toolbar, a notification, a
   * Home link, a reply's Open on Home): an open report closes (T-18 R3). */
  visit?: number;
  /** The Project whose page is shown (YN-86): its pane instead of all of Home. */
  project?: string | null;
  /** Opens a Project's page, at one of its cards when named (YN-86). */
  onOpenProject?: (projectId: string, sectionKey?: string) => void;
  /** Back to the whole of Home from a Project's page. */
  onCloseProject?: () => void;
}) {
  const language = useLanguage();
  const t = homeText(language);
  // How much each card shows, kept on this device for each Workspace (the
  // preview keeps none): the same content either way.
  const densityWorkspace = readOnly ? "" : workspaceId;
  const density = useHomeDensity(densityWorkspace);
  const densityRefusal = useHomeDensityRefusal(densityWorkspace);
  // A late read from a previous Workspace must never seed the new
  // Workspace's overview (or its cards). Abort is checked before writes.
  const [reading, setReading] = useState<{ workspaceId: string; value: HomeData } | null>(null);
  const data = readOnly ? previewHome : reading?.workspaceId === workspaceId ? reading.value : null;
  // An Ask "next needs you" chose: shown as its own row's click shows it.
  const jumpToItem = useRef<(item: NeedsYouItem) => void>(() => {});
  const jumped = useRef(0);
  useEffect(() => {
    if (!jumpTo || !data || jumped.current === jumpTo.n) return;
    // A Project's page takes its own jump, to the card it names (ProjectHome).
    if (jumpTo.projectId && jumpTo.projectId === project) {
      jumped.current = jumpTo.n;
      return;
    }
    if (jumpTo.agentId) {
      // An Agent's ring: its item in Needs you, else Needs you itself.
      jumped.current = jumpTo.n;
      const item = data.needsYou.find((n) => n.agentId === jumpTo.agentId);
      showNeeds.current(item ? needsYouKey(item) : null);
      return;
    }
    const item = data.needsYou.find((n) => n.projectId === jumpTo.projectId && n.kind === "ask" && n.sectionKey === jumpTo.sectionKey);
    if (!item) return;
    jumped.current = jumpTo.n;
    jumpToItem.current(item);
  }, [jumpTo, data]);
  // What went wrong, worded when shown so it follows the language (T-189):
  // a reply Home can't use, an order not saved, or Core's reason as it came.
  const activeWorkspace = useRef(workspaceId);
  activeWorkspace.current = workspaceId;
  // Home fades in as it opens, over medium (T-19 M6: SH:M10, R27); not on a
  // phone, where what is open comes in by its own motion (M8, later).
  const view = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  useSurfaceIn(view, "home", "medium", !phone);
  const [errorState, setErrorState] = useState<(HomeError & { workspaceId: string }) | null>(null);
  const error = errorState?.workspaceId === workspaceId ? errorState : null;
  // The error floats over the top of what is below it, which stays where it was as it comes and goes; it fades in
  // over small and out over exit-small, saying what it said, and goes at once with its Workspace (T-19 HM:H2).
  const banner = useDelayedPresence(!!error, 0);
  const lastError = useRef(errorState);
  if (error) lastError.current = errorState;
  // While the banner is shown, the error it says stays: when the next read answers, the same banner takes its way
  // out (is-leaving, set after that render), never unmounted and put back as a second alert (#620 R1).
  const bannerError = error ?? (banner.shown && lastError.current?.workspaceId === workspaceId ? lastError.current : null);
  const setError = useCallback((value: HomeError | null) => {
    if (activeWorkspace.current === workspaceId) setErrorState(value ? { workspaceId, ...value } : null);
  }, [workspaceId]);
  // A read's age and failure belong to the same Workspace as its data,
  // including while a new Workspace's first response is still pending.
  const [readState, setReadState] = useState<(HomeRead & { workspaceId: string }) | null>(null);
  const homeRead = useMemo<HomeRead>(() => readState?.workspaceId === workspaceId
    ? { at: readState.at, failed: readState.failed }
    : { at: null, failed: false }, [readState, workspaceId]);
  const readFailed = homeRead.failed;
  const [tick, setTick] = useState(0);
  const [reordering, setReordering] = useState(false);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  // Each jump Home makes to a place on itself, numbered: the effect below takes the newest.
  const [reveal, setReveal] = useState(0);
  // Where Needs you's last jump landed (T-19): its mark, until the next.
  const needsSettled = useRef<(() => void) | null>(null);
  useEffect(() => () => needsSettled.current?.(), []);
  /** Needs you, or one of its items (an Ask's card, an approval, a row),
   * scrolled to, focused and marked once it has landed; a folded card opens
   * to show it (T-115). `within`: a jump from Home's own bar (YN-86), which
   * scrolls Home's scroller only, clear of the bar. */
  const showNeeds = useRef((key: string | null, within = false) => {
    const area = document.getElementById("home-current-needs");
    const item = key ? [...(area?.querySelectorAll<HTMLElement>("[data-needs-you]") ?? [])].find((el) => el.dataset.needsYou === key) : null;
    // An Ask is its card, as on its project's page.
    const target = item?.querySelector<HTMLElement>(":scope > [data-section-key]") ?? item ?? area;
    if (!target) return;
    const smooth = !reducedMotion();
    const show = () => {
      if (within) scrollWithinHome(target, "center", smooth);
      else target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center", inline: "center" });
      target.focus({ preventScroll: true });
      needsSettled.current?.();
      needsSettled.current = settleWhenLanded(target, "data-home-highlight", smooth);
    };
    if (unfoldAround(target)) requestAnimationFrame(show);
    else show();
  });
  // The Ask the bar last went to, so the next press goes to the next (YN-86).
  const lastAsk = useRef<string | null>(null);
  // `within`: a jump from Home's own bar (YN-86), which scrolls Home's scroller only, clear of the bar.
  const pendingJump = useRef<{ target: () => HTMLElement | null; n: number; block?: ScrollLogicalPosition; within?: boolean } | null>(null);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  // Refresh asked for and not yet answered (T-19 HM:H3): its icon turns and it says it is busy. The reads Home makes
  // on its own (a revision, the safety net) show nothing.
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (readOnly) return;
    const controller = new AbortController();
    const failed = () => setReadState((previous) => ({
      workspaceId,
      at: previous?.workspaceId === workspaceId ? previous.at : null,
      failed: true,
    }));
    readHome(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setRefreshing(false);
        if (!value || !Array.isArray(value.projects) || !Array.isArray(value.needsYou)) {
          setError({ kind: "unavailable", reason: "" });
          failed();
          return;
        }
        setReading((previous) => ({
          workspaceId,
          value: keepUnchanged(previous?.workspaceId === workspaceId ? previous.value : null, value),
        }));
        onNeedsYou?.(value.needsYou);
        setError(null);
        setReadState({ workspaceId, at: new Date().toISOString(), failed: false });
      })
      .catch((e) => {
        // The last read stays on screen; nothing is blanked while retrying.
        if (controller.signal.aborted) return;
        setRefreshing(false);
        setError({ kind: "read", reason: errorText(e) });
        failed();
      });
    return () => controller.abort();
    // A new report callback is not a reason to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, workspaceId, revision, jobsRevision, tick]);
  useEffect(() => {
    if (readOnly) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") reload();
    }, SAFETY_NET_MS);
    return () => clearInterval(timer);
  }, [readOnly, reload]);
  const changed = useCallback(() => {
    reload();
    onChanged();
  }, [reload, onChanged]);
  const shown = useRef(data);
  shown.current = data;
  const seen = useCallback(
    async (projectId: string, marks: SeenMark[]) => {
      if (!marks.length) return;
      await markSeen(projectId, marks);
      // What was on screen is what was seen, should a newer version come
      // with the next read.
      const brief = shown.current?.projects.find((p) => p.project.id === projectId)?.brief;
      const sections = [...(brief?.sections ?? []), ...(brief?.teamSections ?? [])];
      for (const mark of marks) {
        const section = sections.find((s) => s.key === mark.key && s.version === mark.version);
        if (section) rememberSeenBlocks(workspaceId, projectId, section, mark.version);
      }
      reload();
    },
    [reload, workspaceId],
  );
  /** Records that the report page showed this very version of a live report whole (ReportPage says when). */
  const opened = useCallback(
    async (projectId: string, section: Section) => {
      if (typeof section.id !== "number") return;
      const sectionId = section.id;
      const record = await markOpened(projectId, { workspaceId, sectionId, key: section.key, version: section.version });
      // A late answer for a Workspace no longer shown changes nothing here.
      if (activeWorkspace.current !== workspaceId) return;
      // Its blocks as shown are the read version's only once Core has that very version.
      if (record.sectionId === sectionId && record.version === section.version)
        rememberSeenBlocks(workspaceId, projectId, section, section.version);
      reload();
    },
    [reload, workspaceId],
  );
  const panels = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.projects.map((p) => [p.project.id, p] as const));
    return displayOrder(data, localOrder).map((id) => byId.get(id)!);
  }, [data, localOrder]);
  /** The Project whose page is shown, when Core's read has it (YN-86). */
  const projectPanel = project ? data?.projects.find((panel) => panel.project.id === project) : undefined;
  /** A Project's page takes the jump that opened or named it (YN-86). */
  const projectFocus = project && jumpTo?.projectId === project && !jumpTo.agentId
    ? { key: jumpTo.sectionKey, n: jumpTo.n }
    : null;
  useEffect(() => {
    // A saved order shows as soon as Core reports it.
    if (localOrder && data && !saving && data.order.join("\n") === localOrder.join("\n")) setLocalOrder(null);
  }, [data, localOrder, saving]);
  // The arrow just pressed keeps the focus as its panel moves, and as a refused order puts it back (T-19 HM:H7).
  // The panels change places at once, as Home's layout does (no motion: HM:H7 and H8's moves are not animated).
  const movedArrow = useRef<{ id: string; by: -1 | 1 } | null>(null);
  useLayoutEffect(() => {
    const moved = movedArrow.current;
    if (!moved) return;
    movedArrow.current = null;
    const arrow = document.getElementById(projectDomId(moved.id))
      ?.querySelector<HTMLElement>(`.home-reorder [data-move="${moved.by < 0 ? "up" : "down"}"]`);
    if (arrow && document.activeElement !== arrow) arrow.focus();
  }, [panels]);
  async function move(index: number, by: -1 | 1) {
    const ids = panels.map((p) => p.project.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    const previous = localOrder;
    const moved = { id: ids[target], by };
    movedArrow.current = moved;
    setLocalOrder(ids);
    setSaving(true);
    setError(null);
    try {
      await saveHomeOrder(ids);
      reload();
    } catch (e) {
      movedArrow.current = moved;
      setLocalOrder(previous);
      setError({ kind: "order", reason: errorText(e) });
    } finally {
      setSaving(false);
    }
  }
  const projectName = (id: string | null) =>
    id
      ? data?.projects.find((p) => p.project.id === id)?.project.name ||
        projects.find((p) => p.id === id)?.name ||
        shellText(language).unknownProject
      : shellText(language).noProject;
  /** Scrolls Home (or the Project page on it) to a target, once, and focuses it. */
  function jumpToEl(target: () => HTMLElement | null, block: ScrollLogicalPosition = "center", within = false) {
    const n = reveal + 1;
    pendingJump.current = { target, n, block, within };
    setReveal(n);
  }
  // A Project's page replaces Home's panes in the same scroller: entering it starts at its top, and coming
  // back returns to where the reader was in the whole of Home (YN-86).
  const shownProject = useRef<string | null>(null);
  const homeScroll = useRef(0);
  useLayoutEffect(() => {
    const element = view.current;
    if (!element || shownProject.current === project) return;
    const from = shownProject.current;
    shownProject.current = project;
    if (!project) {
      if (from) element.scrollTo({ top: homeScroll.current });
      return;
    }
    if (!from) homeScroll.current = element.scrollTop;
    element.scrollTo({ top: 0 });
    // Only entering or leaving a Project's page moves the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);
  // A reply's "Open on Home" (T-9): once Home has read, to its project's page
  // (YN-86), at the section it answered while Home shows that very section,
  // else at the page's top; once per opening. What has become of that
  // version is said there, from what Home reads now, never decided before,
  // and never of another section.
  const arrived = useRef(0);
  const replyPanel = arrival && data ? data.projects.find((p) => p.project.id === arrival.origin.projectId) : undefined;
  const landed = arrival && data ? arrivalOf(arrival.origin, replyPanel) : null;
  const landedNote = (ask: boolean) =>
    arrival && landed && (
      <ReplyArrival
        arrival={landed}
        version={arrival.origin.version}
        ask={ask}
        onBack={onBackToReply ? () => onBackToReply(arrival.back) : undefined}
      />
    );
  jumpToItem.current = (item) => jump(item);
  /** Where an item of Needs you is answered: its card in Needs you, its conversation, or its project's page. */
  function jump(item: NeedsYouItem, within = false) {
    // A question is answered in its conversation (T-42), and an executor's
    // result is released from its own (T-36 S3).
    if (item.kind === "question" || item.kind === "executor") {
      onNavigate({ kind: "agent", agentId: item.agentId });
      return;
    }
    const panel = item.projectId ? data?.projects.find((p) => p.project.id === item.projectId) : undefined;
    const onCard =
      item.kind === "approval"
        ? !!panel?.pending.some((request) => request.id === item.requestId)
        : !!panel?.brief.sections.some((section) => section.kind === "ask" && section.key === item.sectionKey);
    if (onCard) {
      showNeeds.current(needsYouKey(item), within);
      return;
    }
    // An approval from an Agent outside any project lives in its conversation.
    if (item.kind === "approval" && item.requestId) onNavigate({ kind: "request", agentId: item.agentId, requestId: item.requestId });
    // An Ask Home's read does not have on any card: its project's page, at it.
    else if (panel && item.sectionKey) onOpenProject?.(panel.project.id, item.sectionKey);
  }
  useEffect(() => {
    const jumpTo = pendingJump.current;
    if (!jumpTo || jumpTo.n !== reveal) return;
    pendingJump.current = null;
    const target = jumpTo.target();
    if (!target) return;
    let frame = 0;
    let settled: (() => void) | undefined;
    const show = () => {
      // Only the user's click scrolls Home; new content never does.
      const smooth = !reducedMotion();
      if (jumpTo.within) scrollWithinHome(target, jumpTo.block ?? "center", smooth);
      else target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: jumpTo.block ?? "center" });
      target.focus({ preventScroll: true });
      // Where it landed, once the scroll has (T-19): kept until the next press.
      settled = settleWhenLanded(target, "data-home-highlight", smooth);
    };
    // A card the user collapsed opens to show what the jump is to (T-115).
    if (unfoldAround(target)) frame = requestAnimationFrame(show);
    else show();
    return () => {
      cancelAnimationFrame(frame);
      settled?.();
    };
  }, [reveal]);
  // A section's report, over Home (T-18). Home stays mounted and laid out
  // below it, so its scroll place, folds and drafts are as they were. The
  // report link is in the address while the page is open, so a reload opens
  // it again; the browser's Back closes it as the page's Back and Escape do,
  // and focus returns to what opened it. Nothing here marks seen or touches
  // a draft; the page records a live report it showed whole as opened
  // (YN-86), which leaves it on Home where it is.
  const [openedReport, setReport] = useState<OpenReport | null>(null);
  // A report belongs to the Workspace its link names: from the first frame
  // after the Workspace changes (Core at this address answering as another),
  // it is neither drawn nor acted on, and nothing of it reaches the other
  // Workspace's Home (T-18 R2).
  const report = openedReport && openedReport.link.workspaceId === workspaceId ? openedReport : null;
  // While a report is still closing over Home, Home is out of reach: the
  // arrival lands once the page has gone (T-18 R3).
  useEffect(() => {
    if (!arrival || !landed || report || arrived.current === arrival.n) return;
    arrived.current = arrival.n;
    const { projectId, key } = arrival.origin;
    if (landed.kind === "gone") {
      // No page to go to: the note saying so, above the projects and often out of view, is brought into view
      // (nearest) and settles (T-19 HM:H15).
      jumpToEl(() => document.querySelector<HTMLElement>(".home-projects > .home-reply-arrival"), "nearest");
      return;
    }
    // Its project's page, at the very section answered, else at its top; the page says what became of it.
    onOpenProject?.(projectId, key !== null && sameSectionLive(landed) ? key : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrival, data, report]);
  const shownReport = useRef(report);
  shownReport.current = report;
  const reportEntry = useRef(0);
  const returnTo = useRef<{ from: HTMLElement | null; projectId: string } | null>(null);
  const afterReport = useRef<(() => void) | null>(null);
  // Between the browser's Back and its popstate: another Back is not another step.
  const closing = useRef(false);
  function openReport(link: ReportLink, back: MessageLink | null, from: HTMLElement | null, mode: "push" | "replace" = "push") {
    const open = shownReport.current;
    closing.current = false;
    const entry = ++reportEntry.current;
    const state = { ...historyState(), [REPORT_STATE]: entry };
    const address = reportLinkHref(here(), link);
    // A report opened from a report (another version, a link in it) takes
    // its entry and keeps where Back returns to.
    const over = reportEntryOnTop(open) ? open : null;
    if (over || mode === "replace") history.replaceState(state, "", address);
    else history.pushState(state, "", address);
    setReport({ link, back: over ? over.back : back, from: over ? over.from : from, entry, mode: over ? over.mode : mode });
  }
  const openReportNow = useRef(openReport);
  openReportNow.current = openReport;
  function finishReport() {
    const open = shownReport.current;
    if (!open) return;
    closing.current = false;
    setReport(null);
    const then = afterReport.current;
    afterReport.current = null;
    if (then) then();
    else if (open.back && onBackToReply) onBackToReply(open.back);
    else returnTo.current = { from: open.from, projectId: open.link.projectId };
  }
  const finishReportNow = useRef(finishReport);
  finishReportNow.current = finishReport;
  function closeReport(then?: () => void) {
    if (closing.current) {
      // The browser's Back is under way: a later explicit way out (Home)
      // decides where it ends, without asking the browser to go back again.
      if (then) afterReport.current = then;
      return;
    }
    const open = shownReport.current;
    afterReport.current = then ?? null;
    if (open?.mode === "push" && reportEntryOnTop(open)) {
      closing.current = true;
      history.back();
      return;
    }
    // Opened from the address: the entry becomes Home's; Back never leaves Yuzuno.
    leaveReportEntry(open);
    finishReport();
  }
  const closeReportNow = useRef(closeReport);
  closeReportNow.current = closeReport;
  useEffect(() => {
    if (!report) return;
    const popped = (event: PopStateEvent) => {
      const state = event.state && typeof event.state === "object" ? (event.state as Record<string, unknown>) : {};
      if (state[REPORT_STATE] !== report.entry) finishReportNow.current();
    };
    window.addEventListener("popstate", popped);
    return () => window.removeEventListener("popstate", popped);
  }, [report]);
  // Leaving Home with a report open leaves its entry as an ordinary one.
  useEffect(() => () => leaveReportEntry(shownReport.current), []);
  // Another Workspace's report is closed for good, with its entry, where Back
  // would go and what it would focus.
  useEffect(() => {
    if (!openedReport || openedReport.link.workspaceId === workspaceId) return;
    leaveReportEntry(openedReport);
    setReport(null);
    returnTo.current = null;
    afterReport.current = null;
    closing.current = false;
  }, [openedReport, workspaceId]);
  // An explicit way to Home: the report closes as its Back closes it (its own
  // history entry left, or that entry made Home's again), and then goes
  // nowhere else: not to the message it came from, not back to its card.
  // Home itself stays mounted, with its drafts, folds and scroll.
  const visited = useRef(visit);
  useEffect(() => {
    if (visited.current === visit) return;
    visited.current = visit;
    if (shownReport.current) closeReportNow.current(() => {});
  }, [visit]);
  const incoming = useRef(0);
  useEffect(() => {
    if (!incomingReport || incoming.current === incomingReport.n) return;
    incoming.current = incomingReport.n;
    const active = document.activeElement;
    openReportNow.current(
      incomingReport.link,
      incomingReport.back,
      active instanceof HTMLElement && active.closest(".home-view") ? active : null,
      incomingReport.fromAddress ? "replace" : "push",
    );
  }, [incomingReport]);
  // Back on Home: focus where the report was opened from (a card, the bar's
  // Latest report), with a short ring; when that is gone (the card marked
  // seen, say), its project: Open project on the whole of Home, the heading
  // of its page.
  useEffect(() => {
    if (report) return;
    const back = returnTo.current;
    returnTo.current = null;
    if (!back) return;
    const target = back.from?.isConnected
      ? back.from
      : (document.getElementById(projectDomId(back.projectId))?.querySelector<HTMLElement>(".project-glance-open") ??
        [...document.querySelectorAll<HTMLElement>(".project-home")].find((page) => page.dataset.projectHome === back.projectId)
          ?.querySelector<HTMLElement>(".project-home-head h1"));
    if (!target) return;
    if (!back.from?.isConnected) target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
    const card = target.closest<HTMLElement>(".home-section, .project-glance") ?? target;
    card.setAttribute("data-report-return", "");
    const timer = setTimeout(() => card.removeAttribute("data-report-return"), 1200);
    return () => {
      clearTimeout(timer);
      card.removeAttribute("data-report-return");
    };
  }, [report]);
  const cardReport = useCallback<ReportOpener>(
    (projectId, section, from) => openReportNow.current({ workspaceId, ...linkTo(projectId, section) }, null, from),
    [workspaceId],
  );
  // The open Agents of each project, the same arrays while they do not change,
  // so section cards are not drawn again for unrelated workspace reads.
  const agentsKey = agents
    .map((a) => (a.closedAt || !a.projectId ? "" : `${a.projectId}\t${a.id}\t${a.name}`))
    .join("\n");
  const byProject = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const agent of agents)
      if (agent.projectId && !agent.closedAt)
        map.set(agent.projectId, [...(map.get(agent.projectId) || []), agent]);
    // The design specimen's Agents belong to no project; it names its own.
    if (readOnly)
      for (const [projectId, ids] of Object.entries(previewProjectAgents))
        map.set(projectId, agents.filter((agent) => ids.includes(agent.id)));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsKey, readOnly]);
  const noAgents = useMemo<Agent[]>(() => [], []);
  // Every Agent by id, closed and archived ones too (YN-86 S2b): who answers for a card, in the Agent list's
  // words, and the executor an archived card was done by. The same map while what a card shows of them is unchanged.
  const cardAgentsKey = agents
    .map((a) => [a.id, a.name, a.kind, a.status, a.closedAt, a.disconnectedAt, a.pendingCount, a.createdAt,
      a.executor?.state, a.executor?.task?.id, a.executor?.dispatchedAt, a.executor?.position, a.executor?.route?.kind,
      a.executor?.reason, a.executor?.blocked].join("\t"))
    .join("\n");
  const cardAgents = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [cardAgentsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const widgetLayout = useWidgetLayout(workspaceId);
  // The sizes the deck's cards are shown at in this visit (T-18).
  const deckSizes = useHeldSizes(readOnly ? "" : workspaceId, visit);
  // How each pinned card is shown, fixed for the visit by its pin (Lead 2604): as its summary card, or
  // whole as before. A newer version that adds or drops the summary changes it only at the next visit,
  // so the widget, its reply and its focus stay; a pin the user sized is always its card.
  const pinPaths = useRef({ workspaceId, visit, paths: new Map<string, "card" | "full">() });
  if (pinPaths.current.workspaceId !== workspaceId || pinPaths.current.visit !== visit)
    pinPaths.current = { workspaceId, visit, paths: new Map() };
  const { layout, pin, unpin, resize, resetSizes } = widgetLayout;
  // A section pinned here (T-19 HM:W5): what was pressed keeps its place
  // while the widget column above it grows, and the new widget comes in over
  // small (opacity, 4 px up) and settles once; under reduced motion it is
  // there at once. Only a widget this press added does so: not one already
  // pinned (a pin that changed nothing, or Pin the new section for one pinned
  // already), not one past the limit, a layout read again or another
  // window's pin. It is this Workspace's: another one opened drops it.
  const [pinnedHere, setPinnedHere] = useState<{ workspace: string; id: string; n: number; had: boolean } | null>(null);
  const pinAnchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  const pinnedWidget = useRef<HTMLElement | null>(null);
  const layoutNow = useRef(layout);
  layoutNow.current = layout;
  useLayoutEffect(() => {
    pinnedWidget.current = null;
    const anchor = pinAnchor.current;
    pinAnchor.current = null;
    if (!pinnedHere || pinnedHere.workspace !== workspaceId) return;
    // Held now, and for two more frames until the reader scrolls, presses a
    // key or touches: so whatever the browser's own scroll anchoring did or
    // does, the pressed control ends where it was, and what the reader then
    // does stands.
    const view = anchor?.element.isConnected ? anchor.element.closest<HTMLElement>(".home-view") : null;
    const hold = () => {
      if (!anchor || !view || !anchor.element.isConnected) return;
      const moved = anchor.element.getBoundingClientRect().top - anchor.top;
      if (Math.abs(moved) >= 1) view.scrollTop += moved;
    };
    hold();
    let frame = requestAnimationFrame(() => {
      hold();
      frame = requestAnimationFrame(hold);
    });
    const inputs = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    const yield_ = () => {
      cancelAnimationFrame(frame);
      for (const kind of inputs) window.removeEventListener(kind, yield_, true);
    };
    for (const kind of inputs) window.addEventListener(kind, yield_, { capture: true, passive: true });
    const added = !pinnedHere.had && !!layout?.pins.some((p) => pinWidgetId(p) === pinnedHere.id);
    const widget = added ? [...document.querySelectorAll<HTMLElement>(".home-widget-slot")].find((slot) => slot.dataset.widget === pinnedHere.id) : undefined;
    pinnedWidget.current = widget ?? null;
    // The tint paints the widget's own card: the card's background would
    // hide one painted behind it.
    const card = widget?.firstElementChild instanceof HTMLElement ? widget.firstElementChild : widget;
    const settled = card ? settleWhenLanded(card, "data-settle", false, "animation") : null;
    return () => {
      yield_();
      settled?.();
    };
    // `layout` is read as this pin committed it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedHere, workspaceId]);
  useSurfaceIn(pinnedWidget, pinnedHere?.n ?? 0, "small", !!pinnedHere, "translateY(4px)");
  /** Every pin is made here, and only of a section pinSource allows. */
  const pinIfAllowed = useCallback(
    (projectId: string, section: Section, pressed?: HTMLElement) => {
      const source = pinSource(data, projectId, section);
      if (!source) return;
      // The control the press was on (the Pin button, or Pin the current
      // version) holds its place, read now, before the pin. It is the one
      // the press named, not whatever has focus: a click does not focus a
      // button in every browser (Safari), and focus may be elsewhere.
      pinAnchor.current = pressed?.closest(".home-view")
        ? { element: pressed, top: pressed.getBoundingClientRect().top }
        : null;
      const id = pinWidgetId({ projectId, key: source.section.key, id: source.section.id! });
      // Pinned already before this press, as the layout was last drawn.
      const had = !!layoutNow.current?.pins.some((p) => pinWidgetId(p) === id);
      pin(projectId, source.projectName, source.section);
      setPinnedHere((last) => ({ workspace: workspaceId, id, n: (last?.n ?? 0) + 1, had }));
    },
    [data, pin, workspaceId],
  );
  const pins = useMemo<PinControl | null>(
    () =>
      readOnly || !layout
        ? null
        : {
            isPinned: (projectId: string, section: Section) =>
              layout.pins.some((p) => p.projectId === projectId && p.id === section.id),
            canPin: (projectId: string, section: Section) => !!pinSource(data, projectId, section),
            toggle: (projectId: string, section: Section, pressed?: HTMLElement) => {
              const pinned = layout.pins.find((p) => p.projectId === projectId && p.id === section.id);
              if (pinned) unpin(pinned);
              else pinIfAllowed(projectId, section, pressed);
            },
          },
    [readOnly, layout, unpin, data, pinIfAllowed],
  );
  const widgets: HomeWidget[] = [
    {
      id: "machines",
      name: t.machines,
      // Built in: the whole row at its content's height, no size to choose (Dev 7's v19).
      full: "builtin",
      body: <MachineWidget projectName={projectName} readOnly={readOnly} />,
    },
    // The design preview has no pins: its sections are not this workspace's.
    ...(readOnly || !layout ? [] : layout.pins).map((p): HomeWidget => {
      const source = resolvePin(p, data, readFailed);
      const id = pinWidgetId(p);
      const name = source.state === "shown" ? source.section.title : p.title;
      const onResize = (size: CardSize | null) => resize(p, size);
      // A pinned card with a summary is the same card as in its project, at the size the user gave the widget,
      // else its Agent's, held for the visit (T-18, Lead 2457, 2473; Dev 7's v19). Nothing is written to the card.
      // Its summary gone in a later version, it says so on the same card (Lead 2604), never the old body.
      let path = pinPaths.current.paths.get(id);
      if (source.state === "shown" && !path) {
        path = p.size || cardContent(source.section).kind === "named" ? "card" : "full";
        pinPaths.current.paths.set(id, path);
      }
      if (source.state === "shown" && (path === "card" || p.size)) {
        const section = source.section;
        const { size, own } = shownSize(section, cardContent(section), p.size ?? null,
          sizable(section) ? (computed) => deckSizes.held(p.projectId, section.id!, computed) : undefined);
        return {
          id,
          name,
          size: { shown: size, own, chosen: p.size ?? null, onChange: onResize },
          onUnpin: () => unpin(p),
          body: (
            <SummaryCard
              section={section}
              projectId={p.projectId}
              workspaceId={workspaceId}
              agents={byProject.get(p.projectId) || noAgents}
              readOnly={readOnly}
              onSeen={(marks) => seen(p.projectId, marks)}
              widget={{ id, chosen: p.size ?? null, onResize, onUnpin: () => unpin(p) }}
              // Marked seen, it keeps its Reply and the reply being written, as History does (T-174, Lead 2655).
              referable={replyableIn(data?.projects.find((panel) => panel.project.id === p.projectId), section)}
              notice={<PinNotes source={source} />}
            />
          ),
        };
      }
      // Any other pin as before: its whole body, or why it can't show it, across the row (Dev 7's v19).
      return {
        id,
        name,
        full: "legacy",
        onUnpin: () => unpin(p),
        body: (
          <PinnedSection
            pin={p}
            source={source}
            onOpen={() => onOpenProject?.(p.projectId, p.key)}
            onUnpin={() => unpin(p)}
            reply={readOnly ? undefined : { workspaceId, agents: byProject.get(p.projectId) || noAgents }}
            onPinCurrent={
              source.state === "replaced" && pinSource(data, p.projectId, source.section)
                ? (pressed: HTMLElement) => {
                    unpin(p);
                    pinIfAllowed(p.projectId, source.section, pressed);
                  }
                : undefined
            }
          />
        ),
      };
    }),
  ];
  // Home's own jumps (YN-86): the open Asks Needs you lists, the report
  // updated last, and My widgets as arranged (none it hides).
  const asks = data ? waitingAsks(data.needsYou) : [];
  const latest = data ? latestReport(data, panels.map((panel) => panel.project.id)) : null;
  const arranged = readOnly ? (layout ?? { order: [], hidden: [], pins: [] }) : layout;
  const widgetsOnShow = arranged ? arrangeWidgets(widgets, arranged).shown.length : 0;
  const toAsk = () => {
    const item = nextAsk(asks, lastAsk.current);
    if (!item) return;
    lastAsk.current = askKey(item);
    jump(item, true);
  };
  // Its cards are on its project's page: the report opens over Home, and Back returns to the bar (YN-86 §2.1).
  const toReport = (from: HTMLElement) => {
    if (!latest) return;
    openReport({ workspaceId, ...linkTo(latest.projectId, latest.section) }, null, from);
  };
  const toWidgets = () => jumpToEl(() => document.getElementById(widgetsDomId), "start", true);
  const projectAgents = (id: string) => byProject.get(id) || noAgents;
  // A Project's page takes its jump once no report is open over it, so the card it names is shown and focused, never
  // under the report; Core's next read or the browser's Back clearing the jump leaves the one already taken.
  const pageFocus = useRef<{ project: string; focus: { key?: string; n: number } } | null>(null);
  if (project && projectFocus) pageFocus.current = { project, focus: projectFocus };
  else if (pageFocus.current?.project !== project) pageFocus.current = null;
  // The page shown named again (its name on the rail pressed once more, S1a's P3): a report open over it closes,
  // as its Back closes it, and the jump lands once it has gone. Entering another page is not this.
  const focusAsked = useRef({ project, n: projectFocus?.n });
  useEffect(() => {
    const was = focusAsked.current;
    focusAsked.current = { project, n: projectFocus?.n };
    if (!projectFocus || was.project !== project || was.n === projectFocus.n || !shownReport.current) return;
    closeReportNow.current(() => {});
    // Only a new jump for the same page asks this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, projectFocus?.n]);
  return (
    <HomeNavigation.Provider value={onNavigate}>
    <CardAgents.Provider value={cardAgents}>
    {/* Which cards are collapsed is kept per Workspace; the preview keeps none (T-115). */}
    <CardFoldWorkspace.Provider value={readOnly ? "" : workspaceId}>
    <PinsContext.Provider value={pins}>
    <DeckSizes.Provider value={deckSizes}>
    <BriefDensity.Provider value={density}>
    <HomeReadContext.Provider value={readOnly ? null : homeRead}>
    <ReportOpen.Provider value={cardReport}>
    <div className="home-stage">
    <div
      ref={view}
      className={`home-view${report ? " is-under-report" : ""}`}
      lang={langTag(language)}
      data-density={density}
      inert={report ? true : undefined}
    >
      {!project && (
        <header className="home-header">
          <h1>
            <House size={18} />
            {t.home}
          </h1>
          <span className="home-header-tools">
            <HomeDensity workspaceId={densityWorkspace} />
            {data && panels.length > 1 && !readOnly && (
              <button
                type="button"
                className={`quiet-button${reordering ? " is-active" : ""}`}
                aria-pressed={reordering}
                onClick={() => setReordering((v) => !v)}
              >
                <ListOrdered size={13} />
                {reordering ? t.reorderDone : t.reorder}
              </button>
            )}
            {!readOnly && <RefreshHome busy={refreshing} onRefresh={() => { setRefreshing(true); reload(); }} />}
          </span>
        </header>
      )}
      {!project && data && (
        <HomeJumps
          asks={asks.length}
          report={latest && { title: latest.section.title, projectName: latest.projectName, opens: true }}
          widgets={widgetsOnShow}
          onAsk={toAsk}
          onReport={toReport}
          onWidgets={toWidgets}
        />
      )}
      {densityRefusal && !densityRefusal.saved && (
        <p className="home-note home-density-note" role="status">
          {t.densityNotKept(densityRefusal.detail)}
        </p>
      )}
      {banner.shown && bannerError && (
        <div className="home-error-slot">
          <p className={`inline-error home-error-banner${banner.leaving ? " is-leaving" : ""}`} role="alert">
            {bannerError.kind === "unavailable" ? t.unavailable : bannerError.kind === "order" ? t.orderNotSaved(bannerError.reason) : bannerError.reason}
            {data && t.lastReading}
          </p>
        </div>
      )}
      {!data ? (
        !error && (
          <div className="loading-state">
            <LoaderCircle className="spin" size={19} />
            {t.reading}
          </div>
        )
      ) : project ? (
        <ProjectHome
          key={project}
          projectId={project}
          panel={projectPanel ?? null}
          workspaceId={workspaceId}
          agents={projectAgents(project)}
          needsYou={data.needsYou.filter((item) => item.projectId === project)}
          readOnly={readOnly}
          densityWorkspace={densityWorkspace}
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            reload();
          }}
          onNavigate={onNavigate}
          onChanged={changed}
          onSeen={seen}
          focus={report ? null : (pageFocus.current?.focus ?? null)}
          arrival={
            arrival && landed && project === arrival.origin.projectId && arrival.origin.key !== null
              ? {
                  key: arrival.origin.key,
                  inCard: landed.kind === "changed",
                  note: landedNote(
                    (arrival.origin.snapshot?.sectionKind ??
                      [...(projectPanel?.brief.sections ?? []), ...(projectPanel?.brief.teamSections ?? [])].find((s) => s.key === arrival.origin.key)?.kind) === "ask",
                  ),
                }
              : null
          }
          onExit={() => onCloseProject?.()}
        />
      ) : (
        // What needs you, answered here; then each project at a glance; then My widgets (YN-86 §2.1).
        <div className="home-layout">
          <div className="home-needs-area" id="home-current-needs" tabIndex={-1}>
            <NeedsYou
              items={data.needsYou}
              data={data}
              workspaceId={workspaceId}
              visit={visit}
              agentsOf={projectAgents}
              readOnly={readOnly}
              projectName={projectName}
              onJump={jump}
              onSeen={seen}
              onChanged={changed}
              onNavigate={onNavigate}
            />
          </div>
          <div className="home-projects">
            {landed?.kind === "gone" && landedNote(false)}
            {reordering && <p className="home-note home-reorder-note">{t.reorderNote}</p>}
            <ProjectGlance
              panels={panels}
              needsYou={data.needsYou}
              agentsOf={projectAgents}
              reorder={reordering ? { busy: saving, move: (index, by) => void move(index, by) } : null}
              onOpen={(projectId, sectionKey) => onOpenProject?.(projectId, sectionKey)}
            />
          </div>
          {/* The design preview has no workspace: its own default layout, not changed. */}
          <HomeWidgets
            widgets={widgets}
            layout={arranged}
            onChange={layout ? widgetLayout.change : undefined}
            onResetSizes={layout ? resetSizes : undefined}
          />
        </div>
      )}
    </div>
    {report && (
      <ReportPage
        key={report.entry}
        link={report.link}
        back={!!report.back}
        data={data}
        readFailed={readFailed}
        workspaceId={workspaceId}
        agents={projectAgents(report.link.projectId)}
        readOnly={readOnly}
        onBack={() => closeReport()}
        onOpenVersion={(link) => openReport(link, null, null)}
        onShowProject={(projectId) =>
          // On Home, its page; on the project's own page, that card (YN-86 §2.4).
          closeReport(() => {
            if (projectId === project) {
              jumpToEl(() => document.getElementById(sectionDomId(projectId, report.link.key)), "center", true);
              return;
            }
            onOpenProject?.(projectId, report.link.key);
          })
        }
        onSeen={seen}
        onOpened={opened}
        readError={error?.kind === "read" || error?.kind === "unavailable" ? error : null}
        onRetry={reload}
      />
    )}
    </div>
    </ReportOpen.Provider>
    </HomeReadContext.Provider>
    </BriefDensity.Provider>
    </DeckSizes.Provider>
    </PinsContext.Provider>
    </CardFoldWorkspace.Provider>
    </CardAgents.Provider>
    </HomeNavigation.Provider>
  );
}
