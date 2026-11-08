import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LoaderCircle, Plus } from "lucide-react";
import { animates } from "./motion";
import { Tip } from "./Tip";
import "./composer-add.css";

export type ComposerAddItem = {
  key: string;
  label: string;
  icon: ReactNode;
  /** What it adds, beside its row: its label stays the row's own words. */
  tip?: ReactNode;
  /** Shown under its label, and why it can't be chosen when `unavailable`. */
  note?: string;
  /** Kept in the menu, quieted, so it can say why (an Agent without images). */
  unavailable?: boolean;
  disabled?: boolean;
  /** Called with "+", which has the focus again, for what it opens to give it back to. */
  onSelect: (plus: HTMLButtonElement) => void;
};

/** How long the menu takes to sink back (composer-add.css, exit-small). */
const MENU_OUT_MS = 130;

/**
 * The composer's "+" (T-44): one button for what can go into a draft besides
 * its text, as in the ChatGPT app, so the box can be one line. Its menu rises
 * from it and follows the menu-button pattern: Enter, Space or the arrow keys
 * open it, the arrow keys, Home and End move, Escape or Tab close it, and
 * focus goes back to "+". Escape is kept from the conversation's interrupt.
 */
export function ComposerAddMenu({ label, tip, menuLabel, items, disabled, busy }: {
  label: string;
  /** What "+" holds. */
  tip: ReactNode;
  menuLabel: string;
  items: ComposerAddItem[];
  disabled?: boolean;
  /** Images are being saved: "+" turns while they are. */
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [focusAt, setFocusAt] = useState<"first" | "last">("first");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // It stays on screen, inert, for its short way out; reduced motion closes
  // it at once. Set in the render that closes it, so it is never taken off
  // the screen and put back for its way out.
  const [leaving, setLeaving] = useState(false);
  const [shownOpen, setShownOpen] = useState(open);
  if (open !== shownOpen) {
    setShownOpen(open);
    setLeaving(!open && animates());
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(false), MENU_OUT_MS + 100);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  useEffect(() => {
    if (!open) return;
    const choices = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") || [])];
    (focusAt === "last" ? choices.at(-1) : choices[0])?.focus();
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, focusAt]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }
  function keys(event: KeyboardEvent) {
    if (!open) {
      if (event.target === trigger.current && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        setFocusAt(event.key === "ArrowUp" ? "last" : "first");
        setOpen(true);
      }
      return;
    }
    const choices = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") || [])];
    const at = choices.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      event.preventDefault();
      choices[(to + choices.length) % choices.length]?.focus();
    };
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(choices.length - 1);
    else if (event.key === "Tab") close(false);
  }
  return (
    <div className="composer-add" ref={root} onKeyDown={keys}>
      {(open || leaving) && (
        <div
          ref={menu}
          className={`composer-add-menu${open ? "" : " is-leaving"}`}
          role="menu"
          aria-label={menuLabel}
          aria-hidden={open ? undefined : true}
          inert={!open}
          onAnimationEnd={(event) => {
            if (!open && event.animationName === "composer-add-out") setLeaving(false);
          }}
        >
          {items.map((item) => (
            <Tip key={item.key} content={item.tip} side="right">
              <button
                type="button"
                role="menuitem"
                className="composer-add-item"
                aria-label={item.label}
                aria-disabled={item.unavailable || item.disabled || undefined}
                data-unavailable={item.unavailable ? "" : undefined}
                onClick={() => {
                  if (item.unavailable || item.disabled) return;
                  close(true);
                  if (trigger.current) item.onSelect(trigger.current);
                }}
              >
                {item.icon}
                <span className="composer-add-text">
                  <span>{item.label}</span>
                  {item.note && <small>{item.note}</small>}
                </span>
              </button>
            </Tip>
          ))}
        </div>
      )}
      {/* Not while its menu is open: the menu says it all. */}
      <Tip content={open ? null : tip} describe={false}>
        <button
          ref={trigger}
          type="button"
          className="composer-tool composer-plus"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-busy={busy || undefined}
          disabled={disabled}
          onClick={() => {
            setFocusAt("first");
            setOpen(!open);
          }}
        >
          {busy ? <LoaderCircle size={17} className="spin" /> : <Plus size={18} />}
        </button>
      </Tip>
    </div>
  );
}
