import { markdownHasHtml, markdownHtml, markdownTokens, markdownTokensHtml } from "./markdown.ts";
import { proseHtml, sanitizeProse } from "./prose-html.ts";
import { FADE, SPREAD, reducedMotion, revealWords, type Segment } from "./stream-reveal.ts";

/** Some of a reply's HTML: as marked wrote it, as Prose shows it, and its nodes. */
type Block = { html: string; safe: string; nodes: ChildNode[]; length: number };

/**
 * Whether a reply being written can be cut at `at`, the start of a top-level
 * block, so that no more text can change the blocks before it (marked 18's
 * block tokenizer): a line beginning with neither white space nor a list
 * marker, after an empty line. An empty line ends a paragraph (and the lines
 * a setext heading may take), a table and a blockquote; a fence before it was
 * closed on a whole line, or it would have run on to `at`; and a line at the
 * margin that is not a list item ends a list or indented code after an empty
 * line. Raw HTML and link reference definitions, which an empty line does not
 * end, never come here: `ProseBlocks` reads text with either whole.
 */
export function canSettleAt(text: string, at: number): boolean {
  return (
    at >= 2 &&
    at < text.length &&
    text.charCodeAt(at - 1) === 10 &&
    text.charCodeAt(at - 2) === 10 &&
    !/[\s*+\-\d]/.test(text[at])
  );
}

const shownLength = (node: Node) =>
  node.nodeType === 1 || node.nodeType === 3 ? (node.textContent?.length ?? 0) : 0;

/**
 * A reply's Markdown drawn into `root` as it is written (YN-234). Text that
 * only grows is read from the last settled block on: blocks before it keep
 * their nodes, so a long reply costs what its last blocks cost, and a
 * selection or a word still fading in there stays as it is. Of the rest, a
 * block whose HTML is the same as before keeps its nodes too. Each part is
 * sanitized as Prose sanitizes, and together they are what Prose shows for
 * the whole text (`proseHtml`): `finish` makes sure of it once the reply is
 * whole. Any other change of text draws it all again, and so does each text
 * with raw HTML, link reference definitions or a carriage return, whose
 * reading does not stop at an empty line. New words fade in as with
 * `useStreamReveal`, only the drawn ones being touched.
 */
export class ProseBlocks {
  private text: string | null = null;
  /** Characters of `text` drawn as blocks that can no longer change… */
  private settledEnd = 0;
  /** …their HTML as shown, and the length of their text. */
  private settledSafe = "";
  private settledLength = 0;
  /** The blocks after them, drawn as they are now. */
  private open: Block[] = [];
  /** Read and drawn as one, as Prose draws a reply that is whole. */
  private whole = false;
  private segments: Segment[] = [];
  private fading: { span: HTMLElement; until: number }[] = [];

  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /** Show `text`; `whole` once nothing more is coming for it. */
  show(text: string, whole: boolean, now = performance.now()) {
    const previous = this.text;
    if (text === previous) {
      const drawn = whole ? this.finish() : null;
      if (drawn) this.reveal(this.length(), drawn, now);
      return;
    }
    const before = this.length();
    const appended = previous !== null && text.startsWith(previous);
    if (!appended) this.clear();
    this.text = text;
    // A carriage return marked reads as a new line, also one before an
    // earlier `\n`: such a text is read whole from then on.
    if (!this.whole && text.includes("\r", appended ? Math.max(0, previous.length - 1) : 0)) this.whole = true;
    let drawn = this.whole ? this.drawWhole(text) : this.draw(text);
    if (whole) drawn = this.finish() ?? drawn;
    this.reveal(appended ? before : null, drawn, now);
  }

  /** The text shown, as the root's textContent would count it. */
  private length() {
    return this.settledLength + this.open.reduce((sum, block) => sum + block.length, 0);
  }

  private clear() {
    this.root.replaceChildren();
    this.settledEnd = 0;
    this.settledSafe = "";
    this.settledLength = 0;
    this.open = [];
    this.whole = false;
    this.fading = [];
  }

  /** A block from its HTML, drawn after the root's last node. */
  private block(html: string, safe = sanitizeProse(html)): Block {
    const scratch = this.root.ownerDocument.createElement("div");
    scratch.innerHTML = safe;
    const nodes = Array.from(scratch.childNodes);
    this.root.append(...nodes);
    return { html, safe, nodes, length: nodes.reduce((sum, node) => sum + shownLength(node), 0) };
  }

  /** Draw the text from the last settled block on: the nodes drawn, and where their text starts. */
  private draw(text: string): Drawn {
    const start = this.settledEnd;
    const rest = text.slice(start);
    const tokens = markdownTokens(rest);
    if (Object.keys(tokens.links).length || (rest.includes("<") && markdownHasHtml(tokens))) {
      this.whole = true;
      return this.drawWhole(text);
    }
    const parts: { html: string; at: number }[] = [];
    let at = 0;
    for (const token of tokens) {
      if (token.type !== "space") parts.push({ html: markdownTokensHtml([token]), at });
      at += token.raw.length;
    }
    // Where the text can be cut: the last block it can be cut before. Only
    // where every character is in a token, so that each one's start is known.
    let cut = 0;
    if (at === rest.length)
      for (let i = parts.length - 1; i > 0; i--)
        if (canSettleAt(text, start + parts[i].at)) {
          cut = i;
          break;
        }
    // Blocks that are as they were keep their nodes; the rest are drawn anew.
    let kept = 0;
    while (kept < parts.length && kept < this.open.length && this.open[kept].html === parts[kept].html) kept++;
    for (const block of this.open.slice(kept)) for (const node of block.nodes) node.remove();
    const offset = this.settledLength + this.open.slice(0, kept).reduce((sum, block) => sum + block.length, 0);
    const settling = this.open.slice(0, Math.min(kept, cut));
    // Blocks that settle as they are first drawn are drawn as one.
    if (cut > kept) settling.push(this.block(parts.slice(kept, cut).map((part) => part.html).join("")));
    const open = this.open.slice(Math.min(kept, cut), kept);
    for (const part of parts.slice(Math.max(kept, cut))) open.push(this.block(part.html));
    const drawn = [...settling.slice(Math.min(kept, cut)), ...open.slice(Math.max(0, kept - cut))].flatMap((block) => block.nodes);
    for (const block of settling) {
      this.settledSafe += block.safe;
      this.settledLength += block.length;
    }
    if (cut) this.settledEnd = start + parts[cut].at;
    this.open = open;
    return { nodes: drawn, offset };
  }

  /** Draw the whole text as one block, as Prose draws a reply that is whole. */
  private drawWhole(text: string, html = markdownHtml(text), safe?: string): Drawn {
    const [only] = this.open;
    if (!this.settledLength && !this.settledSafe && this.open.length === 1 && only.html === html && (safe ?? only.safe) === only.safe)
      return { nodes: [], offset: this.length() };
    this.root.replaceChildren();
    this.settledEnd = 0;
    this.settledSafe = "";
    this.settledLength = 0;
    this.open = [this.block(html, safe)];
    return { nodes: this.open[0].nodes, offset: 0 };
  }

  /**
   * The reply is whole: if its blocks together are not what Prose shows for
   * the whole text, show that instead (the nodes then drawn), and read any
   * text after it whole.
   */
  private finish(): Drawn | null {
    const text = this.text ?? "";
    const expected = proseHtml(text);
    if (this.settledSafe + this.open.map((block) => block.safe).join("") === expected) return null;
    this.whole = true;
    return this.drawWhole(text, markdownHtml(text), expected);
  }

  /**
   * New words fade in as with `useStreamReveal`: only after an append, and
   * not with reduced motion. Words drawn before keep their spans, so their
   * fades go on; a span whose fade is over is plain text again.
   */
  private reveal(before: number | null, drawn: Drawn | null, now: number) {
    const length = this.length();
    if (before === null || reducedMotion()) {
      this.segments = [];
      this.fading = [];
      return;
    }
    const segments = this.segments.filter((s) => s.end <= length && now < s.at + SPREAD + FADE);
    if (length > before) segments.push({ start: before, end: length, at: now });
    this.segments = segments;
    // A word the reader is selecting keeps its span until the next text.
    const selection = this.root.ownerDocument.getSelection();
    const selected = selection && !selection.isCollapsed ? selection : null;
    this.fading = this.fading.filter(({ span, until }) => {
      if (!this.root.contains(span)) return false;
      if (until > now || selected?.containsNode(span, true)) return true;
      span.replaceWith(...span.childNodes);
      return false;
    });
    if (drawn) this.fading.push(...revealWords(drawn.nodes, drawn.offset, segments, now));
  }
}

type Drawn = { nodes: ChildNode[]; offset: number };
