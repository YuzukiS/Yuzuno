import { Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStrings } from "../i18n";
import "./page-send.css";
import type { Agent } from "../types";
import { cardText } from "./card-text";
import { homeText } from "./home-text";
import { dropPendingReply, explain, OLDER_CORE, olderCore, pendingReply, sendReply } from "./home-api";
import type { Section } from "./types";

/**
 * Who a page's message goes to (YN-16 S6): the author of the section the page
 * belongs to, at the version shown. Nobody else: the page never chooses.
 */
export type PageReplyTo = {
  workspaceId: string;
  projectId: string;
  key: string;
  version: number;
  title: string;
  /** The page's file name, named in the message. */
  name: string;
  /** The author, when open in this Project; null when not, and then nothing is sent. */
  agent: { id: string; name: string } | null;
  /** The author as the section names them. */
  owner: string;
};

/** The author of `section` as this place knows them; `agents`, the Project's open Agents, where this place has them. */
export function pageReplyTo(section: Section, projectId: string, workspaceId: string, name: string, agents?: Agent[]): PageReplyTo {
  const { owner } = section;
  const listed = agents?.find((agent) => agent.id === owner.agentId);
  const open = owner.state === "active" && (!agents || !!listed);
  return {
    workspaceId, projectId, key: section.key, version: section.version, title: section.title, name,
    agent: open ? { id: owner.agentId, name: listed?.name || owner.name } : null,
    owner: owner.name,
  };
}

/** Its own slot in Home's outbox, apart from the card's reply and the ask's. */
export const pageSlot = (to: PageReplyTo) => JSON.stringify([to.workspaceId, to.projectId, to.key, "page", to.name]);

/** The message as the Agent reads it, under Core's line naming the section and its version. */
export const pageMessage = (name: string, text: string) => `From the page “${name}”:\n\n${text}`;

/** How long a newly shown message is read before Send takes it (S6 R1 P2): a
 * page cannot swap its text as the pointer leaves the frame for Send. */
export const READ_FIRST_MS = 1000;

export type PageSendState = {
  /** The page's newest message, not sent: a newer one replaces it. */
  offer: string | null;
  /** Shown long enough to have been read: Send takes it. Every new text starts unarmed. */
  armed: boolean;
  busy: boolean;
  /** Who the last one was sent to. */
  sent: string | null;
  /** Why the last one was not sent: Core's reason, or that this Core is too old to take it. */
  error: string | typeof OLDER_CORE;
  /** The text that failed, so Send again is named only for it. */
  failed: string | null;
};
const IDLE: PageSendState = { offer: null, armed: false, busy: false, sent: null, error: "", failed: null };

/** A page's messages, offered one at a time and sent only by the user, to `to`. */
export function usePageSend(to: PageReplyTo | null) {
  const [state, setState] = useState<PageSendState>(IDLE);
  const now = useRef(state);
  now.current = state;
  const target = useRef(to);
  target.current = to;
  // The page's newest text, set as it arrives, before any redraw: Send sends
  // only the text it showed, and only while nothing newer has come.
  const latest = useRef<string | null>(null);
  const slot = to ? pageSlot(to) : "";
  // Another page, version or author: what the last one offered is not this one's.
  const of = to ? `${slot} ${to.version} ${to.agent?.id ?? ""}` : "";
  useEffect(() => {
    latest.current = null;
    setState(IDLE);
  }, [of]);
  // A new text is armed once it has been shown READ_FIRST_MS; a newer one starts again.
  useEffect(() => {
    if (state.offer === null || state.armed) return;
    const shown = state.offer;
    const timer = setTimeout(() => setState((s) => (s.offer === shown ? { ...s, armed: true } : s)), READ_FIRST_MS);
    return () => clearTimeout(timer);
  }, [state.offer, state.armed]);
  const offer = useCallback((text: string) => {
    if (!target.current) return;
    latest.current = text;
    // The same text again changes nothing: it stays as read as it was.
    setState((s) => (s.offer === text ? s : { ...s, offer: text, armed: false, sent: null, error: s.busy ? s.error : "" }));
  }, []);
  /** Sends `text`, the message Send showed: refused unless it is still the newest and was shown long enough. */
  const send = useCallback(async (text: string) => {
    const to = target.current;
    const { offer: shown, armed, busy } = now.current;
    if (!to?.agent || busy || !armed || shown === null || text !== shown || latest.current !== shown) return;
    const slot = pageSlot(to);
    const agent = to.agent;
    latest.current = null;
    setState({ offer: null, armed: false, busy: true, sent: null, error: "", failed: null });
    try {
      // The same text again reuses its client id: Core never delivers it twice.
      await sendReply(slot, to.projectId, {
        key: to.key, agentId: agent.id, text: pageMessage(to.name, text), version: to.version, title: to.title, shown: text,
      });
      setState((s) => ({ ...s, busy: false, sent: agent.name }));
    } catch (error) {
      // Refused before it was read, so never submitted: no retry record.
      if (olderCore(error)) dropPendingReply(slot);
      // Not sent: the text the user read comes back as it was, ready to send again,
      // unless the page offered another meanwhile.
      if (latest.current === null) latest.current = text;
      setState((s) => ({ ...s, busy: false, error: explain(error), failed: text, ...(s.offer === null ? { offer: text, armed: true } : {}) }));
    }
  }, []);
  const discard = useCallback(() => {
    const to = target.current;
    if (!to || now.current.busy) return;
    // Discarded here; one not confirmed may still have been delivered.
    if (pendingReply(pageSlot(to))) dropPendingReply(pageSlot(to));
    latest.current = null;
    setState(IDLE);
  }, []);
  return { state, offer, send, discard };
}

/** Under the page's frame: its message, and Send or Don't send. Nothing goes without Send. */
export function PageSendBar({ to, state, onSend, onDiscard }: {
  to: PageReplyTo;
  state: PageSendState;
  /** With the text this bar shows: nothing else is ever sent. */
  onSend: (text: string) => void;
  onDiscard: () => void;
}) {
  const t = useStrings(cardText);
  const home = useStrings(homeText);
  if (state.offer === null && !state.busy && !state.sent && !state.error) return null;
  return (
    <div className="home-page-send" role="group" aria-label={t.pageSendLabel(to.name)}>
      {state.offer !== null && (
        <>
          <p className="home-page-send-head">{to.agent ? t.pageSendTo(to.agent.name, to.name) : t.pageSendNobody(to.owner, to.name)}</p>
          <p className="home-page-send-text">{state.offer}</p>
          <div className="home-page-send-actions">
            {to.agent && (
              <button type="button" className="primary-button" disabled={state.busy || !state.armed} onClick={() => onSend(state.offer!)}>
                <Send size={13} aria-hidden="true" /> {state.error && state.offer === state.failed ? t.pageSendAgain : t.pageSend}
              </button>
            )}
            <button type="button" className="secondary-button" disabled={state.busy} onClick={onDiscard}>
              {t.pageDontSend}
            </button>
          </div>
        </>
      )}
      {state.busy && <p className="home-note" role="status">{t.pageSending}</p>}
      {state.sent && state.offer === null && <p className="home-note" role="status">{t.pageSent(state.sent)}</p>}
      {state.error && <p className="inline-error" role="alert">{t.pageNotSent(state.error === OLDER_CORE ? home.olderCore : state.error)}</p>}
    </div>
  );
}
