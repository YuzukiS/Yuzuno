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
import { messageSkills } from "./skill-refs";
import { SkillChips } from "./SkillChips";
import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  ListChecks,
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
import { api, artifactUrl, errorText, NO_ANSWER_REPLY, respondToRequest } from "./api";
import { AnswerAgain, DraftNotSaved, useUnconfirmedAnswer } from "./unconfirmed-answer";
import { useRequestDraft } from "./request-draft";
import { ClaudePermission, ClaudeSubAgentScope, ClaudeTool, PlanText, planTitle } from "./ClaudeControls";
import { OpenCodeRequest, OpenCodeTool } from "./OpenCodeControls";
import { agentHarnessName } from "./machine-checks";
import character from "./assets/yuzu-character.png";
import characterOutline from "./assets/yuzu-character-outline.png";
import { blockItems, conversationBlocks, isCompacting, shownItemId, toolActivityCounts, type ConversationBlock } from "./conversation-blocks";
import { InputReading } from "./input-reading";
import { deliveryNote } from "./delivery-note";
import { SubAgentAnchors } from "./SubAgentPanels";
import { ActivityElapsed } from "./ActivityElapsed";
import { activityStartedAt } from "./activity-time";
import { timeMarkKey, turnFooter, type Moment } from "./conversation-time";
import type { TimeDisplay } from "./time-preferences";
import { MessageTime, TurnFooter } from "./ConversationTime";
import { AgentReply } from "./intelligent-ui/AgentReply";
import { TurnResults } from "./intelligent-ui/TurnResults";
import { formAnswer, SentFormAnswer } from "./intelligent-ui/SentFormAnswer";
import { TurnFiles } from "./portal/TurnFiles";
import { OpenChoice } from "./portal/OpenChoice";
import { htmlFile } from "./portal/html-file";
import { formatBytes, fullTurn, isTruncated, useFullItem, type FullItemView } from "./item-payload";
import { useStreamReveal } from "./stream-reveal";
import { useToolMotion } from "./tool-motion";
import { toolCapsules } from "./tool-capsules";
import { langTag, useLanguage, useStrings } from "./i18n";
import { turnWords, type TurnWords } from "./turn-text";
import { requestWords, shownError } from "./request-text";
import "./tool-activity.css";
import "./input-segments.css";
import { QuestionAnchor } from "./QuestionAnchor";
import { ClaudeCheckpointButton } from "./ClaudeCheckpoint";
import { questionKey } from "./pending-questions";
import type { QuestionSource } from "./types";
import { ConversationRows, useConversationDisclosure, useConversationReveal, useConversationTarget, useFirstConversationMount, useConversationWindowed } from "./ConversationWindow";

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
  lang,
  closeLabel = "Close dialog",
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
  /** The language of its title and close button, when not the page's. */
  lang?: string;
  closeLabel?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${wide ? "modal-wide" : ""} ${className}`.trim()}
          onCloseAutoFocus={onCloseAutoFocus}
          lang={lang}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description>{description}</Dialog.Description>
              )}
            </div>
            <Dialog.Close className="icon-button" aria-label={closeLabel}>
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
  label,
}: {
  /** The text, or a function giving it when clicked (possibly after a fetch). */
  text: string | (() => string | Promise<string>);
  label?: string;
}) {
  const [state, setState] = useState<"ready" | "copying" | "copied" | "error">("ready");
  // The fetch's own error, as it came; worded with the language shown.
  const [problem, setProblem] = useState<string | null>(null);
  const t = useStrings(turnWords);
  const name = label ?? t.copy;
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
          setProblem(failed ? errorText(failed) : null);
          setState("error");
        }
      }}
      title={
        state === "error"
          ? problem !== null ? t.loadFailed(problem) : t.clipboardUnavailable
          : name
      }
    >
      {state === "copied" ? <Check size={13} /> : state === "copying" ? <LoaderCircle size={13} className="spin" /> : <Copy size={13} />}
      <span>
        {state === "copied"
          ? t.copied
          : state === "copying"
            ? t.copyLoading
            : state === "error"
              ? problem !== null ? t.copyFailed : t.copyUnavailable
              : name}
      </span>
    </button>
  );
}
/** Copies the link to one message (T-166), where links are offered. */
function CopyLinkButton({ agent, turnId, itemId }: { agent: Agent; turnId: string; itemId: string }) {
  const href = useMessageLinks()?.href(agent, turnId, itemId);
  const t = useStrings(turnWords);
  return href ? <CopyButton text={href} label={t.copyLink} /> : null;
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
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") return item.review || "";
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
        `${i.type === "userMessage" ? (isPeerInput(turn, i, firstUser) ? "Workspace mailbox" : isBriefReminder(turn, i, firstUser) ? "Yuzuno reminder" : "You") : i.type === "agentMessage" ? "Agent" : i.type === "exitedReviewMode" ? "Codex review" : i.type}\n${itemText(i)}`,
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
  // Codex's review findings are its review Turn's reply.
  const reply = item.type === "agentMessage" || item.type === "exitedReviewMode";
  if (item.type !== "userMessage" && !reply) return null;
  const firstUser = turn.items.find(i => i.type === "userMessage");
  const author: MessageAuthor =
    reply ? { kind: "agent" }
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
    text: selected ?? (item.type === "agentMessage" ? item.text || "" : reply ? item.review || "" : author.kind === "user" ? userText(item) : itemText(item)),
    excerpt: selected !== undefined,
  };
}
/** Yuzuno's own prompt asking an Agent to update its Project Brief (T-85). */
export function isBriefReminder(turn: NativeTurn, item: NativeItem, firstUser?: NativeItem) {
  return item._yuzunoSource === "brief-reminder" || (turn._yuzunoSource === "brief-reminder" && item === firstUser);
}
/** What started a Claude turn that is not shown as a reply to your message. */
export function nativeTurnLabel(turn: NativeTurn, t: TurnWords = turnWords("en")) {
  if (turn._yuzunoUnmatched) return t.unmatched;
  // A prompt Yuzuno never sent, found in Claude's saved history on reconnect
  // (sent in a terminal resuming the session, for one).
  if (turn._yuzunoOrigin === "outside") return t.outside;
  return turn._yuzunoOrigin === "task-notification" ? t.afterTask : t.onItsOwn;
}
// Which noun each trimmed field is, in turnWords' `nouns`.
const fieldNouns: Record<string, string> = {
  aggregatedOutput: "output", output: "output", result: "result", changes: "diff",
  input: "input", command: "command", arguments: "arguments",
};
/** What a trimmed Item's preview leaves out, and the request for the rest. */
function TruncationNotice({ view }: { view: FullItemView }) {
  const t = useStrings(turnWords);
  if (!view.truncated || (view.expanded && !view.loading && !view.updating && !view.error)) return null;
  const fields = Object.entries(view.truncated);
  const nouns = [...new Set(fields.map(([name]) => t.nouns[fieldNouns[name] || "details"]))];
  const what = nouns.length === 2 ? t.and(nouns[0], nouns[1]) : nouns.length === 1 ? nouns[0] : t.nouns.details;
  const size = formatBytes(fields.reduce((total, [, field]) => total + field.bytes, 0));
  const ends = new Set(fields.map(([, field]) => field.keep));
  const part = ends.size > 1 ? t.part.part : ends.has("tail") ? t.part.tail : t.part.head;
  return (
    <div className="truncation-notice" role={view.error ? "alert" : "status"}>
      <span>
        {view.error
          ? t.couldNotLoad(what, view.error)
          : view.loading
            ? t.loadingFull(what)
            : view.updating
              ? t.updatingFull(what)
              : t.truncated(part, what)}
      </span>
      {(!view.expanded || view.error) && (
        <button type="button" className="inline-link" onClick={view.expand}>
          {view.error ? t.tryAgain : t.showFull(what, size)}
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
  const language = useLanguage();
  const t = turnWords(language);
  useEffect(() => {
    if (!open) { setOriginal(null); return; }
    const controller = new AbortController();
    setError("");
    api<NativeItem>(`/agents/${encodeURIComponent(agentId)}/items/${encodeURIComponent(item.id)}/original?${new URLSearchParams({turnId})}`, {signal:controller.signal})
      .then(setOriginal, e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [open, agentId, turnId, item.id]);
  return <div className="history-item-preview" data-item-id={item.id} id={`item-${item.id}`} tabIndex={-1}>
    <p>{t.largeItem}</p>
    <pre>{item.text || t.openOriginal}</pre>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild><button className="inline-link">{t.viewOriginal}</button></Dialog.Trigger>
      <Dialog.Portal><Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal history-original-dialog" lang={langTag(language)}>
          <div className="modal-heading"><Dialog.Title>{t.fullOriginal}</Dialog.Title>
            <Dialog.Close aria-label={t.closeOriginal} className="icon-button"><X size={18} /></Dialog.Close></div>
          <Dialog.Description>{t.originalDescription}</Dialog.Description>
          {/* The item and Core's error are as they came, in no language of the page's. */}
          {error ? <p role="alert" lang="">{error}</p> : original ? <pre tabIndex={0} lang="">{itemText(original)}</pre> : <p role="status">{t.loadingOriginal}</p>}
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
  const t = useStrings(turnWords);
  // A Codex plan is what Plan mode is for: open unless the reader closes it.
  const [opened, setOpened] = useConversationDisclosure(`tool:${turnId}:${preview.id}`, preview.type === "plan");
  const item = view.item;
  const notice = <TruncationNotice view={view} />;
  if (item.type === "plan") return <CodexPlanItem item={item} notice={notice} opened={opened} onOpenChange={setOpened} />;
  if (item.type === "claudeToolUse") return <ClaudeTool item={item} notice={notice} opened={opened} onOpenChange={setOpened} unconfirmed={executionUnconfirmed && /inProgress|running/.test(item.status || "")} />;
  if (item.type === "opencodeTool") return <OpenCodeTool item={item} notice={notice} opened={opened} onOpenChange={setOpened} unconfirmed={executionUnconfirmed && /inProgress|running/.test(item.status || "")} />;
  const isCommand = item.type === "commandExecution";
  const isFile = item.type === "fileChange";
  const unconfirmed = executionUnconfirmed && /inProgress|running/.test(item.status || "");
  const running = !executionUnconfirmed && /inProgress|running/.test(item.status || "");
  const label = isCommand
    ? item.command
    : isFile
      ? t.fileChanges(item.changes?.length || 0)
      : item.type === "reasoning"
        ? t.reasoning
        : item.type === "enteredReviewMode"
          ? t.codexReview(item.review)
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
        <span className="tool-result" title={unconfirmed ? t.unconfirmedTitle : undefined}>
          {item.exitCode != null ? t.exit(item.exitCode) : unconfirmed ? t.unconfirmed : item.status || ""}
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
                    (item._yuzunoTruncated?.changes?.cutDiffs?.includes(index) ? t.notInPreview : t.noDiff)}
                </pre>
              </div>
            ))}
            {!!item._yuzunoTruncated?.changes?.omitted && (
              <p className="truncation-notice">{t.omitted(item._yuzunoTruncated.changes.omitted)}</p>
            )}
          </>
        ) : (
          <pre>
            {isCommand
              ? item.aggregatedOutput || t.noOutput
              : itemText(item)}
          </pre>
        )}
      </div>
    </details>
  );
}

/**
 * Codex's proposed plan (a `plan` Item, from Plan mode), as Markdown with the
 * renderer Claude's plans use. Nothing here acts on it: carrying it out is
 * the user's next message.
 */
function CodexPlanItem({ item, notice, opened, onOpenChange }: {
  item: NativeItem; notice: ReactNode; opened: boolean; onOpenChange: (open: boolean) => void;
}) {
  const text = item.text || "";
  const title = planTitle(text);
  const t = useStrings(turnWords);
  return (
    <details className="tool-item codex-plan" id={`item-${item.id}`} open={opened} onToggle={event => {
      if (event.target === event.currentTarget && event.currentTarget.open !== opened) onOpenChange(event.currentTarget.open);
    }}>
      <summary>
        <ChevronRight size={12} />
        <ListChecks size={14} />
        <span><strong>{t.proposedPlan}</strong>{title ? ` · ${title}` : ""}</span>
      </summary>
      <div className="tool-content">
        {notice}
        <PlanText plan={text} id={`plan-${item.id}`} empty={t.noPlanText} />
      </div>
    </details>
  );
}

/** A run of tool calls between messages. `live`: it arrived while the turn
 * was on screen; see tool-motion.ts for how it moves. */
/** A failed call, said outside the fold that holds it. */
function failedCall(item: NativeItem) {
  return item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
}

/**
 * Mail, reminders, automatic continues and Claude's own inputs, with the
 * tools and sub-agents around them, as one row (T-6): what they are, counted,
 * and closed unless something here is being read, waits for an approval or
 * is the latest work. A failed call is said beside it, folded or not.
 */
function CollaborationFold({ id, members, open, revealing, children }: {
  id: string;
  members: ConversationBlock[];
  open: boolean;
  /** A link or a search leads into it: it stays open once there. */
  revealing: boolean;
  children: React.ReactNode;
}) {
  const t = turnWords(useLanguage());
  const [opened, setOpened] = useConversationDisclosure(id, false);
  useLayoutEffect(() => {
    // Commit the disclosure choice before App clears the navigation hint,
    // as ToolActivity does: the message led to would close again with it.
    if (revealing) setOpened(true);
  }, [revealing]);
  const shown = opened || open || revealing;
  const inputs = members.flatMap((block) => (block.kind === "user" ? [block.item] : []));
  const mails = inputs.filter((item) => item._yuzunoInput === "peer").length;
  const automatic = inputs.length - mails;
  const tools = members.flatMap((block) => (block.kind === "tools" ? block.items : []));
  const failed = tools.filter(failedCall);
  const counts = [mails && t.mails(mails), automatic && t.automatic(automatic), tools.length && t.toolSteps(tools.length)]
    .filter(Boolean).join(" · ");
  return (
    <>
      <details className="execution collaboration-fold" open={shown}
        onToggle={(event) => {
          if (event.target === event.currentTarget && event.currentTarget.open !== shown) setOpened(event.currentTarget.open);
        }}>
        <summary>
          <ChevronRight size={13} />
          <span>{t.collaboration}</span>
          {counts && <span className="execution-count">{counts}</span>}
        </summary>
        {shown && <div className="execution-items collaboration-items">{children}</div>}
      </details>
      {!shown && failed.map((item) => (
        <p key={item.id} className="collaboration-failure" role="note">
          <span aria-hidden="true">✕</span> {t.failedStep} · {String(item.command ?? item.name ?? item.type)}
          {typeof item.exitCode === "number" && ` · ${item.exitCode}`}
          <button type="button" className="inline-link" onClick={() => setOpened(true)}>{t.view}</button>
        </p>
      ))}
    </>
  );
}

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
  const language = useLanguage();
  const t = turnWords(language);
  const key = `tools:${turnId}:${items[0]?.id}`;
  const [opened, setOpened] = useConversationDisclosure(key, open);
  const firstMount = useFirstConversationMount(key);
  const target = useConversationTarget(turnId);
  const reveal = useConversationReveal(turnId);
  const windowed = useConversationWindowed();
  const shownTarget = shownItemId({ kind: "tools", items, calls }, target?.itemId);
  const revealing = !!shownItemId({ kind: "tools", items, calls }, reveal?.itemId);
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
        <span className="tool-activity-label">{active ? t.runningTools : t.toolActivity}</span>
        {/* One capsule per tool, named as the harness named it, with the
            calls' own state; see tool-capsules.ts for what a state means. */}
        <span className="execution-count tool-counts">
          {toolCapsules(toolActivityCounts(items, language), executionUnconfirmed).map(({ key, label, count, state, part }) => (
            <span className="tool-count" key={key} data-count-key={key} data-state={state || undefined}>
              <span className="tool-count-name">{label}</span><span className="tool-count-number">×{count}</span>
              {state && state !== "returned" && <span className="tool-count-state">
                {part < count ? t.toolStatePart(part, t.toolState[state]) : t.toolState[state]}
              </span>}
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
  sendingInTurn,
  onResultInteract,
  sourceItemId,
  pendingToolIds,
  highlightSource,
  isLatestAgentTurn = false,
  loadedNumbering = false,
  timeMarks,
  time,
  backgroundShells,
  inputNumbers,
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
  /** New messages still sending that this Turn shows (delivery-note's
   * `sendingInTurn`): their delivery note is shown here, not as a preview. */
  sendingInTurn?: ReadonlySet<string>;
  onResultInteract?: () => void;
  sourceItemId?: string;
  pendingToolIds?: ReadonlySet<string>;
  highlightSource?: boolean;
  isLatestAgentTurn?: boolean;
  loadedNumbering?: boolean;
  /** Minute marks for the whole conversation, from conversationTimeMarks. */
  timeMarks?: ReadonlyMap<string, Moment>;
  /** How this device writes times, as `timeMarks` were written too. */
  time: TimeDisplay;
  /** Shown only on the latest agent turn. */
  backgroundShells?: BackgroundShells | null;
  /** The number of each of the person's inputs among all of them, by
   * `${turnId}\n${itemId}`, where the inputs read so far say (T-6). */
  inputNumbers?: ReadonlyMap<string, number>;
}) {
  // Set once the turn is on screen: tool blocks that arrive after that are
  // live and unfold into place.
  const drawn = useRef(false);
  // Images in your messages can be marked up, the message named as their
  // source (T-167, T-166).
  const pointFix = usePointFix();
  const links = useMessageLinks();
  const target = useConversationTarget(turn.id);
  const reveal = useConversationReveal(turn.id);
  const windowed = useConversationWindowed();
  const reportInput = useContext(InputReading);
  const readingPlaces = useRef<{ prefix?: [number, -1 | 0 | 1]; blocks?: [number, -1 | 0 | 1] }>({});
  useEffect(() => { drawn.current = true; }, []);
  const plan = turn._yuzunoPlan;
  const planSourceId = `yuzuno-plan-${turn.id}`;
  const [planOpen, setPlanOpen] = useConversationDisclosure(`plan:${turn.id}`, false);
  const revealingPlan = reveal?.itemId === planSourceId;
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
  const language = useLanguage();
  const t = turnWords(language);
  // Reading by your inputs (T-6): each input of yours, or one no record
  // attributes, opens a part of the Turn; mail, reminders, automatic
  // continues and Claude's own inputs fold with the tools around them.
  const yours = (item: NativeItem) => ["you", "home", "form", "answer"].includes(item._yuzunoInput ?? "");
  const unconfirmed = (item: NativeItem) => item._yuzunoInput === "unconfirmed";
  const opener = firstUser && (yours(firstUser) || unconfirmed(firstUser)) ? firstUser : undefined;
  const turnNumber = `${t.turn(!!loadedNumbering)} ${String(index + 1).padStart(2, "0")}`;
  const inputLabel = (item: NativeItem) =>
    unconfirmed(item) ? t.earlierInput : t.yourInput(inputNumbers?.get(`${turn.id}\n${item.id}`) ?? null);
  const inputDivider = (item: NativeItem) => item !== opener && (yours(item) || unconfirmed(item)) ? (
    <div className="turn-divider input-divider">
      <span><span className="input-divider-label">{inputLabel(item)}</span> · {turnNumber} {t.midTurn}</span>
      <div />
    </div>
  ) : null;
  const footer = running ? [] : turnFooter(turn, isLatestAgentTurn ? backgroundShells : null, time, language);
  const footerAt = blocks.reduce(
    (last, block, i) => block.kind === "message" && block.item.phase !== "commentary" ? i : last, -1,
  );
  const activity = agent.status === "waiting"
    ? { state: "waiting", label: t.waiting, detail: t.waitingDetail }
    : ["offline", "error", "uncertain"].includes(agent.status)
      ? { state: "uncertain", label: t.check, detail: t.checkDetail }
      : agent.status === "working" && isCompacting(turn)
        ? { state: "compacting", label: t.compacting, detail: t.compactingDetail }
        : { state: "working", label: t.working, detail: t.workingDetail };
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
  // The receipt a message was sent with, by the client ID Core restores on
  // it (or a new Claude Turn names before it is confirmed).
  const receiptOf = (item: NativeItem) => {
    const id = typeof item.clientId === "string" ? item.clientId : item._yuzunoClientMessageId;
    return id ? receipts?.find((r) => r.input.clientMessageId === id) : undefined;
  };
  const userBody = (item: NativeItem) => {
    const text = userText(item);
    const answer = formAnswer(text, receiptOf(item));
    return answer ? (
      <div className="user-text user-form-answer"><SentFormAnswer agentId={agent.id} answer={answer} text={text} /></div>
    ) : (
      <div className="user-text"><MessageContent text={text} blocks={item._yuzunoTextBlocks} /></div>
    );
  };
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
            <span className="you-avatar"><BellRing size={13} /></span>{t.reminder}
            <MessageTime mark={timeOf(item)} />
          </div>
          <div className="user-text brief-reminder-text">{itemText(item)}</div>
        </>
      ) : (
        <>
          <div className="message-label">
            {unconfirmed(item)
              ? <><span className="you-avatar unconfirmed-avatar" aria-hidden="true">?</span>{t.unconfirmedLabel}</>
              : <><span className="you-avatar">Y</span>{t.you}</>}
            <MessageTime mark={timeOf(item)} />
            {!item.clientId && item._yuzunoClientMessageId && sendingInTurn?.has(item._yuzunoClientMessageId) && (
              <small role="status" className="message-delivery">{deliveryNote("sending", agentHarnessName(agent), null, false, language)}</small>
            )}
            {item._yuzunoDelivery && (
              <small role="status" className="message-delivery">
                {deliveryNote(item._yuzunoDelivery === "queued" ? "queued" : "unknown", agentHarnessName(agent), null, false, language)}
              </small>
            )}
            {agent.harness === "claude" && item.nativeUuid && !item._yuzunoDelivery && (
              <ClaudeCheckpointButton agent={agent} nativeUuid={item.nativeUuid} turnRunning={running} />
            )}
            <SendToAgentButton source={() => messageHandoff(agent, turn, item)} />
            <CopyLinkButton agent={agent} turnId={turn.id} itemId={item.id} />
          </div>
          {userBody(item)}
          {unconfirmed(item) && <p className="unconfirmed-note">{t.unconfirmedNote}</p>}
          <SkillChips skills={messageSkills(item.content)} />
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
  const renderBlock = (block: ConversationBlock, blockIndex: number) => {
          if (block.kind === "user") return <Fragment key={block.item.id}>{inputDivider(block.item)}{userMessage(block.item)}</Fragment>;
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
                  <small role="note" className="message-delivery">{t.unsaved}</small>
                )}
                {!running && !commentary && (blockIndex === footerAt ? (
                  <div className="reply-actions">
                    <CopyButton text={item.text || ""} label={t.copyReply} />
                    <SendToAgentButton source={() => messageHandoff(agent, turn, item)} />
                    <CopyLinkButton agent={agent} turnId={turn.id} itemId={item.id} />
                    <TurnFooter parts={footer} />
                    <RewindButton agent={agent} turn={turn} onDraft={onRewindDraft} />
                  </div>
                ) : (
                  <>
                    <CopyButton text={item.text || ""} label={t.copyReply} />
                    <SendToAgentButton source={() => messageHandoff(agent, turn, item)} />
                    <CopyLinkButton agent={agent} turnId={turn.id} itemId={item.id} />
                  </>
                ))}
              </div>
            </Fragment>
          );
  };
  // Runs of folded blocks become one row; a run of tools and sub-agents
  // alone keeps its own rows, as before.
  const folds = (block: ConversationBlock) => block.kind === "tools" || block.kind === "subagents"
    || (block.kind === "user" && !!block.item._yuzunoInput && !yours(block.item) && !unconfirmed(block.item));
  type Row = { block: ConversationBlock; at: number } | { fold: { block: ConversationBlock; at: number }[] };
  const runs: Row[] = [];
  blocks.forEach((block, at) => {
    const last = runs.at(-1);
    if (folds(block) && last && "fold" in last) last.fold.push({ block, at });
    else runs.push(folds(block) ? { fold: [{ block, at }] } : { block, at });
  });
  const rows = runs.flatMap((row): Row[] => "fold" in row && !row.fold.some(member => member.block.kind === "user")
    ? row.fold.map(member => ({ block: member.block, at: member.at })) : [row]);
  const blockKey = (block: ConversationBlock) => "item" in block ? block.item.id : block.items[0].id;
  const rowKey = (row: Row) => "fold" in row ? `fold:${blockKey(row.fold[0].block)}` : blockKey(row.block);
  const targetRow = targetBlock ? rows.find(row => "fold" in row ? row.fold.some(member => member.block === targetBlock) : row.block === targetBlock) : undefined;
  // The input this Turn is read at (T-6): the last of yours at or before the
  // row at the reading line, by the rows' own positions, in the messages the
  // Turn opens with (userPrefix) and then in its blocks; before any, none.
  const inputOf = (block: ConversationBlock) => block.kind === "user" && (yours(block.item) || unconfirmed(block.item)) ? block.item.id : null;
  const prefixInputs = userPrefix.map(inputOf);
  const inputRows = rows.map(row => "fold" in row ? null : inputOf(row.block));
  const lastInput = (inputs: (string | null)[], at: number, before: string | null) => {
    let input = before;
    for (let index = 0; index <= at; index++) input = inputs[index] ?? input;
    return input;
  };
  // A Turn whose first block is the Agent's still opens with its first input.
  const prefixInput = lastInput(prefixInputs, prefixInputs.length - 1, userPrefix.length ? null : opener?.id ?? null);
  const reportReading = () => {
    const { prefix, blocks: inBlocks } = readingPlaces.current;
    reportInput?.(turn.id, inBlocks && inBlocks[1] >= 0 ? lastInput(inputRows, inBlocks[0], prefixInput)
      : prefix && prefix[1] <= 0 ? lastInput(prefixInputs, prefix[0], null)
      : prefixInput);
  };
  const readPrefix = (block: ConversationBlock, place: -1 | 0 | 1) => {
    readingPlaces.current.prefix = [userPrefix.indexOf(block), place];
    reportReading();
  };
  const readAt = (row: Row, place: -1 | 0 | 1) => {
    readingPlaces.current.blocks = [rows.indexOf(row), place];
    reportReading();
  };
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
        <span>{opener && <><span className="input-divider-label">{inputLabel(opener)}</span> · </>}{turnNumber}</span>
        <div />
        <CopyButton text={() => copyTurnText(agent.id, turn)} label={t.copyTurn} />
      </div>
      {turn._yuzunoSource === "native" && (
        <div className="user-message native-turn-notice">
          <span className="message-label">
            <span className="you-avatar"><RefreshCw size={13} /></span>
            {nativeTurnLabel(turn, t)}
          </span>
        </div>
      )}
      <ConversationRows id={`users:${turn.id}`} items={userPrefix}
        itemKey={block => "item" in block ? block.item.id : block.items[0].id}
        estimate={() => 120} targetKey={target?.itemId}
        onReading={reportInput ? readPrefix : undefined}>
        {block => block.kind === "user" && <>{inputDivider(block.item)}{userMessage(block.item)}</>}
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
              <span>{t.agentPlan}</span>
              <span className="execution-count">
                {t.steps(plan.filter((step) => step.status === "completed").length, plan.length)}
              </span>
            </summary>
            {(!windowed || planOpen || revealingPlan) && <div
              id={`item-${planSourceId}`}
              data-item-id={planSourceId}
              tabIndex={-1}
              className={`execution-items${sourceItemId === planSourceId ? " source-highlight" : ""}`}
            >
              <div role="list" aria-label={t.planList}>
                <ConversationRows id={`plan:${turn.id}`} items={plan} itemKey={(_, index) => String(index)}
                  estimate={() => 36} targetKey={revealingPlan ? String(Math.max(0, plan.findIndex(step => step.status === "inProgress"))) : undefined}>
                {(step, stepIndex) => (
                  <div role="listitem" aria-posinset={stepIndex + 1} aria-setsize={plan.length} data-plan-status={step.status}>
                    {step.step}{" "}
                    <small>
                      · {step.status === "inProgress" ? t.stepInProgress : step.status === "completed" ? t.stepDone : t.stepToDo}
                    </small>
                  </div>
                )}</ConversationRows>
              </div>
            </div>}
          </details>
        )}
        <ClaudeSubAgentScope agentId={agent.id} turn={turn} live={agent.connectionState === "connected"}>
        <ConversationRows id={`blocks:${turn.id}`} items={rows}
          itemKey={rowKey}
          estimate={row => "fold" in row ? 44 : row.block.kind === "tools" ? 70 : row.block.kind === "subagents" ? 0 : 220}
          targetKey={targetRow ? rowKey(targetRow) : undefined}
          onReading={reportInput ? readAt : undefined}>
        {row => "fold" in row ? (
          <CollaborationFold key={rowKey(row)} id={`collab:${turn.id}:${rowKey(row)}`} members={row.fold.map(member => member.block)}
            open={row.fold.some(member => !!shownItemId(member.block, windowed ? target?.itemId : sourceItemId)
              || blockItems(member.block).some(item => pendingToolIds?.has(item.id))
              || (isLatestAgentTurn && member.at > lastMessage))}
            revealing={row.fold.some(member => !!(reveal?.itemId && shownItemId(member.block, reveal.itemId)))}>
            {row.fold.map(member => renderBlock(member.block, member.at))}
          </CollaborationFold>
        ) : renderBlock(row.block, row.at)}</ConversationRows>
        </ClaudeSubAgentScope>
        <TurnResults agentId={agent.id} turn={turn} onFile={onFile} onDraft={onAnswer} onInteract={onResultInteract} />
        {!running && <TurnFiles agent={agent} turn={turn} onSource={onFile} />}
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
            {turn.missingNative ? (
              <>
                {t.endedBy}
                <time dateTime={turn.missingNative.endedAt}>
                  {new Date(turn.missingNative.endedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                </time>
                {t.endedAfter}
              </>
            ) : (
              t.interrupted
            )}
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

type CodexQuestion = {
  id: string;
  header?: string;
  question: string;
  options?: { label: string; description: string }[];
  isSecret?: boolean;
};
/** A saved Codex answer for these questions; a secret one is never read. */
function codexAnswers(saved: unknown, questions: CodexQuestion[]) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
  const value = saved as Record<string, unknown>;
  return Object.fromEntries(questions.flatMap((q) =>
    !q.isSecret && typeof value[q.id] === "string" ? [[q.id, value[q.id] as string]] : []));
}

/** `permissionMode` is the mode the live Claude session reports. `draftScope`
 * is the Workspace whose browser drafts a question card keeps, or null. */
export function PendingCard(props: { request: PendingRequest; refresh: () => void; disabled: boolean; highlightSource?: boolean; onViewChanges: () => void; permissionMode?: string | null; draftScope?: string | null }) {
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
  draftScope = null,
}: {
  request: PendingRequest;
  refresh: () => void;
  disabled: boolean;
  highlightSource?: boolean;
  onViewChanges: () => void;
  draftScope?: string | null;
}) {
  const questions = request.params.questions as CodexQuestion[] | undefined;
  const language = useLanguage();
  const t = requestWords(language);
  // An unsent answer survives a refresh; a secret one is not kept (T-170).
  const draft = useRequestDraft(questions ? draftScope : null, request, (saved) => codexAnswers(saved, questions || []));
  const [sending, setSending] = useState(false);
  // Set before the first await, so a second click in the same moment finds
  // it; kept after a delivered answer until the harness resolves the request.
  const answering = useRef(draft.attempted);
  const [answered, setAnswered] = useState(false);
  const unconfirmedAnswer = useUnconfirmedAnswer(refresh, answering, draft.attempted);
  // Core answers 200 only once it has recorded the reply as sent, so the
  // card says so at once instead of waiting for a refetch to bring it.
  const responseSent = !!request.params._responseSent || answered;
  disabled = disabled || !!request.stale || responseSent || unconfirmedAnswer.unconfirmed;
  const [error, setError] = useState(draft.attempted ? NO_ANSWER_REPLY : "");
  const [answers, setAnswers] = useState<Record<string, string>>(() => draft.initial ?? {});
  const kept = codexAnswers(answers, questions || [])!;
  const keptEmpty = !Object.values(kept).some(Boolean);
  useEffect(() => { draft.save(kept, keptEmpty); }, [answers]);
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
    draft.attempt(true, kept, keptEmpty);
    try {
      await respondToRequest(request.id, response);
      draft.remove();
      setAnswered(true);
      refresh();
    } catch (e) {
      if (!unconfirmedAnswer.noReply(e)) {
        answering.current = false;
        draft.attempt(false, kept, keptEmpty);
      }
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
      lang={langTag(language)}
    >
      <div className="pending-heading">
        <ShieldCheck size={17} />
        <strong>
          {questions ? t.question : approval ? t.permission : t.input}
        </strong>
        <span className="pending-tag">{t.needsYou}</span>
      </div>
      {subAgent && (
        <p className="pending-source">
          {t.fromSubAgent}<strong lang="">{subAgent.path || t.ofThisAgent}</strong>{t.onlySubAgent}
        </p>
      )}
      {request.stale && (
        <p className="inline-error">{t.staleCodex}</p>
      )}
      {responseSent && (
        <p className="field-hint">{t.sentHarness}</p>
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
              <legend lang="">{q.question}</legend>
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
                  <span lang="">
                    <strong>{o.label}</strong>
                    <small>{o.description}</small>
                  </span>
                </label>
              ))}
              <input
                aria-label={t.yourAnswer(q.question)}
                type={q.isSecret ? "password" : "text"}
                placeholder={q.options?.length ? t.ownAnswer : t.answerPlaceholder}
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
          {draft.notSaved && <DraftNotSaved />}
          <button
            className="primary-button"
            disabled={
              disabled ||
              sending ||
              questions.some((q) => !answers[q.id]?.trim())
            }
          >
            {sending && <LoaderCircle size={14} className="spin" />}{t.sendAnswer}
          </button>
        </form>
      ) : approval ? (
        <>
          <p>
            {request.params.reason || t.reviewAction}
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
                      <p className="field-hint">{t.diffCut}</p>
                    )}
                  </details>
                ))
              ) : (
                <p>{t.noChanges}</p>
              )}
              {!!childChanges?.omitted && (
                <p className="field-hint">{t.moreFiles(childChanges.omitted)}</p>
              )}
              {request.params.grantRoot && (
                <p className="mono-small">{t.scope(request.params.grantRoot)}</p>
              )}
            </div>
          ) : request.method === "item/fileChange/requestApproval" && (
            <div className="file-approval-context">
              <p>{t.reviewFiles}</p>
              {request.params.grantRoot && (
                <p className="mono-small">{t.scope(request.params.grantRoot)}</p>
              )}
              {request.params.path && (
                <p className="mono-small">{t.path(request.params.path)}</p>
              )}
              {request.params.itemId && (
                <button
                  className="inline-link"
                  onClick={onViewChanges}
                >
                  {t.viewChanges} <ArrowUpRight size={12} />
                </button>
              )}
            </div>
          )}
          <details className="request-details">
            <summary>{t.details}</summary>
            <pre>{JSON.stringify(visibleParams, null, 2)}</pre>
          </details>
          <div className="button-row">
            <button
              className="primary-button"
              disabled={disabled || sending || !canDecide("accept")}
              onClick={() => void respond({ decision: "accept" })}
            >
              {t.allowOnce}
            </button>
            {canDecide("acceptForSession") && <button className="secondary-button" disabled={disabled || sending} onClick={() => void respond({ decision: "acceptForSession" })}>{t.allowSession}</button>}
            <button
              className="secondary-button"
              disabled={disabled || sending || !canDecide("decline")}
              onClick={() => void respond({ decision: "decline" })}
            >
              {t.decline}
            </button>
            <button
              className="quiet-button"
              disabled={disabled || sending || !canDecide("cancel")}
              onClick={() => void respond({ decision: "cancel" })}
            >
              {subAgent ? t.cancelSub : t.cancelTurn}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{t.noControl}</p>
          <pre>{JSON.stringify(visibleParams, null, 2)}</pre>
        </>
      )}
      {error && !(unconfirmedAnswer.unconfirmed && responseSent) && (
        <p role="alert" className="inline-error">
          {shownError(error, t)}
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
  const t = useStrings(turnWords);

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
            ? t.lineOf(line, lines.length)
            : lines.length
              ? t.lineOut(line, lines.length)
              : t.lineEmpty(line)}
        </p>
      )}
      <div className="artifact-content" ref={scroll} lang="">
        {renderMarkdown ? (
          <Prose text={text} />
        ) : (
          <pre
            className="artifact-source"
            aria-label={t.source}
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
  const language = useLanguage();
  const t = turnWords(language);
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
      title={artifact?.name || t.filePreview}
      description={
        artifact?.line === undefined
          ? artifact?.path
          : `${artifact.path}:${artifact.line}`
      }
      onCloseAutoFocus={onCloseAutoFocus}
      lang={langTag(language)}
      closeLabel={t.closeDialog}
      wide
    >
      {!loading && !error && artifact && artifact.kind !== "image" ? (
        <ArtifactText text={text} path={artifact.path} line={artifact.line} />
      ) : (
        <div className="artifact-content">
          {loading ? (
            <div className="loading-state">
              <LoaderCircle className="spin" />
              {t.opening}
            </div>
          ) : error ? (
            <p className="inline-error" role="alert" lang="">
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
          <span>{t.readOnly}</span>
          <button type="button" className="secondary-button" onClick={onAnnotate}>
            <SquareDashedMousePointer size={14} />
            {t.markUp}
          </button>
        </div>
      )}
      {text && (
        <div className="modal-footer">
          <FileText size={14} />
          <span>{t.readOnly}</span>
          <CopyButton text={text} label={t.copyContents} />
          {/* An HTML file opens working too, in the Portal or the browser (T-5). */}
          {!preview && artifact && htmlFile(artifact.path) && (
            <OpenChoice
              target={() => ({ kind: "snapshot", source: { kind: "artifact", agentId, path: artifact.path }, name: artifact.name, from: t.filePreview })}
              onOpened={onClose}
            />
          )}
        </div>
      )}
    </Modal>
  );
}
