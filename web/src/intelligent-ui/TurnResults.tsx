import { useEffect, useState } from "react";
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
// again reads it again.
const KEEP = 200;
const published = new Map<string, Promise<Published>>();
function load(agentId: string, id: string) {
  const key = `${agentId}\u0000${id}`;
  let read = published.get(key);
  if (read) published.delete(key);
  else {
    read = api<Published>(`/agents/${encodeURIComponent(agentId)}/results/${encodeURIComponent(id)}`);
    read.catch(() => published.get(key) === read && published.delete(key));
  }
  published.set(key, read);
  while (published.size > KEEP) published.delete(published.keys().next().value!);
  return read;
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
  const [state, setState] = useState<View>({ kind: "loading" });
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    load(agentId, shown.id).then(
      (result) => current && setState(view(result)),
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
      return <ResultPlaceholder label="Loading interactive result…" />;
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
