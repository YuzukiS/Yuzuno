import { Cpu, Folder, Layers } from "lucide-react";
import type { Agent } from "./types";
import { strings, useStrings } from "./i18n";

// The strip's own words (T-189); project, folder, model and effort as they are.
const text = strings({
  label: "Conversation environment",
  project: (name: string) => `Project: ${name}`,
  folder: (cwd: string) => `Working directory: ${cwd}`,
  defaultModel: "Default model",
  model: (model: string, effort: string | null | undefined) => `Model: ${model}${effort ? ` · Reasoning effort: ${effort}` : ""}`,
}, {
  label: "会话环境",
  project: (name) => `项目：${name}`,
  folder: (cwd) => `工作目录：${cwd}`,
  defaultModel: "默认模型",
  model: (model, effort) => `模型：${model}${effort ? ` · 推理强度：${effort}` : ""}`,
});
import "./conversation-metadata.css";

export function ConversationMetadata({
  agent,
  projectName,
}: {
  agent: Agent;
  projectName?: string;
}) {
  const t = useStrings(text);
  const folder =
    agent.cwd.split(/[/\\]/).filter(Boolean).slice(-2).join("/") || agent.cwd;
  const model = agent.model || t.defaultModel;
  // Only Codex turns are sent the saved effort; Claude does not report one
  // and OpenCode's comes from its own configuration.
  const effort =
    agent.harness === "claude" || agent.harness === "opencode" ? null : agent.settings?.reasoningEffort;
  return (
    <div
      className="conversation-metadata"
      aria-label={t.label}
    >
      {projectName && (
        <span title={t.project(projectName)} className="project-chip">
          <Layers size={12} aria-hidden="true" />
          <span>{projectName}</span>
        </span>
      )}
      <span title={t.folder(agent.cwd)}>
        <Folder size={12} aria-hidden="true" />
        <span>{folder}</span>
      </span>
      <span
        title={t.model(model, effort)}
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
