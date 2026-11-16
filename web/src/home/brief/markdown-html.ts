import DOMPurify from "dompurify";
import { markdownHtml } from "../../markdown.ts";

/**
 * How Home turns an Agent's Markdown into HTML (BriefMarkdown): read as the
 * conversation reads it (markdownHtml), sanitized the way its Prose is, with no images
 * (an Agent never makes the page load an external one), forms, buttons,
 * frames or styles. Copy report reads blocks the same way.
 */
export function briefMarkdownHtml(text: string): string {
  return DOMPurify.sanitize(markdownHtml(text), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "form", "input", "button", "iframe", "style"],
    FORBID_ATTR: ["style"],
  });
}
