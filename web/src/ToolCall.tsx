import type { ReactNode } from "react";
import { Archive, BookOpen, ChevronRight, ClipboardCheck, FileSearch, Inbox, MessageSquarePlus, PanelsTopLeft, Plug, Send, SquarePen, UserPlus } from "lucide-react";
import { useLanguage } from "./i18n";
import { Tip, type TipTone } from "./Tip";
import { callWords, yuzunoTool, type CallFacts } from "./tool-call";
import type { NativeItem } from "./types";
import "./tool-call.css";

/**
 * One tool call's row as a single-line capsule (T-9): its icon, its name and
 * its short result, cut short with an ellipsis when the line is full. The
 * summary still opens the row's raw input and result. A pointer resting on
 * it or keyboard focus shows a few more facts below it, in the app's one
 * tip (Tip.tsx); on a touch screen a tap opens the row, which leads with the
 * same facts. Everything here is text: nothing in a tool's answer becomes
 * markup or an action.
 *  - `name`: the name as shown, with any hint after it.
 *  - `result`: said at the end instead of the state, such as a command's
 *    exit code or a sub-agent's status.
 *  - `resultNote`: what that result means, where it needs saying (a state
 *    not confirmed): in the tip.
 */
export function ToolCallSummary({ icon, name, facts, result, resultNote }: {
  icon: ReactNode;
  name: ReactNode;
  facts: CallFacts;
  result?: string | null;
  resultNote?: string;
}) {
  const t = callWords(useLanguage());
  const end = result !== undefined ? result : facts.state ?? (facts.tone === "returned" && !facts.note ? t.tone.returned : null);
  return (
    <Tip side="bottom" align="start" size="wide" className="tool-call-tip"
      content={<CallTip facts={facts} note={resultNote} state={end && end !== facts.note ? end : facts.tone ? t.tone[facts.tone] : null} />}>
      <summary className="tool-call" data-tone={facts.tone || undefined} data-to-expand={facts.toExpand || undefined}>
        <ChevronRight size={12} />
        {icon}
        {/* The name and its result are one run of text, so the line is cut
            from its end: the result gives way first, and the name only when it
            alone is too long. */}
        <span className="tool-call-text">
          <span className="tool-call-name">{name}</span>
          {facts.note && <span className="tool-call-note" lang={facts.noteGiven ? "" : undefined}>{facts.note}</span>}
        </span>
        {end && <span className="tool-result">{end}</span>}
      </summary>
    </Tip>
  );
}

const yuzunoIcons = {
  task_comment: MessageSquarePlus,
  task_update: SquarePen,
  brief_get: BookOpen,
  brief_update: PanelsTopLeft,
  peer_read: Inbox,
  peer_send: Send,
  task_get: FileSearch,
  task_submit_result: ClipboardCheck,
  task_dispatch: UserPlus,
  executor_release: Archive,
};

/** The icon of a call to one of Yuzuno's tools above or another MCP tool;
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

/** How a call's state is coloured in its tip: bad news, or not settled. */
const tipTone = (tone: CallFacts["tone"]): TipTone | null =>
  tone === "failed" || tone === "refused" ? "bad" : tone === "unconfirmed" || tone === "queued" ? "attention" : null;

/** The few more facts of a call, below its capsule: its full name, its
 * state, what that state means, and its facts. */
function CallTip({ facts, state, note }: { facts: CallFacts; state: string | null; note?: string }) {
  return (
    <>
      {/* A command can run to pages; its start names it. */}
      <strong className="tip-title" lang="">{facts.fullName.length > 300 ? `${facts.fullName.slice(0, 299)}…` : facts.fullName}</strong>
      {state && <span className="tip-status" data-tone={tipTone(facts.tone) || undefined}>{state}</span>}
      {note && <span className="tip-body">{note}</span>}
      <CallDetails facts={facts} />
    </>
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
