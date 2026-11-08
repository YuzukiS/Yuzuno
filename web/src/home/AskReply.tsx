import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, MessageSquareReply, RotateCcw, Send, Trash2 } from "lucide-react";
import { errorText, HttpError, shortcutModifier } from "../api";
import { useLanguage, useStrings } from "../i18n";
import { useSurfaceIn } from "../surface";
import { returnKey, returnSends, useDevicePreferences } from "../device-preferences";
import { touchKeyboard } from "../touch-input";
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
import { dropPendingReply, latestSection, outboxKey, pendingReply, resendReply, sendReply, type HomeReplyInput } from "./home-api";
import { homeText } from "./home-text";
import { draftStore } from "./reply-drafts";
import { repliedThenUpdated } from "./brief-layout";
import type { Section } from "./types";

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
  if (error instanceof HttpError && /unknown field `(askVersion|workspaceId|form)`/.test(text)) return "reload";
  return null;
}

/** One reply to an ask (T-9): what it says, and the version of the ask it
 * answers. `shown` is what this window shows as sent, kept with it here only. */
type AskSend = { text: string; choice?: string; shown: string; askVersion: number; form?: HomeReplyInput["form"] };

/** The same reply to the ask as Core has it now, when it still answers the
 * same thing there (YN-38), or null: then nothing more is sent. */
type Follow = (now: Section) => AskSend | null;

/** One reply slot (a section, or the project), with its retry record. */
function useReply({ projectId, workspaceId, onSent }: ReplyContext, key?: string) {
  const t = useStrings(homeText);
  const slot = outboxKey(workspaceId, projectId, key);
  const [kept] = useState(() => pendingReply(slot));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<MessageReceipt | null>(null);
  /** A reply to the project as a whole. */
  const send = (agentId: string, text: string) =>
    run(false, async () => {
      const value = await sendReply(slot, projectId, { key, agentId, text });
      setReceipt(value);
      onSent();
      return value;
    });
  /**
   * A reply to an ask, to the version in `reply` (YN-38: always the one on
   * screen). Refused because that is no longer the ask's latest version, it
   * reads the ask as Core has it now and sends `follow`'s reply to it, as a
   * new message: Core never had the refused one. Resolves to the version it
   * went to.
   */
  const answer = (agentId: string, reply: AskSend, follow?: Follow) =>
    run(true, () => onward(agentId, () => sendReply(slot, projectId, { key, agentId, ...reply, workspaceId }), reply.askVersion, follow));
  /** The unconfirmed reply again, exactly as it was sent; refused because
   * the ask moved on, `follow`'s reply to the latest. */
  const resend = (follow?: Follow) => {
    const was = pendingReply(slot);
    return run(true, () => onward(was?.agentId ?? "", () => resendReply(slot, projectId, key), was?.askVersion ?? null, follow));
  };
  async function onward(agentId: string, first: () => Promise<MessageReceipt>, version: number | null, follow?: Follow) {
    let attempt = first;
    let at = version;
    // The latest can move on again while this is sent: a few times, then the refusal is shown.
    for (let tries = 0; ; tries += 1) {
      try {
        const value = await attempt();
        setReceipt(value);
        onSent();
        return { receipt: value, version: at };
      } catch (e) {
        if (!follow || !key || at === null || tries >= 2 || askRefusal(e) !== "changed") throw e;
        const now = await latestSection(projectId, key).catch(() => null);
        const next =
          now && !now.history && now.kind === "ask" && now.ask && now.ask.state !== "resolved" && now.version !== at
            ? follow(now)
            : null;
        if (!next) throw e;
        at = next.askVersion;
        attempt = () => sendReply(slot, projectId, { key, agentId, ...next, workspaceId });
      }
    }
  }
  async function run<T>(asks: boolean, go: () => Promise<T>) {
    if (busy) throw new Error("A reply is already being sent.");
    setBusy(true);
    setError("");
    try {
      return await go();
    } catch (e) {
      const refused = asks ? askRefusal(e) : null;
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
  return { send, answer, resend, busy, error, receipt, kept };
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
  // Return sends as it does from the conversation's composer (YN-3): this device's choice, never while an input
  // method composes; Shift+Return makes a new line.
  const { sendKey } = useDevicePreferences();
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
          if (returnKey(event.nativeEvent, sendKey, touchKeyboard)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button
        type="submit"
        className="primary-button"
        disabled={disabled || held || busy || !text.trim()}
        title={returnSends(sendKey, touchKeyboard()) ? t.sendTitleReturn : t.sendTitle(shortcutModifier)}
      >
        {busy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
        {t.send}
      </button>
    </form>
  );
}

/** A form reply: readable lines for the Agent, then the stable ids, which
 * also go beside it (T-9) for Core to keep the answers by label. */
function formReply(form: ClarificationProps, values: ClarificationValues) {
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
  const text = `Answers to “${form.title}”:\n${lines.join("\n")}\n\n${JSON.stringify({ formId: form.id, answers })}`;
  return { text, form: { formId: form.id, answers } };
}

/**
 * An Ask's free-text reply not sent yet (T-182), kept apart from card replies:
 * its text and recipient. It goes to the ask's latest version (YN-38), the one
 * on screen when it is sent; `version`, the one it was begun on, is kept by
 * drafts from before and is not used.
 */
type AskDraft = { key: string; text: string; version?: number; agentId: string; at: string };
const askDrafts = draftStore<AskDraft>("yuzuno.home-ask-drafts.v1");

/**
 * The form a form's answers were given on (YN-38): its version and, from
 * YN-38, the form itself, under the key the form keeps the answers. Answers
 * given on another version are carried to the one on screen, by field and
 * option ID, and the form says on each field what changed.
 */
type FormBegun = { version: number; at: string; form?: ClarificationProps };
const formVersions = draftStore<FormBegun>("yuzuno.home-ask-form-versions.v1");

/**
 * The reply controls an ask section declares. Every one of them sends one
 * user message through Core, to the section's owner unless the user picks
 * another Agent. Nothing here acts on the Agent's behalf. A reply always
 * answers the ask's latest version, the one on screen (YN-38): there is no
 * step to move a reply to a newer version, and an answer is never applied to
 * an option or field the user did not pick (T-9).
 */
/** `inRow`: in a replied Ask's answer card (YN-3), which already says it is
 * replied and whom it waits for: the reply is labelled as the user's.
 * `face`: the answer card shows the reply and Reply again itself, so until a
 * reply is sent from here the replied block is not drawn again; each step of
 * `againRequest` is the card's Reply again, as the button below is.
 * `onReplied`: Core accepted a reply sent from here, to that version of the
 * ask, sent while Core showed the ask replied at `before` (YN-21: its card
 * becomes the answer card once Core's read has the reply). */
export function AskReply({
  section,
  inRow = false,
  face = false,
  againRequest = 0,
  onReplied,
  ...context
}: ReplyContext & { section: Section; inRow?: boolean; face?: boolean; againRequest?: number; onReplied?: (version: number, before: string | null) => void }) {
  const language = useLanguage();
  const t = homeText(language);
  const ask = section.ask!;
  const reply = ask.reply;
  const { answer, resend, busy, error, receipt, kept } = useReply(context, section.key);
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
  const write = (patch: Partial<AskDraft>) => {
    const { version: _begun, ...was } = latest.current ?? { key: section.key, text: "" };
    keep({ ...was, agentId: target, ...patch, at: new Date().toISOString() } as AskDraft);
  };
  const writeText = (text: string) => write({ text });
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
  // the form they were given on is kept under the same key.
  const formIdentity = `home:${context.workspaceId}:${context.projectId}:${section.key}`;
  const formKey = form && context.workspaceId ? clarificationDraftKey(formIdentity, form) : null;
  const [formEpoch, setFormEpoch] = useState(0);
  // Read again whenever the form changes: the answers it saved and their form.
  const [, setFormEdits] = useState(0);
  // What this window set, for the form it set it on (its key, or its ID
  // before the Workspace is known, T-195): this browser keeps it if it can,
  // and this window keeps it whether or not it could.
  const formRef = formKey ?? (form ? `id:${form.id}` : "");
  const begunHere = useRef<{ form: string; begun: FormBegun | null } | null>(null);
  const formBegun = !form ? null
    : begunHere.current?.form === formRef ? begunHere.current.begun
    : formKey ? formVersions.load()[formKey] ?? null
    : null;
  /** The answers on screen are given on the form on screen now. */
  function setFormBegun(on: ClarificationProps | null) {
    if (!form) return;
    const begun = on ? { version: section.version, at: new Date().toISOString(), form: on } : null;
    begunHere.current = { form: formRef, begun };
    if (formKey) formVersions.save(formKey, begun);
    setFormEdits((n) => n + 1);
  }
  // Learning the Workspace keeps what was begun before it, as the form keeps
  // the answers; another Workspace's form has its own.
  useEffect(() => {
    const here = begunHere.current;
    if (!formKey || !form || here?.form !== `id:${form.id}`) return;
    begunHere.current = { form: formKey, begun: here.begun };
    formVersions.save(formKey, here.begun);
    setFormEdits((n) => n + 1);
  }, [formKey, form]);
  // Written in or sent from this form as it is mounted, even if this browser
  // could not keep that.
  const formTouched = useRef(false);
  function formChanged(target: EventTarget) {
    if (!form || !(target as HTMLElement).closest?.(".clarification")) return;
    formTouched.current = true;
    setFormBegun(form);
  }
  // A form nobody wrote in or sent from shows the question as it is now: a
  // newer one under the same ID brings its own fields and defaults, and the
  // form starts afresh with them. Answers begun or sent here are carried to
  // it (the form's `carry`).
  const formShape = form ? JSON.stringify(form) : "";
  const [shownShape, setShownShape] = useState(formShape);
  if (shownShape !== formShape) {
    setShownShape(formShape);
    if (formBegun === null && !formTouched.current) setFormEpoch((n) => n + 1);
  }
  // Answers this browser kept from another version of the ask, or without
  // the version they were given on: said once above the form, until they are
  // sent; the form says what changed on each field.
  let formSaved = false;
  try {
    formSaved = !!formKey && localStorage.getItem(formKey) !== null;
  } catch {
    formSaved = false;
  }
  const [carried, setCarried] = useState(
    () => !!form && formSaved && (formBegun === null || formBegun.version !== section.version),
  );
  // A reply that went again as an unconfirmed one, and Core found it
  // delivered before: that earlier version of the ask, not this one.
  const [sentBefore, setSentBefore] = useState<number | null>(null);
  // This window's replies Core has, and its Reply agains, counted (T-19 HM:A3).
  const [delivered, setDelivered] = useState(0);
  const [reopened, setReopened] = useState(0);
  const repliedBlock = useRef<HTMLDivElement>(null);
  const replyUi = useRef<HTMLDivElement>(null);
  // Shown as replied from Core's record, or from this window's delivery until
  // Core's next read: a reply that went to a version newer than this place
  // has read yet is that version's. Only the owner resolves it.
  const answeredHere = !!receipt && sentVersion !== null && sentVersion >= section.version;
  const replied = !again && (ask.state === "replied" || answeredHere);
  // Only one of the project's open Agents takes it: a kept reply's recipient
  // may have left since.
  const targetOpen = context.agents.some((a) => a.id === target);
  const disabled = context.readOnly || !targetOpen;
  const targetName = context.agents.find((a) => a.id === target)?.name || section.owner.name;
  const freeText = reply.freeText;
  const prompt = typeof freeText === "object" && freeText.prompt ? freeText.prompt : t.writeReply;
  // `reply` answers the version on screen; `follow` says what it is on the
  // ask as Core has it, should Core have a newer one (YN-38).
  const deliver = async (sent: AskSend, follow: Follow) => {
    setSentBefore(null);
    setDiscarded(false);
    // The reply's time Core showed as this was sent, before Core could have this one.
    const before = ask.repliedAt ?? null;
    const { receipt: value, version } = await answer(target, sent, follow);
    setSentVersion(version);
    setSentText(sent.shown);
    setAgain(false);
    setCarried(false);
    setDelivered((n) => n + 1);
    if (version !== null) onReplied?.(version, before);
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
    const before = ask.repliedAt ?? null;
    setSentBefore(null);
    setResending(was);
    // Refused because the ask moved on, never delivered: words go to its
    // latest version; a pick or a form's answers are the user's to give again there.
    const follow: Follow | undefined = !was.choice && !was.form
      ? (now) => ({ text: was.text, shown: was.shown ?? was.text, askVersion: now.version })
      : undefined;
    let went: { version: number | null };
    try {
      went = await resend(follow);
    } catch {
      return;
    } finally {
      setResending(undefined);
    }
    const version = went.version;
    setSentVersion(version);
    setSentText(previewOf(was));
    setAgain(false);
    setDelivered((n) => n + 1);
    if (version !== null) onReplied?.(version, before);
    // Delivered to an earlier version of the ask: this one is still open.
    if (version !== null && version < section.version) setSentBefore(version);
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
  // This window's reply, once Core has it: what was said takes the reply's
  // place, fades in and, focus having gone with the button pressed, takes it.
  // Reply again brings the reply back the same way, focus in it. A reply
  // shown as it was read, or from another window, does neither (T-19 HM:A3).
  useSurfaceIn(repliedBlock, delivered, "small", delivered > 0);
  useSurfaceIn(replyUi, reopened, "small", reopened > 0);
  useLayoutEffect(() => {
    if (!delivered || !replied) return;
    if (!document.activeElement || document.activeElement === document.body) repliedBlock.current?.focus({ preventScroll: true });
    // Only as this window's reply arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delivered]);
  useLayoutEffect(() => {
    if (!reopened || replied) return;
    const ui = replyUi.current;
    const first = ui?.querySelector<HTMLElement>("textarea:not([disabled])")
      ?? ui?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])");
    first?.focus({ preventScroll: true });
    // Only as Reply again brings it back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reopened]);
  // The answer card's Reply again (YN-3): what the button below does.
  const askedAgain = useRef(againRequest);
  useEffect(() => {
    if (againRequest === askedAgain.current) return;
    askedAgain.current = againRequest;
    setReopened((n) => n + 1);
    setAgain(true);
  }, [againRequest]);
  // A pick sends only its id: Core quotes the label, and text would repeat
  // it. On a newer version it goes only to the same question offering the
  // same option, worded the same (T-9).
  const pick = (id: string, shown: string, offered: (now: NonNullable<Section["ask"]>) => unknown) => {
    const was = JSON.stringify(offered(ask));
    void deliver({ text: "", choice: id, shown, askVersion: section.version }, (now) =>
      now.ask!.question === ask.question && JSON.stringify(offered(now.ask!)) === was
        ? { text: "", choice: id, shown, askVersion: now.version }
        : null,
    ).catch(() => {});
  };
  // On the answer card, the reply is on its face: only a draft kept since is said here.
  if (replied && face && delivered === 0)
    return draft?.text.trim() ? <p className="home-note">{t.askDraftAfterReply}</p> : null;
  if (replied)
    return (
      <div className="home-ask-replied" role="status" ref={repliedBlock} tabIndex={-1}>
        <MessageSquareReply size={14} />
        <div>
          <strong>{inRow ? t.yourReply.trim() : t.repliedWaiting(ask.state === "replied" ? section.owner.name : targetName)}</strong>
          {(ask.replyText || sentText) && <p>{ask.replyText || sentText}</p>}
          {ask.state === "replied" && repliedThenUpdated(section) && (
            <p className="home-ask-updated">{t.updatedAfterReply(section.owner.name, relative(section.updatedAt, language))}</p>
          )}
          {!!draft?.text.trim() && <p className="home-note">{t.askDraftAfterReply}</p>}
        </div>
        {!context.readOnly && (
          <button
            type="button"
            className="quiet-button"
            onClick={() => {
              setReopened((n) => n + 1);
              setAgain(true);
            }}
          >
            {t.replyAgain}
          </button>
        )}
      </div>
    );
  return (
    <div
      ref={replyUi}
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
      {sentBefore !== null && sentBefore < section.version && (
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
              onClick={() => pick(option.id, option.label, (now) => now.reply.options?.find((o) => o.id === option.id) ?? null)}
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
                  onClick={() => pick(option.id, `I choose: ${option.label}`, (now) => now.reply.choice?.[side] ?? null)}
                >
                  {t.choose(side.toUpperCase())}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {form && carried && !pending && (
        <p className="home-note home-ask-carried" role="status">{t.askAnswersCarried(section.version)}</p>
      )}
      {form ? (
        <Clarification
          identity={formEpoch ? `${formIdentity}#${formEpoch}` : formIdentity}
          // Home's reply drafts already name their Workspace; this keeps the
          // key they are saved under exactly as it was (T-195).
          draftIdentity={context.workspaceId ? formIdentity : null}
          form={form}
          agentName={targetName}
          carry
          basis={formBegun?.form ?? null}
          onCarry={() => {
            // Carried to the form on screen: given on it from now on.
            setFormBegun(form);
            setCarried(true);
          }}
          blockedReason={
            !targetOpen
              ? "Choose who should get the reply."
              : pending
                ? t.askUnconfirmedFirst
                : undefined
          }
          // Its delivery is that of the version it answered.
          delivery={answeredHere && receipt ? { status: receipt.status, error: receipt.error } : undefined}
          onSubmit={context.readOnly ? undefined : async (values) => {
            const { text, form: answers } = formReply(form, values);
            // Sent, the answers are this version's, defaults included: kept
            // as written ones are, for a retry and against a newer question.
            formTouched.current = true;
            try {
              if (formKey) saveClarificationDraft(localStorage, formKey, values);
            } catch {
              /* Kept on screen in this window all the same. */
            }
            setFormBegun(form);
            const was = JSON.stringify(reply.form);
            // On a newer version, only to the same question and the same form.
            await deliver({ text, shown: text, askVersion: section.version, form: answers }, (now) =>
              now.ask!.question === ask.question && JSON.stringify(now.ask!.reply.form) === was
                ? { text, shown: text, askVersion: now.version, form: answers }
                : null,
            );
          }}
        />
      ) : form === undefined ? (
        <p className="home-note">{t.formUnavailable}</p>
      ) : null}
      {/* Always offered, whatever the ask declares: answering in your own
          words is yours, not something an Agent turns on with `freeText`,
          which only names the field. Core takes text for any ask, with or
          without a choice (project_brief/home.rs). */}
      {restored && !!draft?.text.trim() && <p className="home-note">{t.askDraftKept}</p>}
      <TextReply
        label={t.replyField(section.title)}
        placeholder={prompt}
        text={draft?.text ?? ""}
        onText={writeText}
        disabled={disabled}
        held={!!pending}
        busy={busy}
        onSend={async (text) => {
          // To the version on screen; words go to a newer one as they are.
          await deliver({ text, shown: text, askVersion: section.version }, (now) => ({ text, shown: text, askVersion: now.version }));
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
