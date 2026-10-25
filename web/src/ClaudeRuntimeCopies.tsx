import { useState } from "react";
import { api, errorText } from "./api";
import { strings, useLanguage } from "./i18n";
import { sizeText } from "./storage-overview";

/** A copy of the Claude runtime Core prepared, as Core lists it (T-193). */
type RuntimeCopy = {
  /** Its content key; `null` for a name that isn't a copy's. */
  key: string | null;
  version: string | null;
  at: string | null;
  bytes: number | null;
  usedBy: "thisCore" | "installedRelease" | null;
  removable: boolean;
  problem: string | null;
};
type CopiesView = { state: "ready" | "refused"; reason?: string; copies: RuntimeCopy[]; limited: boolean };
type Outcome = "removed" | "partly" | "failed" | "protected" | "notFound" | "unknown";
type RemovalResult = { key: string; outcome: Outcome; bytes?: number | null; error?: string };
type Removal = { state: "done" | "refused"; reason?: string; results: RemovalResult[] };

const refusalsZh: Record<string, string> = {
  notRelease: "这个 Core 不是从已安装的发布版本运行的，因此无法判断各发布版本需要哪些运行环境。没有可移除的项。",
  installing: "正在安装更新。安装完成后请再次检查。",
  releasesUnreadable: "无法读取某个已安装发布版本的运行环境，因此无法判断它需要什么。没有可移除的项。",
  cacheUnreadable: "Core 无法读取保存这些副本的文件夹。",
  cacheUnset: "Core 还没有为这些副本设置文件夹。",
  badChoice: "这个选择无法移除。",
  interrupted: "移除被中断。请再次检查。",
};
const refusals: Record<string, string> = {
  notRelease: "This Core isn't running from an installed release, so it can't tell which runtimes its releases need. Nothing is offered for removal.",
  installing: "An update is being installed. Check again once it has finished.",
  releasesUnreadable: "An installed release's runtime couldn't be read, so what it needs can't be told. Nothing is offered for removal.",
  cacheUnreadable: "Core couldn't read the folder these copies are kept in.",
  cacheUnset: "Core hasn't set up a folder for these copies.",
  badChoice: "That choice can't be removed.",
  interrupted: "The removal was interrupted. Check again.",
};

const text = strings({
  title: "Claude runtimes Core prepared",
  note: "Core prepares a copy of the Claude runtime, with the Claude Agent SDK in it, for each release that needs one, and keeps it in the Workspace's folder. A copy no installed release needs can be removed. If a Core that needs it runs later, it prepares the copy again, which may download the SDK.",
  check: "Check prepared runtimes",
  checkAgain: "Check again",
  checking: "Checking…",
  couldNotRead: (error: string) => `Could not read the prepared runtimes: ${error}`,
  refused: (reason: string) => refusals[reason] ?? reason,
  none: "Core has no prepared runtimes.",
  limited: "Only the first 64 entries are listed.",
  name: (version: string | null, key: string) => `Claude Agent SDK ${version ?? "(version unknown)"} · runtime ${key.slice(0, 8)}`,
  notACopy: "Not a copy Core made",
  about: (size: string) => `about ${size}`,
  sizeUnknown: "size unknown",
  prepared: (date: string) => `prepared ${date}`,
  thisCore: "Used by this Core",
  installedRelease: "Needed by an installed release",
  unneeded: "No installed release needs it",
  problem: (problem: string) =>
    problem === "notFolder" ? "Not a plain folder: kept"
      : problem === "unknownName" ? "Kept"
        : "Its record of what it is can't be read: kept",
  choose: (name: string) => `Remove ${name}`,
  removeChosen: "Remove chosen…",
  confirm: (count: number, size: string | null) =>
    `Remove ${count} prepared ${count === 1 ? "runtime" : "runtimes"}${size ? `, about ${size}` : ""}? Core checks again first that no installed release needs ${count === 1 ? "it" : "them"}. A Core that needs one later prepares it again, which may download the Claude Agent SDK.`,
  remove: "Remove",
  cancel: "Cancel",
  removing: "Removing…",
  couldNotRemove: (error: string) => `Could not remove: ${error}`,
  result: (result: RemovalResult) => {
    const which = `Runtime ${result.key.slice(0, 8)}`;
    switch (result.outcome) {
      case "removed": return `${which}: removed${typeof result.bytes === "number" ? `, about ${sizeText(result.bytes)} freed` : ""}.`;
      case "partly": return `${which}: moved aside, but not all of it could be removed (${result.error ?? "no reason given"}). What is left is never used, and goes when Core next prepares a runtime; its space is not counted as freed.`;
      case "failed": return `${which}: not removed. It couldn't be moved aside (${result.error ?? "no reason given"}), so it is as it was.`;
      case "protected": return `${which}: kept. An installed release needs it, or this Core uses it.`;
      case "notFound": return `${which}: already gone.`;
      default: return `${which}: kept. Core can't tell it is a copy it made.`;
    }
  },
}, {
  title: "Core 准备的 Claude 运行环境",
  note: "Core 会为每个需要的发布版本准备一份包含 Claude Agent SDK 的 Claude 运行环境副本，保存在 Workspace 的文件夹中。没有任何已安装发布版本需要的副本可以移除。之后如果有需要它的 Core 运行，会重新准备这份副本，可能需要下载 SDK。",
  check: "检查已准备的运行环境",
  checkAgain: "再次检查",
  checking: "正在检查…",
  couldNotRead: (error) => `无法读取已准备的运行环境：${error}`,
  refused: (reason) => refusalsZh[reason] ?? reason,
  none: "Core 没有已准备的运行环境。",
  limited: "只列出前 64 项。",
  name: (version, key) => `Claude Agent SDK ${version ?? "（版本未知）"} · 运行环境 ${key.slice(0, 8)}`,
  notACopy: "不是 Core 制作的副本",
  about: (size) => `约 ${size}`,
  sizeUnknown: "大小未知",
  prepared: (date) => `准备于 ${date}`,
  thisCore: "此 Core 正在使用",
  installedRelease: "某个已安装的发布版本需要",
  unneeded: "没有已安装的发布版本需要",
  problem: (problem) =>
    problem === "notFolder" ? "不是普通文件夹：保留"
      : problem === "unknownName" ? "保留"
        : "无法读取它的记录：保留",
  choose: (name) => `移除 ${name}`,
  removeChosen: "移除所选…",
  confirm: (count, size) =>
    `移除 ${count} 个已准备的运行环境${size ? `，约 ${size}` : ""}？Core 会先再次确认没有已安装的发布版本需要它们。之后需要它的 Core 会重新准备，可能需要下载 Claude Agent SDK。`,
  remove: "移除",
  cancel: "取消",
  removing: "正在移除…",
  couldNotRemove: (error) => `无法移除：${error}`,
  result: (result) => {
    const which = `运行环境 ${result.key.slice(0, 8)}`;
    switch (result.outcome) {
      case "removed": return `${which}：已移除${typeof result.bytes === "number" ? `，约释放 ${sizeText(result.bytes)}` : ""}。`;
      case "partly": return `${which}：已移到一旁，但未能全部移除（${result.error ?? "未给出原因"}）。剩下的部分不会被使用，会在 Core 下次准备运行环境时清除；它的空间不计为已释放。`;
      case "failed": return `${which}：未移除。无法将它移到一旁（${result.error ?? "未给出原因"}），因此保持原样。`;
      case "protected": return `${which}：已保留。某个已安装的发布版本需要它，或此 Core 正在使用它。`;
      case "notFound": return `${which}：已经不在了。`;
      default: return `${which}：已保留。Core 无法确定它是 Core 制作的副本。`;
    }
  },
});

function at(iso: string) {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Settings → Data & storage → the Claude runtimes Core prepared (T-193).
 * Nothing is read until Check: Core hashes each installed release's runtime
 * to tell which copies are needed. Only copies no installed release needs
 * can be chosen, and Core checks that again before it removes any.
 */
export function ClaudeRuntimeCopies() {
  const t = text(useLanguage());
  const [view, setView] = useState<CopiesView | null>(null);
  const [checking, setChecking] = useState(false);
  const [readError, setReadError] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [removeError, setRemoveError] = useState("");

  const check = async () => {
    setChecking(true);
    setReadError("");
    try {
      const next = await api<CopiesView>("/claude-sdk/copies");
      setView(next);
      // Only what can still be removed stays chosen.
      setChosen((was) => was.filter((key) => next.copies.some((copy) => copy.removable && copy.key === key)));
    } catch (e) {
      setReadError(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    setRemoveError("");
    try {
      setRemoval(await api<Removal>("/claude-sdk/copies/remove", { method: "POST", body: JSON.stringify({ keys: chosen }) }));
      setConfirming(false);
      setChosen([]);
    } catch (e) {
      setRemoveError(errorText(e));
    } finally {
      setRemoving(false);
    }
    await check();
  };

  const removable = view?.copies.filter((copy) => copy.removable && copy.key) ?? [];
  const chosenCopies = removable.filter((copy) => chosen.includes(copy.key!));
  const chosenBytes = chosenCopies.every((copy) => typeof copy.bytes === "number")
    ? chosenCopies.reduce((sum, copy) => sum + (copy.bytes ?? 0), 0)
    : null;

  return (
    <section className="storage-part claude-runtime-copies" aria-labelledby="storage-claude-runtimes">
      <h4 id="storage-claude-runtimes">{t.title}</h4>
      <p className="storage-note">{t.note}</p>
      <p>
        <button type="button" className="secondary-button" disabled={checking || removing} onClick={() => void check()}>
          {checking ? t.checking : view ? t.checkAgain : t.check}
        </button>
      </p>
      {readError && <p className="updates-error" role="alert">{t.couldNotRead(readError)}</p>}
      {view?.state === "refused" && <p className="storage-note" data-refused={view.reason}>{t.refused(view.reason ?? "")}</p>}
      {view?.state === "ready" && view.copies.length === 0 && <p className="storage-note">{t.none}</p>}
      {view?.state === "ready" && view.copies.length > 0 && (
        <ul className="storage-rows">
          {view.copies.map((copy, index) => {
            const name = copy.key ? t.name(copy.version, copy.key) : t.notACopy;
            const status = copy.problem ? t.problem(copy.problem)
              : copy.usedBy === "thisCore" ? t.thisCore
                : copy.usedBy === "installedRelease" ? t.installedRelease
                  : t.unneeded;
            return (
              <li key={copy.key ?? `other-${index}`} data-copy={copy.key ?? "other"}>
                <span className="storage-name">
                  {copy.removable && copy.key ? (
                    <label>
                      <input
                        type="checkbox"
                        aria-label={t.choose(name)}
                        checked={chosen.includes(copy.key)}
                        disabled={removing}
                        onChange={(event) => {
                          const key = copy.key!;
                          setConfirming(false);
                          setChosen((was) => (event.target.checked ? [...was.filter((k) => k !== key), key] : was.filter((k) => k !== key)));
                        }}
                      />{" "}
                      {name}
                    </label>
                  ) : name}
                </span>
                <span className="storage-size">{typeof copy.bytes === "number" ? t.about(sizeText(copy.bytes)) : t.sizeUnknown}</span>
                <span className="storage-detail">
                  {copy.at ? `${t.prepared(at(copy.at))} · ` : ""}
                  {status}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {view?.limited && <p className="storage-note">{t.limited}</p>}
      {removable.length > 0 && !confirming && (
        <p>
          <button type="button" className="secondary-button" disabled={chosen.length === 0 || removing || checking} onClick={() => setConfirming(true)}>
            {t.removeChosen}
          </button>
        </p>
      )}
      {confirming && chosenCopies.length > 0 && (
        <div className="storage-confirm" role="group" aria-label={t.removeChosen}>
          <p className="storage-note">{t.confirm(chosenCopies.length, chosenBytes === null ? null : sizeText(chosenBytes))}</p>
          <button type="button" className="secondary-button" disabled={removing} onClick={() => void remove()}>
            {removing ? t.removing : t.remove}
          </button>{" "}
          <button type="button" className="secondary-button" disabled={removing} onClick={() => setConfirming(false)}>
            {t.cancel}
          </button>
        </div>
      )}
      {removeError && <p className="updates-error" role="alert">{t.couldNotRemove(removeError)}</p>}
      {removal?.state === "refused" && <p className="updates-error" role="alert">{t.refused(removal.reason ?? "")}</p>}
      {removal?.state === "done" && (
        <ul className="storage-list" aria-live="polite">
          {removal.results.map((result) => (
            <li key={result.key} data-result={result.outcome}>{t.result(result)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
