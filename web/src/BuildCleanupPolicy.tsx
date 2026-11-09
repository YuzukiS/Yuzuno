import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "./api";
import { strings, useLanguage } from "./i18n";
import { sizeText } from "./storage-overview";

/** The user's build output cleanup, as Core keeps it (YN-65). */
type Policy = { enabled: boolean; keepDays: number; since: string | null; version: number; changedAt: string | null };
type ResultState = "removed" | "kept" | "waiting" | "failed";
type FolderResult = { path: string; how: string[]; state: ResultState; reasons: string[]; bytes: number | null };
/** One released executor's cleanup, newest first. */
type Outcome = {
  state: "waiting" | "done" | "gaveUp";
  nextTryAt: string | null;
  updatedAt: string;
  executor: { id: string; name: string; releasedAt: string } | null;
  taskId: string | null;
  results: FolderResult[];
};
type Overview = { policy: Policy; maxKeepDays: number; recent: Outcome[]; waiting: number };
type Backlog = { executors: number; checked: number; complete: boolean; folders: number; bytes: number; kept: number; items: { executor: string; path: string; bytes: number }[] };

/** How Core knows a folder was the executor's, as Core says it. */
const howZh: Record<string, string> = {
  "it worked there": "它在这里工作",
  "its Jobs ran there": "它的 Job 在这里运行",
  "its Jobs built there": "它的 Job 构建到这里",
  "registered on its task": "登记在它的任务上",
  "on its pull request's branch": "它的 PR 分支",
};

const BACKLOG_SHOWN = 5;

const text = strings({
  label: "Clean up after an executor is released",
  note: "Removes only the Cargo debug build output in the folders Core's records show were that executor's: the folder it worked in, where its Jobs ran or built, worktrees registered on its task and its pull requests' branches. Never sources, branches, uncommitted changes, release builds or anything Cargo didn't make, and only once nothing uses it.",
  keep: "Keep after release",
  keepNote: (max: number) => `0–${max} days, counted from the executor's close.`,
  days: "days",
  daysInvalid: (max: number) => `A whole number from 0 to ${max}.`,
  save: "Save",
  saving: "Saving…",
  off: "Off: nothing is removed automatically. Only you can turn it on here; Agents have no tool for it.",
  on: (since: string | null) =>
    `On for ${since ? `executors released since ${since}` : "every released executor"}. What is in use is tried again every hour for a week. Each cleanup is also on its task's activity; no mail is sent.`,
  reading: "Reading…",
  couldNotRead: (error: string) => `Could not read the build output cleanup: ${error}`,
  tryAgain: "Try again",
  couldNotSave: (error: string) => `Not saved: ${error}. It was read again.`,
  turnOn: "Turn on automatic cleanup",
  counting: "Counting what executors released before left…",
  couldNotCount: (error: string) => `What executors released before left could not be counted: ${error}`,
  backlog: (folders: number, size: string, kept: number) =>
    `Executors released before left ${folders} debug ${folders === 1 ? "folder" : "folders"} that can go, about ${size}${kept ? `; ${kept} more hold files Cargo didn't make and are kept` : ""}.`,
  partial: (checked: number, all: number) => `Only ${checked} of ${all} released executors could be counted in the time allowed.`,
  counted: "Only counted: nothing was checked for use or removed. Each folder is checked again when it is removed.",
  earlier: "Clean these too",
  laterOnly: "Only executors released from now on",
  confirm: "Turn on",
  confirmClean: "Turn on and clean",
  cancel: "Cancel",
  recent: "Latest cleanups",
  waiting: (count: number) => `${count} ${count === 1 ? "executor waits" : "executors wait"} for the next try.`,
  state: (state: ResultState, gaveUp: boolean): string =>
    state === "removed" ? "Removed" : state === "kept" ? "Kept" : state === "failed" ? "Not fully removed" : gaveUp ? "Given up" : "Will retry",
  how: (how: string) => how,
  removedAt: (date: string) => `${date}`,
  nextTry: (date: string) => `next try ${date}`,
  gaveUpNote: "in use for a week: left as it is",
  noSize: "size unknown",
}, {
  label: "执行者释放后自动清理",
  note: "只删除 Core 的记录能确认是这个执行者的目录里的 Cargo debug 构建输出：它工作的目录、它的 Job 运行或构建的位置、登记在它任务上的工作目录和它 PR 的分支。从不删源代码、分支、未提交的改动、release 构建或任何不是 Cargo 生成的东西，而且只在没有人使用时才删。",
  keep: "释放后保留",
  keepNote: (max) => `0–${max} 天，从执行者关闭时算起。`,
  days: "天",
  daysInvalid: (max) => `请填 0 到 ${max} 的整数。`,
  save: "保存",
  saving: "正在保存…",
  off: "关：不会自动删除任何东西。只有你能在这里打开；Agent 没有改它的工具。",
  on: (since) =>
    `已打开，适用于${since ? ` ${since} 之后释放的执行者` : "所有已释放的执行者"}。正在被使用的目录每小时再试一次，最多一周。每次清理也记在对应任务的活动里，不发邮件。`,
  reading: "正在读取…",
  couldNotRead: (error) => `无法读取构建输出自动清理：${error}`,
  tryAgain: "重试",
  couldNotSave: (error) => `没有保存：${error}。已重新读取。`,
  turnOn: "打开自动清理",
  counting: "正在统计之前释放的执行者留下的构建输出…",
  couldNotCount: (error) => `无法统计之前释放的执行者留下的构建输出：${error}`,
  backlog: (folders, size, kept) =>
    `之前释放的执行者留下 ${folders} 个可清理的 debug 目录，约 ${size}${kept ? `；另有 ${kept} 个里面有不是 Cargo 生成的文件，会保留` : ""}。`,
  partial: (checked, all) => `在限定时间内只统计了 ${all} 个已释放执行者中的 ${checked} 个。`,
  counted: "只是统计：还没有检查是否有人在用，也没有删除任何东西。每个目录在删除时都会再检查一遍。",
  earlier: "连同这些一起清理",
  laterOnly: "只清理以后释放的",
  confirm: "打开",
  confirmClean: "打开并清理",
  cancel: "取消",
  recent: "最近的清理",
  waiting: (count) => `${count} 个执行者在等下一次尝试。`,
  state: (state, gaveUp) =>
    state === "removed" ? "已清理" : state === "kept" ? "保留" : state === "failed" ? "未删完" : gaveUp ? "已放弃" : "稍后再试",
  how: (how) => howZh[how] ?? how,
  removedAt: (date) => `${date}`,
  nextTry: (date) => `下次尝试 ${date}`,
  gaveUpNote: "一周内一直在用：保持原样",
  noSize: "大小未知",
});

function at(iso: string) {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function isOverview(value: unknown): value is Overview {
  const view = value as Overview | null;
  return !!view && typeof view.policy?.enabled === "boolean" && typeof view.policy.version === "number" && Array.isArray(view.recent);
}

/**
 * Settings → Data & storage → Build output in task work folders (YN-65): the
 * user's policy for removing released executors' Cargo debug output, and what
 * it did lately. It reads Core while shown; it changes the policy only when
 * the user turns it on or off or saves the days, against the version read.
 * Turning it on first counts what earlier releases left and asks whether to
 * clean that too.
 */
export function BuildCleanupPolicy({ active }: { active: boolean }) {
  const t = text(useLanguage());
  const [view, setView] = useState<Overview | null>(null);
  const [readError, setReadError] = useState("");
  const [days, setDays] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirming, setConfirming] = useState<{ backlog: Backlog | null; error: string; earlier: boolean } | null>(null);

  const read = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api<unknown>("/build-cleanup", { signal });
      if (signal?.aborted) return;
      if (!isOverview(next)) throw new Error("Core's answer has no policy");
      setView(next);
      setDays(String(next.policy.keepDays));
      setReadError("");
    } catch (e) {
      if (!signal?.aborted) setReadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [active, read]);

  const max = view?.maxKeepDays ?? 30;
  const parsed = /^\d{1,3}$/.test(days.trim()) ? Number(days.trim()) : NaN;
  const daysValid = Number.isInteger(parsed) && parsed >= 0 && parsed <= max;
  const on = !!view?.policy.enabled;

  // The switch saves the stored days while the field holds something else invalid.
  const save = async (enabled: boolean, earlier: boolean) => {
    if (!view) return;
    const keepDays = daysValid ? parsed : view.policy.keepDays;
    setSaving(true);
    setSaveError("");
    try {
      const next = await api<unknown>("/build-cleanup", {
        method: "PUT",
        body: JSON.stringify({ enabled, keepDays, earlier, expectedVersion: view.policy.version }),
      });
      if (!isOverview(next)) throw new Error("Core's answer has no policy");
      setView(next);
      setDays(String(next.policy.keepDays));
      setConfirming(null);
    } catch (e) {
      setSaveError(errorText(e));
      await read();
    } finally {
      setSaving(false);
    }
  };

  const startTurningOn = async () => {
    setSaveError("");
    setConfirming({ backlog: null, error: "", earlier: true });
    try {
      const backlog = await api<Backlog>("/build-cleanup/backlog", { method: "POST" });
      setConfirming((was) => (was ? { ...was, backlog } : was));
    } catch (e) {
      setConfirming((was) => (was ? { ...was, error: errorText(e) } : was));
    }
  };

  if (!view) {
    return (
      <div className="build-cleanup">
        {readError ? (
          <p className="updates-error" role="alert">
            {t.couldNotRead(readError)}{" "}
            <button type="button" className="inline-link" onClick={() => void read()}>
              {t.tryAgain}
            </button>
          </p>
        ) : (
          <p className="storage-note">{t.reading}</p>
        )}
      </div>
    );
  }

  const backlog = confirming?.backlog;
  const cleanable = !!backlog && backlog.folders > 0;
  return (
    <div className="build-cleanup">
      <div className="build-cleanup-row">
        <div className="build-cleanup-what">
          <span id="build-cleanup-label" className="storage-name">{t.label}</span>
          <span className="storage-detail">{t.note}</span>
        </div>
        <button
          type="button"
          role="switch"
          className="settings-switch"
          aria-checked={on}
          aria-labelledby="build-cleanup-label"
          disabled={saving || !!confirming}
          onClick={() => void (on ? save(false, false) : startTurningOn())}
        />
      </div>
      <div className="build-cleanup-row">
        <label className="build-cleanup-what" htmlFor="build-cleanup-days">
          <span className="storage-name">{t.keep}</span>
          <span className="storage-detail">{t.keepNote(max)}</span>
        </label>
        <span className="build-cleanup-days">
          <input
            id="build-cleanup-days"
            className="settings-input"
            type="number"
            inputMode="numeric"
            min={0}
            max={max}
            step={1}
            value={days}
            aria-invalid={!daysValid}
            disabled={saving}
            onChange={(event) => setDays(event.target.value)}
          />
          <span>{t.days}</span>
          {String(view.policy.keepDays) !== days.trim() && !confirming && (
            <button type="button" className="secondary-button" disabled={!daysValid || saving} onClick={() => void save(on, false)}>
              {saving ? t.saving : t.save}
            </button>
          )}
        </span>
      </div>
      {!daysValid && <p className="updates-error">{t.daysInvalid(max)}</p>}
      <p className="storage-note" data-policy={on ? "on" : "off"}>
        {on ? t.on(view.policy.since ? at(view.policy.since) : null) : t.off}
      </p>

      {confirming && (
        <div className="storage-confirm" role="group" aria-label={t.turnOn}>
          {confirming.error ? (
            <p className="updates-error" role="alert">{t.couldNotCount(confirming.error)}</p>
          ) : !backlog ? (
            <p className="storage-note">{t.counting}</p>
          ) : (
            <>
              <p className="storage-note" data-backlog={backlog.folders}>{t.backlog(backlog.folders, sizeText(backlog.bytes), backlog.kept)}</p>
              {!backlog.complete && <p className="storage-note">{t.partial(backlog.checked, backlog.executors)}</p>}
              {backlog.items.length > 0 && (
                <ul className="storage-rows">
                  {backlog.items.slice(0, BACKLOG_SHOWN).map((item) => (
                    <li key={item.path}>
                      <span className="storage-name"><code>{item.path}</code></span>
                      <span className="storage-size">{sizeText(item.bytes)}</span>
                      <span className="storage-detail">{item.executor}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="storage-note">{t.counted}</p>
            </>
          )}
          <fieldset className="build-cleanup-choice" disabled={saving}>
            <label>
              <input type="radio" name="build-cleanup-earlier" checked={confirming.earlier}
                onChange={() => setConfirming((was) => (was ? { ...was, earlier: true } : was))} /> {t.earlier}
            </label>
            <label>
              <input type="radio" name="build-cleanup-earlier" checked={!confirming.earlier}
                onChange={() => setConfirming((was) => (was ? { ...was, earlier: false } : was))} /> {t.laterOnly}
            </label>
          </fieldset>
          <p>
            <button type="button" className="secondary-button" disabled={saving} onClick={() => void save(true, confirming.earlier)}>
              {saving ? t.saving : confirming.earlier && cleanable ? t.confirmClean : t.confirm}
            </button>{" "}
            <button type="button" className="secondary-button" disabled={saving} onClick={() => setConfirming(null)}>
              {t.cancel}
            </button>
          </p>
        </div>
      )}
      {saveError && <p className="updates-error" role="alert">{t.couldNotSave(saveError)}</p>}

      {view.recent.length > 0 && (
        <>
          <h5 className="build-cleanup-recent">{t.recent}</h5>
          <ul className="storage-rows" data-recent>
            {view.recent.flatMap((outcome) =>
              outcome.results.map((result) => {
                const gaveUp = outcome.state === "gaveUp";
                const detail = [
                  outcome.executor?.name,
                  ...result.how.map(t.how),
                  result.state === "removed" ? t.removedAt(at(outcome.updatedAt)) : null,
                  ...result.reasons,
                  result.state === "waiting" && gaveUp ? t.gaveUpNote : null,
                  result.state === "waiting" && !gaveUp && outcome.nextTryAt ? t.nextTry(at(outcome.nextTryAt)) : null,
                ].filter(Boolean);
                return (
                  <li key={`${outcome.executor?.id ?? ""}:${result.path}`} data-result={gaveUp && result.state === "waiting" ? "gaveUp" : result.state}>
                    <span className="storage-name">
                      <span className={`build-cleanup-pill build-cleanup-${gaveUp && result.state === "waiting" ? "gaveUp" : result.state}`}>
                        {t.state(result.state, gaveUp)}
                      </span>{" "}
                      {outcome.taskId ? `${outcome.taskId} · ` : ""}
                      <code>{result.path}</code>
                    </span>
                    <span className="storage-size">{typeof result.bytes === "number" ? sizeText(result.bytes) : t.noSize}</span>
                    <span className="storage-detail">{detail.join(" · ")}</span>
                  </li>
                );
              }),
            )}
          </ul>
        </>
      )}
      {view.waiting > 0 && <p className="storage-note">{t.waiting(view.waiting)}</p>}
    </div>
  );
}
