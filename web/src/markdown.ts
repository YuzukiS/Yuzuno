import { Marked } from "marked";

/**
 * How the conversation (Prose) and Home (briefMarkdownHtml) read Markdown:
 * GitHub-flavoured, on an instance of its own, so nothing here changes how
 * the global `marked` reads for anyone else. Sanitizing is each caller's.
 */
const markdown = new Marked({ gfm: true });

/** Markdown as HTML, not yet sanitized. */
export function markdownHtml(text: string): string {
  return markdown.parse(text, { async: false });
}
