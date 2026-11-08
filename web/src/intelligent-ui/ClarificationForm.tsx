import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Check, Clock, LoaderCircle } from "lucide-react";
import {
  carryClarification,
  clarificationDraftKey,
  initialClarificationValues,
  readClarificationDraft,
  saveClarificationDraft,
  validateClarification,
  type CarryNote,
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
  waiting: "Sent · waiting",
  submit: "Submit answers",
  check: "Check delivery",
  // Answers carried to a newer version of the form (YN-38), said on the field.
  dropped: (labels: string) => `No longer offered: ${labels}. Choose again.`,
  changed: "This question changed after you answered it. Answer it again.",
  reworded: "Reworded after you answered. Check your answer.",
  added: "New since you began answering.",
  gone: (label: string) => `No longer asked: “${label}”. That answer won't be sent.`,
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
  waiting: "已发送 · 等待中",
  submit: "提交答案",
  check: "检查投递",
  dropped: (labels) => `已不再提供：${labels}。请重新选择。`,
  changed: "你回答之后，这个问题变了。请重新回答。",
  reworded: "你回答之后措辞有改动。请检查你的答案。",
  added: "你开始回答之后新加的问题。",
  gone: (label) => `不再询问：“${label}”。那个答案不会发送。`,
});
// Said when shown, so it follows a language change; other storage errors
// are the browser's own words.
const ONLY_HERE = "only-in-this-window";

type Props = {
  /** Authenticated source Agent + immutable published result ID. */
  identity: string;
  /**
   * Where unsent answers may be saved, or `null` to keep them in this window
   * only (T-195). It must say which Workspace they belong to: two saved
   * Workspaces can sit at one address and their Agents can share an id, so a
   * key without one handed each Workspace the other's unsent answers.
   *
   * `null` is for a form that has no Workspace to be attributed to: one that
   * cannot be answered at all, and one shown before this window knows which
   * Workspace it is in. Separate from `identity`, which React keys this form
   * by, so learning the Workspace does not throw away what is on screen.
   */
  draftIdentity: string | null;
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
  /**
   * The answers follow a newer version of this form (YN-38, Home's asks):
   * when `form` changes under them, or saved ones were given on another
   * version, they are carried to it by field and option ID
   * (carryClarification), and what changed is said on each field until the
   * user answers it again. Without it a form never changes under its
   * answers, and saved answers that don't fit it are not restored.
   */
  carry?: boolean;
  /** With `carry`: the form the saved answers were given on, when known. */
  basis?: ClarificationProps | null;
  /** With `carry`: the answers were carried to `form` in this window. */
  onCarry?: () => void;
};
export function Clarification(props: Props) {
  return <Form key={`${props.identity}:${props.form.id}`} {...props} />;
}
function Form({
  draftIdentity,
  form,
  agentName,
  delivery,
  blockedReason,
  onSubmit,
  onCheck,
  carry = false,
  basis = null,
  onCarry,
}: Props) {
  const domId = useId();
  const key = draftIdentity && clarificationDraftKey(draftIdentity, form);
  const composing = useRef(false);
  const inFlight = useRef(false);
  // The answers saved under `to`, as this form now asks: carried from the
  // form they were given on when that may be another version.
  type Read = { values: ClarificationValues; notes: CarryNote[]; carried: boolean };
  const read = (to: string): Read => {
    if (carry) {
      const raw = localStorage.getItem(to);
      const saved = raw === null ? null : JSON.parse(raw);
      if (saved?.version === 1 && basis && JSON.stringify(basis) !== JSON.stringify(form))
        return { ...carryClarification(basis, form, saved.values), carried: true };
      try {
        return { values: readClarificationDraft(localStorage, to, form), notes: [], carried: false };
      } catch (error) {
        // Given on a version that is not known here: what still fits.
        if (saved?.version === 1) return { ...carryClarification(null, form, saved.values), carried: true };
        throw error;
      }
    }
    return { values: readClarificationDraft(localStorage, to, form), notes: [], carried: false };
  };
  const [initial] = useState((): Read & { error: string } => {
    if (!key) return { values: initialClarificationValues(form), error: "", notes: [], carried: false };
    try {
      return { ...read(key), error: "" };
    } catch (error) {
      return { values: initialClarificationValues(form), error: String(error), notes: [], carried: false };
    }
  });
  const [values, setValues] = useState(initial.values);
  const [notes, setNotes] = useState(initial.notes);
  const [storageError, setStorageError] = useState(initial.error);
  const [errors, setErrors] = useState<ClarificationErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  // Which key the answers on screen belong to. Learning the Workspace after
  // this form was shown (none -> a key) keeps what is on screen, which is the
  // person's own newer answer, and saves it. Moving to a different
  // Workspace's key is a different Workspace's form: its own saved answers
  // are read, and nothing carries over from the one before it (T-195).
  const belongTo = useRef(key);
  const typed = useRef(false);
  // Which form-state a submission in flight belongs to. Learning the
  // Workspace keeps the state on screen, so a submission made before it was
  // known is still this form's and must still settle: its number does not
  // change. Moving to another Workspace's key replaces the state, so it
  // does, and the submission that was running settles nothing here.
  const generation = useRef(0);
  useEffect(() => {
    if (!key || belongTo.current === key) return;
    // Learning the Workspace for the first time is the same form becoming
    // attributable. Going from one key to another is a different Workspace's
    // form, which is where what is on screen, and anything still running for
    // it, stops being this one's.
    const sameForm = belongTo.current === null;
    // What is on screen is only carried over when the person typed it; with
    // nothing typed, this key's own saved answers are read.
    const keep = sameForm && typed.current;
    belongTo.current = key;
    if (!sameForm) generation.current += 1;
    try {
      if (keep) saveClarificationDraft(localStorage, key, values);
      else {
        typed.current = false;
        const found = read(key);
        setValues(found.values);
        setNotes(found.notes);
        setErrors({});
      }
      if (!sameForm) {
        // A submission of the Workspace before this one cannot leave this
        // form busy or showing its refusal.
        inFlight.current = false;
        setBusy(false);
        setFailure("");
      }
      setStorageError("");
    } catch (error) {
      setStorageError(keep ? ONLY_HERE : String(error));
    }
  }, [key, form, values]);
  // A newer version of the form under the answers on screen (YN-38): they
  // are carried to it before it is painted, and saved as its answers.
  // Saved answers carried as this form opened: saved as this version's.
  useEffect(() => {
    if (!initial.carried || !key) return;
    try {
      saveClarificationDraft(localStorage, key, initial.values);
    } catch {
      setStorageError(ONLY_HERE);
    }
    onCarry?.();
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const shape = JSON.stringify(form);
  const shown = useRef({ shape, form });
  useLayoutEffect(() => {
    const before = shown.current;
    if (before.shape === shape) return;
    shown.current = { shape, form };
    if (!carry) return;
    const next = carryClarification(before.form, form, values);
    setValues(next.values);
    // What an earlier change said stays until its field is answered again.
    const same = (a: CarryNote, b: CarryNote) =>
      a.kind === b.kind && (a.kind === "gone" && b.kind === "gone" ? a.label === b.label : a.field === b.field);
    setNotes((kept) => [
      ...kept.filter(
        (note) =>
          (note.kind === "gone" || form.fields.some((field) => field.id === note.field)) &&
          !next.notes.some((newer) => same(note, newer)),
      ),
      ...next.notes,
    ]);
    setErrors({});
    setFailure("");
    if (key)
      try {
        saveClarificationDraft(localStorage, key, next.values);
      } catch {
        setStorageError(ONLY_HERE);
      }
    onCarry?.();
    // Only as the form changes; what it carries is the answers on screen then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);
  const status = delivery?.status;
  // Three judgments from one receipt (T-19 CX-75/76). From the send on,
  // short of a refusal, the form is locked and shows the answers sent. Only
  // `accepted` reads as success; `queued` is sent and waiting; only
  // `uncertain` or `unknown` is unconfirmed, with Check delivery. A send
  // still on its way is said as sending.
  const sending = status === "sending";
  const queued = status === "queued";
  const accepted = status === "accepted";
  const uncertain = status === "uncertain" || status === "unknown";
  const submitted = sending || queued || accepted || uncertain;
  const disabled = busy || submitted || !!blockedReason || !onSubmit;
  const t = useStrings(formText);
  const notice = accepted
    ? t.sent(agentName)
    : queued
      ? t.queued(agentName)
      : uncertain
        ? t.unconfirmed
        : sending
          ? ""
          : blockedReason || delivery?.error || failure;

  function change(id: string, value: string | string[]) {
    const next = { ...values, [id]: value };
    setValues(next);
    setErrors((previous) => ({ ...previous, [id]: "" }));
    // Answered again: what changed under it has been seen to.
    setNotes((kept) => kept.filter((note) => note.field !== id));
    setFailure("");
    typed.current = true;
    // Nothing is written while there is no Workspace to attribute this to.
    // The answers stay on screen, and reach disk as soon as there is one.
    if (!key) return;
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
    // This submission belongs to the form-state these answers were typed in.
    // If the Core at this address answers as another Workspace while it runs,
    // its refusal is not that Workspace's to show and must not leave that
    // Workspace's form busy (T-195): the move resets those itself. Learning
    // the Workspace for the first time is not such a move -- the answers and
    // this submission are the same ones -- so it still settles here.
    const from = generation.current;
    inFlight.current = true;
    setBusy(true);
    setFailure("");
    try {
      // Capture exactly the values the user explicitly submitted.
      await onSubmit(structuredClone(values));
      if (generation.current === from) setNotes([]);
    } catch (error) {
      if (generation.current === from)
        setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation.current === from) {
        setBusy(false);
        inFlight.current = false;
      }
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
        {notes.map((note) =>
          note.kind === "gone" ? (
            <p key={`gone:${note.label}`} className="clarification-carried" role="status">
              {t.gone(note.label)}
            </p>
          ) : null,
        )}
        {form.fields.map((field) => {
          const fieldId = `${domId}-${field.id}`;
          const value = (
            submitted && delivery?.values
              ? delivery.values
              : values
          )[field.id];
          const descriptionId = `${fieldId}-note`;
          const errorId = `${fieldId}-error`;
          const carriedId = `${fieldId}-carried`;
          const carried = notes.filter((note) => note.field === field.id);
          const describedBy = `${descriptionId}${carried.length ? ` ${carriedId}` : ""}${errors[field.id] ? ` ${errorId}` : ""}`;
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
              {carried.length > 0 && (
                <div id={carriedId} className="clarification-carried" role="status">
                  {carried.map((note) => (
                    <p key={note.kind}>
                      {note.kind === "dropped"
                        ? t.dropped(note.labels.map((label) => `“${label}”`).join(", "))
                        : note.kind === "changed"
                          ? t.changed
                          : note.kind === "reworded"
                            ? t.reworded
                            : t.added}
                    </p>
                  ))}
                </div>
              )}
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
            {busy || sending ? (
              <LoaderCircle size={15} className="spin" />
            ) : accepted ? (
              <Check size={15} />
            ) : queued ? (
              <Clock size={15} />
            ) : (
              <ArrowRight size={15} />
            )}
            {busy || sending ? t.sending : accepted ? t.answered : queued ? t.waiting : t.submit}
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
