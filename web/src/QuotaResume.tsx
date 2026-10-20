import { useEffect, useRef, useState } from "react";
import { Clock, LoaderCircle, Play, X } from "lucide-react";
import { api, errorText, post } from "./api";
import type { AgentDetail } from "./types";
import "./recovery.css";
import "./quota-resume.css";

/** Core's automatic continue after a Claude usage limit resets (T-94). */
export interface AutoContinueIntent {
  id: string;
  turnId: string;
  resetsAt: number;
  dueAt: number;
  limitType: string | null;
  attempt: number;
  state: "waiting" | "sending" | "sent" | "cancelled" | "failed" | "uncertain";
  reason: string | null;
  sentTurn: string | null;
}

export interface AutoContinueView {
  workspace: boolean;
  agent: boolean | null;
  enabled: boolean;
  intent: AutoContinueIntent | null;
  stopped: {
    turnId: string;
    resetsAt: number;
    limitType: string | null;
  } | null;
}

const limitNames: Record<string, string> = {
  five_hour: "five-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
};
const limitName = (type: string | null | undefined) =>
  type ? `${limitNames[type] || type.replace(/_/g, " ")} ` : "";
export const at = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Reads the view again whenever the Agent's record changes. */
function useAutoContinue(agentId: string, version: string) {
  const [view, setView] = useState<AutoContinueView | null>(null);
  const [error, setError] = useState("");
  const current = useRef(agentId);
  current.current = agentId;
  async function load(target = agentId) {
    try {
      const next = await api<AutoContinueView>(
        `/agents/${encodeURIComponent(target)}/claude/auto-continue`,
      );
      if (current.current === target) {
        setView(next);
        setError("");
      }
    } catch (e) {
      if (current.current === target) setError(errorText(e));
    }
  }
  useEffect(() => {
    setView(null);
    setError("");
  }, [agentId]);
  useEffect(() => {
    void load(agentId);
  }, [agentId, version]);
  return { view, setView, error, setError, reload: () => load(agentId) };
}

/** When to read the view again: on every record change only while the
 * agent is stopped (an intent is armed, cancelled or sent then), otherwise
 * when its status changes. A running turn changes the record constantly. */
export const autoContinueVersion = (detail: AgentDetail) =>
  detail.agent.status === "error"
    ? [
        detail.agent.status,
        detail.agent.updatedAt,
        detail.agent.lastSeq,
        detail.turns.length,
      ].join("|")
    : detail.agent.status;

/**
 * In the conversation: why a Claude agent stopped at its usage limit, and
 * what happens next. Nothing is shown unless the limit stopped its latest
 * turn or an automatic continue concerns it.
 */
export function QuotaResumeNotice({
  detail,
  disabled,
}: {
  detail: AgentDetail;
  disabled: boolean;
}) {
  const agentId = detail.agent.id;
  const { view, setView, error, setError } = useAutoContinue(
    agentId,
    autoContinueVersion(detail),
  );
  const [busy, setBusy] = useState<"" | "now" | "cancel" | "on">("");
  if (!view) return null;
  const intent = view.intent;
  const stopped = view.stopped;
  if (!intent && !stopped) return null;
  if (intent?.state === "sent" && !stopped) return null;

  async function act(kind: "now" | "cancel" | "on") {
    if (busy || disabled) return;
    setBusy(kind);
    setError("");
    try {
      const path = `/agents/${encodeURIComponent(agentId)}/claude/auto-continue`;
      setView(
        kind === "on"
          ? await post<AutoContinueView>(path, { enabled: true })
          : await post<AutoContinueView>(`${path}/${kind}`, {
              intentId: intent!.id,
            }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }

  const resets = intent?.resetsAt ?? stopped?.resetsAt;
  const limit = limitName(intent?.limitType ?? stopped?.limitType);
  const beforeReset = resets !== undefined && resets * 1000 > Date.now();
  let text: string;
  if (intent?.state === "waiting") {
    text = `Claude’s ${limit}usage limit stopped this agent. It resets at ${at(intent.resetsAt)}; Yuzuno then sends one message to continue the task in the same session, at about ${at(intent.dueAt)}. Earlier messages and tools are not sent again, and approvals still ask you.`;
  } else if (intent?.state === "sending") {
    text = "Continuing after Claude’s usage limit reset…";
  } else if (intent && intent.state !== "sent") {
    const what =
      intent.state === "cancelled"
        ? "Automatic continue was cancelled"
        : intent.state === "uncertain"
          ? "The automatic continue message’s delivery isn’t confirmed"
          : "Couldn’t continue automatically";
    text = `${what}: ${intent.reason || "no reason given"}.${resets ? ` Claude’s ${limit}usage limit resets at ${at(resets)}.` : ""}`;
  } else {
    text = `Claude’s ${limit}usage limit stopped this agent. It resets at ${at(resets!)}. ${
      view.enabled
        ? "Automatic continue couldn’t be arranged for this stop."
        : "Nothing continues by itself."
    }`;
  }
  return (
    <div className="recovery-notice quota-resume-notice" role="status">
      <Clock size={14} />
      <span>{text}</span>
      <div className="quota-resume-actions">
        {intent?.state === "waiting" && (
          <>
            <button
              type="button"
              className="secondary-button"
              disabled={disabled || !!busy}
              title={
                beforeReset
                  ? `Claude may still refuse until ${at(intent.resetsAt)}.`
                  : undefined
              }
              onClick={() => void act("now")}
            >
              {busy === "now" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Play size={14} />
              )}
              Continue now
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={disabled || !!busy}
              onClick={() => void act("cancel")}
            >
              {busy === "cancel" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <X size={14} />
              )}
              Don’t continue automatically
            </button>
          </>
        )}
        {!intent && stopped && !view.enabled && beforeReset && (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || !!busy}
            onClick={() => void act("on")}
          >
            {busy === "on" ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Clock size={14} />
            )}
            Continue automatically after the reset
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="recovery-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** "At a glance": this agent's choice, or the workspace default. */
export function AutoContinueSetting({
  detail,
  disabled,
}: {
  detail: AgentDetail;
  disabled: boolean;
}) {
  const agentId = detail.agent.id;
  const { view, setView, error, setError } = useAutoContinue(
    agentId,
    detail.agent.status,
  );
  const [busy, setBusy] = useState(false);
  if (!view) return null;
  const value = view.agent === null ? "default" : view.agent ? "on" : "off";
  async function choose(next: string) {
    setBusy(true);
    setError("");
    try {
      setView(
        await post<AutoContinueView>(
          `/agents/${encodeURIComponent(agentId)}/claude/auto-continue`,
          { enabled: next === "default" ? null : next === "on" },
        ),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function setDefault(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      await post("/claude/auto-continue", { enabled });
      setView(
        await api<AutoContinueView>(
          `/agents/${encodeURIComponent(agentId)}/claude/auto-continue`,
        ),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auto-continue-setting">
      <dt>Usage limit</dt>
      <dd>
        <select
          aria-label="After Claude’s usage limit resets"
          value={value}
          disabled={disabled || busy}
          onChange={(e) => void choose(e.target.value)}
          title="When Claude’s usage limit stops this agent, Yuzuno can wait for Claude’s reset and send one message to continue the task in the same session."
        >
          <option value="default">
            Default · {view.workspace ? "continue" : "wait for you"}
          </option>
          <option value="on">Continue after reset</option>
          <option value="off">Wait for you</option>
        </select>
        <button
          type="button"
          className="inline-link"
          disabled={disabled || busy}
          onClick={() => void setDefault(!view.workspace)}
        >
          {view.workspace
            ? "Make the default: wait for you"
            : "Make the default: continue"}
        </button>
        {error && (
          <span role="alert" className="recovery-error">
            {error}
          </span>
        )}
      </dd>
    </div>
  );
}
