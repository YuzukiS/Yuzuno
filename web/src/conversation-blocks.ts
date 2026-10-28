import { isSubAgentCall, subAgentCalls } from "./claude-subagents.ts";
import type { NativeItem, NativeTurn } from "./types";
import type { Language } from "./i18n.ts";

export type ConversationBlock =
  | { kind: "user" | "message" | "preview"; item: NativeItem }
  /** `calls`: calls of Claude sub-agents started in this block, shown under
   *  their Agent call rather than as the Turn's own tools. */
  | { kind: "tools"; items: NativeItem[]; calls?: NativeItem[] }
  /** A Turn's Codex sub-agent activity, gathered where the first appears. */
  | { kind: "subagents"; items: NativeItem[] };

/** Every Item a block holds, its sub-agents' calls included: what a source
 *  link or a pending approval may name. */
export function blockItems(block: ConversationBlock): readonly NativeItem[] {
  if ("item" in block) return [block.item];
  return block.kind === "tools" && block.calls ? [...block.items, ...block.calls] : block.items;
}

/** The block's shown Item that `itemId` names: itself, or the Agent call
 *  whose sub-agent made that call (for a nested one, the outermost). */
export function shownItemId(block: ConversationBlock, itemId: string | undefined): string | undefined {
  if (!itemId) return undefined;
  if ("item" in block) return block.item.id === itemId ? itemId : undefined;
  if (block.items.some((item) => item.id === itemId)) return itemId;
  if (block.kind !== "tools" || !block.calls) return undefined;
  const calls = new Map(block.calls.map((call) => [call.id, call]));
  let id = itemId;
  for (let hops = 0; calls.has(id) && hops <= calls.size; hops++) id = calls.get(id)!.parentToolUseId as string;
  return id !== itemId && block.items.some((item) => item.id === id) ? id : undefined;
}

export function hasAgentContent(item: NativeItem): boolean {
  // Codex can emit reasoning lifecycle items without a public summary.
  // Empty placeholders should not create blank cards or tool counts.
  if (item.type === "reasoning")
    return !!item.summary?.some((part) => part.trim());
  return (
    item.type !== "userMessage" &&
    (item.type !== "agentMessage" ||
      !!item.text?.trim() ||
      !!item.questions?.length)
  );
}

/** Native item order also includes user input appended while a turn is running. */
export function conversationBlocks(
  items: readonly NativeItem[],
): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let subagents: NativeItem[] | undefined;
  const owned = new Set([...subAgentCalls(items).values()].flat().map((item) => item.id));
  // The tools block holding each sub-agent's Agent call (nested ones: the
  // outermost call's).
  const blockOf = new Map<string, NativeItem[]>();
  for (const item of items) {
    if (owned.has(item.id)) {
      const calls = blockOf.get(item.parentToolUseId as string);
      calls?.push(item);
      if (calls && isSubAgentCall(item)) blockOf.set(item.id, calls);
    } else if (item.type === "historyPreview") {
      blocks.push({ kind: "preview", item });
    } else if (item.type === "subAgentActivity") {
      if (subagents) subagents.push(item);
      else blocks.push({ kind: "subagents", items: (subagents = [item]) });
    } else if (item.type === "userMessage") {
      blocks.push({ kind: "user", item });
    } else if (item.type === "exitedReviewMode") {
      // Codex's review findings are its review Turn's reply.
      blocks.push({ kind: "message", item: { ...item, text: item.review ?? "" } });
    } else if (hasAgentContent(item)) {
      if (item.type === "agentMessage") {
        blocks.push({ kind: "message", item });
      } else {
        const previous = blocks.at(-1);
        const block: Extract<ConversationBlock, { kind: "tools" }> =
          previous?.kind === "tools" ? previous : { kind: "tools", items: [] };
        if (block !== previous) blocks.push(block);
        block.items.push(item);
        if (isSubAgentCall(item)) blockOf.set(item.id, (block.calls ??= []));
      }
    }
  }
  return blocks;
}

export function isCompacting(turn: NativeTurn): boolean {
  return /inProgress|running/.test(turn.status) && !!turn._yuzunoCompactionId;
}

const activityNames: Record<string, string> = {
  commandExecution: "Shell",
  fileChange: "Edit",
  webSearch: "Web search",
  imageView: "View image",
  imageGeneration: "Generate image",
  reasoning: "Reasoning",
  contextCompaction: "Compaction",
  enteredReviewMode: "Review",
  plan: "Proposed plan",
  mcpToolCall: "MCP tool",
};
// In Chinese (T-189); a tool's own name stays as the harness gives it.
const activityNamesZh: Record<string, string> = {
  commandExecution: "Shell",
  fileChange: "编辑",
  webSearch: "网页搜索",
  imageView: "查看图片",
  imageGeneration: "生成图片",
  reasoning: "推理",
  contextCompaction: "压缩",
  enteredReviewMode: "审查",
  plan: "提议的计划",
  mcpToolCall: "MCP 工具",
};

/**
 * The tool a call names, as its harness names it: an MCP call's server and
 * tool ("yuzuno/task_get"), or a tool's own name. Empty when it names none.
 */
function toolName(item: NativeItem): { namespace: string; name: string } {
  const name = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : "";
  const namespace = typeof item.server === "string" ? item.server : typeof item.namespace === "string" ? item.namespace : "";
  return { namespace, name };
}

/**
 * What a tool call is called, in a row of its own and in its group's
 * summary alike: the tool it names, else the kind of call.
 */
export function toolLabel(item: NativeItem, language: Language = "en"): { label: string; named: boolean } {
  const { namespace, name } = toolName(item);
  if (name) return { label: [namespace, name].filter(Boolean).join("/"), named: true };
  const names = language === "zh-Hans" ? activityNamesZh : activityNames;
  return {
    label: names[item.type] || item.type.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()),
    named: false,
  };
}

/** Count native calls, not output chunks or files touched by a single edit. */
export function toolActivityCounts(items: readonly NativeItem[], language: Language = "en") {
  const counts = new Map<
    string,
    { key: string; label: string; count: number }
  >();
  const seen = new Set<string>();
  for (const item of items) {
    if (
      seen.has(item.id) ||
      ["userMessage", "agentMessage"].includes(item.type)
    )
      continue;
    seen.add(item.id);
    const { namespace, name } = toolName(item);
    const { label } = toolLabel(item, language);
    const key = JSON.stringify([item.type, namespace, name]);
    const previous = counts.get(key);
    if (previous) previous.count++;
    else counts.set(key, { key, label, count: 1 });
  }
  return [...counts.values()];
}
