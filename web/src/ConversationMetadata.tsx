import { Cpu, Folder, Layers } from "lucide-react";
import type { Agent } from "./types";
import "./conversation-metadata.css";

export function ConversationMetadata({
  agent,
  projectName,
}: {
  agent: Agent;
  projectName?: string;
}) {
  const folder =
    agent.cwd.split(/[/\\]/).filter(Boolean).slice(-2).join("/") || agent.cwd;
  const model = agent.model || "Default model";
  // Only Codex turns are sent the saved effort; Claude does not report one.
  const effort =
    agent.harness === "claude" ? null : agent.settings?.reasoningEffort;
  return (
    <div
      className="conversation-metadata"
      aria-label="Conversation environment"
    >
      {projectName && (
        <span title={`Project: ${projectName}`} className="project-chip">
          <Layers size={12} aria-hidden="true" />
          <span>{projectName}</span>
        </span>
      )}
      <span title={`Working directory: ${agent.cwd}`}>
        <Folder size={12} aria-hidden="true" />
        <span>{folder}</span>
      </span>
      <span
        title={`Model: ${model}${effort ? ` · Reasoning effort: ${effort}` : ""}`}
      >
        <Cpu size={12} aria-hidden="true" />
        <span>
          {model}
          {effort && <span className="model-effort"> · {effort}</span>}
        </span>
      </span>
    </div>
  );
}
