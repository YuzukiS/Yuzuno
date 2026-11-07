// YN-16 S6: what passes between a single-file HTML page in its sandboxed
// frame and Home, apart from React (home/frame-bridge.ts connects a frame).
// Pure, so the contract's guide and the Node tests read the same limits.

/**
 * The bridge between a single-file HTML page in its sandboxed frame (scripts
 * only: no same-origin, so its origin is opaque, "null") and the window around
 * it (YN-16 S6, design G4). Three messages, nothing else:
 *
 * - out, `yuzuno:theme` {vars, scheme}: the colours and font around the page,
 *   when the frame has loaded and whenever the theme or palette changes. The
 *   page may use them or not; they are the theme everyone sees, nothing private.
 * - in, `yuzuno:height` {px}: the card's frame takes that height, kept within
 *   120–1600 px and changed at most once per animation frame.
 * - in, `yuzuno:send` {text}: one message, at most 2000 characters, offered to
 *   the user under the frame. Nothing is sent until the user presses Send; then
 *   it goes to the section's author as the user's own reply from Home.
 *
 * Only messages from that frame's own window with an opaque origin are read.
 * The page's bytes and its Content Security Policy are unchanged: messages
 * between windows are not requests.
 */
export const THEME_VARS = ["--paper", "--ink", "--line", "--accent-ink", "--green"] as const;
export const FRAME_HEIGHT = { min: 120, max: 1600 } as const;
/** A page's message is at most this many characters (code points). */
export const SEND_CHARS = 2000;

export type ThemeMessage = { type: "yuzuno:theme"; vars: Record<string, string>; scheme: "light" | "dark" };

/** The theme as the window around the page shows it now. */
export function themeMessage(root: HTMLElement = document.documentElement): ThemeMessage {
  const style = getComputedStyle(root);
  const vars: Record<string, string> = {};
  for (const name of THEME_VARS) vars[name] = style.getPropertyValue(name).trim();
  vars["--font"] = style.fontFamily.trim();
  return { type: "yuzuno:theme", vars, scheme: root.dataset.theme === "dark" ? "dark" : "light" };
}

export type FrameMessage = { kind: "send"; text: string } | { kind: "height"; px: number };

/** One message a page sent, as the bridge takes it, or null for anything else. */
export function readFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { type } = data as { type?: unknown };
  if (type === "yuzuno:height") {
    const { px } = data as { px?: unknown };
    if (typeof px !== "number" || !Number.isFinite(px)) return null;
    return { kind: "height", px: Math.round(Math.min(FRAME_HEIGHT.max, Math.max(FRAME_HEIGHT.min, px))) };
  }
  if (type === "yuzuno:send") {
    const { text } = data as { text?: unknown };
    if (typeof text !== "string") return null;
    const kept = text.trim();
    // Longer is not cut: a cut message says something the page did not.
    if (!kept || [...kept].length > SEND_CHARS) return null;
    return { kind: "send", text: kept };
  }
  return null;
}
