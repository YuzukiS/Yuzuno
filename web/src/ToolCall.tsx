import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BookOpen, ChevronRight, Inbox, MessageSquarePlus, PanelsTopLeft, Plug, Send, SquarePen } from "lucide-react";
import { langTag, useLanguage } from "./i18n";
import { callWords, yuzunoTool, type CallFacts } from "./tool-call";
import type { NativeItem } from "./types";
import "./tool-call.css";

/** How long a pointer rests on a capsule before its few more facts show. */
const HOVER_MS = 250;

/**
 * One tool call's row as a single-line capsule (T-9): its icon, its name and
 * its short result, cut short with an ellipsis when the line is full. The
 * summary still opens the row's raw input and result. A mouse resting on it
 * or keyboard focus shows a few more facts beside it, which Escape hides; on
 * a touch screen a tap opens the row, which leads with the same facts.
 * Everything here is text: nothing in a tool's answer becomes markup or an
 * action.
 *  - `name`: the name as shown, with any hint after it.
 *  - `result`: said at the end instead of the state, such as a command's
 *    exit code or a sub-agent's status.
 *  - `raw`: the row opens to the raw input and result (not a sub-agent's
 *    detail or a plan).
 */
export function ToolCallSummary({ icon, name, facts, result, resultTitle, open, raw = true }: {
  icon: ReactNode;
  name: ReactNode;
  facts: CallFacts;
  result?: string | null;
  resultTitle?: string;
  open: boolean;
  raw?: boolean;
}) {
  const language = useLanguage();
  const t = callWords(language);
  const summary = useRef<HTMLElement>(null);
  const timer = useRef(0);
  // A press focuses the capsule on its way to opening the row: that focus
  // is the pointer's, not the keyboard's, and shows no tip.
  const pressed = useRef(false);
  const [shown, setShown] = useState(false);
  const id = useId();
  const end = result !== undefined ? result : facts.state ?? (facts.tone === "returned" && !facts.note ? t.tone.returned : null);
  const show = () => { window.clearTimeout(timer.current); setShown(true); };
  const hide = () => { window.clearTimeout(timer.current); setShown(false); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!shown) return;
    // The tip stays with the capsule it describes: a scroll or a resize
    // moves the capsule, so the tip goes until it is pointed at again.
    const away = () => hide();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      hide();
    };
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("keydown", escape, true);
    };
  }, [shown]);
  return (
    <summary ref={summary} className="tool-call" data-tone={facts.tone || undefined} data-to-expand={facts.toExpand || undefined}
      aria-describedby={shown ? id : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setShown(true), HOVER_MS);
      }}
      onPointerLeave={hide}
      // Opening the row puts its facts below; the tip would cover them.
      onPointerDown={() => { pressed.current = true; hide(); }}
      onClick={() => { pressed.current = false; }}
      onFocus={() => { if (!pressed.current) show(); pressed.current = false; }}
      onBlur={() => { pressed.current = false; hide(); }}>
      <ChevronRight size={12} />
      {icon}
      {/* The name and its result are one run of text, so the line is cut
          from its end: the result gives way first, and the name only when it
          alone is too long. */}
      <span className="tool-call-text">
        <span className="tool-call-name">{name}</span>
        {facts.note && <span className="tool-call-note" lang={facts.noteGiven ? "" : undefined}>{facts.note}</span>}
      </span>
      {end && <span className="tool-result" title={resultTitle}>{end}</span>}
      {shown && summary.current && createPortal(<CallTip id={id} anchor={summary.current} facts={facts}
        hint={raw ? open ? t.hideRaw : t.showRaw : open ? t.hideRow : t.showRow}
        state={end && end !== facts.note ? end : facts.tone ? t.tone[facts.tone] : null} />, document.body)}
    </summary>
  );
}

const yuzunoIcons = {
  task_comment: MessageSquarePlus,
  task_update: SquarePen,
  brief_get: BookOpen,
  brief_update: PanelsTopLeft,
  peer_read: Inbox,
  peer_send: Send,
};

/** The icon of a call to one of Yuzuno's six tools or another MCP tool;
 * `fallback` for the rest. */
export function callIcon(item: NativeItem, fallback: ReactNode): ReactNode {
  const tool = yuzunoTool(item);
  const Icon = tool ? yuzunoIcons[tool] : item.type === "mcpToolCall" ? Plug : null;
  return Icon ? <Icon size={14} aria-hidden="true" /> : fallback;
}

/** A tool's name with its server quieter: "yuzuno/" then "task_get". */
export function CallName({ name }: { name: string }) {
  const cut = name.indexOf("/");
  if (cut <= 0 || cut === name.length - 1) return <strong>{name}</strong>;
  return <><span className="tool-call-server">{name.slice(0, cut + 1)}</span><strong>{name.slice(cut + 1)}</strong></>;
}

/** The few more facts of a call, beside its capsule. */
function CallTip({ id, anchor, facts, hint, state }: {
  id: string; anchor: HTMLElement; facts: CallFacts; hint: string; state: string | null;
}) {
  const language = useLanguage();
  const tip = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect();
    const own = tip.current?.getBoundingClientRect();
    const width = own?.width ?? 0, height = own?.height ?? 0;
    // Below the capsule, or above it when the window ends first.
    const below = box.bottom + 6;
    const top = below + height > window.innerHeight - 8 && box.top - 6 - height >= 8 ? box.top - 6 - height : below;
    setPlace({ left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)), top });
  }, [anchor]);
  return (
    <div ref={tip} id={id} role="tooltip" className="tool-call-tip" lang={langTag(language)}
      style={place ?? { left: 8, top: 8, visibility: "hidden" }}>
      {/* A command can run to pages; its start names it. */}
      <p className="tool-call-tip-name" lang="">{facts.fullName.length > 300 ? `${facts.fullName.slice(0, 299)}…` : facts.fullName}</p>
      {state && <p className="tool-call-tip-state" data-tone={facts.tone || undefined}>{state}</p>}
      <CallDetails facts={facts} />
      <p className="tool-call-tip-hint">{hint}</p>
    </div>
  );
}

/** A call's facts as a short list, with what its answer does not mean:
 * in its tip, and leading its row once opened. */
export function CallDetails({ facts }: { facts: CallFacts }) {
  const t = callWords(useLanguage());
  if (!facts.details.length && !facts.caution && !facts.toExpand) return null;
  return (
    <div className="tool-call-details">
      {!!facts.details.length && (
        <dl>
          {facts.details.map((detail) => (
            <div key={detail.label}>
              <dt>{detail.label}</dt>
              <dd lang={detail.given ? "" : undefined}>{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {facts.toExpand && <p className="tool-call-caution">{t.toExpandNote}</p>}
      {facts.caution && <p className="tool-call-caution">{facts.caution}</p>}
    </div>
  );
}
