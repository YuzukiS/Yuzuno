import { clockMs, islandTime, type IslandView } from "./agent-island";
import { IslandRing, islandText, stayText, stayTone } from "./AgentIsland";
import type { ExecutorView } from "./executor-display";
import { lifecycleText, type ExecutorLifecycle, type ExecutorRoute } from "./executor-lifecycle";
import { modelShort } from "./executor-routing";
import { harnessName } from "./executor-routing-text";
import { shortFingerprint } from "./routing-keys";
import { timeFormatter, useTimeDisplay, type TimeDisplay } from "./time-preferences";
import { executorRowText, prText } from "./ExecutorRowState";
import { strings, useLanguage, type Language } from "./i18n";
import { useMinute } from "./live-executors";
import type { Agent } from "./types";
import "./agent-row-card.css";

// The card's own words (YN-44); the rest are the island's. What Agents and
// Core wrote is shown as it came.
export const cardText = strings({
  clock: {
    onTask: (x: string) => `on its task for ${x}`,
    live: (x: string) => `for ${x}`,
    waiting: (x: string) => `waiting ${x}`,
    ended: (x: string) => `Turn ended ${x} ago`,
    last: (x: string) => `last Turn ${x} ago`,
    since: (x: string) => `${x} ago`,
    total: (x: string) => `${x} in total`,
  },
  /** What a state means, where the ring alone doesn't say it. */
  meaning: {
    waiting: "Waits for your answer in Home's Needs you",
    done: "This device hasn't shown this Turn's end yet",
  },
  /** What a state that stays means, beside its pill. */
  stay: {
    queued: "Waits for an executor slot; starts in turn",
    candidate: "Waits for a routing candidate; starts once one's conditions hold",
    starting: "Has its slot; its runtime is starting",
    lead: "Handed in; the lead reviews it next",
    review: "A review round is under way on its PR",
    changes: "The review asked for changes on its PR",
    ciFailed: "Checks failed on its PR's latest commit",
    ready: "Approved; merges once checks are green",
    merged: "Its PR is merged",
    offline: "Its runtime is disconnected",
  },
  unread: "Updates unread",
  leadOf: "Lead of this Project",
  // The template it was made from and what routing gave it (YN-57 S4b), as the routing page names them.
  template: (label: string) => `Template: ${label}`,
  templateNone: "Template: none",
  route: (what: string) => `Route: ${what}`,
  routeWaiting: (from: string | null) => (from ? `Route: waiting for a candidate · from ${from}` : "Route: waiting for a candidate"),
  unrouted: (why: string) => ({
    none: "Not routed at its dispatch",
    fixed: "Not routed: its template is fixed",
    routingOff: "Not routed: routing was turned off while it waited; started on the host's login",
    noCandidate: "Not routed: no candidate was left for it; started on the host's login",
  } as Record<string, string>)[why] ?? `Not routed: ${why}`,
  credLogin: "this host's login",
  credKey: (id: string) => `API key ${id}`,
  credPool: (n: number | null, fingerprint: string) => (n != null ? `claude-swap #${n} · ${fingerprint}` : `claude-swap · ${fingerprint}`),
  credHome: (id: string) => `Codex account ${id}`,
  // YN-70: the kind of work it was dispatched for, and whose that was.
  tier: (tier: string, source?: string) => `${tier === "strong" ? "strong" : tier === "fast" ? "fast" : tier} work${
    source === "template" ? " (template)" : source === "lead" ? " (lead)" : source === "user" ? " (you)" : ""}`,
}, {
  clock: {
    onTask: (x) => `已用 ${x}`,
    live: (x) => `已用 ${x}`,
    waiting: (x) => `已等 ${x}`,
    ended: (x) => `${x}前结束`,
    last: (x) => `上一轮 ${x}前`,
    since: (x) => `${x}前`,
    total: (x) => `共用 ${x}`,
  },
  meaning: {
    waiting: "在 Home 的「等你」里等你回答",
    done: "这一轮的结束你在这台设备上还没看过",
  },
  stay: {
    queued: "在等执行者槽位，按顺序启动",
    candidate: "在等路由候选；有候选满足条件就启动",
    starting: "已占到槽位，运行时正在启动",
    lead: "已交付，接下来由负责人审查",
    review: "它的 PR 正在进行一轮审查",
    changes: "审查要求修改它的 PR",
    ciFailed: "它的 PR 最新提交的检查失败了",
    ready: "已通过审查，检查变绿后即可合并",
    merged: "它的 PR 已合入",
    offline: "它的运行时已断开",
  },
  unread: "有未读更新",
  leadOf: "此 Project 的负责人",
  template: (label) => `模板：${label}`,
  templateNone: "模板：无",
  route: (what) => `路由：${what}`,
  routeWaiting: (from) => (from ? `路由：在等一个候选 · 最早 ${from}` : "路由：在等一个候选"),
  unrouted: (why) => ({
    none: "派发时没有经过路由",
    fixed: "未经路由：模板固定了工具和模型",
    routingOff: "未经路由：等候选时路由被关了，按主机的登录启动",
    noCandidate: "未经路由：没有能给它的候选了，按主机的登录启动",
  } as Record<string, string>)[why] ?? `未经路由：${why}`,
  credLogin: "主机的登录",
  credKey: (id) => `API key ${id}`,
  credPool: (n, fingerprint) => (n != null ? `claude-swap #${n} · ${fingerprint}` : `claude-swap · ${fingerprint}`),
  credHome: (id) => `Codex 账号 ${id}`,
  tier: (tier, source) => `${tier === "strong" ? "强" : tier === "fast" ? "快" : tier}活${
    source === "template" ? "（模板）" : source === "lead" ? "（负责人）" : source === "user" ? "（你）" : ""}`,
});

/** A route's time as the card writes it: "04:00", in the user's clock format and time zone. */
const routeAt = timeFormatter({ hour: "2-digit", minute: "2-digit" });

/** What routing gave an executor, in a line (YN-57 S4b): "Route: OpenCode · deepseek-flash · API key deepseek-main". */
export function routeLine(route: ExecutorRoute, language: Language, time?: TimeDisplay): string {
  const t = cardText(language);
  // YN-70: the kind of work it was dispatched for goes last, whatever routing did.
  const tier = route.tier ? ` · ${t.tier(route.tier, route.tierSource)}` : "";
  if (route.kind === "unrouted") return t.unrouted(route.why) + tier;
  if (route.kind === "waiting") {
    const at = route.earliest ? Date.parse(route.earliest) : NaN;
    return t.routeWaiting(Number.isFinite(at) ? routeAt(time).format(at) : null) + tier;
  }
  const c = route.credential;
  const credential = c.kind === "apiKey" ? t.credKey(c.keyId) : c.kind === "codexHome" ? t.credHome(c.id)
    : c.kind === "pool" ? t.credPool(c.account.number, shortFingerprint(c.account.fingerprint)) : t.credLogin;
  return t.route([harnessName[route.harness as keyof typeof harnessName] ?? route.harness, modelShort(route.model ?? ""), route.effort, credential]
    .filter(Boolean).join(" · ")) + tier;
}

/** Since when, as the card says it: "on its task for 1h12m", "waiting
 * 12m", "Turn ended 3m ago", "last Turn 26m ago", "1h12m in total". */
export function cardClock(island: IslandView, agent: Pick<Agent, "closedAt">, executor: boolean, now: number, language: Language): string | null {
  const clock = island.clock;
  if (!clock) return null;
  const t = cardText(language).clock;
  const x = islandTime(clockMs(clock, now), language);
  if (clock.kind === "total") return t.total(x);
  if (clock.kind === "since") {
    if (!executor && island.state === "done") return t.ended(x);
    // A standing Agent at rest: since its last Turn ended (not closed, not offline).
    if (!executor && island.state === "idle" && !island.stay && !agent.closedAt) return t.last(x);
    return t.since(x);
  }
  if (island.state === "waiting") return t.waiting(x);
  return executor && island.state === "working" ? t.onTask(x) : t.live(x);
}

/**
 * The Agent row's card (YN-44): one card for the whole row, its ring
 * included, beside it. What the row shortens or leaves out, top to bottom:
 *  1. its name, or an executor's task by its short name;
 *  2. its ring, its state in words (or the pill of a state that stays) and
 *     since when;
 *  3. what it is doing or asks, in full;
 *  4. what the state means where the ring alone doesn't say it (needs you,
 *     done, a state that stays), and a lead's updates unread;
 *  5. quietly: its task, who and where it is, its PR and who dispatched it.
 * Never where a click goes (the user, YN-44).
 */
export function AgentRowCard({ agent, island, executor, lifecycle, machine, badge, activity, waits }: {
  agent: Agent;
  island: IslandView;
  executor: ExecutorView | null;
  lifecycle: ExecutorLifecycle | null;
  machine: string;
  /** A lead's badge. */
  badge: string | null;
  /** Line two in full: what it is doing, asks or last said. */
  activity: string;
  /** A standing Agent's unfinished Jobs and CI, in full: "2 jobs queued or running". */
  waits?: string | null;
}) {
  const language = useLanguage();
  const now = useMinute();
  const time = useTimeDisplay();
  const t = cardText(language);
  const words = islandText(language);
  const title = island.title ?? agent.name;
  const stay = island.stay;
  const clock = cardClock(island, agent, !!executor, now, language);
  // An idle ring with a state that stays: the pill says the state.
  const word = stay && island.state === "idle" ? null : words.word[island.state];
  const meaning = stay ? t.stay[stay.kind]
    : island.state === "waiting" ? t.meaning.waiting
      : island.state === "done" && !executor ? t.meaning.done
        : null;
  const facts: string[] = [];
  if (lifecycle) {
    const states = lifecycleText(language);
    const rows = executorRowText(language);
    const task = lifecycle.task;
    if (task) facts.push(task.title.trim() && task.title.trim() !== title ? `${task.id} · ${task.title}` : task.id);
    facts.push([agent.name, machine].filter(Boolean).join(" · "));
    // The template it was made from, and what routing gave it (YN-57 S4b): never a key's value or an email.
    const template = lifecycle.template;
    if (template) facts.push(template.id === "" ? t.templateNone : t.template(template.label || template.id));
    if (lifecycle.route) facts.push(routeLine(lifecycle.route, language, time));
    const by = lifecycle.dispatcher;
    const dispatched = by ? (by.kind === "user" ? states.byUser : states.byAgent(by.name || by.id)) : null;
    const pr = executor?.pr ? `${rows.pr(executor.pr.number)} · ${prText(executor.pr.status, rows)}` : null;
    if (pr || dispatched) facts.push([pr, dispatched].filter(Boolean).join(" · "));
    // Why it is in its state and its task's blocker, unless line two says them already.
    const { reason, blocked } = lifecycle;
    if (reason && !activity.includes(reason)) facts.push(lifecycle.state === "archiving" ? states.archivingReason(reason) : reason);
    if (blocked && !activity.includes(blocked)) facts.push(states.blocked(blocked));
  } else {
    facts.push(badge ? `${t.leadOf} · ${machine}` : machine);
  }
  return (
    <>
      <span className="tip-head">
        <strong className="tip-title">{title}</strong>
        {badge && <> <span className="agent-card-badge">{badge}</span></>}
      </span>
      <span className="agent-card-state" data-island={island.state}>
        <span className="island-ringbox" data-ring={island.state}><IslandRing state={island.state} /></span>
        {/* Spaces between the words for whoever reads the text; the flex
            layout spaces them on screen. */}
        {word && <> <span className="agent-card-word">{word}</span></>}
        {stay && <> <span className="agent-card-pill" data-tone={stayTone(stay)}>{stayText(stay, language, time)}</span></>}
        {clock && <> <span className="agent-card-clock">{clock}</span></>}
      </span>
      {activity && <span className="tip-body agent-card-activity">{activity}</span>}
      {waits && <span className="tip-body">{waits}</span>}
      {meaning && <span className="agent-card-meaning">{meaning}</span>}
      {island.dot && <span className="agent-card-unread">{t.unread}</span>}
      <span className="agent-card-facts">
        {facts.map((line, i) => <small key={i} className="tip-meta">{line}</small>)}
      </span>
    </>
  );
}
