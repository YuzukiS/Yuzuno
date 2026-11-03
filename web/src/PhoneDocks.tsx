// Phones (T-170): the conversation's two docks, jobs and CI on the left and
// Turns on the right, take no width of their own there. Two small buttons at
// the foot of the conversation open one of them over it; the rest of the
// time the text has the whole width. The docks themselves are unchanged
// (WorkDock.tsx, TurnNavigator.tsx): phone-docks.css lays the open one out
// as a panel above its button. Each button shows only while its dock has
// something to show.
import { useCallback, useEffect, useState } from "react";
import { BriefcaseBusiness, History } from "lucide-react";
import { strings, useStrings } from "./i18n";
import { animates } from "./motion";
import "./phone-docks.css";

// The two buttons' own names (T-189).
const text = strings({
  closeWork: "Close jobs and CI",
  closeTurns: "Close turns",
  work: "Jobs, CI and sub-agents",
  turns: "Turns",
  reading: (turn: number, turns: number) => `Turns: reading turn ${turn} of ${turns}`,
  inputs: "Your inputs",
  readingInput: (input: number, inputs: number) => `Your inputs: reading input ${input} of ${inputs}`,
}, {
  closeWork: "关闭 Job 与 CI",
  closeTurns: "关闭 Turn",
  work: "Job、CI 与子 Agent",
  turns: "Turn",
  reading: (turn, turns) => `Turn：正在阅读第 ${turn} 个，共 ${turns} 个`,
  inputs: "你的输入",
  readingInput: (input, inputs) => `你的输入：正在阅读第 ${input} 条，共 ${inputs} 条`,
});

export type PhoneDock = "work" | "turns" | null;

/** The longer of a dock's way in (small) and out (exit-small), and a margin. */
const DOCK_MOTION_MS = 180 + 100;

/**
 * The dock shown and its way in or out (T-19): a panel the reader opens rises
 * from its button, one they close fades back into it, taking no taps on its
 * way. Any other change is at once: navigating, switching docks, or the panel
 * coming back as the on-screen keyboard goes. `choose` is for the reader's
 * own open and close; `end` for the animation's end.
 */
export function usePhoneDockMotion(open: PhoneDock, setOpen: (dock: PhoneDock) => void) {
  const [moving, setMoving] = useState<{ dock: "work" | "turns"; way: "in" | "out" } | null>(null);
  const choose = useCallback((dock: PhoneDock) => {
    setOpen(dock);
    if (!animates()) setMoving(null);
    else setMoving(dock ? { dock, way: "in" } : open ? { dock: open, way: "out" } : null);
  }, [open, setOpen]);
  // A change it did not make (navigation) stops it.
  useEffect(() => {
    setMoving((was) => (was && (was.way === "in" ? was.dock === open : open === null) ? was : null));
  }, [open]);
  useEffect(() => {
    if (!moving) return;
    const timer = window.setTimeout(() => setMoving(null), DOCK_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [moving]);
  const end = useCallback(() => setMoving(null), []);
  return { shown: open ?? (moving?.way === "out" ? moving.dock : null), way: moving?.way ?? null, choose, end };
}

export function PhoneDockButtons({
  open,
  onOpen,
  leaving = false,
  turn,
  turns,
  inputs = false,
}: {
  open: PhoneDock;
  onOpen: (dock: PhoneDock) => void;
  /** A closed panel is on its way out: its scrim stays, taking no taps. */
  leaving?: boolean;
  /** The Turn being read, counted from 1, and how many there are. */
  turn: number;
  turns: number;
  /** The dock reads by inputs (T-6): `turn` and `turns` count inputs. */
  inputs?: boolean;
}) {
  const t = useStrings(text);
  // Escape closes the open panel, as tapping outside it does, and only that:
  // handled here, it does not also interrupt a working Agent (App's Escape).
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onOpen(null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open, onOpen]);
  return (
    <>
      {open ? (
        <button
          type="button"
          className="phone-dock-scrim"
          aria-label={open === "work" ? t.closeWork : t.closeTurns}
          onClick={() => onOpen(null)}
        />
      ) : leaving && <div className="phone-dock-scrim" aria-hidden="true" />}
      <button
        type="button"
        className="phone-dock-button phone-dock-work"
        aria-expanded={open === "work"}
        aria-label={t.work}
        title={t.work}
        onClick={() => onOpen(open === "work" ? null : "work")}
      >
        <BriefcaseBusiness size={16} aria-hidden="true" />
        <span className="phone-dock-signal" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="phone-dock-button phone-dock-turns"
        aria-expanded={open === "turns"}
        aria-label={inputs ? t.readingInput(turn, turns) : t.reading(turn, turns)}
        title={inputs ? t.inputs : t.turns}
        onClick={() => onOpen(open === "turns" ? null : "turns")}
      >
        <History size={14} aria-hidden="true" />
        <span>{turn}</span>
      </button>
    </>
  );
}
