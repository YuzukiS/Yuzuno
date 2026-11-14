/** DeepSeek Harness (dsh), the fourth harness (YN-119 design v1, slice W1):
 * what the web knows of it, and whether this Core offers it. Core runs dsh
 * Agents on its own host only, through dsh's ACP interface (design §3), with
 * a DeepSeek routing key; the web offers dsh only while `/api/workspace`
 * says Core has one it can start (`dsh.available`). */
import { createContext, useContext } from "react";
import { DEFAULT_LEVELS } from "./executor-templates";
import type { Language } from "./i18n";

/** `dsh` of /api/workspace (design §6, S2a): whether Core starts dsh Agents
 * now, the version it found, and its short note of that version (newer than
 * the verified one, a newer line), shown as Core gives it. Absent from a Core
 * without dsh, which offers none. */
export interface DshStatus {
  available: boolean;
  version?: string | null;
  label?: string | null;
}

/** The harness as it is written: the name of its repository, deepseek-ai/deepseek-harness. */
export const DSH_NAME = "DeepSeek Harness";
/** dsh's reasoning efforts, as its DeepSeek provider defines them
 * (deepseek-harness packages/llm/llm-deepseek/src/models.ts; design §1 and
 * §3.9). None chosen leaves it to the provider's default. */
export const DSH_EFFORTS = ["off", "low", "high", "max"] as const;
/** The permission levels dsh keeps (design §3.6): Ask you first, Auto-approve
 * (inside its sandbox as usual, anything beyond it refused) and Full access.
 * Read only is not kept: dsh's sandbox limits no network access. */
export const DSH_LEVELS = ["ask", "auto", "full"] as const;
export type DshLevel = (typeof DSH_LEVELS)[number];
export const isDshLevel = (level: unknown): level is DshLevel => (DSH_LEVELS as readonly unknown[]).includes(level);
/** A level's name in the page's language, as every tool's level is named (DEFAULT_LEVELS). */
export const dshLevelName = (level: DshLevel, language: Language) => {
  const info = DEFAULT_LEVELS.find((l) => l.level === level);
  return info ? (language === "zh-Hans" ? info.labelZh : info.label) : level;
};
/** dsh's built-in DeepSeek models (llm-deepseek/src/models.ts:5-22, design
 * §1): Yuzuno's short list where dsh's own can't be read, its default first
 * (Core's overlay, design §3.2). */
export const DSH_MODEL_HINTS = ["deepseek-flash", "deepseek-v4-pro"];

/** Whether a Core's answer offers dsh: only an explicit yes. */
export const dshAvailable = (status: DshStatus | null | undefined) => status?.available === true;

/** This Core's `dsh`, from the Workspace as the app last read it; null outside
 * the app (and from a Core without dsh). */
export const DshContext = createContext<DshStatus | null>(null);
export const useDsh = () => useContext(DshContext);
