import { useContext, useId, useState } from "react";
import { strings, useLanguage } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import { Tip, TipText } from "../Tip";
import { CardAgents } from "./card-responsible";
import { absolute, relative } from "./format";
import type { InstalledRelease, RequestPull } from "./project-talk-api";
import type { BlockCommon } from "./RequestBlocks";
import {
  barCells, type BarCell, type BlockNext, type BlockNow, type BlockStale, type BlockState, type PullFact, type RequestBlock, type Segment, type Who,
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
      accept: "For you to accept", condition: "Waiting on a condition", team: "Team on it", going: "In progress", frontDesk: "With the front desk",
    } as Record<BlockState, string>,
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
    evidencePart: { prs: (n: number) => `PRs ${n}`, delivered: (n: number) => `delivered ${n}`, answered: (n: number) => `answered ${n}`,
      said: (n: number) => `conversation ${n}` },
    by: (name: string, time: string) => `${name}, ${time}`,
    got: "Got",
    left: "Left",
    installed: "Installed (commit verified)",
    pending: "Merged · install not verified",
    open: "Not merged yet",
    updated: "Updated",
  },
  {
    state: {
      done: "已完成", deliveryFailed: "送达失败", unconfirmed: "未确认送达", decide: "等你决定", accept: "等你验收", condition: "等条件",
      team: "团队在办", going: "进行中", frontDesk: "前台在看",
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
    stale: (time, facts) => `摘要写于 ${time}${facts.length ? `；之后${facts.join("、")}` : ""}，下面可能已不准`,
    expired: "摘要已过有效期",
    fact: {
      merged: (prs) => `${prs.map((n) => `#${n}`).join("、")} 合入`,
      result: (task) => `${task} 交了 1 次结果`,
      ended: (task) => `${task} 已结束`,
      followUp: (n) => `你追问了 ${n} 次`,
    },
    stats: (task, who, prs, ago) => `${task}${who ? ` · ${who}` : ""} · ${prs} 个 PR · 最后变化 ${ago}`,
    noSummary: "还没有进度摘要，以上由 Core 统计",
    followUp: "↩ 追问",
    details: (got, left) => `明细：已得到 ${got} · 还差 ${left}`,
    detailsPlain: "明细",
    evidence: (parts) => `依据：${parts.join(" · ")}`,
    evidencePart: { prs: (n) => `PR ${n}`, delivered: (n) => `交付 ${n}`, answered: (n) => `已答提问 ${n}`, said: (n) => `对话 ${n}` },
    by: (name, time) => `${name} 写于 ${time}`,
    got: "已得到",
    left: "还差",
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
  return (
    <div className="request-details">
      {list(t.got, block.details.got)}
      {list(t.left, block.details.left)}
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
  return <StatsLine block={block} />;
}

/**
 * Core's line about the release (R-38 §2.6): the release this Core runs, by its version, and how many merged PRs
 * linked to the Project's tasks Core found by commit not to be in it (merged later, or on another line); said only
 * when Core knows every one, and never as a count of what merged on main (the lead's comment 12412).
 */
export function InstalledLine({ release, mergedAfter }: { release: InstalledRelease; mergedAfter: number | null }) {
  const t = progressText(useLanguage());
  return (
    <p className="project-installed" title={`${release.releaseId} · ${release.gitSha.slice(0, 12)}`}>
      <span>{t.installedRelease(release.version || release.releaseId)}</span>
      {mergedAfter ? <span>{t.mergedAfter(mergedAfter)}</span> : null}
    </p>
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
        <button key={task} type="button" className="home-chip now-related-chip" title={task} onClick={(event) => { event.stopPropagation(); onShowBlock(n); }}>
          R-{n}
        </button>
      ))}
    </p>
  );
}
