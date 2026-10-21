import { useEffect, useRef, useState } from "react";
import { API_BASE } from "./api";
import { parseWorkspaceEvent, type WorkspaceEvent } from "./workspace-events.ts";

export type EventConnection = "connecting" | "open" | "reconnecting";

/** Snapshots are polled this often, while visible, only while the stream is
 * not open. */
export const POLL_MS = 5_000;
/** After (re)opening, Core's first message says whether it resumed; without
 * one in this time, everything is refetched. */
export const START_WAIT_MS = 800;
/** Core sends a heartbeat every 15 s; a stream silent this long is dead. */
export const SILENCE_MS = 45_000;
/** A stream the browser gave up on is opened again after this long. */
export const REOPEN_MS = 3_000;
/** A browser reconnect that has not opened in this time (it can hang after
 * sleep or a network change) is replaced by a new connection. */
export const STALLED_MS = 10_000;
/** While live, the Agent list is still read this often, in case Core ever
 * changes it without a notice. */
export const SAFETY_NET_MS = 45_000;

/**
 * Core's live changes (see workspace-events.ts). EventSource reconnects by
 * itself and sends the last id, so Core can resume where it left off; when it
 * cannot, it says `reset` and `onEvent` gets a `reset` to refetch everything.
 * A stream that never says either, a poll while the stream is down, and an
 * unreadable message are delivered as `reset` too.
 *
 * An open, quiet stream is healthy: business-event silence is not a timeout;
 * only missing heartbeats are.
 */
export function useWorkspaceEvents(
  enabled: boolean,
  onEvent: (event: WorkspaceEvent) => void,
) {
  const [connection, setConnection] = useState<EventConnection>("connecting");
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let source: EventSource | null = null;
    let open = false;
    let lastId = "";
    let lastHeard = Date.now();
    let starting: ReturnType<typeof setTimeout> | undefined;
    let silence: ReturnType<typeof setTimeout> | undefined;
    let reopen: ReturnType<typeof setTimeout> | undefined;
    const emit = (event: WorkspaceEvent) => {
      if (!disposed && (event.type === "agent.codexUsage" || event.type === "reset")) {
        window.dispatchEvent(new CustomEvent("yuzuno:codex-usage", { detail: event.type === "reset" ? null : event }));
        if (event.type === "agent.codexUsage") return;
      }
      if (!disposed) handler.current(event);
    };
    const heard = () => {
      lastHeard = Date.now();
      clearTimeout(silence);
      silence = setTimeout(() => connect("silent"), SILENCE_MS);
    };
    const connect = (why: "first" | "silent" | "closed" | "focus") => {
      clearTimeout(starting);
      clearTimeout(silence);
      clearTimeout(reopen);
      starting = silence = reopen = undefined;
      if (source) {
        source.onopen = source.onmessage = source.onerror = null;
        source.close();
      }
      open = false;
      // A new connection resumes from the last id it saw, like a browser
      // reconnect does with Last-Event-ID.
      const events = new EventSource(
        lastId
          ? `${API_BASE}/api/events?${new URLSearchParams({ lastEventId: lastId })}`
          : `${API_BASE}/api/events`,
      );
      source = events;
      setConnection(why === "first" ? "connecting" : "reconnecting");
      events.onopen = () => {
        if (disposed || source !== events) return;
        clearTimeout(reopen);
        reopen = undefined;
        open = true;
        setConnection("open");
        heard();
        clearTimeout(starting);
        starting = setTimeout(() => {
          starting = undefined;
          emit({ type: "reset", reason: "open" });
        }, START_WAIT_MS);
      };
      events.onmessage = (message: MessageEvent) => {
        if (disposed || source !== events) return;
        heard();
        if (message.lastEventId) lastId = message.lastEventId;
        const event = parseWorkspaceEvent(message.data);
        if (event.type === "resumed" || event.type === "reset") {
          clearTimeout(starting);
          starting = undefined;
        }
        if (event.type === "resumed" || event.type === "heartbeat") return;
        emit(event);
      };
      events.addEventListener?.("heartbeat", () => {
        if (!disposed && source === events) heard();
      });
      events.onerror = () => {
        if (disposed || source !== events) return;
        open = false;
        clearTimeout(starting);
        clearTimeout(silence);
        starting = silence = undefined;
        setConnection("reconnecting");
        // CLOSED: the browser will not retry (e.g. an HTTP error). Otherwise
        // it retries by itself, but a retry that never opens is replaced.
        if (reopen === undefined)
          reopen = setTimeout(
            () => connect("closed"),
            events.readyState === 2 ? REOPEN_MS : STALLED_MS,
          );
      };
    };
    const poll = () => {
      if (!open && document.visibilityState === "visible")
        emit({ type: "reset", reason: "poll" });
    };
    const focus = () => {
      if (!open) emit({ type: "reset", reason: "poll" });
      // After sleep a dead stream can look open; heartbeats tell.
      else if (Date.now() - lastHeard > 20_000) connect("focus");
    };
    // A phone's page comes back by becoming visible, from the back-forward
    // cache or with its network, often without a focus event (T-170).
    const visible = () => {
      if (document.visibilityState === "visible") focus();
    };
    connect("first");
    const interval = setInterval(poll, POLL_MS);
    window.addEventListener("focus", focus);
    window.addEventListener("pageshow", focus);
    window.addEventListener("online", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      if (source) {
        source.onopen = source.onmessage = source.onerror = null;
        source.close();
      }
      clearTimeout(starting);
      clearTimeout(silence);
      clearTimeout(reopen);
      clearInterval(interval);
      window.removeEventListener("focus", focus);
      window.removeEventListener("pageshow", focus);
      window.removeEventListener("online", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled]);
  return connection;
}
