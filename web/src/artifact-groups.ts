import type { Artifact, NativeTurn } from "./types";

// Compare native absolute/relative paths without changing the path sent to preview.
function pathKey(path: string, cwd: string) {
  const normalized = path.replaceAll("\\", "/");
  const absolute = /^(\/|[a-z]:\/)/i.test(normalized)
    ? normalized
    : `${cwd.replaceAll("\\", "/")}/${normalized}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

export function groupArtifacts(
  artifacts: Artifact[],
  latestTurn: NativeTurn | undefined,
  cwd: string,
) {
  const itemIds = new Set(latestTurn?.items.map((item) => item.id));
  const paths = new Set<string>();
  for (const item of latestTurn?.items || []) {
    // Core deduplicates by path and keeps the first sourceItemId. A file edited
    // again belongs in the latest turn even when its original source is older.
    if (item.type === "fileChange") {
      for (const change of item.changes || [])
        paths.add(pathKey(change.path, cwd));
    } else if (
      item.type === "claudeToolUse" &&
      item.status === "completed" &&
      ["Write", "Edit", "MultiEdit"].includes(String(item.name))
    ) {
      const input = item.input as { file_path?: unknown } | undefined;
      if (typeof input?.file_path === "string")
        paths.add(pathKey(input.file_path, cwd));
    }
  }
  const latest: Artifact[] = [];
  const history: Artifact[] = [];
  for (const artifact of artifacts) {
    const current =
      (artifact.sourceItemId && itemIds.has(artifact.sourceItemId)) ||
      paths.has(pathKey(artifact.path, cwd));
    (current ? latest : history).push(artifact);
  }
  return { latest, history };
}
