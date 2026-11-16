import { utf8Bytes } from "./home/reply-limit";

/**
 * The most Core takes in a field the page writes (YN-106), in the unit Core
 * counts: UTF-8 bytes, as Rust's `str::len` (a Chinese character is 3), or
 * characters, as `chars().count()`. `trim`: the page sends the text trimmed,
 * so that is what is counted; otherwise it goes as written. A field keeps no
 * limit of its own, so a paste is never cut short: what is over says so and
 * the form does not send it. tools/core-limits.test.mjs reads each number
 * from the Rust line named beside it.
 */
export type CoreLimit = { max: number; unit: "bytes" | "chars"; trim: boolean };

const bytes = (max: number, trim = true): CoreLimit => ({ max, unit: "bytes", trim });

export const coreLimits = {
  /** core/src/collaboration_store.rs `MAX_DESCRIPTION`. */
  taskDescription: bytes(32_768),
  /** collaboration_store.rs, task_submit_result: `required_text(input, "summary", …)`. */
  resultSummary: bytes(16_384),
  /** collaboration_store/dispatch_materials.rs: `optional_text(input, "body", …)`. */
  dispatchNote: bytes(16_384),
  /** collaboration_store.rs, task_comment: `required_text(input, "body", …)`. */
  taskComment: bytes(16_384),
  /** collaboration_store.rs, task_update: `optional_text(patch, "progress", …)`. */
  taskProgress: bytes(8_192),
  /** collaboration_store.rs, task_update: `optional_text(patch, "blocker", …)`. */
  taskBlocker: bytes(8_192),
  /** collaboration_store/result_outcome.rs: `required_text(criterion, "report", …)`;
   * a result's report goes as written (task-outcome.ts outcomeInput). */
  criterionReport: bytes(4000, false),
  /** result_outcome.rs: `("remaining", …)`. */
  outcomeRemaining: bytes(8000, false),
  /** result_outcome.rs: `("nextStep", …)`. */
  outcomeNextStep: bytes(4000, false),
  /** core/src/model.rs, ReviewTarget::checked: custom instructions, trimmed there too. */
  reviewInstructions: bytes(100_000),
  /** core/src/codex_goal.rs `MAX_OBJECTIVE_CHARS`: Codex's own limit, in characters, trimmed there too. */
  goalObjective: { max: 4_000, unit: "chars", trim: true },
  /** core/src/pr_operations/mod.rs: a PR's body, sent as written. */
  prBody: bytes(60_000, false),
  // One-line fields (YN-106 PR 3): a name or a title Core counts in bytes.
  /** collaboration_store.rs `MAX_TITLE`: a task's title. */
  taskTitle: bytes(300),
  /** result_outcome.rs: `required_text(criterion, "label", …)`; sent as written. */
  criterionLabel: bytes(300, false),
  /** pr_operations/mod.rs: `self.title.len() <= …`; sent as written. */
  prTitle: bytes(256, false),
  /** pr_operations/mod.rs `fn branch`: `s.len() <= …`; a base or head branch, sent as written. */
  prBranch: bytes(240, false),
  /** model.rs, ReviewTarget::checked `fn name`: a base branch or a commit to review. */
  reviewName: bytes(256),
  /** jobs/mod.rs `validate_command`: a Job's name. */
  jobName: bytes(160),
  /** jobs/gpu.rs: why a GPU is closed to new Jobs. */
  gpuReason: bytes(200),
  /** model.rs `AGENT_NAME_MAX`: an Agent's name, as a rename and every way
   * of making one check it (`agent_name`, YN-112). */
  agentName: bytes(100),
  /** remote.rs `validate_machine`: a machine's name. */
  machineName: bytes(128),
  /** projects.rs `validate_name`: a project's name. */
  projectName: bytes(100),
  /** services.rs: a service's name. */
  serviceName: bytes(80),
  /** merge_queue/mod.rs, merge_revert: a reason (its MCP schema says the same of the other three). */
  mergeReason: bytes(2000),
} satisfies Record<string, CoreLimit>;

/** `text` as Core counts it against `limit`. */
export function measured(text: string, limit: CoreLimit) {
  const sent = limit.trim ? text.trim() : text;
  return limit.unit === "bytes" ? utf8Bytes(sent) : [...sent].length;
}

/** Whether Core refuses `text` for being too long: the form sends nothing. */
export const overLimit = (text: string, limit: CoreLimit) => measured(text, limit) > limit.max;
