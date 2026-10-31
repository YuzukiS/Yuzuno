import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * How Home turns an Agent's Markdown into HTML (BriefMarkdown): GitHub-
 * flavoured, sanitized the way the conversation's Prose is, with no images
 * (an Agent never makes the page load an external one), forms, buttons,
 * frames or styles. Copy report reads blocks the same way.
 */
export function briefMarkdownHtml(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "form", "input", "button", "iframe", "style"],
    FORBID_ATTR: ["style"],
  });
}
