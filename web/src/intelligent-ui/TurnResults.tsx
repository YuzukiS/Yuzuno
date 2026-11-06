import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorText, HttpError } from "../api";
import type { NativeTurn, PublishedResultRef } from "../types";
import { checkSpec, ResultError, type ResultProblem, type ResultSpec } from "./contract";
import { ResultPlaceholder, ResultUnavailable, ShownResult } from "./AgentReply";
import "./result-states.css";

type Published = { id: string; spec: unknown };
type View =
  | { kind: "loading" }
  | { kind: "ready"; spec: ResultSpec; raw: string }
  | { kind: "invalid"; raw: string; problem: ResultProblem }
  | { kind: "failed"; missing: boolean; problem: ResultProblem };

// A version never changes once published: each is read once, and the most
// recent are kept (each is at most 64 KB). A failed read is forgotten, so Try
// again reads it again. What a kept read gave is kept beside it, so a result
// read before is drawn at once when it is shown again (T-19 HM:I5).
const KEEP = 200;
const published = new Map<string, Promise<Published>>();
const settled = new Map<string, Published>();
const keyOf = (agentId: string, id: string) => `${agentId}\u0000${id}`;
function load(agentId: string, id: string) {
  const key = keyOf(agentId, id);
  let read = published.get(key);
  if (read) published.delete(key);
  else {
    const reading = api<Published>(`/agents/${encodeURIComponent(agentId)}/results/${encodeURIComponent(id)}`);
    reading.then(
      (result) => published.get(key) === reading && settled.set(key, result),
      () => published.get(key) === reading && published.delete(key),
    );
    read = reading;
  }
  published.set(key, read);
  while (published.size > KEEP) {
    const oldest = published.keys().next().value!;
    published.delete(oldest);
    settled.delete(oldest);
  }
  return read;
}
/** One published version, read through the same kept reads (T-9). */
export { load as readPublished };

// One view per read, so drawing a kept read again changes nothing.
const views = new WeakMap<Published, View>();
function viewOf(result: Published): View {
  let shown = views.get(result);
  if (!shown) views.set(result, (shown = view(result)));
  return shown;
}
/** A kept read's view, if it has settled. */
function keptView(agentId: string, id: string): View | null {
  const result = settled.get(keyOf(agentId, id));
  return result ? viewOf(result) : null;
}

function view(result: Published): View {
  const raw = JSON.stringify(result.spec, null, 2);
  try {
    // Drawn only as the current contract reads it, like a reply's block.
    return { kind: "ready", spec: checkSpec(result.spec).spec, raw };
  } catch (error) {
    if (!(error instanceof ResultError)) throw error;
    return { kind: "invalid", raw, problem: error.problems[0] };
  }
}

function PublishedResult({
  agentId,
  shown,
  onFile,
  onDraft,
  onInteract,
}: {
  agentId: string;
  shown: PublishedResultRef;
  onFile?: (path: string, line?: number) => void;
  onDraft?: (text: string) => void;
  onInteract?: () => void;
}) {
  // A version read before in this window is drawn at once, with no
  // placeholder before it; one read now comes in with a fade (T-19 HM:I5).
  const [state, setState] = useState<View>(() => keptView(agentId, shown.id) ?? { kind: "loading" });
  const [reads, setReads] = useState(0);
  const waited = useRef(false);
  useLayoutEffect(() => {
    if (state.kind === "loading") waited.current = true;
  }, [state.kind]);
  useEffect(() => {
    let current = true;
    setState(keptView(agentId, shown.id) ?? { kind: "loading" });
    load(agentId, shown.id).then(
      (result) => current && setState(viewOf(result)),
      (error: unknown) =>
        current &&
        setState({
          kind: "failed",
          missing: error instanceof HttpError && error.status === 404,
          problem: { code: error instanceof HttpError && error.code ? error.code : "load_failed", reason: errorText(error) },
        }),
    );
    return () => {
      current = false;
    };
  }, [agentId, shown.id, reads]);
  switch (state.kind) {
    case "loading":
      return <ResultPlaceholder what="result" />;
    case "failed":
      // Reading it again never asks the Agent for anything.
      return state.missing ? (
        <ResultUnavailable kind="missing" problem={state.problem} />
      ) : (
        <ResultUnavailable kind="fetch" problem={state.problem} onRetry={() => setReads((n) => n + 1)} />
      );
    case "invalid":
      return <ResultUnavailable kind="format" raw={state.raw} problem={state.problem} />;
    case "ready":
      // Keyed by version: a new version starts with its own selection.
      return (
        <ShownResult
          spec={state.spec}
          raw={state.raw}
          identity={shown.id}
          resultId={shown.id}
          arrived={waited.current}
          onFile={onFile}
          onDraft={onDraft}
          onInteract={onInteract}
        />
      );
  }
}

/**
 * Results an Agent published in this Turn with result_publish, each in its
 * latest version. Shown with the Turn whatever its outcome: a result that
 * was accepted stays visible when the Turn fails or is interrupted, and is
 * not a sign that the Turn's work is done.
 */
export function TurnResults({
  agentId,
  turn,
  onFile,
  onDraft,
  onInteract,
}: {
  agentId: string;
  turn: NativeTurn;
  onFile?: (path: string, line?: number) => void;
  onDraft?: (text: string) => void;
  onInteract?: () => void;
}) {
  const results = turn._yuzunoResults;
  if (!results?.length) return null;
  return (
    <div className="turn-results">
      {results.map((shown) => (
        <PublishedResult
          key={shown.id}
          agentId={agentId}
          shown={shown}
          onFile={onFile}
          onDraft={onDraft}
          onInteract={onInteract}
        />
      ))}
    </div>
  );
}
