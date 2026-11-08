import { Cpu, Folder, Layers } from "lucide-react";
import type { Agent } from "./types";
import { strings, useStrings } from "./i18n";
import { Tip, TipText } from "./Tip";

// The strip's own words (T-189); project, folder, model and effort as they are.
const text = strings({
  label: "Conversation environment",
  project: "Project",
  folder: "Working directory",
  defaultModel: "Default model",
  model: "Model",
  effort: (effort: string) => `Reasoning effort: ${effort}`,
}, {
  label: "会话环境",
  project: "项目",
  folder: "工作目录",
  defaultModel: "默认模型",
  model: "模型",
  effort: (effort) => `推理强度：${effort}`,
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
      {/* What each one is, and its whole value (YN-44). */}
      {projectName && (
        <Tip side="bottom" content={<TipText label={t.project} title={projectName} />}>
          <span className="project-chip">
            <Layers size={12} aria-hidden="true" />
            <span>{projectName}</span>
          </span>
        </Tip>
      )}
      <Tip side="bottom" content={<TipText label={t.folder} value={agent.cwd} />}>
        <span>
          <Folder size={12} aria-hidden="true" />
          <span>{folder}</span>
        </span>
      </Tip>
      <Tip side="bottom" content={<TipText label={t.model} title={model} status={effort ? t.effort(effort) : null} />}>
        <span>
          <Cpu size={12} aria-hidden="true" />
          <span>
            {model}
            {effort && <span className="model-effort"> · {effort}</span>}
          </span>
        </span>
      </Tip>
    </div>
  );
}
