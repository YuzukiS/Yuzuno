import { strings, type Language } from "../../i18n";
import { sourceTarget } from "../../intelligent-ui/contract.ts";
import type { TimeDisplay } from "../../time-preferences";
import type { Section, SectionAttachment } from "../types";
import { briefText } from "./brief-text";
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
/** Text the page shows as written (a title, a table cell, a label, an item,
 * a finding): on one line, with every character Markdown would read as
 * emphasis, code, a link, markup or a table pipe escaped, so it reads back
 * as the same characters. Only Markdown blocks are copied as Markdown. */
const inline = (value: unknown) => entities(String(value ?? "").replace(/\s*\n\s*/g, " ").trim().replace(/[\\`*_~[\]<>|]/g, "\\$&"));
/** The same, where it begins a list item's text: a leading "-", "+", "#" or
 * "1." would start a nested list or heading. */
const itemText = (value: unknown) => inline(value).replace(/^([-+#])/, "\\$1").replace(/^(\d+)([.)])/, "$1\\$2");
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

export function sectionMarkdown(section: Section, language: Language, time: TimeDisplay): string {
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

  const leaf = (part: BriefElement, depth: number): string[] => {
    switch (part.type) {
      case "Markdown":
        return [String((part.props as { text: string }).text).trim()];
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
          if (!file) return `- ${inline(item.name)}${caption ? ` — ${inline(caption)}` : ""} (${w.notAttached})`;
          // An external link is its own stable address; a kept file is named
          // with its card and version, never a request address of this Core.
          const linked = file.kind === "link" ? link(caption || file.name, file.url) : null;
          if (linked) return `- ${w.link}: ${linked}`;
          const where = file.snapshot ? w.snapshotOf(section.key, section.version) : file.path ? w.referencedAt(file.path) : "";
          return `- ${file.kind === "image" ? w.image : w.file}: ${inline(file.name)}${caption ? ` — ${inline(caption)}` : ""}${where ? ` (${where})` : ""}`;
        }).join("\n")];
      }
      case "Sources": {
        const { items } = part.props as SourcesProps;
        if (!items.length) return [];
        return [...heading(depth, b.sources), items.map((item) => {
          const linked = link(item.label, item.href);
          return linked ? `- ${linked}` : `- ${inline(item.label)}: ${inline(item.href)}`;
        }).join("\n")];
      }
      default: {
        if (!CHART_TYPES.has(part.type)) return [];
        const chart = part.props as ChartProps;
        const lines = [w.chart(axisName(chart.x), axisName(chart.y))];
        for (const series of chart.series ?? []) {
          const points = series.points as [number | string, number][];
          const last = points.length ? `${points[points.length - 1][1]}` : "";
          lines.push(`- ${w.seriesSummary(inline(series.name), points.length, range(points.map(([x]) => x)), range(points.map(([, y]) => y)), last)}`);
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
      return leaf(part, depth).filter((block) => block.trim().length > 0);
    } catch {
      // A part Core accepted but this copy can't read is left out, as the page leaves it out.
      return [];
    }
  };
  out.push(...walk(spec.root, 2));
  return out.join("\n\n") + "\n";
}
