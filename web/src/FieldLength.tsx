import { ReplyLength, type LengthWords } from "./home/reply-limit";
import { measured, type CoreLimit } from "./core-limits";
import { strings, useStrings } from "./i18n";
import "./long-text-field.css";

const n = (value: number) => value.toLocaleString("en-US");
const text = strings({
  bytesLeft: (left: number, most: number) =>
    `${n(left)} ${left === 1 ? "byte" : "bytes"} left of ${n(most)} (UTF-8: a Chinese character is 3).`,
  bytesOver: (over: number, most: number) =>
    `${n(over)} ${over === 1 ? "byte" : "bytes"} too long: this field takes at most ${n(most)} bytes in UTF-8, where a Chinese character is 3. Nothing is sent until it is shorter; what you wrote is kept.`,
  charsLeft: (left: number, most: number) =>
    `${n(left)} ${left === 1 ? "character" : "characters"} left of ${n(most)}.`,
  charsOver: (over: number, most: number) =>
    `${n(over)} ${over === 1 ? "character" : "characters"} too long: this field takes at most ${n(most)} characters. Nothing is sent until it is shorter; what you wrote is kept.`,
}, {
  bytesLeft: (left, most) => `还能输入 ${n(left)} 字节，上限 ${n(most)} 字节（UTF-8，一个汉字 3 字节）。`,
  bytesOver: (over, most) =>
    `超出 ${n(over)} 字节：这一栏最多 ${n(most)} 字节（UTF-8，一个汉字 3 字节）。删减之前不会提交，已写的内容不会丢。`,
  charsLeft: (left, most) => `还能输入 ${n(left)} 个字，上限 ${n(most)} 个字。`,
  charsOver: (over, most) => `超出 ${n(over)} 个字：这一栏最多 ${n(most)} 个字。删减之前不会提交，已写的内容不会丢。`,
});

/** What a length note says for `limit`, in its unit and the page's language. */
export function useLengthWords(limit: CoreLimit): LengthWords {
  const t = useStrings(text);
  return limit.unit === "chars" ? { left: t.charsLeft, over: t.charsOver } : { left: t.bytesLeft, over: t.bytesOver };
}

/**
 * A one-line field's length as Core counts it (YN-106): nothing while it
 * fits; over Core's limit, by how much. The field keeps no limit of its own,
 * so a paste is never cut short, and its form refuses what is over
 * (core-limits.ts overLimit), as a name Core would refuse.
 */
export function FieldLength({ value, limit }: { value: string; limit: CoreLimit }) {
  const words = useLengthWords(limit);
  const used = measured(value, limit);
  if (used <= limit.max) return null;
  return (
    <div className="long-text-note">
      <ReplyLength bytes={used} max={limit.max} words={words} />
    </div>
  );
}
