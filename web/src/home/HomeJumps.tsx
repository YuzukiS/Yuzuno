import { useLayoutEffect, useRef, type ReactNode } from "react";
import { FileText, LayoutGrid, MessageCircleQuestion } from "lucide-react";
import { useStrings } from "../i18n";
import { homeText } from "./home-text";
import type { HomeData, NeedsYouItem, Section } from "./types";
import { Tip, TipText } from "../Tip";

/**
 * The live report on Home updated last (YN-86): across the projects in
 * Home's order, the sections each panel shows, never History or the team's
 * details. A tie keeps the first, so the choice holds while nothing changes.
 * Opening a report changes no update time.
 */
export function latestReport(data: HomeData, order: readonly string[]): { projectId: string; projectName: string; section: Section } | null {
  let latest: { projectId: string; projectName: string; section: Section; at: number } | null = null;
  const byId = new Map(data.projects.map((panel) => [panel.project.id, panel] as const));
  for (const id of order) {
    const panel = byId.get(id);
    if (!panel) continue;
    for (const section of panel.brief.sections) {
      if (section.kind !== "report" || section.history) continue;
      const at = Date.parse(section.updatedAt);
      if (!Number.isFinite(at) || (latest && at <= latest.at)) continue;
      latest = { projectId: id, projectName: panel.project.name, section, at };
    }
  }
  return latest && { projectId: latest.projectId, projectName: latest.projectName, section: latest.section };
}

/**
 * The open Asks waiting for the user, as Needs you lists them (Core's
 * order: Project Priority, then the longest wait). An Ask put off is not
 * among them, nor approvals and questions, which keep their own entries.
 */
export const waitingAsks = (items: readonly NeedsYouItem[]) => items.filter((item) => item.kind === "ask" && item.projectId && item.sectionKey);

/**
 * Scrolls Home's own scroller, and nothing around it, to show `target`
 * (YN-86): centred in the room below the jumps (the view's scroll-padding
 * and the target's scroll-margin), or at its top when it is taller than
 * that room. Outside Home it scrolls as the browser does.
 */
export function scrollWithinHome(target: HTMLElement, block: ScrollLogicalPosition, smooth: boolean) {
  const view = target.closest<HTMLElement>(".home-view");
  const behavior: ScrollBehavior = smooth ? "smooth" : "auto";
  if (!view) {
    target.scrollIntoView({ behavior, block });
    return;
  }
  const px = (value: string) => Number.parseFloat(value) || 0;
  const padding = px(getComputedStyle(view).scrollPaddingTop);
  const margin = px(getComputedStyle(target).scrollMarginTop);
  const box = target.getBoundingClientRect();
  const top = box.top - view.getBoundingClientRect().top - view.clientTop + view.scrollTop;
  const room = view.clientHeight - padding;
  let to: number;
  if (block === "nearest" && box.top - view.getBoundingClientRect().top >= padding + margin && box.bottom <= view.getBoundingClientRect().bottom) return;
  if (block === "start" || box.height + margin > room) to = top - padding - margin;
  else if (block === "end") to = top + box.height - view.clientHeight;
  else to = top - padding - (room - box.height) / 2;
  to = Math.max(0, Math.min(to, view.scrollHeight - view.clientHeight));
  if (typeof view.scrollTo === "function") view.scrollTo({ top: to, behavior });
  else view.scrollTop = to;
}

/** The Ask after the one last gone to, from the first again; the first when that one is no longer waiting. */
export function nextAsk(asks: readonly NeedsYouItem[], last: string | null): NeedsYouItem | null {
  if (!asks.length) return null;
  const keyOf = (item: NeedsYouItem) => JSON.stringify([item.projectId, item.sectionKey]);
  const at = last === null ? -1 : asks.findIndex((item) => keyOf(item) === last);
  return asks[(at + 1) % asks.length];
}
export const askKey = (item: NeedsYouItem) => JSON.stringify([item.projectId, item.sectionKey]);

/**
 * Home's own jumps (YN-86): to the Asks waiting for the user, the report
 * updated last and My widgets, from wherever Home is scrolled to. On the
 * whole of Home, whose cards are on their projects' pages, the report opens
 * as its page over Home (`report.opens`); on a Project's page it is a card
 * there to go to. It stays at the top of Home's own scroller, under nothing
 * of the app's, and goes with Home when a report covers it. Each jump is the
 * user's own press; nothing here scrolls on its own. With nothing to go to,
 * a jump says why and does nothing. Its measured height is what Home keeps
 * clear above a target.
 */
export function HomeJumps({
  asks,
  report,
  widgets,
  onAsk,
  onReport,
  onWidgets,
}: {
  asks: number;
  report: { title: string; projectName: string; opens?: boolean } | null;
  /** Widgets on show in My widgets, as arranged: a hidden one is not counted.
   * Absent on a Project's page, which has no My widgets (YN-86). */
  widgets?: number;
  onAsk: () => void;
  /** With the button pressed, which a report opened over Home gives the focus back to. */
  onReport: (from: HTMLElement) => void;
  onWidgets?: () => void;
}) {
  const t = useStrings(homeText);
  const bar = useRef<HTMLElement>(null);
  // The room Home keeps clear above a jump's target (scroll-padding), from the
  // bar's height as drawn, which wraps and follows the font size.
  useLayoutEffect(() => {
    const element = bar.current;
    const view = element?.closest<HTMLElement>(".home-view");
    if (!element || !view) return;
    const keep = () => view.style.setProperty("--home-jumps-height", `${Math.ceil(element.getBoundingClientRect().height)}px`);
    keep();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(keep);
    observer.observe(element);
    return () => {
      observer.disconnect();
      view.style.removeProperty("--home-jumps-height");
    };
  }, []);
  return (
    <nav ref={bar} className="home-jumps" aria-label={t.jumps}>
      <Jump
        icon={<MessageCircleQuestion size={14} />}
        label={t.jumpAsks}
        count={asks}
        name={t.jumpAsksLabel(asks)}
        help={asks ? t.jumpAsksHelp(asks) : t.jumpAsksNone}
        enabled={asks > 0}
        onPress={onAsk}
        kind="asks"
      />
      <Jump
        icon={<FileText size={14} />}
        label={t.jumpReport}
        help={report ? (report.opens ? t.jumpReportOpenHelp : t.jumpReportHelp)(report.title, report.projectName) : t.jumpReportNone}
        enabled={!!report}
        onPress={onReport}
        kind="report"
      />
      {onWidgets && widgets !== undefined && (
        <Jump
          icon={<LayoutGrid size={14} />}
          label={t.widgets}
          count={widgets}
          help={widgets ? t.jumpWidgetsHelp(widgets) : t.jumpWidgetsNone}
          enabled={widgets > 0}
          onPress={onWidgets}
          kind="widgets"
        />
      )}
    </nav>
  );
}

/** One jump. With nothing to go to it stays focusable, so its tip says why to the keyboard too, and does nothing. */
function Jump({
  icon,
  label,
  count,
  name,
  help,
  enabled,
  onPress,
  kind,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  name?: string;
  help: string;
  enabled: boolean;
  onPress: (from: HTMLElement) => void;
  kind: string;
}) {
  return (
    <Tip content={<TipText body={help} />} side="bottom">
      <button
        type="button"
        className="home-jump"
        data-jump={kind}
        aria-label={name}
        aria-disabled={enabled ? undefined : true}
        // Why it has nothing to go to, said to assistive technology while no tip shows.
        aria-description={enabled ? undefined : help}
        onClick={(event) => {
          if (enabled) onPress(event.currentTarget);
        }}
      >
        {icon}
        <span className="home-jump-label">{label}</span>
        {count !== undefined && <span className="home-jump-count">{count}</span>}
      </button>
    </Tip>
  );
}
