// The app's one tooltip (web/src/Tip.tsx, YN-44) in a JSDOM window: open a
// trigger's tip as a keyboard user does (a key, then focus, which opens it
// at once), read its card line by line, and close it again.

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** The tip showing now, or null. */
export const shownTip = (w) => w.document.querySelector('.tip[role="tooltip"]');

/**
 * Focuses `focusable` after a key (Tip opens on a focus the keyboard
 * moved, not one a press did) and returns the card it opens. A tip on a
 * container (an Agent row) opens when focus enters it.
 */
export async function openTip(w, focusable, { seconds = 3 } = {}) {
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  focusable.focus();
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const tip = shownTip(w);
    if (tip) return tip;
    await pause(20);
  }
  throw new Error("no tip opened on focus");
}

/** Moves focus away and waits until no tip shows. */
export async function closeTip(w, focusable, { seconds = 3 } = {}) {
  focusable.blur();
  const deadline = Date.now() + seconds * 1000;
  while (shownTip(w)) {
    if (Date.now() > deadline) throw new Error("the tip did not close on blur");
    await pause(20);
  }
}

/**
 * A card's lines as a reader sees them, top to bottom: each child of the
 * card a line, each of a group's children (`.agent-card-facts`) a line; the
 * words inside a line joined by single spaces.
 */
export function tipLines(tip) {
  const lines = [];
  for (const child of tip.children) {
    const parts = child.classList.contains("agent-card-facts") ? [...child.children] : [child];
    for (const part of parts) {
      const text = part.textContent.replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
    }
  }
  return lines;
}

/** Opens `focusable`'s tip, returns its lines, and closes it. */
export async function readTip(w, focusable) {
  const lines = tipLines(await openTip(w, focusable));
  await closeTip(w, focusable);
  return lines;
}

/**
 * Rests a mouse on `target` (a trigger the keyboard cannot focus, such as a
 * chip) until its tip shows, returns the tip's lines, and moves the mouse
 * off it again.
 */
export async function hoverTip(w, target, { seconds = 3 } = {}) {
  target.dispatchEvent(new w.PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
  const deadline = Date.now() + seconds * 1000;
  let tip = shownTip(w);
  while (!tip) {
    if (Date.now() > deadline) throw new Error("no tip opened on a resting pointer");
    await pause(20);
    tip = shownTip(w);
  }
  const lines = tipLines(tip);
  target.dispatchEvent(new w.PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: w.document.body }));
  while (shownTip(w)) {
    if (Date.now() > deadline + 3000) throw new Error("the tip did not close on leaving");
    await pause(20);
  }
  return lines;
}

/** `hoverTip` in the element's own window: a test that holds only the element. */
export const tipOf = (target, options) => hoverTip(target.ownerDocument.defaultView, target, options);

/** Rests a pointer on `target` past the delay and leaves again: true when no tip opened. */
export async function noTipOf(target) {
  const w = target.ownerDocument.defaultView;
  target.dispatchEvent(new w.PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
  await pause(600);
  const none = !shownTip(w);
  target.dispatchEvent(new w.PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: w.document.body }));
  await pause(450);
  return none;
}
