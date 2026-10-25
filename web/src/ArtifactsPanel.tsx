import { ArrowUpRight, ChevronRight, FileText } from "lucide-react";
import type { Artifact, NativeTurn } from "./types";
import { groupArtifacts } from "./artifact-groups";
import { strings, useStrings } from "./i18n";
import "./artifacts-panel.css";

// The panel's own words (T-189); file names and paths as they are.
const text = strings({
  imagePreview: "Image preview",
  openPreview: "Open preview",
  artifacts: "Artifacts",
  inLatest: "Files in the latest turn",
  latestGroup: "Latest turn artifacts",
  latest: "Latest turn",
  noFiles: "No files in this turn.",
  willAppear: "Files from this agent’s work will appear here.",
  earlier: "Earlier files",
}, {
  imagePreview: "图片预览",
  openPreview: "打开预览",
  artifacts: "产出文件",
  inLatest: "最近一个 Turn 中的文件",
  latestGroup: "最近一个 Turn 的产出文件",
  latest: "最近一个 Turn",
  noFiles: "这个 Turn 中没有文件。",
  willAppear: "此 Agent 工作产生的文件会显示在这里。",
  earlier: "更早的文件",
});

function ArtifactList({
  files,
  onOpen,
}: {
  files: Artifact[];
  onOpen: (path: string) => void;
}) {
  const t = useStrings(text);
  return (
    <div className="artifact-list">
      {files.map((file) => (
        <button
          key={file.path}
          type="button"
          className="artifact-row"
          title={file.path}
          onClick={() => onOpen(file.path)}
        >
          <span className="file-icon">
            <FileText size={17} />
          </span>
          <span>
            <strong>{file.name}</strong>
            <small>
              {file.kind === "image" ? t.imagePreview : t.openPreview}
            </small>
          </span>
          <ArrowUpRight size={13} />
        </button>
      ))}
    </div>
  );
}

export function ArtifactsPanel({
  artifacts,
  latestTurn,
  cwd,
  onOpen,
}: {
  artifacts: Artifact[];
  latestTurn?: NativeTurn;
  cwd: string;
  onOpen: (path: string) => void;
}) {
  const { latest, history } = groupArtifacts(artifacts, latestTurn, cwd);
  const t = useStrings(text);
  return (
    <section
      className="inspector-section artifacts-panel"
      aria-label={t.artifacts}
    >
      <div className="section-title">
        <h2>
          <FileText size={14} />
          {t.artifacts}
        </h2>
        <span title={t.inLatest}>{latest.length}</span>
      </div>
      <div role="group" aria-label={t.latestGroup}>
        {latestTurn && <p className="artifact-turn-label">{t.latest}</p>}
        {latest.length ? (
          <ArtifactList files={latest} onOpen={onOpen} />
        ) : (
          <p className="artifact-turn-empty">
            {latestTurn ? t.noFiles : t.willAppear}
          </p>
        )}
      </div>
      {history.length > 0 && (
        <details className="artifact-history" key={latestTurn?.id || "no-turn"}>
          <summary>
            <ChevronRight size={13} aria-hidden="true" />
            <span>{t.earlier}</span>
            <span className="artifact-history-count">{history.length}</span>
          </summary>
          <ArtifactList files={history} onOpen={onOpen} />
        </details>
      )}
    </section>
  );
}
