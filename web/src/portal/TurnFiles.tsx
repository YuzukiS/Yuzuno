import { FileCode2 } from "lucide-react";
import { strings, useStrings } from "../i18n";
import type { Agent, NativeTurn } from "../types";
import { OpenChoice } from "./OpenChoice";
import { htmlFile } from "./html-file";

const text = strings({
  prototype: "Interactive prototype · one file",
  from: (agent: string) => `${agent}'s conversation file`,
  files: "Prototypes from this turn",
}, {
  prototype: "交互原型 · 单个文件",
  from: (agent) => `${agent} 的会话文件`,
  files: "这个 Turn 产出的原型",
});

/** The HTML files a Turn wrote (its file changes, deletions aside), once. */
export function turnHtmlFiles(turn: NativeTurn): string[] {
  const paths = new Set<string>();
  for (const item of turn.items)
    if (item.type === "fileChange")
      for (const change of item.changes || [])
        if (change.kind?.type !== "delete" && htmlFile(change.path)) paths.add(change.path);
  return [...paths];
}

/**
 * Each single HTML file a finished Turn wrote, as a card to open it working
 * in the Portal (or the browser), or to read its source (T-5).
 */
export function TurnFiles({ agent, turn, onSource }: { agent: Agent; turn: NativeTurn; onSource: (path: string) => void }) {
  const t = useStrings(text);
  const files = turnHtmlFiles(turn);
  if (!files.length) return null;
  return (
    <ul className="turn-files" aria-label={t.files}>
      {files.map((path) => {
        const name = path.split(/[\\/]/).pop() || path;
        return (
          <li key={path} className="turn-file">
            <span className="turn-file-icon" aria-hidden="true"><FileCode2 size={17} /></span>
            <span className="turn-file-meta">
              <strong title={path}>{name}</strong>
              <small>{t.prototype}</small>
            </span>
            <OpenChoice
              target={() => ({ kind: "snapshot", source: { kind: "artifact", agentId: agent.id, path }, name, from: t.from(agent.name) })}
              onSource={() => onSource(path)}
            />
          </li>
        );
      })}
    </ul>
  );
}
