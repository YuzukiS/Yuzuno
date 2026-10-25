import { useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import type { SettingsEditor } from "./settings-catalog";
import type { ReleaseSummary } from "./updates";
import "./about-section.css";

/** The project's public pages, as the README and Contributing guide link them. */
export const PROJECT = "https://github.com/YuzukiS/Yuzuno";
export const projectLinks = {
  releases: `${PROJECT}/releases`,
  issues: `${PROJECT}/issues/new/choose`,
  security: `${PROJECT}/security/advisories/new`,
} as const;

/** The read me for the source this Core was built from; a development
 * checkout reports no commit, so it gets the newest source instead. */
export function readMeLink(current: ReleaseSummary | null) {
  const commit = current && /^[0-9a-f]{40}$/i.test(current.gitSha) ? current.gitSha : null;
  return commit
    ? { href: `${PROJECT}/blob/${commit}/README.md`, label: "Read me for this version" }
    : { href: `${PROJECT}#readme`, label: "Read me (newest source)" };
}

/** Texts the Web UI build serves next to itself (web/vite.config.ts). */
const LICENSES = [
  { path: "/licenses/LICENSE", title: "Yuzuno · Apache License 2.0" },
  { path: "/licenses/LICENSE-NotoSansSC.txt", title: "Noto Sans SC font · SIL Open Font License 1.1" },
  { path: "/licenses/THIRD_PARTY_NOTICES.txt", title: "Third-party notices for this page" },
] as const;

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="about-link" href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}

/** One license text, read from this page's own build when first opened. */
function LicenseText({ path, title }: { path: string; title: string }) {
  const [text, setText] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  async function read() {
    if (text !== null || reading) return;
    setReading(true);
    setError("");
    try {
      const response = await fetch(path);
      // A file the build lacks is answered with the app's own page, not a 404.
      if (!response.ok || (response.headers.get("content-type") || "").includes("text/html")) {
        setError("This page’s build doesn’t include this file. A development server doesn’t serve the license files.");
        return;
      }
      setText(await response.text());
    } catch (e) {
      // Not kept: opening it again reads again.
      setError(`Couldn’t read it from the Workspace service: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReading(false);
    }
  }
  return (
    <details
      className="updates-notes about-license"
      onToggle={(event) => {
        if (event.currentTarget.open) void read();
      }}
    >
      <summary>
        <ChevronRight size={12} aria-hidden="true" />
        {title}
      </summary>
      {reading && <p className="settings-row-meta">Reading…</p>}
      {error && (
        <p className="updates-error" role="alert">
          {error}
        </p>
      )}
      {text !== null && <pre className="updates-release-notes about-license-text">{text}</pre>}
    </details>
  );
}

/**
 * About & help (T-191): the version the Workspace service runs, the notes
 * of that release, where help and feedback go, and the license texts this
 * page was built with. Read-only: nothing here checks, sends or changes
 * anything; links open GitHub outside Yuzuno.
 */
export function AboutSection({
  current,
  openEditor,
}: {
  /** As /api/updates reports the running release; null until it has. */
  current: ReleaseSummary | null;
  openEditor?: (editor: SettingsEditor) => void;
}) {
  const development = current?.releaseId === "development";
  const commit = current && /^[0-9a-f]{40}$/i.test(current.gitSha) ? current.gitSha : null;
  const notes = development ? "" : (current?.notes ?? "").trim();
  const readMe = readMeLink(current);
  return (
    <section id="settings-about" className="settings-section about-section" aria-labelledby="settings-about-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-about-title">About & help</h3>
          <p>
            Yuzuno, a home for your coding agents: help, the notes of the version you run, where to report a problem,
            and the licenses.
          </p>
        </div>
        {current && (
          <span className="settings-current" title="The Workspace service runs this version">
            {current.version}
          </span>
        )}
      </header>
      <div className="settings-group">
        <div className="settings-row" role="group" aria-label="This version">
          <span className="settings-row-main">
            <span className="settings-row-title">This version</span>
            {current ? (
              <>
                <span className="settings-row-meta about-version">
                  <span>Workspace service {current.version}</span>
                  <code>{current.releaseId}</code>
                  {commit && <code title={commit}>{commit.slice(0, 8)}</code>}
                </span>
                <span className="settings-row-help">
                  {development
                    ? "A development checkout. When you report a problem, add the commit you built (git rev-parse HEAD)."
                    : "Include these when you report a problem."}{" "}
                  The desktop app, this page and each machine’s CLIs are in Runtime & versions.
                </span>
              </>
            ) : (
              <span className="settings-row-help">The Workspace service hasn’t said which version it runs yet.</span>
            )}
          </span>
          {openEditor && (
            <span className="settings-row-action">
              <button type="button" className="secondary-button" onClick={() => openEditor("runtime")}>
                Runtime & versions
              </button>
            </span>
          )}
        </div>
        <div className="settings-row" role="group" aria-label="Release notes">
          <span className="settings-row-main">
            <span className="settings-row-title">Release notes</span>
            {notes ? (
              <details className="updates-notes">
                <summary>
                  <ChevronRight size={12} aria-hidden="true" />
                  What’s in {current!.version}
                </summary>
                <p className="updates-release-notes">{notes}</p>
              </details>
            ) : (
              <span className="settings-row-help">
                {development
                  ? "A development checkout has no release notes."
                  : current
                    ? "The release this service runs has no notes."
                    : "Shown once the Workspace service says which release it runs."}
              </span>
            )}
            <span className="settings-row-help">
              {notes ? "From the signed release the Workspace service runs. " : ""}
              <External href={projectLinks.releases}>Every published release</External>
            </span>
          </span>
        </div>
        <div className="settings-row" role="group" aria-label="Help">
          <span className="settings-row-main">
            <span className="settings-row-title">Help</span>
            <span className="settings-row-help">
              <External href={readMe.href}>{readMe.label}</External> explains what Yuzuno does, how to run it and how
              its data and updates work.
            </span>
          </span>
          {openEditor && (
            <span className="settings-row-action">
              <button type="button" className="secondary-button" onClick={() => openEditor("shortcuts")}>
                Keyboard shortcuts
              </button>
            </span>
          )}
        </div>
        <div className="settings-row" role="group" aria-label="Feedback">
          <span className="settings-row-main">
            <span className="settings-row-title">Feedback</span>
            <span className="settings-row-help about-links">
              <External href={projectLinks.issues}>Report a problem or request a feature</External>
              <External href={projectLinks.security}>Report a security problem privately</External>
            </span>
            <span className="settings-row-help">
              Both open GitHub; Yuzuno sends nothing itself. Leave out tokens, API keys, CLI login files, SSH keys,
              private conversations and your Workspace data folder, and describe a vulnerability only in the private
              report.
            </span>
          </span>
        </div>
        <div className="settings-row" role="group" aria-label="Licenses">
          <span className="settings-row-main">
            <span className="settings-row-title">Licenses</span>
            <span className="settings-row-help">
              The texts served with this page. Core’s own notices are in the licenses folder of its release on the Core
              host.
            </span>
            {LICENSES.map((license) => (
              <LicenseText key={license.path} {...license} />
            ))}
          </span>
        </div>
      </div>
    </section>
  );
}
