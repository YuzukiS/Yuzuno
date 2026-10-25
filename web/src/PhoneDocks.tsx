// Phones (T-170): the conversation's two docks, jobs and CI on the left and
// Turns on the right, take no width of their own there. Two small buttons at
// the foot of the conversation open one of them over it; the rest of the
// time the text has the whole width. The docks themselves are unchanged
// (WorkDock.tsx, TurnNavigator.tsx): phone-docks.css lays the open one out
// as a panel above its button. Each button shows only while its dock has
// something to show.
import { useEffect } from "react";
import { BriefcaseBusiness, History } from "lucide-react";
import { strings, useStrings } from "./i18n";
import "./phone-docks.css";

// The two buttons' own names (T-189).
const text = strings({
  closeWork: "Close jobs and CI",
  closeTurns: "Close turns",
  work: "Jobs, CI and sub-agents",
  turns: "Turns",
  reading: (turn: number, turns: number) => `Turns: reading turn ${turn} of ${turns}`,
}, {
  closeWork: "关闭 Job 与 CI",
  closeTurns: "关闭 Turn",
  work: "Job、CI 与子 Agent",
  turns: "Turn",
  reading: (turn, turns) => `Turn：正在阅读第 ${turn} 个，共 ${turns} 个`,
});

export type PhoneDock = "work" | "turns" | null;

export function PhoneDockButtons({
  open,
  onOpen,
  turn,
  turns,
}: {
  open: PhoneDock;
  onOpen: (dock: PhoneDock) => void;
  /** The Turn being read, counted from 1, and how many there are. */
  turn: number;
  turns: number;
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
      {open && (
        <button
          type="button"
          className="phone-dock-scrim"
          aria-label={open === "work" ? t.closeWork : t.closeTurns}
          onClick={() => onOpen(null)}
        />
      )}
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
        aria-label={t.reading(turn, turns)}
        title={t.turns}
        onClick={() => onOpen(open === "turns" ? null : "turns")}
      >
        <History size={14} aria-hidden="true" />
        <span>{turn}</span>
      </button>
    </>
  );
}
