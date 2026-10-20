import { ArrowUpRight, ChevronRight, FileText } from "lucide-react";
import type { Artifact, NativeTurn } from "./types";
import { groupArtifacts } from "./artifact-groups";
import "./artifacts-panel.css";

function ArtifactList({
  files,
  onOpen,
}: {
  files: Artifact[];
  onOpen: (path: string) => void;
}) {
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
              {file.kind === "image" ? "Image preview" : "Open preview"}
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
  return (
    <section
      className="inspector-section artifacts-panel"
      aria-label="Artifacts"
    >
      <div className="section-title">
        <h2>
          <FileText size={14} />
          Artifacts
        </h2>
        <span title="Files in the latest turn">{latest.length}</span>
      </div>
      <div role="group" aria-label="Latest turn artifacts">
        {latestTurn && <p className="artifact-turn-label">Latest turn</p>}
        {latest.length ? (
          <ArtifactList files={latest} onOpen={onOpen} />
        ) : (
          <p className="artifact-turn-empty">
            {latestTurn
              ? "No files in this turn."
              : "Files from this agent’s work will appear here."}
          </p>
        )}
      </div>
      {history.length > 0 && (
        <details className="artifact-history" key={latestTurn?.id || "no-turn"}>
          <summary>
            <ChevronRight size={13} aria-hidden="true" />
            <span>Earlier files</span>
            <span className="artifact-history-count">{history.length}</span>
          </summary>
          <ArtifactList files={history} onOpen={onOpen} />
        </details>
      )}
    </section>
  );
}
