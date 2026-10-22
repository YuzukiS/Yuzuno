import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
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
 * no ask, task or Seen mark.
 *
 * A card can show in several places at once (its project, a pinned widget,
 * History): every place shows the same reply, one per card, so the text, the
 * version it refers to and a send in progress are shared, and a send started
 * in one place blocks another anywhere. Drafts are kept across reloads until
 * sent or discarded, also after their card has left Home.
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

type Sent = { status: string; to: string; version: number };
/** One card's reply, shared by every place the card shows. */
type ReplyState = { draft: CardDraft | null; busy: boolean; error: string; sent: Sent | null };
const replies = new Map<string, ReplyState>();
const listeners = new Map<string, Set<() => void>>();

function replyState(slot: string): ReplyState {
  let state = replies.get(slot);
  if (!state) {
    state = { draft: loadDrafts()[slot] ?? null, busy: false, error: "", sent: null };
    replies.set(slot, state);
  }
  return state;
}

/** Only text worth keeping is stored; the rest lives as long as this window. */
function update(slot: string, change: Partial<ReplyState>) {
  const next = { ...replyState(slot), ...change };
  replies.set(slot, next);
  if ("draft" in change) saveDraft(slot, next.draft?.text.trim() ? next.draft : null);
  listeners.get(slot)?.forEach((listener) => listener());
}

function useReplyState(slot: string) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const set = listeners.get(slot) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(slot, set);
      return () => void set.delete(listener);
    },
    [slot],
  );
  return useSyncExternalStore(subscribe, () => replyState(slot));
}

export const cardReplySlot = (workspaceId: string, projectId: string, key: string) =>
  outboxKey(workspaceId, projectId, key, true);

/** A reply here that is being written, or whose sending is not confirmed. */
export const hasCardReply = (slot: string) => !!replyState(slot).draft?.text.trim() || !!pendingReply(slot);

/** This project's kept drafts, by slot. */
export function projectCardDrafts(workspaceId: string, projectId: string): [string, CardDraft][] {
  return Object.entries(loadDrafts()).filter(([slot, draft]) => slot === cardReplySlot(workspaceId, projectId, draft.key));
}

/**
 * The History entries a reply can still refer to: each key's newest report
 * the user marked seen, while no section under its key is live. Removed,
 * resolved and expired entries, asks, and older versions never take one.
 */
export function referableHistory(history: Section[], liveKeys: string[]) {
  const seen = new Set<string>();
  return history.filter((section) => {
    if (seen.has(section.key)) return false;
    seen.add(section.key);
    return section.kind === "report" && section.historyReason === "seen" && !liveKeys.includes(section.key);
  });
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
  /** The card as this place shows it: live, or a report in History. */
  section: Section;
  projectId: string;
  workspaceId: string;
  /** The Project's open Agents. */
  agents: Agent[];
  /** Absent where the reply is the place's whole content (kept replies). */
  onClose?: () => void;
}) {
  const slot = cardReplySlot(workspaceId, projectId, section.key);
  const { draft, busy, error, sent } = useReplyState(slot);
  const ownerOpen = section.owner.state === "active" && agents.some((a) => a.id === section.owner.agentId);
  // Begun here when no place has one: bound to the version on screen now, or
  // to the one an unconfirmed send names.
  useEffect(() => {
    if (replyState(slot).draft) return;
    const kept = pendingReply(slot);
    update(slot, {
      draft: {
        key: section.key,
        text: kept?.text ?? "",
        version: kept?.version ?? section.version,
        title: kept?.version !== undefined ? kept.title ?? section.title : section.title,
        agentId: kept?.agentId ?? (ownerOpen ? section.owner.agentId : ""),
        at: new Date().toISOString(),
      },
    });
  });
  if (!draft) return null;
  const change = (patch: Partial<CardDraft>) =>
    update(slot, { draft: { ...draft, ...patch, at: new Date().toISOString() } });
  const target = agents.some((a) => a.id === draft.agentId) ? draft.agentId : "";
  const name = agents.find((a) => a.id === target)?.name || "the Agent";
  const changed = section.version !== draft.version;
  // An attempt Core has not answered: only its retry, unchanged, is safe.
  const unconfirmed = !busy && !!pendingReply(slot);
  async function send() {
    // Read now, not from this render: another place may be sending.
    const current = replyState(slot);
    const reply = current.draft;
    const value = reply?.text.trim();
    if (!reply || !value || !target || current.busy) return;
    update(slot, { busy: true, error: "", sent: null });
    try {
      const receipt = await sendReply(slot, projectId, {
        key: reply.key,
        agentId: target,
        text: value,
        version: reply.version,
        title: reply.title,
      });
      // The next reply here begins afresh, at the version now on screen; the
      // box stays where it is.
      update(slot, {
        busy: false,
        sent: { status: receipt.status, to: name, version: reply.version },
        draft: { ...reply, text: "", version: section.version, title: section.title, at: new Date().toISOString() },
      });
    } catch (e) {
      // Refused before it was read, so never submitted: no retry record.
      if (olderCore(e)) dropPendingReply(slot);
      update(slot, { busy: false, error: explain(e) });
    }
  }
  return (
    <div className="home-card-reply" role="group" aria-label={`Reply to “${draft.title}”`}>
      <div className="home-card-reply-head">
        <MessageSquareReply size={13} aria-hidden="true" />
        <span>
          Reply to <strong>“{draft.title}”</strong> · version {draft.version}
        </span>
        {onClose && (
          <button type="button" className="icon-button" aria-label="Close the reply; the draft is kept" title="Close (the draft is kept)" onClick={onClose}>
            <X size={13} />
          </button>
        )}
      </div>
      <TargetPicker agents={agents} value={target} onChange={(agentId) => change({ agentId })} disabled={busy} label="To" />
      {!ownerOpen && (
        <p className="home-note">
          {section.owner.name} {section.owner.state === "active" ? "is not in this project" : ownerAway[section.owner.state]}; choose who should get this reply.
        </p>
      )}
      {changed && (
        <p className="home-note" role="status">
          {section.version > draft.version
            ? `${section.owner.name} changed this card after you began (now version ${section.version}). `
            : `This place shows version ${section.version}. `}
          Your reply still refers to version {draft.version}, as you saw it; Home sends it only while it has that version.{" "}
          {unconfirmed ? (
            "Send it again first: Core then says whether the earlier attempt arrived."
          ) : (
            <button
              type="button"
              className="inline-link"
              disabled={busy}
              onClick={() => {
                change({ version: section.version, title: section.title });
                update(slot, { error: "" });
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
          aria-label={`Reply to ${draft.title}`}
          value={draft.text}
          rows={2}
          maxLength={20_000}
          placeholder={`A reply for ${name}…`}
          onChange={(event) => change({ text: event.target.value })}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            } else if (event.key === "Escape" && onClose) {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <button type="submit" className="primary-button" disabled={busy || !target || !draft.text.trim()} title={`Send (${shortcutModifier} Enter)`}>
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
 * Replies begun on cards no longer live on Home. One whose card is a report
 * still in History, marked seen, can be sent from here; any other (removed,
 * now an ask, hidden) is kept with its text and never sent to another card.
 */
export function KeptCardReplies({
  projectId,
  workspaceId,
  agents,
  cardKeys,
  referable,
}: {
  projectId: string;
  workspaceId: string;
  agents: Agent[];
  /** Keys of the live report and status cards this project shows. */
  cardKeys: string[];
  /** History entries a reply may still refer to (referableHistory). */
  referable: Section[];
}) {
  const [, redraw] = useState(0);
  const kept = projectCardDrafts(workspaceId, projectId).filter(([, draft]) => !cardKeys.includes(draft.key));
  if (!kept.length) return null;
  return (
    <div className="home-kept-replies" role="list" aria-label="Replies not sent">
      {kept.map(([slot, draft]) => {
        const inHistory = referable.find((section) => section.key === draft.key);
        return (
          <div role="listitem" key={slot} className="home-kept-reply">
            {inHistory ? (
              <>
                <p className="home-note">Your reply to “{draft.title}” is kept: that card is now in History, marked seen.</p>
                <CardReply section={inHistory} projectId={projectId} workspaceId={workspaceId} agents={agents} />
              </>
            ) : (
              <>
                <p className="home-note">
                  Your reply to “{draft.title}” (version {draft.version}) was not sent: that card is no longer on Home.
                </p>
                <blockquote>{draft.text}</blockquote>
              </>
            )}
            <span className="home-kept-reply-actions">
              {!inHistory && (
                <button type="button" className="quiet-button" onClick={() => void navigator.clipboard?.writeText(draft.text)}>
                  <Copy size={13} /> Copy text
                </button>
              )}
              <button
                type="button"
                className="quiet-button"
                onClick={() => {
                  update(slot, { draft: null });
                  redraw((n) => n + 1);
                }}
              >
                <Trash2 size={13} /> Discard
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
