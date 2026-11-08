import * as Tooltip from "@radix-ui/react-tooltip";
import { cloneElement, createContext, isValidElement, useContext, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { langTag, useLanguage } from "./i18n";
import "./tip.css";

/**
 * The app's one tooltip (YN-44): every hover card is drawn the way the Work
 * dock's CI run card was, from the same tokens (tip.css), and behaves the
 * same everywhere. It opens when a pointer rests on its trigger for
 * TIP_DELAY_MS, or at once when the keyboard focuses it; it moves at once
 * from one trigger to the next while one is showing; Escape, a press, a
 * click, a scroll of what holds it or leaving it closes it. Nothing opens on
 * touch. Radix Tooltip does the timing, the placement (it flips to the side
 * with room) and the description for assistive technology; this file only
 * decides the look and which focus counts.
 *
 * A tip says what a thing is or what it holds, never what a click does
 * (the user, YN-44): no "Click to open …" lines.
 */
export const TIP_DELAY_MS = 300;
/** Moving from one trigger to the next within this long opens the next at once. */
export const TIP_SKIP_MS = 400;

const Present = createContext(false);

/** Around the app: one delay group for every tip in it. */
export function TipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={TIP_DELAY_MS} skipDelayDuration={TIP_SKIP_MS} disableHoverableContent>
      <Present.Provider value>{children}</Present.Provider>
    </Tooltip.Provider>
  );
}

// Which input moved focus last: a key, or a press. Radix opens a tip on any
// focus that no press of its own trigger caused; a focus that a press
// elsewhere caused (a dialog closed by a click, giving focus back) should not
// open it either, as `:focus-visible` would have it. Read here rather than
// with `matches(":focus-visible")`, which some engines don't answer.
// On the window, in the capture phase, from when this module loads: before
// any listener a component adds later, so one that stops a key there (the
// context ring's Escape) cannot hide it from this one.
let byKeyboard = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (event) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey) byKeyboard = true;
  }, true);
  window.addEventListener("pointerdown", () => { byKeyboard = false; }, true);
}

/**
 * Whether an event is the trigger's own: on it or on what it holds, not on a
 * menu, dialog or list it opened. React passes a portal's events on to its
 * React parents, so a dialog opened from an Agent row reaches the row, and
 * focus moving into it would open the row's card over it (and Escape would
 * close the card, not the dialog).
 */
function own(event: SyntheticEvent): boolean {
  const trigger = event.currentTarget as Element;
  const target = event.target as Element;
  if (!trigger.contains(target)) return false;
  const opened = target.closest?.('[role="menu"], [role="dialog"], [role="listbox"]');
  return !opened || opened === trigger || !trigger.contains(opened);
}

/** Whether an element's text runs past its box: cut by an ellipsis or a clamp. */
const overflows = (element: HTMLElement | null) =>
  !!element && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);

/** Whether the keyboard moved focus last, for a card of its own that opens
 * on focus as a tip does (ContextUsage, the turn dock's preview). */
export const focusByKeyboard = () => byKeyboard;

export type TipSide = "top" | "right" | "bottom" | "left";
export type TipTone = "ok" | "bad" | "attention" | "working" | "info" | "quiet";

/**
 * A tip on one child, its trigger: an element that takes a ref and the
 * pointer and focus handlers (a DOM element, or a component that passes
 * them on). Without content it is the child alone.
 *  - `side`: where it goes when there is room; it flips when there is not.
 *  - `size`: "wide" (320 px) for rows of values and the Agent row's card,
 *    "preview" (420 px) for a peek at content; 280 px otherwise.
 *  - `describe`: the tip's text describes the trigger for assistive
 *    technology while it shows (aria-describedby). Off where the trigger's
 *    own name or description already says it.
 *  - `open`, `onOpenChange`: to decide when it may show, or show it by hand.
 *  - `cut`: only while the trigger's own text is cut (an ellipsis or a
 *    clamp), measured when it would open: a name shown whole needs no tip.
 * A disabled button still shows its tip to a pointer resting on it (Chromium
 * sends it pointer events, and React passes them on), so a tip may say why
 * it is disabled; the keyboard cannot reach it there.
 * Content may come and go (empty: no tip), and the trigger stays the same
 * element either way: switching between a bare child and a wrapped one
 * would remount it, and a dialog opened from it would lose its place.
 */
export function Tip({
  content,
  children,
  side = "top",
  align = "center",
  size,
  describe = true,
  open,
  onOpenChange,
  className,
  card,
  cut = false,
}: {
  content: ReactNode;
  children: ReactElement;
  side?: TipSide;
  align?: "start" | "center" | "end";
  size?: "wide" | "preview";
  describe?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  /** Data attributes on the card, for its own styles and checks. */
  card?: Record<`data-${string}`, string | undefined>;
  cut?: boolean;
}) {
  const present = useContext(Present);
  const language = useLanguage();
  const [cutShown, setCutShown] = useState(false);
  const cutTrigger = useRef<HTMLElement>(null);
  if (!isValidElement(children)) return children;
  const empty = content == null || content === false || content === "";
  const props = children.props as Record<string, unknown>;
  // Radix marks its trigger with `data-state` and, while open,
  // `aria-describedby`. A trigger's own values of either win, and a trigger
  // without them keeps none: CSS and checks read `data-state` as the
  // element's own state.
  const trigger = cloneElement(children, {
    "data-state": props["data-state"],
    ...(!describe || props["aria-describedby"] !== undefined ? { "aria-describedby": props["aria-describedby"] } : {}),
  } as Record<string, unknown>);
  const tip = (
    <Tooltip.Root
      open={empty ? false : cut ? cutShown : open}
      onOpenChange={empty ? undefined : cut ? (next) => setCutShown(next && overflows(cutTrigger.current)) : onOpenChange}
    >
      <Tooltip.Trigger
        ref={cut ? cutTrigger : undefined}
        asChild
        onFocus={(event) => { if (!byKeyboard || !own(event)) event.preventDefault(); }}
        onPointerMove={(event) => { if (!own(event)) event.preventDefault(); }}
      >
        {trigger}
      </Tooltip.Trigger>
      {!empty && <Tooltip.Portal>
        <Tooltip.Content
          className={className ? `tip ${className}` : "tip"}
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={8}
          data-size={size}
          lang={langTag(language)}
          {...card}
        >
          {content}
        </Tooltip.Content>
      </Tooltip.Portal>}
    </Tooltip.Root>
  );
  // A tip drawn where no provider is (a page of its own) brings one.
  return present ? tip : <TipProvider>{tip}</TipProvider>;
}

/**
 * A tip's lines, the CI run card's order: what it is, its state, then
 * quieter facts and its latest moment. Each is left out when empty.
 *  - `title`: its name, not a sentence; `kbd` its shortcut beside it.
 *  - `status`: its state in words, coloured by `tone` only when it is a state.
 *  - `body`: an explanation, a rule, why it is disabled.
 *  - `meta`: quiet facts, joined with " · ".
 *  - `when`: its latest moment.
 *  - `value`: a full value (a path, an ID), in monospace, `label` naming it.
 */
export function TipText({ title, kbd, status, tone, body, meta, when, value, label }: {
  title?: ReactNode;
  kbd?: string | null;
  status?: ReactNode;
  tone?: TipTone | null;
  body?: ReactNode;
  meta?: ReactNode | (ReactNode | null | undefined | false)[];
  when?: ReactNode;
  value?: ReactNode;
  label?: ReactNode;
}) {
  const facts = Array.isArray(meta) ? meta.filter((part) => part != null && part !== false && part !== "") : meta;
  const quiet = Array.isArray(facts) ? (facts.length ? facts.map((part, i) => <span key={i}>{i > 0 && " · "}{part}</span>) : null) : facts;
  return (
    <>
      {/* What it is, quietly, above a value it names (the Value kind). */}
      {label && <small className="tip-meta">{label}</small>}
      {(title || kbd) && (
        <span className="tip-head">
          {title && <strong className="tip-title">{title}</strong>}
          {kbd && <> <kbd className="tip-kbd">{kbd}</kbd></>}
        </span>
      )}
      {value && <span className="tip-value">{value}</span>}
      {status && <span className="tip-status" data-tone={tone || undefined}>{status}</span>}
      {body && <span className="tip-body">{body}</span>}
      {quiet && <small className="tip-meta">{quiet}</small>}
      {when && <small className="tip-when">{when}</small>}
    </>
  );
}

/**
 * Recharts' own tooltip drawn as the app's one tip: its box, its label and
 * its rows, from tip.css's tokens. It keeps Recharts' timing: a chart's
 * readout follows the pointer across the data at once, which a delay would
 * only lag.
 */
export const chartTip: { contentStyle: CSSProperties; labelStyle: CSSProperties; itemStyle: CSSProperties; wrapperStyle: CSSProperties } = {
  contentStyle: {
    background: "var(--tip-bg)",
    border: "1px solid var(--tip-line)",
    borderRadius: "var(--tip-radius)",
    padding: "var(--tip-pad)",
    boxShadow: "var(--tip-shadow)",
    color: "var(--ink)",
    fontSize: "var(--tip-font)",
    lineHeight: 1.45,
  },
  labelStyle: { margin: 0, color: "var(--ink)", fontWeight: 700 },
  itemStyle: { padding: 0, color: "var(--text-secondary)" },
  wrapperStyle: { zIndex: 60, outline: "none" },
};

/**
 * A tip from lines of text another part of the app already writes (a plan's
 * usage, a machine's state): the first line its name, every other line a
 * quiet line of its own. Empty lines are left out.
 */
export function TipLines({ text }: { text: string }) {
  const [first, ...rest] = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    <>
      {first && <strong className="tip-title">{first}</strong>}
      {rest.map((line, i) => <small key={i} className="tip-meta">{line}</small>)}
    </>
  );
}
