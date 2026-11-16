import { Marked } from "marked";
import markedCjkFriendly from "marked-cjk-friendly";

// `*` and `**` follow the CommonMark CJK-friendly amendments
// (https://github.com/tats-u/markdown-cjk-friendly/blob/main/specification.md),
// through the extension their author wrote for marked: next to a Chinese,
// Japanese or Korean character a run may open or close where CommonMark's
// flanking rule refuses it, so `**粗体。**汉字` is bold. Text without such
// characters reads exactly as before. A `_` run is handed back to marked
// (false): the amendments read `_` as CommonMark does in practice, while the
// extension's own `_` rule is looser. Its `~~` tokenizer is not used at all,
// as it changes text without CJK characters too (YN-172).
const cjkEmphasis = markedCjkFriendly().tokenizer!.emStrong!;

/**
 * How the conversation (Prose) and Home (briefMarkdownHtml) read Markdown:
 * GitHub-flavoured, on an instance of its own, so nothing here changes how
 * the global `marked` reads for anyone else. Sanitizing is each caller's.
 */
const markdown = new Marked({ gfm: true }).use({
  tokenizer: {
    emStrong(src, maskedSrc, prevChar) {
      return src[0] === "*" ? cjkEmphasis.call(this, src, maskedSrc, prevChar) : false;
    },
  },
});

/** Markdown as HTML, not yet sanitized. */
export function markdownHtml(text: string): string {
  return markdown.parse(text, { async: false });
}
