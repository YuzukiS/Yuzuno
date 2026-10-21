import { MessageContent } from "./MessageContent";
import { RewindButton } from "./Rewind";
import { SendToAgentButton, startHandoffDrag } from "./SendToAgent";
import { HANDOFF_TYPE, type HandoffSource, type MessageAuthor } from "./handoff";
import { parseMessageLink, useMessageLinks } from "./deep-link";
import { usePointFix } from "./point-fix";
import { ImageAttachments, inputImageUrl } from "./ImageAttachments";
import { MailboxNotice } from "./MailboxNotice";
import { userRequestText, userText } from "./message-content";
import { messageImages } from "./image-input";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  SquareDashedMousePointer,
  FileCode2,
  FileText,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  BellRing,
  ShieldCheck,
  SquareTerminal,
  X,
} from "lucide-react";
import type {
  Agent,
  ArtifactPreview,
  BackgroundShells,
  NativeItem,
  NativeTurn,
  PendingRequest,
  MessageReceipt,
} from "./types";
import { api, artifactUrl, errorText, respondToRequest } from "./api";
import { AnswerAgain, useUnconfirmedAnswer } from "./unconfirmed-answer";
import { ClaudePermission, ClaudeSubAgentScope, ClaudeTool } from "./ClaudeControls";
import { OpenCodeRequest, OpenCodeTool } from "./OpenCodeControls";
import { agentHarnessName } from "./machine-checks";
import character from "./assets/yuzu-character.png";
import characterOutline from "./assets/yuzu-character-outline.png";
import { blockItems, conversationBlocks, isCompacting, shownItemId, toolActivityCounts } from "./conversation-blocks";
import { SubAgentAnchors } from "./SubAgents";
import { ActivityElapsed } from "./ActivityElapsed";
import { activityStartedAt } from "./activity-time";
import { timeMarkKey, turnFooter, type Moment } from "./conversation-time";
import { MessageTime, TurnFooter } from "./ConversationTime";
import { AgentReply } from "./intelligent-ui/AgentReply";
import { TurnResults } from "./intelligent-ui/TurnResults";
import { formatBytes, fullTurn, isTruncated, useFullItem, type FullItemView } from "./item-payload";
import { useStreamReveal } from "./stream-reveal";
import { useToolMotion } from "./tool-motion";
import "./tool-activity.css";
import { QuestionAnchor } from "./QuestionAnchor";
import { ClaudeCheckpointButton } from "./ClaudeCheckpoint";
import { questionKey } from "./pending-questions";
import type { QuestionSource } from "./types";
import { ConversationRows, useConversationDisclosure, useConversationTarget, useFirstConversationMount, useConversationWindowed } from "./ConversationWindow";

// A tap makes Yuzu squash, hop and wiggle. Only the individual scale, rotate
// and translate properties move, so it stacks on a mark's own tilt and on the
// Working bob around it rather than replacing them.
const yuzuHop: Keyframe[] = [
  { scale: "1", translate: "0 0", rotate: "0deg" },
  { offset: 0.16, scale: "1.14 0.84", translate: "0 6%", rotate: "0deg", easing: "ease-out" },
  { offset: 0.42, scale: "0.92 1.1", translate: "0 -22%", rotate: "-9deg", easing: "ease-in" },
  { offset: 0.62, scale: "1.06 0.95", translate: "0 0", rotate: "7deg" },
  { offset: 0.8, scale: "1", translate: "0 0", rotate: "-3deg" },
  { scale: "1", translate: "0 0", rotate: "0deg" },
];
const yuzuGlow: Keyframe[] = [
  { filter: "brightness(1)" },
  { filter: "brightness(1.18)", offset: 0.35 },
  { filter: "brightness(1)" },
];

function tapYuzu(event: React.PointerEvent<HTMLImageElement>) {
  const mark = event.currentTarget;
  if (event.button !== 0 || typeof mark.animate !== "function") return;
  for (const running of mark.getAnimations())
    if (running.id === "yuzu-tap") running.cancel();
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  mark.animate(still ? yuzuGlow : yuzuHop, {
    duration: still ? 360 : 640,
    easing: "ease-out",
  }).id = "yuzu-tap";
}

export function Yuzu({
  size = 36,
  sleepy = false,
}: {
  size?: number;
  sleepy?: boolean;
}) {
  return (
    <img
      width={size}
      height={size}
      src={sleepy ? characterOutline : character}
      alt=""
      draggable={false}
      aria-hidden="true"
      className="yuzu-mark"
      onPointerDown={tapYuzu}
    />
  );
}
export function Avatar({
  agent,
  small = false,
}: {
  agent: Agent;
  small?: boolean;
}) {
  const tone =
    (
      { yuzu: "yellow", sage: "green", rose: "pink", sky: "blue" } as Record<
        string,
        string
      >
    )[agent.color] ||
    (["green", "pink", "blue", "yellow"].includes(agent.color)
      ? agent.color
      : "yellow");
  return (
    <span
      className={`avatar ${small ? "small" : ""} tone-${tone}`}
      aria-hidden="true"
    >
      {agent.name.slice(0, 1).toUpperCase()}
      <span className="avatar-leaf" />
    </span>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  className = "",
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  wide?: boolean;
  /** More classes for the dialog box, such as a fixed size. */
  className?: string;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${wide ? "modal-wide" : ""} ${className}`.trim()}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description>{description}</Dialog.Description>
              )}
            </div>
            <Dialog.Close className="icon-button" aria-label="Close dialog">
              <X size={18} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
/** Writes text that may still be loading. The clipboard write starts during
 * the click, so browsers that require a user gesture still accept it. */
async function copyText(text: string | Promise<string>) {
  if (typeof text === "string") return navigator.clipboard.writeText(text);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write)
    return navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })),
      }),
    ]);
  return navigator.clipboard.writeText(await text);
}
export function CopyButton({
  text,
  label = "Copy",
}: {
  /** The text, or a function giving it when clicked (possibly after a fetch). */
  text: string | (() => string | Promise<string>);
  label?: string;
}) {
  const [state, setState] = useState<"ready" | "copying" | "copied" | "error">("ready");
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (state === "copied" || state === "error") {
      const t = setTimeout(() => setState("ready"), 2200);
      return () => clearTimeout(t);
    }
  }, [state]);
  return (
    <button
      className="quiet-button copy-button"
      disabled={state === "copying"}
      onClick={async () => {
        let loading: Promise<string> | undefined;
        try {
          const value = typeof text === "function" ? text() : text;
          if (typeof value !== "string") {
            setState("copying");
            loading = value;
          }
          await copyText(value);
          setState("copied");
        } catch {
          // A failed fetch is not a clipboard problem; say which it was.
          const failed = await loading?.then(() => null, (e: unknown) => e);
          setProblem(failed ? `Could not load the full text: ${errorText(failed)}` : "");
          setState("error");
        }
      }}
      title={
        state === "error"
          ? problem || "Clipboard unavailable. Select the text to copy."
          : label
      }
    >
      {state === "copied" ? <Check size={13} /> : state === "copying" ? <LoaderCircle size={13} className="spin" /> : <Copy size={13} />}
      <span>
        {state === "copied"
          ? "Copied"
          : state === "copying"
            ? "Loading…"
            : state === "error"
              ? problem ? "Copy failed" : "Copy unavailable"
              : label}
      </span>
    </button>
  );
}
/** Copies the link to one message (T-166), where links are offered. */
function CopyLinkButton({ agent, turnId, itemId }: { agent: Agent; turnId: string; itemId: string }) {
  const href = useMessageLinks()?.href(agent, turnId, itemId);
  return href ? <CopyButton text={href} label="Copy link" /> : null;
}
export function Prose({
  text,
  onFile,
}: {
  text: string;
  onFile?: (path: string, line?: number) => void;
}) {
  const html = useMemo(
    () => ({
      __html: DOMPurify.sanitize(
        marked.parse(text, { async: false, gfm: true }),
        {
          USE_PROFILES: { html: true },
          FORBID_TAGS: ["img", "form", "input", "button", "iframe", "style"],
          FORBID_ATTR: ["style"],
          // DOMPurify's default URI policy plus file:// and basename.ext:line.
          // Otherwise a bare filename with a line is mistaken for a URI scheme.
          ALLOWED_URI_REGEXP:
            /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|file:\/\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$)|[a-z][\w.\-]*\.[\w.\-]+:-?\d+(?::\d+)?$)/i,
        },
      ),
    }),
    [text],
  );
  // Words streaming onto the end of a reply fade in rather than pop.
  const root = useRef<HTMLDivElement>(null);
  useStreamReveal(root, text);
  const links = useMessageLinks();
  return (
    <div
      ref={root}
      className="prose"
      dangerouslySetInnerHTML={html}
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest("a");
        if (!link) return;
        const href = link.getAttribute("href") || "";
        // A link to a message opens it here, never as a web page (T-166).
        const message = links && parseMessageLink(href);
        if (message) {
          e.preventDefault();
          links.open(message);
          return;
        }
        if (/^(https?:|mailto:)/i.test(href)) {
          link.target = "_blank";
          link.rel = "noreferrer";
          return;
        }
        e.preventDefault();
        if (href && !href.startsWith("#")) {
          // Separate the location before decoding so escaped # and : in a
          // filename remain part of its path. Retain the existing column form.
          const location =
            /#L(-?\d+).*$/i.exec(href) || /:(-?\d+)(?::\d+)?$/.exec(href);
          let path = (location ? href.slice(0, location.index) : href).replace(
            /^file:\/\//i,
            "",
          );
          try {
            path = decodeURIComponent(path);
          } catch {
            /* Keep malformed paths visible to the artifact endpoint. */
          }
          onFile?.(path, location ? Number(location[1]) : undefined);
        }
      }}
    />
  );
}
export function itemText(item: NativeItem): string {
  if (item.type === "userMessage")
    return item._yuzunoInputText !== undefined ? userRequestText(item) : (item.content || [])
      .map((c) => c.text || (c.type === "image" ? "[Image]" : ""))
      .join("\n");
  if (item.type === "claudeToolUse" || item.type === "opencodeTool")
    return `${String(item.name || "Tool")}\n${JSON.stringify(item.input, null, 2)}\n${typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "", null, 2)}`;
  if (item.type === "commandExecution")
    return `$ ${item.command || ""}\n${item.aggregatedOutput || ""}`;
  if (item.type === "fileChange")
    return (item.changes || [])
      .map((c) => `${c.path}\n${c.diff || ""}`)
      .join("\n");
  if (item.type === "reasoning") return (item.summary || []).join("\n");
  const { _yuzunoTruncated: _, ...shown } = item;
  return item.text || JSON.stringify(shown, null, 2);
}
/** The Turn as text, with every trimmed tool field fetched in full first. */
export function copyTurnText(agentId: string, turn: NativeTurn): string | Promise<string> {
  return turn._yuzunoSlice || turn.items.some(item => isTruncated(item) || item.type === "historyPreview")
    ? fullTurn(agentId, turn).then(turnText) : turnText(turn);
}
export function turnText(turn: NativeTurn) {
  const firstUser = turn.items.find(item => item.type === "userMessage");
  return [
    ...(turn._yuzunoSource === "native" ? [nativeTurnLabel(turn)] : []),
    ...turn.items.map(
      (i) =>
        `${i.type === "userMessage" ? (isPeerInput(turn, i, firstUser) ? "Workspace mailbox" : isBriefReminder(turn, i, firstUser) ? "Yuzuno reminder" : "You") : i.type === "agentMessage" ? "Agent" : i.type}\n${itemText(i)}`,
    ),
  ].join("\n\n");
}
export function isPeerInput(turn: NativeTurn, item: NativeItem, firstUser?: NativeItem) {
  return item._yuzunoSource === "peer" || (turn._yuzunoSource === "peer" && item === firstUser);
}
/**
 * A message of this conversation for Send to Agent (T-152), with who wrote it,
 * or null for anything that is not a message. `selected` is a selection from it.
 */
export function messageHandoff(
  agent: Agent,
  turn: NativeTurn,
  item: NativeItem,
  selected?: string,
): HandoffSource | null {
  if (item.type !== "userMessage" && item.type !== "agentMessage") return null;
  const firstUser = turn.items.find(i => i.type === "userMessage");
  const author: MessageAuthor =
    item.type === "agentMessage" ? { kind: "agent" }
      : isPeerInput(turn, item, firstUser) ? { kind: "mailbox" }
      : isBriefReminder(turn, item, firstUser) ? { kind: "reminder" }
      : { kind: "user" };
  return {
    kind: "message",
    agentId: agent.id,
    agentName: agent.name,
    turnId: turn.id,
    itemId: item.id,
    author,
    at: item._yuzunoTime?.at ?? null,
    text: selected ?? (item.type === "agentMessage" ? item.text || "" : author.kind === "user" ? userText(item) : itemText(item)),
    excerpt: selected !== undefined,
  };
}
/** Yuzuno's own prompt asking an Agent to update its Project Brief (T-85). */
export function isBriefReminder(turn: NativeTurn, item: NativeItem, firstUser?: NativeItem) {
  return item._yuzunoSource === "brief-reminder" || (turn._yuzunoSource === "brief-reminder" && item === firstUser);
}
/** What started a Claude turn that is not shown as a reply to your message. */
export function nativeTurnLabel(turn: NativeTurn) {
  if (turn._yuzunoUnmatched) return "Claude output not matched to a message";
  // A prompt Yuzuno never sent, found in Claude's saved history on reconnect
  // (sent in a terminal resuming the session, for one).
  if (turn._yuzunoOrigin === "outside") return "Sent outside Yuzuno · from Claude's saved history";
  return turn._yuzunoOrigin === "task-notification"
    ? "Claude continued after a background task finished"
    : "Claude continued on its own";
}
const fieldNouns: Record<string, string> = {
  aggregatedOutput: "output", output: "output", result: "result", changes: "diff",
  input: "input", command: "command", arguments: "arguments",
};
/** What a trimmed Item's preview leaves out, and the request for the rest. */
function TruncationNotice({ view }: { view: FullItemView }) {
  if (!view.truncated || (view.expanded && !view.loading && !view.updating && !view.error)) return null;
  const fields = Object.entries(view.truncated);
  const nouns = [...new Set(fields.map(([name]) => fieldNouns[name] || "details"))];
  const what = nouns.length <= 2 ? nouns.join(" and ") : "details";
  const size = formatBytes(fields.reduce((total, [, field]) => total + field.bytes, 0));
  const ends = new Set(fields.map(([, field]) => field.keep));
  const part = ends.size > 1 ? "part" : ends.has("tail") ? "the end" : "the start";
  return (
    <div className="truncation-notice" role={view.error ? "alert" : "status"}>
      <span>
        {view.error
          ? `Could not load the full ${what}: ${view.error}`
          : view.loading
            ? `Loading the full ${what}…`
            : view.updating
              ? `Updating the full ${what}…`
              : `Truncated · showing ${part} of the ${what}.`}
      </span>
      {(!view.expanded || view.error) && (
        <button type="button" className="inline-link" onClick={view.expand}>
          {view.error ? "Try again" : `Show full ${what} (${size})`}
        </button>
      )}
      {(view.loading || view.updating) && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
    </div>
  );
}
/** Explicit, disposable plain-text original. One text node avoids a huge
 * Markdown/structured item recreating thousands of DOM nodes on expansion. */
function HistoryPreview({ item, agentId, turnId }: { item: NativeItem; agentId: string; turnId: string }) {
  const [open, setOpen] = useState(false);
  const [original, setOriginal] = useState<NativeItem | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) { setOriginal(null); return; }
    const controller = new AbortController();
    setError("");
    api<NativeItem>(`/agents/${encodeURIComponent(agentId)}/items/${encodeURIComponent(item.id)}/original?${new URLSearchParams({turnId})}`, {signal:controller.signal})
      .then(setOriginal, e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [open, agentId, turnId, item.id]);
  return <div className="history-item-preview" data-item-id={item.id} id={`item-${item.id}`} tabIndex={-1}>
    <p>Large item · preview</p>
    <pre>{item.text || "Open the original to read this item."}</pre>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild><button className="inline-link">View full original</button></Dialog.Trigger>
      <Dialog.Portal><Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal history-original-dialog">
          <div className="modal-heading"><Dialog.Title>Full original</Dialog.Title>
            <Dialog.Close aria-label="Close original" className="icon-button"><X size={18} /></Dialog.Close></div>
          <Dialog.Description>Complete saved item as plain text. Select and copy within this view.</Dialog.Description>
          {error ? <p role="alert">{error}</p> : original ? <pre tabIndex={0}>{itemText(original)}</pre> : <p role="status">Loading original…</p>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
function ToolItem({
  item: preview,
  agentId,
  turnId,
  onFile,
  executionUnconfirmed,
}: {
  item: NativeItem;
  agentId: string;
  turnId: string;
  onFile: (path: string, line?: number) => void;
  executionUnconfirmed: boolean;
}) {
  const view = useFullItem(agentId, turnId, preview);
  const [opened, setOpened] = useConversationDisclosure(`tool:${turnId}:${preview.id}`, false);
  const item = view.item;
  const notice = <TruncationNotice view={view} />;
  if (item.type === "claudeToolUse") return <ClaudeTool item={item} notice={notice} opened={opened} onOpenChange={setOpened} unconfirmed={executionUnconfirmed && /inProgress|running/.test(item.status || "")} />;
  if (item.type === "opencodeTool") return <OpenCodeTool item={item} notice={notice} opened={opened} onOpenChange={setOpened} unconfirmed={executionUnconfirmed && /inProgress|running/.test(item.status || "")} />;
  const isCommand = item.type === "commandExecution";
  const isFile = item.type === "fileChange";
  const unconfirmed = executionUnconfirmed && /inProgress|running/.test(item.status || "");
  const running = !executionUnconfirmed && /inProgress|running/.test(item.status || "");
  const label = isCommand
    ? item.command
    : isFile
      ? `${item.changes?.length || 0} file ${(item.changes?.length || 0) === 1 ? "change" : "changes"}`
      : item.type === "reasoning"
        ? "Reasoning summary"
        : item.type.replace(/([A-Z])/g, " $1");
  return (
    <details className="tool-item" id={`item-${item.id}`} data-running={running || undefined}
      open={opened} onToggle={event => {
        if (event.target === event.currentTarget && event.currentTarget.open !== opened) setOpened(event.currentTarget.open);
      }}>
      <summary>
        <ChevronRight size={12} />
        {isCommand ? <SquareTerminal size={14} /> : <FileCode2 size={14} />}
        <span>{label}</span>
        <span className="tool-result" title={unconfirmed ? "Last reported as running; the current tool state has not been confirmed." : undefined}>
          {item.exitCode != null ? `exit ${item.exitCode}` : unconfirmed ? "Unconfirmed" : item.status || ""}
        </span>
      </summary>
      <div className="tool-content">
        {notice}
        {isFile ? (
          <>
            {item.changes?.map((c, index) => (
              <div key={c.path}>
                <button className="inline-link" onClick={() => onFile(c.path)}>
                  {c.path}
                  <ArrowUpRight size={12} />
                </button>
                <pre>
                  {c.diff ||
                    (item._yuzunoTruncated?.changes?.cutDiffs?.includes(index)
                      ? "Not in the preview. Show the full diff to see this file’s changes."
                      : "File changed; no diff supplied.")}
                </pre>
              </div>
            ))}
            {!!item._yuzunoTruncated?.changes?.omitted && (
              <p className="truncation-notice">
                {item._yuzunoTruncated.changes.omitted} more{" "}
                {item._yuzunoTruncated.changes.omitted === 1 ? "file is" : "files are"} not in the preview.
              </p>
            )}
          </>
        ) : (
          <pre>
            {isCommand
              ? item.aggregatedOutput || "No output yet."
              : itemText(item)}
          </pre>
        )}
      </div>
    </details>
  );
}

/** A run of tool calls between messages. `live`: it arrived while the turn
 * was on screen; see tool-motion.ts for how it moves. */
function ToolActivity({
  items,
  calls,
  open,
  forceMount,
  running,
  active,
  live,
  agentId,
  turnId,
  onFile,
  executionUnconfirmed,
}: {
  items: NativeItem[];
  /** Claude sub-agents' calls, shown under their Agent call in `items`. */
  calls?: NativeItem[];
  open: boolean;
  forceMount: boolean;
  running: boolean;
  active: boolean;
  live: boolean;
  agentId: string;
  turnId: string;
  onFile: (path: string, line?: number) => void;
  executionUnconfirmed: boolean;
}) {
  const block = useRef<HTMLDetailsElement>(null);
  const key = `tools:${turnId}:${items[0]?.id}`;
  const [opened, setOpened] = useConversationDisclosure(key, open);
  const firstMount = useFirstConversationMount(key);
  const target = useConversationTarget(turnId);
  const windowed = useConversationWindowed();
  const shownTarget = shownItemId({ kind: "tools", items, calls }, target?.itemId);
  const revealing = !!shownTarget;
  useLayoutEffect(() => {
    // Commit the disclosure choice before App clears the navigation hint.
    // Native `toggle` is queued and may otherwise arrive after row removal.
    if (revealing) setOpened(true);
  }, [revealing]);
  const [visited, setVisited] = useState(open || forceMount);
  const mounted = opened || forceMount || (!windowed && visited);
  useToolMotion(
    block,
    live && firstMount,
    [active, executionUnconfirmed, ...items.map((item) => `${item.id}:${item.status}:${item.exitCode}`)].join("|"),
    mounted,
    items.map(item => `item-${item.id}`),
  );
  return (
    <details ref={block} className="execution tool-activity" open={opened}
      onToggle={(event) => {
        if (event.target === event.currentTarget && event.currentTarget.open !== opened) setOpened(event.currentTarget.open);
        if (event.target === event.currentTarget && event.currentTarget.open) setVisited(true);
      }}>
      <summary>
        <ChevronRight size={13} />
        <span className="tool-activity-label">{active ? "Running tools" : "Tool activity"}</span>
        <span className="execution-count tool-counts">
          {toolActivityCounts(items).map(({ key, label, count }) => (
            <span className="tool-count" key={key} data-count-key={key}>
              <span>{label}</span><span className="tool-count-number">×{count}</span>
            </span>
          ))}
        </span>
        {/* Held in place while the turn runs, so it can fade as tools finish. */}
        {running && (
          <span className="tool-spinner" data-on={active || undefined}>
            <LoaderCircle size={12} className={active ? "spin" : undefined} />
          </span>
        )}
      </summary>
      <div className="execution-items">
        {mounted && <ConversationRows id={key} items={items} itemKey={item => item.id}
          estimate={() => 44} targetKey={shownTarget}>
          {item => <ToolItem key={item.id} item={item} agentId={agentId} turnId={turnId} onFile={onFile}
            executionUnconfirmed={executionUnconfirmed} />}
        </ConversationRows>}
      </div>
    </details>
  );
}
export function Turn({
  turn,
  index,
  agent,
  onFile,
  onAnswer,
  onRewindDraft,
  onOpenQuestion,
  questionSources,
  receipts,
  onResultInteract,
  sourceItemId,
  pendingToolIds,
  highlightSource,
  isLatestAgentTurn = false,
  loadedNumbering = false,
  timeMarks,
  backgroundShells,
}: {
  turn: NativeTurn;
  index: number;
  agent: Agent;
  onFile: (path: string, line?: number) => void;
  onAnswer?: (text: string) => void;
  onRewindDraft?: (agentId: string, text: string) => void;
  onOpenQuestion?: (source: QuestionSource) => void;
  questionSources?: ReadonlySet<string>;
  receipts?: MessageReceipt[];
  onResultInteract?: () => void;
  sourceItemId?: string;
  pendingToolIds?: ReadonlySet<string>;
  highlightSource?: boolean;
  isLatestAgentTurn?: boolean;
  loadedNumbering?: boolean;
  /** Minute marks for the whole conversation, from conversationTimeMarks. */
  timeMarks?: ReadonlyMap<string, Moment>;
  /** Shown only on the latest agent turn. */
  backgroundShells?: BackgroundShells | null;
}) {
  // Set once the turn is on screen: tool blocks that arrive after that are
  // live and unfold into place.
  const drawn = useRef(false);
  // Images in your messages can be marked up, the message named as their
  // source (T-167, T-166).
  const pointFix = usePointFix();
  const links = useMessageLinks();
  const target = useConversationTarget(turn.id);
  const windowed = useConversationWindowed();
  useEffect(() => { drawn.current = true; }, []);
  const plan = turn._yuzunoPlan;
  const planSourceId = `yuzuno-plan-${turn.id}`;
  const [planOpen, setPlanOpen] = useConversationDisclosure(`plan:${turn.id}`, false);
  const revealingPlan = target?.itemId === planSourceId;
  useLayoutEffect(() => { if (revealingPlan) setPlanOpen(true); }, [revealingPlan]);
  const firstUser = turn.items.find((item) => item.type === "userMessage");
  const ordered = conversationBlocks(turn.items);
  const firstAgent = ordered.findIndex((block) => block.kind !== "user");
  const userPrefix = firstAgent < 0 ? ordered : ordered.slice(0, firstAgent);
  const blocks = firstAgent < 0 ? [] : ordered.slice(firstAgent);
  const targetBlock = target?.itemId && blocks.find(block => shownItemId(block, target.itemId));
  const lastMessage = blocks.reduce(
    (last, block, i) => block.kind === "message" ? i : last, -1,
  );
  const running = /inProgress|running/.test(turn.status);
  const timeOf = (item: NativeItem) => timeMarks?.get(timeMarkKey(turn.id, item.id));
  const footer = running ? [] : turnFooter(turn, isLatestAgentTurn ? backgroundShells : null);
  const footerAt = blocks.reduce(
    (last, block, i) => block.kind === "message" && block.item.phase !== "commentary" ? i : last, -1,
  );
  const activity = agent.status === "waiting"
    ? { state: "waiting", label: "Waiting for you", detail: "A response is needed to continue." }
    : ["offline", "error", "uncertain"].includes(agent.status)
      ? { state: "uncertain", label: "Check status", detail: "Execution status needs confirmation." }
      : agent.status === "working" && isCompacting(turn)
        ? { state: "compacting", label: "Compacting", detail: "Condensing the conversation context." }
        : { state: "working", label: "Working", detail: "Still working on this turn." };
  const agentLabel = (
    <div className="message-label">
      <Avatar agent={agent} small />
      {agent.name}
      <span className="message-harness">{agentHarnessName(agent)}</span>
      {running && (
        <span className="working-caption">
          <span className={`status-dot ${activity.state === "compacting" ? "working" : activity.state}`} />
          {activity.label}
        </span>
      )}
    </div>
  );
  const userMessage = (item: NativeItem) => (
    <div
      className={`user-message${sourceItemId === item.id ? " source-highlight" : ""}`}
      key={item.id}
      data-item-id={item.id}
      tabIndex={-1}
    >
      {isPeerInput(turn, item, firstUser) ? (
        <MailboxNotice snapshot={item._yuzunoMailbox ?? (item === firstUser ? turn._yuzunoMailbox : undefined)}
          text={itemText(item)} time={<MessageTime mark={timeOf(item)} />} />
      ) : isBriefReminder(turn, item, firstUser) ? (
        <>
          <div className="message-label brief-reminder-label">
            <span className="you-avatar"><BellRing size={13} /></span>Yuzuno reminder
            <MessageTime mark={timeOf(item)} />
          </div>
          <div className="user-text brief-reminder-text">{itemText(item)}</div>
        </>
      ) : (
        <>
          <div className="message-label">
            <span className="you-avatar">Y</span>You
            <MessageTime mark={timeOf(item)} />
            {item._yuzunoDelivery && (
              <small role="status" className="message-delivery">
                {item._yuzunoDelivery === "queued"
                  ? `Sent · waiting for ${agentHarnessName(agent)} to confirm`
                  : `Not confirmed by ${agentHarnessName(agent)} · not sent again`}
              </small>
            )}
            {agent.harness === "claude" && item.nativeUuid && !item._yuzunoDelivery && (
              <ClaudeCheckpointButton agent={agent} nativeUuid={item.nativeUuid} turnRunning={running} />
            )}
            <SendToAgentButton source={() => messageHandoff(agent, turn, item)} />
            <CopyLinkButton agent={agent} turnId={turn.id} itemId={item.id} />
          </div>
          <div className="user-text"><MessageContent text={userText(item)} blocks={item._yuzunoTextBlocks} /></div>
          <ImageAttachments images={messageImages(item.content)} onAnnotate={!pointFix ? undefined : ((image) => pointFix({
            name: image.name || "Image",
            ownerId: agent.id,
            provenance: `an image in your message to ${agent.name}${links?.href(agent, turn.id, item.id) ? ` (${links.href(agent, turn.id, item.id)})` : ""}`,
            load: async (signal) => {
              const response = await fetch(inputImageUrl(image.agentId, image.id), { signal });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              return response.blob();
            },
          }))} />
        </>
      )}
    </div>
  );
  return (
    <article
      className={`turn${highlightSource ? " source-highlight" : ""}`}
      id={`turn-${turn.id}`}
      data-turn-id={turn.id}
      tabIndex={-1}
      onDragStart={event => {
        // Selected text dragged out of one message also carries where it came
        // from, so an Agent in the rail can take it (T-152). The text the
        // browser drags is left as it is.
        if (event.dataTransfer.types.includes(HANDOFF_TYPE)) return;
        const selection = window.getSelection();
        const text = selection?.toString() || "";
        if (!selection || !text.trim()) return;
        const message = (node: Node | null) =>
          (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-item-id]");
        const from = message(selection.anchorNode);
        if (!from || from !== message(selection.focusNode) || !event.currentTarget.contains(from)) return;
        const item = turn.items.find(i => i.id === from.dataset.itemId);
        const source = item && messageHandoff(agent, turn, item, text);
        if (source) startHandoffDrag(event, source);
      }}
    >
      <div className="turn-divider">
        <span>{loadedNumbering ? "LOADED TURN" : "TURN"} {String(index + 1).padStart(2, "0")}</span>
        <div />
        <CopyButton text={() => copyTurnText(agent.id, turn)} label="Copy turn" />
      </div>
      {turn._yuzunoSource === "native" && (
        <div className="user-message native-turn-notice">
          <span className="message-label">
            <span className="you-avatar"><RefreshCw size={13} /></span>
            {nativeTurnLabel(turn)}
          </span>
        </div>
      )}
      <ConversationRows id={`users:${turn.id}`} items={userPrefix}
        itemKey={block => "item" in block ? block.item.id : block.items[0].id}
        estimate={() => 120} targetKey={target?.itemId}>
        {block => block.kind === "user" && userMessage(block.item)}
      </ConversationRows>
      <div className="agent-message">
        {agentLabel}
        {!!plan?.length && (
          <details className="execution" open={planOpen || revealingPlan}
            onToggle={event => {
              if (event.target === event.currentTarget && event.currentTarget.open !== planOpen)
                setPlanOpen(event.currentTarget.open);
            }}>
            <summary>
              <ChevronRight size={13} />
              <span>Agent plan</span>
              <span className="execution-count">
                {plan.filter((step) => step.status === "completed").length}/{plan.length} steps
              </span>
            </summary>
            {(!windowed || planOpen || revealingPlan) && <div
              id={`item-${planSourceId}`}
              data-item-id={planSourceId}
              tabIndex={-1}
              className={`execution-items${sourceItemId === planSourceId ? " source-highlight" : ""}`}
            >
              <div role="list" aria-label="Plan recorded by the agent">
                <ConversationRows id={`plan:${turn.id}`} items={plan} itemKey={(_, index) => String(index)}
                  estimate={() => 36} targetKey={revealingPlan ? String(Math.max(0, plan.findIndex(step => step.status === "inProgress"))) : undefined}>
                {(step, stepIndex) => (
                  <div role="listitem" aria-posinset={stepIndex + 1} aria-setsize={plan.length} data-plan-status={step.status}>
                    {step.step}{" "}
                    <small>
                      · {step.status === "inProgress" ? "In progress" : step.status === "completed" ? "Done" : "To do"}
                    </small>
                  </div>
                )}</ConversationRows>
              </div>
            </div>}
          </details>
        )}
        <ClaudeSubAgentScope agentId={agent.id} turn={turn} live={agent.connectionState === "connected"}>
        <ConversationRows id={`blocks:${turn.id}`} items={blocks}
          itemKey={block => "item" in block ? block.item.id : block.items[0].id}
          estimate={block => block.kind === "tools" ? 70 : block.kind === "subagents" ? 0 : 220}
          targetKey={targetBlock ? ("item" in targetBlock ? targetBlock.item.id : targetBlock.items[0].id) : undefined}>
        {(block, blockIndex) => {
          if (block.kind === "user") return userMessage(block.item);
          if (block.kind === "preview") return <HistoryPreview item={block.item} agentId={agent.id} turnId={turn.id} />;
          // Sub-agents show in the left dock and leave only anchors here, so
          // the Agent's label goes with the first block people can see.
          const seen = blocks.slice(0, blockIndex).filter((b) => b.kind !== "subagents");
          const continuedLabel = block.kind !== "subagents" && seen.at(-1)?.kind === "user" ? agentLabel : null;
          if (block.kind === "subagents") {
            return <SubAgentAnchors key={`subagents-${block.items[0].id}`} turnId={turn.id} items={block.items} />;
          }
          if (block.kind === "tools") {
            const active =
              running &&
              activity.state === "working" &&
              block.items.some((item) =>
                /inProgress|running/.test(item.status || ""),
              );
            return (
              <Fragment key={block.items[0].id}>
                {continuedLabel}
                <ToolActivity
                  items={block.items}
                  calls={block.calls}
                  open={isLatestAgentTurn && blockIndex > lastMessage}
                  forceMount={!!shownItemId(block, windowed ? target?.itemId : sourceItemId) || blockItems(block).some((item) => pendingToolIds?.has(item.id))}
                  running={running}
                  active={active}
                  live={drawn.current}
                  agentId={agent.id}
                  turnId={turn.id}
                  onFile={onFile}
                  executionUnconfirmed={!running || activity.state === "uncertain"}
                />
              </Fragment>
            );
          }
          const item = block.item;
          const commentary = item.phase === "commentary";
          return (
            <Fragment key={item.id}>
              {continuedLabel}
              <div
                data-item-id={item.id}
                tabIndex={-1}
                className={`${commentary ? "commentary" : "final-message"}${sourceItemId === item.id ? " source-highlight" : ""}`}
              >
                <MessageTime mark={timeOf(item)} className="agent-message-time" />
                {item.delivery === "async" && item.questions?.length ? (
                  <QuestionAnchor item={item} historical={turn._yuzunoImportedQuestions} registered={!!questionSources?.has(questionKey({ turnId: turn.id, itemId: item.id }))} onOpen={onOpenQuestion && (() => onOpenQuestion({ turnId: turn.id, itemId: item.id }))} receipt={receipts?.slice().reverse().find((r) => r.input.question?.turnId === turn.id && r.input.question.itemId === item.id)} />
                ) : (
                  <AgentReply text={item.text || ""} complete={!running || activity.state === "uncertain" || item.text === item._yuzunoCompletedText} source={{ agentId: agent.id, turnId: turn.id, item }} identity={JSON.stringify([agent.id, turn.id, item.id])} onFile={onFile} onDraft={onAnswer} onInteract={onResultInteract} />
                )}
                {item._yuzunoUnsaved && (
                  <small role="note" className="message-delivery">Shown as it streamed · Claude never saved this reply, so it may be incomplete</small>
                )}
                {!running && !commentary && (blockIndex === footerAt ? (
                  <div className="reply-actions">
                    <CopyButton text={item.text || ""} label="Copy reply" />
                    <SendToAgentButton source={() => messageHandoff(agent, turn, item)} />
                    <CopyLinkButton agent={agent} turnId={turn.id} itemId={item.id} />
                    <TurnFooter parts={footer} />
                    <RewindButton agent={agent} turn={turn} onDraft={onRewindDraft} />
                  </div>
                ) : (
                  <>
                    <CopyButton text={item.text || ""} label="Copy reply" />
                    <SendToAgentButton source={() => messageHandoff(agent, turn, item)} />
                    <CopyLinkButton agent={agent} turnId={turn.id} itemId={item.id} />
                  </>
                ))}
              </div>
            </Fragment>
          );
        }}</ConversationRows>
        </ClaudeSubAgentScope>
        <TurnResults agentId={agent.id} turn={turn} onFile={onFile} onDraft={onAnswer} onInteract={onResultInteract} />
        {running && (
          <div
            className="turn-activity"
            data-state={activity.state}
            role="status"
            title={activity.detail}
          >
            {activity.state === "working" || activity.state === "compacting" ? (
              <span className="activity-yuzu" aria-hidden="true">
                <Yuzu size={17} />
                <span className="activity-twinkle">✦</span>
              </span>
            ) : (
              <MessageSquare size={13} aria-hidden="true" />
            )}
            <strong>{activity.label}</strong>
            {(activity.state === "working" || activity.state === "compacting") && (
              <ActivityElapsed startedAt={activityStartedAt(turn, activity.state)} />
            )}
          </div>
        )}
        {turn.error != null && (
          <div role="alert" className="inline-error">
            {/* Core records a turn's error as {message}. */}
            {typeof (turn.error as { message?: unknown }).message === "string"
              ? (turn.error as { message: string }).message
              : errorText(turn.error)}
          </div>
        )}
        {turn.status === "interrupted" && (
          <div className="turn-interrupted">
            Turn interrupted · the conversation is still here.
          </div>
        )}
        {footerAt < 0 && !running && (
          <div className="turn-footer-standalone reply-actions">
            <TurnFooter parts={footer} />
            <RewindButton agent={agent} turn={turn} onDraft={onRewindDraft} />
          </div>
        )}
      </div>
    </article>
  );
}

/** `permissionMode` is the mode the live Claude session reports. */
export function PendingCard(props: { request: PendingRequest; refresh: () => void; disabled: boolean; highlightSource?: boolean; onViewChanges: () => void; permissionMode?: string | null }) {
  if (props.request.method === "claude/canUseTool") return <ClaudePermission {...props} />;
  if (props.request.method.startsWith("opencode/")) return <OpenCodeRequest {...props} />;
  return <CodexPendingCard {...props} />;
}

function CodexPendingCard({
  request,
  refresh,
  disabled,
  highlightSource,
  onViewChanges,
}: {
  request: PendingRequest;
  refresh: () => void;
  disabled: boolean;
  highlightSource?: boolean;
  onViewChanges: () => void;
}) {
  const [sending, setSending] = useState(false);
  // Set before the first await, so a second click in the same moment finds
  // it; kept after a delivered answer until the harness resolves the request.
  const answering = useRef(false);
  const [answered, setAnswered] = useState(false);
  const unconfirmedAnswer = useUnconfirmedAnswer(refresh, answering);
  // Core answers 200 only once it has recorded the reply as sent, so the
  // card says so at once instead of waiting for a refetch to bring it.
  const responseSent = !!request.params._responseSent || answered;
  disabled = disabled || !!request.stale || responseSent || unconfirmedAnswer.unconfirmed;
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = request.params.questions as
    | {
        id: string;
        header?: string;
        question: string;
        options?: { label: string; description: string }[];
        isSecret?: boolean;
      }[]
    | undefined;
  const approval = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ].includes(request.method);
  const decisions = (request.params.availableDecisions || [
    "accept",
    "decline",
    "cancel",
  ]) as unknown[];
  const canDecide = (decision: string) => decisions.includes(decision);
  const visibleParams = Object.fromEntries(
    Object.entries(request.params).filter(([key]) => !key.startsWith("_")),
  );
  // A direct sub-agent of this Agent asks (Core checked Codex's record);
  // the answer goes to the sub-agent's own request only.
  const subAgent = request.params._subAgent as
    | { threadId?: string; path?: string | null }
    | undefined;
  const childChanges = request.params._changes as
    | {
        changes?: { path?: string; kind?: { type?: string }; diff?: string; truncated?: boolean }[];
        omitted?: number;
      }
    | undefined;
  const respond = async (response: unknown) => {
    if (disabled || answering.current) return;
    answering.current = true;
    setSending(true);
    setError("");
    try {
      await respondToRequest(request.id, response);
      setAnswered(true);
      refresh();
    } catch (e) {
      if (!unconfirmedAnswer.noReply(e)) answering.current = false;
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };
  return (
    <section
      className={`pending-card${highlightSource ? " source-highlight" : ""}`}
      id={`request-${request.id}`}
      tabIndex={-1}
    >
      <div className="pending-heading">
        <ShieldCheck size={17} />
        <strong>
          {questions
            ? "A quick question for you"
            : approval
              ? "Your permission is needed"
              : "Input needed"}
        </strong>
        <span className="pending-tag">Needs you</span>
      </div>
      {subAgent && (
        <p className="pending-source">
          From sub-agent <strong>{subAgent.path || "of this Agent"}</strong>.
          Your answer goes only to this sub-agent.
        </p>
      )}
      {request.stale && (
        <p className="inline-error">
          This request is from a previous connection. Reconnect and confirm its
          current state before responding.
        </p>
      )}
      {responseSent && (
        <p className="field-hint">
          Response sent. Waiting for the harness to confirm.
        </p>
      )}
      {questions ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void respond({
              answers: Object.fromEntries(
                questions.map((q) => [
                  q.id,
                  { answers: [answers[q.id] || ""] },
                ]),
              ),
            });
          }}
        >
          {questions.map((q) => (
            <fieldset key={q.id}>
              <legend>{q.question}</legend>
              {q.options?.map((o) => (
                <label className="answer-option" key={o.label}>
                  <input
                    type="radio"
                    name={`${request.id}-${q.id}`}
                    value={o.label}
                    checked={answers[q.id] === o.label}
                    onChange={() =>
                      setAnswers((a) => ({ ...a, [q.id]: o.label }))
                    }
                  />
                  <span>
                    <strong>{o.label}</strong>
                    <small>{o.description}</small>
                  </span>
                </label>
              ))}
              <input
                aria-label={`Your answer: ${q.question}`}
                type={q.isSecret ? "password" : "text"}
                placeholder={
                  q.options?.length
                    ? "Or write your own answer…"
                    : "Your answer…"
                }
                value={
                  q.options?.some((o) => o.label === answers[q.id])
                    ? ""
                    : answers[q.id] || ""
                }
                onChange={(e) =>
                  setAnswers((a) => ({ ...a, [q.id]: e.target.value }))
                }
              />
            </fieldset>
          ))}
          <button
            className="primary-button"
            disabled={
              disabled ||
              sending ||
              questions.some((q) => !answers[q.id]?.trim())
            }
          >
            {sending && <LoaderCircle size={14} className="spin" />}Send answer
          </button>
        </form>
      ) : approval ? (
        <>
          <p>
            {request.params.reason ||
              "Review this action before allowing the agent to continue."}
          </p>
          {request.params.command && (
            <pre>
              {typeof request.params.command === "string"
                ? request.params.command
                : JSON.stringify(request.params.command, null, 2)}
            </pre>
          )}
          {request.params.cwd && (
            <p className="mono-small">{request.params.cwd}</p>
          )}
          {request.method === "item/fileChange/requestApproval" && subAgent ? (
            <div className="file-approval-context">
              {childChanges?.changes?.length ? (
                childChanges.changes.map((change, i) => (
                  <details className="request-details" key={i} open={i === 0}>
                    <summary className="mono-small">
                      {change.kind?.type ? `${change.kind.type} · ` : ""}
                      {change.path}
                    </summary>
                    <pre>{change.diff}</pre>
                    {change.truncated && (
                      <p className="field-hint">This diff is cut here; the sub-agent proposed more.</p>
                    )}
                  </details>
                ))
              ) : (
                <p>
                  The sub-agent did not show its proposed changes to Yuzuno.
                  Decline unless you know what it will change.
                </p>
              )}
              {!!childChanges?.omitted && (
                <p className="field-hint">{childChanges.omitted} more files are not shown.</p>
              )}
              {request.params.grantRoot && (
                <p className="mono-small">Scope: {request.params.grantRoot}</p>
              )}
            </div>
          ) : request.method === "item/fileChange/requestApproval" && (
            <div className="file-approval-context">
              <p>
                Review the proposed file changes in this turn’s execution
                details before approving.
              </p>
              {request.params.grantRoot && (
                <p className="mono-small">Scope: {request.params.grantRoot}</p>
              )}
              {request.params.path && (
                <p className="mono-small">Path: {request.params.path}</p>
              )}
              {request.params.itemId && (
                <button
                  className="inline-link"
                  onClick={onViewChanges}
                >
                  View proposed changes <ArrowUpRight size={12} />
                </button>
              )}
            </div>
          )}
          <details className="request-details">
            <summary>Request details</summary>
            <pre>{JSON.stringify(visibleParams, null, 2)}</pre>
          </details>
          <div className="button-row">
            <button
              className="primary-button"
              disabled={disabled || sending || !canDecide("accept")}
              onClick={() => void respond({ decision: "accept" })}
            >
              Allow once
            </button>
            {canDecide("acceptForSession") && <button className="secondary-button" disabled={disabled || sending} onClick={() => void respond({ decision: "acceptForSession" })}>Allow for this session</button>}
            <button
              className="secondary-button"
              disabled={disabled || sending || !canDecide("decline")}
              onClick={() => void respond({ decision: "decline" })}
            >
              Decline
            </button>
            <button
              className="quiet-button"
              disabled={disabled || sending || !canDecide("cancel")}
              onClick={() => void respond({ decision: "cancel" })}
            >
              {subAgent ? "Cancel sub-agent’s turn" : "Cancel turn"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            This request needs a control that is not available yet. Its contents
            are preserved below.
          </p>
          <pre>{JSON.stringify(visibleParams, null, 2)}</pre>
        </>
      )}
      {error && !(unconfirmedAnswer.unconfirmed && responseSent) && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {unconfirmedAnswer.unconfirmed && !responseSent && (
        <AnswerAgain onClick={() => { setError(""); unconfirmedAnswer.answerAgain(); }} />
      )}
    </section>
  );
}
function ArtifactText({
  text,
  path,
  line,
}: {
  text: string;
  path: string;
  line?: number;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLSpanElement>(null);
  const lines = useMemo(() => (text ? text.split(/\r\n|\n|\r/) : []), [text]);
  const hasLine = line !== undefined;
  const validLine =
    hasLine && Number.isSafeInteger(line) && line >= 1 && line <= lines.length;
  const renderMarkdown = !hasLine && /\.(md|markdown)$/i.test(path);

  useLayoutEffect(() => {
    const container = scroll.current;
    const row = target.current;
    if (!container || !row) return;
    // Scroll only the preview, never the conversation or the document.
    const rowRect = row.getBoundingClientRect();
    const viewRect = container.getBoundingClientRect();
    container.scrollTop +=
      rowRect.top -
      viewRect.top -
      (container.clientHeight - rowRect.height) / 2;
  }, [text, line]);

  return (
    <>
      {hasLine && (
        <p
          className={validLine ? "artifact-location" : "inline-error"}
          role={validLine ? "status" : "alert"}
        >
          {validLine
            ? `Line ${line} of ${lines.length}`
            : lines.length
              ? `Line ${line} is out of range. This file has ${lines.length} lines (1–${lines.length}).`
              : `Line ${line} is out of range. This file is empty (0 lines).`}
        </p>
      )}
      <div className="artifact-content" ref={scroll}>
        {renderMarkdown ? (
          <Prose text={text} />
        ) : (
          <pre
            className="artifact-source"
            aria-label="File source with line numbers"
            style={
              {
                "--line-number-width": `${String(lines.length).length + 3}ch`,
              } as React.CSSProperties
            }
          >
            <code>
              {lines.map((value, index) => {
                const current = validLine && index + 1 === line;
                return (
                  <span
                    key={index}
                    ref={current ? target : undefined}
                    className={`source-line${current ? " source-line-highlight" : ""}`}
                    data-line={index + 1}
                    aria-current={current ? "location" : undefined}
                  >
                    <span className="source-line-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="source-line-text">{value || "\n"}</span>
                  </span>
                );
              })}
            </code>
          </pre>
        )}
      </div>
    </>
  );
}

export function ArtifactModal({
  artifact,
  agentId,
  onClose,
  preview,
  onCloseAutoFocus,
  onAnnotate,
}: {
  artifact: ArtifactPreview | null;
  agentId: string;
  onClose: () => void;
  preview: boolean;
  onCloseAutoFocus?: (event: Event) => void;
  /** Point & Fix (T-167): mark areas on this image. */
  onAnnotate?: () => void;
}) {
  const [content, setContent] = useState<{
    artifact: ArtifactPreview;
    agentId: string;
    text: string;
    error: string;
  } | null>(null);
  const loaded = content?.artifact === artifact && content?.agentId === agentId;
  const text = loaded ? content.text : "";
  const error = loaded ? content.error : "";
  const loading = !!artifact && artifact.kind !== "image" && !loaded;
  useEffect(() => {
    setContent(null);
    if (!artifact || artifact.kind === "image") return;
    if (preview) {
      setContent({
        artifact,
        agentId,
        text: "# A quieter workspace\n\nThis is a **read-only visual specimen**. No file was opened.\n\nYour real agent’s files will appear here, with their source path and turn.",
        error: "",
      });
      return;
    }
    const controller = new AbortController();
    fetch(artifactUrl(agentId, artifact.path), { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.text();
      })
      .then((value) => {
        if (!controller.signal.aborted)
          setContent({ artifact, agentId, text: value, error: "" });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setContent({ artifact, agentId, text: "", error: errorText(e) });
      });
    return () => controller.abort();
  }, [artifact, agentId, preview]);
  return (
    <Modal
      open={!!artifact}
      onOpenChange={(v) => !v && onClose()}
      title={artifact?.name || "File preview"}
      description={
        artifact?.line === undefined
          ? artifact?.path
          : `${artifact.path}:${artifact.line}`
      }
      onCloseAutoFocus={onCloseAutoFocus}
      wide
    >
      {!loading && !error && artifact && artifact.kind !== "image" ? (
        <ArtifactText text={text} path={artifact.path} line={artifact.line} />
      ) : (
        <div className="artifact-content">
          {loading ? (
            <div className="loading-state">
              <LoaderCircle className="spin" />
              Opening file…
            </div>
          ) : error ? (
            <p className="inline-error" role="alert">
              {error}
            </p>
          ) : artifact?.kind === "image" ? (
            <img
              src={artifactUrl(agentId, artifact.path)}
              alt={artifact.name}
            />
          ) : null}
        </div>
      )}
      {artifact?.kind === "image" && onAnnotate && (
        <div className="modal-footer">
          <span>Read-only preview</span>
          <button type="button" className="secondary-button" onClick={onAnnotate}>
            <SquareDashedMousePointer size={14} />
            Mark up
          </button>
        </div>
      )}
      {text && (
        <div className="modal-footer">
          <FileText size={14} />
          <span>Read-only preview</span>
          <CopyButton text={text} label="Copy contents" />
        </div>
      )}
    </Modal>
  );
}
