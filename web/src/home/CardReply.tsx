import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { LoaderCircle, MessageSquareReply, Send, Trash2, X } from "lucide-react";
import { errorText, HttpError, shortcutModifier } from "../api";
import { CopyButton } from "../components";
import { useStrings } from "../i18n";
import { useSurfaceIn } from "../surface";
import { returnKey, returnSends, useDevicePreferences } from "../device-preferences";
import { touchKeyboard } from "../touch-input";
import type { Agent } from "../types";
import { TargetPicker } from "./AskReply";
import { dropPendingReply, outboxKey, pendingReply, sendReply } from "./home-api";
import { homeText } from "./home-text";
import { draftStore } from "./reply-drafts";
import type { ProjectPanel, Section } from "./types";

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

export type CardDraft = {
  key: string;
  text: string;
  /** The version and title the reply refers to. */
  version: number;
  title: string;
  agentId: string;
  at: string;
};

const drafts = draftStore<CardDraft>("yuzuno.home-card-drafts.v1");

/** `to` is null when the Agent had no name to show: worded when shown. */
type Sent = { status: string; to: string | null; version: number };
/** Why a send failed: Core's reason, or that this Core is too old, worded
 * when shown so it follows the interface language (T-189). */
const OLDER_CORE = Symbol("older Core");
/** One card's reply, shared by every place the card shows. */
type ReplyState = { draft: CardDraft | null; busy: boolean; error: string | typeof OLDER_CORE; sent: Sent | null };
const replies = new Map<string, ReplyState>();
const listeners = new Map<string, Set<() => void>>();

function replyState(slot: string): ReplyState {
  let state = replies.get(slot);
  if (!state) {
    state = { draft: drafts.load()[slot] ?? null, busy: false, error: "", sent: null };
    replies.set(slot, state);
  }
  return state;
}

/** Only text worth keeping is stored; the rest lives as long as this window. */
function update(slot: string, change: Partial<ReplyState>) {
  const next = { ...replyState(slot), ...change };
  replies.set(slot, next);
  if ("draft" in change) drafts.save(slot, next.draft?.text.trim() ? next.draft : null);
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
  return Object.entries(drafts.load()).filter(([slot, draft]) => slot === cardReplySlot(workspaceId, projectId, draft.key));
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

/**
 * Whether a card takes a reply where it shows (T-174): a live report or
 * status, or a History entry its project's referableHistory keeps (a pinned
 * report, or the report page, after the user marked it seen). Never an ask.
 */
export function replyableIn(panel: ProjectPanel | undefined, section: Section) {
  if (section.kind === "ask") return false;
  if (!section.history) return true;
  if (!panel) return false;
  const live = [...panel.brief.sections, ...(panel.brief.teamSections ?? [])].map((s) => s.key);
  return referableHistory(panel.brief.history, live).includes(section);
}

/** A Core from before card replies refuses the reply's version: nothing was sent. */
const olderCore = (error: unknown) =>
  error instanceof HttpError && /unknown field `(version|title)`/.test(errorText(error));

/** Core's reason without its code, or that an older Core refused the reply. */
function explain(error: unknown) {
  if (olderCore(error)) return OLDER_CORE;
  return errorText(error).replace(/^(section_changed|section_removed):\s*/, "");
}

export function CardReply({
  section,
  projectId,
  workspaceId,
  agents,
  opened = false,
  onClose,
}: {
  /** The card as this place shows it: live, or a report in History. */
  section: Section;
  projectId: string;
  workspaceId: string;
  /** The Project's open Agents. */
  agents: Agent[];
  /** The user has opened it here (T-19 HM:S7): it fades in and its text takes
   * focus, brought into view. A reply kept from before shows as it is. */
  opened?: boolean;
  /** Absent where the reply is the place's whole content (kept replies). */
  onClose?: () => void;
}) {
  const t = useStrings(homeText);
  const { sendKey } = useDevicePreferences();
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
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const shown = !!draft;
  useSurfaceIn(root, shown, "small", opened);
  useLayoutEffect(() => {
    if (!shown || !opened) return;
    root.current?.scrollIntoView?.({ block: "nearest" });
    field.current?.focus({ preventScroll: true });
    // Only as it comes in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  if (!draft) return null;
  // On the reply as it is now: another place, or a change not drawn yet, may
  // have moved it on since this render.
  const change = (patch: Partial<CardDraft>) =>
    update(slot, { draft: { ...(replyState(slot).draft ?? draft), ...patch, at: new Date().toISOString() } });
  const target = agents.some((a) => a.id === draft.agentId) ? draft.agentId : "";
  const named = agents.find((a) => a.id === target)?.name || null;
  const name = named ?? t.theAgent;
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
        sent: { status: receipt.status, to: named, version: reply.version },
        draft: { ...reply, text: "", version: section.version, title: section.title, at: new Date().toISOString() },
      });
    } catch (e) {
      // Refused before it was read, so never submitted: no retry record.
      if (olderCore(e)) dropPendingReply(slot);
      update(slot, { busy: false, error: explain(e) });
    }
  }
  return (
    <div className="home-card-reply" role="group" aria-label={t.replyLabel(draft.title)} ref={root}>
      <div className="home-card-reply-head">
        <MessageSquareReply size={13} aria-hidden="true" />
        <span>
          {t.replyTo} <strong>“{draft.title}”</strong> · {t.version(draft.version)}
        </span>
        {onClose && (
          <button type="button" className="icon-button" aria-label={t.closeReplyLabel} title={t.closeReply} onClick={onClose}>
            <X size={13} />
          </button>
        )}
      </div>
      <TargetPicker agents={agents} value={target} onChange={(agentId) => change({ agentId })} disabled={busy} label={t.to} />
      {!ownerOpen && (
        <p className="home-note">
          {t.chooseCardRecipient(section.owner.name, section.owner.state === "active" ? t.notInProject : t.ownerAway[section.owner.state])}
        </p>
      )}
      {changed && (
        <p className="home-note" role="status">
          {section.version > draft.version
            ? t.changedAfter(section.owner.name, section.version)
            : t.placeShows(section.version)}
          {t.stillRefers(draft.version)}{" "}
          {unconfirmed ? (
            t.sendAgainFirst
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
              {t.referTo(section.version)}
            </button>
          )}
        </p>
      )}
      {unconfirmed && (
        <p className="home-note">{t.notConfirmedHere}</p>
      )}
      <form
        className="home-text-reply"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={field}
          aria-label={t.replyField(draft.title)}
          value={draft.text}
          rows={2}
          maxLength={20_000}
          placeholder={t.replyFor(name)}
          onChange={(event) => change({ text: event.target.value })}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            // Return sends as it does from the conversation's composer (YN-3, device-preferences.ts returnKey).
            if (returnKey(event.nativeEvent, sendKey, touchKeyboard)) {
              event.preventDefault();
              void send();
            } else if (event.key === "Escape" && onClose) {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <button type="submit" className="primary-button" disabled={busy || !target || !draft.text.trim()} title={returnSends(sendKey, touchKeyboard()) ? t.sendTitleReturn : t.sendTitle(shortcutModifier)}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
          {t.send}
        </button>
      </form>
      {busy && <p className="home-note" role="status">{t.sending}</p>}
      {sent && (
        <p className="home-note" role="status">
          {sent.status === "queued" ? t.queuedFor(sent.to ?? t.theAgent, sent.version) : t.sentTo(sent.to ?? t.theAgent, sent.version)}
        </p>
      )}
      {error && <p className="inline-error" role="alert">{error === OLDER_CORE ? t.olderCore : error}</p>}
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
  const t = useStrings(homeText);
  const [, redraw] = useState(0);
  const kept = projectCardDrafts(workspaceId, projectId).filter(([, draft]) => !cardKeys.includes(draft.key));
  if (!kept.length) return null;
  return (
    <div className="home-kept-replies" role="list" aria-label={t.repliesNotSent}>
      {kept.map(([slot, draft]) => {
        const inHistory = referable.find((section) => section.key === draft.key);
        return (
          <div role="listitem" key={slot} className="home-kept-reply">
            {inHistory ? (
              <>
                <p className="home-note">{t.keptInHistory(draft.title)}</p>
                <CardReply section={inHistory} projectId={projectId} workspaceId={workspaceId} agents={agents} />
              </>
            ) : (
              <>
                <p className="home-note">{t.keptNotSent(draft.title, draft.version)}</p>
                <blockquote>{draft.text}</blockquote>
              </>
            )}
            <span className="home-kept-reply-actions">
              {!inHistory && (
                // Says it copied, or that it could not (T-19 HM:S11).
                <CopyButton text={draft.text} label={t.copyText} />
              )}
              <button
                type="button"
                className="quiet-button"
                onClick={() => {
                  update(slot, { draft: null });
                  redraw((n) => n + 1);
                }}
              >
                <Trash2 size={13} /> {t.discard}
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
