import { useContext, useMemo, useState, type MouseEvent } from "react";
import { sourceTarget } from "../../intelligent-ui/contract.ts";
import { parseMessageLink, parseReportLink, useMessageLinks } from "../../deep-link";
import { useStrings } from "../../i18n";
import { BriefContext } from "./BriefContext";
import { briefText } from "./brief-text";
import { briefMarkdownHtml } from "./markdown-html";
import "./markdown-fold.css";

/**
 * Characters (Unicode code points, as the guide counts them) above which a
 * report's or status's Markdown block shows folded after its opening
 * (YN-195): the length brief_update's advice starts at
 * (BRIEF_LIMITS.advice.markdownChars, T-176), so what Core advises against
 * is what Home folds. A test keeps the two the same; the renderer does not
 * carry the contract itself.
 */
export const FOLD_CHARS = 1200;

const chars = (text: string) => [...text].length;

/**
 * Where a long block folds (YN-195): its opening, the headings it starts
 * with and the first other block after them, shown; the rest behind "Show
 * all". Read from the sanitized HTML, never from the Markdown, so a list, a
 * fence or a table is never cut open. Null when there is no rest to fold.
 */
export function foldHtml(html: string): { lead: string; rest: string; hidden: number } | null {
  const template = document.createElement("template");
  template.innerHTML = html;
  const nodes = [...template.content.childNodes].filter((node) => node.nodeType === Node.ELEMENT_NODE || node.textContent?.trim());
  let at = 0;
  while (at < nodes.length && /^H[1-6]$/.test((nodes[at] as Element).tagName ?? "")) at += 1;
  at += 1;
  if (at >= nodes.length) return null;
  const serialize = (part: Node[]) => {
    const box = document.createElement("div");
    for (const node of part) box.appendChild(node.cloneNode(true));
    return box.innerHTML;
  };
  const rest = nodes.slice(at);
  return { lead: serialize(nodes.slice(0, at)), rest: serialize(rest), hidden: chars(rest.map((node) => node.textContent ?? "").join("").replace(/\s+/g, " ").trim()) };
}

/**
 * GitHub-flavoured Markdown written by an Agent, sanitized as
 * briefMarkdownHtml says. Fenced code and log excerpts keep their lines and
 * scroll inside a bounded block. A report's or status's block longer than
 * FOLD_CHARS shows its opening and folds the rest (YN-195); an Ask's never
 * folds, as Core advises only reports and statuses.
 */
export function BriefMarkdown({ text }: { text: string }) {
  const t = useStrings(briefText);
  const kind = useContext(BriefContext)?.section.kind;
  const html = useMemo(() => briefMarkdownHtml(text), [text]);
  const fold = useMemo(() => (kind !== "ask" && chars(text) > FOLD_CHARS ? foldHtml(html) : null), [kind, text, html]);
  const [open, setOpen] = useState(false);
  const links = useMessageLinks();
  const follow = (event: MouseEvent<HTMLElement>) => {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    // A link to a message opens that conversation (T-166).
    const message = links && parseMessageLink(link.getAttribute("href") || "");
    if (message) {
      event.preventDefault();
      links.open(message);
      return;
    }
    // A link to a report opens it over Home (T-18).
    const report = links && parseReportLink(link.getAttribute("href") || "");
    if (report) {
      event.preventDefault();
      links.openReport(report);
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
  };
  if (!fold) return <div className="prose brief-markdown" dangerouslySetInnerHTML={{ __html: html }} onClick={follow} />;
  // A details element, so that the browser's find in page still reaches the folded text and opens it.
  return (
    <div className="brief-markdown-fold" onClick={follow}>
      <div className="prose brief-markdown" dangerouslySetInnerHTML={{ __html: fold.lead }} />
      <details className="brief-markdown-more" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>{open ? t.markdownLess : t.markdownMore(fold.hidden)}</summary>
        <div className="prose brief-markdown" dangerouslySetInnerHTML={{ __html: fold.rest }} />
      </details>
    </div>
  );
}
