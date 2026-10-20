import { useLayoutEffect, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";

export type AgentScope = "active" | "closed";

/**
 * The rail's heading: its title, a small Active / Closed pill for which
 * agents it lists, and its search and create buttons. All three share one
 * line while they fit; in a rail too narrow for that, the pill goes under
 * the title. Measured, so any rail width, text size or language fits.
 */
export function RailHeading({
  scope,
  active,
  closed,
  shortcut,
  onScope,
  onSearch,
  onCreate,
}: {
  scope: AgentScope;
  active: number;
  closed: number;
  /** The platform's shortcut modifier, as the buttons' tips show it. */
  shortcut: string;
  onScope: (scope: AgentScope) => void;
  onSearch: () => void;
  onCreate: () => void;
}) {
  const heading = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const el = heading.current;
    if (!el) return;
    // Each part keeps its own width either way, so the answer never flips
    // back and forth as the layout changes.
    const fit = () => {
      const parts = [...el.children];
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const needed =
        parts.reduce((sum, part) => sum + part.getBoundingClientRect().width, 0) +
        gap * (parts.length - 1);
      setStacked(needed > el.clientWidth + 0.5);
    };
    fit();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(el);
    for (const part of el.children) observer?.observe(part);
    void document.fonts?.ready.then(fit);
    return () => observer?.disconnect();
  }, []);
  return (
    <div
      ref={heading}
      className="rail-heading"
      data-stacked={stacked || undefined}
    >
      <span>YOUR AGENTS</span>
      <div className="agent-scope" role="group" aria-label="Show agents">
        <button
          type="button"
          aria-pressed={scope === "active"}
          onClick={() => onScope("active")}
        >
          Active <span>{active}</span>
        </button>
        <button
          type="button"
          aria-pressed={scope === "closed"}
          onClick={() => onScope("closed")}
        >
          Closed <span>{closed}</span>
        </button>
      </div>
      <div className="rail-actions">
        <button
          className="icon-button"
          aria-label="Search agents"
          title={`Search agents · ${shortcut} K`}
          onClick={onSearch}
        >
          <Search size={14} />
        </button>
        <button
          className="icon-button"
          aria-label="Create agent"
          title={`Create agent · ${shortcut} N`}
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}
