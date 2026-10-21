/** A phone or tablet used by touch: its on-screen keyboard has no Shift for
 * Return, so there Return makes a new line and the Send button sends (T-170).
 * A tablet with a trackpad or mouse matches neither and keeps Return to send. */
const TOUCH = "(hover: none) and (pointer: coarse)";

export function touchKeyboard() {
  return typeof window.matchMedia === "function" && window.matchMedia(TOUCH).matches;
}
