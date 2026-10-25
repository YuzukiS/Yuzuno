import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, Search, X } from "lucide-react";
import { api, errorText, shortcutModifier } from "./api";
import {
  searchConversation,
  type ConversationMatch,
} from "./conversation-search";
import type { NativeTurn } from "./types";
import { langTag, strings, useLanguage } from "./i18n";
import { pressed, shortcutKeys, useShortcutKeys } from "./shortcut-keys";
import "./conversation-search.css";

// Kept as this English sentence and said in the language shown (T-189).
const GONE = "This message is no longer available in the loaded conversation.";
// The search's own words (T-189); messages, names and Core's errors as they came.
const text = strings({
  gone: GONE,
  search: "Search conversation",
  searchTitle: (modifier: string, key: string) => `Search this conversation (${modifier}+${key})`,
  saved: "Core-saved messages, including unloaded history. Up to 50 results.",
  loaded: "Loaded messages only.",
  nativePages: " Native history is searched only in pages you have loaded.",
  noTools: " Tool output is excluded.",
  close: "Close conversation search",
  searchSaved: "Search saved messages",
  searchLoaded: "Search loaded messages",
  placeholder: "Find something in this conversation…",
  searching: "Searching saved messages…",
  empty: "Search user messages, agent progress, and replies.",
  matching: (count: number) => `${count} matching ${count === 1 ? "message" : "messages"}`,
  none: "No messages match your search.",
  results: "Matching messages",
  you: "You",
  progress: "Progress",
  reply: "Reply",
  loadedTurn: "Loaded turn",
  turn: "Turn",
}, {
  gone: "已载入的会话中不再有这条消息。",
  search: "搜索会话",
  searchTitle: (modifier, key) => `搜索此会话（${modifier}+${key}）`,
  saved: "Core 保存的消息，包括未载入的历史。最多 50 条结果。",
  loaded: "仅限已载入的消息。",
  nativePages: "原生历史只在你已载入的页面中搜索。",
  noTools: "不包括工具输出。",
  close: "关闭会话搜索",
  searchSaved: "搜索已保存的消息",
  searchLoaded: "搜索已载入的消息",
  placeholder: "在此会话中查找…",
  searching: "正在搜索已保存的消息…",
  empty: "搜索用户消息、Agent 进展和回复。",
  matching: (count) => `${count} 条匹配的消息`,
  none: "没有与搜索匹配的消息。",
  results: "匹配的消息",
  you: "你",
  progress: "进展",
  reply: "回复",
  loadedTurn: "已载入的 Turn",
  turn: "Turn",
});

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
  const language = useLanguage();
  const t = text(language);
  const keys = useShortcutKeys();
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
      // This device's letter for it (shortcut-keys.ts), read as pressed.
      if (!pressed(event, shortcutKeys().search)) return;
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
      setError(GONE);
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
          aria-label={t.search}
          title={t.searchTitle(shortcutModifier, keys.search)}
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
          lang={langTag(language)}
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
              setError(GONE);
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
              <Dialog.Title>{t.search}</Dialog.Title>
              <Dialog.Description>
                {agentName} · {savedAgentId ? t.saved : t.loaded}
                {savedAgentId && loadedNumbering && t.nativePages}{t.noTools}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="icon-button"
              aria-label={t.close}
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <label className="sr-only" htmlFor={inputId}>
            {savedAgentId ? t.searchSaved : t.searchLoaded}
          </label>
          <input
            ref={input}
            id={inputId}
            className="conversation-search-input"
            type="search"
            placeholder={t.placeholder}
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setError("");
            }}
          />
          {error && (
            <p role="alert" className="inline-error">
              {error === GONE ? t.gone : error}
            </p>
          )}
          <p className="conversation-search-status" role="status">
            {searching ? t.searching : !query.trim()
              ? t.empty
              : results.length
                ? t.matching(results.length)
                : t.none}
          </p>
          <ol
            className="conversation-search-results"
            aria-label={t.results}
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
                        ? t.you
                        : `${agentName} · ${result.role === "progress" ? t.progress : t.reply}`}
                    </strong>
                    <span>
                      {loadedNumbering ? t.loadedTurn : t.turn}{" "}
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
