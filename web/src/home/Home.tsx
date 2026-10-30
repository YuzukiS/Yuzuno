import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { House, ListOrdered, LoaderCircle, RefreshCw } from "lucide-react";
import { errorText } from "../api";
import { langTag, useLanguage } from "../i18n";
import { shellText } from "../shell-text";
import type { Agent, Project } from "../types";
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    const clear = () => target.removeAttribute("data-home-highlight");
    const show = () => {
      // Only the user's click scrolls Home; new content never does.
      target.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
      target.focus({ preventScroll: true });
      target.setAttribute("data-home-highlight", "");
      timer = setTimeout(clear, 2400);
    };
    // A card the user collapsed opens to show what the jump is to (T-115).
    if (unfoldAround(target)) frame = requestAnimationFrame(show);
    else show();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      clear();
    };
  }, [reveal]);
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
    <div className="home-view" lang={langTag(language)} data-density={density}>
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
              target?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
              target?.focus({ preventScroll: true });
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
    </HomeReadContext.Provider>
    </BriefDensity.Provider>
    </PinsContext.Provider>
    </CardFoldWorkspace.Provider>
    </HomeNavigation.Provider>
  );
}
