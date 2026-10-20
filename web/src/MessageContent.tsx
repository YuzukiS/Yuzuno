import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./components";
import { api } from "./api";
import {
  contentParts,
  textLabel,
  textPreview,
  userText,
  type TextBlock,
  type RequestPart,
} from "./message-content";
import type { NativeItem, WorkSummary } from "./types";
import "./pasted-text.css";
import "./message-content.css";

function TextBlockButton({
  id,
  label,
  preview,
  kind,
  source,
  onDialogChange,
}: {
  id: string;
  label: string;
  preview: string;
  kind: "paste" | "long";
  source: () => string | Promise<string>;
  onDialogChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const title = kind === "long" ? "Long text" : "Pasted text";
  function previewAtTrigger() {
    const box = trigger.current?.getBoundingClientRect();
    if (box)
      setPosition({
        left: Math.max(
          8,
          Math.min(
            box.left,
            window.innerWidth - Math.min(420, window.innerWidth * 0.85) - 8,
          ),
        ),
        top: Math.max(8, Math.min(box.bottom + 5, window.innerHeight - 175)),
      });
    setHover(true);
  }
  async function show() {
    const attempt = ++request.current;
    setHover(false);
    setText(null);
    setError("");
    setOpen(true);
    onDialogChange?.(true);
    try {
      const value = await source();
      if (attempt === request.current) setText(value);
    } catch (e) {
      if (attempt === request.current)
        setError(e instanceof Error ? e.message : "Could not load this text.");
    }
  }
  return (
    <span
      className="message-text-block"
      onPointerEnter={previewAtTrigger}
      onPointerLeave={() => setHover(false)}
    >
      <button
        ref={trigger}
        type="button"
        className="pasted-text-chip"
        data-paste-id={id}
        aria-label={`${title}: ${label}. View full text`}
        aria-haspopup="dialog"
        onFocus={previewAtTrigger}
        onBlur={() => setHover(false)}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          void show();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ")
            event.stopPropagation();
        }}
      >
        {label || "Empty text"}
        <small>{kind === "long" ? "Long text" : "Pasted text"}</small>
      </button>
      {hover &&
        !open &&
        createPortal(
          <span
            className="message-text-preview"
            role="tooltip"
            style={position}
          >
            <span>{preview || "Empty text"}</span>
            <small>Open full text</small>
          </span>,
          document.body,
        )}
      <Modal
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          onDialogChange?.(value);
          if (!value) {
            ++request.current;
            setText(null);
          }
        }}
        title={`${title} · ${label}`}
        description="The complete original text."
        wide
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
      >
        {error ? (
          <p role="alert">{error}</p>
        ) : text === null ? (
          <p role="status">Loading text…</p>
        ) : (
          <>
            <pre className="message-text-source" tabIndex={0}>
              {text}
            </pre>
            <button
              className="quiet-button"
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text);
                } catch {
                  setError("Could not copy. Select the text to copy it.");
                }
              }}
            >
              Copy full text
            </button>
          </>
        )}
      </Modal>
    </span>
  );
}

/** Closed blocks never put their full source in DOM, title or hidden panels. */
export function MessageContent({
  text,
  blocks,
  compact = false,
  onDialogChange,
}: {
  text: string;
  blocks?: readonly TextBlock[];
  compact?: boolean;
  onDialogChange?: (open: boolean) => void;
}) {
  return (
    <span className="message-content">
      {contentParts(text, blocks).map((part, index) =>
        part.kind === "text" ? (
          <span key={`text-${index}`}>
            {compact ? part.text.slice(0, 160) : part.text}
          </span>
        ) : (
          <TextBlockButton
            key={part.id}
            id={part.id}
            label={textLabel(part.text)}
            preview={textPreview(part.text)}
            kind={part.kind}
            source={() => part.text}
            onDialogChange={onDialogChange}
          />
        ),
      )}
    </span>
  );
}

export function RequestSummary({
  agentId,
  summary,
}: {
  agentId: string;
  summary: WorkSummary;
}) {
  if (summary.source !== "user" || !summary.requestParts?.length)
    return <>{summary.text}</>;
  async function source(part: Exclude<RequestPart, { kind: "text" }>) {
    if (!summary.itemId || !summary.turnId)
      throw new Error("Original message is unavailable.");
    const result = await api<{ itemId: string; fields: Partial<NativeItem> }>(
      `/agents/${encodeURIComponent(agentId)}/items/${encodeURIComponent(summary.itemId)}/payload?turnId=${encodeURIComponent(summary.turnId)}`,
    );
    const item: NativeItem = {
      ...result.fields,
      id: result.itemId,
      type: "userMessage",
    };
    if (item.id !== summary.itemId)
      throw new Error("Original message is unavailable.");
    const block = contentParts(userText(item), item._yuzunoTextBlocks).find(
      (p) => p.kind !== "text" && p.id === part.id,
    );
    if (!block || block.kind === "text")
      throw new Error("Original text block is unavailable.");
    return block.text;
  }
  return (
    <span className="message-content">
      {summary.requestParts.map((part, index) =>
        part.kind === "text" ? (
          <span key={`text-${index}`}>{part.text}</span>
        ) : (
          <TextBlockButton
            key={part.id}
            id={part.id}
            label={textLabel(part.label) + (part.truncated ? "…" : "")}
            preview={textPreview(part.preview)}
            kind={part.kind}
            source={() => source(part)}
          />
        ),
      )}
    </span>
  );
}
