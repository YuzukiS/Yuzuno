import { useId, useMemo, useState } from "react";
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

function TextReply({
  placeholder,
  initial,
  disabled,
  busy,
  onSend,
  label,
}: {
  placeholder: string;
  initial: string;
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => Promise<unknown>;
  label: string;
}) {
  const t = useStrings(homeText);
  const [text, setText] = useState(initial);
  const submit = () => {
    const value = text.trim();
    if (!value || disabled || busy) return;
    // The text stays until the reply is delivered.
    onSend(value).then(() => setText(""), () => {});
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
        onChange={(event) => setText(event.target.value)}
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
        disabled={disabled || busy || !text.trim()}
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
  const [target, setTarget] = useState(() => kept?.agentId || (ownerOpen ? section.owner.agentId : ""));
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
  const disabled = context.readOnly || !target;
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
        onChange={setTarget}
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
          blockedReason={!target ? "Choose who should get the reply." : undefined}
          delivery={receipt ? { status: receipt.status, error: receipt.error } : undefined}
          onSubmit={context.readOnly ? undefined : async (values) => {
            await deliver(formText(form, values));
          }}
        />
      ) : form === undefined ? (
        <p className="home-note">{t.formUnavailable}</p>
      ) : null}
      {(freeText || form === undefined || (!reply.options?.length && !reply.choice && !form)) && (
        <TextReply
          label={t.replyField(section.title)}
          placeholder={prompt}
          initial={kept?.text && !kept.choice ? kept.text : ""}
          disabled={disabled}
          busy={busy}
          onSend={(text) => deliver(text)}
        />
      )}
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
        initial={kept?.text || ""}
        disabled={context.readOnly || !target}
        busy={busy}
        onSend={(text) => send(target, text)}
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
