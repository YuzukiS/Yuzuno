import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, Search, X } from "lucide-react";
import { api, errorText, shortcutModifier } from "./api";
import {
  searchConversation,
  type ConversationMatch,
} from "./conversation-search";
import type { NativeTurn } from "./types";
import "./conversation-search.css";

export function ConversationSearch({
  agentName,
  turns,
  disabled,
  onNavigate,
  loadedNumbering = false,
  onLocate,
  savedAgentId,
  nativeHistory = [],
}: {
  agentName: string;
  turns: NativeTurn[];
  loadedNumbering?: boolean;
  disabled: boolean;
  onNavigate: () => void;
  /** Loads/mounts an offscreen result before placing the reading position. */
  onLocate?: (result: ConversationMatch) => void;
  savedAgentId?: string;
  /** Explicitly loaded Codex pages whose full bodies are not stored by Core. */
  nativeHistory?: NativeTurn[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const destination = useRef<ConversationMatch | null>(null);
  const highlight = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  const localResults = useMemo(
    () => (open ? searchConversation(turns, query) : []),
    [turns, query, open],
  );
  const [remote, setRemote] = useState<{agentId:string; query:string; results:ConversationMatch[]}|null>(null);
  const [searching, setSearching] = useState(false);
  const nativeResults = useMemo(() => open ? searchConversation(nativeHistory, query) : [], [nativeHistory, query, open]);
  const results = savedAgentId ? [...nativeResults,
    ...(remote?.agentId === savedAgentId && remote.query === query ? remote.results : [])].slice(0,50) : localResults;
  useEffect(() => {
    if (!savedAgentId || !open || !query.trim()) { setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      api<ConversationMatch[]>(`/agents/${encodeURIComponent(savedAgentId)}/conversation/search?${new URLSearchParams({q:query})}`, {signal:controller.signal})
        .then(results => { if (!controller.signal.aborted) setRemote({agentId:savedAgentId, query, results}); }, e => { if (!controller.signal.aborted) setError(errorText(e)); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [savedAgentId, open, query]);

  function clearHighlight() {
    clearTimeout(timer.current);
    highlight.current?.removeAttribute("data-search-highlight");
    highlight.current = null;
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      destination.current = null;
      clearHighlight();
    };
  }, []);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        disabled
      )
        return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f")
        return;
      // Leave shortcuts in file previews and other dialogs to their own context.
      if (!open && document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setOpen(true);
      input.current?.focus();
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [disabled, open]);

  function findMessage(result: ConversationMatch) {
    const turn = document.getElementById(`turn-${result.turnId}`);
    return Array.from(
      turn?.querySelectorAll<HTMLElement>("[data-item-id]") || [],
    ).find((element) => element.dataset.itemId === result.itemId);
  }

  function select(result: ConversationMatch) {
    if (!onLocate && !findMessage(result)) {
      setError(
        "This message is no longer available in the loaded conversation.",
      );
      return;
    }
    // Stop following immediately, before dialog dismissal and any live refresh.
    onNavigate();
    destination.current = result;
    setOpen(false);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        setError("");
      }}
    >
      <Dialog.Trigger asChild>
        <button
          className="conversation-action conversation-search-trigger"
          aria-label="Search conversation"
          title={`Search this conversation (${shortcutModifier}+F)`}
          aria-keyshortcuts="Control+F Meta+F"
          disabled={disabled}
        >
          <Search size={16} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal conversation-search-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            // Radix handles this during capture, before the global Interrupt shortcut.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
          onCloseAutoFocus={(event) => {
            if (!mounted.current) {
              event.preventDefault();
              return;
            }
            const result = destination.current;
            if (!result) return;
            event.preventDefault();
            destination.current = null;
            if (onLocate) { onLocate(result); return; }
            const target = findMessage(result);
            if (!target) {
              setError(
                "This message is no longer available in the loaded conversation.",
              );
              setOpen(true);
              return;
            }
            clearHighlight();
            target.scrollIntoView({ behavior: "instant", block: "start" });
            target.focus({ preventScroll: true });
            target.dataset.searchHighlight = "true";
            highlight.current = target;
            timer.current = setTimeout(clearHighlight, 2600);
          }}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>Search conversation</Dialog.Title>
              <Dialog.Description>
                {agentName} · {savedAgentId ? "Core-saved messages, including unloaded history. Up to 50 results." : "Loaded messages only."}
                {savedAgentId && loadedNumbering && " Native history is searched only in pages you have loaded."} Tool output is excluded.
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="icon-button"
              aria-label="Close conversation search"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <label className="sr-only" htmlFor={inputId}>
            {savedAgentId ? "Search saved messages" : "Search loaded messages"}
          </label>
          <input
            ref={input}
            id={inputId}
            className="conversation-search-input"
            type="search"
            placeholder="Find something in this conversation…"
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setError("");
            }}
          />
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
          <p className="conversation-search-status" role="status">
            {searching ? "Searching saved messages…" : !query.trim()
              ? "Search user messages, agent progress, and replies."
              : results.length
                ? `${results.length} matching ${results.length === 1 ? "message" : "messages"}`
                : "No messages match your search."}
          </p>
          <ol
            className="conversation-search-results"
            aria-label="Matching messages"
          >
            {results.map((result) => (
              <li key={JSON.stringify([result.turnId, result.itemId])}>
                <button
                  className="conversation-search-result"
                  onClick={() => select(result)}
                >
                  <span className="conversation-search-meta">
                    <strong>
                      {result.role === "user"
                        ? "You"
                        : `${agentName} · ${result.role === "progress" ? "Progress" : "Reply"}`}
                    </strong>
                    <span>
                      {loadedNumbering ? "Loaded turn" : "Turn"}{" "}
                      {result.turnNumber}
                    </span>
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </span>
                  <span className="conversation-search-snippet">
                    {result.before}
                    <mark>{result.match}</mark>
                    {result.after}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
