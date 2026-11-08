import { useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { errorText } from "./api";
import type { Candidate, Policy } from "./executor-routing";
import { strings, useLanguage, type Language } from "./i18n";
import type { AccountsView, RoutingKey } from "./routing-keys";
import { evaluate, simulate, type Assume, type RouteRecord, type Segment } from "./routing-live";
import { Tip, TipText } from "./Tip";
import { timeFormatter, useTimeDisplay } from "./time-preferences";

const DAY = 24 * 60;
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
});
type Text = ReturnType<typeof text>;

const dayLabel = timeFormatter({ weekday: "short" });
const hhmm = timeFormatter({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const whenLabel = timeFormatter({ weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const reasonWords = (message: string, messageZh: string, language: Language) => (language === "zh-Hans" ? messageZh : message);

/** Today's local midnight, as the strip's first row starts. */
function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A row's stretches: the segments clipped to one day, as shares of it. */
function stretches(segments: Segment[], rowStart: number) {
  const rowEnd = rowStart + DAY * 60_000;
  return segments.flatMap((s) => {
    const from = Math.max(Date.parse(s.from), rowStart);
    const to = Math.min(Date.parse(s.to), rowEnd);
    return to > from ? [{ from, to, chosen: s.chosen, left: ((from - rowStart) / (rowEnd - rowStart)) * 100, width: ((to - from) / (rowEnd - rowStart)) * 100 }] : [];
  });
}

/** Settings → Executor routing → Simulate by time (YN-49 S4b): a week of
 * who would be chosen, a time to look at closely, and what to assume used up. */
export function RoutingSimulate({ policy, active, names, colourOf, accounts, keys }: {
  policy: Policy; active: boolean; names: (c: Candidate) => string; colourOf: (id: string) => number;
  accounts: AccountsView | null; keys: RoutingKey[] | null;
}) {
  const language = useLanguage();
  const t = text(language);
  const time = useTimeDisplay();
  const [now] = useState(() => Date.now());
  const start = useMemo(() => startOfToday(now), [now]);
  const nowOffset = Math.floor((now - start) / 60_000 / STEP) * STEP;
  const [offset, setOffset] = useState<number | null>(null);
  const picked = offset ?? nowOffset;
  const pickedAt = start + picked * 60_000;
  const [assume, setAssume] = useState<Required<Assume>>({ accountsUsedUp: [], codexUsedUp: [], spendCapReached: false, onePasswordDown: false });
  const [segments, setSegments] = useState<Segment[] | null | undefined>(undefined);
  const [record, setRecord] = useState<RouteRecord | null>(null);
  const [error, setError] = useState("");
  // What is assumed, as Core takes it: only what is on.
  const sent: Assume = useMemo(() => ({
    ...(assume.accountsUsedUp.length ? { accountsUsedUp: assume.accountsUsedUp } : {}),
    ...(assume.codexUsedUp.length ? { codexUsedUp: assume.codexUsedUp } : {}),
    ...(assume.spendCapReached ? { spendCapReached: true } : {}),
    ...(assume.onePasswordDown ? { onePasswordDown: true } : {}),
  }), [assume]);
  const key = JSON.stringify([policy, sent]);
  // The week, asked again a moment after the order or an assumption changes.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const wait = window.setTimeout(() => {
      simulate(policy, new Date(start).toISOString(), new Date(start + DAYS * DAY * 60_000).toISOString(), STEP, sent, controller.signal)
        .then((next) => { if (!controller.signal.aborted) { setSegments(next); setError(""); } })
        .catch((e) => { if (!controller.signal.aborted) setError(errorText(e)); });
    }, 350);
    return () => { window.clearTimeout(wait); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, start]);
  // The picked time, with its reasons.
  useEffect(() => {
    if (!active || segments === null) return;
    const controller = new AbortController();
    const wait = window.setTimeout(() => {
      evaluate(policy, new Date(pickedAt).toISOString(), sent, controller.signal)
        .then((next) => { if (!controller.signal.aborted) setRecord(next); })
        .catch(() => { /* the week says what it can */ });
    }, 250);
    return () => { window.clearTimeout(wait); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, pickedAt, segments === null]);

  const byId = new Map(policy.candidates.map((c, i) => [c.id, { c, i }]));
  const label = (id: string | null) => (id && byId.get(id) ? names(byId.get(id)!.c) : t.noneShort);
  const when = whenLabel(time).format(pickedAt);
  const chosen = record?.chosen ? byId.get(record.chosen) : undefined;
  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  // What may be assumed: only what the order uses.
  const pools = policy.candidates.some((c) => c.credential.kind === "pool");
  const codexLogin = policy.candidates.some((c) => c.harness === "codex" && c.credential.kind === "login");
  const homes = (accounts?.codexHomes ?? []).filter((h) => policy.candidates.some((c) => c.credential.kind === "codexHome" && c.credential.id === h.id));
  const apiKeys = policy.candidates.some((c) => c.credential.kind === "apiKey");
  const onePassword = policy.candidates.some((c) => c.credential.kind === "apiKey" && keys?.find((k) => k.id === (c.credential as { keyId: string }).keyId)?.source === "1password");

  if (segments === null) return <section className="routing-simulate"><h4 className="settings-group-title">{t.title}</h4><p className="settings-block-help">{t.unavailable}</p></section>;
  return (
    <section className="routing-simulate" aria-labelledby="routing-simulate-title">
      <h4 id="routing-simulate-title" className="settings-group-title">{t.title}</h4>
      <p className="settings-block-help">{t.help}</p>
      <div className="settings-group routing-sim-box">
        <div className="routing-sim-at">
          <label className="routing-sim-slider">
            <span>{t.at} · <b>{when}</b></span>
            <input type="range" min={0} max={DAYS * DAY - STEP} step={STEP} value={picked} aria-valuetext={when}
              onChange={(e) => setOffset(Number(e.target.value))} />
          </label>
          <button type="button" className="quiet-button" disabled={offset === null} onClick={() => setOffset(null)}><RotateCcw size={14} /> {t.now}</button>
        </div>
        {(pools || codexLogin || homes.length > 0 || apiKeys || onePassword) && (
          <div className="routing-sim-assume" role="group" aria-label={t.assume}>
            <span className="settings-row-meta">{t.assume}</span>
            {pools && (accounts?.cswap.accounts ?? []).map((a) => (
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
          {record && <p className="settings-row-meta">{record.candidates.filter((c) => c.reasons.length && (!chosen || byId.get(c.id)!.i <= chosen.i))
            .map((c) => `${byId.get(c.id) ? byId.get(c.id)!.i + 1 : "?"} ${c.reasons.map((r) => reasonWords(r.message, r.messageZh, language)).join(language === "zh-Hans" ? "；" : "; ")}`)
            .join(" · ")}</p>}
        </div>
        {error && <p className="inline-error" role="alert">{t.failed} {error}</p>}
        {segments && (
          <div className="routing-strip" aria-hidden="true">
            {Array.from({ length: DAYS }, (_, d) => {
              const rowStart = start + d * DAY * 60_000;
              return (
                <div className="routing-strip-row" key={d}>
                  <span className="routing-strip-day">{dayLabel(time).format(rowStart)}</span>
                  <div className="routing-strip-cells" onClick={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    const at = Math.floor(((e.clientX - box.left) / box.width) * DAY / STEP) * STEP;
                    setOffset(Math.max(0, Math.min(DAYS * DAY - STEP, d * DAY + at)));
                  }}>
                    {stretches(segments, rowStart).map((s) => {
                      const c = s.chosen ? byId.get(s.chosen) : undefined;
                      return (
                        <Tip key={s.from} content={<TipText title={c ? names(c.c) : t.noneShort} meta={[`${dayLabel(time).format(s.from)} ${t.stretch(hhmm(time).format(s.from), hhmm(time).format(s.to))}`]} />}>
                          <span className={`routing-strip-run${c ? "" : " is-wait"}`} style={{ left: `${s.left}%`, width: `${s.width}%`, ...(c ? { ["--cc" as string]: `var(--route-c${colourOf(c.c.id)})` } : {}) }}>
                            {c && s.width >= 4 ? c.i + 1 : ""}
                          </span>
                        </Tip>
                      );
                    })}
                    {d === Math.floor(picked / DAY) && <i className="routing-strip-pick" style={{ left: `${((picked % DAY) / DAY) * 100}%` }} />}
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
