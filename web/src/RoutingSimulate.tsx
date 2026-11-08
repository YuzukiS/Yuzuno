import { useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { errorText, HttpError } from "./api";
import type { Candidate, Policy } from "./executor-routing";
import { strings, useLanguage, type Language } from "./i18n";
import type { AccountsView, RoutingKey } from "./routing-keys";
import { evaluate, simulate, type Assume, type RouteRecord, type Segment } from "./routing-live";
import { Tip, TipText } from "./Tip";
import { timeFormatter, useTimeDisplay } from "./time-preferences";

const STEP = 30;
const DAYS = 7;

const text = strings({
  title: "Simulate by time",
  help: "Whom Core would choose over the next seven days, by the order above as it stands. Readings stay as they are now and only the time moves; a strip is the candidate it would choose (its colour), stripes where none is available and new executors wait.",
  at: "Simulated time",
  now: "Back to now",
  would: (when: string) => `${when}: would choose`,
  none: (when: string) => `${when}: none is available, new executors wait`,
  assume: "Assume:",
  usedUp: (n: number) => `Account #${n} used up`,
  codexUsedUp: (name: string) => `${name} used up`,
  codexLogin: "Codex subscription",
  codexHome: (label: string) => `Codex ${label}`,
  capReached: "Today's API cap reached",
  onePasswordDown: "1Password unreachable",
  textVersion: "Text version",
  noneShort: "none: wait",
  stretch: (from: string, to: string) => `${from}–${to}`,
  unavailable: "Simulating by time comes with routing itself (YN-34 S3b).",
  failed: "Couldn't simulate:",
  held: "The week shows again once the marked block is corrected.",
  refused: "Core can't simulate this draft yet:",
}, {
  title: "按时间模拟",
  help: "按上面现在的顺序，未来七天 Core 会选谁。读数按现在的算，只有时间在变；色带是会选的候选（它的颜色），斜线是没有可用的、新开的执行者会排队。",
  at: "模拟时间",
  now: "回到现在",
  would: (when) => `${when} 会选`,
  none: (when) => `${when} 没有可用的候选，新开的执行者会排队`,
  assume: "假设：",
  usedUp: (n) => `账号 #${n} 用完`,
  codexUsedUp: (name) => `${name} 用完`,
  codexLogin: "Codex 订阅",
  codexHome: (label) => `Codex ${label}`,
  capReached: "今日 API 到上限",
  onePasswordDown: "1Password 连不上",
  textVersion: "文字版",
  noneShort: "都不可用：排队",
  stretch: (from, to) => `${from}–${to}`,
  unavailable: "按时间模拟要等路由本身（YN-34 S3b）。",
  failed: "没能模拟：",
  held: "改好标出的那一块，这里会再显示这一周。",
  refused: "Core 还模拟不了这份草稿：",
});
type Text = ReturnType<typeof text>;

const dayLabel = timeFormatter({ weekday: "short" });
const hhmm = timeFormatter({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const whenLabel = timeFormatter({ weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const reasonWords = (message: string, messageZh: string, language: Language) => (language === "zh-Hans" ? messageZh : message);

/** The wall clock in `zone` at `at`. */
const wallClocks = new Map<string, Intl.DateTimeFormat>();
function wallIn(at: number, zone: string) {
  let format = wallClocks.get(zone);
  if (!format) wallClocks.set(zone, (format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })));
  const p = Object.fromEntries(format.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
}

/** The midnight `days` days after `at`'s day, as the calendar has it in the
 * time zone times are shown in (the device's when none is chosen): a day with
 * a clock change is 23 or 25 hours long. */
function midnight(at: number, days = 0, zone: string | null = null): number {
  if (!zone) {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return d.getTime();
  }
  const day = new Date(wallIn(at, zone));
  const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + days);
  // The instant whose wall clock reads that midnight: the zone's offset there,
  // read twice so that a clock change between them is taken into account.
  const first = wall - (wallIn(wall, zone) - wall);
  return wall - (wallIn(first, zone) - first);
}

/** A row's stretches: the segments clipped to one day, as shares of it. */
function stretches(segments: Segment[], rowStart: number, rowEnd: number) {
  return segments.flatMap((s) => {
    const from = Math.max(Date.parse(s.from), rowStart);
    const to = Math.min(Date.parse(s.to), rowEnd);
    return to > from ? [{ from, to, chosen: s.chosen, left: ((from - rowStart) / (rowEnd - rowStart)) * 100, width: ((to - from) / (rowEnd - rowStart)) * 100 }] : [];
  });
}

/** Settings → Executor routing → Simulate by time (YN-49 S4b): a week of
 * who would be chosen, a time to look at closely, and what to assume used up. */
export function RoutingSimulate({ policy, active, held = false, names, colourOf, accounts, keys }: {
  policy: Policy; active: boolean; held?: boolean; names: (c: Candidate) => string; colourOf: (id: string) => number;
  accounts: AccountsView | null; keys: RoutingKey[] | null;
}) {
  const language = useLanguage();
  const t = text(language);
  const time = useTimeDisplay();
  // Now, read again while the page is shown: Settings keeps a page mounted.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const every = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(every);
  }, [active]);
  // The week's days, each from its local midnight to the next.
  // Days as the calendar has them where times are shown (Settings → Typing & time).
  const zone = time.timeZone;
  const start = midnight(now, 0, zone);
  const days = useMemo(() => Array.from({ length: DAYS + 1 }, (_, d) => midnight(start, d, zone)), [start, zone]);
  const end = days[DAYS];
  const toStep = (at: number) => start + Math.floor((at - start) / 60_000 / STEP) * STEP * 60_000;
  // The picked moment; none, or one the week has left behind, is now.
  const [chosenAt, setChosenAt] = useState<number | null>(null);
  const pickedOwn = chosenAt !== null && chosenAt >= start && chosenAt < end ? chosenAt : null;
  const pickedAt = pickedOwn ?? toStep(now);
  const picked = (pickedAt - start) / 60_000;
  const [assume, setAssume] = useState<Required<Assume>>({ accountsUsedUp: [], codexUsedUp: [], spendCapReached: false, onePasswordDown: false });
  const [segments, setSegments] = useState<Segment[] | null | undefined>(undefined);
  const [record, setRecord] = useState<RouteRecord | null>(null);
  const [error, setError] = useState("");
  const [refused, setRefused] = useState("");
  // What is assumed, as Core takes it: only what is on.
  const sent: Assume = useMemo(() => ({
    ...(assume.accountsUsedUp.length ? { accountsUsedUp: assume.accountsUsedUp } : {}),
    ...(assume.codexUsedUp.length ? { codexUsedUp: assume.codexUsedUp } : {}),
    ...(assume.spendCapReached ? { spendCapReached: true } : {}),
    ...(assume.onePasswordDown ? { onePasswordDown: true } : {}),
  }), [assume]);
  const key = JSON.stringify([policy, sent]);
  // Nothing assumed is no assumption: not sent at all.
  const assumed = Object.keys(sent).length ? sent : undefined;
  // The week, asked again a moment after the order or an assumption changes;
  // not while the page already knows the order can't be saved (`held`).
  useEffect(() => {
    if (!active || held) return;
    const controller = new AbortController();
    const wait = window.setTimeout(() => {
      simulate(policy, new Date(start).toISOString(), new Date(end).toISOString(), STEP, assumed, controller.signal)
        .then((next) => { if (!controller.signal.aborted) { setSegments(next); setError(""); setRefused(""); } })
        .catch((e) => {
          if (controller.signal.aborted) return;
          // A draft Core refuses (400) is a note, not an error.
          const refusal = e instanceof HttpError && e.status === 400;
          setRefused(refusal ? errorText(e) : "");
          setError(refusal ? "" : errorText(e));
        });
    }, 350);
    return () => { window.clearTimeout(wait); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, start, end, held]);
  // The picked time, with its reasons.
  useEffect(() => {
    if (!active || held || segments === null) return;
    const controller = new AbortController();
    const wait = window.setTimeout(() => {
      evaluate(policy, new Date(pickedAt).toISOString(), assumed, controller.signal)
        .then((next) => { if (!controller.signal.aborted) setRecord(next); })
        .catch(() => { /* the week says what it can */ });
    }, 250);
    return () => { window.clearTimeout(wait); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, pickedAt, segments === null, held]);

  const byId = new Map(policy.candidates.map((c, i) => [c.id, { c, i }]));
  const label = (id: string | null) => (id && byId.get(id) ? names(byId.get(id)!.c) : t.noneShort);
  const when = whenLabel(time).format(pickedAt);
  const chosen = record?.chosen ? byId.get(record.chosen) : undefined;
  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  // What may be assumed: only what the order uses, and only where it can change
  // the answer. Used up is a quota reading of 0: it moves a pool's pick, and
  // otherwise counts only for a candidate with a quota condition.
  const pools = policy.candidates.some((c) => c.credential.kind === "pool");
  const readsQuota = (c: Candidate) => c.conditions.some((x) => x.kind === "quota");
  // A Claude login runs on claude-swap's active account; Core takes that
  // account's fingerprint as used up too (YN-34 #801).
  const claudeLogin = policy.candidates.some((c) => c.harness === "claude" && c.credential.kind === "login" && readsQuota(c));
  const cswapAccounts = (accounts?.cswap.accounts ?? []).filter((a) => pools || (claudeLogin && a.active));
  const codexLogin = policy.candidates.some((c) => c.harness === "codex" && c.credential.kind === "login" && readsQuota(c));
  const homes = (accounts?.codexHomes ?? []).filter((h) => policy.candidates.some((c) => c.credential.kind === "codexHome" && c.credential.id === h.id && readsQuota(c)));
  const apiKeys = policy.candidates.some((c) => c.credential.kind === "apiKey");
  const onePassword = policy.candidates.some((c) => c.credential.kind === "apiKey" && keys?.find((k) => k.id === (c.credential as { keyId: string }).keyId)?.source === "1password");

  if (segments === null) return <section className="routing-simulate"><h4 className="settings-group-title">{t.title}</h4><p className="settings-block-help">{t.unavailable}</p></section>;
  // A week or a time of another order isn't shown for this one.
  if (held || refused) return (
    <section className="routing-simulate">
      <h4 className="settings-group-title">{t.title}</h4>
      <p className="settings-block-help routing-sim-held">{held ? t.held : <>{t.refused} <span lang="en">{refused}</span></>}</p>
    </section>
  );
  return (
    <section className="routing-simulate" aria-labelledby="routing-simulate-title">
      <h4 id="routing-simulate-title" className="settings-group-title">{t.title}</h4>
      <p className="settings-block-help">{t.help}</p>
      <div className="settings-group routing-sim-box">
        <div className="routing-sim-at">
          <label className="routing-sim-slider">
            <span>{t.at} · <b>{when}</b></span>
            <input type="range" min={0} max={(end - start) / 60_000 - STEP} step={STEP} value={picked} aria-valuetext={when}
              onChange={(e) => setChosenAt(start + Number(e.target.value) * 60_000)} />
          </label>
          <button type="button" className="quiet-button" disabled={pickedOwn === null} onClick={() => setChosenAt(null)}><RotateCcw size={14} /> {t.now}</button>
        </div>
        {(cswapAccounts.length > 0 || codexLogin || homes.length > 0 || apiKeys || onePassword) && (
          <div className="routing-sim-assume" role="group" aria-label={t.assume}>
            <span className="settings-row-meta">{t.assume}</span>
            {cswapAccounts.map((a) => (
              <button type="button" key={a.fingerprint} className="routing-pill" aria-pressed={assume.accountsUsedUp.includes(a.fingerprint)}
                onClick={() => setAssume((x) => ({ ...x, accountsUsedUp: toggle(x.accountsUsedUp, a.fingerprint) }))}>{t.usedUp(a.number)}</button>
            ))}
            {codexLogin && <button type="button" className="routing-pill" aria-pressed={assume.codexUsedUp.includes("login")}
              onClick={() => setAssume((x) => ({ ...x, codexUsedUp: toggle(x.codexUsedUp, "login") }))}>{t.codexUsedUp(t.codexLogin)}</button>}
            {homes.map((h) => (
              <button type="button" key={h.id} className="routing-pill" aria-pressed={assume.codexUsedUp.includes(h.id)}
                onClick={() => setAssume((x) => ({ ...x, codexUsedUp: toggle(x.codexUsedUp, h.id) }))}>{t.codexUsedUp(t.codexHome(h.label))}</button>
            ))}
            {apiKeys && <button type="button" className="routing-pill" aria-pressed={assume.spendCapReached}
              onClick={() => setAssume((x) => ({ ...x, spendCapReached: !x.spendCapReached }))}>{t.capReached}</button>}
            {onePassword && <button type="button" className="routing-pill" aria-pressed={assume.onePasswordDown}
              onClick={() => setAssume((x) => ({ ...x, onePasswordDown: !x.onePasswordDown }))}>{t.onePasswordDown}</button>}
          </div>
        )}
        <div className="routing-sim-result" role="status" style={chosen ? { ["--cc" as string]: `var(--route-c${colourOf(chosen.c.id)})` } : undefined}>
          {record && (chosen
            ? <p><span className="routing-num is-sm" aria-hidden="true">{chosen.i + 1}</span> {t.would(when)} <b>{names(chosen.c)}</b></p>
            : <p><span className="routing-num is-sm is-wait" aria-hidden="true">…</span> {t.none(when)}</p>)}
          {/* The record can be of the order before a change: a candidate no longer in it is left out. */}
          {record && <ul className="routing-now-why routing-sim-why">{record.candidates.flatMap((c) => {
            const at = byId.get(c.id);
            return at && c.reasons.length && (!chosen || at.i <= chosen.i)
              ? [<li key={c.id}><span className="routing-num is-sm" style={{ ["--cc" as string]: `var(--route-c${colourOf(c.id)})` }} aria-hidden="true">{at.i + 1}</span>
                <span>{c.id === chosen?.c.id ? "" : `${names(at.c)}: `}{c.reasons.map((r) => reasonWords(r.message, r.messageZh, language)).join(language === "zh-Hans" ? "；" : "; ")}</span></li>] : [];
          })}</ul>}
        </div>
        {error && <p className="inline-error" role="alert">{t.failed} {error}</p>}
        {segments && (
          <div className="routing-strip" aria-hidden="true">
            {days.slice(0, DAYS).map((rowStart, d) => {
              const rowEnd = days[d + 1];
              return (
                <div className="routing-strip-row" key={d}>
                  <span className="routing-strip-day">{dayLabel(time).format(rowStart)}</span>
                  <div className="routing-strip-cells" onClick={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    const at = toStep(rowStart + ((e.clientX - box.left) / box.width) * (rowEnd - rowStart));
                    setChosenAt(Math.max(start, Math.min(end - STEP * 60_000, at)));
                  }}>
                    {stretches(segments, rowStart, rowEnd).map((s) => {
                      const c = s.chosen ? byId.get(s.chosen) : undefined;
                      return (
                        <Tip key={s.from} content={<TipText title={c ? names(c.c) : t.noneShort} meta={[`${dayLabel(time).format(s.from)} ${t.stretch(hhmm(time).format(s.from), hhmm(time).format(s.to))}`]} />}>
                          <span className={`routing-strip-run${c ? "" : " is-wait"}`} style={{ left: `${s.left}%`, width: `${s.width}%`, ...(c ? { ["--cc" as string]: `var(--route-c${colourOf(c.c.id)})` } : {}) }}>
                            {c && s.width >= 4 ? c.i + 1 : ""}
                          </span>
                        </Tip>
                      );
                    })}
                    {pickedAt >= rowStart && pickedAt < rowEnd && <i className="routing-strip-pick" style={{ left: `${((pickedAt - rowStart) / (rowEnd - rowStart)) * 100}%` }} />}
                  </div>
                </div>
              );
            })}
            <div className="routing-strip-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
          </div>
        )}
        {segments && (
          <details className="routing-sim-text">
            <summary>{t.textVersion}</summary>
            <ol>
              {segments.map((s) => (
                <li key={s.from}>{whenLabel(time).format(Date.parse(s.from))}–{hhmm(time).format(Date.parse(s.to))} · {label(s.chosen)}</li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </section>
  );
}
