import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, LoaderCircle, MessageSquare, ShieldCheck, SquareTerminal } from "lucide-react";
import { errorText, NO_ANSWER_REPLY, respondToRequest } from "./api";
import { AnswerAgain, DraftNotSaved, useUnconfirmedAnswer } from "./unconfirmed-answer";
import { choiceAnswers, choiceEmpty, useRequestDraft } from "./request-draft";
import type { NativeItem, PendingRequest } from "./types";
import { langTag, useLanguage, useStrings } from "./i18n";
import { cardWords } from "./subagent-text";
import { requestWords, shownError } from "./request-text";
import "./opencode.css";

/** One of OpenCode's questions (its QuestionInfo); `custom` is true unless OpenCode says otherwise. */
type Question = { question: string; header?: string; options?: { label: string; description?: string }[]; multiple?: boolean; custom?: boolean };

const shown = (value: unknown) => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);

/** A tool call as OpenCode reported it: its name, input and output (or error). */
export function OpenCodeTool({ item, unconfirmed, notice, opened, onOpenChange }: {
  item: NativeItem; unconfirmed: boolean; notice?: ReactNode;
  opened?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const t = useStrings(cardWords);
  const input = (item.input || {}) as Record<string, unknown>;
  const hint = input.command || input.filePath || input.pattern || input.url || input.description || "";
  const running = !unconfirmed && /inProgress|running/.test(item.status || "");
  const result = unconfirmed || item.status === "unknown" ? t.unconfirmed : item.status === "inProgress" ? t.running : item.status;
  return <details className="tool-item opencode-tool" id={`item-${item.id}`} data-running={running || undefined}
    open={opened} onToggle={event => {
      if (event.target === event.currentTarget && event.currentTarget.open !== opened) onOpenChange?.(event.currentTarget.open);
    }}>
    <summary><ChevronRight size={12} /><SquareTerminal size={14} />
      <span><strong>{String(item.name || t.tool)}</strong>{hint ? ` · ${String(hint)}` : ""}</span>
      <span className="tool-result">{result}</span>
    </summary>
    <div className="tool-content">
      {notice}
      <span className="section-eyebrow">{t.input}</span><pre>{JSON.stringify(input, null, 2)}</pre>
      <span className="section-eyebrow">{item.status === "failed" ? t.error : t.result}</span>
      <pre>{item.output == null ? t.noResultYet : shown(item.output)}</pre>
    </div>
  </details>;
}

/** Answers go only to the OpenCode process and session that asked (Core
 * checks). Allow once or reject: no lasting rule is offered or written. */
export function OpenCodeRequest({ request, refresh, disabled, highlightSource, draftScope = null }: {
  request: PendingRequest; refresh: () => void; disabled: boolean; highlightSource?: boolean; draftScope?: string | null;
}) {
  const question = request.method === "opencode/question";
  const language = useLanguage();
  const t = requestWords(language);
  const questions: Question[] = question && Array.isArray(request.params.questions) ? request.params.questions : [];
  // An unsent answer to a question survives a refresh (T-170).
  const draft = useRequestDraft(questions.length ? draftScope : null, request, saved => choiceAnswers(saved, questions.map((_, index) => String(index))));
  const [sending, setSending] = useState(false);
  // Set before the first await, so a second click in the same moment finds
  // it; kept after a delivered answer until Core marks the request sent.
  const answering = useRef(draft.attempted);
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState(draft.attempted ? NO_ANSWER_REPLY : "");
  const [answers, setAnswers] = useState<Record<number, string[]>>(() => draft.initial?.answers ?? {});
  const [free, setFree] = useState<Record<number, string>>(() => draft.initial?.free ?? {});
  const kept = { answers, free };
  useEffect(() => { draft.save(kept, choiceEmpty(kept)); }, [answers, free]);
  const unconfirmedAnswer = useUnconfirmedAnswer(refresh, answering, draft.attempted);
  const locked = disabled || !!request.stale || !!request.params._responseSent || sending || answered || unconfirmedAnswer.unconfirmed;
  const answer = (q: Question, index: number) =>
    [...(answers[index] || []), ...(q.custom !== false && free[index]?.trim() ? [free[index].trim()] : [])];
  async function respond(response: unknown) {
    if (locked || answering.current) return;
    answering.current = true;
    setSending(true); setError("");
    draft.attempt(true, kept, choiceEmpty(kept));
    try {
      await respondToRequest(request.id, response);
      draft.remove();
      setAnswered(true);
      refresh();
    } catch (e) {
      if (!unconfirmedAnswer.noReply(e)) { answering.current = false; draft.attempt(false, kept, choiceEmpty(kept)); }
      setError(errorText(e));
    } finally { setSending(false); }
  }
  // Which of its sub-agents asks (T-10), on the line Codex's sub-agents use: OpenCode's title for it, else its agent.
  const child = request.params._opencodeChild as { title?: unknown; agent?: unknown } | undefined;
  const subAgent = child ? (typeof child.title === "string" && child.title) || (typeof child.agent === "string" && child.agent ? `@${child.agent}` : "") : "";
  const patterns = Array.isArray(request.params.patterns) ? request.params.patterns.map(String) : [];
  const metadata = request.params.metadata && Object.keys(request.params.metadata).length ? request.params.metadata : null;
  return <section className={`pending-card opencode-request${highlightSource ? " source-highlight" : ""}`} id={`request-${request.id}`} tabIndex={-1} lang={langTag(language)}>
    <div className="pending-heading">
      {question ? <MessageSquare size={17} /> : <ShieldCheck size={17} />}
      <strong>{question ? t.openQuestion : t.openPermission}</strong>
      <span className="pending-tag">{t.needsYou}</span>
    </div>
    {child && <p className="pending-source">{t.fromSubAgent}<strong lang="">{subAgent || t.ofThisAgent}</strong>{t.onlySubAgent}</p>}
    {request.stale && <p className="inline-error">{t.staleOpen}</p>}
    {request.params._responseSent && <p className="field-hint">{t.sentOpen}</p>}
    {question ? <form onSubmit={e => { e.preventDefault(); void respond({ answers: questions.map(answer) }); }}>
      <fieldset disabled={locked} className="opencode-question-fields">
        {questions.map((q, index) => <fieldset key={index}>
          <legend lang="">{q.question}</legend>
          {q.multiple && <p className="field-hint">{t.chooseAny}</p>}
          {q.options?.map(option => <label className="answer-option" key={option.label}>
            <input type={q.multiple ? "checkbox" : "radio"} name={`${request.id}-${index}`} checked={(answers[index] || []).includes(option.label)}
              onChange={e => { setAnswers(old => ({ ...old, [index]: q.multiple ? e.target.checked ? [...(old[index] || []), option.label] : (old[index] || []).filter(x => x !== option.label) : [option.label] })); if (!q.multiple) setFree(old => ({ ...old, [index]: "" })); }} />
            <span lang=""><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          </label>)}
          {q.custom !== false && <input aria-label={t.yourAnswer(q.question)} placeholder={t.ownAnswer} value={free[index] || ""}
            onChange={e => { setFree(old => ({ ...old, [index]: e.target.value })); if (!q.multiple) setAnswers(old => ({ ...old, [index]: [] })); }} />}
        </fieldset>)}
      </fieldset>
      {draft.notSaved && <DraftNotSaved />}
      <div className="opencode-actions">
        <button className="primary-button" disabled={locked || !questions.length || questions.some((q, index) => !answer(q, index).length)}>{sending && <LoaderCircle size={14} className="spin" />}{t.sendAnswer}</button>
        <button type="button" className="secondary-button" disabled={locked} onClick={() => void respond({ decision: "reject" })}>{t.decline}</button>
      </div>
    </form> : <>
      <p>{t.asksUse}<strong>{String(request.params.permission || t.aTool)}</strong>{patterns.length ? t.forColon : t.period}</p>
      {patterns.length > 0 && <pre className="opencode-request-input">{patterns.join("\n")}</pre>}
      {metadata && <pre className="opencode-request-input">{JSON.stringify(metadata, null, 2)}</pre>}
      <div className="opencode-actions">
        <button className="primary-button" disabled={locked} onClick={() => void respond({ decision: "once" })}>{sending && <LoaderCircle size={14} className="spin" />}{t.allowOnce}</button>
        <button className="secondary-button" disabled={locked} onClick={() => void respond({ decision: "reject" })}>{t.reject}</button>
      </div>
      <p className="field-hint">{t.openHint}</p>
    </>}
    {error && !(unconfirmedAnswer.unconfirmed && request.params._responseSent) && <p role="alert" className="inline-error">{shownError(error, t)}</p>}
    {unconfirmedAnswer.unconfirmed && !request.params._responseSent && <AnswerAgain onClick={() => { setError(""); unconfirmedAnswer.answerAgain(); }} />}
  </section>;
}
