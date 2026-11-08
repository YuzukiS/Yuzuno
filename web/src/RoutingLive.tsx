import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, CircleCheck, CircleDashed, CircleHelp, CircleMinus, CircleSlash, CircleX } from "lucide-react";
import { errorText, HttpError } from "./api";
import type { Candidate, Policy } from "./executor-routing";
import { strings, useLanguage, type Language } from "./i18n";
import { evaluate, oldestReading, readChoices, readReadings, type CandidateState, type Choice, type Reading, type Reason, type Readings, type RouteCandidate, type RouteRecord } from "./routing-live";
import { timeFormatter, useTimeDisplay } from "./time-preferences";

const text = strings({
  nowWould: "Now it would choose",
  nowNone: "No candidate is available now",
  nowEarliest: (t: string, who: string) => `New executors wait in the queue; ${who} may be available from ${t}.`,
  nowOff: "Routing is off: new executors start with their templates' own settings.",
  readAgo: (ago: string) => `From readings ${ago}`,
  noReadings: "No reading was needed",
  draft: "with your unsaved changes",
  account: (n: number) => `Account #${n}`,
  home: (id: string) => `Codex account ${id}`,
  liveUnavailable: "This Core can't say yet which candidate it would choose: that comes with routing itself (YN-34 S3b).",
  liveFailed: "Couldn't ask Core which candidate it would choose:",
  liveHeld: "Whom Core would choose shows again once the marked block is corrected.",
  liveRefused: "Core can't judge this draft yet:",
  states: { chosen: "Would choose", skipped: "Skipped", unknown: "Unknown", failed: "Start failed", notTried: "Not reached", off: "Off" } as Record<CandidateState, string>,
  accountStates: { pick: "Would use", ok: "Enough", low: "Not enough", unknown: "No reading" } as Record<string, string>,
  what: { fiveHourLeft: "5-hour left", weekLeft: "Week left", spendToday: "Spent today" } as Record<string, string>,
  justNow: "just now",
  minAgo: (n: number) => `${n} min ago`,
  hAgo: (n: number) => `${n} h ago`,
  recentTitle: "Recent choices",
  recentHelp: "Each choice is kept on its dispatch (task_get's executorSlot.route); the task's card and the executor's Overview show the same record.",
  recentNone: "No executor has been started by routing yet.",
  recentUnavailable: "Recent choices come with routing itself (YN-34 S3b).",
  at: { dispatch: "at dispatch", start: "changed before starting", preview: "preview" } as Record<string, string>,
  noneChosen: "none available",
  changedFrom: (from: string) => `Chosen again before starting, in place of ${from}`,
  spendToday: (usd: string) => `Spent today with API keys: $${usd}`,
  spendCap: (usd: string, cap: string) => `Spent today with API keys: $${usd} of $${cap}`,
  spendNote: "What the tools report, not a bill.",
  spendResets: (t: string) => `A new day starts at ${t}.`,
}, {
  nowWould: "现在会选",
  nowNone: "现在没有可用的候选",
  nowEarliest: (t, who) => `新开的执行者会排队，最早 ${t} 起 ${who} 可用。`,
  nowOff: "路由关着：新开的执行者按各自模板的固定设置启动。",
  readAgo: (ago) => `按 ${ago}的读数`,
  noReadings: "不需要读数",
  draft: "包含未保存的改动",
  account: (n) => `账号 #${n}`,
  home: (id) => `Codex 账号 ${id}`,
  liveUnavailable: "这个 Core 还说不出此刻会选哪一项：要等路由本身（YN-34 S3b）。",
  liveFailed: "没能问到 Core 此刻会选哪一项：",
  liveHeld: "改好标出的那一块，这里会再显示此刻会选谁。",
  liveRefused: "Core 还判断不了这份草稿：",
  states: { chosen: "会选这个", skipped: "跳过", unknown: "未知", failed: "启动失败", notTried: "没轮到", off: "已停用" },
  accountStates: { pick: "会用这个", ok: "够用", low: "不够", unknown: "读不到" },
  what: { fiveHourLeft: "5 小时剩", weekLeft: "本周剩", spendToday: "今日已花" },
  justNow: "刚刚",
  minAgo: (n) => `${n} 分钟前`,
  hAgo: (n) => `${n} 小时前`,
  recentTitle: "最近的选择",
  recentHelp: "每次选择都记在派发上（task_get 的 executorSlot.route），任务卡片和执行者概览也显示同一份记录。",
  recentNone: "还没有由路由启动的执行者。",
  recentUnavailable: "最近的选择要等路由本身（YN-34 S3b）。",
  at: { dispatch: "派发时", start: "启动前改选", preview: "预览" },
  noneChosen: "都不可用",
  changedFrom: (from) => `启动前改选，原来是 ${from}`,
  spendToday: (usd) => `今天用 API key 花了 $${usd}`,
  spendCap: (usd, cap) => `今天用 API key 花了 $${usd} / $${cap}`,
  spendNote: "各工具自己报的估算，不是账单。",
  spendResets: (t) => `${t} 起算新的一天。`,
});
type Text = ReturnType<typeof text>;

const clock = timeFormatter({ weekday: "short", hour: "numeric", minute: "2-digit" });
const reasonWords = (r: Reason, language: Language) => (language === "zh-Hans" ? r.messageZh : r.message);
const stateIcon: Record<CandidateState, typeof CircleCheck> = {
  chosen: CircleCheck, skipped: CircleMinus, unknown: CircleHelp, failed: CircleX, notTried: CircleDashed, off: CircleSlash,
};

function ago(ms: number, t: Text, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  return minutes < 1 ? t.justNow : minutes < 90 ? t.minAgo(minutes) : t.hAgo(Math.round(minutes / 60));
}

/** Core's evaluation of the page's policy, unsaved changes included, now:
 * asked again a moment after each change and every minute while shown. Not
 * asked while the page already knows the draft can't be saved (`held`); a
 * draft Core refuses (400) is a note, not an error. */
export function useLiveRouting(policy: Policy | null, active: boolean, held = false) {
  const [record, setRecord] = useState<RouteRecord | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [refused, setRefused] = useState("");
  const [tick, setTick] = useState(0);
  const sent = useRef(0);
  useEffect(() => {
    if (!active) return;
    const every = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(every);
  }, [active]);
  const key = policy ? JSON.stringify(policy) : "";
  useEffect(() => {
    if (!active || !policy || held) return;
    const controller = new AbortController();
    const asked = ++sent.current;
    const wait = window.setTimeout(() => {
      evaluate(policy, undefined, undefined, controller.signal).then((next) => {
        if (controller.signal.aborted || asked !== sent.current) return;
        setUnavailable(next === null);
        setRecord(next);
        setError("");
        setRefused("");
      }).catch((e) => {
        if (controller.signal.aborted || asked !== sent.current) return;
        const refusal = e instanceof HttpError && e.status === 400;
        setRefused(refusal ? errorText(e) : "");
        setError(refusal ? "" : errorText(e));
      });
    }, 350);
    return () => { window.clearTimeout(wait); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, tick, held]);
  const stale = held || !!refused;
  return { record: stale ? null : record, unavailable, error: held ? "" : error, refused: held ? "" : refused, held };
}

/** 「现在会选……」: the candidate Core would choose now, why each one before it
 * wasn't, and how old the readings were. */
export function NowCard({ record, policy, names, colourOf, changed, error, unavailable, held, refused }: {
  record: RouteRecord | null; policy: Policy; names: (c: Candidate) => string; colourOf: (id: string) => number;
  changed: boolean; error: string; unavailable: boolean; held?: boolean; refused?: string;
}) {
  const language = useLanguage();
  const t = text(language);
  const time = useTimeDisplay();
  if (unavailable) return <p className="settings-block-help routing-now-unavailable">{t.liveUnavailable}</p>;
  if (held) return <p className="settings-block-help routing-now-held">{t.liveHeld}</p>;
  if (refused) return <p className="settings-block-help routing-now-held">{t.liveRefused} <span lang="en">{refused}</span></p>;
  if (error) return <p className="inline-error routing-now-error" role="alert">{t.liveFailed} {error}</p>;
  if (!record) return null;
  if (!policy.enabled) return <div className="routing-now is-off"><p className="routing-now-title" role="status">{t.nowOff}</p></div>;
  const byId = new Map(policy.candidates.map((c, i) => [c.id, { c, i }]));
  const chosen = record.chosen ? byId.get(record.chosen) : undefined;
  const upTo = chosen ? policy.candidates.slice(0, chosen.i + 1) : policy.candidates;
  const live = new Map(record.candidates.map((c) => [c.id, c]));
  const oldest = oldestReading(record);
  const account = record.account && ("number" in record.account ? t.account(record.account.number) : t.home(record.account.home));
  const earliest = !chosen && record.earliest ? byId.get(record.earliest.candidate) : undefined;
  return (
    <div className={`routing-now${chosen ? "" : " is-wait"}`} style={chosen ? { ["--cc" as string]: `var(--route-c${colourOf(chosen.c.id)})` } : undefined}>
      <span className={`routing-num routing-now-badge${chosen ? "" : " is-wait"}`} aria-hidden="true">{chosen ? chosen.i + 1 : "…"}</span>
      <div className="routing-now-main">
        <p className="routing-now-title" role="status">
          {chosen ? <>{t.nowWould} {names(chosen.c)}{account ? ` — ${account}` : ""}</> : t.nowNone}
        </p>
        {earliest && record.earliest && Number.isFinite(Date.parse(record.earliest.at)) && (
          <p className="settings-row-help">{t.nowEarliest(clock(time).format(Date.parse(record.earliest.at)), names(earliest.c))}</p>
        )}
        <ul className="routing-now-why">
          {upTo.map((c) => {
            const why = live.get(c.id)?.reasons.map((r) => reasonWords(r, language)).join(language === "zh-Hans" ? "；" : "; ");
            return why ? <li key={c.id}><span className="routing-num is-sm" style={{ ["--cc" as string]: `var(--route-c${colourOf(c.id)})` }} aria-hidden="true">{byId.get(c.id)!.i + 1}</span>
              <span>{c.id === chosen?.c.id ? why : `${names(c)}: ${why}`}</span></li> : null;
          })}
        </ul>
        <p className="settings-row-meta">{oldest != null ? t.readAgo(ago(oldest, t)) : t.noReadings}{changed && <> · <span className="routing-now-draft">{t.draft}</span></>}</p>
      </div>
    </div>
  );
}

/** A candidate's state now, its reasons and readings, inside its card. */
export function CandidateLive({ live }: { live: RouteCandidate | undefined }) {
  const language = useLanguage();
  const t = text(language);
  if (!live) return null;
  const why = live.reasons.map((r) => reasonWords(r, language)).join(language === "zh-Hans" ? "；" : "; ");
  // Readings by account (a pool's), else the candidate's own.
  const byAccount = new Map<string, Reading[]>();
  for (const r of live.readings) byAccount.set(r.account ?? "", [...(byAccount.get(r.account ?? "") ?? []), r]);
  return (
    <div className="routing-live">
      {why && <p className="routing-why">{why}</p>}
      {live.accounts?.length ? (
        <ul className="routing-live-accounts">
          {live.accounts.map((a) => (
            <li key={a.fingerprint} className={a.state === "pick" ? "is-pick" : ""}>
              <span className="routing-live-account">{t.account(a.number)}</span>
              <Readings list={byAccount.get(String(a.number)) ?? []} t={t} />
              <span className={`settings-tag${a.state === "low" ? " is-error" : ""}`}>{t.accountStates[a.state]}</span>
            </li>
          ))}
        </ul>
      ) : byAccount.get("")?.length ? <Readings list={byAccount.get("")!} t={t} /> : null}
    </div>
  );
}

function Readings({ list, t }: { list: Reading[]; t: Text }) {
  if (!list.length) return null;
  const at = list.map((r) => (r.observedAt ? Date.parse(r.observedAt) : NaN)).filter(Number.isFinite);
  return (
    <span className="routing-readings">
      {list.map((r) => {
        const pct = typeof r.value === "number" && /Left$/.test(r.what);
        return (
          <span key={`${r.what}-${r.account ?? ""}`} className="routing-reading">
            {t.what[r.what] ?? r.what} <b>{typeof r.value === "number" ? (pct ? `${r.value}%` : r.value) : r.value}</b>
            {pct && <span className="routing-meter" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, Number(r.value)))}%` }} /></span>}
          </span>
        );
      })}
      {at.length > 0 && <span className="routing-reading-at">{ago(Math.min(...at), t)}</span>}
    </span>
  );
}

/** The candidate's state as a pill at the end of its card's head. */
export function StatePill({ state }: { state: CandidateState | undefined }) {
  const t = text(useLanguage());
  if (!state) return null;
  const Icon = stateIcon[state];
  return <span className={`routing-state is-${state}`}><Icon size={13} aria-hidden="true" />{t.states[state]}</span>;
}

/** The 20 most recent choices (S3's route_json), newest first, each opening to its record. */
export function RecentChoices({ active, names }: { active: boolean; names: (id: string, fallback?: RouteCandidate) => string }) {
  const language = useLanguage();
  const t = text(language);
  const time = useTimeDisplay();
  const [choices, setChoices] = useState<Choice[] | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const read = () => readChoices(20, controller.signal).then((next) => { if (!controller.signal.aborted) { setChoices(next); setError(""); } })
      .catch((e) => { if (!controller.signal.aborted) setError(errorText(e)); });
    read();
    const every = window.setInterval(read, 60_000);
    return () => { controller.abort(); window.clearInterval(every); };
  }, [active]);
  return (
    <section className="routing-recent" aria-labelledby="routing-recent-title">
      <h4 id="routing-recent-title" className="settings-group-title">{t.recentTitle}</h4>
      <p className="settings-block-help">{t.recentHelp}</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {choices === null && <p className="settings-block-help">{t.recentUnavailable}</p>}
      {choices && choices.length === 0 && <p className="settings-block-help">{t.recentNone}</p>}
      {choices && choices.length > 0 && (
        <ul className="settings-group routing-recent-list">
          {choices.map((c) => {
            const r = c.route;
            const when = r.evaluatedAt && Number.isFinite(Date.parse(r.evaluatedAt)) ? clock(time).format(Date.parse(r.evaluatedAt)) : "";
            const chosen = r.chosen ? r.candidates.find((x) => x.id === r.chosen) : undefined;
            const account = r.account && ("number" in r.account ? t.account(r.account.number) : t.home(r.account.home));
            const expanded = open === c.dispatchId;
            return (
              <li key={c.dispatchId}>
                <button type="button" className="routing-recent-row" aria-expanded={expanded} aria-controls={`routing-recent-${c.dispatchId}`}
                  onClick={() => setOpen(expanded ? null : c.dispatchId)}>
                  <time dateTime={r.evaluatedAt}>{when}</time>
                  <span className="routing-recent-what">
                    {/* An executor's name starts with its task's id by default: the id once. */}
                    <b>{c.executorName?.includes(c.taskId) ? c.executorName : `${c.taskId}${c.executorName ? ` · ${c.executorName}` : ""}`} → {r.chosen ? names(r.chosen, chosen) : t.noneChosen}{account ? ` · ${account}` : ""}</b>
                    <small>{r.changedAtStart ? t.changedFrom(names(r.changedAtStart.from)) : t.at[r.at] ?? r.at}</small>
                  </span>
                  {expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
                </button>
                {expanded && (
                  <ol className="routing-record" id={`routing-recent-${c.dispatchId}`}>
                    {r.candidates.map((x) => (
                      <li key={x.id}>
                        <b>{names(x.id, x)}</b>
                        <span>{t.states[x.state]}{x.reasons.length ? ` · ${x.reasons.map((why) => reasonWords(why, language)).join(language === "zh-Hans" ? "；" : "; ")}` : ""}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Today's API spend, as Core counts it (S2a), with the Workspace's cap. */
export function SpendLine({ active, cap }: { active: boolean; cap?: number }) {
  const language = useLanguage();
  const t = text(language);
  const time = useTimeDisplay();
  const [readings, setReadings] = useState<Readings | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const read = () => readReadings(controller.signal).then((next) => { if (!controller.signal.aborted) setReadings(next); }).catch(() => { /* the line stays as it was */ });
    read();
    const every = window.setInterval(read, 60_000);
    return () => { controller.abort(); window.clearInterval(every); };
  }, [active]);
  const spend = readings?.spend;
  if (!spend) return null;
  const limit = cap ?? spend.capUsd;
  const resets = spend.resetsAt && Number.isFinite(Date.parse(spend.resetsAt)) ? clock(time).format(Date.parse(spend.resetsAt)) : "";
  const share = limit ? Math.min(100, (spend.totalUsd / limit) * 100) : 0;
  return (
    <div className="routing-spend">
      <span className="settings-row-title">{limit ? t.spendCap(spend.totalUsd.toFixed(2), String(limit)) : t.spendToday(spend.totalUsd.toFixed(2))}</span>
      {limit ? <span className="routing-meter is-wide" role="img" aria-label={t.spendCap(spend.totalUsd.toFixed(2), String(limit))}><i className={share >= 100 ? "is-low" : ""} style={{ width: `${share}%` }} /></span> : null}
      <span className="settings-row-meta">{t.spendNote}{resets ? ` ${t.spendResets(resets)}` : ""}</span>
    </div>
  );
}
