import { useEffect, useId, useMemo, useRef, useState } from "react";
import { LoaderCircle, MessageSquareReply, RotateCcw, Send, Trash2 } from "lucide-react";
import { errorText, HttpError, shortcutModifier } from "../api";
import { useLanguage, useStrings } from "../i18n";
import type { Agent, MessageReceipt } from "../types";
import { Clarification } from "../intelligent-ui/ClarificationForm";
import {
  clarificationAnswers,
  clarificationDraftKey,
  clarificationSchema,
  saveClarificationDraft,
  type ClarificationProps,
  type ClarificationValues,
} from "../intelligent-ui/clarification";
import { relative } from "./format";
import { dropPendingReply, outboxKey, pendingReply, resendReply, sendReply } from "./home-api";
import { homeText } from "./home-text";
import { draftStore } from "./reply-drafts";
import type { Section } from "./types";

/** Its owner changed the section after the user's reply (an edit keeps it replied). */
export function repliedThenUpdated(section: Section) {
  const at = section.ask?.repliedAt;
  return !!at && Date.parse(section.updatedAt) > Date.parse(at);
}

type ReplyContext = {
  projectId: string;
  workspaceId: string;
  /** The Project's open Agents, any of which can receive the reply. */
  agents: Agent[];
  readOnly: boolean;
  onSent: () => void;
};

/**
 * Why Core refused a reply to an ask before anything was sent (T-9): the ask
 * changed, was resolved or removed since the version the user answered, or
 * this page shows another Workspace or is older than Core expects (an older
 * Core, which does not know the field, says so too).
 */
function askRefusal(error: unknown): "changed" | "resolved" | "removed" | "reload" | null {
  const text = errorText(error);
  if (/^ask_changed:/.test(text)) return "changed";
  if (/^ask_resolved:/.test(text)) return "resolved";
  if (/^section_removed:/.test(text)) return "removed";
  if (/^(workspace_changed|ask_version_required):/.test(text)) return "reload";
  if (error instanceof HttpError && /unknown field `(askVersion|workspaceId)`/.test(text)) return "reload";
  return null;
}

/** One reply slot (a section, or the project), with its retry record. */
function useReply({ projectId, workspaceId, onSent }: ReplyContext, key?: string) {
  const t = useStrings(homeText);
  const slot = outboxKey(workspaceId, projectId, key);
  const [kept] = useState(() => pendingReply(slot));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<MessageReceipt | null>(null);
  /** `askVersion`: the version of the ask this answers, for a reply to one;
   * `shown`: what this window shows as sent, kept with it here only. */
  const send = (agentId: string, text: string, choice?: string, askVersion?: number, shown?: string) =>
    run(askVersion, () => sendReply(slot, projectId, {
      key, agentId, text, choice, shown,
      ...(askVersion !== undefined ? { askVersion, workspaceId } : {}),
    }));
  /** The unconfirmed reply again, exactly as it was sent. */
  const resend = () => run(pendingReply(slot)?.askVersion, () => resendReply(slot, projectId, key));
  async function run(askVersion: number | undefined, go: () => Promise<MessageReceipt>) {
    if (busy) throw new Error("A reply is already being sent.");
    setBusy(true);
    setError("");
    try {
      const value = await go();
      setReceipt(value);
      onSent();
      return value;
    } catch (e) {
      const refused = askVersion !== undefined ? askRefusal(e) : null;
      // An older Core refused the field before reading the reply: never submitted.
      if (refused === "reload" && e instanceof HttpError && e.code !== "message_not_submitted") dropPendingReply(slot);
      setError(refused === "changed" ? t.askChanged : refused === "resolved" ? t.askResolved
        : refused === "removed" ? t.askRemoved : refused === "reload" ? t.askReloadHome : errorText(e));
      // Home reads the ask again, so the question as it is now shows beside the reply kept.
      if (refused === "changed" || refused === "resolved" || refused === "removed") onSent();
      throw e;
    } finally {
      setBusy(false);
    }
  }
  return { send, resend, busy, error, receipt, kept };
}

export function TargetPicker({
  agents,
  value,
  onChange,
  disabled,
  label,
}: {
  agents: Agent[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
  label?: string;
}) {
  const id = useId();
  const t = useStrings(homeText);
  return (
    <span className="home-reply-target">
      <label htmlFor={id}>{label ?? t.sendTo}</label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {!agents.some((a) => a.id === value) && <option value="">{t.chooseAgent}</option>}
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
    </span>
  );
}

/** A text reply; its owner keeps the text and says what a delivery clears. */
function TextReply({
  placeholder,
  text,
  onText,
  disabled,
  held = false,
  busy,
  onSend,
  label,
}: {
  placeholder: string;
  text: string;
  onText: (text: string) => void;
  disabled: boolean;
  /** Not sendable as it is, though it can still be written in. */
  held?: boolean;
  busy: boolean;
  onSend: (text: string) => Promise<unknown>;
  label: string;
}) {
  const t = useStrings(homeText);
  const submit = () => {
    const value = text.trim();
    if (!value || disabled || held || busy) return;
    // The text stays until the reply is delivered.
    onSend(value).catch(() => {});
  };
  return (
    <form
      className="home-text-reply"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        aria-label={label}
        value={text}
        rows={2}
        maxLength={20_000}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button
        type="submit"
        className="primary-button"
        disabled={disabled || held || busy || !text.trim()}
        title={t.sendTitle(shortcutModifier)}
      >
        {busy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
        {t.send}
      </button>
    </form>
  );
}

/** A form reply: readable lines for the Agent, then the stable ids. */
function formText(form: ClarificationProps, values: ClarificationValues) {
  const answers = clarificationAnswers(form).parse(values) as ClarificationValues;
  const lines = form.fields.map((field) => {
    const value = answers[field.id];
    const shown =
      field.type === "text"
        ? String(value || "")
        : (Array.isArray(value) ? value : value ? [value] : [])
            .map((id) => field.options.find((o) => o.id === id)?.label ?? id)
            .join(", ");
    return `- ${field.label}: ${shown || "(no answer)"}`;
  });
  return `Answers to “${form.title}”:\n${lines.join("\n")}\n\n${JSON.stringify({ formId: form.id, answers })}`;
}

/**
 * An Ask's free-text reply not sent yet (T-182), kept apart from card replies:
 * its text, recipient and the version of the ask it was begun on. That version
 * goes with it (T-9): Core sends it only while it is still the ask's version,
 * so a reply begun on one version of the question never goes to another, and
 * this window asks first.
 */
type AskDraft = { key: string; text: string; version: number; agentId: string; at: string };
const askDrafts = draftStore<AskDraft>("yuzuno.home-ask-drafts.v1");

/**
 * The version of the ask a form's answers were begun on (T-9), under the key
 * the form keeps the answers themselves. Like free text, answers begun on
 * one version go to another only once the user says so.
 */
type FormBegun = { version: number; at: string };
const formVersions = draftStore<FormBegun>("yuzuno.home-ask-form-versions.v1");

/**
 * The reply controls an ask section declares. Every one of them sends one
 * user message through Core, to the section's owner unless the user picks
 * another Agent. Nothing here acts on the Agent's behalf.
 */
export function AskReply({ section, ...context }: ReplyContext & { section: Section }) {
  const language = useLanguage();
  const t = homeText(language);
  const ask = section.ask!;
  const reply = ask.reply;
  const { send, resend, busy, error, receipt, kept } = useReply(context, section.key);
  const ownerOpen =
    section.owner.state === "active" && context.agents.some((a) => a.id === section.owner.agentId);
  // Kept once the Workspace is known: another one may hold the same project
  // and key (T-195).
  const slot = outboxKey(context.workspaceId, context.projectId, section.key);
  const stored = () => (context.workspaceId ? askDrafts.load()[slot] ?? null : null);
  // An unconfirmed send is not a draft: it goes again only as it was, from
  // its own record (below).
  const [draft, setDraft] = useState<AskDraft | null>(stored);
  const latest = useRef(draft);
  const [restored, setRestored] = useState(() => !!draft?.at && !!draft.text.trim());
  const [onlyHere, setOnlyHere] = useState(false);
  const [target, setTarget] = useState(
    () => (draft?.text.trim() && draft.agentId) || kept?.agentId || (ownerOpen ? section.owner.agentId : ""),
  );
  // The Workspace arrived after this was drawn: its draft, unless one is being written.
  const [shownSlot, setShownSlot] = useState(slot);
  if (shownSlot !== slot) {
    setShownSlot(slot);
    if (!latest.current?.text.trim()) {
      const found = stored();
      latest.current = found;
      setDraft(found);
      setRestored(!!found?.text.trim());
      // And its recipient, as the user chose it.
      if (found?.text.trim() && found.agentId) setTarget(found.agentId);
    }
  }
  function keep(next: AskDraft | null) {
    latest.current = next;
    setDraft(next);
    if (context.workspaceId) setOnlyHere(!askDrafts.save(slot, next?.text.trim() ? next : null));
  }
  // Always to the recipient on screen: one chosen while the text was empty
  // goes with what is written next.
  const write = (patch: Partial<AskDraft>) =>
    keep({
      ...(latest.current ?? { key: section.key, text: "", version: section.version }),
      agentId: target,
      ...patch,
      at: new Date().toISOString(),
    });
  // Emptied, it begins again at the version on screen.
  const writeText = (text: string) => write(text.trim() ? { text } : { text, version: section.version });
  const pickTarget = (agentId: string) => {
    setTarget(agentId);
    if (latest.current?.text.trim()) write({ agentId });
  };
  // An unconfirmed send (from before a reload, or one that failed here) goes
  // again only as it was, from its own record: the same version, words and
  // client id, whatever the screen shows now (T-9). Core then finds it
  // delivered, or refuses it and sends nothing. Until it is sent again or
  // discarded, nothing else is sent from here; drafts can still be written.
  const pending = busy ? undefined : pendingReply(slot);
  // Being sent again: still shown, its two actions held, until Core answers.
  const [resending, setResending] = useState<ReturnType<typeof pendingReply>>(undefined);
  const unconfirmed = pending ?? resending;
  const [wholePreview, setWholePreview] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  // Begun on another version of the ask: sent only once the user says which.
  const otherVersion = !!draft?.text.trim() && draft.version !== section.version;
  const [again, setAgain] = useState(false);
  // The version this window replied to: a later version from the owner
  // (for example a reopened question) asks again.
  const [sentVersion, setSentVersion] = useState<number | null>(null);
  const [sentText, setSentText] = useState("");
  const form = useMemo(() => {
    if (!reply.form) return null;
    const parsed = clarificationSchema.safeParse(reply.form);
    return parsed.success ? parsed.data : undefined;
  }, [reply.form]);
  // The form saves its answers under this identity and key, the form's own;
  // the version they were begun on is kept under the same key. A discard
  // starts the form afresh.
  const formIdentity = `home:${context.workspaceId}:${context.projectId}:${section.key}`;
  const formKey = form && context.workspaceId ? clarificationDraftKey(formIdentity, form) : null;
  const [formEpoch, setFormEpoch] = useState(0);
  // Read again whenever the form changes: the answers it saved and their version.
  const [, setFormEdits] = useState(0);
  // What this window set, for the form it set it on (its key, or its ID
  // before the Workspace is known, T-195): this browser keeps it if it can,
  // and this window keeps it whether or not it could.
  const formRef = formKey ?? (form ? `id:${form.id}` : "");
  const begunHere = useRef<{ form: string; version: number | null } | null>(null);
  const formBegun = !form ? null
    : begunHere.current?.form === formRef ? begunHere.current.version
    : formKey ? formVersions.load()[formKey]?.version ?? null
    : null;
  function setFormBegun(version: number | null) {
    if (!form) return;
    begunHere.current = { form: formRef, version };
    if (formKey) formVersions.save(formKey, version === null ? null : { version, at: new Date().toISOString() });
    setFormEdits((n) => n + 1);
  }
  // Learning the Workspace keeps what was begun before it, as the form keeps
  // the answers; another Workspace's form has its own.
  useEffect(() => {
    const here = begunHere.current;
    if (!formKey || !form || here?.form !== `id:${form.id}`) return;
    begunHere.current = { form: formKey, version: here.version };
    formVersions.save(formKey, here.version === null ? null : { version: here.version, at: new Date().toISOString() });
    setFormEdits((n) => n + 1);
  }, [formKey, form]);
  // Written in or sent from this form as it is mounted, even if this browser
  // could not keep that.
  const formTouched = useRef(false);
  // Begun on the version on screen when first changed.
  function formChanged(target: EventTarget) {
    if (!form || !(target as HTMLElement).closest?.(".clarification")) return;
    formTouched.current = true;
    // Answers of an unknown version stay so when changed: only Refer or
    // Discard settles them.
    if (formBegun === null && !formUnknown) setFormBegun(section.version);
    else setFormEdits((n) => n + 1);
  }
  function discardForm() {
    try {
      if (formKey) localStorage.removeItem(formKey);
    } catch {
      /* The form below starts afresh all the same. */
    }
    formTouched.current = false;
    setFormBegun(null);
    setFormEpoch((n) => n + 1);
  }
  // A form nobody wrote in or sent from shows the question as it is now: a
  // newer one under the same ID brings its own fields and defaults, and the
  // form starts afresh with them. Answers begun or sent here keep theirs.
  const formShape = form ? JSON.stringify(form) : "";
  const [shownShape, setShownShape] = useState(formShape);
  if (shownShape !== formShape) {
    setShownShape(formShape);
    if (formBegun === null && !formTouched.current) setFormEpoch((n) => n + 1);
  }
  // Answers this browser kept without the version they were begun on (that
  // record went, or they are older than it) are never taken for this
  // version's. A form at its defaults has none kept.
  let formSaved = false;
  try {
    formSaved = !!formKey && localStorage.getItem(formKey) !== null;
  } catch {
    formSaved = false;
  }
  const formUnknown = !!form && formBegun === null && formSaved;
  const formOtherVersion = !!form && formBegun !== null && formBegun !== section.version;
  // A reply that went again as an unconfirmed one, and Core found it
  // delivered before: that earlier version of the ask, not this one.
  const [sentBefore, setSentBefore] = useState<number | null>(null);
  // Shown as replied from Core's record, or from this window's delivery until
  // Core's next read. Only the owner resolves it.
  const replied =
    !again && (ask.state === "replied" || (!!receipt && sentVersion === section.version));
  // Only one of the project's open Agents takes it: a kept reply's recipient
  // may have left since.
  const targetOpen = context.agents.some((a) => a.id === target);
  const disabled = context.readOnly || !targetOpen;
  const targetName = context.agents.find((a) => a.id === target)?.name || section.owner.name;
  const freeText = reply.freeText;
  const prompt = typeof freeText === "object" && freeText.prompt ? freeText.prompt : t.writeReply;
  // `shown` is what this window shows as sent until Core's next read;
  // `version` is the version of the ask it answers, as the user saw it.
  const deliver = async (text: string, choice: string | undefined, shown: string, version: number) => {
    setSentBefore(null);
    setDiscarded(false);
    const value = await send(target, text, choice, version, shown);
    setSentVersion(version);
    setSentText(shown);
    setAgain(false);
    return value;
  };
  // What an unconfirmed reply said, as it went: what this window showed as
  // sent (a form's answers without their ids), never the ask as it is now.
  const previewOf = (was: { choice?: string; text: string; shown?: string }) =>
    (was.shown ?? (was.text || was.choice || "")).replace(/\n\n\{[\s\S]*\}$/, "").trim();
  // The unconfirmed reply again, exactly as it was sent.
  const sendAgain = async () => {
    const was = pendingReply(slot);
    if (!was) return;
    setSentBefore(null);
    setResending(was);
    try {
      await resend();
    } catch {
      return;
    } finally {
      setResending(undefined);
    }
    const version = was.askVersion ?? null;
    setSentVersion(version);
    setSentText(previewOf(was));
    setAgain(false);
    // Delivered to an earlier version of the ask: this one is still open.
    if (version !== null && version !== section.version) setSentBefore(version);
    // The draft that reply was sent from goes with it; one written since is
    // newer, whatever its words, and stays.
    const written = latest.current;
    if (!was.choice && written && written.text.trim() === was.text && was.sentAt && written.at
      && Date.parse(written.at) <= Date.parse(was.sentAt)) {
      keep(null);
      setRestored(false);
    }
  };
  // Forgotten here; Core may have it already, and this says so.
  const discardPending = () => {
    dropPendingReply(slot);
    setSentBefore(null);
    setDiscarded(true);
  };
  // A pick sends only its id: Core quotes the label, and text would repeat it.
  const pick = (id: string, label: string) => void deliver("", id, label, section.version).catch(() => {});
  if (replied)
    return (
      <div className="home-ask-replied" role="status">
        <MessageSquareReply size={14} />
        <div>
          <strong>{t.repliedWaiting(ask.state === "replied" ? section.owner.name : targetName)}</strong>
          {(ask.replyText || sentText) && <p>{ask.replyText || sentText}</p>}
          {ask.state === "replied" && repliedThenUpdated(section) && (
            <p className="home-ask-updated">{t.updatedAfterReply(section.owner.name, relative(section.updatedAt, language))}</p>
          )}
          {!!draft?.text.trim() && <p className="home-note">{t.askDraftAfterReply}</p>}
        </div>
        {!context.readOnly && (
          <button type="button" className="quiet-button" onClick={() => setAgain(true)}>
            {t.replyAgain}
          </button>
        )}
      </div>
    );
  return (
    <div
      className="home-ask-reply"
      onChangeCapture={(event) => formChanged(event.target)}
      onClickCapture={(event) => {
        // Clearing a choice changes the answers too.
        if ((event.target as HTMLElement).closest?.(".clarification-options button")) formChanged(event.target);
      }}
    >
      <TargetPicker
        agents={context.agents}
        value={target}
        onChange={pickTarget}
        disabled={context.readOnly || busy}
      />
      {!ownerOpen && (
        <p className="home-note">
          {t.chooseAskRecipient(section.owner.name, section.owner.state === "active" ? t.askNotInProject : t.askOwnerState(section.owner.state))}
        </p>
      )}
      {unconfirmed && (() => {
        const preview = previewOf(unconfirmed);
        const long = preview.length > 240;
        return (
          <div className="home-kept-reply home-ask-unconfirmed" role="status">
            {/* One run of text, so a narrow card wraps it as a sentence. */}
            <p className="home-note">
              <span>
                <strong>{t.askPendingTitle}</strong>
                {unconfirmed.askVersion !== undefined && ` ${t.askPendingVersion(unconfirmed.askVersion)}`}
              </span>
            </p>
            <blockquote>{long && !wholePreview ? `${preview.slice(0, 239)}…` : preview}</blockquote>
            {long && (
              <button type="button" className="inline-link" onClick={() => setWholePreview((whole) => !whole)}>
                {wholePreview ? t.showLess : t.showMore}
              </button>
            )}
            <p className="home-note">{t.askPendingMayHave}</p>
            <div className="home-ask-options" role="group" aria-label={t.askPendingTitle}>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void sendAgain()}>
                {resending ? <LoaderCircle size={13} className="spin" /> : <RotateCcw size={13} />}
                {resending ? t.sending : t.askRetryPrevious}
              </button>
              <button type="button" className="quiet-button" disabled={busy} onClick={discardPending}>
                <Trash2 size={13} /> {t.askClearPending}
              </button>
            </div>
          </div>
        );
      })()}
      {discarded && !pending && <p className="home-note" role="status">{t.askUnconfirmedDiscarded}</p>}
      {sentBefore !== null && sentBefore !== section.version && (
        <p className="home-note" role="status">{t.askSentBefore(sentBefore, section.version)}</p>
      )}
      {reply.options && reply.options.length > 0 && (
        <div className="home-ask-options" role="group" aria-label={t.replyOptions}>
          {reply.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="secondary-button"
              disabled={disabled || busy || !!pending}
              onClick={() => pick(option.id, option.label)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {reply.choice && (
        <div className="home-ask-choice" role="group" aria-label={t.chooseOne}>
          {(["a", "b"] as const).map((side) => {
            const option = reply.choice![side];
            return (
              <div className="home-choice" key={side}>
                <strong>{option.label}</strong>
                {option.detail && <p>{option.detail}</p>}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={disabled || busy || !!pending}
                  onClick={() => pick(option.id, `I choose: ${option.label}`)}
                >
                  {t.choose(side.toUpperCase())}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {form && formUnknown && !pending && (
        <div className="home-kept-reply home-ask-unknown" role="status">
          <p className="home-note">{t.askAnswersVersionUnknown}</p>
          <div className="home-ask-options" role="group" aria-label={t.askAnswersVersionUnknown}>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setFormBegun(section.version)}>
              {t.askUseForCurrent}
            </button>
            <button type="button" className="quiet-button" disabled={busy} onClick={discardForm}>
              <Trash2 size={13} /> {t.askClearOldAnswers}
            </button>
          </div>
        </div>
      )}
      {form ? (
        <>
          <Clarification
            identity={formEpoch ? `${formIdentity}#${formEpoch}` : formIdentity}
            // Home's reply drafts already name their Workspace; this keeps the
            // key they are saved under exactly as it was (T-195).
            draftIdentity={context.workspaceId ? formIdentity : null}
            form={form}
            agentName={targetName}
            blockedReason={
              !targetOpen
                ? "Choose who should get the reply."
                : pending
                  ? t.askUnconfirmedFirst
                  : formOtherVersion && formBegun !== null
                    ? t.askDraftOtherVersion(formBegun, section.version)
                    : formUnknown
                      ? t.askUseOrClearFirst
                      : undefined
            }
            // Its delivery is that of the version it answered.
            delivery={receipt && sentVersion === section.version ? { status: receipt.status, error: receipt.error } : undefined}
            onSubmit={context.readOnly ? undefined : async (values) => {
              const text = formText(form, values);
              // Sent, the answers are this version's, defaults included: kept
              // as written ones are, for a retry and against a newer question.
              formTouched.current = true;
              try {
                if (formKey) saveClarificationDraft(localStorage, formKey, values);
              } catch {
                /* Kept on screen in this window all the same. */
              }
              if (formBegun === null) setFormBegun(section.version);
              await deliver(text, undefined, text, section.version);
            }}
          />
          {formOtherVersion && !pending && (
            <p className="home-note home-ask-draft-note">
              <button type="button" className="inline-link" disabled={busy} onClick={() => setFormBegun(section.version)}>
                {t.referTo(section.version)}
              </button>{" "}
              <button type="button" className="inline-link" disabled={busy} onClick={discardForm}>
                {t.discard}
              </button>
            </p>
          )}
        </>
      ) : form === undefined ? (
        <p className="home-note">{t.formUnavailable}</p>
      ) : null}
      {/* Always offered, whatever the ask declares: answering in your own
          words is yours, not something an Agent turns on with `freeText`,
          which only names the field. Core takes text for any ask, with or
          without a choice (project_brief/home.rs). */}
      {otherVersion && draft && !pending ? (
        <p className="home-note home-ask-draft-note" role="status">
          {t.askDraftOtherVersion(draft.version, section.version)}{" "}
          <button type="button" className="inline-link" disabled={busy} onClick={() => write({ version: section.version })}>
            {t.referTo(section.version)}
          </button>{" "}
          <button type="button" className="inline-link" disabled={busy} onClick={() => keep(null)}>
            {t.discard}
          </button>
        </p>
      ) : (
        restored && !!draft?.text.trim() && <p className="home-note">{t.askDraftKept(draft.version)}</p>
      )}
      <TextReply
        label={t.replyField(section.title)}
        placeholder={prompt}
        text={draft?.text ?? ""}
        onText={writeText}
        disabled={disabled}
        held={otherVersion || !!pending}
        busy={busy}
        onSend={async (text) => {
          // The version it was begun on, which is the one on screen.
          await deliver(text, undefined, text, latest.current?.version ?? section.version);
          // Only what was sent leaves: anything written while it was being sent stays.
          if (!latest.current || latest.current.text.trim() === text) keep(null);
          setRestored(false);
        }}
      />
      {onlyHere && <p className="home-note">{t.askDraftOnlyHere}</p>}
      {busy && <p className="home-note" role="status">{t.sending}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  );
}

/**
 * A reply to the project as a whole. Without a Brief Steward (slice 1) the
 * user picks which of the project's Agents gets it.
 */
export function ProjectReply(context: ReplyContext & { projectName: string }) {
  const t = useStrings(homeText);
  const { send, busy, error, receipt, kept } = useReply(context);
  const [target, setTarget] = useState(kept?.agentId || "");
  const [text, setText] = useState(kept?.text || "");
  const [open, setOpen] = useState(!!kept);
  if (!context.agents.length) return null;
  if (!open)
    return (
      <button type="button" className="quiet-button home-project-reply-open" onClick={() => setOpen(true)} disabled={context.readOnly}>
        <MessageSquareReply size={13} />
        {t.replyToProject}
      </button>
    );
  return (
    <div className="home-project-reply">
      <TargetPicker agents={context.agents} value={target} onChange={setTarget} disabled={context.readOnly || busy} />
      {kept && <p className="home-note">{t.notConfirmed}</p>}
      <TextReply
        label={t.replyField(context.projectName)}
        placeholder={t.projectMessage}
        text={text}
        onText={setText}
        disabled={context.readOnly || !target}
        busy={busy}
        onSend={(value) => send(target, value).then(() => setText(""))}
      />
      {receipt && !error && (
        <p className="home-note" role="status">
          {t.sentToAgent(context.agents.find((a) => a.id === target)?.name || t.theAgent)}
        </p>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  );
}
