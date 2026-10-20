import { MessageContent } from "./MessageContent";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { ArrowDownToLine, History } from "lucide-react";
import { nativeTurnLabel } from "./components";
import { userRequests } from "./CurrentTurnPrompt";
import { isCompacting } from "./conversation-blocks";
import type { NativeTurn } from "./types";
import { useAppearance } from "./appearance";
import "./turn-dock.css";

/** By default this many Turns show their number; the rest of the nearby
 * Turns are short rounded bars, up to BARS on each side, shorter and fainter
 * with distance. Settings changes both (Appearance, Turn dock). */
const NUMBERS = 5;
const BARS = 5;
/** Wheel travel that moves the dock's window by one Turn. */
const WHEEL_STEP = 60;
/** Row heights, here so the glide below can place rows without measuring. */
const NUMBER_ROW = 32;
const BAR_ROW = 11;
/** Distance within which the pointer magnifies rows, strongest at its tip. */
const LENS = 64;
const GLIDE = { duration: 260, easing: "cubic-bezier(.2, .8, .2, 1)" };

const still = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** How far a row is currently shifted by a running glide. */
function glideOffset(row: HTMLElement) {
  const value = getComputedStyle(row).translate;
  return value && value !== "none" ? parseFloat(value.split(" ")[1] ?? "0") || 0 : 0;
}

function turnStatus(turn: NativeTurn) {
  if (isCompacting(turn)) return "Compacting";
  if (/inProgress|running/.test(turn.status)) return "Working";
  return (
    { completed: "Completed", interrupted: "Interrupted", failed: "Failed" }[
      turn.status
    ] || turn.status
  );
}

function readingIndex(starts: number[], position: number) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The Turns on show around `center`: numbered ones, then bars by distance. */
export function dockWindow(
  count: number,
  center: number,
  numbered = NUMBERS,
  bars = BARS,
) {
  const numbers = Math.min(numbered, count);
  const start = Math.max(
    0,
    Math.min(count - numbers, center - Math.floor(numbers / 2)),
  );
  const end = start + numbers;
  const shown: { index: number; distance: number }[] = [];
  for (let index = Math.max(0, start - bars); index < Math.min(count, end + bars); index++)
    shown.push({
      index,
      distance: index < start ? start - index : index >= end ? index - end + 1 : 0,
    });
  return shown;
}

export function TurnNavigator({
  turns,
  scrollRef,
  onNavigate,
  onInteractionChange,
  atLatest = true,
  onLatest,
  loadedNumbering = false,
  readingTurnId,
}: {
  turns: NativeTurn[];
  /** Logical turn selected by the virtual conversation's position model. */
  readingTurnId?: string;
  loadedNumbering?: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onNavigate: (turnId: string) => void;
  onInteractionChange: (engaged: boolean) => void;
  /** Whether the conversation already shows its latest content. */
  atLatest?: boolean;
  /** Back to the latest content, as the conversation's own button does. */
  onLatest?: () => void;
}) {
  const [reading, setReading] = useState(turns.at(-1)?.id);
  // Where the reader moved the dock's window by wheel or keyboard; null
  // follows the conversation's reading position.
  const [browse, setBrowse] = useState<number | null>(null);
  const [dialogTurn, setDialogTurn] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [previewTop, setPreviewTop] = useState(8);
  const [engaged, setEngaged] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const pointerInside = useRef(false);
  const focusInside = useRef(false);
  const engagedRef = useRef(false);
  const wheel = useRef(0);
  const focusAfterRender = useRef<number | null>(null);
  const tooltipId = useId();
  const turnKey = JSON.stringify(turns.map((turn) => turn.id));
  // Until the scroll position says otherwise, the reader is at the end: a
  // conversation opens at its latest Turn.
  const found = turns.findIndex((turn) => turn.id === (readingTurnId ?? reading));
  const index = found >= 0 ? found : Math.max(0, turns.length - 1);
  const center = Math.max(0, Math.min(turns.length - 1, browse ?? index));
  const { turnDock } = useAppearance();
  const shown = dockWindow(turns.length, center, turnDock.numbers, turnDock.bars);
  // Where each shown Turn's row sits, from the list's middle (the dock stays
  // vertically centred), and whether it is a number or a bar.
  const layout = useMemo(() => {
    const rows = shown.map(({ index, distance }) => ({
      id: turns[index]?.id,
      kind: distance ? "bar" : "number",
      height: distance ? BAR_ROW : NUMBER_ROW,
    }));
    let y = -rows.reduce((sum, row) => sum + row.height, 0) / 2;
    const places = new Map<string, { y: number; kind: string }>();
    for (const row of rows) {
      places.set(row.id, { y: y + row.height / 2, kind: row.kind });
      y += row.height;
    }
    return places;
  }, [turnKey, center, turnDock.numbers, turnDock.bars]);
  const placed = useRef(layout);
  const lensFrame = useRef(0);
  const highlighted = dialogTurn ?? hover ?? focused;
  const previewTurn = highlighted === null ? undefined : turns[highlighted];
  const previewMessage = previewTurn && userRequests(previewTurn)[0];

  function engage() {
    const next = pointerInside.current || focusInside.current;
    if (next !== engagedRef.current) {
      engagedRef.current = next;
      setEngaged(next);
      onInteractionChange(next);
    }
    // Let go of the dock: its window returns to the reading position.
    if (!next) setBrowse(null);
  }
  useEffect(
    () => () => {
      onInteractionChange(false);
    },
    [onInteractionChange],
  );

  // When the window moves, rows that stay glide from where they were, a bar
  // grows into a number (or settles back into a bar), and new rows fade in.
  // A glide interrupted by the next step continues from where it had got to.
  useLayoutEffect(() => {
    const before = placed.current;
    placed.current = layout;
    const rows = list.current?.children;
    if (!rows || before === layout || still()) return;
    for (const row of Array.from(rows) as HTMLElement[]) {
      if (typeof row.animate !== "function") return;
      const id = row.dataset.dockTurn!;
      const now = layout.get(id);
      const was = before.get(id);
      if (!now) continue;
      if (!was) {
        row.animate(
          [
            { opacity: 0, scale: "0.5" },
            { opacity: 1, scale: "1" },
          ],
          GLIDE,
        );
        continue;
      }
      let from = was.y - now.y;
      const running = row.getAnimations().find((a) => a.id === "dock-glide");
      if (running) {
        from += glideOffset(row);
        running.cancel();
      }
      if (Math.abs(from) > 0.5)
        row.animate([{ translate: `0 ${from}px` }, { translate: "0 0" }], GLIDE).id =
          "dock-glide";
      if (was.kind !== now.kind)
        row
          .querySelector<HTMLElement>(".turn-dock-chip, .turn-dock-bar")
          ?.animate(
            now.kind === "number"
              ? [
                  { opacity: 0, scale: "0.3" },
                  { opacity: 1, scale: "1" },
                ]
              : [{ scale: "1.8 1" }, { scale: "1" }],
            GLIDE,
          );
    }
  }, [layout]);

  /** Magnify the rows near the pointer, most at its tip (null: rest). */
  function lens(clientY: number | null) {
    cancelAnimationFrame(lensFrame.current);
    lensFrame.current = requestAnimationFrame(() => {
      for (const row of Array.from(list.current?.children ?? []) as HTMLElement[]) {
        let lift = 0;
        if (clientY !== null) {
          const box = row.getBoundingClientRect();
          const distance = Math.abs(clientY - (box.top + box.height / 2));
          if (distance < LENS) lift = (1 + Math.cos((Math.PI * distance) / LENS)) / 2;
        }
        row.style.setProperty("--lift", lift.toFixed(3));
      }
    });
  }
  useEffect(() => () => cancelAnimationFrame(lensFrame.current), []);

  // Cache positions when message layout changes; scrolling only does a binary
  // search. Following the reading marker never scrolls the conversation.
  useLayoutEffect(() => {
    if (readingTurnId !== undefined) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    let starts: number[] = [];
    let ids: string[] = [];
    let frame = 0;
    const update = () => {
      if (!starts.length || !scroller.clientHeight) return;
      const bottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;
      const position = scroller.scrollTop + 32;
      setReading(
        ids[bottom ? starts.length - 1 : readingIndex(starts, position)],
      );
    };
    const measure = () => {
      const top = scroller.getBoundingClientRect().top;
      const nodes = Array.from(
        scroller.querySelectorAll<HTMLElement>(".turn[data-turn-id]"),
      );
      starts = nodes.map(
        (node) => node.getBoundingClientRect().top - top + scroller.scrollTop,
      );
      ids = nodes.map((node) => node.dataset.turnId!);
      update();
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(scroller);
    const inner = scroller.querySelector(".conversation-inner");
    if (inner) observer?.observe(inner);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", measure);
    };
  }, [scrollRef, turnKey, readingTurnId]);

  function stop(turnIndex: number) {
    return list.current?.querySelector<HTMLButtonElement>(
      `[data-turn-index="${turnIndex}"]`,
    );
  }
  function positionPreview(turnIndex: number) {
    const row = stop(turnIndex);
    const root = nav.current;
    if (row && root)
      setPreviewTop(
        Math.max(
          8,
          Math.min(
            row.getBoundingClientRect().top -
              root.getBoundingClientRect().top -
              25,
            root.clientHeight - 180,
          ),
        ),
      );
  }
  // A Turn reached by keyboard may only now be on show; focus it once drawn.
  useLayoutEffect(() => {
    const target = focusAfterRender.current;
    if (target === null) return;
    focusAfterRender.current = null;
    stop(target)?.focus({ preventScroll: true });
    positionPreview(target);
  });

  const label = loadedNumbering ? "Loaded turn" : "Turn";
  // No numbered Turns: the reader hid the dock in Settings.
  if (!turns.length || turnDock.numbers === 0) return null;
  return (
    <nav
      ref={nav}
      className="turn-dock"
      aria-label={
        loadedNumbering ? "Loaded conversation turns" : "Conversation turns"
      }
      data-engaged={engaged}
      onPointerEnter={() => {
        pointerInside.current = true;
        engage();
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
        setHover(null);
        lens(null);
        engage();
      }}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse") lens(event.clientY);
      }}
      onWheel={(event) => {
        // The wheel walks the dock through Turns without moving the
        // conversation; a click on a Turn then reads it.
        wheel.current += event.deltaY;
        const steps = Math.trunc(wheel.current / WHEEL_STEP);
        if (!steps) return;
        wheel.current -= steps * WHEEL_STEP;
        setHover(null);
        setBrowse(Math.max(0, Math.min(turns.length - 1, center + steps)));
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          focusInside.current = false;
          setFocused(null);
          engage();
        }
      }}
      onKeyDown={(event) => {
        if (dialogTurn !== null) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setFocused(null);
          setHover(null);
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        setHover(null);
        const at = Number(
          (document.activeElement as HTMLElement)?.dataset.turnIndex ?? index,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? turns.length - 1
              : Math.max(
                  0,
                  Math.min(
                    turns.length - 1,
                    at + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                );
        setBrowse(next);
        setFocused(next);
        focusAfterRender.current = next;
      }}
    >
      <span
        className="turn-dock-heading"
        title={
          loadedNumbering ? "Loaded conversation turns" : "Conversation turns"
        }
      >
        <History size={12} aria-hidden="true" />
        <span className="sr-only">
          {loadedNumbering ? "Loaded turns" : "Turns"}
        </span>
      </span>
      <ol
        ref={list}
        className="turn-dock-list"
        style={{ "--bar-span": Math.max(1, turnDock.bars - 1) } as CSSProperties}
      >
        {shown.map(({ index: turnIndex, distance }) => {
          const turn = turns[turnIndex];
          const bar = distance > 0;
          return (
            <li
              key={turn.id}
              data-kind={bar ? "bar" : "number"}
              data-dock-turn={turn.id}
              style={{ height: bar ? BAR_ROW : NUMBER_ROW }}
            >
              <button
                type="button"
                className="turn-dock-stop"
                data-turn-choice={turn.id}
                data-turn-index={turnIndex}
                data-active={turnIndex === index}
                data-highlighted={turnIndex === highlighted}
                aria-label={`${label} ${turnIndex + 1} · ${turnStatus(turn)}`}
                aria-current={turnIndex === index ? "location" : undefined}
                aria-describedby={
                  turnIndex === highlighted ? tooltipId : undefined
                }
                tabIndex={turnIndex === (focused ?? center) ? 0 : -1}
                onPointerEnter={() => {
                  setHover(turnIndex);
                  positionPreview(turnIndex);
                }}
                onFocus={() => {
                  focusInside.current = true;
                  setFocused(turnIndex);
                  engage();
                  positionPreview(turnIndex);
                }}
                onClick={() => {
                  setHover(null);
                  setFocused(null);
                  // The clicked Turn becomes the reading position.
                  setBrowse(null);
                  onNavigate(turn.id);
                }}
              >
                {bar ? (
                  <span
                    className="turn-dock-bar"
                    data-running={/inProgress|running/.test(turn.status)}
                    style={{ "--bar-distance": distance } as CSSProperties}
                  />
                ) : (
                  <span
                    className="turn-dock-chip"
                    data-running={/inProgress|running/.test(turn.status)}
                  >
                    {turnIndex + 1}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
      <span
        className="turn-dock-position"
        aria-label={`Reading ${loadedNumbering ? "loaded turn" : "turn"} ${index + 1} of ${turns.length}`}
      >
        {index + 1}
        <span>/ {turns.length}</span>
      </span>
      {/* Shown while the pointer or focus is at the dock, and only away
          from the latest content. */}
      {!atLatest && onLatest && (
        <button
          type="button"
          className="turn-dock-latest"
          title="Back to latest"
          aria-label="Back to the latest turn"
          onClick={() => {
            setHover(null);
            setFocused(null);
            setBrowse(null);
            onLatest();
          }}
        >
          <ArrowDownToLine size={13} aria-hidden="true" />
        </button>
      )}
      {previewTurn && (
        <div
          className="turn-dock-preview"
          id={tooltipId}
          role="tooltip"
          style={{ top: previewTop }}
        >
          <div>
            <strong>
              {label} {highlighted! + 1}
            </strong>
            <span>{turnStatus(previewTurn)}</span>
          </div>
          <p>
            {previewMessage ? <MessageContent text={previewMessage.text} blocks={previewMessage.blocks} compact onDialogChange={open => { if (!open) setFocused(highlighted); setDialogTurn(open ? highlighted : null); }} /> :
              (previewTurn._yuzunoSource === "peer"
                ? "Workspace collaboration"
                : previewTurn._yuzunoSource === "native"
                  ? nativeTurnLabel(previewTurn)
                  : "No user message")}
          </p>
          <small>Click to read this turn</small>
        </div>
      )}
    </nav>
  );
}
