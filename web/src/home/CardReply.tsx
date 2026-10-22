import { useEffect, useRef, useState } from "react";
import { Copy, LoaderCircle, MessageSquareReply, Send, Trash2, X } from "lucide-react";
import { errorText, HttpError, shortcutModifier } from "../api";
import type { Agent } from "../types";
import { TargetPicker } from "./AskReply";
import { dropPendingReply, outboxKey, pendingReply, sendReply } from "./home-api";
import type { Section } from "./types";

/**
 * Replies to report and status cards (T-174). A reply goes to the card's
 * author, or to an Agent the user picks when the author can't take it, as one
 * user message through Core. It names the card's key, title and the version
 * on screen when the user began it. A newer version arriving meanwhile never
 * changes what the reply refers to: Core sends it only while it still has
 * that version, and the user can refer the reply to the newer one. It changes
 * no ask, task or Seen mark. Drafts are kept across reloads until sent or
 * discarded, also after their card has left Home.
 */

const DRAFTS = "yuzuno.home-card-drafts.v1";
const MAX_DRAFTS = 50;
const KEEP_DAYS = 30;

export type CardDraft = {
  key: string;
  text: string;
  /** The version and title the reply refers to. */
  version: number;
  title: string;
  agentId: string;
  at: string;
};

function loadDrafts(): Record<string, CardDraft> {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFTS) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function saveDraft(slot: string, draft: CardDraft | null) {
  const drafts = loadDrafts();
  if (draft) drafts[slot] = draft;
  else delete drafts[slot];
  const since = Date.now() - KEEP_DAYS * 86_400_000;
  const kept = Object.entries(drafts)
    .filter(([, d]) => Date.parse(d.at) >= since)
    .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
    .slice(0, MAX_DRAFTS);
  try {
    if (kept.length) localStorage.setItem(DRAFTS, JSON.stringify(Object.fromEntries(kept)));
    else localStorage.removeItem(DRAFTS);
  } catch {
    /* This window still has the draft. */
  }
}

export const cardReplySlot = (workspaceId: string, projectId: string, key: string) =>
  outboxKey(workspaceId, projectId, key, true);

/** A reply here that is being written, or whose sending is not confirmed. */
export const hasCardReply = (slot: string) => !!loadDrafts()[slot] || !!pendingReply(slot);

/** This project's drafts, by slot. */
export function projectCardDrafts(workspaceId: string, projectId: string): [string, CardDraft][] {
  return Object.entries(loadDrafts()).filter(([slot, draft]) => slot === cardReplySlot(workspaceId, projectId, draft.key));
}

/** A Core from before card replies refuses the reply's version: nothing was sent. */
const olderCore = (error: unknown) =>
  error instanceof HttpError && /unknown field `(version|title)`/.test(errorText(error));

/** Core's reason without its code, or why an older Core refused the reply. */
function explain(error: unknown) {
  if (olderCore(error))
    return "This Core can't bind a reply to a card version yet, so nothing was sent. Update Core to reply to cards, or write to the Agent in its conversation.";
  return errorText(error).replace(/^(section_changed|section_removed):\s*/, "");
}

const ownerAway = { closed: "is closed", deleted: "was deleted", moved: "is no longer in this project" } as const;

export function CardReply({
  section,
  projectId,
  workspaceId,
  agents,
  onClose,
}: {
  section: Section;
  projectId: string;
  workspaceId: string;
  /** The Project's open Agents. */
  agents: Agent[];
  onClose: () => void;
}) {
  const slot = cardReplySlot(workspaceId, projectId, section.key);
  const [kept] = useState(() => pendingReply(slot));
  const [draft] = useState(() => loadDrafts()[slot]);
  // What the reply refers to: fixed when it was begun, changed only by the user.
  const [bound, setBound] = useState(() =>
    kept?.version !== undefined
      ? { version: kept.version, title: kept.title ?? section.title }
      : draft
        ? { version: draft.version, title: draft.title }
        : { version: section.version, title: section.title },
  );
  const ownerOpen = section.owner.state === "active" && agents.some((a) => a.id === section.owner.agentId);
  const [target, setTarget] = useState(() => {
    const chosen = kept?.agentId || draft?.agentId;
    if (chosen && agents.some((a) => a.id === chosen)) return chosen;
    return ownerOpen ? section.owner.agentId : "";
  });
  const [text, setText] = useState(() => draft?.text ?? kept?.text ?? "");
  const [busy, setBusy] = useState(false);
  // Set at once, before React draws `busy`: a second click or Enter in the
  // same moment sends nothing more.
  const sending = useRef(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<{ status: string; to: string; version: number } | null>(null);
  useEffect(() => {
    if (!text.trim()) saveDraft(slot, null);
    else saveDraft(slot, { key: section.key, text, ...bound, agentId: target, at: new Date().toISOString() });
  }, [slot, section.key, text, bound, target]);
  const changed = section.version !== bound.version;
  // An attempt Core has not answered: only its retry, unchanged, is safe.
  const unconfirmed = !busy && pendingReply(slot);
  const name = agents.find((a) => a.id === target)?.name || "the Agent";
  async function send() {
    const value = text.trim();
    if (!value || !target || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setSent(null);
    try {
      const receipt = await sendReply(slot, projectId, {
        key: section.key,
        agentId: target,
        text: value,
        version: bound.version,
        title: bound.title,
      });
      setText("");
      setSent({ status: receipt.status, to: name, version: bound.version });
    } catch (e) {
      // Refused before it was read, so never submitted: no retry record.
      if (olderCore(e)) dropPendingReply(slot);
      setError(explain(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="home-card-reply" role="group" aria-label={`Reply to “${bound.title}”`}>
      <div className="home-card-reply-head">
        <MessageSquareReply size={13} aria-hidden="true" />
        <span>
          Reply to <strong>“{bound.title}”</strong> · version {bound.version}
        </span>
        <button type="button" className="icon-button" aria-label="Close the reply; the draft is kept" title="Close (the draft is kept)" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <TargetPicker agents={agents} value={target} onChange={setTarget} disabled={busy} label="To" />
      {!ownerOpen && (
        <p className="home-note">
          {section.owner.name} {section.owner.state === "active" ? "is not in this project" : ownerAway[section.owner.state]}; choose who should get this reply.
        </p>
      )}
      {changed && (
        <p className="home-note" role="status">
          {section.owner.name} changed this card after you began (now version {section.version}). Your reply still refers to version {bound.version}, as
          you saw it; Home sends it only while it has that version.{" "}
          {unconfirmed ? (
            "Send it again first: Core then says whether the earlier attempt arrived."
          ) : (
            <button
              type="button"
              className="inline-link"
              disabled={busy}
              onClick={() => {
                setBound({ version: section.version, title: section.title });
                setError("");
              }}
            >
              Refer it to version {section.version}
            </button>
          )}
        </p>
      )}
      {unconfirmed && (
        <p className="home-note">An earlier reply here was not confirmed. Sending the same text again will not deliver it twice.</p>
      )}
      <form
        className="home-text-reply"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label={`Reply to ${bound.title}`}
          value={text}
          rows={2}
          maxLength={20_000}
          placeholder={`A reply for ${name}…`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <button type="submit" className="primary-button" disabled={busy || !target || !text.trim()} title={`Send (${shortcutModifier} Enter)`}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
          Send
        </button>
      </form>
      {busy && <p className="home-note" role="status">Sending…</p>}
      {sent && (
        <p className="home-note" role="status">
          {sent.status === "queued"
            ? `Queued for ${sent.to}, referring to version ${sent.version}; not confirmed as read yet.`
            : `Sent to ${sent.to}, referring to version ${sent.version}.`}
        </p>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  );
}

/**
 * Replies begun on cards that are no longer on Home (removed, marked seen,
 * now an ask, or hidden): kept with their text, never sent to another card.
 */
export function KeptCardReplies({ projectId, workspaceId, shownKeys }: { projectId: string; workspaceId: string; shownKeys: string[] }) {
  const [, redraw] = useState(0);
  const kept = projectCardDrafts(workspaceId, projectId).filter(([, draft]) => !shownKeys.includes(draft.key));
  if (!kept.length) return null;
  return (
    <div className="home-kept-replies" role="list" aria-label="Replies not sent">
      {kept.map(([slot, draft]) => (
        <div role="listitem" key={slot} className="home-kept-reply">
          <p className="home-note">
            Your reply to “{draft.title}” (version {draft.version}) was not sent: that card is no longer on Home.
          </p>
          <blockquote>{draft.text}</blockquote>
          <span className="home-kept-reply-actions">
            <button type="button" className="quiet-button" onClick={() => void navigator.clipboard?.writeText(draft.text)}>
              <Copy size={13} /> Copy text
            </button>
            <button
              type="button"
              className="quiet-button"
              onClick={() => {
                saveDraft(slot, null);
                redraw((n) => n + 1);
              }}
            >
              <Trash2 size={13} /> Discard
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
