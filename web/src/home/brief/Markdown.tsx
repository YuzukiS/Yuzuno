import { useMemo } from "react";
import { sourceTarget } from "../../intelligent-ui/contract.ts";
import { parseMessageLink, useMessageLinks } from "../../deep-link";
import { briefMarkdownHtml } from "./markdown-html";

/**
 * GitHub-flavoured Markdown written by an Agent, sanitized as
 * briefMarkdownHtml says. Fenced code and log excerpts keep their lines and
 * scroll inside a bounded block.
 */
export function BriefMarkdown({ text }: { text: string }) {
  const html = useMemo(() => ({ __html: briefMarkdownHtml(text) }), [text]);
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
