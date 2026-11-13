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
/** From this many bytes on, the reply says how many are left. */
const NEAR = HOME_REPLY_MAX_BYTES * 0.9;

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

/** How much a long reply can still take, or how far over it is and why it
 * is not sent; nothing while it is far from the limit. */
export function ReplyLength({ text }: { text: string }) {
  const t = useStrings(homeText);
  const bytes = replyBytes(text);
  if (bytes < NEAR) return null;
  const over = bytes - HOME_REPLY_MAX_BYTES;
  return (
    <p className={over > 0 ? "inline-error home-reply-length" : "home-note home-reply-length"} role="status" data-over={over > 0 ? "" : undefined}>
      {over > 0 ? t.replyTooLong(over, HOME_REPLY_MAX_BYTES) : t.replyBytesLeft(-over, HOME_REPLY_MAX_BYTES)}
    </p>
  );
}
