import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { House, ListOrdered, LoaderCircle, RefreshCw } from "lucide-react";
import { errorText } from "../api";
import { langTag, useLanguage } from "../i18n";
import { shellText } from "../shell-text";
import type { Agent, HomeReplyOrigin, Project } from "../types";
import { reportLinkHref, type MessageLink, type ReportLink } from "../deep-link";
import { arrivalOf, sameSectionLive } from "../home-reply/home-reply-model";
import { ReplyArrival } from "../home-reply/ReplyArrival";
import { rememberSeenBlocks } from "./brief/block-changes";
import { keepUnchanged, projectDomId, requestDomId, sectionDomId } from "./brief-layout";
import { markSeen, readHome, saveHomeOrder, type SeenMark } from "./home-api";
import { HomePanel } from "./HomePanel";
import { HomeNavigation, type HomeTarget } from "./home-navigation";
import { HomeReadContext, type HomeRead } from "./home-read";
import { HomeWidgets, type HomeWidget } from "./HomeWidgets";
import { HomeReturnOverview } from "./HomeReturnOverview";
import { MachineWidget } from "./MachineWidget";
import { NeedsYou } from "./NeedsYou";
import { PinnedSection } from "./PinnedSection";
import { previewHome, previewProjectAgents } from "./preview-home";
import type { HomeData, NeedsYouItem, ProjectPanel, Section } from "./types";
import { PinsContext, pinSource, pinWidgetId, resolvePin, useWidgetLayout, type PinControl } from "./widget-layout";
import "./home.css";
import { CardFoldWorkspace, unfoldAround } from "./card-fold";
import { homeText } from "./home-text";
import { BriefDensity, chooseHomeDensity, densities, useHomeDensity, useHomeDensityRefusal } from "./home-density";
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
 * Home: what needs you across projects, then My widgets (this machine's
 * load and the sections the user pinned), then one panel per Project in
 * Project Priority. It reads Core's facts and the Agents' Briefs; it never
 * mounts a conversation.
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
  arrival = null,
  onBackToReply,
  report: incomingReport = null,
  visit = 0,
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
  // What went wrong, worded when shown so it follows the language (T-189):
  // a reply Home can't use, an order not saved, or Core's reason as it came.
  const activeWorkspace = useRef(workspaceId);
  activeWorkspace.current = workspaceId;
  const [errorState, setErrorState] = useState<(HomeError & { workspaceId: string }) | null>(null);
  const error = errorState?.workspaceId === workspaceId ? errorState : null;
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
  // Panels the needs-you row jumped to, shown whole for this visit.
  const [reveal, setReveal] = useState<{ n: number; projects: Record<string, number> }>({ n: 0, projects: {} });
  // The Needs you area's landing mark, from the return overview (T-19).
  const needsSettled = useRef<(() => void) | null>(null);
  useEffect(() => () => needsSettled.current?.(), []);
  const pendingJump = useRef<{ target: () => HTMLElement | null; n: number } | null>(null);
  const reload = useCallback(() => setTick((n) => n + 1), []);
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
  const panels = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.projects.map((p) => [p.project.id, p] as const));
    return displayOrder(data, localOrder).map((id) => byId.get(id)!);
  }, [data, localOrder]);
  useEffect(() => {
    // A saved order shows as soon as Core reports it.
    if (localOrder && data && !saving && data.order.join("\n") === localOrder.join("\n")) setLocalOrder(null);
  }, [data, localOrder, saving]);
  async function move(index: number, by: -1 | 1) {
    const ids = panels.map((p) => p.project.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    const previous = localOrder;
    setLocalOrder(ids);
    setSaving(true);
    setError(null);
    try {
      await saveHomeOrder(ids);
      reload();
    } catch (e) {
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
  /** Shows the project's panel whole, then scrolls to and focuses the target in it. */
  function revealIn(projectId: string, target: () => HTMLElement | null) {
    const n = reveal.n + 1;
    pendingJump.current = { target: () => target() || document.getElementById(projectDomId(projectId)), n };
    setReveal({ n, projects: { ...reveal.projects, [projectId]: n } });
  }
  // A reply's "Open on Home" (T-9): once Home has read, to the section it
  // answered while Home shows that very section, else to its project; once
  // per opening. What has become of that version is said from what Home
  // reads now, never decided before, and never of another section.
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
  function jump(item: NeedsYouItem) {
    const panel = item.projectId ? panels.find((p) => p.project.id === item.projectId) : undefined;
    if (!panel) {
      // An approval from an Agent outside any project lives in its conversation.
      if (item.kind === "approval" && item.requestId)
        onNavigate({ kind: "request", agentId: item.agentId, requestId: item.requestId });
      return;
    }
    revealIn(panel.project.id, () =>
      item.kind === "approval" && item.requestId
        ? document.getElementById(requestDomId(item.requestId))
        : item.sectionKey
          ? document.getElementById(sectionDomId(panel.project.id, item.sectionKey))
          : null,
    );
  }
  useEffect(() => {
    const jumpTo = pendingJump.current;
    if (!jumpTo || jumpTo.n !== reveal.n) return;
    pendingJump.current = null;
    const target = jumpTo.target();
    if (!target) return;
    let frame = 0;
    let settled: (() => void) | undefined;
    const show = () => {
      // Only the user's click scrolls Home; new content never does.
      const smooth = !reducedMotion();
      target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
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
  // a draft.
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
    revealIn(projectId, () => (key !== null && sameSectionLive(landed) ? document.getElementById(sectionDomId(projectId, key)) : null));
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
  // Back on Home: focus where the report was opened from, with a short ring;
  // its project's heading when that is gone (the card marked seen, say).
  useEffect(() => {
    if (report) return;
    const back = returnTo.current;
    returnTo.current = null;
    if (!back) return;
    const target = back.from?.isConnected
      ? back.from
      : document.getElementById(projectDomId(back.projectId))?.querySelector<HTMLElement>(".home-panel-head > button");
    if (!target) return;
    if (!back.from?.isConnected) target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
    const card = target.closest<HTMLElement>(".home-section, .home-panel") ?? target;
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
  const widgetLayout = useWidgetLayout(workspaceId);
  const { layout, pin, unpin } = widgetLayout;
  /** Every pin is made here, and only of a section pinSource allows. */
  const pinIfAllowed = useCallback(
    (projectId: string, section: Section) => {
      const source = pinSource(data, projectId, section);
      if (source) pin(projectId, source.projectName, source.section);
    },
    [data, pin],
  );
  const pins = useMemo<PinControl | null>(
    () =>
      readOnly || !layout
        ? null
        : {
            isPinned: (projectId: string, section: Section) =>
              layout.pins.some((p) => p.projectId === projectId && p.id === section.id),
            canPin: (projectId: string, section: Section) => !!pinSource(data, projectId, section),
            toggle: (projectId: string, section: Section) => {
              const pinned = layout.pins.find((p) => p.projectId === projectId && p.id === section.id);
              if (pinned) unpin(pinned);
              else pinIfAllowed(projectId, section);
            },
          },
    [readOnly, layout, unpin, data, pinIfAllowed],
  );
  const widgets: HomeWidget[] = [
    {
      id: "machines",
      name: t.machines,
      body: <MachineWidget projectName={projectName} readOnly={readOnly} />,
    },
    // The design preview has no pins: its sections are not this workspace's.
    ...(readOnly || !layout ? [] : layout.pins).map((p) => {
      const source = resolvePin(p, data, readFailed);
      return {
        id: pinWidgetId(p),
        name: source.state === "shown" ? source.section.title : p.title,
        onUnpin: () => unpin(p),
        body: (
          <PinnedSection
            pin={p}
            source={source}
            onOpen={() => revealIn(p.projectId, () => document.getElementById(sectionDomId(p.projectId, p.key)))}
            onUnpin={() => unpin(p)}
            reply={readOnly ? undefined : { workspaceId, agents: byProject.get(p.projectId) || noAgents }}
            onPinCurrent={
              source.state === "replaced" && pinSource(data, p.projectId, source.section)
                ? () => {
                    unpin(p);
                    pinIfAllowed(p.projectId, source.section);
                  }
                : undefined
            }
          />
        ),
      };
    }),
  ];
  const projectAgents = (id: string) => byProject.get(id) || noAgents;
  const needsFor = (panel: ProjectPanel) =>
    data?.needsYou.filter((item) => item.projectId === panel.project.id) || [];
  return (
    <HomeNavigation.Provider value={onNavigate}>
    {/* Which cards are collapsed is kept per Workspace; the preview keeps none (T-115). */}
    <CardFoldWorkspace.Provider value={readOnly ? "" : workspaceId}>
    <PinsContext.Provider value={pins}>
    <BriefDensity.Provider value={density}>
    <HomeReadContext.Provider value={readOnly ? null : homeRead}>
    <ReportOpen.Provider value={cardReport}>
    <div className="home-stage">
    <div
      className={`home-view${report ? " is-under-report" : ""}`}
      lang={langTag(language)}
      data-density={density}
      inert={report ? true : undefined}
    >
      <header className="home-header">
        <h1>
          <House size={18} />
          {t.home}
        </h1>
        <span className="home-header-tools">
          <span className="home-density" role="group" aria-label={t.density} title={t.densityHelp}>
            {densities.map((option) => (
              <button
                key={option}
                type="button"
                className="home-density-option"
                aria-pressed={density === option}
                title={option === "low" ? t.densityLowHelp : t.densityHighHelp}
                onClick={() => chooseHomeDensity(densityWorkspace, option)}
              >
                {option === "low" ? t.densityLow : t.densityHigh}
              </button>
            ))}
          </span>
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
          {!readOnly && (
            <button type="button" className="icon-button" aria-label={t.refresh} title={t.refresh} onClick={reload}>
              <RefreshCw size={14} />
            </button>
          )}
        </span>
      </header>
      {densityRefusal && !densityRefusal.saved && (
        <p className="home-note home-density-note" role="status">
          {t.densityNotKept(densityRefusal.detail)}
        </p>
      )}
      {error && (
        <p className="inline-error home-error-banner" role="alert">
          {error.kind === "unavailable" ? t.unavailable : error.kind === "order" ? t.orderNotSaved(error.reason) : error.reason}
          {data && t.lastReading}
        </p>
      )}
      {!data ? (
        !error && (
          <div className="loading-state">
            <LoaderCircle className="spin" size={19} />
            {t.reading}
          </div>
        )
      ) : (
        // Needs you first, on its own; then My widgets, two columns where
        // the pane is wide; then the projects.
        <div className="home-layout">
          <HomeReturnOverview
            key={readOnly ? "preview" : workspaceId}
            data={data}
            readFailed={readFailed}
            onSection={(projectId, key) => revealIn(projectId, () => document.getElementById(sectionDomId(projectId, key)))}
            onNeedsYou={() => {
              const target = document.getElementById("home-current-needs");
              if (!target) return;
              const smooth = !reducedMotion();
              target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
              target.focus({ preventScroll: true });
              needsSettled.current?.();
              needsSettled.current = settleWhenLanded(target, "data-home-highlight", smooth);
            }}
            onNavigate={onNavigate}
          />
          <div className="home-needs-area" id="home-current-needs" tabIndex={-1}>
            <NeedsYou items={data.needsYou} projectName={projectName} onJump={jump} />
          </div>
          {/* The design preview has no workspace: its own default layout, not changed. */}
          <HomeWidgets
            widgets={widgets}
            layout={readOnly ? (layout ?? { order: [], hidden: [], pins: [] }) : layout}
            onChange={layout ? widgetLayout.change : undefined}
          />
          <div className="home-main">
            {landed?.kind === "gone" && landedNote(false)}
            {reordering && (
              <p className="home-note home-reorder-note">{t.reorderNote}</p>
            )}
            {panels.length === 0 ? (
              <p className="home-note home-empty">{t.noProjects}</p>
            ) : (
              <div className="home-panels">
                {panels.map((panel, index) => (
                  <HomePanel
                    key={panel.project.id}
                    panel={panel}
                    rank={index}
                    workspaceId={workspaceId}
                    agents={projectAgents(panel.project.id)}
                    needsYou={needsFor(panel)}
                    readOnly={readOnly}
                    reveal={reveal.projects[panel.project.id] || 0}
                    arrival={
                      arrival && landed && panel.project.id === arrival.origin.projectId && arrival.origin.key !== null
                        ? {
                            key: arrival.origin.key,
                            inCard: landed.kind === "changed",
                            note: landedNote(
                              (arrival.origin.snapshot?.sectionKind ??
                                panel.brief.sections.find((s) => s.key === arrival.origin.key)?.kind) === "ask",
                            ),
                          }
                        : null
                    }
                    reorder={
                      reordering
                        ? {
                            busy: saving,
                            onUp: index > 0 ? () => void move(index, -1) : undefined,
                            onDown: index < panels.length - 1 ? () => void move(index, 1) : undefined,
                          }
                        : null
                    }
                    onNavigate={onNavigate}
                    onChanged={changed}
                    onSeen={seen}
                  />
                ))}
              </div>
            )}
          </div>
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
        onShowProject={(projectId) => closeReport(() => revealIn(projectId, () => null))}
        onSeen={seen}
        readError={error?.kind === "read" || error?.kind === "unavailable" ? error : null}
        onRetry={reload}
      />
    )}
    </div>
    </ReportOpen.Provider>
    </HomeReadContext.Provider>
    </BriefDensity.Provider>
    </PinsContext.Provider>
    </CardFoldWorkspace.Provider>
    </HomeNavigation.Provider>
  );
}
