import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock3,
  LoaderCircle,
  Monitor,
  Plus,
  Server,
  Trash2,
  Wifi,
} from "lucide-react";
import { api, errorText, remove } from "./api";
import { Avatar } from "./components";
import {
  checkAge,
  harnessLabel,
  harnessName,
  harnessTip,
  runMachineCheck,
  type MachineCheck,
} from "./machine-checks";
import { MachineEditor } from "./MachineEditor";
import { MachineExecutorLimit } from "./MachineExecutorLimit";
import { MachineSettings } from "./MachineSettings";
import { SaveBarScope } from "./SettingsSaveBar";
import { JobsBudgetEditor } from "./JobsSettings";
import { strings, useLanguage, type Language } from "./i18n";
import { shellText } from "./shell-text";
import { machineIdOf, projectName } from "./projects";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import type { Agent, Project } from "./types";
import "./machines.css";

/** Re-render relative times while visible; the check itself is not repeated. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

// A stored check's words, in the language a page passes (T-189): Machines
// and New agent pass the interface language. Host names, paths and the
// reasons Core or SSH gave stay as written.
const checkText = strings({
  checking: "Checking…",
  notChecked: "Not checked yet",
  testHint: "Test the connection to see what Core can reach.",
  reached: (host?: string) => `Reached${host ? ` ${host}` : ""}`,
  unreachable: "Couldn’t reach",
  checkedAt: (at: string) => `Last checked ${at}`,
  lastCheck: (age: string) => `Last check ${age}`,
  staleTip: "An old result; it does not mean the machine is offline.",
  stale: "May be out of date",
  folderError: (path: string, error: string) => `Default folder ${path}: ${error}`,
}, {
  checking: "正在检查…",
  notChecked: "尚未检查",
  testHint: "测试连接，看看 Core 能访问到什么。",
  reached: (host) => `已连通${host ? ` ${host}` : ""}`,
  unreachable: "无法连通",
  checkedAt: (at) => `上次检查于 ${at}`,
  lastCheck: (age) => `上次检查：${age}`,
  staleTip: "这是较早的结果，不代表机器已离线。",
  stale: "可能已过时",
  folderError: (path, error) => `默认文件夹 ${path}：${error}`,
});

/** The one presentation of a stored check, shared with New agent. */
export function LastCheck({
  check,
  checking = false,
  compact = false,
  now = Date.now(),
  language = "en",
}: {
  check?: MachineCheck | null;
  checking?: boolean;
  /** Shorter wording for New agent; failure reasons are never hidden. */
  compact?: boolean;
  now?: number;
  /** The language of its own words; English where a page doesn't pass one. */
  language?: Language;
}) {
  const t = checkText(language);
  if (!check)
    return (
      <div className="last-check state-unknown" role="status">
        {checking ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <CircleDashed size={14} />
        )}
        <span className="last-check-line">
          <strong>{checking ? t.checking : t.notChecked}</strong>
          {!checking && !compact && (
            <span>{t.testHint}</span>
          )}
        </span>
      </div>
    );
  const age = checkAge(check, now, language);
  const at = new Date(check.checkedAt).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <div
      className={`last-check ${check.reachable ? "state-reached" : "state-failed"}`}
      role="status"
    >
      {checking ? (
        <LoaderCircle size={14} className="spin" />
      ) : check.reachable ? (
        <CircleCheck size={14} />
      ) : (
        <CircleAlert size={14} />
      )}
      <span className="last-check-line">
        <strong>
          {check.reachable ? t.reached(check.host?.hostname) : t.unreachable}
        </strong>
        <time dateTime={check.checkedAt} title={t.checkedAt(at)}>
          {t.lastCheck(age.label)}
        </time>
        {age.stale && (
          <span
            className="last-check-stale"
            title={t.staleTip}
          >
            <Clock3 size={11} /> {t.stale}
          </span>
        )}
      </span>
      {check.harnesses.length > 0 && (
        <span className="last-check-harnesses">
          {check.harnesses.map((h) => (
            <span
              key={h.harness}
              className={`harness-chip ${h.supported ? (h.found ? "found" : "missing") : "unsupported"}`}
              title={h.error || (h.found ? harnessTip(h, language) : undefined)}
            >
              {harnessLabel(h, language)}
            </span>
          ))}
        </span>
      )}
      {/* Reasons are visible text in every layout, including New agent:
          a failed check is a stored result, not a request error. */}
      {check.error && <p className="last-check-error">{check.error}</p>}
      {check.harnesses
        .filter((h) => h.supported && !h.found && h.error)
        .map((h) => (
          <p className="last-check-error" key={`${h.harness}-error`}>
            {harnessName(h.harness)}: {h.error}
          </p>
        ))}
      {check.defaultFolder?.error && (
        <p className="last-check-error">
          {t.folderError(check.defaultFolder.path, check.defaultFolder.error)}
        </p>
      )}
    </div>
  );
}

// The page's own words (T-189); an Agent's state is said as the Agent list
// says it (shellText). Machine and Agent names, SSH destinations, paths,
// host facts and Core's errors are shown as they are.
const text = strings({
  title: "Machines",
  description: "Where your agents run. A check shows what Core could reach at that moment; nothing checks in the background.",
  // Settings › Machines (YN-8 S3): the list, then a page for each.
  backTo: "Back to Machines",
  count: (machines: number, down: number) => (down ? `${machines} · ${down} unreachable` : String(machines)),
  agentCount: (count: number) => `${count} ${count === 1 ? "Agent" : "Agents"}`,
  thisPc: "This PC",
  coreHost: "Core host",
  localIntro: "The computer that runs your Workspace Core. It can’t be removed; its Job budget is the Core host’s.",
  sshIntro: (target: string) => `Connected over SSH: ${target}.`,
  addIntro: "Yuzuno connects through OpenSSH; keys and host configuration stay in OpenSSH.",
  jobsTitle: "Jobs",
  gone: "This machine is no longer listed.",
  add: "Add SSH machine",
  loadFailed: (error: string) => `Couldn’t load machines: ${error}`,
  loading: "Loading machines…",
  ssh: (target: string) => `SSH · ${target}`,
  local: "Local · runs your Workspace Core",
  checking: "Checking…",
  test: "Test connection",
  removeName: (name: string) => `Remove ${name}`,
  remove: "Remove",
  stillWorking: (names: string, count: number) =>
    `${names} still ${count === 1 ? "works" : "work"} here. Close ${count === 1 ? "that agent" : "those agents"} first, then remove this machine.`,
  confirmRemove: (name: string) => `Remove ${name} from this workspace? Closed agents created on it keep their own settings; its last check is deleted.`,
  ok: "OK",
  cancel: "Cancel",
  removeMachine: "Remove machine",
  defaultFolder: "Default folder",
  codex: "Codex executable",
  atLastCheck: "At last check",
  agentsOn: (name: string) => `Agents on ${name}`,
  agentsHere: "Agents here now",
  openAgent: (name: string, cwd: string) => `Open ${name}\n${cwd}`,
  noProject: "No project",
  connected: "Connected",
  connecting: "Connecting",
  notConnected: "Not connected",
  noAgents: "No agents on this machine yet.",
  footnote: "Agent states come from their own sessions, not from these checks. An old check does not mean a machine is offline, and a found CLI does not mean it is signed in.",
}, {
  title: "机器",
  description: "你的 Agent 运行的地方。一次检查只说明 Core 在那一刻能访问到什么；后台不会自动检查。",
  backTo: "返回机器列表",
  count: (machines, down) => (down ? `${machines} 台 · ${down} 台连不上` : `${machines} 台`),
  agentCount: (count) => `${count} 个 Agent`,
  thisPc: "本机",
  coreHost: "Core 主机",
  localIntro: "运行你的 Workspace Core 的这台电脑。它不能移除；它的 Job 预算就是 Core 主机的预算。",
  sshIntro: (target) => `通过 SSH 连接：${target}。`,
  addIntro: "Yuzuno 通过 OpenSSH 连上去；密钥和主机配置留在 OpenSSH 里。",
  jobsTitle: "Job",
  gone: "这台机器已不在列表中。",
  add: "添加 SSH 机器",
  loadFailed: (error) => `无法加载机器：${error}`,
  loading: "正在加载机器…",
  local: "本机 · 运行你的 Workspace Core",
  checking: "正在检查…",
  test: "测试连接",
  removeName: (name) => `移除 ${name}`,
  remove: "移除",
  stillWorking: (names, count) => `${names} 仍在此机器上工作。请先关闭${count === 1 ? "该" : "这些"} Agent，再移除此机器。`,
  confirmRemove: (name) => `要从此 Workspace 移除 ${name} 吗？在它上面创建的已关闭 Agent 保留各自的设置；它的上次检查会被删除。`,
  ok: "好",
  cancel: "取消",
  removeMachine: "移除机器",
  defaultFolder: "默认文件夹",
  codex: "Codex 可执行文件",
  atLastCheck: "上次检查时",
  agentsOn: (name) => `${name} 上的 Agent`,
  agentsHere: "当前在此的 Agent",
  openAgent: (name, cwd) => `打开 ${name}\n${cwd}`,
  noProject: "无项目",
  connected: "已连接",
  connecting: "正在连接",
  notConnected: "未连接",
  noAgents: "此机器上还没有 Agent。",
  footnote: "Agent 的状态来自它们自己的会话，而非这些检查。较早的检查不代表机器已离线，找到 CLI 也不代表已登录。",
});

/** The list with this machine as Core saved it: replaced, or added once. */
const withMachine = (list: WorkspaceMachine[] | null, saved: WorkspaceMachine) =>
  (list || []).some((m) => m.id === saved.id)
    ? (list || []).map((m) => (m.id === saved.id ? saved : m))
    : [...(list || []), saved];

type MachinesView = { kind: "list" } | { kind: "machine"; id: string } | { kind: "add" };

/** Settings › Machines (YN-8 S3): the list of machines, then a page for
 * each (its check, its Agents, its editor; the Core host's with its Job
 * budget), and one to add an SSH machine. A request opens one of them
 * (`initialMachineId`: a machine's id, or "new"); otherwise the list. `open`
 * is whether Settings is open. */
export function MachinesPage({
  open,
  agents,
  projects,
  revision,
  onOpenAgent,
  initialMachineId = null,
  initialBlock,
}: {
  open: boolean;
  agents: Agent[];
  projects: Project[];
  /** Workspace change counter; another window's check refreshes this list. */
  revision: number;
  onOpenAgent: (id: string) => void;
  initialMachineId?: string | null;
  /** A block of the machine's page asked for: "jobs", the Core host's Job budget. */
  initialBlock?: string;
}) {
  const language = useLanguage();
  const t = text(language);
  const shell = shellText(language);
  const [machines, setMachines] = useState<WorkspaceMachine[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  // One change at a time: adding a machine or removing one (a machine's settings are its page's).
  const [change, setChange] = useState<
    { kind: "add" } | { kind: "remove"; id: string } | null
  >(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [view, setView] = useState<MachinesView>(() =>
    initialMachineId === "new" ? { kind: "add" } : initialMachineId ? { kind: "machine", id: initialMachineId } : { kind: "list" });
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(false);
  const load = useRef(0);
  const now = useNow(open);
  // Another view of the page starts at its top, its title focused; the first
  // keeps the focus Settings gave the page.
  useEffect(() => {
    if (!shown.current) {
      shown.current = true;
      return;
    }
    heading.current?.closest(".settings-pane")?.scrollTo?.({ top: 0 });
    heading.current?.focus();
  }, [view]);
  function go(next: MachinesView) {
    setChange(null);
    setRemoveError("");
    setView(next);
  }
  const reload = useCallback(() => {
    const generation = ++load.current;
    api<{ machines: WorkspaceMachine[] }>("/machines")
      .then((result) => {
        if (generation !== load.current) return;
        setMachines(result.machines || []);
        setLoadError("");
      })
      .catch((e) => {
        if (generation === load.current) setLoadError(errorText(e));
      });
  }, []);
  useEffect(() => {
    if (open) reload();
  }, [open, revision, reload]);
  useEffect(() => {
    if (!open) setChange(null);
  }, [open]);
  function startChange(next: typeof change) {
    setChange(next);
    setRemoveError("");
  }
  async function removeMachine(machine: WorkspaceMachine) {
    if (removing) return;
    setRemoving(true);
    setRemoveError("");
    try {
      await remove(`/machines/${encodeURIComponent(machine.id)}`);
      setMachines((list) => (list || []).filter((m) => m.id !== machine.id));
      go({ kind: "list" });
    } catch (e) {
      setRemoveError(errorText(e));
    } finally {
      setRemoving(false);
    }
  }
  async function check(machine: WorkspaceMachine) {
    if (checking[machine.id]) return;
    setChecking((c) => ({ ...c, [machine.id]: true }));
    setCheckErrors((e) => ({ ...e, [machine.id]: "" }));
    try {
      const result = await runMachineCheck(machine.id);
      setMachines((list) =>
        (list || []).map((m) =>
          m.id === machine.id ? { ...m, lastCheck: result } : m,
        ),
      );
    } catch (e) {
      setCheckErrors((errors) => ({ ...errors, [machine.id]: errorText(e) }));
    } finally {
      setChecking((c) => ({ ...c, [machine.id]: false }));
    }
  }
  /** A machine's own card: its check, its editor or removal, its facts
   * and Agents, as the Machines page had them. */
  const card = (machine: WorkspaceMachine) => {
          const here = agents.filter((a) => machineIdOf(a) === machine.id);
          const working = here.filter((a) => !a.closedAt);
          const busy = !!checking[machine.id];
          const confirming =
            change?.kind === "remove" && change.id === machine.id;
          return (
            <article
              className="machine-card"
              key={machine.id}
              data-machine-id={machine.id}
              aria-label={machine.name}
            >
              <header className="machine-card-heading">
                <span className="machine-icon">
                  {machine.kind === "ssh" ? (
                    <Server size={16} />
                  ) : (
                    <Monitor size={16} />
                  )}
                </span>
                <div>
                  <h3>{machine.name}</h3>
                  <span>
                    {machine.kind === "ssh" ? t.ssh(machine.target ?? "") : t.local}
                  </span>
                </div>
                <div className="machine-card-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void check(machine)}
                  >
                    {busy ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Wifi size={14} />
                    )}
                    {busy ? t.checking : t.test}
                  </button>
                  {/* The Core host is where Core runs: checked, not edited. */}
                  {machine.kind === "ssh" && (
                    <>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t.removeName(machine.name)}
                        title={t.remove}
                        disabled={busy}
                        aria-pressed={confirming}
                        onClick={() =>
                          startChange(
                            confirming
                              ? null
                              : { kind: "remove", id: machine.id },
                          )
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              </header>
              {confirming && (
                <div
                  className="machine-remove"
                  role="group"
                  aria-label={t.removeName(machine.name)}
                >
                  <p>
                    {working.length
                      ? t.stillWorking(working.map((a) => a.name).join(", "), working.length)
                      : t.confirmRemove(machine.name)}
                  </p>
                  {removeError && (
                    <p role="alert" className="inline-error">
                      {removeError}
                    </p>
                  )}
                  <div className="machine-remove-actions">
                    <button
                      type="button"
                      className="quiet-button"
                      disabled={removing}
                      onClick={() => setChange(null)}
                    >
                      {working.length ? t.ok : t.cancel}
                    </button>
                    {!working.length && (
                      <button
                        type="button"
                        className="danger-button"
                        disabled={removing}
                        onClick={() => void removeMachine(machine)}
                      >
                        {removing ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                        {t.removeMachine}
                      </button>
                    )}
                  </div>
                </div>
              )}
              <LastCheck check={machine.lastCheck} checking={busy} now={now} language={language} />
              {checkErrors[machine.id] && (
                <p role="alert" className="inline-error">
                  {checkErrors[machine.id]}
                </p>
              )}
              <dl className="machine-facts">
                <div>
                  <dt>{t.defaultFolder}</dt>
                  <dd title={machine.defaultCwd}>
                    {machine.defaultCwd || "—"}
                  </dd>
                </div>
                {machine.kind === "ssh" && (
                  <div>
                    <dt>{t.codex}</dt>
                    <dd>{machine.codex || "codex"}</dd>
                  </div>
                )}
                {machine.lastCheck?.host && (
                  <div>
                    <dt>{t.atLastCheck}</dt>
                    <dd>
                      {machine.lastCheck.host.platform} ·{" "}
                      {machine.lastCheck.host.home}
                    </dd>
                  </div>
                )}
              </dl>
              {/* The Core host has no editor: its own executor limit is set here (T-35 S3). */}
              {machine.kind === "local" && <MachineExecutorLimit machineId="local" language={language} />}
              <section
                className="machine-agents"
                aria-label={t.agentsOn(machine.name)}
              >
                <h4>
                  {t.agentsHere} <span>{here.length}</span>
                </h4>
                {here.length ? (
                  <ul>
                    {here.map((agent) => (
                      <li key={agent.id}>
                        {/* A small tile, several to a row; the folder is in its tip. */}
                        <button
                          type="button"
                          className="machine-agent"
                          onClick={() => onOpenAgent(agent.id)}
                          title={t.openAgent(agent.name, agent.cwd)}
                        >
                          <Avatar agent={agent} small />
                          <span className="machine-agent-name">
                            <strong>{agent.name}</strong>
                            <small>
                              {agent.projectId
                                ? projectName(agent.projectId, projects)
                                : t.noProject}
                            </small>
                          </span>
                          <span className="machine-agent-state">
                            {agent.closedAt ? shell.closed : shell.status[agent.status]}
                            {agent.remote && !agent.closedAt
                              ? ` · ${agent.connectionState === "connected" ? t.connected : agent.connectionState === "connecting" ? t.connecting : t.notConnected}`
                              : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="machine-note">{t.noAgents}</p>
                )}
              </section>
            </article>
          );
        };
  const list = machines ?? [];
  const down = list.filter((m) => m.lastCheck?.reachable === false).length;
  const shownMachine = view.kind === "machine" ? list.find((m) => m.id === view.id) : undefined;
  const check0 = checkText(language);
  const status = (m: WorkspaceMachine) =>
    !m.lastCheck ? check0.notChecked : m.lastCheck.reachable ? check0.reached() : check0.unreachable;
  // The Core host's page is there even before (or without) its row in the list.
  const isLocal = view.kind === "machine" && view.id === "local";
  const title =
    view.kind === "list" ? t.title : view.kind === "add" ? t.add : shownMachine?.name ?? (isLocal ? t.coreHost : t.title);
  const intro =
    view.kind === "list"
      ? t.description
      : view.kind === "add"
        ? t.addIntro
        : shownMachine?.kind === "ssh"
          ? t.sshIntro(shownMachine.target ?? "")
          : shownMachine || isLocal ? t.localIntro : machines ? t.gone : t.loading;
  const chip =
    view.kind === "list" ? (machines ? t.count(list.length, down) : undefined)
      : shownMachine ? (shownMachine.kind === "ssh" ? "SSH" : t.thisPc) : isLocal ? t.thisPc : undefined;
  return (
    <section className="settings-section settings-manager settings-machines" aria-labelledby="settings-machines-title">
      {view.kind !== "list" && (
        <button type="button" className="settings-crumb" aria-label={t.backTo} onClick={() => go({ kind: "list" })}>
          <ChevronLeft size={14} aria-hidden="true" />
          {t.title}
        </button>
      )}
      <header className="settings-section-heading">
        <div>
          <h3 id="settings-machines-title" ref={heading} tabIndex={-1}>{title}</h3>
          <p>{intro}</p>
        </div>
        {chip && <span className="settings-current">{chip}</span>}
      </header>
      {loadError && (
        <p role="alert" className="inline-error">
          {t.loadFailed(loadError)}
        </p>
      )}
      {!machines && !loadError && view.kind !== "add" && (
        <p className="machines-loading" role="status">
          <LoaderCircle size={15} className="spin" /> {t.loading}
        </p>
      )}
      {view.kind === "list" ? (
        machines && (
          <div className="settings-group appearance-group">
            <fieldset className="appearance-field">
              <legend>{t.title}</legend>
              <ul className="settings-list">
                {list.map((m) => {
                  const here = agents.filter((a) => machineIdOf(a) === m.id).length;
                  return (
                    <li key={m.id}>
                      <button type="button" className="settings-list-row is-open" data-machine-row={m.id} onClick={() => go({ kind: "machine", id: m.id })}>
                        {m.kind === "ssh" ? (
                          <Server size={15} className="settings-list-icon" aria-hidden="true" />
                        ) : (
                          <Monitor size={15} className="settings-list-icon" aria-hidden="true" />
                        )}
                        <span className="settings-list-main">
                          <span className="settings-list-title">{m.name}</span>
                          <span className="settings-list-sub">{m.kind === "ssh" ? t.ssh(m.target ?? "") : t.local}</span>
                        </span>
                        <span className={`settings-tag machine-state ${!m.lastCheck ? "is-unknown" : m.lastCheck.reachable ? "is-ok" : "is-bad"}`}>
                          {status(m)}
                        </span>
                        <span className="settings-list-meta">{t.agentCount(here)}</span>
                        <ChevronRight size={15} className="settings-list-chev" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
                <li>
                  <button type="button" className="settings-list-row is-open is-add" onClick={() => go({ kind: "add" })}>
                    <Plus size={15} className="settings-list-icon" aria-hidden="true" />
                    <span className="settings-list-main">
                      <span className="settings-list-title">{t.add}</span>
                    </span>
                  </button>
                </li>
              </ul>
            </fieldset>
          </div>
        )
      ) : view.kind === "add" ? (
        <div className="settings-group appearance-group">
          <div className="appearance-field machine-block">
            <MachineEditor
              id="machines-new-ssh"
              language={language}
              onCancel={() => go({ kind: "list" })}
              // Listed once Core has it, even while its executor limit is still
              // to be saved from the open form (T-35 S3c).
              onMachineSaved={(saved) => setMachines((list) => withMachine(list, saved))}
              onSaved={(saved) => {
                setMachines((list) => withMachine(list, saved));
                go({ kind: "machine", id: saved.id });
              }}
            />
          </div>
        </div>
      ) : (
        // One save bar for the page (YN-8), anew for each machine.
        <SaveBarScope key={view.id}>
          {shownMachine && (
            <>
              <div className="settings-group appearance-group">
                <div className="appearance-field machine-block">{card(shownMachine)}</div>
              </div>
              {/* An SSH machine's settings are its page's, saved with the bar; the Core host's are below. */}
              {shownMachine.kind === "ssh" && (
                <MachineSettings
                  machine={shownMachine}
                  language={language}
                  onSaved={(saved) => {
                    // What Core saved shows at once, so a failed read of the
                    // list after it doesn't show the old values (T-187). Core
                    // drops a check that described the old address.
                    setMachines((list) => (list || []).map((m) => (m.id === saved.id ? saved : m)));
                    reload();
                  }}
                />
              )}
            </>
          )}
          {/* The Core host's Job budget (T-55) is its page's; shown while the
              list is read too, since it reads itself. */}
          {view.id === "local" && (
            <>
              <h4 className="settings-group-title">{t.jobsTitle}</h4>
              {/* Settings focuses it when it was asked for (initialBlock "jobs"). */}
              <div className="settings-group appearance-group" id="settings-block-jobs" tabIndex={-1} data-asked={initialBlock === "jobs" || undefined}>
                <div className="appearance-field machine-block">
                  <JobsBudgetEditor active={open} />
                </div>
              </div>
            </>
          )}
        </SaveBarScope>
      )}
      {/* What a check is, beside the states the list and each page show. */}
      {view.kind !== "add" && machines && <p className="machine-note machines-footnote">{t.footnote}</p>}
    </section>
  );
}
