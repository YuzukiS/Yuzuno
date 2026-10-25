import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { checkModels, readRuntime, runtimeView, type Fact, type MachineFacts, type ModelChecks, type RuntimeRead } from "./runtime-status";
import { ClaudeMcpStatus } from "./ClaudeMcpStatus";
import { CodexMcpStatus } from "./CodexMcpStatus";
import { strings, useLanguage, useStrings } from "./i18n";
import type { Agent } from "./types";
import "./runtime-section.css";

// The section's own words (T-189). Names, versions, releases, paths,
// accounts and what Core or a CLI said come as they are. Each Agent's MCP
// report is the shared MCP panels', given this section's language.
const text = strings({
  states: { yes: "Yes", no: "No", unknown: "Unknown" } as Record<"yes" | "no" | "unknown", string>,
  coreHost: "Core host",
  sshMachine: "SSH machine",
  lastChecked: (age: string) => `Last checked ${age} (`,
  close: ")",
  olderThanHour: " · older than an hour",
  neverChecked: "Never checked",
  reached: "Reached",
  codexConnection: "Codex connection",
  managedJobs: "Managed Jobs",
  windowsJobs: "Windows Jobs",
  cli: "CLI",
  signedIn: "Signed in",
  models: "Models",
  harnessOn: (harness: string, machine: string) => `${harness} on ${machine}`,
  checkingModels: "Checking models…",
  checkModels: "Check models",
  checkModelsNote:
    "Lists the models of this host's Codex and Claude Code, as the New Agent dialog does when it opens. If Codex can't list them, Core marks it not connected, as the dialog would.",
  mcp: "MCP services",
  mcpNote:
    "As each Agent's harness reported them. Claude Code: its session's last report; Refresh asks that session once. Codex: the startup reports its connection received; reading asks Codex nothing. Showing an Agent asks nothing. Configuration and sign-in stay in each CLI.",
  agent: "Agent",
  noMcpAgents: "No open Claude Code or Codex Agents to report MCP services.",
  openCode: (n: number) => `${n === 1 ? "1 OpenCode Agent" : `${n} OpenCode Agents`}: OpenCode doesn't report MCP status to Yuzuno in this version.`,
  title: "Runtime & versions",
  intro: "What this Workspace runs on, as Core and this device last knew it. Nothing here signs in, reconnects or updates anything.",
  read: "Read ",
  eachSource: " · each source answered on its own",
  reading: "Reading…",
  readAgain: "Read again",
  service: "Workspace service",
  version: "Version",
  release: "Release",
  state: "State",
  sdk: "Claude Agent SDK",
  sdkCopy: "SDK copy",
  serviceNote:
    "Updated from Versions & updates; installing is never started here. The Claude Agent SDK is what Core's Claude bridge runs and comes with Core's Claude runtime; Claude Code's CLI is another program, listed under Machines. Reading it prepares and downloads nothing.",
  device: "This device",
  page: "This page",
  desktop: "Desktop app",
  iphone: "iPhone app",
  machines: "Machines",
  machinesNote:
    "Reached and each CLI are from the machine's last check, not live. On the Core host, Codex's connection and sign-in are as Core holds them now, and Managed Jobs as Core reads its budget. A machine's CLIs and their sign-in belong to that machine and are updated with its own tools.",
  gap: " ",
  checksElsewhere: " Checks run from the Machines page.",
  checkMachines: "Check machines",
  machinesUnread: (error: string) => `The machines could not be read: ${error}`,
  compatibility: "Compatibility",
  notDefined: "Not defined",
  compatibilityHelp: "Which versions work together isn't defined for this release, so it isn't guessed from version numbers.",
}, {
  states: { yes: "是", no: "否", unknown: "未知" },
  coreHost: "Core 主机",
  sshMachine: "SSH 机器",
  lastChecked: (age) => `上次检查：${age}（`,
  close: "）",
  olderThanHour: " · 超过一小时",
  neverChecked: "从未检查",
  reached: "连通",
  codexConnection: "Codex 连接",
  managedJobs: "托管 Job",
  windowsJobs: "Windows Job",
  cli: "CLI",
  signedIn: "登录",
  models: "模型",
  harnessOn: (harness, machine) => `${machine} 上的 ${harness}`,
  checkingModels: "正在检查模型…",
  checkModels: "检查模型",
  checkModelsNote:
    "像“新建 Agent”对话框打开时那样，列出此主机上 Codex 和 Claude Code 的模型。如果 Codex 无法列出，Core 会像对话框那样把它标为未连接。",
  mcp: "MCP 服务",
  mcpNote:
    "按各 Agent 的 harness 报告的显示。Claude Code：它会话的最近一次报告；“Refresh”会询问该会话一次。Codex：它连接启动时收到的报告；读取不会询问 Codex。显示某个 Agent 不会询问任何内容。配置和登录仍在各自的 CLI 中。",
  agent: "Agent",
  noMcpAgents: "没有打开的 Claude Code 或 Codex Agent 可报告 MCP 服务。",
  openCode: (n) => `${n} 个 OpenCode Agent：此版本中 OpenCode 不向 Yuzuno 报告 MCP 状态。`,
  title: "运行环境与版本",
  intro: "此 Workspace 运行在什么上，按 Core 和此设备最近所知。这里不会登录、重连或更新任何内容。",
  read: "读取于 ",
  eachSource: " · 每个来源分别回答",
  reading: "正在读取…",
  readAgain: "重新读取",
  service: "Workspace 服务",
  version: "版本",
  release: "发布",
  state: "状态",
  sdk: "Claude Agent SDK",
  sdkCopy: "SDK 副本",
  serviceNote:
    "通过“版本与更新”更新；这里从不开始安装。Claude Agent SDK 是 Core 的 Claude bridge 所运行的，随 Core 的 Claude 运行环境提供；Claude Code 的 CLI 是另一个程序，列在“机器”下。读取它不会准备或下载任何内容。",
  device: "此设备",
  page: "此页面",
  desktop: "桌面应用",
  iphone: "iPhone 应用",
  machines: "机器",
  machinesNote:
    "“连通”和各 CLI 来自机器的上次检查，并非实时。在 Core 主机上，Codex 的连接和登录按 Core 现在持有的显示，托管 Job 按 Core 读取的预算显示。机器的 CLI 及其登录属于那台机器，用它自己的工具更新。",
  gap: "",
  checksElsewhere: "检查在“机器”页面进行。",
  checkMachines: "检查机器",
  machinesUnread: (error) => `无法读取机器：${error}`,
  compatibility: "兼容性",
  notDefined: "未定义",
  compatibilityHelp: "此发布没有定义哪些版本可以一起使用，因此不会根据版本号猜测。",
});
const timeText = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
};

/** One fact: its name, Yes / No / Unknown in words, what it says and where
 * it came from. */
function FactRow({ label, fact }: { label: string; fact: Fact }) {
  const t = useStrings(text);
  return (
    <div className="runtime-fact" data-state={fact.state}>
      <dt>{label}</dt>
      <dd>
        <span className="runtime-state">{t.states[fact.state]}</span>
        <span className="runtime-text">{fact.text}</span>
        {fact.detail && <span className="runtime-detail">{fact.detail}</span>}
      </dd>
    </div>
  );
}

function MachineCard({ machine, onCheckModels, checkingModels = false }: {
  machine: MachineFacts;
  /** The Core host's explicit model check; other machines have none here. */
  onCheckModels?: () => void;
  checkingModels?: boolean;
}) {
  const t = useStrings(text);
  return (
    <article className="runtime-machine" aria-labelledby={`runtime-machine-${machine.id}`}>
      <header>
        <h5 id={`runtime-machine-${machine.id}`}>{machine.name}</h5>
        <span className="runtime-where">{machine.kind === "local" ? t.coreHost : machine.target ?? t.sshMachine}</span>
        <p className="runtime-checked" data-stale={machine.stale || undefined}>
          {machine.checkedAt ? (
            <>
              {t.lastChecked(machine.age ?? "")}
              <time dateTime={machine.checkedAt}>{timeText(machine.checkedAt)}</time>
              {t.close}
              {machine.stale && t.olderThanHour}
            </>
          ) : (
            t.neverChecked
          )}
        </p>
      </header>
      <dl>
        <FactRow label={t.reached} fact={machine.reachable} />
        {machine.codexConnection && <FactRow label={t.codexConnection} fact={machine.codexConnection} />}
        <FactRow label={t.managedJobs} fact={machine.jobs} />
        {machine.windowsJobs && <FactRow label={t.windowsJobs} fact={machine.windowsJobs} />}
      </dl>
      {machine.harnesses.map((harness) => (
        <section key={harness.harness} className="runtime-harness" aria-label={t.harnessOn(harness.name, machine.name)}>
          <h6>{harness.name}</h6>
          <dl>
            <FactRow label={t.cli} fact={harness.cli} />
            <FactRow label={t.signedIn} fact={harness.signedIn} />
            <FactRow label={t.models} fact={harness.models} />
          </dl>
        </section>
      ))}
      {onCheckModels && machine.kind === "local" && (
        <p className="runtime-note runtime-models-check">
          <button type="button" className="quiet-button" disabled={checkingModels} onClick={onCheckModels}>
            {checkingModels ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            {checkingModels ? t.checkingModels : t.checkModels}
          </button>
          {t.checkModelsNote}
        </p>
      )}
    </article>
  );
}

/** MCP services as each Agent's harness reported them (T-191), one Agent at
 * a time. Claude Code: opening shows its session's last report and asks
 * nothing; only Refresh asks that session. Codex: the startup reports its
 * connection received; reading asks Codex nothing. A harness without a
 * report is named, not guessed. */
function McpServices({ agents }: { agents: Agent[] }) {
  const language = useLanguage();
  const t = text(language);
  const open = agents.filter((agent) => !agent.closedAt);
  const listed = open.filter((agent) => agent.harness === "claude" || (agent.harness ?? "codex") === "codex");
  const others = open.length - listed.length;
  const [chosen, setChosen] = useState("");
  const agent = listed.find((item) => item.id === chosen) ?? listed[0];
  const where = (item: Agent) => (item.remote ? item.remote.machine.name : t.coreHost);
  const label = (item: Agent) => `${item.name} · ${item.harness === "claude" ? "Claude Code" : "Codex"} · ${where(item)}`;
  return (
    <section className="runtime-group runtime-mcp" aria-labelledby="runtime-mcp">
      <h4 id="runtime-mcp">{t.mcp}</h4>
      <p className="runtime-note">{t.mcpNote}</p>
      {agent ? (
        <>
          <label className="runtime-mcp-agent">
            <span>{t.agent}</span>
            <select className="settings-select" value={agent.id} onChange={(event) => setChosen(event.target.value)}>
              {listed.map((item) => (
                <option key={item.id} value={item.id}>
                  {label(item)}
                </option>
              ))}
            </select>
          </label>
          {agent.harness === "claude" ? (
            <ClaudeMcpStatus agent={agent} cachedOnOpen heading={label(agent)} headingLevel={5} language={language} />
          ) : (
            <CodexMcpStatus agent={agent} heading={label(agent)} headingLevel={5} anchor={false} language={language} />
          )}
        </>
      ) : (
        <p className="runtime-note">{t.noMcpAgents}</p>
      )}
      {others > 0 && (
        <p className="runtime-note">{t.openCode(others)}</p>
      )}
    </section>
  );
}

/**
 * Runtime & versions (T-191): what this Workspace runs on, as Core and this
 * client hold it, each fact with where and when it was observed. Read-only:
 * opening it, or Read again, signs nothing in, reconnects nothing, updates
 * nothing and runs no machine check. Checks are the Machines page's; the
 * Core host's Check models makes only the New Agent dialog's catalog reads.
 */
export function RuntimeSection({
  active = true,
  onOpenMachines,
}: {
  /** Read while shown; nothing is read while closed. */
  active?: boolean;
  /** Where machine checks are run; without it the section says where. */
  onOpenMachines?: () => void;
}) {
  const language = useLanguage();
  const t = text(language);
  const [read, setRead] = useState<RuntimeRead | null>(null);
  const [reading, setReading] = useState(false);
  const [again, setAgain] = useState(0);
  const [models, setModels] = useState<ModelChecks>({});
  const [checkingModels, setCheckingModels] = useState(false);
  /** Only on the button: the dialog's own catalog reads. Afterwards the
   * section reads again, since a Codex failure changes its connection. */
  async function onCheckModels() {
    if (checkingModels) return;
    setCheckingModels(true);
    try {
      setModels(await checkModels());
      setAgain((n) => n + 1);
    } finally {
      setCheckingModels(false);
    }
  }
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setReading(true);
    void readRuntime(controller.signal)
      .then((next) => !controller.signal.aborted && setRead(next))
      .finally(() => !controller.signal.aborted && setReading(false));
    return () => controller.abort();
  }, [active, again]);
  const view = read ? runtimeView(read, undefined, models, language) : null;
  return (
    <section id="settings-runtime" className="settings-section runtime-section" aria-labelledby="settings-runtime-title" aria-busy={reading}>
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-runtime-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
        <div className="runtime-read">
          <span role="status">
            {view ? (
              <>
                {t.read}
                <time dateTime={view.at}>{timeText(view.at)}</time>
                <span className="runtime-read-note">{t.eachSource}</span>
              </>
            ) : reading ? (
              t.reading
            ) : (
              ""
            )}
          </span>
          <button type="button" className="quiet-button" disabled={reading} onClick={() => setAgain((n) => n + 1)}>
            {reading ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            {t.readAgain}
          </button>
        </div>
      </header>
      {view && (
        <>
          <section className="runtime-group" aria-labelledby="runtime-core">
            <h4 id="runtime-core">{t.service}</h4>
            <dl>
              <FactRow label={t.version} fact={view.core.version} />
              <FactRow label={t.release} fact={view.core.release} />
              <FactRow label={t.state} fact={view.core.ready} />
              <FactRow label={t.sdk} fact={view.core.sdk} />
              <FactRow label={t.sdkCopy} fact={view.core.sdkCopy} />
            </dl>
            <p className="runtime-note">{t.serviceNote}</p>
          </section>
          <section className="runtime-group" aria-labelledby="runtime-client">
            <h4 id="runtime-client">{t.device}</h4>
            <dl>
              <FactRow label={t.page} fact={view.client.page} />
              <FactRow label={t.desktop} fact={view.client.desktop} />
              <FactRow label={t.iphone} fact={view.client.iphone} />
            </dl>
          </section>
          <section className="runtime-group" aria-labelledby="runtime-machines">
            <h4 id="runtime-machines">{t.machines}</h4>
            <p className="runtime-note">
              {t.machinesNote}
              {onOpenMachines ? t.gap : t.checksElsewhere}
              {onOpenMachines && (
                <button type="button" className="quiet-button runtime-machines-link" onClick={onOpenMachines}>
                  {t.checkMachines}
                </button>
              )}
            </p>
            {view.machinesError && (
              <p className="runtime-note" role="alert">
                {t.machinesUnread(view.machinesError)}
              </p>
            )}
            {view.machines.map((machine) => (
              <MachineCard key={machine.id} machine={machine} onCheckModels={onCheckModels} checkingModels={checkingModels} />
            ))}
          </section>
          {read?.agents && <McpServices agents={read.agents} />}
          <dl className="runtime-group">
            <FactRow label={t.compatibility} fact={{ state: "unknown", text: t.notDefined, detail: t.compatibilityHelp }} />
          </dl>
        </>
      )}
    </section>
  );
}
