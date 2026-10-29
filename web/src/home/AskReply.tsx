import { useId, useMemo, useRef, useState } from "react";
import { LoaderCircle, MessageSquareReply, Send } from "lucide-react";
import { errorText, shortcutModifier } from "../api";
import { useLanguage, useStrings } from "../i18n";
import type { Agent, MessageReceipt } from "../types";
import { Clarification } from "../intelligent-ui/ClarificationForm";
import {
  clarificationAnswers,
  clarificationSchema,
  type ClarificationProps,
  type ClarificationValues,
} from "../intelligent-ui/clarification";
import { relative } from "./format";
import { outboxKey, pendingReply, sendReply } from "./home-api";
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

/** One reply slot (a section, or the project), with its retry record. */
function useReply({ projectId, workspaceId, onSent }: ReplyContext, key?: string) {
  const slot = outboxKey(workspaceId, projectId, key);
  const [kept] = useState(() => pendingReply(slot));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<MessageReceipt | null>(null);
  async function send(agentId: string, text: string, choice?: string) {
    if (busy) throw new Error("A reply is already being sent.");
    setBusy(true);
    setError("");
    try {
      const value = await sendReply(slot, projectId, { key, agentId, text, choice });
      setReceipt(value);
      onSent();
      return value;
    } catch (e) {
      setError(errorText(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }
  return { send, busy, error, receipt, kept };
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
 * its text, recipient and the version of the ask it was begun on. Core answers
 * the ask as it is when a reply arrives, so the version is never sent: it only
 * makes this window ask before a reply begun on one version of the question
 * goes to another.
 */
type AskDraft = { key: string; text: string; version: number; agentId: string; at: string };
const askDrafts = draftStore<AskDraft>("yuzuno.home-ask-drafts.v1");

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
  const { send, busy, error, receipt, kept } = useReply(context, section.key);
  const ownerOpen =
    section.owner.state === "active" && context.agents.some((a) => a.id === section.owner.agentId);
  // Kept once the Workspace is known: another one may hold the same project
  // and key (T-195).
  const slot = outboxKey(context.workspaceId, context.projectId, section.key);
  const stored = () => (context.workspaceId ? askDrafts.load()[slot] ?? null : null);
  const [draft, setDraft] = useState<AskDraft | null>(() => {
    const found = stored();
    if (found || !kept?.text || kept.choice) return found;
    // An unconfirmed send's text, for its retry: kept here once changed.
    return { key: section.key, text: kept.text, version: section.version, agentId: kept.agentId, at: "" };
  });
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
  // `shown` is what this window shows as sent until Core's next read.
  const deliver = async (text: string, choice?: string, shown = text) => {
    const version = section.version;
    const value = await send(target, text, choice);
    setSentVersion(version);
    setSentText(shown);
    setAgain(false);
    return value;
  };
  // A pick sends only its id: Core quotes the label, and text would repeat it.
  const pick = (id: string, label: string) => void deliver("", id, label).catch(() => {});
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
    <div className="home-ask-reply">
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
      {kept && <p className="home-note">{t.notConfirmedHere}</p>}
      {reply.options && reply.options.length > 0 && (
        <div className="home-ask-options" role="group" aria-label={t.replyOptions}>
          {reply.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="secondary-button"
              disabled={disabled || busy}
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
                  disabled={disabled || busy}
                  onClick={() => pick(option.id, `I choose: ${option.label}`)}
                >
                  {t.choose(side.toUpperCase())}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {form ? (
        <Clarification
          identity={`home:${context.workspaceId}:${context.projectId}:${section.key}`}
          // Home's reply drafts already name their Workspace; this keeps the
          // key they are saved under exactly as it was (T-195).
          draftIdentity={
            context.workspaceId
              ? `home:${context.workspaceId}:${context.projectId}:${section.key}`
              : null
          }
          form={form}
          agentName={targetName}
          blockedReason={!targetOpen ? "Choose who should get the reply." : undefined}
          delivery={receipt ? { status: receipt.status, error: receipt.error } : undefined}
          onSubmit={context.readOnly ? undefined : async (values) => {
            await deliver(formText(form, values));
          }}
        />
      ) : form === undefined ? (
        <p className="home-note">{t.formUnavailable}</p>
      ) : null}
      {/* Always offered, whatever the ask declares: answering in your own
          words is yours, not something an Agent turns on with `freeText`,
          which only names the field. Core takes text for any ask, with or
          without a choice (project_brief/home.rs). */}
      {otherVersion && draft ? (
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
        held={otherVersion}
        busy={busy}
        onSend={async (text) => {
          await deliver(text);
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
