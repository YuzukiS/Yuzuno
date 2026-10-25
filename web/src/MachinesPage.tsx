import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock3,
  LoaderCircle,
  Monitor,
  Pencil,
  Plus,
  Server,
  Trash2,
  Wifi,
} from "lucide-react";
import { api, errorText, remove } from "./api";
import { Avatar, Modal } from "./components";
import {
  checkAge,
  harnessLabel,
  harnessName,
  harnessTip,
  runMachineCheck,
  type MachineCheck,
} from "./machine-checks";
import { MachineEditor } from "./MachineEditor";
import { strings, useLanguage, type Language } from "./i18n";
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
// passes the interface language; New agent, not yet translated, keeps
// English. Host names, paths and the reasons Core or SSH gave stay as written.
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

// The page's own words (T-189). Machine and Agent names, SSH destinations,
// paths, host facts and Core's errors are shown as they are.
const text = strings({
  states: { idle: "Ready", working: "Working", waiting: "Waiting", offline: "Offline", error: "Needs a look", uncertain: "Check result" } as Record<Agent["status"], string>,
  title: "Machines",
  description: "Where your agents run. A check shows what Core could reach at that moment; nothing checks in the background.",
  add: "Add SSH machine",
  loadFailed: (error: string) => `Couldn’t load machines: ${error}`,
  loading: "Loading machines…",
  ssh: (target: string) => `SSH · ${target}`,
  local: "Local · runs your Workspace Core",
  checking: "Checking…",
  test: "Test connection",
  editName: (name: string) => `Edit ${name}`,
  edit: "Edit",
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
  closed: "Closed",
  connected: "Connected",
  connecting: "Connecting",
  notConnected: "Not connected",
  noAgents: "No agents on this machine yet.",
  footnote: "Agent states come from their own sessions, not from these checks. An old check does not mean a machine is offline, and a found CLI does not mean it is signed in.",
}, {
  states: { idle: "就绪", working: "工作中", waiting: "等待中", offline: "离线", error: "需要查看", uncertain: "需核对结果" },
  title: "机器",
  description: "你的 Agent 运行的地方。一次检查只说明 Core 在那一刻能访问到什么；后台不会自动检查。",
  add: "添加 SSH 机器",
  loadFailed: (error) => `无法加载机器：${error}`,
  loading: "正在加载机器…",
  local: "本机 · 运行你的 Workspace Core",
  checking: "正在检查…",
  test: "测试连接",
  editName: (name) => `编辑 ${name}`,
  edit: "编辑",
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
  closed: "已关闭",
  connected: "已连接",
  connecting: "正在连接",
  notConnected: "未连接",
  noAgents: "此机器上还没有 Agent。",
  footnote: "Agent 的状态来自它们自己的会话，而非这些检查。较早的检查不代表机器已离线，找到 CLI 也不代表已登录。",
});

export function MachinesPage({
  open,
  onOpenChange,
  agents,
  projects,
  revision,
  onOpenAgent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  projects: Project[];
  /** Workspace change counter; another window's check refreshes this list. */
  revision: number;
  onOpenAgent: (id: string) => void;
}) {
  const language = useLanguage();
  const t = text(language);
  const [machines, setMachines] = useState<WorkspaceMachine[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  // One change at a time: adding a machine, or editing or removing one.
  const [change, setChange] = useState<
    { kind: "add" } | { kind: "edit" | "remove"; id: string } | null
  >(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const load = useRef(0);
  const now = useNow(open);
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
      setChange(null);
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
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={t.title}
      description={t.description}
    >
      <div className="machines-page">
        <div className="machines-toolbar">
          <button
            type="button"
            className="secondary-button"
            aria-expanded={change?.kind === "add"}
            aria-controls="machines-new-ssh"
            disabled={!machines || change?.kind === "add"}
            onClick={() => startChange({ kind: "add" })}
          >
            <Plus size={14} /> {t.add}
          </button>
        </div>
        {change?.kind === "add" && (
          <MachineEditor
            id="machines-new-ssh"
            language={language}
            onCancel={() => setChange(null)}
            onSaved={(saved) => {
              setMachines((list) => [...(list || []), saved]);
              setChange(null);
            }}
          />
        )}
        {loadError && (
          <p role="alert" className="inline-error">
            {t.loadFailed(loadError)}
          </p>
        )}
        {!machines && !loadError && (
          <p className="machines-loading" role="status">
            <LoaderCircle size={15} className="spin" /> {t.loading}
          </p>
        )}
        {machines?.map((machine) => {
          const here = agents.filter((a) => machineIdOf(a) === machine.id);
          const working = here.filter((a) => !a.closedAt);
          const busy = !!checking[machine.id];
          const editing = change?.kind === "edit" && change.id === machine.id;
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
                        aria-label={t.editName(machine.name)}
                        title={t.edit}
                        disabled={busy}
                        aria-pressed={editing}
                        onClick={() =>
                          startChange(
                            editing ? null : { kind: "edit", id: machine.id },
                          )
                        }
                      >
                        <Pencil size={14} />
                      </button>
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
              {editing && (
                <MachineEditor
                  key={machine.id}
                  machine={machine}
                  language={language}
                  onCancel={() => setChange(null)}
                  onSaved={(saved) => {
                    setChange(null);
                    // What Core saved shows at once, as for an added machine,
                    // so a failed read of the list after it doesn't show the
                    // old values (T-187). Core drops a check that described
                    // the old address.
                    setMachines((list) => (list || []).map((m) => (m.id === saved.id ? saved : m)));
                    reload();
                  }}
                />
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
                            {agent.closedAt ? t.closed : t.states[agent.status]}
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
        })}
        <p className="machine-note machines-footnote">{t.footnote}</p>
      </div>
    </Modal>
  );
}
