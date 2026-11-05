import { useLayoutEffect, useRef, type ReactNode } from "react";
import "./conversation-strips.css";

/**
 * The strips over the conversation's top: another browser's place offered,
 * and the source being read with its way back (T-19 SH:C08, CV:CW-11). They
 * float over the conversation instead of standing above it, so one that
 * appears while someone reads moves no text; each fades in over small
 * (conversation-strips.css). Their height is the conversation's
 * `--strips-height`, which keeps the request pin below them and, as scroll
 * padding, a target a jump places at the top clear of them. It is set as
 * they render, before the jump that opened a source places its target, and
 * again whenever they change size.
 */
export function ConversationStrips({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const measure = () => {
    const element = box.current;
    element?.parentElement?.style.setProperty("--strips-height", `${element.offsetHeight}px`);
  };
  // Each render: a strip shown or gone is measured in the commit that shows it.
  useLayoutEffect(measure);
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
    };
  }, []);
  return (
    <div className="conversation-strips" ref={box}>
      {children}
    </div>
  );
}
