import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import type { ConversationInput, ConversationInputs } from "./types";

/** How many inputs one read asks for (Core's MAX_INPUTS). */
const PAGE = 100;

interface Loaded {
  agentId: string;
  inputs: ConversationInput[];
  hasBefore: boolean;
  total: number;
}

const key = (input: ConversationInput) => `${input.turnId}\u0000${input.itemId}`;

/**
 * The inputs a person wrote, or may have, to read the conversation by them
 * (T-6): read only while `active`, the newest page first and each earlier
 * page when asked for, from Core's light index (never the bodies). `changed`
 * names the conversation's newest state; when it moves the newest page is
 * read again and joined to the pages already read.
 */
export function useConversationInputs(agentId: string, active: boolean, changed: string) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const read = useCallback(async (before?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ limit: String(PAGE), ...(before ? { before } : {}) });
      const page = await api<ConversationInputs>(
        `/agents/${encodeURIComponent(agentId)}/conversation/inputs?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      // A Core that has no such read answers something else: no inputs.
      if (!Array.isArray(page?.inputs)) throw new Error("No inputs");
      setLoaded(current => {
        const kept = current?.agentId === agentId ? current.inputs : [];
        if (before) {
          return { agentId, inputs: [...page.inputs, ...kept], hasBefore: page.hasBefore, total: page.total };
        }
        // The newest page again: earlier pages stay in front of it while they
        // join it, so the numbering has no gap.
        const newest = new Set(page.inputs.map(key));
        const first = page.inputs[0];
        const joins = !page.hasBefore || kept.some(input => newest.has(key(input)));
        const earlier = first && joins ? kept.filter(input => !newest.has(key(input)) && (input.position[0] < first.position[0]
          || (input.position[0] === first.position[0] && input.position[1] < first.position[1]))) : [];
        return { agentId, inputs: [...earlier, ...page.inputs], total: page.total,
          hasBefore: earlier.length ? (current?.hasBefore ?? page.hasBefore) : page.hasBefore };
      });
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorText(failure));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [agentId]);
  useEffect(() => {
    setLoaded(null);
    return () => request.current?.abort();
  }, [agentId]);
  useEffect(() => {
    if (active) void read();
  }, [active, changed, read]);
  const loadEarlier = useCallback(() => {
    const first = loaded?.agentId === agentId ? loaded.inputs[0] : undefined;
    if (first && loaded?.hasBefore && !loading) void read(JSON.stringify([first.turnId, first.itemId]));
  }, [agentId, loaded, loading, read]);
  const shown = loaded?.agentId === agentId ? loaded : null;
  return {
    inputs: shown?.inputs ?? [],
    hasBefore: shown?.hasBefore ?? false,
    total: shown?.total ?? 0,
    loading,
    error,
    loadEarlier,
  };
}
