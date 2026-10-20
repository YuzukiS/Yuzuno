import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { House, ListOrdered, LoaderCircle, RefreshCw } from "lucide-react";
import { errorText } from "../api";
import type { Agent, Project } from "../types";
import { rememberSeenBlocks } from "./brief/block-changes";
import { keepUnchanged, projectDomId, requestDomId, sectionDomId } from "./brief-layout";
import { markSeen, readHome, saveHomeOrder, type SeenMark } from "./home-api";
import { HomePanel } from "./HomePanel";
import { HomeNavigation, type HomeTarget } from "./home-navigation";
import { HomeWidgets, type HomeWidget } from "./HomeWidgets";
import { MachineWidget } from "./MachineWidget";
import { NeedsYou } from "./NeedsYou";
import { PinnedSection } from "./PinnedSection";
import { previewHome, previewProjectAgents } from "./preview-home";
import type { HomeData, NeedsYouItem, ProjectPanel, Section } from "./types";
import { PinsContext, pinSource, pinWidgetId, resolvePin, useWidgetLayout, type PinControl } from "./widget-layout";
import "./home.css";

export type { HomeTarget } from "./home-navigation";

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
 * Home: what needs you across projects, then one panel per Project in
 * Project Priority; beside them, a column of widgets (this machine's load
 * first). It reads Core's facts and the Agents' Briefs; it never mounts a
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
  const [data, setData] = useState<HomeData | null>(readOnly ? previewHome : null);
  const [error, setError] = useState("");
  // Whether the last read failed, so pinned sections say they are not current.
  const [readFailed, setReadFailed] = useState(false);
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
    readHome(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!value || !Array.isArray(value.projects) || !Array.isArray(value.needsYou))
          throw new Error("Home is unavailable from this Core.");
        setData((previous) => keepUnchanged(previous, value));
        onNeedsYou?.(value.needsYou);
        setError("");
        setReadFailed(false);
      })
      .catch((e) => {
        // The last read stays on screen; nothing is blanked while retrying.
        if (controller.signal.aborted) return;
        setError(errorText(e));
        setReadFailed(true);
      });
    return () => controller.abort();
    // A new report callback is not a reason to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, revision, jobsRevision, tick]);
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
    setError("");
    try {
      await saveHomeOrder(ids);
      reload();
    } catch (e) {
      setLocalOrder(previous);
      setError(`The order was not saved: ${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  }
  const projectName = (id: string | null) =>
    id
      ? data?.projects.find((p) => p.project.id === id)?.project.name ||
        projects.find((p) => p.id === id)?.name ||
        "Unknown project"
      : "No project";
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
    // Only the user's click scrolls Home; new content never does.
    target.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
    target.focus({ preventScroll: true });
    target.setAttribute("data-home-highlight", "");
    const clear = () => target.removeAttribute("data-home-highlight");
    const timer = setTimeout(clear, 2400);
    return () => {
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
      name: "Machines",
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
    <PinsContext.Provider value={pins}>
    <div className="home-view">
      <header className="home-header">
        <h1>
          <House size={18} />
          Home
        </h1>
        <span className="home-header-tools">
          {data && panels.length > 1 && !readOnly && (
            <button
              type="button"
              className={`quiet-button${reordering ? " is-active" : ""}`}
              aria-pressed={reordering}
              onClick={() => setReordering((v) => !v)}
            >
              <ListOrdered size={13} />
              {reordering ? "Done" : "Reorder"}
            </button>
          )}
          {!readOnly && (
            <button type="button" className="icon-button" aria-label="Refresh Home" title="Refresh Home" onClick={reload}>
              <RefreshCw size={14} />
            </button>
          )}
        </span>
      </header>
      {error && (
        <p className="inline-error home-error-banner" role="alert">
          {error}
          {data && " · Showing the last reading."}
        </p>
      )}
      {!data ? (
        !error && (
          <div className="loading-state">
            <LoaderCircle className="spin" size={19} />
            Reading your projects…
          </div>
        )
      ) : (
        // Wide: Needs you and the projects on the left, widgets on the
        // right. Narrow: one column, the widgets between the two.
        <div className="home-layout">
          <div className="home-needs-area">
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
              <p className="home-note home-reorder-note">
                The order only changes how Home is laid out: higher projects come first and show more of their Brief.
              </p>
            )}
            {panels.length === 0 ? (
              <p className="home-note home-empty">
                No projects yet. Create one from the project menu, then add its Agents.
              </p>
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
    </PinsContext.Provider>
    </HomeNavigation.Provider>
  );
}
