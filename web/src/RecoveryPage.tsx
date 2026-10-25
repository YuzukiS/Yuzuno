import { Component, Fragment, useState, type ReactNode } from "react";
import { Copy, Download, Eye, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { clearRecordedErrors, diagnosticsText, errorRecordProblem, gatherFacts, recordError, recordedErrors } from "./diagnostics";
import "./diagnostics.css";

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
  return (
    <>
      {state === "copied" && (
        <p className="diagnostics-note" role="status">
          Copied. Nothing was sent anywhere; paste it where you report the problem.
        </p>
      )}
      {state === "select" && (
        <p className="diagnostics-note" role="status">
          This window can't use the clipboard. Select the text below and copy it.
        </p>
      )}
      {text !== null && (
        <textarea
          className="diagnostics-text"
          aria-label="Diagnostics"
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
    <main className="app-recovery" aria-labelledby="app-recovery-title">
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
  const { text, state, saved, why, cleared, beforeClear, preview, copy, download, clear } = useDiagnosticsPreview();
  const errors = recordedErrors().length;
  const problem = errorRecordProblem();
  return (
    <section id="settings-diagnostics" className="settings-section diagnostics-section" aria-label="Diagnostics">
      <header className="settings-section-heading">
        <div>
          <h3>Diagnostics</h3>
          <p>
            Versions, connection and the errors this window recorded ({errors === 0 ? "none" : errors}), to paste
            into a report. No conversations, drafts or credentials. Preview it first: nothing is copied, saved or
            sent until you choose.
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void preview()} disabled={state === "reading"}>
          <Eye size={14} aria-hidden="true" /> {text === null ? "Preview diagnostics" : "Preview again"}
        </button>
      </header>
      {state === "reading" && (
        <p className="diagnostics-note" role="status">
          Gathering…
        </p>
      )}
      {state === "shown" && (
        <p className="diagnostics-note" role="status">
          This is the whole text. Nothing has been copied, saved or sent.
        </p>
      )}
      {state === "saving" && (
        <p className="diagnostics-note" role="status">
          Your browser was asked to save {saved}. If no file appears, select the text below and copy it.
        </p>
      )}
      {state === "notSaved" && (
        <p className="diagnostics-note" role="alert">
          The download could not start ({why}). Select the text below and copy it.
        </p>
      )}
      {beforeClear && (
        <p className="diagnostics-note" role="status">
          This text was gathered before the recorded errors were cleared. Preview again for the record as it is now.
        </p>
      )}
      <DiagnosticsText text={text} state={state} />
      {text !== null && (
        <div className="diagnostics-actions">
          <button type="button" className="secondary-button" onClick={() => void copy()} disabled={state === "reading"}>
            <Copy size={14} aria-hidden="true" /> Copy
          </button>
          <button type="button" className="secondary-button" onClick={download} disabled={state === "reading"}>
            <Download size={14} aria-hidden="true" /> Download .txt
          </button>
        </div>
      )}
      <div className="diagnostics-clear">
        <p className="diagnostics-note">
          {problem
            ? `The recorded errors can't be cleared here: ${problem}.`
            : errors === 0
              ? "No errors are recorded in this browser for this site."
              : `${errors} recorded ${errors === 1 ? "error is" : "errors are"} kept in this browser for this site.`}{" "}
          Clearing removes only these error records and can't be undone. Core's and the desktop app's last-read
          versions stay, and so do drafts, settings, conversations and Core's logs. Errors after that are recorded as
          before.
        </p>
        <button type="button" className="secondary-button" onClick={clear} disabled={!!problem || errors === 0 || state === "reading"}>
          <Trash2 size={14} aria-hidden="true" /> Clear recorded errors
        </button>
        {cleared && "cleared" in cleared && (
          <p className="diagnostics-note" role="status">
            Cleared {cleared.cleared} recorded {cleared.cleared === 1 ? "error" : "errors"} from this browser for this site.
          </p>
        )}
        {cleared && "notCleared" in cleared && (
          <p className="diagnostics-note" role="alert">
            Nothing was cleared: {cleared.notCleared}. The recorded errors are kept as they were.
          </p>
        )}
      </div>
    </section>
  );
}
