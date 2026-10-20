import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Forward } from "lucide-react";
import type { Agent } from "./types";
import { HANDOFF_TYPE, handoffRefusal, readHandoff, type HandoffSource } from "./handoff";
import "./send-to-agent.css";

/** What App lends the buttons and the rail: one action for the menu and the drop (T-152). */
export type HandoffApi = {
  /** The Workspace's Agents, read when a menu opens. */
  agents: () => Agent[];
  /** Adds the handoff to the Agent's draft and opens that Agent; false when it did not. */
  send: (source: HandoffSource, agentId: string) => boolean;
};
export const HandoffContext = createContext<HandoffApi | null>(null);

/**
 * The handoff this window is dragging, frozen when the drag began. The type on
 * a drag proves nothing (any page can set it), so a drop is taken only when it
 * carries exactly this snapshot. `dialog`: it began in a dialog, which covers
 * the rail.
 */
let dragging: { source: HandoffSource; raw: string; dialog: boolean } | null = null;
const watchers = new Set<() => void>();
let lastDragEvent = 0;
function setDragging(next: typeof dragging) {
  dragging = next;
  for (const watch of watchers) watch();
}
function endDrag() {
  window.removeEventListener("dragend", endDrag);
  window.removeEventListener("drop", endAfterDrop);
  window.removeEventListener("dragover", markDragging);
  window.removeEventListener("mousemove", endIfIdle);
  if (dragging) setDragging(null);
}
/** After the drop target has read the snapshot. */
function endAfterDrop() {
  setTimeout(endDrag, 0);
}
function markDragging() {
  lastDragEvent = Date.now();
}
/**
 * A dragged element that unmounts gets its dragend where no one hears it.
 * Browsers send no mouse moves during a drag, so one with no drag event for a
 * while means it is over.
 */
function endIfIdle() {
  if (Date.now() - lastDragEvent > 300) endDrag();
}

/** Adds a handoff to a drag that is starting, beside whatever text it already carries. */
export function startHandoffDrag(event: DragEvent, source: HandoffSource) {
  const raw = JSON.stringify(source);
  event.dataTransfer.setData(HANDOFF_TYPE, raw);
  endDrag();
  markDragging();
  setDragging({ source, raw, dialog: !!(event.currentTarget as Element).closest?.('[role="dialog"]') });
  window.addEventListener("dragend", endDrag);
  window.addEventListener("drop", endAfterDrop);
  window.addEventListener("dragover", markDragging);
  window.addEventListener("mousemove", endIfIdle);
}
function subscribe(watch: () => void) {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

/** A rail row as a drop target: only a handoff from this window, and never one it refuses. */
export function useHandoffDrop(agent: Agent) {
  const api = useContext(HandoffContext);
  const [state, setState] = useState<"" | "accept" | "refuse">("");
  useEffect(() => {
    if (!state) return;
    const reset = () => setState("");
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [state]);
  if (!api) return { state, refusal: null, handlers: {} };
  // Judged during the drag: a render before it began knew no source.
  const refusal = () => (dragging ? handoffRefusal(dragging.source, agent) : null);
  const over = (event: DragEvent) => {
    // Only a drag this window started; one from elsewhere is not offered a target.
    if (!dragging || !event.dataTransfer.types.includes(HANDOFF_TYPE)) return;
    if (refusal()) {
      event.dataTransfer.dropEffect = "none";
      setState("refuse");
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setState("accept");
  };
  return {
    state,
    refusal: state === "refuse" ? refusal() : null,
    handlers: {
      onDragEnter: over,
      onDragOver: over,
      onDragLeave: (event: DragEvent) => {
        // Chromium may give no relatedTarget: then the pointer's place decides.
        const row = event.currentTarget.getBoundingClientRect();
        const inside = event.relatedTarget
          ? event.currentTarget.contains(event.relatedTarget as Node)
          : event.clientX > row.left && event.clientX < row.right && event.clientY > row.top && event.clientY < row.bottom;
        if (!inside) setState("");
      },
      onDrop: (event: DragEvent) => {
        setState("");
        const raw = event.dataTransfer.getData(HANDOFF_TYPE);
        const started = dragging;
        if (!started || raw !== started.raw || !readHandoff(raw)) return;
        event.preventDefault();
        endDrag();
        // App refuses it again (self, closed, gone) with a notice.
        api.send(started.source, agent.id);
      },
    },
  };
}

/**
 * "Send to Agent": a menu of Agents that adds `source` to the chosen Agent's
 * draft, and a handle to drag it onto an Agent in the rail (or, from a
 * dialog, the drop strip) instead.
 */
export function SendToAgentButton({
  source,
  label = "Send to Agent",
}: {
  /** Built when used, so it is a snapshot of that moment. */
  source: () => HandoffSource | null;
  label?: string;
}) {
  const api = useContext(HandoffContext);
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    const away = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  if (!api) return null;
  const picked = open ? source() : null;
  const targets = open && picked ? api.agents().filter(agent => !handoffRefusal(picked, agent)) : [];
  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) button.current?.focus();
  }
  function keys(event: KeyboardEvent) {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") || [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Tab") close(false);
  }
  return (
    <span className="send-to-agent" ref={wrapper}>
      <button
        ref={button}
        type="button"
        className="quiet-button send-to-agent-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${label}: choose an Agent, or drag this onto one. It is added to that Agent’s draft; you send it.`}
        draggable
        onDragStart={event => {
          const value = source();
          if (!value) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = "copy";
          startHandoffDrag(event, value);
        }}
        onClick={() => setOpen(!open)}
      >
        <Forward size={13} aria-hidden="true" />
        <span>{label}</span>
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label="Add to an Agent’s draft" className="send-to-agent-menu" onKeyDown={keys}>
          <p className="send-to-agent-note">Adds it to the Agent’s draft. Nothing is sent until you send it.</p>
          {targets.length ? (
            targets.map(agent => (
              <button
                key={agent.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  const value = source();
                  close(false);
                  if (value) api.send(value, agent.id);
                }}
              >
                <span className="send-to-agent-name">{agent.name}</span>
                <small>{agent.remote?.machine.name || "Core host"}</small>
              </button>
            ))
          ) : (
            <button type="button" role="menuitem" disabled>
              {picked ? "No other open Agent" : "Nothing to send"}
            </button>
          )}
        </div>
      )}
    </span>
  );
}

/**
 * While a handoff dragged out of a dialog is in the air: the open Agents to
 * drop it on, over the dialog that covers the rail. Each takes a drop like a
 * rail row. It shows nothing otherwise, and leaves the page's layout alone.
 */
export function HandoffDropStrip() {
  const api = useContext(HandoffContext);
  const active = useSyncExternalStore(subscribe, () => !!dragging?.dialog);
  if (!api || !active) return null;
  const agents = api.agents().filter(agent => !agent.closedAt);
  // Beside the dialog's own portal, above its overlay: inside the app it
  // would sit under the overlay and never be hit by a drag.
  return createPortal(
    <div className="handoff-strip" role="group" aria-label="Agents to drop it on">
      <span className="handoff-strip-label">Drop on an Agent to add it to their draft</span>
      {agents.length ? agents.map(agent => <HandoffChip key={agent.id} agent={agent} />) : <span className="handoff-strip-label">No open Agent</span>}
    </div>,
    document.body,
  );
}
function HandoffChip({ agent }: { agent: Agent }) {
  const drop = useHandoffDrop(agent);
  return (
    <span
      className={`handoff-chip${drop.state ? ` handoff-${drop.state}` : ""}`}
      data-agent-id={agent.id}
      title={drop.refusal || `Add it to ${agent.name}’s draft`}
      {...drop.handlers}
    >
      <span className="send-to-agent-name">{agent.name}</span>
      <small>{agent.remote?.machine.name || "Core host"}</small>
    </span>
  );
}
