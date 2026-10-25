import { useEffect, useRef, useState } from "react";
import { API_BASE } from "./api";
import { strings, useStrings } from "./i18n";
import {
  READ_EVERY_MS,
  behindAgents,
  nextStreaks,
  type BacklogRead,
  type Streaks,
} from "./core-backlog";
import "./core-backlog.css";

// What the hint says (T-189); Agent names as they came.
const text = strings({
  someAgent: "An Agent",
  hint: "Core is catching up on output; status may lag",
  region: "Core backlog",
  explain: "Core has received these events from the runtime but has not finished applying them. Thinking and long-running tools are not counted.",
  waiting: (count: number, seconds: number) => ` · ${count} ${count === 1 ? "event" : "events"} waiting · oldest ${seconds} s`,
  observed: "Observed ",
}, {
  someAgent: "某个 Agent",
  hint: "Core 正在处理积压的输出；状态可能滞后",
  region: "Core 积压",
  explain: "Core 已从运行时收到这些事件，但尚未处理完。思考和长时间运行的工具不计入。",
  waiting: (count, seconds) => ` · ${count} 个事件等待中 · 最早的已等 ${seconds} 秒`,
  observed: "观察于 ",
});

/**
 * A short note next to the Core status when Core itself has stayed behind in
 * applying an Agent's output. It reports only Core's own backlog: thinking,
 * long tools or a quiet runtime are not lag, and it never acts on an Agent.
 */
export function CoreBacklog({
  agents,
  live,
}: {
  agents: { id: string; name: string }[];
  /** Core reachable and live updates open; otherwise the backlog is unknown. */
  live: boolean;
}) {
  const [read, setRead] = useState<BacklogRead | null>(null);
  const [streaks, setStreaks] = useState<Streaks>({});
  const t = useStrings(text);
  const [open, setOpen] = useState(false);
  const unsupported = useRef(false);

  useEffect(() => {
    // A read answers for the moment it was asked; forgetting (hidden, not
    // live) makes any read still out stale.
    let epoch = 0;
    const forget = () => {
      epoch++;
      setRead(null);
      setStreaks({});
    };
    if (!live) {
      forget();
      return;
    }
    let stopped = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      clearTimeout(timer);
      if (stopped || unsupported.current) return;
      if (document.visibilityState !== "visible") {
        forget();
        return;
      }
      if (reading) return;
      reading = true;
      const asked = epoch;
      const controller = new AbortController();
      const limit = setTimeout(() => controller.abort(), 4000);
      let next: BacklogRead | null = null;
      try {
        const response = await fetch(`${API_BASE}/api/backlog`, {
          signal: controller.signal,
        });
        const json = (response.headers.get("content-type") ?? "").includes(
          "application/json",
        );
        if (response.status === 404 || (response.ok && !json)) {
          // An older Core has no backlog route: it answers 404, or with its
          // page (the web app's fallback for unknown paths). Ask no more.
          unsupported.current = true;
        } else if (response.ok) {
          const body = (await response.json()) as BacklogRead;
          if (body && typeof body.agents === "object") next = body;
        }
        // Anything else (a server error) is unknown for now.
      } catch {
        // Unreachable, timed out or unreadable: unknown for now.
      } finally {
        clearTimeout(limit);
        reading = false;
      }
      if (stopped) return;
      if (asked !== epoch || document.visibilityState !== "visible") {
        // Hidden while this read was out: its answer is stale. If the window
        // is visible again, start afresh now.
        if (document.visibilityState === "visible") void tick();
        return;
      }
      setRead(next);
      setStreaks((previous) => nextStreaks(previous, next));
      timer = setTimeout(tick, READ_EVERY_MS);
    };
    void tick();
    document.addEventListener("visibilitychange", tick);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [live]);

  const behind = behindAgents(streaks, read);
  useEffect(() => {
    if (!behind.length) setOpen(false);
  }, [behind.length]);
  if (!behind.length || !read) return null;

  const name = (id: string) =>
    agents.find((agent) => agent.id === id)?.name || t.someAgent;
  const observed = new Date(read.observedAt);
  return (
    <span className="core-backlog">
      <button
        type="button"
        className="core-backlog-hint"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {t.hint}
      </button>
      {open && (
        <div
          className="core-backlog-details"
          role="region"
          aria-label={t.region}
        >
          <p>{t.explain}</p>
          <ul>
            {behind.map((agent) => (
              <li key={agent.id}>
                <strong>{name(agent.id)}</strong>
                {t.waiting(agent.pending, Math.round(agent.oldestMs / 1000))}
              </li>
            ))}
          </ul>
          <p className="core-backlog-observed">
            {t.observed}
            {Number.isNaN(observed.getTime())
              ? read.observedAt
              : observed.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
          </p>
        </div>
      )}
    </span>
  );
}
