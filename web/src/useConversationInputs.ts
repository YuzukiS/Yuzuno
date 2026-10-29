import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import type { ConversationInput, ConversationInputs } from "./types";

/** How many inputs one read asks for (Core's MAX_INPUTS). */
const PAGE = 100;
/** None yet: one array, so what is derived from it keeps its identity. */
const NONE: ConversationInput[] = [];

interface Loaded {
  workspaceId: string;
  agentId: string;
  inputs: ConversationInput[];
  hasBefore: boolean;
  total: number;
}

const key = (input: ConversationInput) => `${input.turnId}\u0000${input.itemId}`;

/**
 * The inputs a person wrote, or may have, to read the conversation by them
 * (T-6): the newest page first and each earlier page when asked for, from
 * Core's light index (never the bodies), only while `enabled`. Read once for
 * each Agent opened, so whether there are any is known in either mode;
 * while `following` (the dock reads by them), read again whenever `changed`,
 * the conversation's newest state, moves, and joined to the pages already
 * read. `workspaceId` is part of whose they are, as in useAgentDetail (T-195):
 * an Agent id can name another Agent in another Workspace at this address.
 */
export function useConversationInputs(workspaceId: string, agentId: string, enabled: boolean, following: boolean, changed: string) {
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
        const kept = current?.workspaceId === workspaceId && current.agentId === agentId ? current.inputs : [];
        if (before) {
          return { workspaceId, agentId, inputs: [...page.inputs, ...kept], hasBefore: page.hasBefore, total: page.total };
        }
        // The newest page again: earlier pages stay in front of it while they
        // join it, so the numbering has no gap.
        const newest = new Set(page.inputs.map(key));
        const first = page.inputs[0];
        const joins = !page.hasBefore || kept.some(input => newest.has(key(input)));
        const earlier = first && joins ? kept.filter(input => !newest.has(key(input)) && (input.position[0] < first.position[0]
          || (input.position[0] === first.position[0] && input.position[1] < first.position[1]))) : [];
        return { workspaceId, agentId, inputs: [...earlier, ...page.inputs], total: page.total,
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
  }, [workspaceId, agentId]);
  useEffect(() => {
    setLoaded(null);
    return () => request.current?.abort();
  }, [workspaceId, agentId]);
  // What asks for a read: while following, each newest state; otherwise one
  // read for each Agent opened (one that fails leaves the dock by Turn, as a
  // Core without this read does, until the Agent is opened again).
  const known = loaded?.workspaceId === workspaceId && loaded.agentId === agentId;
  const due = !enabled ? null : following ? `follow:${changed}` : known ? null : "once";
  useEffect(() => {
    if (due !== null) void read();
  }, [due, read]);
  const loadEarlier = useCallback(() => {
    const first = known && loaded ? loaded.inputs[0] : undefined;
    if (first && loaded?.hasBefore && !loading) void read(JSON.stringify([first.turnId, first.itemId]));
  }, [known, loaded, loading, read]);
  const shown = known ? loaded : null;
  return {
    inputs: shown?.inputs ?? NONE,
    hasBefore: shown?.hasBefore ?? false,
    total: shown?.total ?? 0,
    loading,
    error,
    loadEarlier,
  };
}
