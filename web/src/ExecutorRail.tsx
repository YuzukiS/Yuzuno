import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { TurnSeen } from "./attention";
import { lifecycleText, railParts } from "./executor-lifecycle";
import { useStrings } from "./i18n";
import type { Agent } from "./types";
import "./executor-rail.css";

const openKey = (workspaceId: string) => `yuzuno.archivedExecutorsOpen.${workspaceId}`;
function readOpen(workspaceId: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(openKey(workspaceId)) || "[]");
    return new Set<string>(Array.isArray(saved) ? saved.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set<string>();
  }
}

/** Which lists show their archived executors, remembered on this device per
 * Workspace; folded until opened. */
function useArchivedOpen(workspaceId: string) {
  const [open, setOpen] = useState(() => readOpen(workspaceId));
  useEffect(() => setOpen(readOpen(workspaceId)), [workspaceId]);
  const toggle = (key: string) =>
    setOpen((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(openKey(workspaceId), JSON.stringify([...next]));
      } catch {
        // Open for this visit even without storage.
      }
      return next;
    });
  return [open, toggle] as const;
}

/**
 * One Project's Agents in the sidebar (T-36 S3): its leads, its other
 * Agents, its 任务执行者 · Task executors group and, folded, its archived
 * executors (docs/executor-model.md "An executor's lifecycle"). With
 * `order` (the Attention order), executors go waiting on you or failed;
 * delivered, awaiting release; running; archiving; queued or starting.
 * A search, or an archived executor chosen, shows the fold open.
 */
export function ExecutorRail({
  agents,
  listKey,
  workspaceId,
  selectedId,
  searching,
  order,
  renderAgent,
}: {
  agents: readonly Agent[];
  /** What the fold's state is remembered by: the Project group's key. */
  listKey: string;
  workspaceId: string;
  selectedId: string | null;
  searching: boolean;
  order?: { seen: TurnSeen; waiting?: ReadonlySet<string> };
  renderAgent: (agent: Agent) => ReactNode;
}) {
  const t = useStrings(lifecycleText);
  const body = useId();
  const [open, toggle] = useArchivedOpen(workspaceId);
  const parts = railParts(agents, order);
  const archivedShown = open.has(listKey) || searching || parts.archived.some((a) => a.id === selectedId);
  // While some wait for a slot, how many run and how many wait (T-43 S2).
  const states = parts.executors.map((a) => a.executor?.state);
  const running = states.filter((s) => s === "running" || s === "delivering").length;
  const queued = states.filter((s) => s === "queued" || s === "starting").length;
  return (
    <>
      {parts.members.map(renderAgent)}
      {parts.executors.length > 0 && (
        <section className="rail-executors" aria-label={t.executors} data-rail-part="executors">
          <h3 className="rail-subgroup-head">
            <span>{t.executors}</span>
            {queued > 0 && <span className="rail-subgroup-slots" title={t.slotUseTitle}>{t.slotUse(running, queued)}</span>}
            <span className="rail-subgroup-count">{parts.executors.length}</span>
          </h3>
          {parts.executors.map(renderAgent)}
        </section>
      )}
      {parts.archived.length > 0 && (
        <section className="rail-archived" aria-label={t.archived} data-rail-part="archived">
          <button
            type="button"
            className="rail-subgroup-head rail-archived-toggle"
            aria-expanded={archivedShown}
            aria-controls={body}
            title={t.archivedToggle(!archivedShown, parts.archived.length)}
            onClick={() => toggle(listKey)}
          >
            <ChevronDown size={11} className="rail-archived-chevron" aria-hidden="true" />
            <span>{t.archived}</span>
            <span className="rail-subgroup-count">{parts.archived.length}</span>
          </button>
          <div id={body} className="rail-archived-rows">
            {archivedShown && parts.archived.map(renderAgent)}
          </div>
        </section>
      )}
    </>
  );
}
