import { useId, useRef, useState } from "react";
import { ArrowRight, Check, LoaderCircle } from "lucide-react";
import {
  clarificationDraftKey,
  initialClarificationValues,
  readClarificationDraft,
  saveClarificationDraft,
  validateClarification,
  type ClarificationErrors,
  type ClarificationProps,
  type ClarificationValues,
} from "./clarification";
import "./clarification.css";
import { strings, useStrings } from "../i18n";

// The form's own words in the interface language (T-189). The questions,
// options, defaults, answers, the Agent's name, Core's and the browser's
// errors and the validation messages are shown as they are.
const formText = strings({
  sent: (agent: string) => `Answers sent to ${agent}.`,
  queued: (agent: string) => `Sent · waiting for ${agent} to confirm.`,
  unconfirmed: "Delivery is unconfirmed. Check the conversation before sending anything again.",
  onlyHere: "This draft is only in this window. Keep it open until your answers are sent.",
  required: "Required",
  optional: "Optional",
  default: (source: string) => `Default: ${source}`,
  clear: "Clear selection",
  goesTo: (agent: string) => `Your answers go to ${agent} in this conversation.`,
  sending: "Sending answers…",
  answered: "Answers sent",
  submit: "Submit answers",
  check: "Check delivery",
}, {
  sent: (agent) => `答案已发送给 ${agent}。`,
  queued: (agent) => `已发送 · 等待 ${agent} 确认。`,
  unconfirmed: "投递尚未确认。再次发送之前，请先查看会话。",
  onlyHere: "这份草稿只在此窗口中。在答案发送之前，请保持它打开。",
  required: "必填",
  optional: "可选",
  default: (source) => `默认：${source}`,
  clear: "清除选择",
  goesTo: (agent) => `你的答案会在此会话中发给 ${agent}。`,
  sending: "正在发送答案…",
  answered: "答案已发送",
  submit: "提交答案",
  check: "检查投递",
});
// Said when shown, so it follows a language change; other storage errors
// are the browser's own words.
const ONLY_HERE = "only-in-this-window";

type Props = {
  /** Authenticated source Agent + immutable published result ID. */
  identity: string;
  form: ClarificationProps;
  agentName: string;
  /** Delivery facts come from the existing message path, never a UI success timer. */
  delivery?: {
    status: string;
    error?: string | null;
    values?: ClarificationValues;
  };
  blockedReason?: string;
  onSubmit?: (values: ClarificationValues) => Promise<void>;
  onCheck?: () => void;
};
export function Clarification(props: Props) {
  return <Form key={`${props.identity}:${props.form.id}`} {...props} />;
}
function Form({
  identity,
  form,
  agentName,
  delivery,
  blockedReason,
  onSubmit,
  onCheck,
}: Props) {
  const domId = useId();
  const key = clarificationDraftKey(identity, form);
  const composing = useRef(false);
  const inFlight = useRef(false);
  const [initial] = useState(() => {
    try {
      return {
        values: readClarificationDraft(localStorage, key, form),
        error: "",
      };
    } catch (error) {
      return { values: initialClarificationValues(form), error: String(error) };
    }
  });
  const [values, setValues] = useState(initial.values);
  const [storageError, setStorageError] = useState(initial.error);
  const [errors, setErrors] = useState<ClarificationErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const status = delivery?.status;
  const accepted = status === "accepted" || status === "queued";
  const uncertain =
    status === "uncertain" || status === "unknown" || status === "sending";
  const disabled =
    busy || accepted || uncertain || !!blockedReason || !onSubmit;
  const t = useStrings(formText);
  const notice =
    status === "accepted"
      ? t.sent(agentName)
      : status === "queued"
        ? t.queued(agentName)
        : uncertain
          ? t.unconfirmed
          : blockedReason || delivery?.error || failure;

  function change(id: string, value: string | string[]) {
    const next = { ...values, [id]: value };
    setValues(next);
    setErrors((previous) => ({ ...previous, [id]: "" }));
    setFailure("");
    try {
      saveClarificationDraft(localStorage, key, next);
      setStorageError("");
    } catch {
      setStorageError(ONLY_HERE);
    }
  }
  async function submit() {
    if (!onSubmit || disabled || inFlight.current || composing.current) return;
    const problems = validateClarification(form, values);
    setErrors(problems);
    const first = Object.keys(problems)[0];
    if (first) {
      document.getElementById(`${domId}-${first}`)?.focus();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setFailure("");
    try {
      // Capture exactly the values the user explicitly submitted.
      await onSubmit(structuredClone(values));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  return (
    <section
      className="clarification"
      aria-label={form.title}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (!event.nativeEvent.isComposing) event.preventDefault();
        }
      }}
    >
      <header>
        <h4>{form.title}</h4>
        {form.description && <p>{form.description}</p>}
      </header>
      <form onSubmit={(event) => event.preventDefault()} noValidate>
        {form.fields.map((field) => {
          const fieldId = `${domId}-${field.id}`;
          const value = (
            (accepted || uncertain) && delivery?.values
              ? delivery.values
              : values
          )[field.id];
          const descriptionId = `${fieldId}-note`;
          const errorId = `${fieldId}-error`;
          const describedBy = `${descriptionId}${errors[field.id] ? ` ${errorId}` : ""}`;
          return (
            <fieldset
              key={field.id}
              disabled={disabled}
              className="clarification-field"
            >
              <legend>
                {field.label}
                <span>{field.required ? t.required : t.optional}</span>
              </legend>
              <div id={descriptionId} className="clarification-note">
                {field.description && <p>{field.description}</p>}
                {field.default && <p>{t.default(field.default.source)}</p>}
              </div>
              {field.type === "text" ? (
                <textarea
                  id={fieldId}
                  value={String(value || "")}
                  aria-label={field.label}
                  aria-required={field.required}
                  aria-invalid={!!errors[field.id]}
                  aria-describedby={describedBy}
                  placeholder={field.placeholder}
                  rows={2}
                  maxLength={2000}
                  onChange={(event) => change(field.id, event.target.value)}
                />
              ) : (
                <div className="clarification-options">
                  {field.options.map((option, index) => {
                    const selected =
                      field.type === "multi"
                        ? Array.isArray(value) && value.includes(option.id)
                        : value === option.id;
                    return (
                      <label key={option.id} data-selected={selected}>
                        <input
                          id={index === 0 ? fieldId : `${fieldId}-${option.id}`}
                          name={fieldId}
                          type={field.type === "multi" ? "checkbox" : "radio"}
                          value={option.id}
                          checked={selected}
                          aria-describedby={describedBy}
                          aria-invalid={!!errors[field.id]}
                          onChange={() =>
                            change(
                              field.id,
                              field.type === "single"
                                ? option.id
                                : selected
                                  ? (value as string[]).filter(
                                      (id) => id !== option.id,
                                    )
                                  : [...(value as string[]), option.id],
                            )
                          }
                        />
                        <span>
                          <strong>{option.label}</strong>
                          {option.description && (
                            <small>{option.description}</small>
                          )}
                        </span>
                      </label>
                    );
                  })}
                  {field.type === "single" && !field.required && value && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => change(field.id, "")}
                    >
                      {t.clear}
                    </button>
                  )}
                </div>
              )}
              {errors[field.id] && (
                <p id={errorId} className="clarification-error" role="alert">
                  {errors[field.id]}
                </p>
              )}
            </fieldset>
          );
        })}
        {errors.form && <p role="alert">{errors.form}</p>}
        {storageError && (
          <p role="alert" className="clarification-error">
            {storageError === ONLY_HERE ? t.onlyHere : storageError}
          </p>
        )}
        <footer>
          <small>{t.goesTo(agentName)}</small>
          <button
            type="button"
            className="primary-button"
            disabled={disabled}
            onClick={() => void submit()}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : accepted ? (
              <Check size={15} />
            ) : (
              <ArrowRight size={15} />
            )}
            {busy ? t.sending : accepted ? t.answered : t.submit}
          </button>
        </footer>
        {notice && (
          <p className="clarification-delivery" role="status">
            {notice}
          </p>
        )}
        {uncertain && onCheck && (
          <button type="button" className="text-button" onClick={onCheck}>
            {t.check}
          </button>
        )}
      </form>
    </section>
  );
}
