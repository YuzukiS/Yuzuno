import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { sourceTarget } from "../../intelligent-ui/contract.ts";
import { parseMessageLink, useMessageLinks } from "../../deep-link";

/**
 * GitHub-flavoured Markdown written by an Agent, sanitized the way the
 * conversation's Prose is: no images (an Agent never makes the page load an
 * external one), forms, buttons, frames or styles. Fenced code and log
 * excerpts keep their lines and scroll inside a bounded block.
 */
export function BriefMarkdown({ text }: { text: string }) {
  const html = useMemo(
    () => ({
      __html: DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }), {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ["img", "form", "input", "button", "iframe", "style"],
        FORBID_ATTR: ["style"],
      }),
    }),
    [text],
  );
  const links = useMessageLinks();
  return (
    <div
      className="prose brief-markdown"
      dangerouslySetInnerHTML={html}
      onClick={(event) => {
        const link = (event.target as HTMLElement).closest("a");
        if (!link) return;
        // A link to a message opens that conversation (T-166).
        const message = links && parseMessageLink(link.getAttribute("href") || "");
        if (message) {
          event.preventDefault();
          links.open(message);
          return;
        }
        // Web links open outside Home; anything else (a relative or file
        // path) has nowhere to go from here and stays inert.
        const target = sourceTarget(link.getAttribute("href") || "");
        if (target?.kind === "web") {
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          return;
        }
        event.preventDefault();
      }}
    />
  );
}
