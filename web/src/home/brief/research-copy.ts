/**
 * A research desk as Markdown (T-9), for copying a Home report: the claims
 * with what may and may not be said, each plot as a table of its rows, the
 * sources, the definitions with every version, and the next steps as
 * previews. Numbers say where they came from: a fixed snapshot (with the
 * file it was read from) or the Agent. Nothing of the card's controls, and
 * no snapshot URL or token, is copied. Pure: no DOM and no fetch; the
 * caller gives Core's read when it has one (`resolved`).
 */
import type { ResearchDeskProps } from "./brief-catalog";

type Desk = ResearchDeskProps;
type Estimate = Desk["plots"][number]["rows"][number]["estimate"];
type Num = Estimate["value"];
/** Core's research read for this desk (GET .../brief/research/...), or the part of it the copy uses. */
export type ResearchResolved = {
  values: Record<string, { status: string; value?: number; from?: string }>;
  sources: Record<string, { sha256?: string; takenAt?: string; available?: boolean }>;
};
/** The words the copy adds, in the interface language. */
export type ResearchCopyWords = {
  claims: string;
  status: Record<Desk["claims"][number]["status"], string>;
  canSay: string;
  cannotSay: string;
  kind: Record<"criterion" | "interpretation" | "exploratory", string>;
  conditions: string;
  paper: string;
  row: string;
  value: string;
  interval: string;
  scaled: (scale: number) => string;
  origin: string;
  read: (file: string) => string;
  provided: string;
  notRead: string;
  sources: string;
  definitions: string;
  version: (version: number) => string;
  plans: string;
  previewOnly: string;
  question: string;
  produces: string;
  notProduced: string;
};

const ENGLISH: ResearchCopyWords = {
  claims: "Claims",
  status: { supported: "supported", conditional: "holds under conditions", unsupported: "not supported", open: "open" },
  canSay: "May say",
  cannotSay: "May not say",
  kind: { criterion: "statistical criterion", interpretation: "interpretation", exploratory: "exploratory" },
  conditions: "Holds only under",
  paper: "In the paper",
  row: "Row",
  value: "Value",
  interval: "Interval",
  scaled: (scale) => `Values shown × ${scale} of the file's.`,
  origin: "From",
  read: (file) => `snapshot ${file}`,
  provided: "the Agent",
  notRead: "not read",
  sources: "Sources",
  definitions: "Definitions",
  version: (version) => `v${version}`,
  plans: "Next steps (previews; nothing has run)",
  previewOnly: "Whether a plan runs as described is not verified.",
  question: "Question",
  produces: "Would produce",
  notProduced: "Would not produce",
};

/** A table cell: no pipes or line breaks. */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function number(value: Num | undefined, at: string, resolved: ResearchResolved | undefined, digits: number | undefined, scale = 1) {
  const text = (n: number) => (digits === undefined ? String(n * scale) : (n * scale).toFixed(digits));
  if (value === undefined) return { text: "", origin: "" };
  if (typeof value === "number") return { text: text(value), origin: "provided" as const };
  const read = resolved?.values[at];
  if (read?.status === "read" && typeof read.value === "number")
    return { text: text(read.value), origin: "read" as const, from: value.from };
  return { text: "—", origin: "not" as const, from: value.from };
}

/** One desk's Markdown. */
export function researchDeskMarkdown(desk: Desk, resolved?: ResearchResolved, words: ResearchCopyWords = ENGLISH): string {
  const out: string[] = [];
  const sources = new Map(desk.sources.map((source) => [source.id, source]));
  if (desk.title) out.push(`### ${desk.title}`, "");
  out.push(`#### ${words.claims}`, "");
  for (const claim of desk.claims) {
    out.push(`**${claim.title}** (${words.status[claim.status]})`, "", claim.statement, "");
    for (const [stance, label] of [["can", words.canSay], ["cannot", words.cannotSay]] as const) {
      const said = (claim.statements ?? []).filter((statement) => statement.stance === stance);
      if (!said.length) continue;
      out.push(`${label}:`);
      for (const statement of said) out.push(`- ${statement.text} (${words.kind[statement.kind]})`);
      out.push("");
    }
    if (claim.conditions?.length) {
      out.push(`${words.conditions}:`);
      for (const condition of claim.conditions) out.push(`- ${condition.text}`);
      out.push("");
    }
    if (claim.paper?.length) {
      out.push(`${words.paper}:`);
      for (const place of claim.paper) {
        const source = sources.get(place.cite.source);
        out.push(`- ${place.label}${source ? ` (${source.label}${place.cite.lines ? `, ${place.cite.lines}` : ""})` : ""}`);
      }
      out.push("");
    }
  }
  for (const plot of desk.plots) {
    out.push(`#### ${plot.title}${plot.unit ? ` (${plot.unit})` : ""}`, "");
    if (plot.scale) out.push(words.scaled(plot.scale), "");
    out.push(`| ${words.row} | ${words.value} | ${plot.interval ?? words.interval} | ${words.origin} |`, "| --- | --- | --- | --- |");
    // A row's group is part of its name: two rows may share a label in different groups.
    const rows = plot.rows.flatMap((row) => {
      const label = row.group ? `${row.group} · ${row.label}` : row.label;
      return [
        { id: row.id, label, estimate: row.estimate },
        ...(row.parts ?? []).map((part) => ({ id: part.id, label: `${label} · ${part.label}`, estimate: part.estimate })),
      ];
    });
    for (const row of rows) {
      const value = number(row.estimate.value, `${row.id}.value`, resolved, plot.digits, plot.scale);
      const low = number(row.estimate.low, `${row.id}.low`, resolved, plot.digits, plot.scale);
      const high = number(row.estimate.high, `${row.id}.high`, resolved, plot.digits, plot.scale);
      const interval = row.estimate.low !== undefined || row.estimate.high !== undefined ? `[${low.text}, ${high.text}]` : "";
      const origin = value.origin === "read" ? words.read(value.from!) : value.origin === "provided" ? words.provided : words.notRead;
      out.push(`| ${cell(row.label)} | ${value.text} | ${interval} | ${cell(origin)} |`);
    }
    out.push("");
  }
  if (desk.sources.length) {
    out.push(`#### ${words.sources}`, "");
    for (const source of desk.sources) {
      const info = resolved?.sources[source.id];
      const snapshot = source.snapshot && info?.sha256 ? ` — ${source.snapshot}, SHA-256 ${info.sha256}${info.takenAt ? `, ${info.takenAt}` : ""}` : "";
      out.push(`- ${source.label}${snapshot}${source.location ? ` (${source.location})` : ""}`);
    }
    out.push("");
  }
  if (desk.definitions?.length) {
    out.push(`#### ${words.definitions}`, "");
    for (const definition of desk.definitions)
      for (const version of [...definition.versions].sort((a, b) => b.version - a.version))
        out.push(`- ${definition.title} ${words.version(version.version)}: ${version.text}${version.change ? ` (${version.change})` : ""}`);
    out.push("");
  }
  if (desk.plans?.length) {
    out.push(`#### ${words.plans}`, "", words.previewOnly, "");
    for (const plan of desk.plans) {
      out.push(`- **${plan.title}** — ${words.question}: ${plan.question}`);
      if (plan.outputs?.length) out.push(`  - ${words.produces}: ${plan.outputs.join("; ")}`);
      if (plan.notProduced?.length) out.push(`  - ${words.notProduced}: ${plan.notProduced.join("; ")}`);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
