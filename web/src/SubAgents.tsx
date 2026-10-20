import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Bot, ChevronLeft, LoaderCircle, RefreshCw, X } from "lucide-react";
import { api, errorText } from "./api";
import {
  conversationSubAgents,
  stateLabels,
  threadStatusLabel,
  turnStatusLabel,
  type ConversationSubAgent,
  type SubAgentDetail,
  type SubAgentState,
} from "./subagents";
import type { NativeItem } from "./types";
import { useConversationTarget, useConversationWindowed } from "./ConversationWindow";
import { StatusMark, WorkDockGroup, WorkDockItem, WorkDockMore } from "./WorkDock";
import "./subagents.css";

/**
 * The sub-agents now live in the conversation's left dock (SubAgentDock),
 * where they stay in sight. Their Turn keeps only the Items' anchors, so a
 * link to one of them still finds its place. A child's many activity events
 * need no DOM of their own: windowed Turns keep the first and any requested
 * anchor.
 */
export function SubAgentAnchors({
  turnId,
  items,
}: {
  turnId: string;
  items: readonly NativeItem[];
}) {
  const target = useConversationTarget(turnId);
  const windowed = useConversationWindowed();
  const [lastTarget, setLastTarget] = useState<string>();
  const requested = items.some((item) => item.id === target?.itemId) ? target?.itemId : undefined;
  useLayoutEffect(() => {
    if (requested) setLastTarget(requested);
  }, [requested]);
  const ids = windowed
    ? [...new Set([items[0]?.id, requested || lastTarget].filter((id): id is string => !!id))]
    : items.map((item) => item.id);
  return (
    <>
      {ids.map((id) => (
        <span key={id} id={`item-${id}`} data-item-id={id} tabIndex={-1} className="subagent-anchor" />
      ))}
    </>
  );
}

// The dock's own status keys for a sub-agent's last known fact. Started is
// only "to confirm"; how an ended child finished is read in its details.
const dockStatus: Record<SubAgentState, string> = {
  started: "running",
  ended: "ended",
  interrupted: "interrupted",
  unknown: "unconfirmed",
};
const dockSub: Record<SubAgentState, string> = {
  started: "Started",
  ended: "Ended",
  interrupted: "Interrupted",
  unknown: "Status unknown",
};

/** At most this many on the dock unless a caller says otherwise: Settings
 * sets it for sub-agents; Claude's background tasks keep this one. */
const SHOWN = 5;

/**
 * One sub-agent on the dock, from whichever harness reported it: Codex's
 * here, and others' (such as Claude's) through SubAgentDock's `entries`.
 */
export type DockSubAgent = {
  /** Unique within the conversation: a Codex thread, a Claude tool use. */
  key: string;
  /** The Turn it started in, which "Go to its Turn" opens. */
  turnId: string;
  label: string;
  /** A WorkDock status key, which picks its mark. */
  status: string;
  /** Its status in words. */
  state: string;
  /** A few words under its name on the dock. */
  sub: string;
  /** Where it works and on what, such as its path and model. */
  detail?: string;
  /** Not yet known to have ended: listed before those that have. */
  waiting: boolean;
  /** Its card: what the harness reports about it, read when it opens. */
  details: (onNavigate: (turnId: string) => void) => ReactNode;
};

/** Codex's sub-agents, as the dock shows them. */
function codexEntries(agentId: string, children: ConversationSubAgent[]): DockSubAgent[] {
  return children.map((child) => ({
    key: child.threadId,
    turnId: child.turnId,
    label: child.label,
    status: dockStatus[child.state],
    state: stateLabels[child.state],
    sub: dockSub[child.state],
    detail: [child.path, child.model].filter(Boolean).join(" · "),
    waiting: child.state === "started",
    details: (onNavigate) => (
      <SubAgentDetails key={child.threadId} agentId={agentId} child={child} onNavigate={onNavigate} />
    ),
  }));
}
const NO_ENTRIES: readonly DockSubAgent[] = [];

/** A dock group's names: its heading, one of its entries, and its icon. */
export type DockGroup = { label: string; one: string; icon: (size: number) => ReactNode };
const SUBAGENTS: DockGroup = { label: "Sub-agents", one: "Sub-agent", icon: (size) => <Bot size={size} /> };

/**
 * The conversation's sub-agents as a group of the left dock, under its jobs
 * and runs: those still to confirm first, then the latest started. A node
 * opens a card beside the dock with what its harness reports for it. Codex's
 * come from the loaded Turns; other harnesses pass theirs as `entries`.
 */
export function SubAgentDock({
  agentId,
  turns,
  entries = NO_ENTRIES,
  onNavigate,
  group = SUBAGENTS,
  limit = SHOWN,
}: {
  agentId: string;
  turns: readonly { id: string; status?: string; items?: readonly NativeItem[] }[];
  entries?: readonly DockSubAgent[];
  onNavigate: (turnId: string) => void;
  /** What the group lists, for its heading and card (Claude's background tasks use it too). */
  group?: DockGroup;
  /** At most this many on the dock; 0 leaves the group off it. */
  limit?: number;
}) {
  const codex = useMemo(() => conversationSubAgents(turns), [turns]);
  const all = useMemo(() => [...codexEntries(agentId, codex), ...entries], [agentId, codex, entries]);
  const [card, setCard] = useState<{ key: string | null; from: HTMLElement } | null>(null);
  if (!all.length || limit <= 0) return null;
  const shown = all
    .map((child, order) => ({ child, order }))
    .sort((a, b) => +b.child.waiting - +a.child.waiting || b.order - a.order)
    .slice(0, limit)
    .map(({ child }) => child);
  return (
    <>
      <WorkDockGroup label={group.label} icon={group.icon(14)} onOpen={(from) => setCard({ key: null, from })}>
        {shown.map((child) => (
          <WorkDockItem
            key={child.key}
            className="conversation-subagent"
            status={child.status}
            state={child.state}
            name={child.label}
            sub={child.sub}
            detail={child.detail}
            onOpen={(from) => setCard({ key: child.key, from })}
          />
        ))}
        {all.length > shown.length && (
          <WorkDockMore
            label={group.label}
            count={all.length - shown.length}
            onOpen={(from) => setCard({ key: null, from })}
          />
        )}
      </WorkDockGroup>
      {card && (
        <SubAgentCard
          group={group}
          all={all}
          chosen={card.key}
          from={card.from}
          onChoose={(key) => setCard({ ...card, key })}
          onNavigate={(turnId) => {
            setCard(null);
            onNavigate(turnId);
          }}
          onClose={() => setCard(null)}
        />
      )}
    </>
  );
}

/**
 * A card beside the dock: the list of this conversation's sub-agents, or
 * one of them. A child's details are read from Codex only when its card
 * opens, and its answer stays here, never mixed into the Agent's reply.
 */
function SubAgentCard({
  group,
  all,
  chosen,
  from,
  onChoose,
  onNavigate,
  onClose,
}: {
  group: DockGroup;
  all: DockSubAgent[];
  chosen: string | null;
  from: HTMLElement;
  onChoose: (key: string | null) => void;
  onNavigate: (turnId: string) => void;
  onClose: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  // The latest callback, so closing never re-runs the focus handling below.
  const close = useRef(onClose);
  close.current = onClose;
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const child = all.find((c) => c.key === chosen) ?? null;
  // Beside the node that opened it, kept inside the window, and placed
  // again whenever the card changes size (its details arrive after it opens,
  // another child is chosen) or the window does.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const placeCard = () => {
      const anchor = from.getBoundingClientRect();
      setPlace({
        left: Math.max(8, Math.min(anchor.right + 10, innerWidth - el.offsetWidth - 8)),
        top: Math.max(8, Math.min(anchor.top - 12, innerHeight - el.offsetHeight - 8)),
      });
    };
    placeCard();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(placeCard);
    observer?.observe(el);
    window.addEventListener("resize", placeCard);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", placeCard);
    };
  }, [from]);
  // Focus moves into the card once it is placed (hidden until then, it can
  // take no focus) and returns to its node; Escape or a press elsewhere
  // closes it.
  const placed = !!place;
  useEffect(() => {
    if (placed) card.current?.focus();
  }, [placed]);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!card.current?.contains(event.target as Node) && !from.contains(event.target as Node)) close.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
      if (from.isConnected) from.focus();
    };
  }, [from]);
  // Choosing a child, or going back to the list, removes the button that had
  // focus: keep focus in the card, back on the list at the child just read.
  const view = useRef(chosen);
  useEffect(() => {
    const was = view.current;
    view.current = chosen;
    const el = card.current;
    if (was === chosen || !el || el.contains(document.activeElement)) return;
    const back = !chosen && [...el.querySelectorAll<HTMLElement>("[data-key]")].find((b) => b.dataset.key === was);
    (back || el).focus();
  }, [chosen]);
  return createPortal(
    <div
      ref={card}
      className="subagent-card"
      role="dialog"
      aria-label={child ? `${group.one} ${child.label}` : `${group.label} in this conversation`}
      tabIndex={-1}
      style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
    >
      <header className="subagent-card-heading">
        {child && all.length > 1 ? (
          <button type="button" className="icon-button" aria-label={`All ${group.label.toLowerCase()}`} onClick={() => onChoose(null)}>
            <ChevronLeft size={15} />
          </button>
        ) : (
          <span className="subagent-card-icon" aria-hidden="true">{group.icon(15)}</span>
        )}
        <strong>{child ? child.label : `${group.label} · ${all.length}`}</strong>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      {child ? (
        child.details(onNavigate)
      ) : (
        <ul className="subagent-card-list">
          {[...all].reverse().map((c) => (
            <li key={c.key}>
              <button type="button" data-key={c.key} onClick={() => onChoose(c.key)}>
                <StatusMark status={c.status} />
                <strong>{c.label}</strong>
                <span>{c.state}</span>
                <small>{c.detail}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}

function SubAgentDetails({
  agentId,
  child,
  onNavigate,
}: {
  agentId: string;
  child: ConversationSubAgent;
  onNavigate: (turnId: string) => void;
}) {
  const [detail, setDetail] = useState<SubAgentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDetail(
        await api<SubAgentDetail>(
          `/agents/${encodeURIComponent(agentId)}/subagents/${encodeURIComponent(child.threadId)}`,
        ),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    // Read once per card; "Read again" asks again.
    void load();
  }, []);
  return (
    <div className="subagent-detail">
      <p className="subagent-card-state">
        <StatusMark status={dockStatus[child.state]} />
        {stateLabels[child.state]}
        {child.path && <code>{child.path}</code>}
      </p>
      {loading && (
        <p className="subagent-note">
          <LoaderCircle size={13} className="updates-spin" aria-hidden /> Reading from Codex…
        </p>
      )}
      {error && (
        <p className="subagent-error" role="alert">
          {error}
        </p>
      )}
      {detail && <Detail detail={detail} />}
      <div className="subagent-card-actions">
        <button type="button" className="quiet-button" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={12} aria-hidden /> Read again
        </button>
        <button type="button" className="quiet-button" onClick={() => onNavigate(child.turnId)}>
          <ArrowUpRight size={12} aria-hidden /> Go to its Turn
        </button>
      </div>
    </div>
  );
}

function Detail({ detail }: { detail: SubAgentDetail }) {
  const turn = detail.turn;
  const read = new Date(detail.readAt);
  return (
    <>
      <dl className="subagent-facts">
        {detail.nickname && (
          <>
            <dt>Name</dt>
            <dd>{detail.nickname}</dd>
          </>
        )}
        <dt>Latest turn</dt>
        <dd>{turn ? turnStatusLabel(turn.status) : "None yet"}</dd>
        <dt>Thread</dt>
        <dd>{threadStatusLabel(detail.status)}</dd>
        <dt>Goal</dt>
        <dd className="subagent-muted">Not provided by this Codex version</dd>
        {detail.model && (
          <>
            <dt>Model</dt>
            <dd>{detail.model}</dd>
          </>
        )}
        {detail.role && (
          <>
            <dt>Role</dt>
            <dd>{detail.role}</dd>
          </>
        )}
        <dt>Thread ID</dt>
        <dd>
          <code title={`Parent ${detail.parentThreadId}`}>{detail.threadId}</code>
        </dd>
      </dl>
      {turn?.error && (
        <p className="subagent-error" role="alert">
          {turn.error}
        </p>
      )}
      <div className="subagent-answer">
        <span className="subagent-answer-label">Answer</span>
        {detail.result ? (
          <p>
            {detail.result.text}
            {detail.result.truncated && <span className="subagent-muted"> … (shortened)</span>}
          </p>
        ) : (
          <p className="subagent-muted">No answer yet</p>
        )}
      </div>
      <p className="subagent-note">
        Read {detail.readFrom === "live" ? "from the running Codex" : "from Codex history"} at{" "}
        {Number.isNaN(read.getTime())
          ? detail.readAt
          : read.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </p>
    </>
  );
}
