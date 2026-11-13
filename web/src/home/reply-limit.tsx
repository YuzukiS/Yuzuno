import { useStrings } from "../i18n";
import { homeText } from "./home-text";

/**
 * The longest reply Home sends, in UTF-8 bytes (YN-91): Core's limit, in the
 * unit Core counts (core/src/project_brief/home.rs MAX_REPLY, which says the
 * same number). A reply goes to its Agent as one message under the limit a
 * conversation's message has, with Core's quote of the card or ask before
 * it. The field itself has no limit, so a paste is never cut short: what is
 * too long says so here and is not sent.
 */
export const HOME_REPLY_MAX_BYTES = 92_000;
/**
 * The longest message a conversation takes, in UTF-8 bytes: Core's limit
 * (core/src/model.rs MAX_MESSAGE_TEXT, which says the same number). A form's
 * answers in a conversation go as one such message (YN-103).
 */
export const MESSAGE_MAX_BYTES = 100_000;
/** From this share of the limit on, a note says how many bytes are left. */
const NEAR = 0.9;

/** `text`'s length in UTF-8, as Rust's `str::len` and `TextEncoder` count it. */
export function utf8Bytes(text: string) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** The reply as it is sent: trimmed, as each reply sends it. */
export const replyBytes = (text: string) => utf8Bytes(text.trim());
export const replyTooLong = (text: string) => replyBytes(text) > HOME_REPLY_MAX_BYTES;

/** What a length note says: how much is left, or how far over and why. */
export type LengthWords = {
  left: (left: number, most: number) => string;
  over: (over: number, most: number) => string;
};

/** How much a long reply can still take, or how far over it is and why it
 * is not sent; nothing while it is far from the limit. Without `bytes`, a
 * reply from Home's `text`; with them, any message counted as Core counts
 * it, against its `max` and in its own `words` (a form's answers, YN-103). */
export function ReplyLength({ text = "", bytes, max = HOME_REPLY_MAX_BYTES, words }: {
  text?: string;
  bytes?: number;
  max?: number;
  words?: LengthWords;
}) {
  const t = useStrings(homeText);
  const used = bytes ?? replyBytes(text);
  if (used < max * NEAR) return null;
  const over = used - max;
  const say = words ?? { left: t.replyBytesLeft, over: t.replyTooLong };
  return (
    <p className={over > 0 ? "inline-error home-reply-length" : "home-note home-reply-length"} role="status" data-over={over > 0 ? "" : undefined}>
      {/* At the limit exactly: 0 left, never -0. */}
      {over > 0 ? say.over(over, max) : say.left(max - used, max)}
    </p>
  );
}
