import { useLayoutEffect, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { strings, useStrings } from "./i18n";
import { useShortcutKeys } from "./shortcut-keys";

const text = strings({
  heading: "YOUR AGENTS",
  show: "Show agents",
  active: "Active",
  closed: "Closed",
  search: "Search agents",
  create: "Create agent",
}, {
  heading: "你的 Agent",
  show: "显示 Agent",
  active: "活跃",
  closed: "已关闭",
  search: "搜索 Agent",
  create: "新建 Agent",
});

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
  extra,
}: {
  scope: AgentScope;
  active: number;
  closed: number;
  /** The platform's shortcut modifier, as the buttons' tips show it. */
  shortcut: string;
  onScope: (scope: AgentScope) => void;
  onSearch: () => void;
  onCreate: () => void;
  /** Another action before search, such as reconnecting Agents (T-184). */
  extra?: React.ReactNode;
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
  const t = useStrings(text);
  const keys = useShortcutKeys();
  return (
    <div
      ref={heading}
      className="rail-heading"
      data-stacked={stacked || undefined}
    >
      <span>{t.heading}</span>
      <div className="agent-scope" role="group" aria-label={t.show}>
        <button
          type="button"
          aria-pressed={scope === "active"}
          onClick={() => onScope("active")}
        >
          {t.active} <span>{active}</span>
        </button>
        <button
          type="button"
          aria-pressed={scope === "closed"}
          onClick={() => onScope("closed")}
        >
          {t.closed} <span>{closed}</span>
        </button>
      </div>
      <div className="rail-actions">
        {extra}
        <button
          className="icon-button"
          aria-label={t.search}
          title={`${t.search} · ${shortcut} ${keys.find}`}
          onClick={onSearch}
        >
          <Search size={14} />
        </button>
        <button
          className="icon-button"
          aria-label={t.create}
          title={`${t.create} · ${shortcut} ${keys.newAgent}`}
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}
