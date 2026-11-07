import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { errorText } from "./api";
import { readHandover, saveHandover, type Handover } from "./project-handover";
import { langTag, strings, useLanguage } from "./i18n";
import "./project-handover.css";

const text = strings({
  title: "Handover",
  section: "This project's handover document",
  intro: "What this project already knows, for an executor that starts cold: how to build and test, where things are, what to avoid. Every executor of the project starts with it. The project's leads write it; you can change it here too.",
  reading: "Reading the handover…",
  document: "Handover document",
  bytes: (used: number, limit: number) => `${used} of ${limit} bytes.`,
  note: "Note",
  notePlaceholder: "Optional: what changed",
  chars: (used: number, limit: number) => `${used} of ${limit} characters.`,
  save: "Save handover",
  saved: "Saved.",
  unsaved: "Unsaved changes",
  tooLarge: (limit: number) => `At most ${limit} bytes.`,
  noteTooLong: (limit: number) => `At most ${limit} characters.`,
  reload: "Reload the saved handover",
  never: "Not written yet.",
  you: "you",
  lastChanged: (who: string, at: string) => `Last changed by ${who}, ${at}`,
}, {
  title: "交接文档",
  section: "此项目的交接文档",
  intro: "此项目已知的内容，供从零开始的执行者使用：如何构建与测试、东西在哪、要避免什么。此项目的每个执行者开工时都会拿到它。由项目的负责人来写；你也可以在这里修改。",
  reading: "正在读取交接文档…",
  document: "交接文档",
  bytes: (used, limit) => `${used} / ${limit} 字节。`,
  note: "说明",
  notePlaceholder: "可选：改了什么",
  chars: (used, limit) => `${used} / ${limit} 个字符。`,
  save: "保存交接文档",
  saved: "已保存。",
  unsaved: "有未保存的更改",
  tooLarge: (limit) => `最多 ${limit} 字节。`,
  noteTooLong: (limit) => `最多 ${limit} 个字符。`,
  reload: "重新读取已保存的交接文档",
  never: "还没有写过。",
  you: "你",
  lastChanged: (who, at) => `最后由${who}修改，${at}`,
});

const bytes = (value: string) => new TextEncoder().encode(value).length;
/** As Core's `handover::MAX_NOTE`: the trimmed note, in characters. */
const NOTE_CHARS = 200;

/** A Project's handover document in its settings (T-34): the user's editor, saved against the revision read, with an
 * optional note, and who changed it last (a lead or you). No history is shown (YN-2 S3, the user's decision). */
export function ProjectHandover({ projectId, disabled = false }: { projectId: string; disabled?: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const [view, setView] = useState<Handover | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [reload, setReload] = useState(0);
  const adopt = (next: Handover) => {
    setView(next);
    setDraft(next.markdown);
    setNote("");
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
  const noteSize = [...note.trim()].length;
  const noteTooLong = noteSize > NOTE_CHARS;
  const locked = disabled || busy;
  async function save() {
    if (!view) return;
    setBusy(true);
    setError("");
    try {
      adopt(await saveHandover(projectId, view.version, draft, note));
      setDone(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const when = (at: string) => new Date(at).toLocaleString(langTag(language));
  const last = view?.lastModified;
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
        <p className="settings-row-help project-handover-modified">
          {last ? <>
            {t.lastChanged(last.by.id === "user" ? t.you : last.by.name, when(last.at))}
            {last.note && <span className="project-handover-note"> · {last.note}</span>}
          </> : t.never}
        </p>
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
            <span className="settings-row-title">{t.note}</span>
            <span className="settings-row-help">{t.chars(noteSize, NOTE_CHARS)}</span>
          </span>
          <input className="settings-input" aria-label={t.note} value={note} placeholder={t.notePlaceholder}
            disabled={locked} onChange={e => setNote(e.target.value)} />
        </label>
        {noteTooLong && <p className="inline-error" role="alert">{t.noteTooLong(NOTE_CHARS)}</p>}
        <div className="project-handover-actions">
          <button type="button" className="secondary-button" disabled={locked || !changed || tooLarge || noteTooLong} onClick={() => void save()}>
            {busy && <LoaderCircle size={13} className="spin" />} {t.save}
          </button>
          {changed ? <span className="settings-row-help">{t.unsaved}</span> : done && <span className="settings-row-help" role="status">{t.saved}</span>}
        </div>
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {error && <button type="button" className="quiet-button" disabled={busy} onClick={() => setReload(n => n + 1)}>{t.reload}</button>}
    </section>
  );
}
