import { Component, Fragment, useState, type ReactNode } from "react";
import { Copy, Download, Eye, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { clearRecordedErrors, diagnosticsText, errorRecordProblem, gatherFacts, recordError, recordedErrors } from "./diagnostics";
import { strings, TranslatedPart, useStrings } from "./i18n";
import "./diagnostics.css";

// Diagnostics' words in the interface language (T-189). The report itself
// (its text, fields and redaction), what is copied or saved, and what this
// browser says of an error stay as they are; the reasons this code words
// itself are said in the language shown.
const recordProblemZh = (reason: string) => {
  const fixed: Record<string, string> = {
    "this browser gives Yuzuno no storage here": "此浏览器不给 Yuzuno 在这里存储",
    "the record saved here is not valid JSON": "这里保存的记录不是有效的 JSON",
    "the record saved here is not an error record": "这里保存的记录不是错误记录",
  };
  const refused = /^this browser refused to save the change \((.*)\)$/.exec(reason);
  return fixed[reason] ?? (refused ? `此浏览器拒绝保存这次更改（${refused[1]}）` : reason);
};
const words = strings({
  copied: "Copied. Nothing was sent anywhere; paste it where you report the problem.",
  select: "This window can't use the clipboard. Select the text below and copy it.",
  textLabel: "Diagnostics",
  title: "Diagnostics",
  intro: (errors: number) =>
    `Versions, connection and the errors this window recorded (${errors === 0 ? "none" : errors}), to paste into a report. No conversations, drafts or credentials. Preview it first: nothing is copied, saved or sent until you choose.`,
  preview: (again: boolean) => (again ? "Preview again" : "Preview diagnostics"),
  gathering: "Gathering…",
  shown: "This is the whole text. Nothing has been copied, saved or sent.",
  saving: (name: string) => `Your browser was asked to save ${name}. If no file appears, select the text below and copy it.`,
  notSaved: (why: string) => `The download could not start (${why}). Select the text below and copy it.`,
  beforeClear: "This text was gathered before the recorded errors were cleared. Preview again for the record as it is now.",
  copy: "Copy",
  download: "Download .txt",
  record: (problem: string | null, errors: number) =>
    `${
      problem
        ? `The recorded errors can't be cleared here: ${problem}.`
        : errors === 0
          ? "No errors are recorded in this browser for this site."
          : `${errors} recorded ${errors === 1 ? "error is" : "errors are"} kept in this browser for this site.`
    } Clearing removes only these error records and can't be undone. Core's and the desktop app's last-read versions stay, and so do drafts, settings, conversations and Core's logs. Errors after that are recorded as before.`,
  clear: "Clear recorded errors",
  cleared: (count: number) => `Cleared ${count} recorded ${count === 1 ? "error" : "errors"} from this browser for this site.`,
  notCleared: (reason: string) => `Nothing was cleared: ${reason}. The recorded errors are kept as they were.`,
}, {
  copied: "已复制。没有发送到任何地方；请粘贴到你报告问题的地方。",
  select: "此窗口无法使用剪贴板。请选择下方文本并复制。",
  textLabel: "诊断信息",
  title: "诊断信息",
  intro: (errors) =>
    `版本、连接，以及此窗口记录的错误（${errors === 0 ? "无" : errors}），可粘贴到问题报告中。不含会话、草稿或凭据。请先预览：在你选择之前，不会复制、保存或发送任何内容。`,
  preview: (again) => (again ? "重新预览" : "预览诊断信息"),
  gathering: "正在收集…",
  shown: "这就是全部文本。尚未复制、保存或发送任何内容。",
  saving: (name) => `已请浏览器保存 ${name}。如果没有出现文件，请选择下方文本并复制。`,
  notSaved: (why) => `无法开始下载（${why}）。请选择下方文本并复制。`,
  beforeClear: "此文本是在清除已记录的错误之前收集的。重新预览可查看当前的记录。",
  copy: "复制",
  download: "下载 .txt",
  record: (problem, errors) =>
    `${
      problem
        ? `此处无法清除已记录的错误：${recordProblemZh(problem)}。`
        : errors === 0
          ? "此浏览器没有为此站点记录任何错误。"
          : `此浏览器为此站点保存了 ${errors} 条已记录的错误。`
    }清除只会删除这些错误记录，且无法撤销。Core 和桌面应用最近读取的版本会保留，草稿、设置、会话和 Core 的日志也都保留。之后的错误照常记录。`,
  clear: "清除已记录的错误",
  cleared: (count) => `已从此浏览器为此站点清除 ${count} 条已记录的错误。`,
  notCleared: (reason) => `没有清除任何内容：${recordProblemZh(reason)}。已记录的错误保持原样。`,
});

/**
 * Copies this window's diagnostics (diagnostics.ts). Where the clipboard can't
 * be used (no permission, an older desktop), the same text is shown to select
 * and copy by hand. Either way the text is shown, so the user sees what they
 * pass on.
 */
function useDiagnosticsCopy() {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "reading" | "copied" | "select">("idle");
  async function copy() {
    if (state === "reading") return;
    setState("reading");
    let value: string;
    try {
      value = diagnosticsText(await gatherFacts());
    } catch {
      value = diagnosticsText(null);
    }
    setText(value);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("select");
    }
  }
  return { text, state, copy };
}

function DiagnosticsText({ text, state }: { text: string | null; state: string }) {
  const t = useStrings(words);
  return (
    <>
      {state === "copied" && (
        <p className="diagnostics-note" role="status">
          {t.copied}
        </p>
      )}
      {state === "select" && (
        <p className="diagnostics-note" role="status">
          {t.select}
        </p>
      )}
      {text !== null && (
        <textarea
          className="diagnostics-text"
          aria-label={t.textLabel}
          readOnly
          rows={10}
          value={text}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
    </>
  );
}

/** What shows instead of the app when it could not be drawn at all. */
function RecoveryPage({ failures, onRetry }: { failures: number; onRetry: () => void }) {
  const { text, state, copy } = useDiagnosticsCopy();
  return (
    // Not translated in this version: English throughout, its shared parts too.
    <main className="app-recovery" aria-labelledby="app-recovery-title" lang="en">
      <TranslatedPart value={false}>
      <div className="app-recovery-card">
        <h1 id="app-recovery-title">Yuzuno couldn't show this screen</h1>
        <p>
          Your conversations, drafts and settings are kept: nothing was cleared. Try again, or
          reload the window. If it keeps happening, copy the diagnostics and send them with your
          report.
        </p>
        {failures > 1 && (
          <p className="diagnostics-note" role="status">
            It failed again ({failures} times in this window).
          </p>
        )}
        <div className="app-recovery-actions">
          <button type="button" className="primary-button" onClick={onRetry}>
            <RotateCcw size={14} aria-hidden="true" /> Try again
          </button>
          <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
            <RefreshCw size={14} aria-hidden="true" /> Reload
          </button>
          <button type="button" className="secondary-button" onClick={() => void copy()} disabled={state === "reading"}>
            <Copy size={14} aria-hidden="true" /> Copy diagnostics
          </button>
        </div>
        <DiagnosticsText text={text} state={state} />
      </div>
      </TranslatedPart>
    </main>
  );
}

/**
 * The app's last boundary: an error no part of the app handled shows the
 * recovery page instead of leaving the window blank. Trying again draws the
 * app anew; reloading reloads the window. Neither clears anything stored.
 */
export class AppRecovery extends Component<{ children: ReactNode }, { failed: boolean; failures: number; attempt: number }> {
  state = { failed: false, failures: 0, attempt: 0 };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    recordError("render", error);
    this.setState((state) => ({ failures: state.failures + 1 }));
  }
  render() {
    if (this.state.failed)
      return (
        <RecoveryPage
          failures={this.state.failures}
          onRetry={() => this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }))}
        />
      );
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}

/**
 * Settings' diagnostics (T-193): the text is gathered and shown first, and
 * leaves this window only when the user then copies it or saves it as a text
 * file. Nothing is written to the clipboard or saved before that. The errors
 * recorded on this device are cleared only when the user asks.
 */
function useDiagnosticsPreview() {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "reading" | "shown" | "copied" | "select" | "saving" | "notSaved">("idle");
  const [saved, setSaved] = useState("");
  const [why, setWhy] = useState("");
  const [cleared, setCleared] = useState<ReturnType<typeof clearRecordedErrors> | null>(null);
  const [beforeClear, setBeforeClear] = useState(false);
  async function preview() {
    if (state === "reading") return;
    setState("reading");
    setBeforeClear(false);
    let value: string;
    try {
      value = diagnosticsText(await gatherFacts());
    } catch {
      value = diagnosticsText(null);
    }
    setText(value);
    setState("shown");
  }
  // While Preview again gathers, the text shown is about to change: nothing leaves.
  async function copy() {
    if (text === null || state === "reading") return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("select");
    }
  }
  function download() {
    if (text === null || state === "reading") return;
    const name = `yuzuno-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    try {
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      // The page can ask for a download; whether the file was saved is the browser's to say.
      setSaved(name);
      setState("saving");
    } catch (error) {
      setWhy(error instanceof Error && error.message ? error.message : String(error));
      setState("notSaved");
    }
  }
  // Only the recorded errors, and only when asked; a text shown already was
  // gathered before, and says so.
  function clear() {
    if (state === "reading") return;
    const result = clearRecordedErrors();
    setCleared(result);
    if ("cleared" in result && text !== null) setBeforeClear(true);
  }
  return { text, state, saved, why, cleared, beforeClear, preview, copy, download, clear };
}

/** The same diagnostics while the app works: in Settings, next to the versions. */
export function DiagnosticsCopy() {
  const t = useStrings(words);
  const { text, state, saved, why, cleared, beforeClear, preview, copy, download, clear } = useDiagnosticsPreview();
  const errors = recordedErrors().length;
  const problem = errorRecordProblem();
  return (
    <section id="settings-diagnostics" className="settings-section diagnostics-section" aria-label={t.title}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.title}</h3>
          <p>{t.intro(errors)}</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void preview()} disabled={state === "reading"}>
          <Eye size={14} aria-hidden="true" /> {t.preview(text !== null)}
        </button>
      </header>
      {state === "reading" && (
        <p className="diagnostics-note" role="status">
          {t.gathering}
        </p>
      )}
      {state === "shown" && (
        <p className="diagnostics-note" role="status">
          {t.shown}
        </p>
      )}
      {state === "saving" && (
        <p className="diagnostics-note" role="status">
          {t.saving(saved)}
        </p>
      )}
      {state === "notSaved" && (
        <p className="diagnostics-note" role="alert">
          {t.notSaved(why)}
        </p>
      )}
      {beforeClear && (
        <p className="diagnostics-note" role="status">
          {t.beforeClear}
        </p>
      )}
      <DiagnosticsText text={text} state={state} />
      {text !== null && (
        <div className="diagnostics-actions">
          <button type="button" className="secondary-button" onClick={() => void copy()} disabled={state === "reading"}>
            <Copy size={14} aria-hidden="true" /> {t.copy}
          </button>
          <button type="button" className="secondary-button" onClick={download} disabled={state === "reading"}>
            <Download size={14} aria-hidden="true" /> {t.download}
          </button>
        </div>
      )}
      <div className="diagnostics-clear">
        <p className="diagnostics-note">{t.record(problem, errors)}</p>
        <button type="button" className="secondary-button" onClick={clear} disabled={!!problem || errors === 0 || state === "reading"}>
          <Trash2 size={14} aria-hidden="true" /> {t.clear}
        </button>
        {cleared && "cleared" in cleared && (
          <p className="diagnostics-note" role="status">
            {t.cleared(cleared.cleared)}
          </p>
        )}
        {cleared && "notCleared" in cleared && (
          <p className="diagnostics-note" role="alert">
            {t.notCleared(cleared.notCleared)}
          </p>
        )}
      </div>
    </section>
  );
}
