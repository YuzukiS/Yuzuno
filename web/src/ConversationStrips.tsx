import { Children, isValidElement, useLayoutEffect, useRef, type ReactNode } from "react";
import "./conversation-strips.css";

/**
 * The strips over the conversation's top: another browser's place offered,
 * and the source being read with its way back (T-19 SH:C08, CV:CW-11). They
 * float over the conversation instead of standing above it, so one that
 * appears while someone reads moves no text; each fades in over small
 * (conversation-strips.css). Their height is the conversation's
 * `--strips-height`: the request pin sits below them, the conversation's
 * text starts below them, so scrolling up brings out whatever they cover,
 * and as scroll padding it places a target a jump puts at the top clear of
 * them. It is set in the commit that shows or takes away a strip, before
 * the jump that opened a source places its target, and again whenever they
 * change size, and written only when it changed: not on every render, as
 * App renders often while a Turn streams (R2 5db2b3cc). What is in view
 * stays where it was as that padding comes and goes, at the conversation's
 * very top too (R1 f0b0a715), by the conversation's own hold on its place:
 * ConversationWindow's ReadingAnchor while it is read, in the commit that
 * changes the padding, and App's followGrowth while it follows its end (it
 * watches the pane, whose content box the padding changes). The pane has no
 * browser scroll anchoring (conversation-window.css), so nothing else moves it.
 */
export function ConversationStrips({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const written = useRef<number | null>(null);
  // Which strips show, by their place among the children (App's reading offer, then its source strip).
  const shows = Children.toArray(children).map((child) => (isValidElement(child) ? String(child.key) : "")).join(" ");
  const measure = () => {
    const element = box.current;
    const body = element?.parentElement;
    if (!element || !body) return;
    const height = element.offsetHeight;
    if (height === written.current) return;
    written.current = height;
    body.style.setProperty("--strips-height", `${height}px`);
  };
  // A strip shown or gone is measured in the commit that shows it.
  useLayoutEffect(measure, [shows]);
  useLayoutEffect(() => {
    const element = box.current;
    const body = element?.parentElement;
    if (!element || !body) return;
    // A strip that wraps anew as the window narrows.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      body.style.removeProperty("--strips-height");
      written.current = null;
    };
  }, []);
  return (
    <div className="conversation-strips" ref={box}>
      {children}
    </div>
  );
}
