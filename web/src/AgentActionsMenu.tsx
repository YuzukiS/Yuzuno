import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleStop, Link2, MoreHorizontal, RotateCw, Settings2, SlidersHorizontal, Square, Unplug } from "lucide-react";
import { agentMenuItems, agentMenuLabel, type AgentActionHandlers, type AgentMenuAction, type AgentMenuItem } from "./agent-actions";
import { langTag, strings, useLanguage } from "./i18n";
import type { Agent } from "./types";
import "./agent-actions.css";

// The menu's own names (T-189); the Agent's name as it came.
const menuText = strings({
  actionsFor: (name: string) => `Actions for ${name}`,
  actions: "Actions",
  menu: (name: string) => `${name} actions`,
  // Where the Agent runs, which the list no longer keeps a line for (T-15).
  runsOn: (machine: string, harness: string) => `Runs on ${machine} · ${harness}`,
}, {
  actionsFor: (name) => `${name} 的操作`,
  actions: "操作",
  menu: (name) => `${name} 的操作`,
  runsOn: (machine, harness) => `运行位置：${machine} · ${harness}`,
});
/** The harness as it is written, not as it is keyed. */
const harnessName: Record<string, string> = {
  claude: "Claude Code", codex: "Codex", opencode: "OpenCode",
};

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
  endMissing: CircleStop,
  interrupt: Square,
  disconnect: Unplug,
  settings: SlidersHorizontal,
  copyLink: Link2,
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
  missingTurns = false,
}: {
  agent: Agent;
  handlers: AgentActionHandlers;
  /** A check found Turns missing from the native history (T-198); only the
   * open conversation knows, from its record. */
  missingTurns?: boolean;
  className?: string;
  /** Its button's name; "Actions for {name}" unless the place names it. */
  label?: string;
  ref?: React.Ref<AgentActionsMenuHandle>;
}) {
  const language = useLanguage();
  const t = menuText(language);
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
      setMenu({ id: agent.id, name: agent.name, items: agentMenuItems(agent, { missingTurns: missingTurns && !!handlers.endMissing, disconnect: !!handlers.disconnect, link: !!handlers.copyLink }), at, align, returnTo, focus });
    },
    [agent, missingTurns, handlers.endMissing, handlers.disconnect, handlers.copyLink],
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

  // A press elsewhere, a resize, or a scroll that moves its button closes it,
  // leaving focus there. Another pane's scroll, such as a conversation
  // following a running turn's output, leaves it open.
  useEffect(() => {
    if (!menu) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    const dismiss = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && list.current?.contains(target)) return;
      const anchor = trigger.current;
      if (!(target instanceof Node) || !anchor || target.contains(anchor)) close(false);
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
      case "endMissing":
        handlers.endMissing?.(target.id);
        break;
      case "disconnect":
        handlers.disconnect?.(target.id);
        break;
      case "copyLink":
        handlers.copyLink?.(target.id);
        break;
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`agent-actions-button ${className}`.trim()}
        aria-label={label ?? t.actionsFor(agent.name)}
        title={label ?? t.actions}
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
            aria-label={t.menu(menu.name)}
            aria-describedby={`${menuId}-where`}
            lang={langTag(language)}
            className="agent-actions-menu"
            data-placed={!!placed}
            style={{ left: placed?.x ?? 0, top: placed?.y ?? 0 }}
            onKeyDown={onMenuKeyDown}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {/* Where this Agent runs, as words at the top of the menu: the row
                itself no longer spends a line on it, and a title would only
                answer a pointer. Named by the menu as well, so it is spoken
                when the menu opens however it was opened (T-15). */}
            <p className="agent-actions-where" id={`${menuId}-where`} role="note">
              {t.runsOn(agent.remote?.machine.name || "Core host",
                harnessName[agent.harness ?? ""] ?? agent.harness ?? "Codex")}
            </p>
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
                  {agentMenuLabel(item.action, item.disabled, language)}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
