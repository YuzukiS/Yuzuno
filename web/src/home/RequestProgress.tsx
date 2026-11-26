import { useContext, useId, useState, type ReactNode } from "react";
import { CircleCheck, Hourglass, LoaderCircle, MessageCircle, TriangleAlert } from "lucide-react";
import { strings, useLanguage } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import { Tip, TipText } from "../Tip";
import { CardAgents } from "./card-responsible";
import { absolute, duration, relative } from "./format";
import type { InstalledRelease, RequestPull, RouteAgent } from "./project-talk-api";
import { talkText } from "./talk-text";
import type { BlockCommon } from "./RequestBlocks";
import {
  barCells, type BarCell, type BlockFollowUp, type BlockNext, type BlockNow, type BlockStale, type BlockState, type FollowUpItem, type FollowUpTo,
  type PullFact, type RequestBlock, type Segment, type Who,
} from "./request-blocks";

/**
 * A request block's first look by outcome (R-38 §2.2, §3): its status label, its bar of outcomes (or its task's own
 * progress), its one next step, and the line under them; in English and Simplified Chinese. Every word here is
 * drawn from Core's facts or the author's own Plan; nothing is guessed.
 */
export const progressText = strings(
  {
    state: {
      done: "Done", deliveryFailed: "Not delivered", unconfirmed: "Delivery not confirmed", decide: "Your decision",
      followUp: "Waiting for a reply", accept: "For you to accept", condition: "Waiting on a condition", team: "Team on it", going: "In progress",
      frontDesk: "With the front desk",
    } as Record<BlockState, string>,
    /** The follow-up zone (R-45 §3.2). */
    /** The follow-up zone (R-45 §3.2): the project replies, never an Agent by name (the user's choice on YN-233). */
    follow: {
      label: "Your follow-up and what came of it",
      one: "You followed up",
      many: (n: number) => `You followed up ${n} times · newest`,
      count: (n: number, replied: number) => `${n} follow-ups · ${replied} replied`,
      project: "the project", projectFirst: "The project",
      waiting: (project: ReactNode) => <>Delivered · waiting for {project} to reply</>,
      waited: (time: string) => `waiting ${time}`,
      others: (k: number) => `${k} more ${k === 1 ? "waits" : "wait"} for the project's reply`,
      replied: (project: ReactNode) => <>{project} replied</>,
      later: (project: ReactNode) => <>{project} added a note</>,
      caveat: "Not marked as a reply to any follow-up",
      unsent: "Not confirmed delivered", failed: "Not delivered", resend: "Send again",
      show: "Show in the conversation →",
      showLabel: (n: number) => `Show follow-up #${n} in the conversation`,
      deskTip: (who: string) => `The project's front desk: ${who}`,
      toTip: (names: string) => `Delivered to: ${names}`,
      list: (names: string[]) => names.join(", "),
    },
    segment: {
      available: "usable", done: "done", merged: "merged · install not verified", doing: "in progress", blocked: "waiting on a condition", todo: "not started",
    } as Record<Segment["state"], string>,
    label: {
      done: (n: number, m: number) => `Done ${n}/${m}`,
      usable: (k: number) => `usable ${k}`,
      merged: (k: number) => `${k} merged · install not verified`,
    },
    pull: {
      installed: (n: number) => `#${n} installed`,
      merged: (n: number) => `#${n} merged · install not verified`,
      draft: (n: number) => `#${n} draft`,
      closed: (n: number) => `#${n} closed, not merged`,
      open: (n: number) => `#${n} not merged`,
      unlinked: (n: number) => `#${n} not linked to the task`,
      ambiguous: (n: number) => `#${n} shared by several repositories, not verifiable`,
    },
    progress: "Progress",
    bar: (label: string, parts: string[]) => `${label}. ${parts.join("; ")}`,
    part: (name: string, state: string, count: number) => `${name}${count > 1 ? ` and ${count - 1} more` : ""}: ${state}`,
    detail: (name: string, state: string, detail: string | null) => `${name} — ${state}${detail ? `: ${detail}` : ""}`,
    asking: "has one for you",
    factJoin: "; ",
    next: "Next",
    step: (who: string, step: string) => (who ? `${who}: ${step}` : step),
    nextAccept: "Confirm it done, or follow up",
    nextElsewhere: (task: string, home: number) => `${task} has one for you ↑ under R-${home}`,
    show: "Show →",
    common: "depends on a project-wide item ↗",
    installedRelease: (release: string) => `Installed ${release}`,
    mergedAfter: (n: number) => `${n} merged ${n === 1 ? "PR" : "PRs"} linked to this project ${n === 1 ? "is" : "are"} not in this version`,
    related: "Related requests",
    replied: (who: string) => `${who} replied`,
    stale: (time: string, facts: string[]) => `Summary written ${time}${facts.length ? `; since then ${facts.join(", ")}` : ""}: what follows may be out of date`,
    expired: "Summary past its validity",
    fact: {
      merged: (prs: number[]) => `${prs.map((n) => `#${n}`).join(", ")} merged`,
      result: (task: string) => `${task} reported a result`,
      ended: (task: string) => `${task} ended`,
      followUp: (n: number) => `you followed up ${n === 1 ? "once" : `${n} times`}`,
    },
    stats: (task: string, who: string | null, prs: number, ago: string) =>
      `${task}${who ? ` · ${who}` : ""} · ${prs} ${prs === 1 ? "PR" : "PRs"} · last change ${ago}`,
    noSummary: "No progress summary yet; the line above is Core's count",
    followUp: "↩ Follow up",
    details: (got: number, left: number) => `Details: ${got} got · ${left} left`,
    detailsPlain: "Details",
    evidence: (parts: string[]) => `Evidence: ${parts.join(" · ")}`,
    evidencePart: { prs: (n: number) => `PRs ${n}`, delivered: (n: number) => `delivered ${n}`, answered: (n: number) => `answered ${n}` },
    by: (name: string, time: string) => `${name}, ${time}`,
    got: "Got",
    left: "Left",
    relay: "Planned hand-offs after this",
    installed: "Installed (commit verified)",
    pending: "Merged · install not verified",
    open: "Not merged yet",
    updated: "Updated",
  },
  {
    state: {
      done: "已完成", deliveryFailed: "送达失败", unconfirmed: "未确认送达", decide: "等你决定", followUp: "等回复", accept: "等你验收", condition: "等条件",
      team: "团队在办", going: "进行中", frontDesk: "前台在看",
    },
    follow: {
      label: "你的追问和回复",
      one: "你追问",
      many: (n) => `你追问 ${n} 次 · 最近一条`,
      count: (n, replied) => `共 ${n} 条 · ${replied} 条已回复`,
      project: "项目", projectFirst: "项目",
      waiting: (project) => <>已送达 · 等{project}回复</>,
      waited: (time) => `已等 ${time}`,
      others: (k) => `另 ${k} 条也在等项目回复`,
      replied: (project) => <>{project}回复</>,
      later: (project) => <>{project}后续留言</>,
      caveat: "这条留言没有标明回复的是哪条追问",
      unsent: "没确认送达", failed: "送达失败", resend: "再发一次",
      show: "在对话中查看 →",
      showLabel: (n) => `在对话中查看追问 #${n}`,
      deskTip: (who) => `项目的前台：${who}`,
      toTip: (names) => `送达：${names}`,
      list: (names) => names.join("、"),
    },
    segment: { available: "可用", done: "完成", merged: "已合入 · 安装待核实", doing: "在做", blocked: "等条件", todo: "未开始" },
    label: {
      done: (n, m) => `完成 ${n}/${m}`,
      usable: (k) => `可用 ${k}`,
      merged: (k) => `${k} 项已合入 · 安装待核实`,
    },
    pull: {
      installed: (n) => `#${n} 已装`,
      merged: (n) => `#${n} 已合入 · 安装待核实`,
      draft: (n) => `#${n} 草稿`,
      closed: (n) => `#${n} 已关闭、未合入`,
      open: (n) => `#${n} 未合入`,
      unlinked: (n) => `#${n} 任务没有关联这个 PR`,
      ambiguous: (n) => `#${n} 有多个仓库同号，无法核实`,
    },
    progress: "进度",
    bar: (label, parts) => `${label}。${parts.join("；")}`,
    part: (name, state, count) => `${name}${count > 1 ? `等 ${count} 项` : ""}：${state}`,
    detail: (name, state, detail) => `${name} — ${state}${detail ? `：${detail}` : ""}`,
    asking: "有一项等你",
    factJoin: "；",
    next: "下一步",
    step: (who, step) => (who ? `${who}：${step}` : step),
    nextAccept: "你确认完成，或继续跟进",
    nextElsewhere: (task, home) => `${task}有一项等你 ↑ 在 R-${home} 下`,
    show: "查看 →",
    common: "依赖共同事项 ↗",
    installedRelease: (release) => `已装 ${release}`,
    mergedAfter: (n) => `当前版本未包含本项目关联的 ${n} 个已合并 PR`,
    related: "相关请求",
    replied: (who) => `${who} 回复`,
    stale: (time, facts) => `摘要写于 ${time}${facts.length ? `；之后${facts.join("、")}` : ""}，下面可能已不准`,
    expired: "摘要已过有效期",
    fact: {
      merged: (prs) => `${prs.map((n) => `#${n}`).join("、")} 合入`,
      result: (task) => `${task} 交了 1 次结果`,
      ended: (task) => `${task} 已结束`,
      followUp: (n) => `你追问了 ${n} 次`,
    },
    stats: (task, who, prs, ago) => `${task}${who ? ` · ${who}` : ""} · ${prs} 个 PR · 最后变化 ${ago}`,
    noSummary: "还没有进度摘要，上一行由 Core 统计",
    followUp: "↩ 追问",
    details: (got, left) => `明细：已得到 ${got} · 还差 ${left}`,
    detailsPlain: "明细",
    evidence: (parts) => `依据：${parts.join(" · ")}`,
    evidencePart: { prs: (n) => `PR ${n}`, delivered: (n) => `交付 ${n}`, answered: (n) => `已答提问 ${n}` },
    by: (name, time) => `${name} 写于 ${time}`,
    got: "已得到",
    left: "还差",
    relay: "之后的接力（计划）",
    installed: "已装（提交已核实）",
    pending: "已合入 · 安装待核实",
    open: "未合入",
    updated: "有更新",
  },
);

/** The status label (§2.3): a state, never the condition's own words. Waiting for the user is the solid mark. */
export function StateMark({ state }: { state: BlockState }) {
  const t = progressText(useLanguage());
  return <span className="request-state" data-state={state}>{t.state[state]}</span>;
}

/**
 * The label beside a bar: done n of m, whatever kind of work, and apart from it what Core verified usable in the
 * release and what merged with its install not verified (the lead's rule on YN-227, comment 12387).
 */
function barLabel(now: BlockNow & { kind: "bar" }, t: ReturnType<typeof progressText>) {
  return [t.label.done(now.done, now.total), now.available ? t.label.usable(now.available) : null, now.merged ? t.label.merged(now.merged) : null]
    .filter(Boolean)
    .join(" · ");
}

/** What is known of one PR a step names. */
function pullFact(fact: PullFact, t: ReturnType<typeof progressText>) {
  if (fact.kind !== "linked") return t.pull[fact.kind](fact.number);
  const { pr } = fact;
  if (pr.state === "merged") return pr.installed === true ? t.pull.installed(fact.number) : t.pull.merged(fact.number);
  return t.pull[pr.state === "draft" ? "draft" : pr.state === "closed" ? "closed" : "open"](fact.number);
}

/** A step's detail and the facts of its PRs, as one line's tail. */
function detailOf(segment: Pick<Segment, "detail" | "facts">, t: ReturnType<typeof progressText>) {
  const parts = [segment.detail, ...segment.facts.map((fact) => pullFact(fact, t))].filter(Boolean);
  return parts.length ? parts.join(t.factJoin) : null;
}

/**
 * The bar of a block's outcomes (§3): one cell each, equal widths, its short name under it; each a button that shows
 * "name — state: detail" under the bar, one at a time, and hides it again. Read aloud as its label, then each
 * outcome and its state.
 */
export function ProgressBar({ now, dim }: { now: BlockNow & { kind: "bar" }; dim: boolean }) {
  const t = progressText(useLanguage());
  const [shown, setShown] = useState<string | null>(null);
  const detailId = useId();
  const cells = barCells(now.segments);
  const label = barLabel(now, t);
  const stateOf = (cell: BarCell) => `${t.segment[cell.state]}${cell.segments.some((s) => s.asking) ? ` · ${t.asking}` : ""}`;
  const open = cells.find((cell) => cell.key === shown);
  return (
    <div className="request-bar" data-dim={dim ? "" : undefined}>
      <span className="request-bar-label">{label}</span>
      <div className="request-bar-cells" role="group" aria-label={t.bar(label, cells.map((cell) => t.part(cell.segments[0].name, stateOf(cell), cell.segments.length)))}>
        {cells.map((cell) => (
          <div key={cell.key} className="request-bar-cell">
            <button
              type="button"
              className="request-bar-seg"
              data-state={cell.state}
              data-asking={cell.segments.some((s) => s.asking) ? "" : undefined}
              aria-pressed={shown === cell.key}
              aria-controls={detailId}
              aria-label={t.part(cell.segments[0].name, stateOf(cell), cell.segments.length)}
              onClick={() => setShown(shown === cell.key ? null : cell.key)}
            >
              {cell.segments.length > 1 && <span className="request-bar-count">{cell.segments.length}</span>}
            </button>
            <span className="request-bar-name" aria-hidden="true">{cell.segments[0].name}</span>
          </div>
        ))}
      </div>
      <p className="request-bar-detail" id={detailId} aria-live="polite">
        {open && open.segments.map((s) => <span key={s.id}>{t.detail(s.name, stateOf({ ...open, segments: [s] }), detailOf(s, t))}</span>)}
      </p>
    </div>
  );
}

/** The one next step (§2.3); an open Ask is the first look itself, so it has no line. */
export function NextLine({ next, onShowBlock, common }: { next: BlockNext; onShowBlock: (n: number) => void; common?: BlockCommon }) {
  const t = progressText(useLanguage());
  const agents = useContext(CardAgents);
  const name = (who: Who | null) => (who ? agents.get(who.agentId)?.name || who.name : "");
  if (next.kind === "ask") return null;
  let text: string;
  switch (next.kind) {
    case "accept":
      text = t.nextAccept;
      break;
    case "elsewhere":
      text = t.nextElsewhere(next.task, next.home);
      break;
    case "condition":
      text = next.text;
      break;
    case "step":
      text = t.step(name(next.who), next.text);
      break;
  }
  return (
    <p className="request-next" data-kind={next.kind}>
      <span className="request-next-label">{t.next}</span>
      <span className="request-next-text">{text}</span>
      {next.kind === "elsewhere" && (
        <button type="button" className="talk-link" onClick={() => onShowBlock(next.home)}>
          {t.show}
        </button>
      )}
      {/* R-38 §2.2: the condition is one of the project's common items, said once in the lead's card. */}
      {next.kind === "condition" && common?.commonTasks?.has(next.task) && common.onShowNow && (
        <button type="button" className="talk-link request-next-common" onClick={common.onShowNow}>
          {t.common}
        </button>
      )}
    </p>
  );
}

/** That the progress was written before later facts (§2.5): when, and at most three kinds of what came after. */
export function StaleLine({ stale }: { stale: BlockStale }) {
  const language = useLanguage();
  const t = progressText(language);
  const time = useTimeDisplay();
  const facts = stale.facts.map((fact) => {
    switch (fact.kind) {
      case "merged":
        return t.fact.merged(fact.prs);
      case "result":
        return t.fact.result(fact.task);
      case "ended":
        return t.fact.ended(fact.task);
      case "followUp":
        return t.fact.followUp(fact.count);
    }
  });
  return (
    <Tip content={<TipText title={absolute(stale.at, time)} />} describe={false}>
      <p className="request-stale">{facts.length ? t.stale(relative(stale.at, language), facts) : t.expired}</p>
    </Tip>
  );
}

/** A request with no progress summary (§2.5): Core's own count, and that no summary was written. */
export function StatsLine({ block }: { block: RequestBlock }) {
  const language = useLanguage();
  const t = progressText(language);
  const agents = useContext(CardAgents);
  const row = block.tasks[0] ?? block.joined[0];
  if (!row) return null;
  const who = row.responsible ? agents.get(row.responsible.agentId)?.name || row.responsible.name : null;
  const prs = new Set(block.tasks.concat(block.joined).flatMap((r) => r.prs.map((pr) => `${pr.repository}#${pr.number}`))).size;
  return (
    <p className="request-stats">
      <span>{t.stats(row.task.id, who, prs, relative(new Date(block.last).toISOString(), language))}</span>
      <span className="request-stats-note">{t.noSummary}</span>
    </p>
  );
}

/** One PR of the evidence: its number and title, linked, and when it merged. */
function PullLine({ pr }: { pr: RequestPull }) {
  const language = useLanguage();
  return (
    <li>
      <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a> {pr.title ?? ""}
      {pr.mergedAt && <span className="request-evidence-at"> · {relative(pr.mergedAt, language)}</span>}
    </li>
  );
}

/** The evidence, unfolded (§2.6): the PRs by whether the release has them, by commit only. */
export function EvidenceList({ block }: { block: RequestBlock }) {
  const t = progressText(useLanguage());
  const groups = [
    ["installed", t.installed, block.evidence.installed],
    ["pending", t.pending, block.evidence.pending],
    ["open", t.open, block.evidence.open],
  ] as const;
  return (
    <div className="request-evidence">
      {groups.filter(([, , prs]) => prs.length).map(([key, title, prs]) => (
        <section key={key} data-evidence={key}>
          <h4>{title} {prs.length}</h4>
          <ul>{prs.map((pr) => <PullLine key={`${pr.repository}#${pr.number}`} pr={pr} />)}</ul>
        </section>
      ))}
    </div>
  );
}

/** What a block has and still lacks, by outcome, unfolded under Details. */
export function DetailLists({ block }: { block: RequestBlock }) {
  const t = progressText(useLanguage());
  if (!block.details) return null;
  const list = (title: string, items: NonNullable<RequestBlock["details"]>["got"]) =>
    items.length > 0 && (
      <section>
        <h4>{title} {items.length}</h4>
        <ul>{items.map((item) => <li key={`${item.task}:${item.name}`} data-state={item.state}>{t.detail(item.name, t.segment[item.state], detailOf(item, t))}</li>)}</ul>
      </section>
    );
  const relay = block.details.relay;
  return (
    <div className="request-details">
      {list(t.got, block.details.got)}
      {list(t.left, block.details.left)}
      {/* R-38 §2.2: what its lead plans after these, in order; words only, nothing here is the user's to do now. */}
      {relay.length > 0 && (
        <section data-relay="">
          <h4>{t.relay}</h4>
          <ol className="request-relay">{relay.map((step, i) => <li key={`${step.task}:${i}`} data-state={step.state}>{step.text}</li>)}</ol>
        </section>
      )}
    </div>
  );
}

/** The first look's progress: the bar, or its task's own progress, or Core's count with no summary. */
export function NowLine({ block }: { block: RequestBlock }) {
  const t = progressText(useLanguage());
  const now = block.now;
  if (now?.kind === "bar") return <ProgressBar now={now} dim={!!block.stale} />;
  if (now?.kind === "progress")
    return (
      <p className="request-progress" data-dim={block.stale ? "" : undefined}>
        <span className="request-bar-label">{t.progress}</span>
        <span>{now.text}</span>
      </p>
    );
  return (
    <>
      {block.reply && <ReplyLine reply={block.reply} />}
      <StatsLine block={block} />
    </>
  );
}

/**
 * The front desk's newest reply (R-43): with no progress yet, the last the project said to the user is its first
 * look, not only in the folded conversation. At most three lines; the whole of it stays in the conversation.
 */
function ReplyLine({ reply }: { reply: NonNullable<RequestBlock["reply"]> }) {
  const language = useLanguage();
  const t = progressText(language);
  const time = useTimeDisplay();
  const agents = useContext(CardAgents);
  const who = agents.get(reply.by.agentId)?.name || reply.by.name;
  return (
    <p className="request-reply">
      <span className="request-bar-label">{t.replied(who)}</span>
      <span className="request-reply-text">{reply.text}</span>
      <Tip content={<TipText title={absolute(reply.at, time)} />} describe={false}>
        <time className="request-reply-at" dateTime={reply.at}>{relative(reply.at, language)}</time>
      </Tip>
    </p>
  );
}

/**
 * Core's line about the release (R-38 §2.6): the release this Core runs, by its version, and how many merged PRs
 * linked to the Project's tasks Core found by commit not to be in it (merged later, or on another line); said only
 * when Core knows every one, and never as a count of what merged on main (the lead's comment 12412).
 */
export function InstalledLine({ release, mergedAfter }: { release: InstalledRelease; mergedAfter: number | null }) {
  const t = progressText(useLanguage());
  return (
    <Tip content={<TipText title={`${release.releaseId} · ${release.gitSha.slice(0, 12)}`} />} describe={false}>
      <p className="project-installed">
        <span>{t.installedRelease(release.version || release.releaseId)}</span>
        {mergedAfter ? <span>{t.mergedAfter(mergedAfter)}</span> : null}
      </p>
    </Tip>
  );
}

/** The requests the lead's card names among its common items (R-38 §2.4), each a way to its block. */
export function RelatedRequests({ related, onShowBlock }: { related: readonly { task: string; n: number }[]; onShowBlock: (n: number) => void }) {
  const t = progressText(useLanguage());
  if (!related.length) return null;
  return (
    <p className="now-related">
      <span className="now-related-label">{t.related}</span>
      {related.map(({ task, n }) => (
        <Tip key={task} content={<TipText title={task} />} describe={false}>
          <button type="button" className="home-chip now-related-chip" onClick={(event) => { event.stopPropagation(); onShowBlock(n); }}>
            R-{n}
          </button>
        </Tip>
      ))}
    </p>
  );
}

/**
 * An Agent's name as the page knows it, else as Core named it, else "an Agent" (R-45 §3.2). The words name only the
 * project, which replies to the user (the user's choice on YN-233): a name is said in the tip of "the project" only.
 */
export function useFollowUpName() {
  const agents = useContext(CardAgents);
  const someone = talkText(useLanguage()).someone;
  return (who: FollowUpTo | RouteAgent) => agents.get(who.agentId)?.name || who.name || someone;
}

/** "The project" in the words, its tip saying who that is (R-45 §3.2): the front desk, or whom a follow-up went to. */
export function ProjectWord({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <Tip content={<TipText title={tip} />}>
      <b className="request-follow-project">{children}</b>
    </Tip>
  );
}

const FOLLOW_ICON: Record<FollowUpItem["state"], typeof Hourglass> = {
  waiting: Hourglass, unsent: TriangleAlert, answered: CircleCheck, later: MessageCircle,
};

/**
 * The user's newest follow-up and what came of it, in the block's first look (R-45 §3.2): how many there are and how
 * many the project replied to; its words, two lines at most; then that it waits for the project's reply and since when,
 * or the project's reply (three lines at most), or the project's later note, said to reply to none, or that it is not
 * confirmed delivered, with Send again. Only "the project" speaks here; its tip names the front desk, or, for a
 * follow-up that went to someone else (before R-45), whom it went to. Its link opens the request's conversation at it.
 * Nothing for a request with none.
 */
export function FollowUpZone({ follow, front, onShow, onResend, resending = false, readOnly = false }: {
  follow: BlockFollowUp;
  /** The request's front desk, by ID (`frontAgentId`). */
  front: string;
  /** Opens the conversation at follow-up `n`, the lines named with it marked. */
  onShow: (n: number, marked: string[]) => void;
  /** Sends follow-up `n` again as Core keeps it. */
  onResend?: (n: number) => void;
  resending?: boolean;
  readOnly?: boolean;
}) {
  const language = useLanguage();
  const t = progressText(language).follow;
  const time = useTimeDisplay();
  const nameOf = useFollowUpName();
  const { latest, items } = follow;
  const when = (at: string) => (
    <Tip content={<TipText title={absolute(at, time)} />} describe={false}>
      <time dateTime={at}>{relative(at, language)}</time>
    </Tip>
  );
  // Who "the project" is: whoever wrote the note, as the front desk; for a follow-up waiting, its front desk, or, when
  // it went to others, them.
  const project = (word: string, by: RouteAgent | null) => {
    const to = latest.to;
    const tip = by ? t.deskTip(nameOf(by))
      : to.length && to.every((agent) => agent.agentId === front) ? t.deskTip(nameOf(to[0]))
        : to.length ? t.toTip(t.list(to.map(nameOf))) : t.deskTip(nameOf({ agentId: front, name: "" }));
    return <ProjectWord tip={tip}>{word}</ProjectWord>;
  };
  const others = items.filter((item) => item.n !== latest.n && item.state === "waiting").length;
  const Icon = FOLLOW_ICON[latest.state];
  let status: ReactNode;
  switch (latest.state) {
    case "waiting": {
      const seconds = Math.max(60, (Date.now() - Date.parse(latest.at)) / 1000);
      status = (
        <>
          <span>{t.waiting(project(t.project, null))}</span>{" "}
          <span className="request-follow-who">· {t.waited(duration(seconds, language))}</span>
          {others > 0 && <span className="request-follow-more">{t.others(others)}</span>}
        </>
      );
      break;
    }
    case "unsent":
      status = (
        <>
          <span>{latest.failed ? t.failed : t.unsent}</span>
          {onResend && !readOnly && (
            <>
              {" · "}
              <button type="button" className="talk-link" disabled={resending} onClick={() => onResend(latest.n)}>
                {resending && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
                {t.resend}
              </button>
            </>
          )}
        </>
      );
      break;
    case "answered":
      status = (
        <>
          <span className="request-follow-who">{t.replied(project(t.projectFirst, latest.note.by))} · {when(latest.note.at)}</span>
          <span className="request-follow-answer">{latest.note.note}</span>
        </>
      );
      break;
    case "later":
      status = (
        <>
          <span className="request-follow-who">{t.later(project(t.projectFirst, latest.note.by))} · {when(latest.note.at)}</span>
          <span className="request-follow-answer">{latest.note.note}</span>
          <span className="request-follow-caveat">{t.caveat}</span>
        </>
      );
      break;
  }
  // The lines its jump marks: the follow-up, the note that answers it or came after it, and the follow-ups that note
  // came after alike (R-45 §3.4).
  const marked =
    latest.state === "answered" ? [`note:${latest.note.n}`]
      : latest.state === "later" ? [`note:${latest.note.n}`, ...latest.together.filter((n) => n !== latest.n).map((n) => `reply:${n}`)]
        : [];
  return (
    <section className="request-follow" data-state={latest.state} aria-label={t.label}>
      <p className="request-follow-head">
        <b>{items.length > 1 ? t.many(items.length) : t.one}</b> · {when(latest.at)}
        {items.length > 1 && <span className="request-follow-count">{t.count(items.length, follow.answered)}</span>}
      </p>
      <p className="request-follow-said">{latest.text}</p>
      <div className="request-follow-status" data-kind={latest.state}>
        <span className="request-follow-icon" aria-hidden="true"><Icon size={12} /></span>
        <p className="request-follow-lines">
          {status}
        </p>
      </div>
      <p className="request-follow-foot">
        <button type="button" className="talk-link" aria-label={t.showLabel(latest.n)} onClick={() => onShow(latest.n, marked)}>
          {t.show}
        </button>
      </p>
    </section>
  );
}
