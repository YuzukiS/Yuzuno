import type { AgentDetail } from "./types";
import type { DetailEvent } from "./workspace-events.ts";
import { patchDetail } from "./detail-patch.ts";

export interface DetailSyncOptions {
  /** Reads the Agent's whole detail. */
  fetch: (agentId: string, signal: AbortSignal) => Promise<AgentDetail>;
  /** The detail to show (null while none is loaded). */
  publish: (detail: AgentDetail | null) => void;
  /** The latest read failure, or null once a read succeeds. */
  error: (error: unknown) => void;
  /** Refetches requested within this window share one read. */
  refetchDelayMs?: number;
  /** Streamed changes are rendered at most this often. */
  flushDelayMs?: number;
  /** After a failed read, reads wait this long (unless asked for now). */
  retryDelayMs?: number;
}

/** Streamed changes waiting beyond this many are dropped for one refetch. */
const MAX_QUEUED = 5_000;

/**
 * Keeps the shown Agent's detail current: one whole read when it is opened or
 * when Core says something else changed, and streamed Item changes applied in
 * place in between.
 *
 * A read and the stream are reconciled by revision: a read whose
 * `agent.rev` is R already contains every change with `rev <= R`, so of
 * the changes that arrived while it was running only later ones are applied
 * again.
 *
 * The shown `agent.lastSeq` (the read receipt's position) is always the last
 * read's. Streamed changes never move it: everything that counts as unread
 * (results, requests, errors) arrives as a change notice and is shown by a
 * read, so a receipt covers only what a read put on screen.
 */
export class DetailSync {
  readonly options: Required<DetailSyncOptions>;
  agentId: string | null = null;
  current: AgentDetail | null = null;
  /** Revision of the last read. */
  baseRev = 0;
  /** Journal position of the last read. */
  baseSeq = 0;
  /** The last read failed; reads wait for the retry unless asked for now. */
  failed = false;
  running = false;
  queued = false;
  /** The browser came back online while a read ran: if it fails, read again
   * at once instead of after the retry delay (T-170). */
  retryOnline = false;
  controller: AbortController | null = null;
  /** Changes received while the running read was outstanding. */
  recent: DetailEvent[] = [];
  /** Changes received but not rendered yet. */
  queue: DetailEvent[] = [];
  generation = 0;
  refetchTimer: ReturnType<typeof setTimeout> | undefined;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: DetailSyncOptions) {
    this.options = {
      refetchDelayMs: 150,
      flushDelayMs: 100,
      retryDelayMs: 5_000,
      ...options,
    };
  }

  /** Shows another Agent (or none): earlier reads and changes are dropped. */
  select(agentId: string | null) {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    for (const timer of [this.refetchTimer, this.flushTimer, this.retryTimer])
      clearTimeout(timer);
    this.refetchTimer = this.flushTimer = this.retryTimer = undefined;
    this.running = this.queued = this.failed = this.retryOnline = false;
    this.recent = [];
    this.queue = [];
    this.current = null;
    this.baseRev = this.baseSeq = 0;
    this.agentId = agentId;
    this.options.publish(null);
    this.options.error(null);
    if (agentId) void this.run();
  }

  dispose() {
    this.select(null);
  }

  /** A different body window of this Agent. Keep the previous view until
   * the replacement arrives, but never let an older request overwrite it. */
  reloadWindow() {
    this.generation++;
    this.controller?.abort();
    for (const timer of [this.refetchTimer, this.flushTimer, this.retryTimer]) clearTimeout(timer);
    this.refetchTimer = this.flushTimer = this.retryTimer = undefined;
    this.running = this.queued = this.failed = this.retryOnline = false;
    this.queue = this.recent = [];
    this.options.error(null);
    return this.run();
  }

  /**
   * Reads the detail again: now (a reset, a poll, the user's own action), or
   * with others requested within the refetch window. After a failed read,
   * only one asked for now goes before the retry.
   */
  refetch({ now = false } = {}) {
    if (!this.agentId) return;
    if (this.failed && !now) {
      this.scheduleRetry();
      return;
    }
    if (now) {
      clearTimeout(this.refetchTimer);
      this.refetchTimer = undefined;
      void this.run();
      return;
    }
    // A fixed cadence: a stream of notices never postpones the read.
    if (this.refetchTimer !== undefined) return;
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = undefined;
      void this.run();
    }, this.options.refetchDelayMs);
  }

  /**
   * The browser reports its network back (T-170). A read that failed while
   * it was away is tried again now rather than after the retry delay; one
   * still running is tried again at once if it fails. Otherwise nothing is
   * read: the event stream keeps the detail current. Each report starts at
   * most one read, and a read that fails again backs off as usual.
   */
  online() {
    if (!this.agentId) return;
    if (this.running) this.retryOnline = true;
    else if (this.failed) void this.run();
  }

  /** A streamed change for the shown Agent. */
  push(event: DetailEvent) {
    if (!this.agentId || event.agentId !== this.agentId) return;
    this.queue.push(event);
    if (this.running) this.recent.push(event);
    if (this.queue.length > MAX_QUEUED) {
      this.queue = [];
      this.refetch();
      return;
    }
    if (this.flushTimer === undefined)
      this.flushTimer = setTimeout(() => this.flush(), this.options.flushDelayMs);
  }

  /** Applies a local change (e.g. an action's response) to the shown detail. */
  mutate(change: (detail: AgentDetail) => AgentDetail) {
    if (!this.current) return;
    this.current = change(this.current);
    this.show();
  }

  /** The detail as shown, at the last read's journal position. */
  view(): AgentDetail | null {
    const current = this.current;
    if (!current) return null;
    return current.agent.lastSeq === this.baseSeq
      ? current
      : { ...current, agent: { ...current.agent, lastSeq: this.baseSeq } };
  }

  show() {
    this.options.publish(this.view());
  }

  /** Applies changes newer than the last read; returns whether any could
   * not be placed (a refetch is needed). */
  apply(events: DetailEvent[]) {
    let next = this.current;
    if (!next) return events.length > 0;
    let missing = false;
    for (const event of events) {
      if (event.rev <= this.baseRev) continue; // already in the read
      const patched = patchDetail(next, event);
      if (patched) next = patched;
      else missing = true;
    }
    this.current = next;
    return missing;
  }

  flush() {
    this.flushTimer = undefined;
    const events = this.queue;
    this.queue = [];
    if (!this.current) {
      // Nothing to apply them to yet; a running read replays them.
      if (!this.running && events.length) this.refetch();
      return;
    }
    const before = this.current;
    const missing = this.apply(events);
    if (this.current !== before) this.show();
    if (missing) this.refetch();
  }

  scheduleRetry() {
    if (this.retryTimer !== undefined || this.running) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.run();
    }, this.options.retryDelayMs);
  }

  async run() {
    const agentId = this.agentId;
    if (!agentId) return;
    if (this.running) {
      this.queued = true;
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.running = true;
    this.queued = false;
    const generation = this.generation;
    this.recent = [];
    const controller = new AbortController();
    this.controller = controller;
    try {
      const read = await this.options.fetch(agentId, controller.signal);
      if (generation !== this.generation) return;
      const replay = this.recent;
      this.recent = [];
      // Unrendered changes are either in the read or in `replay`.
      this.queue = [];
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.current = read;
      this.baseRev = read.agent.rev ?? 0;
      this.baseSeq = read.agent.lastSeq;
      this.failed = false;
      this.retryOnline = false;
      const missing = this.apply(replay);
      this.options.error(null);
      this.show();
      if (missing) this.refetch();
    } catch (error) {
      if (generation !== this.generation) return;
      // Changes it was to reconcile are still queued for the shown copy.
      this.recent = [];
      this.failed = true;
      this.options.error(error);
    } finally {
      if (generation === this.generation) {
        this.running = false;
        this.controller = null;
        // A read asked for while this one ran still goes; reads asked for
        // after a failure wait for the retry (see refetch).
        if (this.queued) void this.run();
        else if (this.failed && this.retryOnline) {
          this.retryOnline = false;
          void this.run();
        } else if (this.failed) this.scheduleRetry();
        if (!this.running && this.queue.length && this.flushTimer === undefined)
          this.flushTimer = setTimeout(() => this.flush(), this.options.flushDelayMs);
      }
    }
  }
}
