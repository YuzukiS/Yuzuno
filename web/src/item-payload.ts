import { useEffect, useReducer, useState } from "react";
import { api, errorText } from "./api";
import type { NativeItem, NativeTurn, TruncatedField } from "./types";

// Core sends large tool fields as previews (see core/src/client_view.rs) and
// returns the full values on request. What the user expanded stays expanded
// for this session. A running Item keeps growing: the part of each new
// preview that arrived after the full value is appended to it, so nothing
// is fetched again until the Item finishes or more arrived than a preview
// holds (then at most every few seconds).

type Fields = Record<string, unknown>;
interface Entry {
  fields: Fields;
  /** Size of each field as Core reports it: a string's UTF-8 length (measured
   * here), else the size its preview reported when this was read. */
  bytes: Record<string, number>;
  /** The snapshot's Item status when these were requested. A full value can
   * be newer than the snapshot; only a change in the snapshot means more. */
  status: string | null;
  /** Approximate memory held, in UTF-16 code units. */
  size: number;
  fetchedAt: number;
}

/** Limits, adjustable by tests. */
export const payloadLimits = {
  /** Full values kept for rows not on screen: about 32 MB. */
  keepChars: 16 * 1024 * 1024,
  /** Expanded rows remembered. */
  keepExpanded: 500,
  /** A running Item is fetched in full again at most this often. */
  runningRefetchMs: 5000,
};

const loaded = new Map<string, Entry>();
const expanded = new Set<string>();
/** Expanded rows on screen, which are never evicted. */
const onScreen = new Map<string, number>();
const inflight = new Map<string, Promise<Entry>>();

const keyOf = (agentId: string, turnId: string, itemId: string) => [agentId, turnId, itemId].join("\u0000");
const path = (part: string) => encodeURIComponent(part);
const encoder = new TextEncoder();

function utf8Length(text: string) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** The last `count` UTF-8 bytes of `text`, or null if that splits a character. */
function lastBytes(text: string, count: number) {
  const bytes = encoder.encode(text);
  if (count > bytes.length) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(bytes.length - count));
  } catch {
    return null;
  }
}

function entryOf(fields: Fields, item: NativeItem): Entry {
  const bytes: Record<string, number> = {};
  let size = 0;
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === "string") {
      bytes[name] = utf8Length(value);
      size += value.length;
    } else {
      const reported = item._yuzunoTruncated?.[name]?.bytes;
      if (reported !== undefined) bytes[name] = reported;
      size += JSON.stringify(value ?? null).length;
    }
  }
  return { fields, bytes, status: item.status ?? null, size, fetchedAt: Date.now() };
}

function remember(key: string, entry: Entry) {
  loaded.delete(key);
  loaded.set(key, entry);
  let total = 0;
  for (const value of loaded.values()) total += value.size;
  for (const [oldest, value] of loaded) {
    if (total <= payloadLimits.keepChars) break;
    if (oldest === key || onScreen.has(oldest)) continue;
    loaded.delete(oldest);
    total -= value.size;
  }
}

function markExpanded(key: string) {
  expanded.delete(key);
  expanded.add(key);
  for (const oldest of expanded) {
    if (expanded.size <= payloadLimits.keepExpanded) break;
    if (!onScreen.has(oldest)) expanded.delete(oldest);
  }
}

export function isTruncated(item: NativeItem) {
  return !!item._yuzunoTruncated && Object.keys(item._yuzunoTruncated).length > 0;
}

/** The Item with these full values in place of their previews. */
export function withFullFields(item: NativeItem, fields?: Fields): NativeItem {
  if (!fields) return item;
  const rest = Object.entries(item._yuzunoTruncated || {}).filter(([name]) => !(name in fields));
  return {
    ...item,
    ...fields,
    _yuzunoTruncated: rest.length ? Object.fromEntries(rest) : undefined,
  };
}

/** The newest values to show for an Item: the full ones, extended by the
 * part of the current preview that arrived after them. `stale` means the
 * full values must be read again (the Item finished, or a gap opened). */
function newest(entry: Entry, item: NativeItem): { fields: Fields; bytes: Record<string, number>; stale: boolean } {
  const fields = { ...entry.fields };
  const bytes = { ...entry.bytes };
  let stale = entry.status !== (item.status ?? null);
  for (const [name, info] of Object.entries(item._yuzunoTruncated || {})) {
    const full = entry.fields[name];
    const preview = item[name];
    if (!(name in entry.fields)) {
      stale = true;
      continue;
    }
    const known = entry.bytes[name];
    if (info.bytes === known) continue;
    if (typeof full === "string" && typeof preview === "string" && info.keep === "tail" && known !== undefined) {
      if (info.bytes < known) continue; // The full value is newer than this preview.
      const added = lastBytes(preview, info.bytes - known);
      if (added !== null) {
        fields[name] = full + added;
        bytes[name] = info.bytes;
        continue;
      }
      // More arrived than the preview holds: show the gap, never older text.
      const missing = info.bytes - known - utf8Length(preview);
      fields[name] = `${full}\n[… ${formatBytes(Math.max(missing, 0))} not loaded yet …]\n${preview}`;
      stale = true;
      continue;
    }
    // Changed some other way: the preview is the newer value.
    fields[name] = preview;
    stale = true;
  }
  return { fields, bytes, stale };
}

/** Full values of the Item's trimmed fields, read once however many ask. */
function fetchEntry(agentId: string, turnId: string, item: NativeItem): Promise<Entry> {
  const key = keyOf(agentId, turnId, item.id);
  let request = inflight.get(key);
  if (!request) {
    const fields = Object.keys(item._yuzunoTruncated || {}).join(",");
    request = api<{ fields: Fields }>(
      `/agents/${path(agentId)}/items/${path(item.id)}/payload?${new URLSearchParams({ turnId, field: fields })}`,
    )
      .then(({ fields }) => {
        const entry = entryOf(fields, item);
        remember(key, entry);
        return entry;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, request);
  }
  return request;
}

/** The Turn with every trimmed field in full. Items the Turn request does
 * not cover are read one by one; if any still cannot be read, this fails
 * rather than copy a preview as if it were the whole text. */
export async function fullTurn(agentId: string, turn: NativeTurn): Promise<NativeTurn> {
  if (turn._yuzunoSlice || turn.items.some(item => item.type === "historyPreview"))
    return api<NativeTurn>(`/agents/${path(agentId)}/turns/${path(turn.id)}/original`);
  const trimmed = turn.items.filter(isTruncated);
  if (!trimmed.length) return turn;
  const full = new Map<string, Fields>();
  const missing = trimmed.filter((item) => {
    const entry = loaded.get(keyOf(agentId, turn.id, item.id));
    const view = entry && newest(entry, item);
    if (view && !view.stale) full.set(item.id, view.fields);
    return !full.has(item.id);
  });
  if (missing.length) {
    let items: Record<string, { fields: Fields }> = {};
    try {
      items = (await api<{ items: typeof items }>(`/agents/${path(agentId)}/turns/${path(turn.id)}/payload`)).items;
    } catch {
      /* Each Item is tried on its own below. */
    }
    const failed: string[] = [];
    for (const item of missing) {
      const names = Object.keys(item._yuzunoTruncated || {});
      const covers = (fields?: Fields) => !!fields && names.every((name) => name in fields);
      let fields: Fields | undefined = items[item.id]?.fields;
      if (covers(fields)) remember(keyOf(agentId, turn.id, item.id), entryOf(fields!, item));
      else fields = await fetchEntry(agentId, turn.id, item).then((entry): Fields | undefined => entry.fields, () => undefined);
      if (covers(fields)) full.set(item.id, fields!);
      else failed.push(item.id);
    }
    if (failed.length)
      throw new Error(`couldn't get the full output of ${failed.length} ${failed.length === 1 ? "item" : "items"}, so nothing was copied`);
  }
  return { ...turn, items: turn.items.map((item) => withFullFields(item, full.get(item.id))) };
}

export interface FullItemView {
  /** The Item to render: full once loaded, otherwise the preview. */
  item: NativeItem;
  /** Trimmed fields of the preview; null when nothing was trimmed. */
  truncated: Record<string, TruncatedField> | null;
  expanded: boolean;
  /** Full values are being read for the first time. */
  loading: boolean;
  /** Shown values are full but will be read again (running or finished). */
  updating: boolean;
  error: string;
  expand: () => void;
}

/** A preview Item that can be expanded to its full fields on request. */
export function useFullItem(agentId: string | undefined, turnId: string | undefined, item: NativeItem): FullItemView {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  const truncated = !!agentId && !!turnId && isTruncated(item);
  const key = truncated ? keyOf(agentId!, turnId!, item.id) : "";
  const open = truncated && expanded.has(key);
  const entry = open ? loaded.get(key) : undefined;
  const view = entry ? newest(entry, item) : null;
  const fetchNeeded = open && !failure && (!entry || view!.stale);
  // Finished or first read: now. Still running: no more often than the limit.
  const delay = !entry || entry.status !== (item.status ?? null)
    ? 0
    : Math.max(0, entry.fetchedAt + payloadLimits.runningRefetchMs - Date.now());
  const signature = JSON.stringify([item.status ?? null, item._yuzunoTruncated ?? null]);
  useEffect(() => {
    if (!open) return;
    onScreen.set(key, (onScreen.get(key) || 0) + 1);
    return () => {
      const count = (onScreen.get(key) || 1) - 1;
      if (count) onScreen.set(key, count);
      else onScreen.delete(key);
    };
  }, [open, key]);
  useEffect(() => {
    // Keep what the previews added, so the next preview only adds its own part.
    if (entry && view && !view.stale && loaded.get(key) === entry) {
      for (const [name, value] of Object.entries(view.fields))
        if (typeof value === "string" && typeof entry.fields[name] === "string")
          entry.size += value.length - (entry.fields[name] as string).length;
      entry.fields = view.fields;
      entry.bytes = view.bytes;
    }
  }, [key, signature]);
  useEffect(() => {
    if (!fetchNeeded) return;
    let live = true;
    const timer = setTimeout(() => {
      fetchEntry(agentId!, turnId!, item).then(
        () => live && rerender(),
        (e) => live && setFailure(errorText(e)),
      );
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The signature covers every change of the Item that matters here.
  }, [fetchNeeded, key, signature, attempt]);
  return {
    item: open && view ? withFullFields(item, view.fields) : item,
    truncated: truncated ? item._yuzunoTruncated! : null,
    expanded: open,
    loading: open && !entry && !failure,
    updating: fetchNeeded && !!entry,
    error: open ? failure : "",
    expand: () => {
      if (!truncated) return;
      markExpanded(key);
      setFailure("");
      setAttempt((n) => n + 1);
    },
  };
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
