import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { errorText } from "./api";
import { readHandover, readHandoverVersion, saveHandover, type Handover, type HandoverVersion } from "./project-handover";
import { langTag, strings, useLanguage } from "./i18n";
import "./project-handover.css";

const text = strings({
  title: "Handover",
  section: "This project's handover document",
  intro: "What this project already knows, for an executor that starts cold: how to build and test, where things are, what to avoid. Every executor of the project starts with it. The project's leads write it; here you can read every version, restore one, or change it yourself.",
  reading: "Reading the handover…",
  document: "Handover document",
  bytes: (used: number, limit: number) => `${used} of ${limit} bytes.`,
  reason: "Why this change",
  reasonPlaceholder: "Optional, kept with this version",
  save: "Save handover",
  saved: "Saved.",
  unsaved: "Unsaved changes",
  tooLarge: (limit: number) => `At most ${limit} bytes.`,
  reload: "Reload the saved handover",
  history: "Versions",
  none: "No version yet.",
  version: (n: number) => `Version ${n}`,
  by: (name: string, at: string) => `${name}, ${at}`,
  approvedBy: (name: string, at: string) => `${name}, approved by you, ${at}`,
  show: (n: number) => `Show version ${n}`,
  restore: (n: number) => `Restore version ${n}`,
  restored: (n: number) => `Restored version ${n}`,
  saveFirst: "Save or discard your edits first",
  hide: "Hide",
  emptyVersion: "This version is empty.",
}, {
  title: "交接文档",
  section: "此项目的交接文档",
  intro: "此项目已知的内容，供从零开始的执行者使用：如何构建与测试、东西在哪、要避免什么。此项目的每个执行者开工时都会拿到它。由项目的负责人来写；你可以在这里查看每个版本、恢复某个版本，或者自己修改。",
  reading: "正在读取交接文档…",
  document: "交接文档",
  bytes: (used, limit) => `${used} / ${limit} 字节。`,
  reason: "更改原因",
  reasonPlaceholder: "可选，随此版本保存",
  save: "保存交接文档",
  saved: "已保存。",
  unsaved: "有未保存的更改",
  tooLarge: (limit) => `最多 ${limit} 字节。`,
  reload: "重新读取已保存的交接文档",
  history: "版本",
  none: "还没有版本。",
  version: (n) => `第 ${n} 版`,
  by: (name, at) => `${name}，${at}`,
  approvedBy: (name, at) => `${name}，经你批准，${at}`,
  show: (n) => `查看第 ${n} 版`,
  restore: (n) => `恢复第 ${n} 版`,
  restored: (n) => `恢复为第 ${n} 版`,
  saveFirst: "先保存或放弃你的修改",
  hide: "收起",
  emptyVersion: "此版本为空。",
});

const bytes = (value: string) => new TextEncoder().encode(value).length;
/** As Core's `handover::MAX_REASON`: the trimmed reason, in UTF-8 bytes. */
const REASON_BYTES = 1_000;

/** A Project's handover document in its settings (T-34): the user's editor, saved against the version read, with its
 * versions, who wrote each and why; a past one can be restored as a new version (YN-2 S3). */
export function ProjectHandover({ projectId, disabled = false }: { projectId: string; disabled?: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const [view, setView] = useState<Handover | null>(null);
  const [draft, setDraft] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [reload, setReload] = useState(0);
  const [past, setPast] = useState<HandoverVersion | null>(null);
  const adopt = (next: Handover) => {
    setView(next);
    setDraft(next.markdown);
    setReason("");
  };
  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    setError("");
    readHandover(projectId, controller.signal).then(next => {
      if (!controller.signal.aborted) adopt(next);
    }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [projectId, reload]);
  const changed = !!view && draft !== view.markdown;
  const size = bytes(draft);
  const tooLarge = !!view && size > view.limit;
  const reasonSize = bytes(reason.trim());
  const reasonTooLong = reasonSize > REASON_BYTES;
  const locked = disabled || busy;
  async function save() {
    if (!view) return;
    setBusy(true);
    setError("");
    try {
      adopt(await saveHandover(projectId, view.version, draft, reason));
      setDone(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  // A past version saved again as a new one, with why: the user's own save (YN-2 S3).
  async function restore(version: number) {
    // Restoring replaces the draft: never over unsaved edits (#661 R1).
    if (!view || changed) return;
    setBusy(true);
    setError("");
    try {
      const markdown = past?.version === version && typeof past.markdown === "string"
        ? past.markdown : (await readHandoverVersion(projectId, version)).past.markdown ?? "";
      adopt(await saveHandover(projectId, view.version, markdown, t.restored(version)));
      setPast(null);
      setDone(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function show(version: number) {
    if (past?.version === version) return setPast(null);
    try {
      setPast((await readHandoverVersion(projectId, version)).past);
    } catch (e) {
      setError(errorText(e));
    }
  }
  const when = (at: string) => new Date(at).toLocaleString(langTag(language));
  return (
    <section id="project-settings-handover" className="settings-section project-handover" aria-label={t.section} lang={langTag(language)}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.title}</h3>
          <p>{t.intro}</p>
        </div>
      </header>
      {!view && !error && <p className="settings-row-help" role="status">{t.reading}</p>}
      {view && <>
        <label className="settings-row project-handover-document">
          <span className="settings-row-main">
            <span className="settings-row-title">{t.document}</span>
            <span className="settings-row-help">{t.bytes(size, view.limit)}</span>
          </span>
          <textarea className="settings-textarea" aria-label={t.document} rows={10} value={draft} disabled={locked}
            onChange={e => { setDone(false); setDraft(e.target.value); }} />
        </label>
        {tooLarge && <p className="inline-error" role="alert">{t.tooLarge(view.limit)}</p>}
        <label className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">{t.reason}</span>
            <span className="settings-row-help">{t.bytes(reasonSize, REASON_BYTES)}</span>
          </span>
          <input className="settings-input" aria-label={t.reason} value={reason} placeholder={t.reasonPlaceholder}
            disabled={locked} onChange={e => setReason(e.target.value)} />
        </label>
        {reasonTooLong && <p className="inline-error" role="alert">{t.tooLarge(REASON_BYTES)}</p>}
        <div className="project-handover-actions">
          <button type="button" className="secondary-button" disabled={locked || !changed || tooLarge || reasonTooLong} onClick={() => void save()}>
            {busy && <LoaderCircle size={13} className="spin" />} {t.save}
          </button>
          {changed ? <span className="settings-row-help">{t.unsaved}</span> : done && <span className="settings-row-help" role="status">{t.saved}</span>}
        </div>
        <h4 className="project-handover-history-title">{t.history}</h4>
        {view.history.length === 0 ? <p className="settings-row-help">{t.none}</p> : (
          <ol className="project-handover-history">
            {view.history.map(v => (
              <li key={v.version}>
                <span className="project-handover-version">{t.version(v.version)}</span>
                <span className="settings-row-help">{v.approvedBy ? t.approvedBy(v.writtenBy.name, when(v.at)) : t.by(v.writtenBy.name, when(v.at))}</span>
                {v.reason && <span className="project-handover-reason">{v.reason}</span>}
                <button type="button" className="quiet-button" aria-expanded={past?.version === v.version} onClick={() => void show(v.version)}>
                  {past?.version === v.version ? t.hide : t.show(v.version)}
                </button>
                {v.version !== view.version && (
                  <button type="button" className="quiet-button" disabled={locked || changed}
                    title={changed ? t.saveFirst : undefined} onClick={() => void restore(v.version)}>
                    {t.restore(v.version)}
                  </button>
                )}
                {past?.version === v.version && (
                  <pre className="project-handover-past">{past.markdown?.trim() ? past.markdown : t.emptyVersion}</pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {error && <button type="button" className="quiet-button" disabled={busy} onClick={() => setReload(n => n + 1)}>{t.reload}</button>}
    </section>
  );
}
