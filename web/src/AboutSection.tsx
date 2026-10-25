import { useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import { strings, useLanguage, type Language } from "./i18n";
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

// The page's own words (T-189). Versions, release IDs, commits, links, the
// release notes and the license texts are shown as they are.
const text = strings({
  readMe: "Read me for this version",
  readMeNewest: "Read me (newest source)",
  licenses: {
    "/licenses/LICENSE": "Yuzuno · Apache License 2.0",
    "/licenses/LICENSE-NotoSansSC.txt": "Noto Sans SC font · SIL Open Font License 1.1",
    "/licenses/THIRD_PARTY_NOTICES.txt": "Third-party notices for this page",
  } as Record<string, string>,
  reading: "Reading…",
  notInBuild: "This page’s build doesn’t include this file. A development server doesn’t serve the license files.",
  couldNotRead: (error: string) => `Couldn’t read it from the Workspace service: ${error}`,
  title: "About & help",
  intro: "Yuzuno, a home for your coding agents: help, the notes of the version you run, where to report a problem, and the licenses.",
  runs: "The Workspace service runs this version",
  version: "This version",
  service: (version: string) => `Workspace service ${version}`,
  versionHelp: (development: boolean) =>
    `${development ? "A development checkout. When you report a problem, add the commit you built (git rev-parse HEAD)." : "Include these when you report a problem."} The desktop app, this page and each machine’s CLIs are in Runtime & versions.`,
  noVersion: "The Workspace service hasn’t said which version it runs yet.",
  runtime: "Runtime & versions",
  notes: "Release notes",
  notesOf: (version: string) => `What’s in ${version}`,
  noDevelopmentNotes: "A development checkout has no release notes.",
  noNotes: "The release this service runs has no notes.",
  notesLater: "Shown once the Workspace service says which release it runs.",
  notesFrom: "From the signed release the Workspace service runs. ",
  releases: "Every published release",
  help: "Help",
  readMeHelp: " explains what Yuzuno does, how to run it and how its data and updates work.",
  shortcuts: "Keyboard shortcuts",
  feedback: "Feedback",
  issue: "Report a problem or request a feature",
  security: "Report a security problem privately",
  feedbackHelp:
    "Both open GitHub; Yuzuno sends nothing itself. Leave out tokens, API keys, CLI login files, SSH keys, private conversations and your Workspace data folder, and describe a vulnerability only in the private report.",
  licensesTitle: "Licenses",
  licensesHelp: "The texts served with this page. Core’s own notices are in the licenses folder of its release on the Core host.",
}, {
  readMe: "此版本的 README",
  readMeNewest: "README（最新源码）",
  licenses: {
    "/licenses/LICENSE": "Yuzuno · Apache License 2.0",
    "/licenses/LICENSE-NotoSansSC.txt": "Noto Sans SC 字体 · SIL Open Font License 1.1",
    "/licenses/THIRD_PARTY_NOTICES.txt": "此页面的第三方声明",
  },
  reading: "正在读取…",
  notInBuild: "此页面的构建不包含这个文件。开发服务器不提供许可证文件。",
  couldNotRead: (error) => `无法从 Workspace 服务读取：${error}`,
  title: "关于与帮助",
  intro: "Yuzuno，编程 Agent 的家：帮助、你所运行版本的说明、在哪里报告问题，以及许可证。",
  runs: "Workspace 服务运行的是此版本",
  version: "此版本",
  service: (version) => `Workspace 服务 ${version}`,
  versionHelp: (development) =>
    `${development ? "这是开发检出。报告问题时，请附上你构建时的提交（git rev-parse HEAD）。" : "报告问题时请附上这些信息。"}桌面应用、此页面和每台机器的 CLI 版本见“运行环境与版本”。`,
  noVersion: "Workspace 服务尚未说明它运行的版本。",
  runtime: "运行环境与版本",
  notes: "发布说明",
  notesOf: (version) => `${version} 的更新内容`,
  noDevelopmentNotes: "开发检出没有发布说明。",
  noNotes: "此服务运行的发布没有说明。",
  notesLater: "Workspace 服务说明它运行哪个发布后显示。",
  notesFrom: "来自 Workspace 服务运行的已签名发布。",
  releases: "所有已发布的版本",
  help: "帮助",
  readMeHelp: "：介绍 Yuzuno 做什么、如何运行，以及它的数据和更新如何运作。",
  shortcuts: "键盘快捷键",
  feedback: "反馈",
  issue: "报告问题或请求功能",
  security: "私下报告安全问题",
  feedbackHelp:
    "两者都会打开 GitHub；Yuzuno 自己不会发送任何内容。请不要附上令牌、API 密钥、CLI 登录文件、SSH 密钥、私密对话和你的 Workspace 数据文件夹，漏洞只在私下报告中描述。",
  licensesTitle: "许可证",
  licensesHelp: "随此页面提供的文本。Core 自己的声明在 Core 主机上其发布的 licenses 文件夹中。",
});

/** The read me for the source this Core was built from; a development
 * checkout reports no commit, so it gets the newest source instead. */
export function readMeLink(current: ReleaseSummary | null, language: Language = "en") {
  const commit = current && /^[0-9a-f]{40}$/i.test(current.gitSha) ? current.gitSha : null;
  const t = text(language);
  return commit
    ? { href: `${PROJECT}/blob/${commit}/README.md`, label: t.readMe }
    : { href: `${PROJECT}#readme`, label: t.readMeNewest };
}

/** Texts the Web UI build serves next to itself (web/vite.config.ts). */
const LICENSES = ["/licenses/LICENSE", "/licenses/LICENSE-NotoSansSC.txt", "/licenses/THIRD_PARTY_NOTICES.txt"] as const;

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="about-link" href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}

/** Why a license text isn't shown: not in this build, or not read (the
 * browser's own words). */
type ReadError = { kind: "notInBuild" } | { kind: "read"; error: string };

/** One license text, read from this page's own build when first opened. */
function LicenseText({ path }: { path: string }) {
  const t = text(useLanguage());
  const [license, setLicense] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<ReadError | null>(null);
  async function read() {
    if (license !== null || reading) return;
    setReading(true);
    setError(null);
    try {
      const response = await fetch(path);
      // A file the build lacks is answered with the app's own page, not a 404.
      if (!response.ok || (response.headers.get("content-type") || "").includes("text/html")) {
        setError({ kind: "notInBuild" });
        return;
      }
      setLicense(await response.text());
    } catch (e) {
      // Not kept: opening it again reads again.
      setError({ kind: "read", error: e instanceof Error ? e.message : String(e) });
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
        {t.licenses[path]}
      </summary>
      {reading && <p className="settings-row-meta">{t.reading}</p>}
      {error && (
        <p className="updates-error" role="alert">
          {error.kind === "notInBuild" ? t.notInBuild : t.couldNotRead(error.error)}
        </p>
      )}
      {license !== null && <pre className="updates-release-notes about-license-text">{license}</pre>}
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
  const language = useLanguage();
  const t = text(language);
  const readMe = readMeLink(current, language);
  return (
    <section id="settings-about" className="settings-section about-section" aria-labelledby="settings-about-title">
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-about-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
        {current && (
          <span className="settings-current" title={t.runs}>
            {current.version}
          </span>
        )}
      </header>
      <div className="settings-group">
        <div className="settings-row" role="group" aria-label={t.version}>
          <span className="settings-row-main">
            <span className="settings-row-title">{t.version}</span>
            {current ? (
              <>
                <span className="settings-row-meta about-version">
                  <span>{t.service(current.version)}</span>
                  <code>{current.releaseId}</code>
                  {commit && <code title={commit}>{commit.slice(0, 8)}</code>}
                </span>
                <span className="settings-row-help">{t.versionHelp(development)}</span>
              </>
            ) : (
              <span className="settings-row-help">{t.noVersion}</span>
            )}
          </span>
          {openEditor && (
            <span className="settings-row-action">
              <button type="button" className="secondary-button" onClick={() => openEditor("runtime")}>
                {t.runtime}
              </button>
            </span>
          )}
        </div>
        <div className="settings-row" role="group" aria-label={t.notes}>
          <span className="settings-row-main">
            <span className="settings-row-title">{t.notes}</span>
            {notes ? (
              <details className="updates-notes">
                <summary>
                  <ChevronRight size={12} aria-hidden="true" />
                  {t.notesOf(current!.version)}
                </summary>
                <p className="updates-release-notes">{notes}</p>
              </details>
            ) : (
              <span className="settings-row-help">
                {development ? t.noDevelopmentNotes : current ? t.noNotes : t.notesLater}
              </span>
            )}
            <span className="settings-row-help">
              {notes ? t.notesFrom : ""}
              <External href={projectLinks.releases}>{t.releases}</External>
            </span>
          </span>
        </div>
        <div className="settings-row" role="group" aria-label={t.help}>
          <span className="settings-row-main">
            <span className="settings-row-title">{t.help}</span>
            <span className="settings-row-help">
              <External href={readMe.href}>{readMe.label}</External>
              {t.readMeHelp}
            </span>
          </span>
          {openEditor && (
            <span className="settings-row-action">
              <button type="button" className="secondary-button" onClick={() => openEditor("shortcuts")}>
                {t.shortcuts}
              </button>
            </span>
          )}
        </div>
        <div className="settings-row" role="group" aria-label={t.feedback}>
          <span className="settings-row-main">
            <span className="settings-row-title">{t.feedback}</span>
            <span className="settings-row-help about-links">
              <External href={projectLinks.issues}>{t.issue}</External>
              <External href={projectLinks.security}>{t.security}</External>
            </span>
            <span className="settings-row-help">{t.feedbackHelp}</span>
          </span>
        </div>
        <div className="settings-row" role="group" aria-label={t.licensesTitle}>
          <span className="settings-row-main">
            <span className="settings-row-title">{t.licensesTitle}</span>
            <span className="settings-row-help">{t.licensesHelp}</span>
            {LICENSES.map((path) => (
              <LicenseText key={path} path={path} />
            ))}
          </span>
        </div>
      </div>
    </section>
  );
}
