import DOMPurify from "dompurify";
import { markdownHtml } from "./markdown.ts";

/** What a conversation's Markdown may keep once it is HTML (Prose). */
const PROSE_PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["img", "form", "input", "button", "iframe", "style"],
  FORBID_ATTR: ["style"],
  // DOMPurify's default URI policy plus file:// and basename.ext:line.
  // Otherwise a bare filename with a line is mistaken for a URI scheme.
  ALLOWED_URI_REGEXP:
    /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|file:\/\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$)|[a-z][\w.\-]*\.[\w.\-]+:-?\d+(?::\d+)?$)/i,
};

/** Markdown's HTML (from `markdownHtml`, or a part of it) as Prose shows it. */
export function sanitizeProse(html: string): string {
  return DOMPurify.sanitize(html, PROSE_PURIFY);
}

/** Markdown as the HTML Prose shows. */
export function proseHtml(text: string): string {
  return sanitizeProse(markdownHtml(text));
}
