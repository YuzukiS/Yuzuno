import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, RotateCw, Settings2, SlidersHorizontal, Square } from "lucide-react";
import { agentMenuItems, type AgentActionHandlers, type AgentMenuAction, type AgentMenuItem } from "./agent-actions";
import type { Agent } from "./types";
import "./agent-actions.css";

/** Where the menu opens, in viewport pixels. */
export interface MenuPoint {
  x: number;
  y: number;
}

/** Opens the menu at a point, for a right-click or a long-press. */
export interface AgentActionsMenuHandle {
  openAt: (point: MenuPoint, returnTo: HTMLElement | null) => void;
}

interface OpenMenu {
  /** Fixed when the menu opens: every entry acts on this Agent. */
  id: string;
  name: string;
  items: AgentMenuItem[];
  at: MenuPoint;
  /** Its right edge at `at.x` (under its button), or its left edge (at a pointer). */
  align: "start" | "end";
  /** Where focus goes back when the menu closes. */
  returnTo: HTMLElement | null;
  focus: "first" | "last";
}

const icons: Record<AgentMenuAction, typeof RotateCw> = {
  reconnect: RotateCw,
  check: RotateCw,
  interrupt: Square,
  settings: SlidersHorizontal,
  manage: Settings2,
};

/**
 * An Agent's actions (T-184): a visible "…" button, and the same menu at a
 * pointer for a right-click or a long-press (`openAt`). The menu follows the
 * menu-button pattern: Enter, Space or the arrow keys open it, the arrow keys,
 * Home and End move, Escape or Tab close it, and focus returns to where it
 * was. Escape is consumed here, so it never reaches the window's Escape to
 * interrupt. Its entries are fixed when it opens and act on that Agent only;
 * it closes if this control comes to show another Agent.
 */
export function AgentActionsMenu({
  agent,
  handlers,
  className = "",
  label,
  ref,
}: {
  agent: Agent;
  handlers: AgentActionHandlers;
  className?: string;
  /** Its button's name; "Actions for {name}" unless the place names it. */
  label?: string;
  ref?: React.Ref<AgentActionsMenuHandle>;
}) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [placed, setPlaced] = useState<MenuPoint | null>(null);
  const current = useRef<OpenMenu | null>(null);
  current.current = menu;
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const open = useCallback(
    (at: MenuPoint, align: OpenMenu["align"], returnTo: HTMLElement | null, focus: OpenMenu["focus"] = "first") => {
      setPlaced(null);
      setMenu({ id: agent.id, name: agent.name, items: agentMenuItems(agent), at, align, returnTo, focus });
    },
    [agent],
  );
  const close = useCallback((refocus: boolean) => {
    const was = current.current;
    setMenu(null);
    setPlaced(null);
    if (refocus) was?.returnTo?.focus();
  }, []);
  useImperativeHandle(ref, () => ({ openAt: (point, returnTo) => open(point, "start", returnTo) }), [open]);

  // Never act on another Agent than the one it was opened on.
  useEffect(() => {
    if (current.current && current.current.id !== agent.id) close(false);
  }, [agent.id, close]);

  // Kept inside the window once its size is known.
  useLayoutEffect(() => {
    if (!menu || !list.current) return;
    const { width, height } = list.current.getBoundingClientRect();
    const margin = 8;
    const left = menu.align === "end" ? menu.at.x - width : menu.at.x;
    const x = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    const y = menu.at.y + height + margin > window.innerHeight ? Math.max(margin, menu.at.y - height) : menu.at.y;
    setPlaced({ x, y });
  }, [menu]);

  const entries = () =>
    Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);

  useEffect(() => {
    if (!menu || !placed) return;
    const items = entries();
    (menu.focus === "last" ? items.at(-1) : items[0])?.focus();
  }, [menu, placed]);

  // A press elsewhere, a scroll or a resize closes it, leaving focus there.
  useEffect(() => {
    if (!menu) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    const dismiss = (event: Event) => {
      if (!list.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [menu, close]);

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const items = entries();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => items[(next + items.length) % items.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(items.length - 1);
        break;
      case "Escape":
        // Consumed here: the window's Escape interrupts a running turn.
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case "Tab":
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function run(item: AgentMenuItem) {
    const target = current.current;
    if (!target || item.disabled) return;
    // A view it opens takes the focus; otherwise focus returns.
    close(item.action === "reconnect" || item.action === "check" || item.action === "interrupt");
    switch (item.action) {
      case "reconnect":
      case "check":
        void handlers.reconnect(target.id);
        break;
      case "interrupt":
        void handlers.interrupt(target.id);
        break;
      case "settings":
        handlers.settings(target.id);
        break;
      case "manage":
        handlers.manage(target.id);
        break;
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`agent-actions-button ${className}`.trim()}
        aria-label={label ?? `Actions for ${agent.name}`}
        title={label ?? "Actions"}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-controls={menu ? menuId : undefined}
        onClick={(event) => {
          if (menu) return close(true);
          const rect = event.currentTarget.getBoundingClientRect();
          open({ x: rect.right, y: rect.bottom + 4 }, "end", event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          open({ x: rect.right, y: rect.bottom + 4 }, "end", event.currentTarget, event.key === "ArrowUp" ? "last" : "first");
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {menu &&
        createPortal(
          <div
            ref={list}
            id={menuId}
            role="menu"
            aria-label={`${menu.name} actions`}
            className="agent-actions-menu"
            data-placed={!!placed}
            style={{ left: placed?.x ?? 0, top: placed?.y ?? 0 }}
            onKeyDown={onMenuKeyDown}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {menu.items.map((item) => {
              const Icon = icons[item.action];
              return (
                <button
                  key={item.action}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="agent-actions-item"
                  data-action={item.action}
                  disabled={item.disabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    run(item);
                  }}
                >
                  <Icon size={15} aria-hidden="true" />
                  {item.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
