import { useEffect, useState, type ReactNode } from "react";
import { ListChecks } from "lucide-react";
import { HttpError } from "../api";
import { strings, useStrings } from "../i18n";
import type { MessageInput } from "../types";
import {
  clarificationAnswers,
  clarificationSchema,
  type ClarificationAnswer,
  type ClarificationProps,
  type ClarificationValues,
} from "./clarification";
import { readPublished } from "./TurnResults";
import "./clarification.css";

const answerText = strings({
  answersTo: "Answers to",
  answers: (title: string) => `Answers to “${title}”`,
  reading: "Reading the form…",
  notAnswered: "Not answered",
  sent: "Text sent to the Agent",
  unavailable: "The original form can't be shown, so this is the text that was sent.",
  retry: "Try again",
}, {
  answersTo: "表单回答",
  answers: (title: string) => `“${title}”的回答`,
  reading: "正在读取表单…",
  notAnswered: "未填写",
  sent: "发给 Agent 的原文",
  unavailable: "原表单无法显示，下面是当时发送的原文。",
  retry: "重试",
});

/**
 * The form a message answered, named only by its send receipt: Core checked,
 * when it was sent, that this very text is the one that form and these
 * answers make. No receipt, or other text, names nothing: what a message
 * looks like never makes it a form's answers.
 */
export function formAnswer(
  text: string,
  receipt: { input: MessageInput } | undefined,
): ClarificationAnswer | null {
  const answer = receipt?.input.clarification;
  return answer && receipt.input.text === text ? answer : null;
}

/** The answered form in the published version the answers were sent to. */
function answeredForm(spec: unknown, answer: ClarificationAnswer) {
  const elements = (spec as { elements?: unknown } | null)?.elements;
  if (!elements || typeof elements !== "object") return null;
  for (const element of Object.values(elements as Record<string, { type?: unknown; props?: unknown }>)) {
    if (element?.type !== "Clarification") continue;
    const form = clarificationSchema.safeParse(element.props);
    if (!form.success || form.data.id !== answer.formId) continue;
    const values = clarificationAnswers(form.data).safeParse(answer.answers);
    return values.success ? { form: form.data, values: values.data as ClarificationValues } : null;
  }
  return null;
}

type View =
  | { kind: "reading" }
  | { kind: "ready"; form: ClarificationProps; values: ClarificationValues }
  | { kind: "unavailable"; retry: boolean };

/**
 * A message that answered a published form, shown as its answers: each
 * question with the chosen labels or the text written (T-9). The text sent
 * stays one click away; when the form can't be read it is what is shown.
 */
export function SentFormAnswer({
  agentId,
  answer,
  text,
  children,
}: {
  agentId: string;
  answer: ClarificationAnswer;
  text: string;
  /** The message as text, shown when the form can't be. */
  children: ReactNode;
}) {
  const t = useStrings(answerText);
  const [view, setView] = useState<View>({ kind: "reading" });
  const [reads, setReads] = useState(0);
  const identity = JSON.stringify(answer);
  useEffect(() => {
    let current = true;
    setView({ kind: "reading" });
    readPublished(agentId, answer.resultId).then(
      (result) => {
        if (!current) return;
        const shown = answeredForm(result.spec, answer);
        setView(shown ? { kind: "ready", ...shown } : { kind: "unavailable", retry: false });
      },
      (error: unknown) =>
        current && setView({ kind: "unavailable", retry: !(error instanceof HttpError && error.status === 404) }),
    );
    return () => {
      current = false;
    };
    // The answer by value: a receipt read again is the same answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, identity, reads]);
  if (view.kind !== "ready")
    return (
      <section className="clarification-answer" data-state={view.kind} aria-label={t.answersTo}>
        <header>
          <ListChecks size={14} aria-hidden="true" />
          <span>{t.answersTo}</span>
        </header>
        {view.kind === "reading" ? (
          <p className="clarification-answer-note" role="status">{t.reading}</p>
        ) : (
          <>
            <p className="clarification-answer-note">
              {t.unavailable}
              {view.retry && (
                <button type="button" className="text-button" onClick={() => setReads((n) => n + 1)}>
                  {t.retry}
                </button>
              )}
            </p>
            <div className="clarification-answer-text">{children}</div>
          </>
        )}
      </section>
    );
  const { form, values } = view;
  return (
    <section className="clarification-answer" data-state="ready" aria-label={t.answers(form.title)}>
      <header>
        <ListChecks size={14} aria-hidden="true" />
        <span>{t.answersTo}</span>
        <h4>{form.title}</h4>
      </header>
      <dl>
        {form.fields.map((field) => {
          const value = values[field.id];
          const chosen =
            field.type === "text"
              ? null
              : field.options.filter((option) =>
                  Array.isArray(value) ? value.includes(option.id) : value === option.id,
                );
          const empty = chosen ? chosen.length === 0 : !String(value ?? "").trim();
          return (
            <div key={field.id}>
              <dt>{field.label}</dt>
              <dd data-empty={empty || undefined}>
                {empty ? (
                  t.notAnswered
                ) : chosen ? (
                  <ul>
                    {chosen.map((option) => (
                      <li key={option.id}>{option.label}</li>
                    ))}
                  </ul>
                ) : (
                  <p>{String(value)}</p>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <details className="clarification-answer-sent">
        <summary>{t.sent}</summary>
        <pre>{text}</pre>
      </details>
    </section>
  );
}
