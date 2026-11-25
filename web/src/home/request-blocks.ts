import { changedSinceSeen } from "./brief-layout.ts";
import { runsText, visibleRuns } from "./card-face.ts";
import { summaryOf } from "./report/report-model.ts";
import type { Deliverable, Delivery, ProjectRequest, RequestCard, RequestPull, RouteAgent } from "./project-talk-api";
import type { Section } from "./types";

/**
 * A Project's page read by request (YN-212, R-20: "按请求归并", one task one
 * card). Pure facts joined from Core's two reads, the requests
 * (project_requests.rs `view`, progress.rs) and the Brief (home.rs): nothing
 * here is an Agent's words but a card's own title, and that only where it is
 * newer than every Core fact about the same task, so text written before a
 * reply never outranks the reply.
 *
 * - Every request is one block. Its first look is one latest fact and one
 *   action, then what its tasks delivered, each openable.
 * - Every task is one row with one card, under the lowest-numbered request
 *   routed to it (progress.rs `first_request`); another request it serves
 *   names it in one line and shares its fact and deliverables.
 * - Every live section bound to no request's task is the Project's own block:
 *   its open Asks each stand in Needs you, its cards in a group of their own
 *   (R-27), and neither counts as a request.
 */

/** Needs you, in progress, done (confirmed by the user, YN-184). */
export type BlockGroup = "needs" | "doing" | "done";

/**
 * The one action a block's first look offers: answer > send again > confirm done > follow up. Answer is offered
 * only by a block whose open Ask is shown under another request it joined; an Ask of its own is shown in it, to
 * answer there (W5, R-20 follow-up). Confirm done has Follow up beside it (R-30), for a delivery not done enough.
 */
export type BlockAction = "answer" | "resend" | "confirm" | "follow";

/** Who answers for a task now, as Core reads it (cards.rs `responsible`). */
export type Who = NonNullable<RequestCard["responsible"]>;

/**
 * A block's latest fact, the first of these that holds (the design's §3.2
 * table, rows 1–7): what Core knows outranks what an Agent wrote before it.
 */
export type BlockFact =
  /** 1. The user's words are not confirmed delivered. */
  | { kind: "unconfirmed" }
  /**
   * 2. A task of the block has an open Ask: the oldest, and how many more. `home` is null when it is one of the
   * block's own tasks, whose Asks the block shows; else the request whose block shows it (a joined task).
   */
  | { kind: "ask"; title: string; key: string; count: number; task: string; at: string; home: number | null }
  /** 3. The front desk answered it itself (YN-136). */
  | { kind: "answered"; text: string; at: string }
  /** 4. Its tasks delivered, and no task going on wrote its card since. */
  | { kind: "result"; count: number; task: string; ended: boolean; at: string; going: number }
  /** 5. Every task ended with nothing to open. */
  | { kind: "ended"; task: string; status: string; at: string | null }
  /** 6. No task yet: the front desk's newest note, or delivered and being looked at. */
  | { kind: "waiting"; note: string | null; at: string }
  /** 7. In progress, the newest task's newest: the user's reply when newer than its card… */
  | { kind: "replied"; title: string; reply: string; who: Who | null; task: string; at: string; taken: boolean }
  /** …else its card's title, by who wrote it… */
  | { kind: "card"; title: string; who: Who | null; author: string; task: string; at: string; stale: boolean }
  /** …else whom it went to. */
  | { kind: "working"; who: Who | null; task: string; at: string };

/** One task: its one card, the cards it had before (folded), its Asks and what it delivered. */
export type TaskRow = {
  task: RequestCard["task"];
  /** The task's card on Home: its newest status or report that is no route's placeholder; null before its first. */
  card: Section | null;
  /** The task's other statuses and reports, newest first (before YN-212: a second status, a report sub-topic). */
  earlier: Section[];
  /** A route's placeholder (C3 `card.placeholder`), kept for its words only, never shown as a card. */
  placeholder: Section | null;
  /** The task's Asks, newest first. */
  asks: Section[];
  responsible: Who | null;
  deliverables: Deliverable[];
  /** The PRs its task links (R-38), as Core last read them; none from an older Core. */
  prs: RequestPull[];
  /** Its task's newest result, or null; null from an older Core. */
  result: NonNullable<RequestCard["result"]> | null;
  /**
   * Why a task that ended shows nothing delivered (YN-208): cancelled, its result named nothing, or it ended with no
   * result. Null while it goes on, once it delivered something, and from an older Core, which reads no deliverables.
   */
  nothing: "cancelled" | "noDeliverable" | "noResult" | null;
  /** Whether the card's version is older than the user's newest reply to one of the task's Asks, while it goes on. */
  cardBeforeReply: boolean;
  /** The request it is shown under: the lowest-numbered one routed to it. */
  home: number;
  /** The other requests it serves, which name it in one line. */
  alsoFor: number[];
  title: string;
};

export type DeliveredGroup = { task: string; title: string; items: Deliverable[] };

/** An open Ask of a task the block joined, shown under the request that task is shown under. */
export type AskedElsewhere = { home: number; key: string; title: string; count: number };

export type RequestBlock = {
  kind: "request";
  key: string;
  request: ProjectRequest;
  group: BlockGroup;
  fact: BlockFact;
  /** None once the user confirmed it done, and none for an Ask the block shows itself. */
  action: BlockAction | null;
  /**
   * The Asks of the tasks shown here, each once, oldest first (W5): an open one is shown in the block's first look,
   * answerable there, not behind Answer; the view keeps one the user answered in this visit where it was.
   */
  asks: Section[];
  /** Open Asks of tasks it joined, shown in the block of the request they are under. */
  askedElsewhere: AskedElsewhere | null;
  /** What its tasks' newest results delivered, newest result first, each task once. */
  delivered: DeliveredGroup[];
  /** The tasks shown here in full. */
  tasks: TaskRow[];
  /** The tasks it joined that are shown under another request. */
  joined: TaskRow[];
  /** A card or Ask of its tasks changed since the user marked it seen. */
  unread: boolean;
  /** Its newest activity (ms), for the order within a group. */
  last: number;
  /** Its status label (R-38 §2.3). */
  state: BlockState;
  /** Its progress: the bar of its tasks' outcomes, else its task's own progress, else none (R-38 §2.2, §3). */
  now: BlockNow;
  /** The one real next step, or none (R-38 §2.3). */
  next: BlockNext | null;
  /** What it has and still lacks, by outcome; only with a bar. */
  details: BlockDetails | null;
  /** What its first look's evidence line counts (R-38 §2.2): its tasks' PRs, by whether the release has them. */
  evidence: BlockEvidence;
  /** When its progress was written before later facts Core knows (R-38 §2.5); none otherwise. */
  stale: BlockStale | null;
  /** Who wrote the card its bar is read from, and when (the newest, with several); none without a bar. */
  by: { author: string; at: string } | null;
  /**
   * The front desk's newest reply, shown in its first look (R-43): only with tasks and no progress (no bar, no
   * task's own progress), and newer than every card of its tasks; none otherwise. Without a task, its fact says it.
   */
  reply: { text: string; by: RouteAgent; at: string } | null;
};

/**
 * A request's status label (R-38 §2.3), the first of these that holds: done (the user confirmed it); its words'
 * delivery refused (deliveryFailed) or not confirmed; an open Ask of its own tasks (decide); settled and waiting for
 * the user's confirmation (accept); a task going on that waits for a condition (condition); one its team works on
 * now (team); else going on (going); no task yet (frontDesk).
 */
export type BlockState = "done" | "deliveryFailed" | "unconfirmed" | "decide" | "accept" | "condition" | "team" | "going" | "frontDesk";

/**
 * One outcome on a request's bar (R-38 §3): a step of the Plan its task's card names as `summary.progress`. Its text
 * before the first " — " is its name, the rest its detail. Of a step its author marked done: merged, when every PR
 * it names is exactly one PR its task links and each is merged; available, when each of those is also in the
 * release (Core kept the commit ancestry); else done, as its author marked it, with what is known of each PR in
 * `facts` (the lead's rule on YN-227, comment 12387). doing, blocked, todo as the step says. `asking`: its task has
 * an open Ask, on its first step not done.
 */
export type Segment = {
  id: string;
  task: string;
  name: string;
  detail: string | null;
  state: "available" | "done" | "merged" | "doing" | "blocked" | "todo";
  /** What is known of each PR it names, in its order. */
  facts: PullFact[];
  asking: boolean;
};

/**
 * A PR a step names, as Core knows it: the one its task links by that number, with whether it merged and is in the
 * release (installed); or none (unlinked); or more than one, of other repositories (ambiguous).
 */
export type PullFact =
  | { number: number; kind: "linked"; pr: RequestPull }
  | { number: number; kind: "unlinked" | "ambiguous" };

/**
 * A block's progress. bar: its outcomes, `done` of `total` done (available, merged or done, whatever kind of work),
 * and apart from that how many are `available` (in the release, by commit) and how many `merged` and not known to be
 * installed. progress: no Plan, the first sentence of its task's own progress.
 */
export type BlockNow =
  | { kind: "bar"; done: number; total: number; available: number; merged: number; segments: Segment[] }
  | { kind: "progress"; text: string; task: string }
  | null;

/** The one real next step (R-38 §2.3): never a planned step of the user's, nor a guess. */
export type BlockNext =
  /** The open Ask its first look shows. */
  | { kind: "ask" }
  /** The user confirms it done, or follows up. */
  | { kind: "accept" }
  /** A task it joined has an open Ask, shown under request `home`. */
  | { kind: "elsewhere"; task: string; home: number; title: string }
  /** What a task going on waits for, as its blocker says. */
  | { kind: "condition"; text: string; task: string }
  /** The first step in progress, and who answers for its task. */
  | { kind: "step"; text: string; task: string; who: Who | null };

export type DetailItem = { task: string; name: string; detail: string | null; state: Segment["state"]; facts: PullFact[] };
export type BlockDetails = { got: DetailItem[]; left: DetailItem[] };

export type BlockEvidence = {
  /** Merged and in the release (Core kept the commit ancestry). */
  installed: RequestPull[];
  /** Merged, not known to be in the release. */
  pending: RequestPull[];
  /** Open or draft. */
  open: RequestPull[];
  /** Its tasks' Asks the user answered. */
  answered: number;
  /** The front desk's notes and the user's follow-ups. */
  conversation: number;
};

/** A later fact Core knows than the progress (R-38 §2.5), at most three kinds. */
export type StaleFact =
  | { kind: "merged"; prs: number[] }
  | { kind: "result"; task: string }
  | { kind: "ended"; task: string }
  | { kind: "followUp"; count: number };
export type BlockStale = { at: string; facts: StaleFact[]; expired: boolean };

/**
 * Every live section bound to no task a request has: the lead's overview, standing statuses, their Asks. It is no
 * request (R-27 §2): its open Asks stand in Needs you each on its own, its cards in the page's Project cards group.
 */
export type ProjectBlock = {
  kind: "project";
  key: "project";
  sections: Section[];
  /** Its Asks, oldest first: an open one stands in Needs you, answerable there (W5). */
  asks: Section[];
  unread: boolean;
  last: number;
};

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : 0;
};

/** As project-talk-api.ts `delivered`, which this pure module does not import (it reaches the network). */
const reached = (delivery: Delivery) => delivery === "accepted" || delivery === "queued";

const ended = (status: string) => status === "done" || status === "cancelled";

const taskOf = (section: Section) => section.card?.task.id ?? null;

/** A route's placeholder card, as Core marks it (YN-212 C3); an older Core marks none and shows it as a card. */
export const isPlaceholder = (section: Section) => section.card?.placeholder === true;

/** Who wrote a card's version (YN-212 C1), else its owner, as an older Core says. */
export const authorOf = (section: Section) => section.author?.name || section.owner.name;

/**
 * The sections a task's rows read: each section once by its identity on Home, the live one before its history
 * entries, then the newest; an entry without an identity (an older Core) by its key.
 */
function unique(sections: readonly Section[]) {
  const kept = new Map<string, Section>();
  for (const section of sections) {
    const id = section.id === undefined ? `k:${section.key}` : `i:${section.id}`;
    const had = kept.get(id);
    if (!had || (had.history && !section.history) || (had.history === section.history && section.version > had.version)) kept.set(id, section);
  }
  return [...kept.values()];
}

const newestFirst = (a: Section, b: Section) => Number(a.history) - Number(b.history) || time(b.updatedAt) - time(a.updatedAt);

/** An Ask the user has not answered, live. */
export const openAsk = (section: Section) => section.kind === "ask" && !section.history && section.ask?.state === "open";

/**
 * Asks in the order they were put, oldest first: by Home's identity, which a new section gets in turn and a new
 * version keeps, so an answer moves none of them; an older Core's, without one, by when it was last written.
 */
const asked = (a: Section, b: Section) =>
  a.id !== undefined && b.id !== undefined ? a.id - b.id : time(a.updatedAt) - time(b.updatedAt);

function rowsOf(requests: readonly ProjectRequest[], sections: readonly Section[]) {
  const all = unique(sections);
  const rows = new Map<string, TaskRow>();
  // Oldest request first: the first to name a task is the one it is shown under (Core's `first_request`).
  for (const request of [...requests].sort((a, b) => a.n - b.n)) {
    for (const routed of request.cards) {
      const id = routed.task.id;
      const row = rows.get(id);
      if (row) {
        if (row.home !== request.n && !row.alsoFor.includes(request.n)) row.alsoFor.push(request.n);
        continue;
      }
      const bound = all.filter((s) => taskOf(s) === id);
      // Removed and resolved entries are no card of the task; an archived or seen report still is (YN-195).
      const cards = bound
        .filter((s) => s.kind !== "ask" && s.historyReason !== "removed")
        .sort(newestFirst);
      const placeholder = cards.find(isPlaceholder) ?? null;
      const real = cards.filter((s) => !isPlaceholder(s));
      const asks = bound.filter((s) => s.kind === "ask").sort(newestFirst);
      const card = real[0] ?? null;
      const replied = Math.max(0, ...asks.map((a) => time(a.ask?.repliedAt)));
      rows.set(id, {
        task: routed.task,
        card,
        earlier: real.slice(1),
        placeholder,
        asks,
        responsible: routed.responsible,
        deliverables: routed.deliverables?.items ?? [],
        prs: routed.prs?.items ?? [],
        result: routed.result ?? null,
        nothing: nothingDelivered(routed),
        cardBeforeReply: !!card && !ended(routed.task.status) && replied > time(card.updatedAt),
        home: request.n,
        alsoFor: [],
        title: card?.title || routed.title || placeholder?.title || id,
      });
    }
  }
  return rows;
}

/** Why an ended task delivered nothing (`TaskRow.nothing`), as the request's card said it before YN-212. */
function nothingDelivered(card: RequestCard): TaskRow["nothing"] {
  const over = card.task.archived || ended(card.task.status);
  if (card.deliverables === undefined || card.deliverables?.items.length || !over) return null;
  return card.task.status === "cancelled" ? "cancelled" : card.result ? "noDeliverable" : "noResult";
}

/** The newest of what the user replied and what the card says, for one task going on (§3.2 row 7). */
function progressOf(row: TaskRow, request: ProjectRequest): { fact: BlockFact; at: number } {
  const replied = row.asks
    .filter((a) => a.ask && a.ask.state !== "open" && a.ask.repliedAt)
    .sort((a, b) => time(b.ask?.repliedAt) - time(a.ask?.repliedAt))[0];
  const repliedAt = time(replied?.ask?.repliedAt);
  const cardAt = time(row.card?.updatedAt);
  if (replied?.ask && repliedAt >= cardAt) {
    return {
      fact: {
        kind: "replied",
        title: replied.ask.question || replied.title,
        reply: replied.ask.replyText ?? "",
        who: row.responsible,
        task: row.task.id,
        at: replied.ask.repliedAt!,
        taken: replied.ask.state === "resolved",
      },
      at: repliedAt,
    };
  }
  if (row.card) {
    return {
      fact: {
        kind: "card",
        title: row.card.title,
        who: row.responsible,
        author: authorOf(row.card),
        task: row.task.id,
        at: row.card.updatedAt,
        stale: !!row.card.status?.stale,
      },
      at: cardAt,
    };
  }
  const routed = request.routes.filter((r) => r.task === row.task.id).map((r) => time(r.at));
  const at = Math.max(time(request.createdAt), ...routed);
  return { fact: { kind: "working", who: row.responsible, task: row.task.id, at: new Date(at).toISOString() }, at };
}

/** The open Asks of `rows`, oldest first, each with its row. */
const openAsks = (rows: readonly TaskRow[]) =>
  rows.flatMap((row) => row.asks.filter(openAsk).map((ask) => ({ ask, row }))).sort((a, b) => asked(a.ask, b.ask));

/**
 * The block's latest fact and its one action (§3.2), from its tasks (shown here or joined) and what they delivered.
 * An open Ask of its own tasks is shown in the block (W5): no action leads to it.
 */
function factOf(request: ProjectRequest, rows: readonly TaskRow[], delivered: readonly DeliveredGroup[]): { fact: BlockFact; action: BlockAction | null } {
  if (!reached(request.delivery)) return { fact: { kind: "unconfirmed" }, action: "resend" };
  const own = openAsks(rows.filter((row) => row.home === request.n));
  const open = own.length ? own : openAsks(rows);
  if (open.length) {
    const { ask, row } = open[0];
    const home = own.length ? null : row.home;
    return {
      fact: { kind: "ask", title: ask.ask?.question || ask.title, key: ask.key, count: open.length, task: row.task.id, at: ask.updatedAt, home },
      action: home === null ? null : "answer",
    };
  }
  const note = request.notes.at(-1);
  if (request.state === "answered") return { fact: { kind: "answered", text: note?.note ?? "", at: note?.at ?? request.createdAt }, action: "confirm" };
  const going = rows.filter((row) => !ended(row.task.status) && !row.task.archived);
  const finished = request.state === "ended" || request.state === "done";
  if (delivered.length) {
    const newest = delivered[0];
    const routed = request.cards.find((c) => c.task.id === newest.task);
    const at = routed?.deliverables?.reportedAt ?? request.createdAt;
    // A result is the newest fact unless a task still going on wrote its card after it.
    if (!going.some((row) => row.card && time(row.card.updatedAt) > time(at))) {
      return {
        fact: {
          kind: "result",
          count: delivered.reduce((n, d) => n + d.items.length, 0),
          task: newest.task,
          ended: !!routed && ended(routed.task.status),
          at,
          going: going.length,
        },
        action: request.state === "ended" ? "confirm" : "follow",
      };
    }
  }
  if (finished) {
    const line = request.lines.filter((l) => l.kind === "done").at(-1);
    const row = rows.find((r) => r.task.id === line?.task) ?? rows[0];
    return {
      fact: { kind: "ended", task: row?.task.id ?? "", status: line?.kind === "done" ? line.status : row?.task.status ?? "done", at: line?.at ?? null },
      action: request.state === "ended" ? "confirm" : "follow",
    };
  }
  if (!rows.length) return { fact: { kind: "waiting", note: note?.note ?? null, at: note?.at ?? request.createdAt }, action: "follow" };
  let best: { fact: BlockFact; at: number } | null = null;
  for (const row of going.length ? going : rows) {
    const candidate = progressOf(row, request);
    if (!best || candidate.at > best.at) best = candidate;
  }
  return { fact: best!.fact, action: "follow" };
}

/**
 * Needs you only for what is the user's to do here (R-38 §2.4): an open Ask of its own tasks, words not delivered,
 * or a settled request to confirm. An Ask of a task it joined counts under the request that task is shown under.
 */
const groupOf = (request: ProjectRequest, fact: BlockFact): BlockGroup => {
  if (request.state === "done") return "done";
  if ((fact.kind === "ask" && fact.home === null) || fact.kind === "unconfirmed" || request.state === "ended" || request.state === "answered")
    return "needs";
  return "doing";
};

type PlanStep = { id: string; text: string; state: "todo" | "doing" | "done" | "blocked"; prs: number[] };
const STEP_STATES = new Set(["todo", "doing", "done", "blocked"]);
type Body = { elements?: Record<string, { type?: unknown; props?: Record<string, unknown> }> } | null | undefined;

/** The steps of the Plan `id` of a section's body, as its author wrote them; none when it is no Plan. */
function stepsOf(section: Section, id: string): PlanStep[] {
  const node = (section.body as Body)?.elements?.[id];
  if (node?.type !== "Plan" || !Array.isArray(node.props?.steps)) return [];
  return (node.props.steps as Record<string, unknown>[]).flatMap((step) =>
    step && typeof step.id === "string" && typeof step.text === "string" && STEP_STATES.has(step.state as string)
      ? [{ id: step.id, text: step.text, state: step.state as PlanStep["state"],
          prs: Array.isArray(step.prs) ? [...new Set((step.prs as unknown[]).filter((n): n is number => Number.isInteger(n)))] : [] }]
      : []);
}

/**
 * A task's progress card (R-38 §2.3): of its live cards and Asks, the newest whose summary names a Plan as its
 * progress, with that Plan's steps; null with none. An Ask is shown as it always is: only where the steps come from
 * changes.
 */
export function progressCard(row: TaskRow): { section: Section; steps: PlanStep[] } | null {
  const candidates = [row.card, ...row.earlier, ...row.asks].filter((s): s is Section => !!s && !s.history);
  let best: { section: Section; steps: PlanStep[] } | null = null;
  for (const section of candidates) {
    const named = summaryOf(section)?.progress;
    const steps = named ? stepsOf(section, named) : [];
    if (steps.length && (!best || time(section.updatedAt) > time(best.section.updatedAt))) best = { section, steps };
  }
  return best;
}

/** A step's text as its name and, after the first " — ", its detail. */
function split(text: string) {
  const at = text.indexOf(" — ");
  return at < 0 ? { name: text.trim(), detail: null } : { name: text.slice(0, at).trim(), detail: text.slice(at + 3).trim() || null };
}

/** What is known of each PR a step names, by number among those its task links (R-38, the lead's rule). */
function factsOf(step: PlanStep, linked: readonly RequestPull[]): PullFact[] {
  return step.prs.map((number) => {
    const matches = linked.filter((pr) => pr.number === number);
    return matches.length === 1 ? { number, kind: "linked", pr: matches[0] } : { number, kind: matches.length ? "ambiguous" : "unlinked" };
  });
}

/** A done step's state: merged only when each PR it names is one linked PR, merged; available when each is installed too. */
function doneState(facts: readonly PullFact[]): Segment["state"] {
  if (!facts.length || !facts.every((fact) => fact.kind === "linked" && fact.pr.state === "merged")) return "done";
  return facts.every((fact) => fact.kind === "linked" && fact.pr.installed === true) ? "available" : "merged";
}

const TEAM_STATES = new Set(["queued", "starting", "running", "delivering"]);
const going = (row: TaskRow) => !ended(row.task.status) && !row.task.archived;
const shortOf = (row: TaskRow) => row.card?.card?.task.shortName || row.task.id;

/** The bar of `rows`' outcomes (R-38 §3), their steps in order, named by task when several tasks have one. */
function barOf(rows: readonly TaskRow[]): { now: BlockNow & { kind: "bar" }; sources: Section[] } | null {
  const planned = rows.flatMap((row) => {
    const card = progressCard(row);
    return card ? [{ row, card }] : [];
  });
  if (!planned.length) return null;
  const several = planned.length > 1;
  const segments: Segment[] = planned.flatMap(({ row, card }) => {
    let asking = row.asks.some(openAsk);
    return card.steps.map((step) => {
      const { name, detail } = split(step.text);
      const facts = factsOf(step, row.prs);
      const state: Segment["state"] = step.state === "done" ? doneState(facts) : step.state;
      const ask = asking && step.state !== "done";
      if (ask) asking = false;
      return { id: `${row.task.id}:${step.id}`, task: row.task.id, name: several ? `${shortOf(row)} · ${name}` : name, detail, state,
        facts, asking: ask };
    });
  });
  const count = (...states: Segment["state"][]) => segments.filter((s) => states.includes(s.state)).length;
  return {
    now: { kind: "bar", done: count("available", "merged", "done"), total: segments.length, available: count("available"), merged: count("merged"),
      segments },
    sources: planned.map(({ card }) => card.section),
  };
}

/** One cell of a drawn bar: a segment, or (more than `BAR_CELLS` of them) a run of adjacent ones of one state. */
export type BarCell = { key: string; state: Segment["state"]; segments: Segment[] };

/** Most cells a bar draws one per outcome (R-38 §3); past it, adjacent outcomes of one state share a cell. */
export const BAR_CELLS = 10;

/** The cells a bar draws: one per segment, or past BAR_CELLS, adjacent segments of one state (and not asking) merged. */
export function barCells(segments: readonly Segment[], most = BAR_CELLS): BarCell[] {
  if (segments.length <= most) return segments.map((segment) => ({ key: segment.id, state: segment.state, segments: [segment] }));
  const cells: BarCell[] = [];
  for (const segment of segments) {
    const last = cells.at(-1);
    if (last && last.state === segment.state && !segment.asking && !last.segments.some((s) => s.asking)) last.segments.push(segment);
    else cells.push({ key: segment.id, state: segment.state, segments: [segment] });
  }
  return cells;
}

/** The block's status label (R-38 §2.3), from its own tasks (`own`) and those it joined. */
function stateOf(request: ProjectRequest, own: readonly TaskRow[], joined: readonly TaskRow[]): BlockState {
  if (request.state === "done") return "done";
  if (request.delivery === "rejected") return "deliveryFailed";
  if (!reached(request.delivery)) return "unconfirmed";
  if (openAsks(own).length) return "decide";
  if (request.state === "ended" || request.state === "answered") return "accept";
  const rows = [...own, ...joined];
  if (!rows.length) return "frontDesk";
  const on = rows.filter(going);
  if (on.some((row) => row.task.blocker)) return "condition";
  if (on.some((row) => row.responsible && (row.responsible.kind !== "executor" || TEAM_STATES.has(row.responsible.state)))) return "team";
  return "going";
}

/** The one real next step (R-38 §2.3), the first of these that holds. */
function nextOf(state: BlockState, own: readonly TaskRow[], joined: readonly TaskRow[], segments: readonly Segment[]): BlockNext | null {
  if (state === "decide") return { kind: "ask" };
  if (state === "accept") return { kind: "accept" };
  if (state === "done" || state === "unconfirmed" || state === "deliveryFailed") return null;
  const elsewhere = openAsks(joined)[0];
  if (elsewhere)
    return { kind: "elsewhere", task: elsewhere.row.task.id, home: elsewhere.row.home, title: elsewhere.ask.ask?.question || elsewhere.ask.title };
  const rows = [...own, ...joined];
  const waiting = rows.find((row) => going(row) && row.task.blocker);
  if (state === "condition" && waiting) return { kind: "condition", text: waiting.task.blocker!, task: waiting.task.id };
  const step = segments.find((segment) => segment.state === "doing");
  if (step) return { kind: "step", text: step.name, task: step.task, who: rows.find((row) => row.task.id === step.task)?.responsible ?? null };
  return null;
}

const DONE_STATES = new Set<Segment["state"]>(["available", "done", "merged"]);

/** Each PR once, by repository and number, as its evidence counts it. */
function evidenceOf(request: ProjectRequest, rows: readonly TaskRow[]): BlockEvidence {
  const seen = new Map<string, RequestPull>();
  for (const pr of rows.flatMap((row) => row.prs)) seen.set(`${pr.repository}#${pr.number}`, pr);
  const all = [...seen.values()];
  return {
    installed: all.filter((pr) => pr.state === "merged" && pr.installed === true),
    pending: all.filter((pr) => pr.state === "merged" && pr.installed !== true),
    open: all.filter((pr) => pr.state === "open" || pr.state === "draft"),
    answered: rows.flatMap((row) => row.asks).filter((a) => a.kind === "ask" && a.ask && a.ask.state !== "open").length,
    conversation: request.notes.length + request.replies.length,
  };
}

/**
 * Whether the progress was written before later facts Core knows (R-38 §2.5): PRs merged, results reported, tasks
 * ended and the user's follow-ups after the newest card it was read from, at most three kinds; `expired` when that
 * card is a status past its validity. None without a bar: a task's own progress carries no time to compare.
 */
function staleOf(request: ProjectRequest, rows: readonly TaskRow[], sources: readonly Section[]): BlockStale | null {
  if (!sources.length) return null;
  const newest = sources.reduce((a, b) => (time(b.updatedAt) > time(a.updatedAt) ? b : a));
  const at = time(newest.updatedAt);
  const facts: StaleFact[] = [];
  const merged = [...new Set(rows.flatMap((row) => row.prs).filter((pr) => pr.state === "merged" && time(pr.mergedAt) > at).map((pr) => pr.number))];
  if (merged.length) facts.push({ kind: "merged", prs: merged });
  for (const row of rows) if (row.result && time(row.result.reportedAt) > at) facts.push({ kind: "result", task: row.task.id });
  for (const line of request.lines) if (line.kind === "done" && time(line.at) > at) facts.push({ kind: "ended", task: line.task });
  const followUps = request.replies.filter((reply) => time(reply.at) > at).length;
  if (followUps) facts.push({ kind: "followUp", count: followUps });
  const kinds = [...new Set(facts.map((fact) => fact.kind))].slice(0, 3);
  const kept = facts.filter((fact) => kinds.includes(fact.kind));
  const expired = sources.some((section) => !!section.status?.stale);
  return kept.length || expired ? { at: newest.updatedAt, facts: kept, expired } : null;
}

/** A block's progress parts (R-38 §2): from its own tasks, else (none of its own) those it joined. */
function requestProgress(request: ProjectRequest, own: readonly TaskRow[], joined: readonly TaskRow[]) {
  const rows = own.length ? own : joined;
  const bar = barOf(rows);
  const state = stateOf(request, own, joined);
  let now: BlockNow = bar?.now ?? null;
  if (!now) {
    const row = rows.find((r) => going(r) && r.task.progress) ?? rows.find((r) => r.task.progress);
    const head = splitLead(row?.task.progress)?.head;
    if (row && head) now = { kind: "progress", text: head, task: row.task.id };
  }
  const segments = bar?.now.segments ?? [];
  const newest = bar?.sources.reduce((a, b) => (time(b.updatedAt) > time(a.updatedAt) ? b : a));
  const note = request.notes.at(-1);
  const reply =
    !now && rows.length && note?.note.trim() && rows.every((row) => !row.card || time(row.card.updatedAt) < time(note.at))
      ? { text: note.note.trim(), by: note.by, at: note.at }
      : null;
  return {
    by: newest ? { author: authorOf(newest), at: newest.updatedAt } : null,
    reply,
    state,
    now,
    next: nextOf(state, own, joined, segments),
    details: bar
      ? {
          got: segments.filter((s) => DONE_STATES.has(s.state)).map(({ task, name, detail, state, facts }) => ({ task, name, detail, state, facts })),
          left: segments.filter((s) => !DONE_STATES.has(s.state)).map(({ task, name, detail, state, facts }) => ({ task, name, detail, state, facts })),
        }
      : null,
    evidence: evidenceOf(request, rows),
    stale: staleOf(request, rows, bar?.sources ?? []),
  };
}

/** Within Needs you: an Ask first, then words not delivered, then what waits for a confirmation. */
const RANK: Record<BlockFact["kind"], number> = {
  ask: 0, unconfirmed: 1, result: 2, answered: 2, ended: 3, replied: 4, card: 4, working: 4, waiting: 4,
};
const ORDER: Record<BlockGroup, number> = { needs: 0, doing: 1, done: 2 };

/**
 * The page's blocks (YN-212 §2–3): each request once, in three groups (needs
 * you, in progress, done), and the Project's own block for every live section
 * bound to no request's task, or null without any. Within Needs you: what to
 * answer first, then the newest; in the other groups the newest first.
 */
export function pageBlocks(requests: readonly ProjectRequest[], sections: readonly Section[]): { blocks: RequestBlock[]; project: ProjectBlock | null } {
  const rows = rowsOf(requests, sections);
  const blocks: RequestBlock[] = [];
  for (const request of requests) {
    const mine = [...new Set(request.cards.map((c) => c.task.id))].map((id) => rows.get(id)!);
    const delivered = request.cards
      .filter((c) => c.deliverables?.items.length)
      .filter((c, index, all) => all.findIndex((other) => other.task.id === c.task.id) === index)
      .sort((a, b) => time(b.deliverables?.reportedAt) - time(a.deliverables?.reportedAt))
      .map((c) => ({ task: c.task.id, title: rows.get(c.task.id)?.title ?? c.task.id, items: c.deliverables!.items }));
    const { fact, action } = factOf(request, mine, delivered);
    const group = groupOf(request, fact);
    const own = mine.flatMap((row) => [row.card, ...row.asks]).filter((s): s is Section => !!s && !s.history);
    const tasks = mine.filter((row) => row.home === request.n);
    const joined = mine.filter((row) => row.home !== request.n);
    const elsewhere = openAsks(joined);
    blocks.push({
      kind: "request",
      key: `r${request.n}`,
      request,
      group,
      fact,
      action: group === "done" ? null : action,
      asks: tasks.flatMap((row) => row.asks).sort(asked),
      askedElsewhere: elsewhere.length
        ? { home: elsewhere[0].row.home, key: elsewhere[0].ask.key, title: elsewhere[0].ask.ask?.question || elsewhere[0].ask.title, count: elsewhere.length }
        : null,
      delivered,
      tasks,
      joined,
      unread: own.some(changedSinceSeen),
      ...requestProgress(request, tasks, joined),
      last: Math.max(
        time(request.createdAt),
        ...own.map((s) => time(s.updatedAt)),
        ...request.lines.map((l) => time(l.at)),
        ...request.notes.map((n) => time(n.at)),
        ...request.replies.map((r) => time(r.at)),
      ),
    });
  }
  blocks.sort((a, b) =>
    ORDER[a.group] - ORDER[b.group] ||
    (a.group === "needs" ? RANK[a.fact.kind] - RANK[b.fact.kind] : 0) ||
    b.last - a.last ||
    b.request.n - a.request.n);
  const taken = new Set(rows.keys());
  const rest = unique(sections).filter((s) => !s.history && !isPlaceholder(s) && !taken.has(taskOf(s) ?? ""));
  const asks = rest.filter((s) => s.kind === "ask").sort(asked);
  const project: ProjectBlock | null = rest.length
    ? {
        kind: "project",
        key: "project",
        sections: rest.filter((s) => s.kind !== "ask"),
        asks,
        unread: rest.some(changedSinceSeen),
        last: Math.max(0, ...rest.map((s) => time(s.updatedAt))),
      }
    : null;
  return { blocks, project };
}

/**
 * How many requests each group has: the group heads, "Requests N" and "n need you". The Project's own block is no
 * request (R-27 §3.7): the page counts its Asks on their own.
 */
export function blockCounts(blocks: readonly RequestBlock[]) {
  const counts: Record<BlockGroup, number> = { needs: 0, doing: 0, done: 0 };
  for (const block of blocks) counts[block.group] += 1;
  return counts;
}

/** Whether `key` is an open Ask shown up front (W5): in its block's first look, or in Needs you for the Project's. A
 * jump to it opens no block. */
export function askUpFront(key: string, blocks: readonly RequestBlock[], project: ProjectBlock | null) {
  return [...blocks.flatMap((block) => block.asks), ...(project?.asks ?? [])].some((ask) => ask.key === key && openAsk(ask));
}

/** The block a section is shown in (a card link, a jump to an Ask): its task's home request's, else the Project's. */
export function blockOfSection(key: string, blocks: readonly RequestBlock[], project: ProjectBlock | null): string | null {
  for (const block of blocks) {
    for (const row of block.tasks) {
      if ([row.card, row.placeholder, ...row.earlier, ...row.asks].some((s) => s?.key === key)) return block.key;
    }
  }
  if (project && [...project.sections, ...project.asks].some((s) => s.key === key)) return project.key;
  return null;
}

/**
 * The card the project's page leads with (R-27 §3.1): of the Project's own cards, those bound to no task and written
 * by a lead (any, when the project names none, as its glance reads them), the newest status, stale or not, else the
 * newest report; null with neither. The first of two written at the same time.
 */
export function projectLine(cards: readonly Section[], editors: readonly string[] | null): Section | null {
  const ours = cards.filter((section) => !section.card && !section.history && (!editors || editors.includes(section.owner.agentId)));
  const newest = (kind: Section["kind"]) =>
    ours.filter((section) => section.kind === kind).reduce<Section | null>((best, section) => (best && time(section.updatedAt) <= time(best.updatedAt) ? best : section), null);
  return newest("status") ?? newest("report");
}

/**
 * A card's lead split into the banner's heading and the rest (R-27 §3.2): a bold opening is the heading; else its
 * first sentence (to 。！？!? or a full stop and a space); else all of it. The heading is plain text, the rest Markdown
 * as written; null without a lead (the banner then heads with the card's title).
 */
export function splitLead(lead: string | null | undefined): { head: string; rest: string | null } | null {
  const text = lead?.trim();
  if (!text) return null;
  const plain = (markdown: string) => runsText(visibleRuns(markdown)).replace(/\s+/g, " ").trim();
  const bold = /^\*\*([\s\S]+?)\*\*/.exec(text);
  const end = bold ? null : /[。！？!?]|\.(?=\s)/.exec(text);
  const cut = bold ? bold[0].length : end ? end.index + 1 : text.length;
  const head = plain(bold ? bold[1] : text.slice(0, cut));
  const rest = text.slice(cut).trim();
  return head ? { head, rest: rest || null } : { head: plain(text), rest: null };
}

/** The open items of the Checklist a card names as `summary.forYou` (R-27 §3.3), with its title and how many. */
export type ForYou = { title: string | null; open: number; items: { id: string; text: string }[] };

/**
 * What the user is asked to do on a card, as its author named it (`summary.forYou`, R-27 §3.3): its open items, in
 * the author's order; null without one, or once every item is done. Never guessed from a title or a list's words.
 */
export function forYouTodo(section: Section): ForYou | null {
  const named = summaryOf(section)?.forYou;
  if (!named) return null;
  const props = (section.body as { elements?: Record<string, { props?: Record<string, unknown> }> } | null)?.elements?.[named]?.props;
  const items = Array.isArray(props?.items) ? (props.items as { id?: unknown; text?: unknown; done?: unknown }[]) : [];
  const open = items
    .filter((item) => item && item.done !== true && typeof item.text === "string" && item.text.trim())
    .map((item, index) => ({ id: typeof item.id === "string" ? item.id : String(index), text: item.text as string }));
  if (!open.length) return null;
  return { title: typeof props?.title === "string" && props.title.trim() ? props.title : null, open: open.length, items: open };
}

/**
 * What the Project cards group holds (R-27 §3.6): the Project's cards, the banner's among them, and its Asks answered
 * before this visit (`answered`); 0 when it would hold nothing but the banner's card, which is then the banner alone,
 * with that card's own Reply, Seen and Pin (§6; the lead's call on YN-218, seq 12072).
 */
export function projectCardsCount(block: ProjectBlock | null, answered: number, lead: Section | null) {
  if (!block) return 0;
  const count = block.sections.length + answered;
  const others = count - (lead && block.sections.some((section) => section.key === lead.key) ? 1 : 0);
  return others > 0 ? count : 0;
}

/**
 * The tasks a project card names as its common items (R-38 §2.4): its LiveRefs' task items, by key, in order. Only
 * these relate the card to requests: never a task or request named in its words.
 */
export function commonTasks(section: Section | null): string[] {
  const elements = (section?.body as Body)?.elements;
  if (!elements) return [];
  const tasks = Object.values(elements).flatMap((node) =>
    node?.type === "LiveRefs" && Array.isArray(node.props?.items)
      ? (node.props.items as { kind?: unknown; id?: unknown }[]).filter((item) => item?.kind === "task" && typeof item.id === "string").map((item) => item.id as string)
      : []);
  return [...new Set(tasks)];
}

/** The requests a project card's common items serve (R-38 §2.4): each task once, with the request it is shown under. */
export function relatedRequests(section: Section | null, blocks: readonly RequestBlock[]): { task: string; n: number }[] {
  return commonTasks(section).flatMap((task) => {
    const block = blocks.find((b) => b.tasks.some((row) => row.task.id === task));
    return block ? [{ task, n: block.request.n }] : [];
  });
}
