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
  const notice =
    status === "accepted"
      ? `Answers sent to ${agentName}.`
      : status === "queued"
        ? `Sent · waiting for ${agentName} to confirm.`
        : uncertain
          ? "Delivery is unconfirmed. Check the conversation before sending anything again."
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
      setStorageError(
        "This draft is only in this window. Keep it open until your answers are sent.",
      );
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
                <span>{field.required ? "Required" : "Optional"}</span>
              </legend>
              <div id={descriptionId} className="clarification-note">
                {field.description && <p>{field.description}</p>}
                {field.default && <p>Default: {field.default.source}</p>}
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
                      Clear selection
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
            {storageError}
          </p>
        )}
        <footer>
          <small>Your answers go to {agentName} in this conversation.</small>
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
            {busy
              ? "Sending answers…"
              : accepted
                ? "Answers sent"
                : "Submit answers"}
          </button>
        </footer>
        {notice && (
          <p className="clarification-delivery" role="status">
            {notice}
          </p>
        )}
        {uncertain && onCheck && (
          <button type="button" className="text-button" onClick={onCheck}>
            Check delivery
          </button>
        )}
      </form>
    </section>
  );
}
