import type { SkillRef } from "./types";

/** Enough of a Codex skill's path to tell two skills of one name apart:
 * the folders just above its file, as written on the Agent's machine. */
export function pathTail(path: string) {
  return path.split(/[\\/]/).filter(Boolean).slice(-3, -1).join("/");
}

/** The skills a native user message invoked: its typed `skill` parts. */
export function messageSkills(content: readonly { type: string; name?: unknown; path?: unknown }[] | undefined): SkillRef[] {
  return (content || []).flatMap((part) =>
    part.type === "skill" && typeof part.name === "string" && typeof part.path === "string" ? [{ name: part.name, path: part.path }] : [],
  );
}
