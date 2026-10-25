// Where a result came from, as Core recorded it (T-168): one Job, or its
// whole run, exported as a JSON manifest and a short report. Core builds both
// from its records; this previews them and saves exactly what was previewed.
// It fetches no artifact: each stays where it was checked, and a local one
// downloads from its run's artifact list after Core checks it again.
import { useState } from "react";
import { FileDown } from "lucide-react";
import { strings, useStrings } from "./i18n";
import { api, errorText } from "./api";
import { JobCard } from "./JobParts";

type Attempt = {
  target: { kind: string; machineName?: string | null };
  artifacts: { files: unknown[] };
  inputs: { withheld?: number };
};
export type ProvenanceExport = {
  manifest: {
    schema: string;
    version: number;
    scope: { kind: "job" | "run"; id: string; attempts: number };
    attempts: Attempt[];
    omitted: string[];
  };
  report: string;
};

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// The card's own words (T-189); machine names and the report Core writes are
// shown as they came.
const text = strings({
  attempts: (count: number) => plural(count, "attempt"),
  on: (machines: string) => `on ${machines || "no machine"}`,
  artifacts: (count: number) => plural(count, "artifact reference"),
  withheld: (count: number) => `${plural(count, "input path")} withheld`,
  title: "Provenance",
  intro:
    "What Core recorded about where this result came from: machine, code and input digests, artifacts and checks. Command arguments, environment values, absolute paths, output and file contents are left out.",
  previewAttempt: "Preview this attempt",
  previewExport: "Preview export",
  previewRun: "Preview whole run",
  report: "Report preview",
  saveJson: "Save JSON",
  saveReport: "Save report",
  close: "Close",
}, {
  attempts: (count) => `${count} 次尝试`,
  on: (machines) => `位于 ${machines || "无机器"}`,
  artifacts: (count) => `${count} 个产物引用`,
  withheld: (count) => `已隐去 ${count} 个输入路径`,
  title: "来源证明",
  intro: "Core 记录的此结果来源：机器、代码与输入摘要、产物和检查。命令参数、环境变量值、绝对路径、输出和文件内容不包含在内。",
  previewAttempt: "预览此次尝试",
  previewExport: "预览导出",
  previewRun: "预览整个运行",
  report: "报告预览",
  saveJson: "保存 JSON",
  saveReport: "保存报告",
  close: "关闭",
});
type Text = ReturnType<typeof text>;

/** What the export covers, before anything is saved. */
function scopeText({ manifest }: ProvenanceExport, t: Text) {
  const attempts = manifest.attempts;
  const machines = [...new Set(attempts.map((a) => a.target.machineName || a.target.kind))];
  const artifacts = attempts.reduce((n, a) => n + a.artifacts.files.length, 0);
  const withheld = attempts.reduce((n, a) => n + (a.inputs.withheld || 0), 0);
  return [
    t.attempts(attempts.length),
    t.on(machines.join(", ")),
    t.artifacts(artifacts),
    withheld > 0 && t.withheld(withheld),
  ]
    .filter(Boolean)
    .join(" · ");
}

function save(text: string, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ProvenanceCard({ jobId, runId }: { jobId: string; runId?: string | null }) {
  const t = useStrings(text);
  const [shown, setShown] = useState<ProvenanceExport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function preview(kind: "job" | "run") {
    setBusy(true);
    setError("");
    setShown(null);
    try {
      setShown(await api<ProvenanceExport>(kind === "run" ? `/jobs/runs/${runId}/provenance` : `/jobs/${jobId}/provenance`));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const name = shown && `provenance-${shown.manifest.scope.kind}-${shown.manifest.scope.id.slice(0, 8)}`;
  return (
    <JobCard title={t.title} className="job-provenance">
      <p className="job-footnote">{t.intro}</p>
      <div className="job-run-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void preview("job")}>
          <FileDown size={13} aria-hidden="true" />
          {runId ? t.previewAttempt : t.previewExport}
        </button>
        {runId && (
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void preview("run")}>
            <FileDown size={13} aria-hidden="true" />
            {t.previewRun}
          </button>
        )}
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {shown && name && (
        <div className="job-provenance-preview">
          <p className="job-provenance-scope">{scopeText(shown, t)}</p>
          <pre className="job-provenance-report" tabIndex={0} aria-label={t.report}>
            {shown.report}
          </pre>
          <div className="job-run-actions">
            <button type="button" className="secondary-button" onClick={() => save(JSON.stringify(shown.manifest, null, 2), "application/json", `${name}.json`)}>
              {t.saveJson}
            </button>
            <button type="button" className="secondary-button" onClick={() => save(shown.report, "text/markdown", `${name}.md`)}>
              {t.saveReport}
            </button>
            <button type="button" className="quiet-button" onClick={() => setShown(null)}>
              {t.close}
            </button>
          </div>
        </div>
      )}
    </JobCard>
  );
}
