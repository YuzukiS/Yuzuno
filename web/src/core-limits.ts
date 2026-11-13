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
} satisfies Record<string, CoreLimit>;

/** `text` as Core counts it against `limit`. */
export function measured(text: string, limit: CoreLimit) {
  const sent = limit.trim ? text.trim() : text;
  return limit.unit === "bytes" ? utf8Bytes(sent) : [...sent].length;
}

/** Whether Core refuses `text` for being too long: the form sends nothing. */
export const overLimit = (text: string, limit: CoreLimit) => measured(text, limit) > limit.max;
