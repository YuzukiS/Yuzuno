import { useRef, useState, type ReactNode } from "react";
import { ChevronRight, LoaderCircle, MessageSquare, ShieldCheck, SquareTerminal } from "lucide-react";
import { errorText, respondToRequest } from "./api";
import { AnswerAgain, useUnconfirmedAnswer } from "./unconfirmed-answer";
import type { NativeItem, PendingRequest } from "./types";
import "./opencode.css";

/** One of OpenCode's questions (its QuestionInfo); `custom` is true unless OpenCode says otherwise. */
type Question = { question: string; header?: string; options?: { label: string; description?: string }[]; multiple?: boolean; custom?: boolean };

const shown = (value: unknown) => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);

/** A tool call as OpenCode reported it: its name, input and output (or error). */
export function OpenCodeTool({ item, unconfirmed, notice, opened, onOpenChange }: {
  item: NativeItem; unconfirmed: boolean; notice?: ReactNode;
  opened?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const input = (item.input || {}) as Record<string, unknown>;
  const hint = input.command || input.filePath || input.pattern || input.url || input.description || "";
  const running = !unconfirmed && /inProgress|running/.test(item.status || "");
  const result = unconfirmed || item.status === "unknown" ? "Unconfirmed" : item.status === "inProgress" ? "Running" : item.status;
  return <details className="tool-item opencode-tool" id={`item-${item.id}`} data-running={running || undefined}
    open={opened} onToggle={event => {
      if (event.target === event.currentTarget && event.currentTarget.open !== opened) onOpenChange?.(event.currentTarget.open);
    }}>
    <summary><ChevronRight size={12} /><SquareTerminal size={14} />
      <span><strong>{String(item.name || "Tool")}</strong>{hint ? ` · ${String(hint)}` : ""}</span>
      <span className="tool-result">{result}</span>
    </summary>
    <div className="tool-content">
      {notice}
      <span className="section-eyebrow">INPUT</span><pre>{JSON.stringify(input, null, 2)}</pre>
      <span className="section-eyebrow">{item.status === "failed" ? "ERROR" : "RESULT"}</span>
      <pre>{item.output == null ? "No result yet." : shown(item.output)}</pre>
    </div>
  </details>;
}

/** Answers go only to the OpenCode process and session that asked (Core
 * checks). Allow once or reject: no lasting rule is offered or written. */
export function OpenCodeRequest({ request, refresh, disabled, highlightSource }: {
  request: PendingRequest; refresh: () => void; disabled: boolean; highlightSource?: boolean;
}) {
  const [sending, setSending] = useState(false);
  // Set before the first await, so a second click in the same moment finds
  // it; kept after a delivered answer until Core marks the request sent.
  const answering = useRef(false);
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<number, string[]>>({});
  const [free, setFree] = useState<Record<number, string>>({});
  const question = request.method === "opencode/question";
  const questions: Question[] = question && Array.isArray(request.params.questions) ? request.params.questions : [];
  const unconfirmedAnswer = useUnconfirmedAnswer(refresh, answering);
  const locked = disabled || !!request.stale || !!request.params._responseSent || sending || answered || unconfirmedAnswer.unconfirmed;
  const answer = (q: Question, index: number) =>
    [...(answers[index] || []), ...(q.custom !== false && free[index]?.trim() ? [free[index].trim()] : [])];
  async function respond(response: unknown) {
    if (locked || answering.current) return;
    answering.current = true;
    setSending(true); setError("");
    try {
      await respondToRequest(request.id, response);
      setAnswered(true);
      refresh();
    } catch (e) { if (!unconfirmedAnswer.noReply(e)) answering.current = false; setError(errorText(e)); } finally { setSending(false); }
  }
  const patterns = Array.isArray(request.params.patterns) ? request.params.patterns.map(String) : [];
  const metadata = request.params.metadata && Object.keys(request.params.metadata).length ? request.params.metadata : null;
  return <section className={`pending-card opencode-request${highlightSource ? " source-highlight" : ""}`} id={`request-${request.id}`} tabIndex={-1}>
    <div className="pending-heading">
      {question ? <MessageSquare size={17} /> : <ShieldCheck size={17} />}
      <strong>{question ? "OpenCode has a question" : "OpenCode needs your permission"}</strong>
      <span className="pending-tag">Needs you</span>
    </div>
    {request.stale && <p className="inline-error">This request belongs to a closed connection. Reconnect to continue.</p>}
    {request.params._responseSent && <p className="field-hint">Response sent. Waiting for OpenCode.</p>}
    {question ? <form onSubmit={e => { e.preventDefault(); void respond({ answers: questions.map(answer) }); }}>
      <fieldset disabled={locked} className="opencode-question-fields">
        {questions.map((q, index) => <fieldset key={index}>
          <legend>{q.question}</legend>
          {q.multiple && <p className="field-hint">Choose any that apply.</p>}
          {q.options?.map(option => <label className="answer-option" key={option.label}>
            <input type={q.multiple ? "checkbox" : "radio"} name={`${request.id}-${index}`} checked={(answers[index] || []).includes(option.label)}
              onChange={e => { setAnswers(old => ({ ...old, [index]: q.multiple ? e.target.checked ? [...(old[index] || []), option.label] : (old[index] || []).filter(x => x !== option.label) : [option.label] })); if (!q.multiple) setFree(old => ({ ...old, [index]: "" })); }} />
            <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          </label>)}
          {q.custom !== false && <input aria-label={`Your answer: ${q.question}`} placeholder="Or write your own answer…" value={free[index] || ""}
            onChange={e => { setFree(old => ({ ...old, [index]: e.target.value })); if (!q.multiple) setAnswers(old => ({ ...old, [index]: [] })); }} />}
        </fieldset>)}
      </fieldset>
      <div className="opencode-actions">
        <button className="primary-button" disabled={locked || !questions.length || questions.some((q, index) => !answer(q, index).length)}>{sending && <LoaderCircle size={14} className="spin" />}Send answer</button>
        <button type="button" className="secondary-button" disabled={locked} onClick={() => void respond({ decision: "reject" })}>Decline</button>
      </div>
    </form> : <>
      <p>OpenCode asks to use <strong>{String(request.params.permission || "a tool")}</strong>{patterns.length ? " for:" : "."}</p>
      {patterns.length > 0 && <pre className="opencode-request-input">{patterns.join("\n")}</pre>}
      {metadata && <pre className="opencode-request-input">{JSON.stringify(metadata, null, 2)}</pre>}
      <div className="opencode-actions">
        <button className="primary-button" disabled={locked} onClick={() => void respond({ decision: "once" })}>{sending && <LoaderCircle size={14} className="spin" />}Allow once</button>
        <button className="secondary-button" disabled={locked} onClick={() => void respond({ decision: "reject" })}>Reject</button>
      </div>
      <p className="field-hint">Applies only to this request; your OpenCode permission rules stay in place. OpenCode rejects this session’s other waiting requests along with this one.</p>
    </>}
    {error && !(unconfirmedAnswer.unconfirmed && request.params._responseSent) && <p role="alert" className="inline-error">{error}</p>}
    {unconfirmedAnswer.unconfirmed && !request.params._responseSent && <AnswerAgain onClick={() => { setError(""); unconfirmedAnswer.answerAgain(); }} />}
  </section>;
}
