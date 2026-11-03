import { marked } from "marked";
import { api } from "../../api";
import { strings, type Language } from "../../i18n";
import { sourceTarget } from "../../intelligent-ui/contract.ts";
import type { TimeDisplay } from "../../time-preferences";
import type { Section, SectionAttachment } from "../types";
import { briefText } from "./brief-text";
import { briefMarkdownHtml } from "./markdown-html";
import { researchDeskMarkdown, type ResearchCopyWords, type ResearchResolved } from "./research-copy";
import {
  CHART_TYPES,
  formatTime,
  isBriefSpec,
  type BriefElement,
  type BriefSpec,
  type BriefTableProps,
  type ChartProps,
  type ChecklistProps,
  type FindingsProps,
  type GroupProps,
  type LiveRefsProps,
  type MathProps,
  type MetricsProps,
  type PlanProps,
  type SourcesProps,
  type AttachmentsProps,
  type ResearchDeskProps,
  researchPath,
} from "./brief-catalog";

// T-9: a Home report as Markdown to paste elsewhere, written from the
// section's stored body (the json-render spec), never from the page: no
// control or fold label, no "Show all", no request address or token. A
// folded card, a long table and a collapsed plan copy in full.

const words = strings({
  dataAsOf: (at: string) => `Data as of ${at}`,
  chart: (x: string, y: string) => `Chart · x: ${x} · y: ${y}`,
  seriesSummary: (name: string, points: number, x: string, y: string, last: string) =>
    `${name}: ${points} ${points === 1 ? "point" : "points"}${x ? `; x ${x}` : ""}${y ? `; y ${y}` : ""}${last ? `; last ${last}` : ""}`,
  chartFile: (name: string, x: string, series: string) => `Data in the attachment ${name} (x: ${x}; ${series})`,
  noRows: "(no rows)",
  sourcesColumn: "Sources",
  image: "Image",
  file: "File",
  link: "Link",
  snapshotOf: (key: string, version: number) => `kept with Home card ${key}, version ${version}`,
  referencedAt: (path: string) => `referenced at ${path}; it may have changed`,
  notAttached: "no longer attached to this card",
  previously: (value: string) => `previously ${value}`,
}, {
  dataAsOf: (at) => `数据截至 ${at}`,
  chart: (x, y) => `图表 · x：${x} · y：${y}`,
  seriesSummary: (name, points, x, y, last) =>
    `${name}：${points} 个数据点${x ? `；x ${x}` : ""}${y ? `；y ${y}` : ""}${last ? `；最后一个 ${last}` : ""}`,
  chartFile: (name, x, series) => `数据在附件 ${name} 中（x：${x}；${series}）`,
  noRows: "（没有行）",
  sourcesColumn: "来源",
  image: "图片",
  file: "文件",
  link: "链接",
  snapshotOf: (key, version) => `随 Home 卡片 ${key} 第 ${version} 版保存`,
  referencedAt: (path) => `引用自 ${path}，可能已更改`,
  notAttached: "已不属于这张卡片",
  previously: (value) => `之前为 ${value}`,
});

/** "&amp;" or "&#38;" would be read back as one character: keep the "&" literal. */
const entities = (text: string) => text.replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&");
/** A research desk's words in Chinese (research-copy.ts gives English), in
 * the card's own vocabulary (research-text.ts). */
const researchZh: ResearchCopyWords = {
  claims: "主张",
  status: { supported: "已支持", conditional: "有条件成立", unsupported: "未获支持", open: "待定" },
  canSay: "可以说",
  cannotSay: "不能说",
  kind: { criterion: "统计判据", interpretation: "作者解释", exploratory: "探索性观察" },
  conditions: "只在这些条件下成立",
  paper: "论文里的位置",
  row: "行",
  value: "值",
  interval: "区间",
  scaled: (scale) => `显示的值是文件中的 × ${scale}。`,
  origin: "取自",
  basis: "来源 · 定义",
  lines: (lines) => `第 ${lines} 行`,
  noOwnSource: "没有自己的来源",
  noOwnDefinition: "没有自己的定义",
  read: (file) => `快照 ${file}`,
  provided: "Agent 提供",
  notRead: "未读取",
  sources: "来源",
  definitions: "分析定义",
  version: (version) => `v${version}`,
  plans: "候选下一步（只是预览，什么都没有运行）",
  previewOnly: "计划能否按所述执行尚未核实。",
  question: "疑问",
  produces: "会得到",
  notProduced: "不会得到",
};

/** Text the page shows as written (a title, a table cell, a label, an item,
 * a finding, a path, a chart's category): on one line, with every character
 * that means something to Markdown wherever it stands escaped (emphasis,
 * code, a link, markup, a table pipe, a heading's closing "#", math's "$"),
 * so it reads back as the same characters. Only Markdown blocks are copied
 * as Markdown. */
const inline = (value: unknown) => entities(String(value ?? "").replace(/\s*\n\s*/g, " ").trim().replace(/[\\`*_~[\]<>|#$]/g, "\\$&"));
/** The same, where it begins a list item's text: a leading "-", "+" or "1."
 * would start a nested list. */
const itemText = (value: unknown) => inline(value).replace(/^([-+])/, "\\$1").replace(/^(\d+)([.)])/, "$1\\$2");
const range = (values: (number | string)[]) => {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (numbers.length === values.length && numbers.length > 0) {
    const low = Math.min(...numbers);
    const high = Math.max(...numbers);
    return low === high ? String(low) : `${low}–${high}`;
  }
  return values.length > 1 ? `${values[0]} … ${values[values.length - 1]}` : values.length ? String(values[0]) : "";
};
/** A link's label on one line, Markdown's brackets and backslash kept literal. */
const label = inline;
/** A link's destination: the address the page links to (sourceTarget's
 * normalized URL), in angle brackets so parentheses stay part of it. An "&"
 * that begins an entity is written "&amp;", which marked keeps and a
 * CommonMark renderer decodes, so both link to the same address. */
const destination = (url: string) => `<${url.replace(/[\\<>]/g, "\\$&").replace(/&(?=#?[A-Za-z0-9]+;)/g, "&amp;").replace(/[\r\n]/g, (c) => encodeURIComponent(c))}>`;
/** A web link as the page makes it, or nothing for an address it wouldn't link. */
const link = (text: unknown, url: string | undefined): string | null => {
  const target = url ? sourceTarget(url) : null;
  return target?.kind === "web" ? `[${label(text)}](${destination(target.path)})` : null;
};
const axisName = (axis: ChartProps["x"]) => `${inline(axis.label)}${axis.unit ? ` (${inline(axis.unit)})` : ""}`;

/** Raw HTML blocks that run until their own end, not to a blank line. */
const htmlEnds: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i, (match) => `</${match[1].toLowerCase()}>`],
  [/^ {0,3}<!--/, () => "-->"],
  [/^ {0,3}<\?/, () => "?>"],
  [/^ {0,3}<!\[CDATA\[/, () => "]]>"],
  [/^ {0,3}<![A-Za-z]/, () => ">"],
];
/** What a Markdown block leaves open at its end, read as Home's renderer
 * reads it: a code fence or a raw HTML block that never closes. Home renders
 * each block on its own, so there it ends with the block; in the copy, one
 * document, it would take in everything after. */
function openAtEnd(text: string): string | null {
  const last = marked.lexer(text, { gfm: true }).filter((token) => token.type !== "space").at(-1);
  if (!last) return null;
  const lines = last.raw.replace(/\n+$/, "").split("\n");
  if (last.type === "code" && last.codeBlockStyle !== "indented") {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0])?.[1];
    // marked closes a fence with the same run, longer allowed, then spaces.
    const closed = !!fence && lines.length > 1 && new RegExp(`^ {0,3}${fence}[~\`]* *$`).test(lines[lines.length - 1]);
    return fence && !closed ? fence : null;
  }
  if (last.type === "html") {
    for (const [start, end] of htmlEnds) {
      const match = start.exec(lines[0]);
      if (!match) continue;
      const close = end(match);
      const after = last.raw.slice(match[0].length);
      const closed = close === "-->" ? /^-?>/.test(after) || after.includes(close) : after.toLowerCase().includes(close);
      return closed ? null : close;
    }
  }
  return null;
}
/** Stands in for whatever part follows a block in the copy. */
const NEXT_PART = "yuzuno-copy-next-part";
const view = (html: string): DocumentFragment => {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
};
const visible = (node: Node) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
/** Whether `markdown`, with a part after it, still shows what the page shows
 * for the block on its own (`page`) and leaves that part outside it. Both
 * are read as Home reads them (marked, then the same sanitizing). */
function standsAlone(markdown: string, page: DocumentFragment): boolean {
  const joined = view(briefMarkdownHtml(`${markdown}\n\n${NEXT_PART}`));
  const last = joined.lastElementChild;
  if (last?.tagName !== "P" || last.textContent !== NEXT_PART) return false;
  last.remove();
  return visible(joined) === visible(page);
}
/** A Markdown block exactly as written (its indentation is an indented code
 * block), with a fence or raw HTML block it leaves open closed where the
 * block ends, as it ends on the page. Two kinds of block are copied as the
 * HTML the page shows for them instead, on one line, so they end there: one
 * that still takes in what follows it (raw HTML cut off mid-tag, say), and
 * one that defines link references. Home resolves a block's references
 * within that block; in one document they would be shared, so another
 * block's [s] would point at the first [s] defined anywhere. */
function markdownBlock(value: unknown): string {
  const text = String(value ?? "");
  if (!text.trim()) return "";
  const open = openAtEnd(text);
  const closed = `${text}${open ? `${/\n$/.test(text) ? "" : "\n"}${open}` : ""}`;
  if (typeof document !== "undefined") {
    const html = briefMarkdownHtml(text);
    const defines = Object.keys(marked.lexer(text, { gfm: true }).links).length > 0;
    if (defines || !standsAlone(closed, view(html)))
      return html.trim() ? `<div>${html.trim().replace(/\r?\n/g, "&#10;")}</div>` : "";
  }
  // A block whose first line starts indented or with a list marker would
  // continue a list just before it (Home shows it on its own): an empty
  // comment ends that list.
  const first = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const boundary = /^(?:[ \t]|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/.test(first) ? "<!-- -->\n\n" : "";
  return `${boundary}${closed}`;
}

/** research: Core's numbers for each research desk, by element key, read for
 * this section version; a desk without one copies its snapshot numbers as
 * not read. */
export function sectionMarkdown(section: Section, language: Language, time: TimeDisplay, research?: Record<string, ResearchResolved | undefined>): string {
  const w = words(language);
  const b = briefText(language);
  const out: string[] = [`# ${inline(section.title)}`];
  if (section.status) out.push(`_${w.dataAsOf(formatTime(section.status.asOf, time))}_`);
  if (!isBriefSpec(section.body)) return out.join("\n\n") + "\n";
  const spec: BriefSpec = section.body;
  const element = (key: string): BriefElement | undefined => (Object.hasOwn(spec.elements, key) ? spec.elements[key] : undefined);
  // Sources by id across the body: a table row cites them.
  const sources = new Map<string, SourcesProps["items"][number]>();
  for (const part of Object.values(spec.elements))
    if (part?.type === "Sources") for (const item of (part.props as SourcesProps).items ?? []) sources.set(item.id, item);
  const attachment = (name: string): SectionAttachment | undefined => section.attachments.find((item) => item.name === name);
  const heading = (depth: number, title?: string) => (title ? [`${"#".repeat(Math.min(6, depth))} ${inline(title)}`] : []);
  const seen = new Set<string>();

  const leaf = (part: BriefElement, depth: number, key: string): string[] => {
    switch (part.type) {
      case "ResearchDesk":
        return [researchDeskMarkdown(part.props as ResearchDeskProps, research?.[key], language === "zh-Hans" ? researchZh : undefined).trim()];
      case "Markdown":
        return [markdownBlock((part.props as { text: string }).text)];
      case "Math": {
        const { tex, display } = part.props as MathProps;
        return [display ? `$$\n${tex}\n$$` : `$${tex}$`];
      }
      case "Checklist": {
        const { title, items } = part.props as ChecklistProps;
        return [...heading(depth, title), items.map((item) => `- [${item.done ? "x" : " "}] ${itemText(item.text)}`).join("\n")];
      }
      case "Plan": {
        const { title, steps } = part.props as PlanProps;
        return [...heading(depth, title ?? b.plan), steps.map((step, index) => `${index + 1}. ${itemText(step.text)} — ${b.planState[step.state]}`).join("\n")];
      }
      case "Findings": {
        const { title, items } = part.props as FindingsProps;
        return [...heading(depth, title ?? b.findings),
          items.map((item) => `- **${b.severity[item.severity]}** · ${inline(item.source)}: ${inline(item.text)}`).join("\n")];
      }
      case "Metrics": {
        const { items } = part.props as MetricsProps;
        return [items.map((item) => {
          const unit = item.unit ? ` ${inline(item.unit)}` : "";
          const previous = item.previous !== undefined ? ` (${w.previously(`${inline(item.previous)}${unit}`)})` : "";
          return `- **${inline(item.label)}**: ${inline(item.value)}${unit}${previous}${item.detail ? ` — ${inline(item.detail)}` : ""}`;
        }).join("\n")];
      }
      case "Table": {
        const { title, columns, rows } = part.props as BriefTableProps;
        const cited = rows.some((row) => row.sourceIds?.length);
        const head = [...columns.map((column) => inline(column.label)), ...(cited ? [w.sourcesColumn] : [])];
        const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`,
          ...rows.map((row) => `| ${[...columns.map((column) => inline(row.cells[column.key])),
            ...(cited ? [(row.sourceIds ?? []).map((id) => inline(sources.get(id)?.label ?? id)).join(", ")] : [])].join(" | ")} |`)];
        return [...heading(depth, title), rows.length ? lines.join("\n") : `${lines.slice(0, 2).join("\n")}\n\n${w.noRows}`];
      }
      case "LiveRefs": {
        const { items } = part.props as LiveRefsProps;
        return [...heading(depth, b.references), items.map((item) => {
          const state = section.refs?.[`${item.kind}:${item.id}`];
          const name = `${b.refKind[item.kind]} ${item.id}`;
          const named = link(name, state?.url) ?? inline(name);
          // Unread is not missing: Core couldn't read it this time.
          const about = [item.label ?? state?.title, state?.found === false ? (state.unavailable ? b.refUnavailable : b.notFound) : state?.state]
            .filter(Boolean).map(inline);
          return `- ${named}${about.length ? `: ${about.join(" · ")}` : ""}${item.note ? ` — ${inline(item.note)}` : ""}`;
        }).join("\n")];
      }
      case "Attachments": {
        const { items } = part.props as AttachmentsProps;
        return [items.map((item) => {
          const file = attachment(item.name);
          const caption = item.caption || file?.caption;
          if (!file) return `- ${itemText(item.name)}${caption ? ` — ${inline(caption)}` : ""} (${w.notAttached})`;
          // An external link is its own stable address; a kept file is named
          // with its card and version, never a request address of this Core.
          const linked = file.kind === "link" ? link(caption || file.name, file.url) : null;
          if (linked) return `- ${w.link}: ${linked}`;
          const where = file.snapshot ? w.snapshotOf(section.key, section.version) : file.path ? w.referencedAt(inline(file.path)) : "";
          return `- ${file.kind === "image" ? w.image : w.file}: ${inline(file.name)}${caption ? ` — ${inline(caption)}` : ""}${where ? ` (${where})` : ""}`;
        }).join("\n")];
      }
      case "Sources": {
        const { items } = part.props as SourcesProps;
        if (!items.length) return [];
        return [...heading(depth, b.sources), items.map((item) => {
          const linked = link(item.label, item.href);
          return linked ? `- ${linked}` : `- ${itemText(item.label)}: ${inline(item.href)}`;
        }).join("\n")];
      }
      default: {
        if (!CHART_TYPES.has(part.type)) return [];
        const chart = part.props as ChartProps;
        const lines = [w.chart(axisName(chart.x), axisName(chart.y))];
        for (const series of chart.series ?? []) {
          const points = series.points as [number | string, number][];
          const last = points.length ? `${points[points.length - 1][1]}` : "";
          lines.push(`- ${w.seriesSummary(itemText(series.name), points.length, inline(range(points.map(([x]) => x))), inline(range(points.map(([, y]) => y))), inline(last))}`);
        }
        if (chart.data) {
          const columns = chart.data.series.map((series) => `${inline(series.name)} ← ${inline(series.column)}`).join(", ");
          lines.push(`- ${w.chartFile(inline(chart.data.attachment), inline(chart.data.x), columns)}`);
        }
        return [...heading(depth, chart.title), lines.join("\n")];
      }
    }
  };
  const walk = (key: string, depth: number): string[] => {
    const part = element(key);
    if (!part || seen.has(key)) return [];
    seen.add(key);
    if (part.type === "BriefBody" || part.type === "Columns" || part.type === "Group") {
      const title = part.type === "Group" ? (part.props as GroupProps).title : undefined;
      const inner = (part.children ?? []).flatMap((child) => walk(child, title ? depth + 1 : depth));
      return inner.length ? [...heading(depth, title), ...inner] : [];
    }
    try {
      return leaf(part, depth, key).filter((block) => block.trim().length > 0);
    } catch {
      // A part Core accepted but this copy can't read is left out, as the page leaves it out.
      return [];
    }
  };
  out.push(...walk(spec.root, 2));
  return out.join("\n\n") + "\n";
}

/** Core's numbers for one research desk, read for exactly the version being
 * copied. A failed read, or an answer for another section or version, is no
 * read: those numbers copy as not read, never another version's. */
async function readResearch(projectId: string, section: Section, key: string): Promise<ResearchResolved | undefined> {
  try {
    const value = (await api<unknown>(researchPath(projectId, section.key, key, section.version))) as
      { key?: unknown; version?: unknown; values?: unknown; sources?: unknown } | null;
    const object = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
    if (!object(value) || value!.version !== section.version || (value!.key !== undefined && value!.key !== section.key) ||
      !object(value!.values) || !object(value!.sources)) return undefined;
    return value as ResearchResolved;
  } catch {
    return undefined;
  }
}

/** What Copy report writes. A report with research desks reads their numbers
 * first: the button writes that promise through ClipboardItem, so the
 * clipboard write still starts in the click (Safari). Without a desk it is
 * the text itself. */
export function reportMarkdown(section: Section, projectId: string, language: Language, time: TimeDisplay): string | Promise<string> {
  const keys = isBriefSpec(section.body)
    ? Object.entries(section.body.elements).filter(([, part]) => part?.type === "ResearchDesk").map(([key]) => key)
    : [];
  if (!keys.length) return sectionMarkdown(section, language, time);
  return Promise.all(keys.map((key) => readResearch(projectId, section, key))).then((reads) =>
    sectionMarkdown(section, language, time, Object.fromEntries(keys.map((key, index) => [key, reads[index]]))));
}
