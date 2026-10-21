// Where a result came from, as Core recorded it (T-168): one Job, or its
// whole run, exported as a JSON manifest and a short report. Core builds both
// from its records; this previews them and saves exactly what was previewed.
// It fetches no artifact: each stays where it was checked, and a local one
// downloads from its run's artifact list after Core checks it again.
import { useState } from "react";
import { FileDown } from "lucide-react";
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

/** What the export covers, before anything is saved. */
function scopeText({ manifest }: ProvenanceExport) {
  const attempts = manifest.attempts;
  const machines = [...new Set(attempts.map((a) => a.target.machineName || a.target.kind))];
  const artifacts = attempts.reduce((n, a) => n + a.artifacts.files.length, 0);
  const withheld = attempts.reduce((n, a) => n + (a.inputs.withheld || 0), 0);
  return [
    plural(attempts.length, "attempt"),
    `on ${machines.join(", ") || "no machine"}`,
    plural(artifacts, "artifact reference"),
    withheld > 0 && `${plural(withheld, "input path")} withheld`,
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
    <JobCard title="Provenance" className="job-provenance">
      <p className="job-footnote">
        What Core recorded about where this result came from: machine, code and input digests, artifacts and checks.
        Command arguments, environment values, absolute paths, output and file contents are left out.
      </p>
      <div className="job-run-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void preview("job")}>
          <FileDown size={13} aria-hidden="true" />
          {runId ? "Preview this attempt" : "Preview export"}
        </button>
        {runId && (
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void preview("run")}>
            <FileDown size={13} aria-hidden="true" />
            Preview whole run
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
          <p className="job-provenance-scope">{scopeText(shown)}</p>
          <pre className="job-provenance-report" tabIndex={0} aria-label="Report preview">
            {shown.report}
          </pre>
          <div className="job-run-actions">
            <button type="button" className="secondary-button" onClick={() => save(JSON.stringify(shown.manifest, null, 2), "application/json", `${name}.json`)}>
              Save JSON
            </button>
            <button type="button" className="secondary-button" onClick={() => save(shown.report, "text/markdown", `${name}.md`)}>
              Save report
            </button>
            <button type="button" className="quiet-button" onClick={() => setShown(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </JobCard>
  );
}
