/** Settings → Home → Refreshes (YN-113 R4, design §3.3): every card that
 * refreshes itself, what its last run came to and when it runs next, its
 * switch, and the three limits that hold for the whole Workspace. The card's
 * own panel (R3) changes its time and instruction; this page lists them and
 * turns them off and on, and saves the limits. */
import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { errorText } from "./api";
import {
  RefreshRefused,
  cadenceText,
  lastRunText,
  momentText,
  readRefreshes,
  saveRefresh,
  saveRefreshLimits,
  waitingText,
  weeklyRuns,
  type RefreshItem,
  type RefreshLimits,
  type RefreshList,
  type RefreshReason,
} from "./brief-refreshes";
import { useLanguage, strings } from "./i18n";
import { useSaveBarPart } from "./SettingsSaveBar";
import { SettingsSlider } from "./SettingsSlider";
import "./brief-refresh-settings.css";

const text = strings({
  section: "Home card refreshes",
  title: "Scheduled refreshes",
  intro: "Cards that write themselves again on a schedule, in every project, and the limits that hold for the whole Workspace.",
  total: (active: number, weekly: number) =>
    `${active} ${active === 1 ? "card refreshes itself" : "cards refresh themselves"} · about ${weekly} ${weekly === 1 ? "Turn" : "Turns"} a week`,
  loading: "Loading…",
  empty: "No card refreshes itself yet. A project lead can make a report card refresh itself with brief_update and its refresh.",
  next: "Next",
  last: "Last",
  off: "Not scheduled",
  weekly: (turns: number) => `About ${turns} ${turns === 1 ? "Turn" : "Turns"} a week`,
  paused: "Paused",
  switchLabel: (title: string) => `${title}: refresh itself`,
  changed: "This refresh changed meanwhile and was read again. Try the switch again.",
  limits: "Limits",
  limitsHelp: "They hold for every project and every lead. Lowering one stops nothing already on: it refuses only new refreshes or ones made faster.",
  minHours: "Shortest interval",
  minHoursHelp: "Every N hours may be no shorter than this. Claude Code’s routines run at most hourly.",
  maxActive: "Refreshes on at once",
  maxActiveHelp: "At most this many cards refresh themselves at the same time. Gemini’s scheduled actions and Copilot’s scheduled prompts allow 10.",
  pauseAfter: "Failures before pausing",
  pauseAfterHelp: "After this many failures in a row Core pauses the refresh and says so. Claude automatic continue stops after 3.",
  hoursUnit: "h",
  cardsUnit: "cards",
  failuresUnit: "times",
  save: "Save limits",
  saving: "Saving…",
  saved: "Saved.",
  conflict: "The limits changed meanwhile and were read again. Save again to apply yours.",
}, {
  section: "Home 卡片的定时刷新",
  title: "定时刷新",
  intro: "各项目中按时间表重写自己的卡片，以及对整个 Workspace 生效的上限。",
  total: (active, weekly) => `${active} 张定时卡片 · 每周约 ${weekly} 次 Turn`,
  loading: "正在加载…",
  empty: "还没有会定时刷新的卡片。项目负责人可以用 brief_update 的 refresh 让一张报告卡自己刷新。",
  next: "下次",
  last: "上次",
  off: "未安排",
  weekly: (turns) => `每周约 ${turns} 次 Turn`,
  paused: "已暂停",
  switchLabel: (title) => `${title}：定时刷新`,
  changed: "这个定时刷新已被更改，已重新读取。请再试一次开关。",
  limits: "上限",
  limitsHelp: "对所有项目和所有负责人生效。调低不会停掉已经开启的，只挡住新建的或变快的。",
  minHours: "最短间隔",
  minHoursHelp: "“每 N 小时”不能短于它。Claude Code 的 routines 最短每小时一次。",
  maxActive: "同时开启的刷新",
  maxActiveHelp: "同一时间最多这么多张卡片定时刷新。Gemini 的定时操作和 Copilot 的定时提示最多 10 个。",
  pauseAfter: "连续失败几次暂停",
  pauseAfterHelp: "连续失败这么多次后，Core 会暂停这个定时刷新并说明原因。Claude 的自动继续最多 3 次。",
  hoursUnit: "小时",
  cardsUnit: "张",
  failuresUnit: "次",
  save: "保存上限",
  saving: "正在保存…",
  saved: "已保存。",
  conflict: "上限已被更改，已重新读取。再次保存以应用你的值。",
});

type Limits = { minHours: number; maxActive: number; pauseAfterFailures: number };
const limitsOf = (limits: RefreshLimits): Limits => ({
  minHours: limits.minHours,
  maxActive: limits.maxActive,
  pauseAfterFailures: limits.pauseAfterFailures,
});
const sameLimits = (a: Limits, b: RefreshLimits) =>
  a.minHours === b.minHours && a.maxActive === b.maxActive && a.pauseAfterFailures === b.pauseAfterFailures;

function reasonText(reason: RefreshReason, language: string): string {
  return language === "zh-Hans" ? reason.messageZh || reason.message : reason.message;
}

/** The rows as they are after one switch; the totals follow them. */
function withItems(view: RefreshList, items: RefreshItem[]): RefreshList {
  const active = items.filter((item) => item.enabled);
  return {
    ...view,
    items,
    total: {
      cards: items.length,
      active: active.length,
      weeklyRuns: active.reduce((sum, item) => sum + weeklyRuns(item.cadence), 0),
    },
  };
}

export function BriefRefreshSettings({ active = true, visible = true, onOpenCard }: {
  /** Settings is open (its pages stay mounted while another is shown). */
  active?: boolean;
  /** This page is the one shown. */
  visible?: boolean;
  /** Opens the card on its project's Home (the title). */
  onOpenCard?: (projectId: string, key: string) => void;
}) {
  const language = useLanguage();
  const t = text(language);
  const [view, setView] = useState<RefreshList | null>(null);
  const [draft, setDraft] = useState<Limits | null>(null);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [reads, setReads] = useState(0);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !visible) return;
    const controller = new AbortController();
    setReadError("");
    readRefreshes(controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setView(next);
        setDraft((old) => old ?? limitsOf(next.limits));
      },
      (e) => {
        if (!controller.signal.aborted) setReadError(errorText(e));
      },
    );
    return () => controller.abort();
  }, [active, visible, reads]);

  function adoptLimits(next: RefreshLimits) {
    setView((old) => (old ? { ...old, limits: next } : old));
    setDraft(limitsOf(next));
    setDone(false);
  }

  const changed = !!view && !!draft && !sameLimits(draft, view.limits);
  const valid = !!view && !!draft
    && draft.minHours >= view.limits.ranges.minHours[0] && draft.minHours <= view.limits.ranges.minHours[1]
    && draft.maxActive >= view.limits.ranges.maxActive[0] && draft.maxActive <= view.limits.ranges.maxActive[1]
    && draft.pauseAfterFailures >= view.limits.ranges.pauseAfterFailures[0]
    && draft.pauseAfterFailures <= view.limits.ranges.pauseAfterFailures[1];

  async function save(): Promise<boolean> {
    if (!view || !draft || !valid) return false;
    setSaving(true);
    setError("");
    try {
      adoptLimits(await saveRefreshLimits(view.limits, draft));
      setDone(true);
      return true;
    } catch (e) {
      if (e instanceof RefreshRefused && e.code === "version_conflict" && e.current && "minHours" in e.current) {
        adoptLimits(e.current);
        setError(t.conflict);
      } else setError(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  const inBar = useSaveBarPart("brief-refresh-limits", changed && !saving ? {
    ready: valid,
    save,
    discard: () => {
      setError("");
      setDraft(view ? limitsOf(view.limits) : null);
    },
  } : null);

  async function toggle(item: RefreshItem, enabled: boolean) {
    const at = `${item.projectId}/${item.identity}`;
    setBusyRow(at);
    setRowError((old) => ({ ...old, [at]: "" }));
    try {
      const next = await saveRefresh(item.projectId, item.identity, { version: item.version, enabled });
      setView((old) => (old ? withItems(old, old.items.map((row) => (
        row.projectId === item.projectId && row.identity === item.identity
          ? { ...row, ...next, projectId: row.projectId, projectName: row.projectName } : row
      ))) : old));
    } catch (e) {
      if (e instanceof RefreshRefused && e.code === "version_conflict" && e.current && "identity" in e.current) {
        const current = e.current;
        setView((old) => (old ? withItems(old, old.items.map((row) => (
          row.projectId === item.projectId && row.identity === item.identity
            ? { ...row, ...current, projectId: row.projectId, projectName: row.projectName } : row
        ))) : old));
        setRowError((old) => ({ ...old, [at]: t.changed }));
      } else setRowError((old) => ({ ...old, [at]: errorText(e) }));
    } finally {
      setBusyRow(null);
    }
  }

  const limits = view?.limits;
  return (
    <section className="settings-section brief-refresh-settings" aria-label={t.section}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.title}</h3>
          <p>{t.intro}</p>
          {view && <p className="settings-row-help brief-refresh-total">{t.total(view.total.active, view.total.weeklyRuns)}</p>}
        </div>
      </header>

      {view && view.items.length === 0 && <p className="settings-row-help">{t.empty}</p>}
      {view && view.items.length > 0 && (
        <div className="settings-group brief-refresh-list">
          {view.items.map((item) => {
            const at = `${item.projectId}/${item.identity}`;
            const title = item.title || item.key;
            const waiting = waitingText(item, language);
            return (
              <div className="settings-row brief-refresh-row" key={at}>
                <span className="settings-row-main">
                  <span className="settings-row-title">
                    {onOpenCard
                      ? <button type="button" className="brief-refresh-open" onClick={() => onOpenCard(item.projectId, item.key)}>{title}</button>
                      : title}
                    {!item.enabled && <span className="settings-current">{t.paused}</span>}
                  </span>
                  <span className="settings-row-help">
                    {cadenceText(item.cadence, item.zone, language)}
                    {item.projectName ? ` · ${item.projectName}` : ""}
                  </span>
                  <span className="settings-row-meta">
                    <span>{t.next} {item.enabled ? momentText(item.nextAt) || t.off : t.off}</span>
                    <span>{t.last} {waiting ?? lastRunText(item, language)}</span>
                    <span>{t.weekly(item.weeklyRuns)}</span>
                  </span>
                  {!item.enabled && item.pausedReason && (
                    <span className="settings-row-help">{reasonText(item.pausedReason, language)}</span>
                  )}
                  {rowError[at] && <span className="inline-error" role="alert">{rowError[at]}</span>}
                </span>
                <span className="settings-row-action">
                  {busyRow === at && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
                  <input
                    type="checkbox"
                    role="switch"
                    className="settings-toggle"
                    checked={item.enabled}
                    disabled={busyRow === at}
                    aria-label={t.switchLabel(title)}
                    onChange={(event) => void toggle(item, event.target.checked)}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}

      {limits && draft && (
        <div className="settings-group brief-refresh-limits">
          <div className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.limits}</span>
              <span className="settings-row-help">{t.limitsHelp}</span>
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-row-main">
              <SettingsSlider name="refresh-min-hours" label={t.minHours} value={draft.minHours}
                min={limits.ranges.minHours[0]} max={limits.ranges.minHours[1]} unit={t.hoursUnit}
                disabled={saving} onChange={(value) => { setDone(false); setDraft({ ...draft, minHours: value }); }} />
              <span className="settings-row-help">{t.minHoursHelp}</span>
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-row-main">
              <SettingsSlider name="refresh-max-active" label={t.maxActive} value={draft.maxActive}
                min={limits.ranges.maxActive[0]} max={limits.ranges.maxActive[1]} unit={t.cardsUnit}
                disabled={saving} onChange={(value) => { setDone(false); setDraft({ ...draft, maxActive: value }); }} />
              <span className="settings-row-help">{t.maxActiveHelp}</span>
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-row-main">
              <SettingsSlider name="refresh-pause-failures" label={t.pauseAfter} value={draft.pauseAfterFailures}
                min={limits.ranges.pauseAfterFailures[0]} max={limits.ranges.pauseAfterFailures[1]} unit={t.failuresUnit}
                disabled={saving} onChange={(value) => { setDone(false); setDraft({ ...draft, pauseAfterFailures: value }); }} />
              <span className="settings-row-help">{t.pauseAfterHelp}</span>
            </span>
          </div>
          {!inBar && (
            <div className="settings-row settings-row-end">
              <div className="settings-row-action">
                <button type="button" className="secondary-button" disabled={saving || !changed || !valid} onClick={() => void save()}>
                  {saving && <LoaderCircle size={13} className="spin" />} {saving ? t.saving : t.save}
                </button>
                {done && !changed && <span className="field-hint" role="status">{t.saved}</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {(error || readError) && (
        <p className="inline-error" role="alert">{[error, readError].filter(Boolean).join(" ")}</p>
      )}
      {!view && !readError && <p className="settings-row-help" role="status">{t.loading}</p>}
    </section>
  );
}
