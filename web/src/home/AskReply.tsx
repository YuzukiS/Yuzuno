import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, LoaderCircle, MessageCircleQuestion, MessageSquareReply, MessageSquareText, RotateCcw, Send, Trash2 } from "lucide-react";
import { errorText, HttpError, shortcutModifier } from "../api";
import { useLanguage, useStrings } from "../i18n";
import { useSurfaceIn } from "../surface";
import { returnSends, useDevicePreferences } from "../device-preferences";
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
import {
  dropPendingReply, latestSection, olderCoreFiles, olderCoreImages, olderCoreNotes, outboxKey, pendingReply, resendReply, sendReply,
  type HomeReplyInput,
} from "./home-api";
import { replyRecipient } from "./card-responsible";
import { homeText } from "./home-text";
import { draftStore } from "./reply-drafts";
import { HOME_REPLY_MAX_BYTES, ReplyLength, replyTooLong, utf8Bytes } from "./reply-limit";
import { HomeComposer, type HomeAttach, type ReplyWords } from "./HomeComposer";
import { ImageAttachments } from "../ImageAttachments";
import { FileAttachments } from "../FileAttachments";
import { homeImageUrl, takesImages, validHomeImages, type HomeImage } from "./home-images";
import { agentTakesFiles, homeFileUrl, validHomeFiles, type HomeFile } from "./home-files";
import { repliedThenUpdated } from "./brief-layout";
import type { AskNote, Section } from "./types";
import { CleanupApprovalNote, cleanupOptionView, useCleanupApproval } from "./cleanup-approval";
import { Tip, TipText } from "../Tip";

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
type AskSend = {
  text: string; choice?: string; shown: string; askVersion: number; form?: HomeReplyInput["form"]; images?: string[]; files?: HomeFile[];
  /** A note (YN-213): words that answer nothing. */
  intent?: "note";
  /** The user's words beside a form's answers (YN-213). */
  note?: string;
};

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
      // A Core from before notes and a form's own words (YN-213): never submitted, and never sent as an answer instead.
      if (olderCoreNotes(e)) {
        dropPendingReply(slot);
        setError(t.olderCoreNotes);
        throw e;
      }
      // A Core from before Home's images or files refused them before reading the reply (YN-134, YN-145): never submitted.
      if (olderCoreImages(e) || olderCoreFiles(e)) {
        dropPendingReply(slot);
        setError(olderCoreFiles(e) ? t.olderCoreFiles : t.olderCoreImages);
        throw e;
      }
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
  return { answer, resend, busy, error, receipt, kept };
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

/** A text reply; its owner keeps the words and says what a delivery clears. */
function TextReply({
  slot,
  placeholder,
  words,
  onWords,
  disabled,
  held = false,
  busy,
  onSend,
  label,
  attach,
}: {
  /** Which reply it is (HomeComposer). */
  slot: string;
  placeholder: string;
  words: ReplyWords;
  onWords: (words: ReplyWords) => void;
  disabled: boolean;
  /** Not sendable as it is, though it can still be written in. */
  held?: boolean;
  busy: boolean;
  /** The words, the IDs of the images they take, and the files (YN-134, YN-145). */
  onSend: (text: string, images: string[], files: HomeFile[]) => Promise<unknown>;
  label: string;
  /** Takes images and files: the words' own field, never a form's. */
  attach?: HomeAttach;
}) {
  const t = useStrings(homeText);
  const [uploading, setUploading] = useState(false);
  const images = words.images ?? [];
  const files = words.files ?? [];
  // Nothing goes while images or files save, nor with any who it goes to can't take.
  const stopped = held || uploading || (images.length > 0 && !!attach?.refusal) || (files.length > 0 && !!attach?.files?.refusal);
  // Return sends as it does from the conversation's composer (YN-3), whose field this is (YN-91): this device's
  // choice, never while an input method composes; Shift+Return makes a new line.
  const { sendKey } = useDevicePreferences();
  const text = words.text;
  const submit = () => {
    const value = text.trim();
    if (!value || disabled || stopped || busy || replyTooLong(value)) return;
    // The text stays until the reply is delivered.
    onSend(value, images.map((image) => image.id), files).catch(() => {});
  };
  return (
    <>
      <form
        className="home-text-reply"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <HomeComposer
          slot={slot}
          label={label}
          placeholder={placeholder}
          words={words}
          onWords={onWords}
          onSubmit={submit}
          readOnly={disabled}
          attach={attach}
          onUploading={setUploading}
        />
        {/* Its key, as the composer's Send says it. */}
        <Tip content={<TipText title={t.send} kbd={returnSends(sendKey, touchKeyboard()) ? "↵" : `${shortcutModifier} ↵`} />} describe={false}>
          <button
            type="submit"
            className="primary-button"
            disabled={disabled || stopped || busy || !text.trim() || replyTooLong(text)}
          >
            {busy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
            {t.send}
          </button>
        </Tip>
      </form>
      <ReplyLength text={text} />
    </>
  );
}

/** A form reply: readable lines for the Agent, then the stable ids, which
 * also go beside it (T-9) for Core to keep the answers by label. */
function formReply(form: ClarificationProps, values: ClarificationValues) {
  const answers = clarificationAnswers(form).parse(values) as ClarificationValues;
  return { text: formReplyText(form, answers), form: { formId: form.id, answers } };
}

/** The text a form reply sends (formReply) without checking its answers:
 * what the form counts as they are written (YN-103), the same bytes once
 * they are checked. Only the form's own fields, in its order. */
function formReplyText(form: ClarificationProps, values: ClarificationValues) {
  const answers = Object.fromEntries(form.fields.map((field) => [field.id, values[field.id]]));
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
 * its text and recipient. It goes to the ask's latest version (YN-38), the one
 * on screen when it is sent; `version`, the one it was begun on, is kept by
 * drafts from before and is not used.
 */
type AskDraft = {
  key: string; text: string; blocks?: ReplyWords["blocks"]; images?: HomeImage[]; files?: HomeFile[]; version?: number; agentId: string; at: string;
  /** The option or approach picked, not sent yet (YN-213): sent with the words as one reply. */
  pick?: string;
};
const askDrafts = draftStore<AskDraft>("yuzuno.home-ask-drafts.v1");

/**
 * A note on an ask not sent yet (YN-213, "Wait, what?"): its words and what
 * it attaches, apart from the reply being written, which it never takes.
 */
type NoteDraft = { key: string; text: string; blocks?: ReplyWords["blocks"]; images?: HomeImage[]; files?: HomeFile[]; at: string };
const noteDrafts = draftStore<NoteDraft>("yuzuno.home-ask-notes.v1");

/** A form reply's text as it is shown: without the line of IDs Core reads its answers by (YN-213). */
export const withoutFormIds = (text: string) => text.replace(/\n\n\{"formId":.*\}(?=\n\n|$)/, "");

/** A kept draft as read back: images and files that are not what this page keeps are left out. */
function checkedDraft<T extends { images?: HomeImage[]; files?: HomeFile[] }>(draft: T | null): T | null {
  if (!draft) return draft;
  let kept = draft;
  if (kept.images !== undefined && !validHomeImages(kept.images)) {
    const { images: _dropped, ...rest } = kept;
    kept = rest as T;
  }
  if (kept.files !== undefined && !validHomeFiles(kept.files)) {
    const { files: _dropped, ...rest } = kept;
    kept = rest as T;
  }
  return kept;
}

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
  onAgain,
  ...context
}: ReplyContext & { section: Section; inRow?: boolean; face?: boolean; againRequest?: number; onReplied?: (version: number, before: string | null) => void; onAgain?: () => void }) {
  const language = useLanguage();
  const t = homeText(language);
  const ask = section.ask!;
  const reply = ask.reply;
  const { answer, resend, busy, error, kept } = useReply(context, section.key);
  // An ask on a card bound to a task goes to whoever answers for the card (YN-86 §3.3), while they are open in
  // the Project; else to its author. The user can pick another all the same.
  const recipient = replyRecipient(section, context.agents);
  // Kept once the Workspace is known: another one may hold the same project
  // and key (T-195).
  const slot = outboxKey(context.workspaceId, context.projectId, section.key);
  const stored = () => (context.workspaceId ? checkedDraft(askDrafts.load()[slot] ?? null) : null);
  // An unconfirmed send is not a draft: it goes again only as it was, from
  // its own record (below).
  const [draft, setDraft] = useState<AskDraft | null>(stored);
  const latest = useRef(draft);
  const [restored, setRestored] = useState(() => !!draft?.at && !!draft.text.trim());
  const [onlyHere, setOnlyHere] = useState(false);
  const [target, setTarget] = useState(
    () => (draft?.text.trim() && draft.agentId) || kept?.agentId || recipient,
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
    if (context.workspaceId)
      setOnlyHere(!askDrafts.save(slot, next?.text.trim() || next?.images?.length || next?.files?.length || next?.pick ? next : null));
  }
  // Always to the recipient on screen: one chosen while the text was empty
  // goes with what is written next.
  const write = (patch: Partial<AskDraft>) => {
    const { version: _begun, ...was } = latest.current ?? { key: section.key, text: "" };
    keep({ ...was, agentId: target, ...patch, at: new Date().toISOString() } as AskDraft);
  };
  const writeWords = ({ text, blocks, images, files }: ReplyWords) => write({ text, blocks, images, files });
  const pickTarget = (agentId: string) => {
    setTarget(agentId);
    if (latest.current?.text.trim() || latest.current?.pick) write({ agentId });
  };
  // A note being written (YN-213), apart from the reply: kept in this browser too, under the same slot.
  const storedNote = () => (context.workspaceId ? checkedDraft(noteDrafts.load()[slot] ?? null) : null);
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(storedNote);
  const latestNote = useRef(noteDraft);
  const [noteOnlyHere, setNoteOnlyHere] = useState(false);
  function keepNote(next: NoteDraft | null) {
    latestNote.current = next;
    setNoteDraft(next);
    if (context.workspaceId)
      setNoteOnlyHere(!noteDrafts.save(slot, next?.text.trim() || next?.images?.length || next?.files?.length ? next : null));
  }
  const writeNote = ({ text, blocks, images, files }: ReplyWords) =>
    keepNote({ key: section.key, text, blocks, images, files, at: new Date().toISOString() });
  // Writing a note ("Wait, what?"): where a note kept from before was left off, too.
  const [noting, setNoting] = useState(() => !!noteDraft?.text.trim());
  // This window's newest note Core has, until Core's read lists it.
  const [sentNote, setSentNote] = useState<AskNote | null>(null);
  const [uploading, setUploading] = useState(false);
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
  const [sentImages, setSentImages] = useState<string[]>([]);
  const [sentFiles, setSentFiles] = useState<HomeFile[]>([]);
  // The answer this window sent last (a note is not one): its delivery is the form's.
  const [answerReceipt, setAnswerReceipt] = useState<MessageReceipt | null>(null);
  // The form as Home asks it (YN-213): a choice's default is said as a suggestion, never chosen for the user,
  // so an answer the user did not give is never sent as theirs.
  const parsedForm = useMemo(() => {
    if (!reply.form) return null;
    const parsed = clarificationSchema.safeParse(reply.form);
    return parsed.success ? parsed.data : undefined;
  }, [reply.form]);
  const form = useMemo(
    () => parsedForm && { ...parsedForm, fields: parsedForm.fields.map((field) => {
      if (field.type === "text" || !field.default) return field;
      const { default: _suggested, ...rest } = field;
      return rest;
    }) },
    [parsedForm],
  );
  const suggested = useMemo(() => {
    const said: Record<string, string> = {};
    for (const field of parsedForm?.fields ?? []) {
      if (field.type === "text" || !field.default) continue;
      const ids = [field.default.value].flat();
      const labels = field.options.filter((option) => ids.includes(option.id)).map((option) => `“${option.label}”`).join(", ");
      if (labels) said[field.id] = t.suggested(labels, field.default.source);
    }
    return said;
  }, [parsedForm, t]);
  // A cleanup plan's approval (YN-74 ①b): its groups as Core summarized them,
  // and no answer while that summary can't be shown as the Ask asks it.
  const cleanup = useCleanupApproval(section);
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
  // Every change of an answer, its text field's too (YN-103), as the form says it.
  function formChanged() {
    if (!form) return;
    formTouched.current = true;
    // Kept once per version and form, not on every keystroke.
    if (formBegun?.version === section.version && JSON.stringify(formBegun.form) === JSON.stringify(form)) return;
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
  const answeredHere = !!answerReceipt && sentVersion !== null && sentVersion >= section.version;
  const replied = !again && (ask.state === "replied" || answeredHere);
  // Only one of the project's open Agents takes it: a kept reply's recipient
  // may have left since.
  const targetOpen = context.agents.some((a) => a.id === target);
  const disabled = context.readOnly || !targetOpen;
  const targetName = context.agents.find((a) => a.id === target)?.name || section.owner.name;
  // Who it goes to is known here: one that takes no images or files is said before Core would refuse it (YN-134, YN-145).
  const chosen = context.agents.find((a) => a.id === target);
  const refusal = chosen && !takesImages(chosen.harness) ? t.cantTakeImages(chosen.name) : null;
  const filesRefusal = chosen && !agentTakesFiles(chosen) ? t.cantTakeFiles(chosen.name) : null;
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
    setAnswerReceipt(value);
    setSentVersion(version);
    setSentText(sent.shown);
    setSentImages(sent.images ?? []);
    setSentFiles(sent.files ?? []);
    setAgain(false);
    setCarried(false);
    setDelivered((n) => n + 1);
    if (version !== null) onReplied?.(version, before);
    return value;
  };
  // A note (YN-213): to the version on screen, its words to a newer one as they are. The ask stays as it was.
  const deliverNote = async (sent: AskSend, follow: Follow) => {
    setSentBefore(null);
    setDiscarded(false);
    const { receipt: value, version } = await answer(target, sent, follow);
    setSentNote({
      version: version ?? section.version, at: new Date().toISOString(), text: sent.text, agentId: target,
      ...(sent.images?.length ? { images: sent.images } : {}), ...(sent.files?.length ? { files: sent.files } : {}),
    });
    return value;
  };
  // What an unconfirmed reply said, as it went: what this window showed as
  // sent (a form's answers without their ids), never the ask as it is now.
  const previewOf = (was: { choice?: string; text: string; shown?: string }) =>
    withoutFormIds(was.shown ?? (was.text || was.choice || "")).trim();
  // The unconfirmed reply again, exactly as it was sent.
  const sendAgain = async () => {
    const was = pendingReply(slot);
    if (!was) return;
    const before = ask.repliedAt ?? null;
    setSentBefore(null);
    setResending(was);
    // Refused because the ask moved on, never delivered: words go to its
    // latest version, a note as a note; a pick or a form's answers are the user's to give again there.
    const follow: Follow | undefined = !was.choice && !was.form
      ? (now) => ({
          text: was.text, shown: was.shown ?? was.text, askVersion: now.version,
          ...(was.images?.length ? { images: was.images } : {}), ...(was.files?.length ? { files: was.files } : {}),
          ...(was.intent ? { intent: was.intent } : {}),
        })
      : undefined;
    let went: { receipt: MessageReceipt; version: number | null };
    try {
      went = await resend(follow);
    } catch {
      return;
    } finally {
      setResending(undefined);
    }
    const version = went.version;
    // A note went (YN-213): the ask is as it was; the note's draft goes with it, unless written since.
    if (was.intent === "note") {
      setSentNote({
        version: version ?? section.version, at: was.sentAt ?? new Date().toISOString(), text: was.text, agentId: was.agentId,
        ...(was.images?.length ? { images: was.images } : {}), ...(was.files?.length ? { files: was.files } : {}),
      });
      const note = latestNote.current;
      if (note && note.text.trim() === was.text && was.sentAt && Date.parse(note.at) <= Date.parse(was.sentAt)) keepNote(null);
      return;
    }
    setAnswerReceipt(went.receipt);
    setSentVersion(version);
    setSentText(previewOf(was));
    setSentImages(was.images ?? []);
    setSentFiles(was.files ?? []);
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
    // Its first field to write in: the reply's composer (YN-91), or a form's text field before it.
    const first = ui?.querySelector<HTMLElement>("textarea:not([disabled]), [data-composer-input][contenteditable='true']")
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
  // What the ask lets the user pick (YN-213): its options and its two approaches, one of which is the decision.
  // A pick sends only its id, beside the user's words: Core quotes the label. On a newer version it goes only
  // to the same question offering the same option, worded the same (T-9).
  type Pick = { id: string; label: string; shown: string; detail?: string; side?: "a" | "b"; offered: (now: NonNullable<Section["ask"]>) => unknown };
  const picks: Pick[] = [
    ...(reply.options ?? []).map((option) => ({
      id: option.id, label: option.label, shown: option.label,
      offered: (now: NonNullable<Section["ask"]>) => now.reply.options?.find((o) => o.id === option.id) ?? null,
    })),
    ...(reply.choice
      ? (["a", "b"] as const).map((side) => ({
          id: reply.choice![side].id, label: reply.choice![side].label, shown: `I choose: ${reply.choice![side].label}`,
          detail: reply.choice![side].detail, side,
          offered: (now: NonNullable<Section["ask"]>) => now.reply.choice?.[side] ?? null,
        }))
      : []),
  ];
  // An ask with a decision to make (options, A/B or a form) has one button that sends it, the user's words and
  // what they attach together, and "Wait, what?" beside it. Free text alone is answered as before.
  const decides = picks.length > 0 || form !== null;
  const picked = picks.find((p) => p.id === draft?.pick) ?? null;
  const words = draft?.text ?? "";
  const attached = { ...(draft?.images?.length ? { images: draft.images.map((image) => image.id) } : {}), ...(draft?.files?.length ? { files: draft.files } : {}) };
  const attachments = (images?: HomeImage[], files?: HomeFile[]) =>
    ((images?.length ?? 0) > 0 && !!refusal) || ((files?.length ?? 0) > 0 && !!filesRefusal);
  // Words alone answer only an ask that asks for them (`freeText`), or one whose form can't be shown here;
  // otherwise they go as a note ("Wait, what?").
  const wordsAnswer = (!!freeText || form === undefined) && !picked && !form
    && (!!words.trim() || !!draft?.images?.length || !!draft?.files?.length);
  const held = disabled || busy || !!pending || uploading || attachments(draft?.images, draft?.files);
  const decideLabel = picked ? t.submitChoice(picked.label) : wordsAnswer ? t.sendReply : t.submitDecision;
  // The decision, the user's words and what they attached, as one reply; only what was sent leaves the draft.
  const sendPick = async () => {
    if (!picked || held || replyTooLong(words)) return;
    const text = words.trim();
    const was = JSON.stringify(picked.offered(ask));
    const shown = text ? `${picked.shown}\n\n${text}` : picked.shown;
    const sent = { text, choice: picked.id, shown, ...attached };
    await deliver({ ...sent, askVersion: section.version }, (now) =>
      now.ask!.question === ask.question && JSON.stringify(picked.offered(now.ask!)) === was ? { ...sent, askVersion: now.version } : null,
    );
    if (!latest.current || (latest.current.text.trim() === text && latest.current.pick === picked.id)) keep(null);
    setRestored(false);
  };
  const sendWords = async () => {
    if (!wordsAnswer || held || replyTooLong(words)) return;
    const text = words.trim();
    const sent = { text, shown: text, ...attached };
    // To the version on screen; words go to a newer one as they are.
    await deliver({ ...sent, askVersion: section.version }, (now) => ({ ...sent, askVersion: now.version }));
    if (!latest.current || latest.current.text.trim() === text) keep(null);
    setRestored(false);
  };
  const decide = () => void (picked ? sendPick() : sendWords()).catch(() => {});
  // A note ("Wait, what?"): only what it says goes, never the pick or the answers begun, which stay as they were.
  const noteWords = noteDraft?.text ?? "";
  const noteHeld = disabled || busy || !!pending || uploading || attachments(noteDraft?.images, noteDraft?.files);
  const noteSendable = !noteHeld && !replyTooLong(noteWords)
    && (!!noteWords.trim() || !!noteDraft?.images?.length || !!noteDraft?.files?.length);
  const { sendKey } = useDevicePreferences();
  const noteUi = useRef<HTMLDivElement>(null);
  const waitWhat = useRef<HTMLButtonElement>(null);
  const [noteOpened, setNoteOpened] = useState(0);
  const openNote = (open: boolean) => {
    setNoting(open);
    setNoteOpened((n) => n + 1);
  };
  useLayoutEffect(() => {
    if (!noteOpened) return;
    // Opened: in its field, to write at once. Closed: back on the button that opens it.
    if (noting) noteUi.current?.querySelector<HTMLElement>("[data-composer-input][contenteditable='true'], textarea:not([disabled])")?.focus({ preventScroll: true });
    else waitWhat.current?.focus({ preventScroll: true });
    // Only as it opens or closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteOpened]);
  const sendNote = async () => {
    if (!noteSendable) return;
    const text = noteWords.trim();
    const sent = {
      text, shown: text, intent: "note" as const,
      ...(noteDraft?.images?.length ? { images: noteDraft.images.map((image) => image.id) } : {}),
      ...(noteDraft?.files?.length ? { files: noteDraft.files } : {}),
    };
    await deliverNote({ ...sent, askVersion: section.version }, (now) => ({ ...sent, askVersion: now.version }));
    // Only what was sent leaves: anything written while it was being sent stays.
    if (!latestNote.current || latestNote.current.text.trim() === text) keepNote(null);
    openNote(false);
  };
  // The notes Core lists, and this window's newest until Core's read has it.
  const notes: AskNote[] = [
    ...(sentNote && !(ask.notes ?? []).some((n) => n.text === sentNote.text.trim() && n.version === sentNote.version) ? [sentNote] : []),
    ...(ask.notes ?? []),
  ];
  // On the answer card, the reply is on its face: only a draft kept since is said here.
  if (replied && face && delivered === 0)
    return draft?.text.trim() ? <p className="home-note">{t.askDraftAfterReply}</p> : null;
  if (replied)
    return (
      <div className="home-ask-replied" role="status" ref={repliedBlock} tabIndex={-1}>
        <MessageSquareReply size={14} />
        <div>
          <strong>{inRow ? t.yourReply.trim() : t.repliedWaiting(ask.state === "replied" ? section.owner.name : targetName)}</strong>
          {(ask.replyText || sentText) && <p>{withoutFormIds(ask.replyText || sentText)}</p>}
          <ImageAttachments
            images={(ask.replyText ? ask.replyImages ?? [] : sentImages).map((id) => ({ id }))}
            imageUrl={(id, thumb) => homeImageUrl(context.projectId, id, thumb)}
          />
          <FileAttachments
            files={ask.replyText ? ask.replyFiles ?? [] : sentFiles}
            href={(file) => homeFileUrl(context.projectId, file.id, file.name)}
            projectId={context.projectId}
          />
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
              // Its card grows back to the reply (YN-203).
              onAgain?.();
            }}
          >
            {t.replyAgain}
          </button>
        )}
      </div>
    );
  const attach = context.readOnly ? undefined : { projectId: context.projectId, refusal, files: { refusal: filesRefusal } };
  const waitWhatButton = decides && !context.readOnly ? (
    <button
      ref={waitWhat}
      type="button"
      className="secondary-button home-wait-what"
      aria-expanded={noting}
      disabled={!!pending}
      onClick={() => openNote(true)}
    >
      <MessageCircleQuestion size={14} />
      {t.waitWhat}
    </button>
  ) : null;
  // The user's words with the decision, and what they attach: a field of the reply, never of a form's answers.
  const decisionWords = (
    <>
      <div className="home-text-reply home-ask-words">
        <HomeComposer
          slot={slot}
          label={t.decisionNoteField(section.title)}
          placeholder={typeof freeText === "object" && freeText.prompt ? freeText.prompt : t.decisionNote}
          words={{ text: words, blocks: draft?.blocks, ...(draft?.images?.length ? { images: draft.images } : {}), ...(draft?.files?.length ? { files: draft.files } : {}) }}
          onWords={writeWords}
          // Return does what the one button does: with a form, its button sends the answers with these words.
          onSubmit={form ? () => replyUi.current?.querySelector<HTMLButtonElement>(".clarification footer .primary-button")?.click() : decide}
          readOnly={disabled}
          attach={attach}
          onUploading={setUploading}
        />
      </div>
      <ReplyLength text={words} />
    </>
  );
  return (
    <div ref={replyUi} className="home-ask-reply">
      <TargetPicker
        agents={context.agents}
        value={target}
        onChange={pickTarget}
        disabled={context.readOnly || busy}
      />
      {!recipient && (
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
                <strong>{unconfirmed.intent === "note" ? t.notePendingTitle : t.askPendingTitle}</strong>
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
      {discarded && !pending && <p className="home-note" role="status">{t.askUnconfirmedDiscarded}</p>}
      {sentBefore !== null && sentBefore < section.version && (
        <p className="home-note" role="status">{t.askSentBefore(sentBefore, section.version)}</p>
      )}
      {decides && (
        // Kept while a note is written: the pick and the answers begun stay as they were.
        <div className="home-ask-decision" hidden={noting}>
          {picks.length > 0 && (
            <fieldset className={reply.choice ? "home-ask-choice" : "home-ask-options"}>
              <legend className="sr-only">{reply.choice && !reply.options?.length ? t.chooseOne : t.replyOptions}</legend>
              {picks.map((option) => (
                <label key={option.id} className={option.side ? "home-choice" : "home-ask-pick"} data-selected={picked?.id === option.id || undefined}>
                  <input
                    type="radio"
                    name={`${slot}:pick`}
                    value={option.id}
                    checked={picked?.id === option.id}
                    disabled={disabled || busy || !!pending}
                    onChange={() => write({ pick: option.id })}
                  />
                  {option.side ? (
                    <span>
                      <small>{t.choose(option.side.toUpperCase())}</small>
                      <strong>{option.label}</strong>
                      {option.detail && <p>{option.detail}</p>}
                    </span>
                  ) : (
                    <span>{option.label}</span>
                  )}
                </label>
              ))}
            </fieldset>
          )}
          {form && carried && !pending && (
            <p className="home-note home-ask-carried" role="status">{t.askAnswersCarried(section.version)}</p>
          )}
          {form && <CleanupApprovalNote approval={cleanup} />}
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
                    : cleanup.state === "blocked" || cleanup.state === "loading"
                      ? cleanup.reason
                      : undefined
              }
              optionView={cleanupOptionView(cleanup, language)}
              suggested={suggested}
              onEdit={formChanged}
              // A reply from Home, counted as Core counts it (YN-103), with the user's words beside the answers.
              measure={(values) => ({ bytes: utf8Bytes(formReplyText(form, values)) + utf8Bytes(words.trim()), max: HOME_REPLY_MAX_BYTES })}
              // Its delivery is that of the version it answered.
              delivery={answeredHere && answerReceipt ? { status: answerReceipt.status, error: answerReceipt.error } : undefined}
              extra={decisionWords}
              secondary={waitWhatButton ?? undefined}
              submitLabel={picked ? t.submitChoice(picked.label) : t.submitAnswers}
              // One of the ask's own options picked: that is the answer, and the form's stay a draft.
              submitInstead={picked ? sendPick : undefined}
              onSubmit={context.readOnly ? undefined : async (values) => {
                if (attachments(draft?.images, draft?.files) || uploading) throw new Error(refusal ?? filesRefusal ?? t.sending);
                const { text, form: answers } = formReply(form, values);
                const note = words.trim();
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
                // The answers, then the user's words and what they attached, as one reply (YN-213).
                const sent = {
                  text, shown: note ? `${withoutFormIds(text)}\n\n${note}` : text, form: answers, ...(note ? { note } : {}), ...attached,
                };
                // On a newer version, only to the same question and the same form.
                await deliver({ ...sent, askVersion: section.version }, (now) =>
                  now.ask!.question === ask.question && JSON.stringify(now.ask!.reply.form) === was ? { ...sent, askVersion: now.version } : null,
                );
                if (!latest.current || latest.current.text.trim() === note) keep(null);
                setRestored(false);
              }}
            />
          ) : form === undefined ? (
            <p className="home-note">{t.formUnavailable}</p>
          ) : null}
          {!form && (
            <>
              {restored && !!words.trim() && <p className="home-note">{t.askDraftKept}</p>}
              {decisionWords}
              <div className="home-ask-actions">
                {waitWhatButton}
                <Tip content={<TipText title={decideLabel} kbd={returnSends(sendKey, touchKeyboard()) ? "↵" : `${shortcutModifier} ↵`} />} describe={false}>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={held || (!picked && !wordsAnswer) || replyTooLong(words)}
                    onClick={decide}
                  >
                    {busy && !noting ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />}
                    {decideLabel}
                  </button>
                </Tip>
              </div>
            </>
          )}
          {form && restored && !!words.trim() && <p className="home-note">{t.askDraftKept}</p>}
        </div>
      )}
      {decides && noting && (
        // "Wait, what?": a field of its own, to say anything to the Agent without deciding.
        <section ref={noteUi} className="home-ask-note" aria-label={t.noteHeading}>
          <h4>{t.noteHeading}</h4>
          <p className="home-note">{t.noteHint}</p>
          <div className="home-text-reply home-ask-words">
            <HomeComposer
              slot={`${slot}:note`}
              label={t.noteField(section.title)}
              placeholder={t.notePlaceholder}
              words={{
                text: noteWords, blocks: noteDraft?.blocks,
                ...(noteDraft?.images?.length ? { images: noteDraft.images } : {}), ...(noteDraft?.files?.length ? { files: noteDraft.files } : {}),
              }}
              onWords={writeNote}
              onSubmit={() => void sendNote().catch(() => {})}
              readOnly={disabled}
              attach={attach}
              onUploading={setUploading}
            />
          </div>
          <ReplyLength text={noteWords} />
          <div className="home-ask-actions">
            <button type="button" className="quiet-button" disabled={busy} onClick={() => openNote(false)}>
              {t.backToQuestion}
            </button>
            <Tip content={<TipText title={t.sendNote} kbd={returnSends(sendKey, touchKeyboard()) ? "↵" : `${shortcutModifier} ↵`} />} describe={false}>
              <button type="button" className="primary-button" disabled={!noteSendable} onClick={() => void sendNote().catch(() => {})}>
                {busy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
                {t.sendNote}
              </button>
            </Tip>
          </div>
          {noteOnlyHere && <p className="home-note">{t.askDraftOnlyHere}</p>}
        </section>
      )}
      {!decides && (
        <>
          {/* Free text alone: the words are the answer (YN-213 keeps this as it was). */}
          {restored && !!draft?.text.trim() && <p className="home-note">{t.askDraftKept}</p>}
          <TextReply
            slot={slot}
            label={t.replyField(section.title)}
            placeholder={prompt}
            words={{ text: draft?.text ?? "", blocks: draft?.blocks, ...(draft?.images?.length ? { images: draft.images } : {}), ...(draft?.files?.length ? { files: draft.files } : {}) }}
            onWords={writeWords}
            disabled={disabled}
            held={!!pending}
            busy={busy}
            attach={attach}
            onSend={async (text, images, files) => {
              const taken = { ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) };
              // To the version on screen; words go to a newer one as they are.
              await deliver({ text, shown: text, askVersion: section.version, ...taken }, (now) => ({ text, shown: text, askVersion: now.version, ...taken }));
              // Only what was sent leaves: anything written while it was being sent stays.
              if (!latest.current || latest.current.text.trim() === text) keep(null);
              setRestored(false);
            }}
          />
        </>
      )}
      {notes.length > 0 && (
        <div className="home-ask-notes" role="status">
          <strong>
            <MessageSquareText size={14} />
            {ask.state === "open" ? t.notedWaiting : t.notedReplied}
          </strong>
          <ul>
            {notes.map((note) => (
              <li key={`${note.version}:${note.at}:${note.text}`}>
                {note.text && <p>{note.text}</p>}
                <ImageAttachments images={(note.images ?? []).map((id) => ({ id }))} imageUrl={(id, thumb) => homeImageUrl(context.projectId, id, thumb)} />
                <FileAttachments files={note.files ?? []} href={(file) => homeFileUrl(context.projectId, file.id, file.name)} projectId={context.projectId} />
                <small>
                  {relative(note.at, language)}
                  {note.version !== section.version && ` · ${t.noteOnVersion(note.version)}`}
                </small>
              </li>
            ))}
          </ul>
          {notes[0].version < section.version && <p className="home-note">{t.noteUpdated(section.owner.name)}</p>}
        </div>
      )}
      {onlyHere && <p className="home-note">{t.askDraftOnlyHere}</p>}
      {busy && <p className="home-note" role="status">{t.sending}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  );
}
