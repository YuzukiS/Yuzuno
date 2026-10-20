import { Component, lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { LoaderCircle, RotateCcw, TriangleAlert } from "lucide-react";
import { CopyButton, Prose } from "../components";
import { useFullItem } from "../item-payload";
import type { NativeItem } from "../types";
import { parseReply, type ReplySegment, type ResultProblem } from "./message";
import type { ResultSpec } from "./spec";
import "./result-states.css";

type ResultProps = {
  resultId?: string;
  spec: ResultSpec;
  raw: string;
  identity: string;
  onFile?: (path: string, line?: number) => void;
  onDraft?: (text: string) => void;
  onInteract?: () => void;
};

/** The renderer chunk could not be loaded (offline, or replaced by an update). */
export class ResultChunkError extends Error {
  /** It can be fetched again in place; otherwise only a reload brings it. */
  readonly retryable: boolean;
  constructor(cause: unknown, retryable: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ResultChunkError";
    this.retryable = retryable;
  }
}

type ResultModule = { default: ComponentType<ResultProps> };
/** How the renderer is loaded; replaceable by tests. */
export const resultChunk = {
  load: (): Promise<ResultModule> => import("./InteractiveResult"),
  loadFrom: (url: string): Promise<ResultModule> => import(/* @vite-ignore */ url),
  reloadPage: () => window.location.reload(),
};

/**
 * The chunk's own URL, when the failure names it (Chromium and Firefox do).
 * Only a same-origin script is ever imported again.
 */
function failedChunk(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\bhttps?:\/\/[^\s'"]+\.js\b/.exec(message);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (url.origin !== window.location.origin) return null;
    url.search = "";
    return url.href;
  } catch {
    return null;
  }
}

// One import shared by every reply. A browser keeps a failed module fetch for
// its URL, and React.lazy keeps a rejected promise for good, so a retry
// imports the same chunk under a new URL into a new lazy component. A
// component that loaded is kept, so shown results never remount.
let loading: Promise<ResultModule> | null = null;
let failed = false;
let retryFrom: string | null = null;
let retries = 0;
function loadResult() {
  loading ??= (retryFrom ? resultChunk.loadFrom(`${retryFrom}?retry=${retries}`) : resultChunk.load()).catch(
    (error: unknown) => {
      loading = null;
      failed = true;
      retryFrom = failedChunk(error) ?? retryFrom;
      throw new ResultChunkError(error, retryFrom !== null);
    },
  );
  return loading;
}
let LazyResult = lazy(loadResult);
function retryResult() {
  if (!failed) return;
  failed = false;
  retries += 1;
  LazyResult = lazy(loadResult);
}

/**
 * Kept outside the lazy chunk: a chunk that fails to load must leave the
 * reply readable too, not only a failure inside the renderer.
 */
class ResultBoundary extends Component<
  { children: ReactNode; fallback: (error: unknown, reset: () => void) => ReactNode },
  { error: unknown; failed: boolean }
> {
  state = { error: null as unknown, failed: false };
  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }
  reset = () => this.setState({ error: null, failed: false });
  render() {
    return this.state.failed ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}

function RawResult({ raw, problem }: { raw?: string; problem?: ResultProblem }) {
  return (
    <details className="result-state-details">
      <summary>{raw === undefined ? "Details" : problem ? "Details and result JSON" : "Result JSON"}</summary>
      {problem && (
        <dl className="result-problem">
          <div><dt>Code</dt><dd><code>{problem.code}</code></dd></div>
          {problem.path && <div><dt>Where</dt><dd><code>{problem.path}</code></dd></div>}
          <div><dt>Reason</dt><dd>{problem.reason}</dd></div>
        </dl>
      )}
      {raw !== undefined && (
        <>
          <CopyButton text={raw} label="Copy result JSON" />
          <pre>{raw}</pre>
        </>
      )}
    </details>
  );
}

/** Where a result goes while it is still being written or loaded. */
export function ResultPlaceholder({ label }: { label: string }) {
  return (
    <div className="result-state result-placeholder" role="status" aria-live="polite">
      <LoaderCircle size={15} className="spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

const unavailable: Record<"format" | "unfinished" | "multiple" | "load" | "render" | "fetch" | "missing", string> = {
  format: "This interactive result couldn’t be shown: its format isn’t valid.",
  unfinished: "This interactive result couldn’t be shown: the reply stopped before it was complete.",
  multiple: "Only one interactive result is shown per reply. This one is kept below as JSON.",
  load: "The interactive result viewer couldn’t be loaded.",
  render: "This interactive result couldn’t be displayed.",
  fetch: "This interactive result couldn’t be loaded.",
  missing: "This interactive result is no longer available.",
};

export function ResultUnavailable({
  kind,
  raw,
  problem,
  onRetry,
  onReload,
}: {
  kind: keyof typeof unavailable;
  /** The result's JSON, when there is one to show. */
  raw?: string;
  problem?: ResultProblem;
  onRetry?: () => void;
  onReload?: () => void;
}) {
  return (
    <div className="result-state result-unavailable" data-result-state={kind}>
      <p role="status">
        <TriangleAlert size={15} aria-hidden="true" />
        <span>{unavailable[kind]}</span>
        {onRetry && (
          <button type="button" className="quiet-button result-retry" onClick={onRetry}>
            <RotateCcw size={13} aria-hidden="true" />
            Try again
          </button>
        )}
        {onReload && (
          <button type="button" className="quiet-button result-retry" onClick={onReload}>
            <RotateCcw size={13} aria-hidden="true" />
            Reload Yuzuno
          </button>
        )}
      </p>
      <RawResult raw={raw} problem={problem} />
    </div>
  );
}

function stateOf(problem: ResultProblem): keyof typeof unavailable {
  if (problem.code === "unfinished") return "unfinished";
  if (problem.code === "multiple_results") return "multiple";
  return "format";
}

/** One valid result, drawn by the lazily loaded renderer. */
export function ShownResult(props: ResultProps) {
  // Re-rendered on retry, so the boundary gets the current lazy component.
  const [, setTries] = useState(0);
  return (
    <ResultBoundary
      key={props.identity + props.raw}
      fallback={(error, reset) =>
        error instanceof ResultChunkError ? (
          <ResultUnavailable
            kind="load"
            raw={props.raw}
            problem={{ code: "viewer_unavailable", reason: error.message }}
            // Try again is a real second import (a new lazy component, a new
            // request), offered when the failure names the chunk; it helps
            // after a dropped connection. A reload is always offered: after an
            // update the old chunk is gone for good, and only a reload loads
            // the new one.
            onRetry={
              error.retryable
                ? () => {
                    retryResult();
                    setTries((tries) => tries + 1);
                    reset();
                  }
                : undefined
            }
            onReload={resultChunk.reloadPage}
          />
        ) : (
          <ResultUnavailable
            kind="render"
            raw={props.raw}
            problem={{ code: "render_error", reason: error instanceof Error ? error.message : String(error) }}
          />
        )
      }
    >
      <Suspense fallback={<ResultPlaceholder label="Loading interactive result…" />}>
        <LazyResult {...props} />
      </Suspense>
    </ResultBoundary>
  );
}

function Segment({ segment, props }: { segment: ReplySegment; props: Omit<ResultProps, "spec" | "raw"> }) {
  switch (segment.kind) {
    case "text":
      return <Prose text={segment.text} onFile={props.onFile} />;
    case "pending":
      return <ResultPlaceholder label="Generating interactive result…" />;
    case "invalid":
      return <ResultUnavailable kind={stateOf(segment.problem)} raw={segment.raw} problem={segment.problem} />;
    case "result":
      return <ShownResult {...props} spec={segment.spec} raw={segment.raw} />;
  }
}

const noItem: NativeItem = { id: "", type: "agentMessage" };

/**
 * An Agent reply: Markdown, with one explicit interactive result rendered in
 * place. While a result is still being written or loaded a small placeholder
 * stands in for it; one that cannot be shown says why in a line, with the
 * details and its JSON folded away. The rest of the reply always reads as
 * Markdown, and the reply text itself is never changed.
 */
export function AgentReply({
  text,
  identity,
  complete = true,
  source,
  onFile,
  onDraft,
  onInteract,
}: {
  text: string;
  identity: string;
  /** Nothing more is coming for this message (it finished, its Turn ended, or
   * execution is unconfirmed): an unclosed block is then unfinished. */
  complete?: boolean;
  /** Where to read the full text when the shown text is only a preview. */
  source?: { agentId: string; turnId: string; item: NativeItem };
  onFile?: (path: string, line?: number) => void;
  onDraft?: (text: string) => void;
  onInteract?: () => void;
}) {
  // A preview with a result block is read in full first: its cut-off end
  // would look like a broken result. Others stay previews, so a long history
  // never reads replies it has no result in.
  const preview = !!source?.item._yuzunoTruncated?.text && text.includes("yuzuno-ui");
  const full = useFullItem(source?.agentId, source?.turnId, source?.item ?? noItem);
  const expand = full.expand;
  useEffect(() => {
    if (preview && !full.expanded) expand();
  }, [preview, full.expanded, expand]);
  const loaded = preview && full.expanded && !full.loading && !full.error;
  const shownText = loaded && typeof full.item.text === "string" ? full.item.text : text;
  const segments = useMemo(
    () => (preview && !loaded ? null : parseReply(shownText, complete)),
    [preview, loaded, shownText, complete],
  );
  if (preview && !loaded)
    return (
      <>
        <Prose text={text} onFile={onFile} />
        {full.error ? (
          <div className="result-state result-unavailable" data-result-state="payload">
            <p role="status">
              <TriangleAlert size={15} aria-hidden="true" />
              <span>The rest of this reply couldn’t be loaded.</span>
              <button type="button" className="quiet-button result-retry" onClick={expand}>
                <RotateCcw size={13} aria-hidden="true" />
                Try again
              </button>
            </p>
          </div>
        ) : (
          <ResultPlaceholder label="Loading the full reply…" />
        )}
      </>
    );
  if (!segments) return <Prose text={shownText} onFile={onFile} />;
  return (
    <>
      {segments.map((segment, index) => (
        <Segment key={index} segment={segment} props={{ identity, onFile, onDraft, onInteract }} />
      ))}
    </>
  );
}
