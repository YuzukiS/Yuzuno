import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Bell, ChevronDown, Folder, Minus, Plus } from "lucide-react";
import type { ProjectGroupStyle } from "./appearance";
import { strings, useStrings } from "./i18n";
import { groupSummary, type ProjectGroup } from "./project-groups";
import type { Agent } from "./types";
import "./project-groups.css";

// A group's own controls and marks; its name is the project's (T-189).
const text = strings({
  toggle: (folded: boolean, name: string) => `${folded ? "Open" : "Fold"} ${name}`,
  count: (count: number) => `${count} ${count === 1 ? "agent" : "agents"}`,
  newIn: (name: string) => `New agent in ${name}`,
  newWithout: "New agent without a project",
  needs: (count: number) => `${count} ${count === 1 ? "needs" : "need"} you`,
  working: (count: number) => `${count} working`,
  unread: (count: number) => `${count} unread`,
  listJoin: ", ",
}, {
  toggle: (folded, name) => `${folded ? "展开" : "折叠"} ${name}`,
  count: (count) => `${count} 个 Agent`,
  newIn: (name) => `在 ${name} 中新建 Agent`,
  newWithout: "新建不属于任何项目的 Agent",
  needs: (count) => `${count} 项需要你`,
  working: (count) => `${count} 个工作中`,
  unread: (count) => `${count} 条未读`,
  listJoin: "，",
});

const foldedKey = (workspaceId: string) => `yuzuno.projectGroupsFolded.${workspaceId}`;
function readFolded(workspaceId: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(foldedKey(workspaceId)) || "[]");
    return new Set<string>(Array.isArray(saved) ? saved.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set<string>();
  }
}

/** Which groups are folded, remembered on this device per workspace. */
function useFolded(workspaceId: string) {
  const [folded, setFolded] = useState(() => readFolded(workspaceId));
  useEffect(() => setFolded(readFolded(workspaceId)), [workspaceId]);
  const fold = (key: string, value: boolean) =>
    setFolded((old) => {
      if (old.has(key) === value) return old;
      const next = new Set(old);
      if (value) next.add(key);
      else next.delete(key);
      try {
        localStorage.setItem(foldedKey(workspaceId), JSON.stringify([...next]));
      } catch {
        // Folded for this visit even without storage.
      }
      return next;
    });
  return [folded, fold] as const;
}

// The Agent the grouped list last showed as chosen, per workspace, kept
// while the list is not grouped (one project's list, No grouping, a single
// group): an Agent chosen meanwhile still opens its group when the groups
// come back. A reload starts afresh.
const lastChosen = new Map<string, string>();

/**
 * The Agent list by project, as Settings → Appearance → Project groups
 * chooses: headings, cards or colour bands. Each group folds and opens, and
 * can start a new Agent in its project. A search shows every group open; an
 * Agent chosen elsewhere opens its group.
 */
export function GroupedAgents({
  groups,
  style,
  workspaceId,
  selectedId,
  searching,
  renderAgent,
  onCreate,
}: {
  groups: ProjectGroup[];
  style: Exclude<ProjectGroupStyle, "none">;
  workspaceId: string;
  selectedId: string | null;
  searching: boolean;
  renderAgent: (agent: Agent) => ReactNode;
  /** Start a new Agent in this project; null for one without a project. */
  onCreate: (projectId: string | null) => void;
}) {
  const [folded, fold] = useFolded(workspaceId);
  // Only choosing another Agent opens its group, once the Agent is listed
  // (another in the same project too): folding the chosen Agent's own group
  // by hand stays folded through refreshes, re-renders and reloads. Nothing
  // chosen, as while Home is open, is no choice: coming back to the same
  // Agent keeps the fold.
  const chosen = selectedId || null;
  const reveal = useRef<string | null>(null);
  useEffect(() => {
    if (!chosen) return;
    const before = lastChosen.get(workspaceId) ?? chosen;
    lastChosen.set(workspaceId, chosen);
    if (chosen !== before) reveal.current = chosen;
  }, [workspaceId, chosen]);
  useEffect(() => {
    const key = reveal.current && groups.find((group) => group.agents.some((agent) => agent.id === reveal.current))?.key;
    if (!key) return;
    reveal.current = null;
    fold(key, false);
  });
  return (
    <>
      {groups.map((group) => {
        const isFolded = folded.has(group.key) && !searching;
        return (
          <GroupSection
            key={group.key}
            group={group}
            style={style}
            folded={isFolded}
            onToggle={() => fold(group.key, !isFolded)}
            onCreate={() => onCreate(group.projectId)}
          >
            {group.agents.map(renderAgent)}
          </GroupSection>
        );
      })}
    </>
  );
}

/**
 * Whether a folded heading's name and marks no longer share one line, which
 * puts the marks under the name. Measured like the rail heading: each part
 * at its own width, the name untruncated, so the answer never flips back and
 * forth as the layout changes. `marks` names what is shown; null when none.
 */
function useStacked(marks: string | null) {
  const toggle = useRef<HTMLButtonElement>(null);
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const el = toggle.current;
    if (!marks || !el) {
      setStacked(false);
      return;
    }
    const fit = () => {
      const style = getComputedStyle(el);
      const parts = [...el.children];
      const needed =
        parts.reduce((sum, part) => sum + (part.classList.contains("project-group-name") ? part.scrollWidth : part.getBoundingClientRect().width), 0) +
        (parseFloat(style.columnGap) || 0) * (parts.length - 1);
      const room = el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      setStacked(needed > room + 0.5);
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(el);
    for (const part of el.children) observer?.observe(part);
    void document.fonts?.ready.then(fit);
    return () => observer?.disconnect();
  }, [marks]);
  return [toggle, stacked] as const;
}

function GroupSection({
  group,
  style,
  folded,
  onToggle,
  onCreate,
  children,
}: {
  group: ProjectGroup;
  style: Exclude<ProjectGroupStyle, "none">;
  folded: boolean;
  onToggle: () => void;
  onCreate: () => void;
  children: ReactNode;
}) {
  const t = useStrings(text);
  const body = useId();
  const count = group.agents.length;
  const summary = groupSummary(group.agents);
  const marked = folded && (summary.needs > 0 || summary.working > 0 || summary.unread > 0);
  const [toggle, stacked] = useStacked(marked ? `${summary.needs}/${summary.working}/${summary.unread}` : null);
  return (
    <section
      className={`project-group project-group-${style}${group.projectId ? "" : " is-unassigned"}${folded ? " is-folded" : ""}`}
      style={group.colour ? ({ "--project": group.colour } as CSSProperties) : undefined}
      aria-label={group.name}
      data-group={group.key}
    >
      <div className="project-group-head" data-stacked={(marked && stacked) || undefined}>
        <button
          ref={toggle}
          type="button"
          className="project-group-toggle"
          aria-expanded={!folded}
          aria-controls={body}
          title={t.toggle(folded, group.name)}
          onClick={onToggle}
        >
          <ChevronDown size={12} className="project-group-chevron" aria-hidden="true" />
          {style === "bands" ? (
            <span className="project-group-dot" aria-hidden="true" />
          ) : group.projectId ? (
            <Folder size={12} aria-hidden="true" />
          ) : (
            <Minus size={12} aria-hidden="true" />
          )}
          <span className="project-group-name">{group.name}</span>
          {marked && <Summary {...summary} />}
          <span className="project-group-count" aria-label={t.count(count)}>
            {count}
          </span>
        </button>
        {group.creatable && (
          <button
            type="button"
            className="project-group-add"
            aria-label={t.newIn(group.name)}
            title={group.projectId ? t.newIn(group.name) : t.newWithout}
            onClick={onCreate}
          >
            <Plus size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="project-group-body" id={body} inert={folded}>
        <div className="project-group-rows">{children}</div>
      </div>
    </section>
  );
}

/** A folded group's marks: requests waiting, work running, unread. */
function Summary({ needs, working, unread }: ReturnType<typeof groupSummary>) {
  const t = useStrings(text);
  const said = [
    needs && t.needs(needs),
    working && t.working(working),
    unread && t.unread(unread),
  ].filter(Boolean);
  if (!said.length) return null;
  return (
    <span className="project-group-summary" aria-label={said.join(t.listJoin)} title={said.join(" · ")}>
      {needs > 0 && (
        <span className="project-group-mark is-attention" aria-hidden="true">
          <Bell size={9} />
          {needs}
        </span>
      )}
      {working > 0 && (
        <span className="project-group-mark" aria-hidden="true">
          <span className="status-dot working" />
          {working}
        </span>
      )}
      {unread > 0 && (
        <span className="project-group-mark" aria-hidden="true">
          <span className="project-group-ring" />
          {unread}
        </span>
      )}
    </span>
  );
}
