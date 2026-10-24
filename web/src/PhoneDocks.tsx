// Phones (T-170): the conversation's two docks, jobs and CI on the left and
// Turns on the right, take no width of their own there. Two small buttons at
// the foot of the conversation open one of them over it; the rest of the
// time the text has the whole width. The docks themselves are unchanged
// (WorkDock.tsx, TurnNavigator.tsx): phone-docks.css lays the open one out
// as a panel above its button. Each button shows only while its dock has
// something to show.
import { useEffect } from "react";
import { BriefcaseBusiness, History } from "lucide-react";
import "./phone-docks.css";

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
          aria-label={open === "work" ? "Close jobs and CI" : "Close turns"}
          onClick={() => onOpen(null)}
        />
      )}
      <button
        type="button"
        className="phone-dock-button phone-dock-work"
        aria-expanded={open === "work"}
        aria-label="Jobs, CI and sub-agents"
        title="Jobs, CI and sub-agents"
        onClick={() => onOpen(open === "work" ? null : "work")}
      >
        <BriefcaseBusiness size={16} aria-hidden="true" />
        <span className="phone-dock-signal" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="phone-dock-button phone-dock-turns"
        aria-expanded={open === "turns"}
        aria-label={`Turns: reading turn ${turn} of ${turns}`}
        title="Turns"
        onClick={() => onOpen(open === "turns" ? null : "turns")}
      >
        <History size={14} aria-hidden="true" />
        <span>{turn}</span>
      </button>
    </>
  );
}
