import { Component, Fragment, useState, type ReactNode } from "react";
import { Copy, RefreshCw, RotateCcw } from "lucide-react";
import { diagnosticsText, gatherFacts, recordError, recordedErrors } from "./diagnostics";
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

/** The copied text, shown so the user sees what they pass on (also used by
 * Settings → Data & storage, under its own label). */
export function DiagnosticsText({ text, state, label = "Diagnostics" }: { text: string | null; state: string; label?: string }) {
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
          aria-label={label}
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

/** The same diagnostics while the app works: in Settings, next to the versions. */
export function DiagnosticsCopy() {
  const { text, state, copy } = useDiagnosticsCopy();
  const errors = recordedErrors().length;
  return (
    <section id="settings-diagnostics" className="settings-section diagnostics-section" aria-label="Diagnostics">
      <header className="settings-section-heading">
        <div>
          <h3>Diagnostics</h3>
          <p>
            Versions, connection and the errors this window recorded ({errors === 0 ? "none" : errors}), to paste
            into a report. No conversations, drafts or credentials; nothing is sent anywhere.
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void copy()} disabled={state === "reading"}>
          <Copy size={14} aria-hidden="true" /> Copy diagnostics
        </button>
      </header>
      <DiagnosticsText text={text} state={state} />
    </section>
  );
}
