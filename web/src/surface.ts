import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const REDUCED = "(prefers-reduced-motion: reduce)";

/** A token such as `--motion-small` ("180ms", or ".18s" once built), in milliseconds. */
function tokenMs(name: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ms = value.endsWith("ms") ? parseFloat(value) : value.endsWith("s") ? parseFloat(value) * 1000 : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Fades `element` in once, opacity only, over the `duration` token, for what
 * is not drawn by React (T-19 CV:CO-09, the slash menu CodeMirror draws).
 * Under reduced motion, or without the Web Animations API, nothing plays.
 */
export function fadeIn(element: HTMLElement, duration: "micro" | "small" | "medium"): Animation | null {
  if (typeof element.animate !== "function" || window.matchMedia?.(REDUCED).matches) return null;
  const ms = tokenMs(`--motion-${duration}`);
  if (!ms) return null;
  const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() || "ease";
  return element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing });
}

/**
 * A surface coming in fades in (T-19 M6): Home as it opens, a conversation as
 * it opens or another Agent's takes its place. Opacity only, from before the
 * first paint, so nothing in it moves: a conversation's rows, where it is read
 * and what reads it keep their places. The surface it replaces is gone at
 * once, as before. A newer `key` starts the fade again on the newest surface;
 * under reduced motion, or without the Web Animations API, nothing plays.
 *
 * Only a newer `key` starts a fade. A fade under way stops at once, the
 * surface fully shown, when `enabled` turns off (a phone) or reduced motion
 * turns on; turning either back does not play it again.
 *
 * `from`, a transform such as "translateX(8px)", also moves the surface in
 * from there (T-19 M8, a phone's push and pop; M7, a side panel shown again);
 * without it, only opacity.
 */
export function useSurfaceIn(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
  duration: "micro" | "small" | "medium",
  enabled = true,
  from = "",
) {
  const fade = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof element.animate !== "function") return;
    if (window.matchMedia?.(REDUCED).matches) return;
    const ms = tokenMs(`--motion-${duration}`);
    if (!ms) return;
    const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() || "ease";
    const frames: Keyframe[] = from
      ? [{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }]
      : [{ opacity: 0 }, { opacity: 1 }];
    const played = element.animate(frames, { duration: ms, easing });
    fade.current = played;
    return () => {
      played.cancel();
      if (fade.current === played) fade.current = null;
    };
    // `ref` is stable; `duration`, `enabled` and `from` only say how the next one plays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useLayoutEffect(() => {
    if (!enabled) fade.current?.cancel();
  }, [enabled]);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED);
    if (!query?.addEventListener) return;
    const change = () => {
      if (query.matches) fade.current?.cancel();
    };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
}

/**
 * What arrives while its view is open fades in, once each (T-19 M9; CV:Q-01, a
 * request card arriving in its conversation). Opacity only, so nothing in it
 * moves under the pointer and it works from its first frame. `arrivals` names
 * what has arrived since the view opened; each fades the first time it is
 * named, found by `find` after the commit. Under reduced motion, or without
 * the Web Animations API, nothing plays; a fade under way stops, fully shown,
 * when `enabled` turns off or reduced motion turns on, and none plays again.
 */
export function useArrivalsIn(
  arrivals: readonly string[],
  find: (key: string) => HTMLElement | null,
  duration: "micro" | "small" | "medium",
  enabled = true,
) {
  const fades = useRef(new Map<string, Animation>());
  const named = useRef(new Set<string>());
  useLayoutEffect(() => {
    for (const key of arrivals) {
      if (named.current.has(key)) continue;
      named.current.add(key);
      const element = find(key);
      if (!enabled || !element || typeof element.animate !== "function") continue;
      if (window.matchMedia?.(REDUCED).matches) continue;
      const ms = tokenMs(`--motion-${duration}`);
      if (!ms) continue;
      const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() || "ease";
      const fade = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing });
      fades.current.set(key, fade);
      const forget = () => {
        if (fades.current.get(key) === fade) fades.current.delete(key);
      };
      fade.finished.then(forget, forget);
    }
    // `find` and `duration` only say how the next one plays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivals.join("\n"), enabled]);
  useLayoutEffect(() => {
    if (enabled) return;
    for (const fade of fades.current.values()) fade.cancel();
    fades.current.clear();
  }, [enabled]);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED);
    if (!query?.addEventListener) return;
    const change = () => {
      if (!query.matches) return;
      for (const fade of fades.current.values()) fade.cancel();
      fades.current.clear();
    };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
}

/**
 * An inline panel the user opened (a confirm, a preview) reveals (T-19 M9):
 * as it mounts, the box it is in opens from nothing to its height and fades
 * in over small, pushing what is below down; it is brought into view first
 * (nearest, at once) if it would not be. `ref` is that box, a `.reveal` with
 * the panel inside: only its height and opacity move, and the panel keeps
 * its own padding and margins, so nothing in it moves as it opens. A newer
 * `key` reveals the panel shown then; a falsy one, or no panel, reveals
 * nothing. What it holds is clipped only while it opens. Under reduced
 * motion, or without the Web Animations API, it is there at once; reduced
 * motion turned on meanwhile shows it whole.
 */
export function useRevealIn(ref: RefObject<HTMLElement | null>, key: unknown) {
  const reveal = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!key || !element) return;
    element.scrollIntoView?.({ block: "nearest" });
    if (typeof element.animate !== "function" || window.matchMedia?.(REDUCED).matches) return;
    const ms = tokenMs("--motion-small");
    if (!ms) return;
    const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() || "ease";
    const open = { height: `${element.getBoundingClientRect().height}px`, opacity: 1 };
    const shut = { height: "0px", opacity: 0 };
    const overflow = element.style.overflow;
    element.style.overflow = "hidden";
    const played = element.animate([shut, open], { duration: ms, easing });
    reveal.current = played;
    const done = () => {
      element.style.overflow = overflow;
      if (reveal.current === played) reveal.current = null;
    };
    played.addEventListener("finish", done);
    played.addEventListener("cancel", done);
    return () => played.cancel();
    // `ref` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED);
    if (!query?.addEventListener) return;
    const change = () => {
      if (query.matches) reveal.current?.cancel();
    };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
}

/** The box that scrolls `element`: the nearest that can, else the page's. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let el = element.parentElement; el; el = el.parentElement) {
    const y = getComputedStyle(el).overflowY;
    if ((y === "auto" || y === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return document.scrollingElement as HTMLElement | null;
}

const ease = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// A Home card changing size as the user acts on it (YN-203). Its tokens
// (styles.css): --motion-card its edge, --motion-card-out what leaves it,
// --motion-card-in what comes into it.
const resizes = new WeakMap<HTMLElement, Animation>();
const targets = new WeakMap<Animation, number>();
/** What a resize holds while it plays (its watch, the scroller's anchoring, the card's mark), let go once. */
const cleanups = new WeakMap<Animation, () => void>();
/** Who waits for a card to have no resize under way (afterResize). */
const waiters = new WeakMap<HTMLElement, (() => void)[]>();
/**
 * One act's resize and what follows it: changes to what the card holds move
 * the edge on only until `deadline` (the first resize's own end), and one
 * glide at most goes on after a resize ends, so endless changes are not
 * chased: from then on the card follows them at once.
 */
const chains = new WeakMap<HTMLElement, { deadline: number; glided: boolean }>();
const fades = new WeakMap<HTMLElement, Animation>();
const ghosts = new WeakMap<HTMLElement, { layer: HTMLElement; fade: Animation | null }>();
/** Each card's fades in under way. */
const cardFades = new WeakMap<HTMLElement, Set<Animation>>();
/** Cards with motion of theirs under way: a resize, a copy fading out, a fade in, a focus to scroll to. */
const moving = new Set<HTMLElement>();
let heard = false;
function track(card: HTMLElement) {
  moving.add(card);
  if (heard || typeof window.matchMedia !== "function") return;
  heard = true;
  // Reduced motion turned on: every card's motion stops where it is, at its end state, as the user asks now.
  window.matchMedia(REDUCED).addEventListener?.("change", () => {
    if (!window.matchMedia(REDUCED).matches) return;
    for (const card of [...moving]) stopCard(card);
  });
}
function idleOf(card: HTMLElement) {
  if (!resizes.has(card) && !ghosts.has(card) && !cardFades.get(card)?.size && !focusing.has(card)) moving.delete(card);
}
/** The focus each card is bringing into view, smoothly, now (showFocusWhenSettled). */
const focusing = new WeakMap<HTMLElement, HTMLElement>();
/** All of `card`'s motion, at its end at once: its resize, a copy fading out, its fades in, a smooth scroll to its focus. */
function stopCard(card: HTMLElement) {
  take(card);
  settle(card);
  ghosts.get(card)?.fade?.cancel();
  for (const fade of [...(cardFades.get(card) ?? [])]) fade.cancel();
  const target = focusing.get(card);
  focusing.delete(card);
  if (target?.isConnected) target.scrollIntoView({ block: "nearest", behavior: "instant" as ScrollBehavior });
  moving.delete(card);
}
const held = new WeakMap<HTMLElement, { count: number; was: string }>();

/** Where a box was before a change: its height and its top, as drawn. */
export type Drawn = { height: number; top: number };

/** The resize under way on `element`, stopped and let go of now, if any (its cancel event comes later). */
function take(element: HTMLElement): Animation | null {
  const running = resizes.get(element) ?? null;
  if (!running) return null;
  resizes.delete(element);
  cleanups.get(running)?.();
  running.cancel();
  return running;
}
/** No resize under way on `element` any more: whoever waits for that goes on. */
function settle(element: HTMLElement) {
  if (resizes.has(element)) return;
  const waiting = waiters.get(element);
  if (!waiting) return;
  waiters.delete(element);
  for (const go of waiting) go();
}

/**
 * The user acted on a card and its size changed: its edge moves from where
 * it was drawn, `from`, to its own height, over --motion-card on the
 * standard curve, in either direction. A change while one plays starts from
 * where that one had it, so a second press turns it around without a jump.
 * Meanwhile what the card holds is clipped to its edge (overflow: clip, so
 * focus never scrolls it) and its scroller does not anchor.
 *
 * Shrinking with its top above its scroller's, its lower edge stays where it
 * was until its top is in view: the scroller moves up by as much, at once,
 * and the card's top margin takes that back over the same time, so the
 * reply is where it was sent from and nothing below moves. Under reduced
 * motion, or without the Web Animations API, it is at its height at once,
 * moved into view the same way. Call it with the new layout in place,
 * before it is painted.
 */
export function resizeFrom(element: HTMLElement, from: Drawn): Animation | null {
  chains.set(element, { deadline: performance.now() + tokenMs("--motion-card"), glided: false });
  return resize(element, from);
}

function resize(element: HTMLElement, from: Drawn): Animation | null {
  const running = take(element);
  const to = element.getBoundingClientRect().height;
  const scroller = scrollerOf(element);
  let shifted = false;
  if (scroller && from.height > to + 1) {
    const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    const margin = parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
    const shift = Math.min(from.height - to, Math.max(0, top + margin - from.top), scroller.scrollTop);
    if (shift > 0) {
      hold(scroller);
      scroller.scrollTop -= shift;
      shifted = true;
    }
  }
  // Its top as drawn: where a resize under way, or the shift above, had it; else where it is.
  const offset = running || shifted ? from.top - element.getBoundingClientRect().top : 0;
  if ((!(Math.abs(from.height - to) > 1) && !(Math.abs(offset) > 1)) || !motion(element)) {
    if (shifted && scroller) letGo(scroller);
    settle(element);
    return null;
  }
  if (scroller && !shifted) hold(scroller);
  return play(element, from.height, to, offset, scroller);
}

function motion(element: HTMLElement) {
  return typeof element.animate === "function" && !window.matchMedia?.(REDUCED).matches && tokenMs("--motion-card") > 0;
}

function hold(scroller: HTMLElement) {
  const now = held.get(scroller);
  if (now) now.count += 1;
  else {
    held.set(scroller, { count: 1, was: scroller.style.overflowAnchor });
    scroller.style.overflowAnchor = "none";
  }
}
function letGo(scroller: HTMLElement) {
  const now = held.get(scroller);
  if (!now) return;
  now.count -= 1;
  if (now.count > 0) return;
  held.delete(scroller);
  scroller.style.overflowAnchor = now.was;
}

/** The height `element` would have without `played`, read without stopping it. */
function heightWithout(element: HTMLElement, played: Animation): number | null {
  const effect = played.effect;
  if (!(effect instanceof KeyframeEffect)) return null;
  effect.target = null;
  const height = element.getBoundingClientRect().height;
  effect.target = element;
  return height;
}

function play(element: HTMLElement, from: number, to: number, offset: number, scroller: HTMLElement | null) {
  const base = parseFloat(getComputedStyle(element).marginTop) || 0;
  const frames: Keyframe[] = Math.abs(offset) > 1
    ? [{ height: `${from}px`, marginTop: `${base + offset}px` }, { height: `${to}px`, marginTop: `${base}px` }]
    : [{ height: `${from}px` }, { height: `${to}px` }];
  element.dataset.resizing = "";
  track(element);
  const played = element.animate(frames, { duration: tokenMs("--motion-card"), easing: ease("--ease-standard", "ease") });
  resizes.set(element, played);
  targets.set(played, to);
  // What the card holds changed by React meanwhile (a form drawn a moment
  // later): the edge moves on to the new height from where it is, read
  // before the frame is painted; only within the act's own time.
  const watch = typeof MutationObserver === "function"
    ? new MutationObserver(() => {
        if (resizes.get(element) !== played) return;
        if (performance.now() > (chains.get(element)?.deadline ?? 0)) return;
        const natural = heightWithout(element, played);
        if (natural === null || Math.abs(natural - to) <= 1) return;
        const now = element.getBoundingClientRect();
        resize(element, { height: now.height, top: now.top });
      })
    : null;
  watch?.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
  let ended = false;
  cleanups.set(played, () => {
    if (ended) return;
    ended = true;
    watch?.disconnect();
    if (scroller) letGo(scroller);
    delete element.dataset.resizing;
  });
  played.addEventListener("finish", () => {
    if (resizes.get(element) !== played) return;
    resizes.delete(element);
    cleanups.get(played)?.();
    // A size changed with nothing React did (an image or a font loaded, the
    // window resized): one glide on from the height drawn last, then no more.
    const chain = chains.get(element);
    const box = element.getBoundingClientRect();
    if (chain && !chain.glided && Math.abs(box.height - to) > 1 && motion(element)) {
      chain.glided = true;
      resize(element, { height: to, top: box.top });
    }
    settle(element);
    idleOf(element);
  });
  played.addEventListener("cancel", () => cleanups.get(played)?.());
  return played;
}

/** Each card an act of the user's is under way in (watchAct): until when, and the card as last drawn. */
const acts = new WeakMap<HTMLElement, { until: number; drawn: Drawn }>();
/**
 * The user pressed something in `card` (a click, Enter): for --motion-card
 * from now, the act's own time as a resize's changes are followed in, a
 * change React makes in the card that moves its edge without one of
 * CardResize's (an option's reply being sent, a note it shows) glides there
 * from where the card was last drawn instead of jumping. A change that is
 * one of CardResize's resizes it as before, with its copy and fades; a
 * resize under way follows its own changes. Nothing under reduced motion.
 */
export function watchAct(card: HTMLElement) {
  if (!motion(card) || typeof MutationObserver !== "function") return;
  const until = performance.now() + tokenMs("--motion-card");
  const now = acts.get(card);
  if (now) {
    now.until = until;
    return;
  }
  const box = card.getBoundingClientRect();
  const act = { until, drawn: { height: box.height, top: box.top } };
  acts.set(card, act);
  let frame = 0;
  const stop = () => {
    watch.disconnect();
    cancelAnimationFrame(frame);
    if (acts.get(card) === act) acts.delete(card);
  };
  // Read after CardResize's own (queued as React commits): one of its changes is its.
  const watch = new MutationObserver(() => queueMicrotask(() => {
    if (acts.get(card) !== act || resizes.has(card) || performance.now() > act.until) return;
    if (Math.abs(card.getBoundingClientRect().height - act.drawn.height) <= 1) return;
    chains.set(card, { deadline: act.until, glided: false });
    resize(card, act.drawn);
  }));
  watch.observe(card, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "disabled"] });
  // As drawn each frame, until the act's time is over.
  const tick = () => {
    if (performance.now() > act.until || !card.isConnected) return stop();
    if (!resizes.has(card)) {
      const r = card.getBoundingClientRect();
      act.drawn = { height: r.height, top: r.top };
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

/** Once `element` has no resize under way: after the last of a chain moved on by later changes, or none. */
export function afterResize(element: HTMLElement): Promise<void> {
  if (!resizes.has(element)) return Promise.resolve();
  return new Promise((go) => {
    const waiting = waiters.get(element) ?? [];
    waiting.push(go);
    waiters.set(element, waiting);
  });
}

/** The height `element` is going to: a resize's under way, else the one it has. */
export function resizeTarget(element: HTMLElement): number {
  const running = resizes.get(element);
  return (running && targets.get(running)) ?? element.getBoundingClientRect().height;
}

/**
 * Focus that went into `within` as `card` opened (Reply again) is brought
 * into view once the card has its height, if it is not in view: by the
 * nearest way, smoothly unless reduced motion is asked for then.
 */
export function showFocusWhenSettled(card: HTMLElement, within: HTMLElement) {
  track(card);
  void afterResize(card).then(() => requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!card.isConnected || !(active instanceof HTMLElement) || !within.contains(active)) return idleOf(card);
    const reduced = !!window.matchMedia?.(REDUCED).matches;
    if (reduced) {
      active.scrollIntoView({ block: "nearest", behavior: "instant" as ScrollBehavior });
      return idleOf(card);
    }
    // Followed while it scrolls, so reduced motion turned on meanwhile puts it at its end (stopCard).
    focusing.set(card, active);
    track(card);
    const scroller = scrollerOf(card);
    active.scrollIntoView({ block: "nearest", behavior: "smooth" });
    let last = NaN, still = 0;
    const watch = () => {
      if (focusing.get(card) !== active) return;
      const now = scroller ? scroller.scrollTop : 0;
      still = now === last ? still + 1 : 0;
      last = now;
      if (still < 2) return void requestAnimationFrame(watch);
      focusing.delete(card);
      idleOf(card);
    };
    requestAnimationFrame(watch);
  }));
}

/** A card as it is drawn now, to fade out over what it becomes (dissolveFrom). */
export type Snapshot = { layer: HTMLElement; width: number; height: number; scrolls: [HTMLElement, number, number][] };

/**
 * A copy of `card` as drawn now, taken before React changes it, so what
 * changes can fade from it to what replaces it (YN-203: the user's "渐隐渐
 * 现"). What a copy would lose is carried over: what is typed in its fields,
 * its canvases' pictures, how far its inner boxes are scrolled, a copy
 * fading out in it (at the opacity it has now). Frames and media are only
 * their boxes, never loaded again. Its ids are its own (renameIds), so it
 * shares none with the card and its pictures' references still find what
 * they point at; it has no section key and takes no input. None under
 * reduced motion.
 */
export function snapshotOf(card: HTMLElement): Snapshot | null {
  if (!motion(card)) return null;
  const box = card.getBoundingClientRect();
  const layer = card.cloneNode(true) as HTMLElement;
  const live = [card, ...card.querySelectorAll<HTMLElement>("*")];
  const copy = [layer, ...layer.querySelectorAll<HTMLElement>("*")];
  const scrolls: [HTMLElement, number, number][] = [];
  const boxes: [HTMLElement, DOMRect][] = [];
  const fading = new Set<Element>([...(cardFades.get(card) ?? [])].map((a) => (a.effect as KeyframeEffect | null)?.target).filter((t): t is Element => !!t));
  for (let i = 0; i < live.length && i < copy.length; i++) {
    const a = live[i], b = copy[i];
    if (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement || a instanceof HTMLSelectElement) {
      (b as HTMLInputElement).value = a.value;
      if (a instanceof HTMLInputElement) (b as HTMLInputElement).checked = a.checked;
    } else if (a instanceof HTMLCanvasElement) {
      try { (b as HTMLCanvasElement).getContext("2d")?.drawImage(a, 0, 0); } catch { /* a canvas it may not read */ }
    } else if (a instanceof HTMLIFrameElement || a instanceof HTMLMediaElement || a instanceof HTMLObjectElement || a instanceof HTMLEmbedElement) {
      boxes.push([b, a.getBoundingClientRect()]);
    } else if (ghosts.get(card)?.layer === a || fading.has(a)) {
      // A copy fading out, or a part fading in: as it looks now.
      b.style.opacity = getComputedStyle(a).opacity;
    }
    if (a.scrollTop || a.scrollLeft) scrolls.push([b, a.scrollTop, a.scrollLeft]);
  }
  for (const [b, rect] of boxes) {
    const stand = document.createElement("div");
    stand.style.cssText = `width:${rect.width}px;height:${rect.height}px`;
    b.replaceWith(stand);
  }
  // A copy fading out in it is kept as it looks; any copy that copy holds goes: one level, however fast the presses.
  for (const nested of layer.querySelectorAll(".card-ghost .card-ghost")) nested.remove();
  for (const name of ["data-section-key", "data-section-version", "data-card-size", "data-resizing", "data-ghosting", "tabindex", "aria-labelledby"])
    layer.removeAttribute(name);
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  layer.classList.add("card-ghost");
  renameIds(layer);
  return { layer, width: box.width, height: box.height, scrolls };
}

let copies = 0;
/** The attributes that name other elements by id, separated by spaces. */
const ID_LISTS = ["for", "list", "form", "headers", "aria-activedescendant", "aria-controls", "aria-describedby", "aria-details", "aria-errormessage", "aria-flowto", "aria-labelledby", "aria-owns"];
/**
 * Every id in a card's copy made its own (a suffix for this copy), and what
 * in the copy points at one of them pointed at the new one: an SVG's
 * href="#…" and url(#…) (markers, gradients, clip paths, filters, also in a
 * style), and the id lists of labels and ARIA. So the page never has an id
 * twice and the copy's pictures draw as the card's did. A reference to an id
 * outside the copy is left as it is.
 */
function renameIds(layer: HTMLElement) {
  const named = layer.id ? [layer, ...layer.querySelectorAll("[id]")] : [...layer.querySelectorAll("[id]")];
  if (!named.length) return;
  const suffix = `--card-copy-${++copies}`;
  const renamed = new Map<string, string>();
  for (const element of named) {
    renamed.set(element.id, element.id + suffix);
    element.id += suffix;
  }
  const to = (id: string) => renamed.get(id) ?? id;
  for (const element of [layer, ...layer.querySelectorAll("*")])
    for (const attr of [...element.attributes]) {
      let value = attr.value;
      if (attr.localName === "href") {
        if (value.startsWith("#")) value = `#${to(value.slice(1))}`;
      } else if (ID_LISTS.includes(attr.name)) {
        value = value.split(/\s+/).map(to).join(" ");
      } else if (value.includes("url(")) {
        value = value.replace(/url\(\s*(['"]?)#([^'")]+?)\1\s*\)/g, (all, quote: string, id: string) =>
          renamed.has(id) ? `url(${quote}#${to(id)}${quote})` : all);
      }
      if (value !== attr.value) attr.value = value;
    }
}

/**
 * What `card` was, `snap`, fades out over what it is now, over
 * --motion-card-out on the exit curve: where nothing changed the two are
 * the same and nothing is seen to move; where something changed, the new
 * is kept unseen meanwhile (fadeInFrom), so the old fades out to nothing
 * and only then the new fades in. It takes no input and is gone once
 * faded. A copy already fading in the card is in `snap` as it looked, and
 * goes now.
 */
export function dissolveFrom(card: HTMLElement, snap: Snapshot | null) {
  if (!snap || typeof card.animate !== "function" || window.matchMedia?.(REDUCED).matches) return;
  const was = ghosts.get(card);
  if (was) {
    was.fade?.cancel();
    was.layer.remove();
  }
  const style = getComputedStyle(card);
  const layer = snap.layer;
  Object.assign(layer.style, {
    position: "absolute", top: `${-(parseFloat(style.borderTopWidth) || 0)}px`, left: `${-(parseFloat(style.borderLeftWidth) || 0)}px`,
    width: `${snap.width}px`, height: `${snap.height}px`, minHeight: "0", maxHeight: "none", margin: "0",
    pointerEvents: "none", zIndex: "1", transform: "none",
  });
  card.dataset.ghosting = "";
  card.append(layer);
  track(card);
  // Each copied box scrolled as its original was (one replaced by a stand-in box is no longer in the copy).
  for (const [element, top, left] of snap.scrolls)
    if (layer.contains(element)) element.scrollTo({ top, left, behavior: "instant" as ScrollBehavior });
  const fade = layer.animate([{ opacity: layer.style.opacity || 1 }, { opacity: 0 }], {
    duration: tokenMs("--motion-card-out"), easing: ease("--ease-exit", "ease-in"), fill: "forwards",
  });
  ghosts.set(card, { layer, fade });
  const done = () => {
    layer.remove();
    if (ghosts.get(card)?.layer !== layer) return;
    ghosts.delete(card);
    delete card.dataset.ghosting;
    idleOf(card);
  };
  fade.addEventListener("finish", done);
  fade.addEventListener("cancel", done);
}

/** An element a fade in keeps unseen while the old fades out: which fade hides it, and the pointer it had before. */
const unseen = new WeakMap<HTMLElement, { by: Animation; was: string }>();
/** `element` takes the pointer again, as it had it before a fade hid it. */
function reveal(element: HTMLElement) {
  const hidden = unseen.get(element);
  if (!hidden) return;
  unseen.delete(element);
  element.style.pointerEvents = hidden.was;
}

/**
 * What changed in a card, or came into it, fades in over --motion-card-in
 * once what it replaces has faded out (YN-203, the user's round 3: "渐隐到
 * 消失之后再开始渐显"): from nothing, unseen for --motion-card-out first,
 * while the card's copy (dissolveFrom) fades out over it. Changed again
 * meanwhile, it starts over the same way, and the copy taken then shows it
 * as it looked, so old and new are not drawn together. Opacity only. While
 * it is unseen it takes no pointer, so nothing is pressed that cannot be
 * seen; focus in it stays where it is. Under reduced motion nothing plays.
 */
export function fadeInFrom(element: HTMLElement): Animation | null {
  fades.get(element)?.cancel();
  // A fade it replaces gives the pointer back now; its own cancel, later, finds it no longer its own.
  reveal(element);
  if (typeof element.animate !== "function" || window.matchMedia?.(REDUCED).matches) return null;
  const ms = tokenMs("--motion-card-in");
  if (!ms) return null;
  const delay = tokenMs("--motion-card-out");
  const played = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, delay, easing: ease("--ease-standard", "ease"), fill: "backwards" });
  fades.set(element, played);
  if (delay > 0) {
    unseen.set(element, { by: played, was: element.style.pointerEvents });
    element.style.pointerEvents = "none";
    const give = () => {
      if (unseen.get(element)?.by === played) reveal(element);
    };
    const watch = () => {
      if (played.playState !== "running" || (Number(played.currentTime) || 0) >= delay) return give();
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    played.addEventListener("cancel", give);
    played.addEventListener("finish", give);
  }
  const card = element.parentElement?.closest<HTMLElement>("[data-section-key]") ?? null;
  if (card) {
    track(card);
    const set = cardFades.get(card) ?? new Set<Animation>();
    set.add(played);
    cardFades.set(card, set);
  }
  const done = () => {
    if (fades.get(element) === played) fades.delete(element);
    if (card) {
      cardFades.get(card)?.delete(played);
      idleOf(card);
    }
  };
  played.addEventListener("finish", done);
  played.addEventListener("cancel", done);
  return played;
}

/**
 * A banner that a brief flap should not flash (T-19 M15: SH:M04, SH:M06): `shown` once `want` has held
 * for `delay` ms. Once shown and no longer wanted, it is `leaving` for exit-small (the banner's own CSS
 * plays its exit meanwhile), then gone; under reduced motion it goes at once. Wanted again while
 * leaving, it stays.
 */
export function useDelayedPresence(want: boolean, delay: number): { shown: boolean; leaving: boolean } {
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (want) {
      setLeaving(false);
      if (shown) return;
      const timer = setTimeout(() => setShown(true), delay);
      return () => clearTimeout(timer);
    }
    if (!shown) return;
    const ms = window.matchMedia?.(REDUCED).matches ? 0 : tokenMs("--motion-exit-small");
    if (!ms) {
      setShown(false);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = setTimeout(() => {
      setShown(false);
      setLeaving(false);
    }, ms);
    return () => clearTimeout(timer);
  }, [want, shown, delay]);
  return { shown, leaving };
}
