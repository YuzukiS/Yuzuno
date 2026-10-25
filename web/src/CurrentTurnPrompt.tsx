import { MessageContent } from "./MessageContent";
import { userRequestText } from "./message-content";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, Pin } from "lucide-react";
import { isPeerInput } from "./components";
import type { NativeTurn } from "./types";
import { langTag, strings, useLanguage } from "./i18n";

// The prompt's own words (T-189); the requests as the user wrote them.
const text = strings({
  requestFor: (loaded: boolean, number: number) => `Your request for ${loaded ? "loaded turn" : "turn"} ${number}`,
  yourRequest: "Your request",
  turn: (loaded: boolean): string => (loaded ? "Loaded turn" : "Turn"),
  messages: "This turn’s user messages",
  original: "Original request",
  followUp: (index: number) => `Follow-up ${index}`,
  preview: "Request preview · ",
  view: "View in conversation",
}, {
  requestFor: (loaded, number) => `你在第 ${number} 个${loaded ? "已载入的 " : ""}Turn 中的请求`,
  yourRequest: "你的请求",
  turn: (loaded) => (loaded ? "已载入的 Turn" : "Turn"),
  messages: "这个 Turn 中的用户消息",
  original: "原始请求",
  followUp: (index) => `追加 ${index}`,
  preview: "请求预览 · ",
  view: "在会话中查看",
});
import "./turn-navigation.css";

export function userRequests(turn: NativeTurn) {
  const firstUser = turn.items.find((item) => item.type === "userMessage");
  return turn.items
    .filter(
      (item) =>
        item.type === "userMessage" && !isPeerInput(turn, item, firstUser),
    )
    .map((item) => ({ id: item.id, text: userRequestText(item), blocks: item._yuzunoTextBlocks }))
    .filter((item) => item.text);
}

export function CurrentTurnPrompt({
  turn,
  number,
  loadedNumbering = false,
  loaded = false,
  scrollRef,
  onLocate,
}: {
  turn: NativeTurn;
  number: number;
  loadedNumbering?: boolean;
  /** The Turn is among the conversation's loaded Turns, not elsewhere in
   * its history. */
  loaded?: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onLocate?: () => void;
}) {
  const messages = userRequests(turn);
  const pin = useRef<HTMLDetailsElement>(null);
  const [pinned, setPinned] = useState(true);
  const original = messages[0]?.id;
  const items = useRef(turn.items);
  items.current = turn.items;

  // The pin is the original request held at the top edge: hidden while the
  // original is in view, sliding in with the scroll as it leaves over the top.
  useLayoutEffect(() => {
    const element = pin.current;
    // The pin comes before the scroller, so when both mount together (back
    // from Catch up) this runs before the scroller's ref is set. Its node is
    // already in the DOM.
    const scroller =
      scrollRef.current ??
      element?.parentElement?.querySelector<HTMLDivElement>(
        ".conversation-scroll",
      ) ??
      null;
    if (!scroller || !element || !original) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const below = (node: HTMLElement | null) => {
      if (!node) return true;
      // The Turn's items as they are now; a running Turn keeps growing.
      const order = new Map(items.current.map((item, index) => [item.id, index]));
      const at = order.get(original);
      if (at === undefined) return false;
      // How far the reader has come: the items in view or above it. Rows
      // kept mounted for focus or a selection may lie anywhere below.
      const end = scroller.getBoundingClientRect().bottom;
      const reached = Array.from(node.querySelectorAll<HTMLElement>("[data-item-id]"))
        .filter((item) => item.getBoundingClientRect().top < end)
        .map((item) => order.get(item.dataset.itemId ?? ""))
        .filter((index): index is number => index !== undefined);
      return !reached.length || at > Math.max(...reached);
    };
    let frame = 0;
    let height = 0;
    let shown: boolean | undefined;
    const update = () => {
      frame = 0;
      if (!element.open) height = element.offsetHeight;
      const node = scroller.ownerDocument.getElementById(`turn-${turn.id}`);
      const source = Array.from(
        node?.querySelectorAll<HTMLElement>(".user-message") ?? [],
      ).find((message) => message.dataset.itemId === original);
      let progress = 1;
      // Open or focused, it stays put under the reader's hand.
      const free =
        !!height && !element.open && !element.contains(document.activeElement);
      // A loaded original that is not mounted lies outside the conversation's
      // window (T-77): hidden, as one in view below is, when it is below what
      // is read. A loaded Turn not mounted at all is, as the running Turn is
      // the last; within a mounted Turn, one that comes after everything in
      // view or above it is, such as a first own request after a peer's start.
      if (free && !source && loaded && below(node)) progress = 0;
      if (source && free) {
        const edge = scroller.getBoundingClientRect().top;
        const box = source.getBoundingClientRect();
        // Follow the top out of view; a long request first scrolls until
        // only a pin's height of it is left.
        const travel = Math.min(
          edge - box.top,
          2 * height - (box.bottom - edge),
        );
        progress = Math.max(0, Math.min(1, travel / height));
        if (still?.matches) progress = progress < 1 ? 0 : 1;
      }
      element.style.setProperty("--pin-progress", String(progress));
      if (progress > 0 !== shown) {
        shown = progress > 0;
        setPinned(shown);
      }
      // Jumps land below the pin at its current size, including a jump that
      // only brings it in by moving the original out of view.
      const room = `${element.offsetHeight + 16}px`;
      if (scroller.style.scrollPaddingTop !== room)
        scroller.style.scrollPaddingTop = room;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    element.addEventListener("toggle", schedule);
    element.addEventListener("focusin", schedule);
    element.addEventListener("focusout", schedule);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(scroller);
    observer?.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      scroller.removeEventListener("scroll", schedule);
      element.removeEventListener("toggle", schedule);
      element.removeEventListener("focusin", schedule);
      element.removeEventListener("focusout", schedule);
      scroller.style.scrollPaddingTop = "";
    };
  }, [scrollRef, turn.id, original, loaded]);

  const language = useLanguage();
  const t = text(language);
  if (!messages.length) return null;
  return (
    <details
      ref={pin}
      className="current-turn-prompt"
      data-pinned={pinned}
      aria-hidden={!pinned || undefined}
      inert={!pinned}
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.currentTarget.open) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary
        aria-label={t.requestFor(!!loadedNumbering, number)}
      >
        <span className="current-turn-label" lang={langTag(language)}>
          <Pin size={12} aria-hidden="true" />
          <strong>{t.yourRequest}</strong>
          <span>
            {t.turn(!!loadedNumbering)} {number}
          </span>
          {(turn._yuzunoRequestCount ?? messages.length) > 1 && (
            <span className="current-turn-additions">
              +{(turn._yuzunoRequestCount ?? messages.length) - 1}
            </span>
          )}
          <ChevronDown
            size={13}
            aria-hidden="true"
            className="current-turn-chevron"
          />
        </span>
        <span className="current-turn-excerpt"><MessageContent text={messages[0].text} blocks={messages[0].blocks} compact /></span>
      </summary>
      <ol
        className="current-turn-messages"
        aria-label={t.messages}
      >
        {messages.map((message, index) => (
          <li key={message.id}>
            {messages.length > 1 && (
              <small>
                {index === 0 ? t.original : t.followUp(index)}
              </small>
            )}
            <p><MessageContent text={message.text} blocks={message.blocks} /></p>
          </li>
        ))}
      </ol>
      {turn._yuzunoIndex === true && <p>{t.preview}<button className="inline-link" onClick={onLocate}>{t.view}</button></p>}
    </details>
  );
}
