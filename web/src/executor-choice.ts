// How `auto` chose an executor's machine (T-35 S3b), as a task card shows
// it: the machine's name for the chip, and for its title each candidate's
// numbers or why it was left out, read from Core's record alone
// (`executorSlot.choice`). Both task card chips call it: today's slot chip
// and T-36's lifecycle chip.
import { strings, type Language } from "./i18n";

type Resources = { cpuMillis: number; memoryMiB: number };
/** One machine `auto` weighed, in the order Core ranked them. */
export type ChoiceCandidate = {
  machine: string;
  name?: string;
  freeSlot?: boolean;
  executors?: number;
  limit?: number | null;
  budget?: Resources | null;
  reserved?: Resources;
  spare?: Resources;
  /** Why it could not run this executor; then it has no numbers. */
  excluded?: string;
};
export type ExecutorChoice = { requested?: string; chosen: string; candidates?: ChoiceCandidate[] };

const cpus = (millis: number) => `${Number((millis / 1000).toFixed(2))}`;

const text = strings({
  chosen: (name: string) => `${name} (chosen automatically)`,
  heading: "Chosen automatically. The machines in the order Core weighed them:",
  slot: (free: boolean, executors: number, limit: number | null) =>
    `${free ? "a free executor slot" : "no free executor slot"} (${executors} running, ${limit === null ? "no limit of its own" : `limit ${limit}`})`,
  spare: (spare: Resources, budget: Resources) =>
    `${spare.memoryMiB} of ${budget.memoryMiB} MiB and ${cpus(spare.cpuMillis)} of ${cpus(budget.cpuMillis)} CPUs spare in its Jobs budget`,
  noBudget: "no Jobs budget",
  excluded: (why: string) => `left out: ${why}`,
  line: (name: string, detail: string) => `${name}: ${detail}`,
  both: (slot: string, room: string) => `${slot}; ${room}`,
}, {
  chosen: (name) => `${name}（自动选择）`,
  heading: "自动选择。Core 依次比较的机器：",
  slot: (free, executors, limit) =>
    `${free ? "有空闲执行者槽位" : "没有空闲执行者槽位"}（${executors} 个运行中，${limit === null ? "没有自己的上限" : `上限 ${limit}`}）`,
  spare: (spare, budget) =>
    `Job 预算中剩余内存 ${spare.memoryMiB} / ${budget.memoryMiB} MiB、CPU ${cpus(spare.cpuMillis)} / ${cpus(budget.cpuMillis)}`,
  noBudget: "没有 Job 预算",
  excluded: (why) => `未选：${why}`,
  line: (name, detail) => `${name}：${detail}`,
  both: (slot, room) => `${slot}；${room}`,
});

/** The chip's words for the machine `auto` chose, and its title; nothing
 * without a choice, so a chip then reads as it did. */
export function executorChoiceText(choice: ExecutorChoice | null | undefined, language: Language): { text: string; title: string } | null {
  if (!choice || typeof choice.chosen !== "string") return null;
  const t = text(language);
  const candidates = Array.isArray(choice.candidates) ? choice.candidates : [];
  const name = (c: ChoiceCandidate) => c.name || c.machine;
  const chosen = candidates.find((c) => c.machine === choice.chosen);
  const lines = candidates.map((c) => {
    if (c.excluded) return t.line(name(c), t.excluded(c.excluded));
    const slot = t.slot(c.freeSlot === true, c.executors ?? 0, c.limit ?? null);
    const room = c.budget && c.spare ? t.spare(c.spare, c.budget) : t.noBudget;
    return t.line(name(c), t.both(slot, room));
  });
  return { text: t.chosen(chosen ? name(chosen) : choice.chosen), title: [t.heading, ...lines].join("\n") };
}
