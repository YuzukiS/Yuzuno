import type { AgentDetail, NativeItem, TruncatedField } from "./types";
import type { DetailEvent } from "./workspace-events.ts";

function replaceAt<T>(list: T[], index: number, value: T): T[] {
  const next = list.slice();
  next[index] = value;
  return next;
}

/** Core's client projection limits (core/src/client_view.rs): a string over
 * TRIM_ABOVE UTF-8 bytes is sent as a preview of at most PREVIEW bytes. */
export const TRIM_ABOVE = 8 * 1024;
export const PREVIEW = 4 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8 = (text: string) => encoder.encode(text).length;
const lineCount = (text: string) =>
  (text.match(/\n/g)?.length ?? 0) + (text && !text.endsWith("\n") ? 1 : 0);

/** The end of `text` within `limit` UTF-8 bytes, cut as client_view's tail
 * preview is: on a character boundary, and after a newline near the start. */
export function tailPreview(text: string, limit = PREVIEW) {
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return text;
  let start = bytes.length - limit;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  let tail = bytes.subarray(start);
  const newline = tail.indexOf(10);
  if (newline >= 0 && newline < Math.floor(limit / 4)) tail = tail.subarray(newline + 1);
  return decoder.decode(tail);
}

/** A field Core sends as a tail preview once it is large; the only one
 * streamed output appends to (Codex command output). Items a pending
 * request refers to are sent whole (client_view::referenced). */
function previewedOutput(detail: AgentDetail, item: NativeItem, field: string) {
  return (
    item.type === "commandExecution" &&
    field === "aggregatedOutput" &&
    !detail.pending.some(
      (request) => request.params?.itemId === item.id || request.params?.toolUseId === item.id,
    )
  );
}

/**
 * Text appended to an Item's string field, kept as Core's projection keeps
 * it: a field that is (or now becomes) a tail preview stays one, at most
 * PREVIEW bytes, with `_yuzunoTruncated` counting the full size and lines.
 * The full value, when expanded (item-payload.ts), grows from exactly that
 * preview and count, so nothing is applied twice. Null: not placeable.
 */
function appendText(detail: AgentDetail, item: NativeItem, field: string, text: string): NativeItem | null {
  const value = item[field];
  if (value != null && typeof value !== "string") return null;
  const before = value ?? "";
  const trimmed = item._yuzunoTruncated?.[field];
  if (trimmed) {
    // A head preview cannot take an append; only a read shows it.
    if (trimmed.keep !== "tail") return null;
    const full: TruncatedField = {
      ...trimmed,
      bytes: trimmed.bytes + utf8(text),
      // The preview ends where the full value ends.
      lines:
        (trimmed.lines ?? lineCount(before)) -
        (before && !before.endsWith("\n") ? 1 : 0) +
        (text.match(/\n/g)?.length ?? 0) +
        (before + text && !(before + text).endsWith("\n") ? 1 : 0),
    };
    return {
      ...item,
      [field]: tailPreview(before + text),
      _yuzunoTruncated: { ...item._yuzunoTruncated, [field]: full },
    };
  }
  const next = before + text;
  // A string can exceed TRIM_ABOVE bytes only past a third as many units.
  if (previewedOutput(detail, item, field) && next.length * 3 > TRIM_ABOVE) {
    const bytes = utf8(next);
    const preview = tailPreview(next);
    // As client_view: trimmed when large and the preview leaves out at least half.
    if (bytes > TRIM_ABOVE && utf8(preview) * 2 <= bytes)
      return {
        ...item,
        [field]: preview,
        _yuzunoTruncated: {
          ...item._yuzunoTruncated,
          [field]: { bytes, lines: lineCount(next), keep: "tail" },
        },
      };
  }
  return { ...item, [field]: next };
}

/**
 * The detail with one streamed change applied, as Core applied it to its own
 * record and projects it for clients; or null when this copy cannot take it
 * (its Turn or Item is not here, or the field is not text). The caller then
 * refetches the detail.
 *
 * Never mutates its input. Turns and Items the change does not touch keep
 * their identity, so only what changed renders again. `agent.lastSeq` is
 * left alone: what has been applied is tracked by the caller.
 */
export function patchDetail(
  detail: AgentDetail,
  event: DetailEvent,
): AgentDetail | null {
  if (event.type === "agent.context") {
    const next = { ...detail };
    if ("contextUsage" in event) next.contextUsage = event.contextUsage ?? null;
    if ("claudeRuntime" in event) next.claudeRuntime = event.claudeRuntime ?? null;
    return next;
  }
  // A body outside the reading window stays unloaded. Artifact metadata is
  // independent of that body and must still reach the inspector.
  const outsideWindow = () => !detail.conversation?.hasAfter ? null
    : event.type === "agent.item" && event.artifacts ? { ...detail, artifacts: event.artifacts } : detail;
  // A running sub-agent's or background task's call listed from outside the
  // window: placed here it would be out of order, and its listing must not
  // go stale.
  if (event.type === "agent.item" && [detail.conversation?.runningSubAgents, detail.conversation?.runningBackgroundTasks]
    .some((listed) => listed?.some((entry) => entry.turnId === event.turnId && entry.item.id === event.item.id))) return null;
  const index = detail.turns.findIndex((turn) => turn.id === event.turnId);
  if (index < 0) return outsideWindow();
  const turn = detail.turns[index];
  let items: NativeItem[];
  if (event.type === "agent.item") {
    const at = turn.items.findIndex((item) => item.id === event.item.id);
    if (at < 0 && detail.conversation?.hasAfter) return outsideWindow();
    const previous = at < 0 ? undefined : turn.items[at];
    // Mailbox provenance is added per request by Core, not stored in Items.
    let item =
      previous?._yuzunoSource && !event.item._yuzunoSource
        ? { ...event.item, _yuzunoSource: previous._yuzunoSource }
        : event.item;
    if (previous?._yuzunoMailbox && !item._yuzunoMailbox)
      item = { ...item, _yuzunoMailbox: previous._yuzunoMailbox };
    items = at < 0 ? [...turn.items, item] : replaceAt(turn.items, at, item);
  } else {
    const at = turn.items.findIndex((item) => item.id === event.itemId);
    if (at < 0) return outsideWindow();
    const item = turn.items[at];
    if (item.type === "historyPreview") return null;
    let next: NativeItem | null;
    if (event.index === undefined) {
      next = appendText(detail, item, event.field, event.text);
    } else {
      const value = item[event.field];
      if (value != null && !Array.isArray(value)) return null;
      const parts = [...((value as unknown[] | null | undefined) ?? [])];
      while (parts.length <= event.index) parts.push("");
      const part = parts[event.index];
      if (typeof part !== "string") return null;
      parts[event.index] = part + event.text;
      next = { ...item, [event.field]: parts };
    }
    if (!next) return null;
    items = replaceAt(turn.items, at, next);
  }
  if (detail.conversation) {
    // A long live Turn must obey the same bounds as a fresh window. Refetch
    // replaces its oldest rows, with the server's stable cursors and index.
    if (detail.turns.reduce((n, t) => n + (t === turn ? items.length : t.items.length), 0) > 96) return null;
    let total = 0;
    for (const row of detail.turns) for (const item of row === turn ? items : row.items) {
      const size = utf8(JSON.stringify(item));
      if (size > 32 * 1024 || (total += size) > 256 * 1024) return null;
    }
  }
  const patched: AgentDetail = {
    ...detail,
    turns: replaceAt(detail.turns, index, { ...turn, items }),
  };
  if (event.type === "agent.item" && event.artifacts)
    patched.artifacts = event.artifacts;
  return patched;
}
