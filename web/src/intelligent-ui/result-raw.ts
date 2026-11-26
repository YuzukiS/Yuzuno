import { useMemo, useState, type SyntheticEvent } from "react";

/**
 * A result's JSON as its details show and copy it. A reply's block is its
 * text as written, kept with the reply anyway. A published result is a
 * function that makes `JSON.stringify(spec, null, 2)` when it is called
 * (YN-234): only when its details are open or it is copied, never kept
 * beside the read it comes from.
 */
export type RawText = string | (() => string);

/** The text, made now if it has to be. */
export function rawText(raw: RawText): string {
  return typeof raw === "string" ? raw : raw();
}

/**
 * What of the text names the result it shows: a reply's block text, since a
 * new text is a new result; nothing for a published result, whose identity
 * already names one version that never changes.
 */
export function rawKey(raw: RawText): string {
  return typeof raw === "string" ? raw : "";
}

/**
 * The text for a `<pre>` in folded details, and their toggle handler. A text
 * as written is always there, as before. A published result's is made when
 * the details open, once while they stay open, and let go when they close,
 * so a folded result holds no copy of it in the page either.
 */
export function useFoldedRaw(raw: RawText | undefined): {
  text: string | null;
  onToggle?: (event: SyntheticEvent<HTMLDetailsElement>) => void;
} {
  const [open, setOpen] = useState(false);
  const made = useMemo(() => (typeof raw === "function" && open ? raw() : null), [open, raw]);
  if (raw === undefined) return { text: null };
  if (typeof raw === "string") return { text: raw };
  return { text: made, onToggle: (event) => setOpen(event.currentTarget.open) };
}
