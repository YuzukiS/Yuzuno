import { changedSinceSeen } from "./brief-layout.ts";
import type { Deliverable, Delivery, ProjectRequest, RequestCard } from "./project-talk-api";
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
 * - Every live section bound to no request's task is the Project's own block.
 */

/** Needs you, in progress, done (confirmed by the user, YN-184). */
export type BlockGroup = "needs" | "doing" | "done";

/** The one action a block's first look offers: answer > send again > confirm done > follow up. */
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
  /** 2. A task of the block has an open Ask: the oldest, and how many more. */
  | { kind: "ask"; title: string; key: string; count: number; task: string; at: string }
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
  /** Whether the card's version is older than the user's newest reply to one of the task's Asks, while it goes on. */
  cardBeforeReply: boolean;
  /** The request it is shown under: the lowest-numbered one routed to it. */
  home: number;
  /** The other requests it serves, which name it in one line. */
  alsoFor: number[];
  title: string;
};

export type DeliveredGroup = { task: string; title: string; items: Deliverable[] };

export type RequestBlock = {
  kind: "request";
  key: string;
  request: ProjectRequest;
  group: BlockGroup;
  fact: BlockFact;
  /** None once the user confirmed it done. */
  action: BlockAction | null;
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
};

/** Every live section bound to no task a request has: the lead's overview, standing statuses, their Asks. */
export type ProjectBlock = {
  kind: "project";
  key: "project";
  group: BlockGroup;
  sections: Section[];
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
        cardBeforeReply: !!card && !ended(routed.task.status) && replied > time(card.updatedAt),
        home: request.n,
        alsoFor: [],
        title: card?.title || routed.title || placeholder?.title || id,
      });
    }
  }
  return rows;
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

/** The block's latest fact and its one action (§3.2), from its tasks (shown here or joined) and what they delivered. */
function factOf(request: ProjectRequest, rows: readonly TaskRow[], delivered: readonly DeliveredGroup[]): { fact: BlockFact; action: BlockAction } {
  if (!reached(request.delivery)) return { fact: { kind: "unconfirmed" }, action: "resend" };
  const open = rows
    .flatMap((row) => row.asks.filter((a) => a.ask?.state === "open").map((ask) => ({ ask, row })))
    .sort((a, b) => time(a.ask.updatedAt) - time(b.ask.updatedAt));
  if (open.length) {
    const { ask, row } = open[0];
    return {
      fact: { kind: "ask", title: ask.ask?.question || ask.title, key: ask.key, count: open.length, task: row.task.id, at: ask.updatedAt },
      action: "answer",
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

const groupOf = (request: ProjectRequest, fact: BlockFact): BlockGroup => {
  if (request.state === "done") return "done";
  if (fact.kind === "ask" || fact.kind === "unconfirmed" || request.state === "ended" || request.state === "answered") return "needs";
  return "doing";
};

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
    blocks.push({
      kind: "request",
      key: `r${request.n}`,
      request,
      group,
      fact,
      action: group === "done" ? null : action,
      delivered,
      tasks: mine.filter((row) => row.home === request.n),
      joined: mine.filter((row) => row.home !== request.n),
      unread: own.some(changedSinceSeen),
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
  const asks = rest.filter((s) => s.kind === "ask");
  const project: ProjectBlock | null = rest.length
    ? {
        kind: "project",
        key: "project",
        group: asks.some((a) => a.ask?.state === "open") ? "needs" : "doing",
        sections: rest.filter((s) => s.kind !== "ask"),
        asks,
        unread: rest.some(changedSinceSeen),
        last: Math.max(0, ...rest.map((s) => time(s.updatedAt))),
      }
    : null;
  return { blocks, project };
}

/** How many blocks each group has, the Project's own counted where it stands: the group heads and "n need you". */
export function blockCounts(blocks: readonly RequestBlock[], project: ProjectBlock | null) {
  const counts: Record<BlockGroup, number> = { needs: 0, doing: 0, done: 0 };
  for (const block of blocks) counts[block.group] += 1;
  if (project) counts[project.group] += 1;
  return counts;
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
