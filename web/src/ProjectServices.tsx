import { useCallback, useEffect, useRef, useState } from "react";
import {
  Globe,
  LoaderCircle,
  Monitor,
  Plug,
  PlugZap,
  Server,
  Trash2,
} from "lucide-react";
import { api, errorText, post, remove } from "./api";
import { strings, useStrings } from "./i18n";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import "./project-services.css";
import { OpenChoice } from "./portal/OpenChoice";

/** What Core has open for a service now (core/src/services.rs, Access). */
export type ServiceConnection = {
  state:
    | "closed"
    | "opening"
    | "available"
    | "notRunning"
    | "notReady"
    | "portInUse"
    | "machineUnreachable"
    | "tunnelFailed"
    | "disconnected";
  localPort?: number;
  httpStatus?: number;
  /** Whether the checked page may be framed by another origin (T-5). */
  framing?: "allowed" | "blocked" | "restricted" | "unknown";
  reason?: string;
  since: string;
};
/** The Yuzuno Job that serves a service, when one does (T-5, service_jobs). */
export type ServiceJob = {
  jobId: string;
  status: string;
  /** Whether the listener on the service's port is that Job's own. */
  owner: "verified" | "otherProcess" | "notListening" | "unknown";
  earlierJobIds: string[];
  canStop: boolean;
};
export type ServiceHealth =
  | { declared: false }
  | { declared: true; path: string; state: "ok" | "failing" | "unknown"; httpStatus?: number; reason?: string; checkedAt?: string };
export type ProjectService = {
  id: string;
  projectId: string;
  machineId: string;
  port: number;
  path: string;
  name: string;
  author: { kind: "user" } | { kind: "agent"; id: string; name: string };
  createdAt: string;
  connection: ServiceConnection;
  /** Undefined from a Core without service Jobs; null for a service no Yuzuno Job runs. */
  job?: ServiceJob | null;
  health?: ServiceHealth;
};
type Opened = ProjectService & { proof?: { challenge: string; answer: string } };
/** Whether this browser reaches Core's port for the service (checked here,
 * never assumed from Core's side). */
type Reach =
  | { kind: "checking" }
  | { kind: "proven"; url: string }
  | { kind: "unproven"; port: number };

/** Whether this page was opened on a loopback address, the desktop app's own
 * (`localhost`, `tauri.localhost`) included. Only there can the note about an
 * unconfirmed port speak of this computer's ports and its tunnel; a page
 * reached another way (Core's remote entry, T-170) says only that this
 * connection gives no way to the service. */
const loopbackPage = () => /^(localhost|[^/]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(window.location.hostname);

// The section's own words (T-189). Service and machine names, ports, paths
// and the reasons Core gives are shown as they are.
const text = strings({
  states: {
    closed: "Not open",
    opening: "Opening…",
    available: "Answering",
    notRunning: "Not running",
    notReady: "Not answering yet",
    portInUse: "No free port",
    machineUnreachable: "Machine unreachable",
    tunnelFailed: "SSH failed",
    disconnected: "Disconnected",
  } as Record<ServiceConnection["state"], string>,
  title: "Services",
  add: "Add",
  hint: "Web services that already run on this project’s machines, such as a dev server, Jupyter or TensorBoard. Agents can add them too. Opening one connects to it on the machine; Yuzuno never starts or stops a service.",
  loading: "Loading services…",
  empty: "No services yet.",
  coreHost: "Core host",
  where: (machine: string, port: number) => `${machine} · port ${port}`,
  byAgent: (name: string) => `added by ${name}`,
  byYou: "added by you",
  checkAgain: "Check again",
  open: "Open",
  close: "Close",
  deleteName: (name: string) => `Delete ${name}`,
  deleteTip: "Delete (closes it here; the service keeps running)",
  corePort: (port: number) => ` · Core port ${port}`,
  checking: (port?: number) => `Checking that this computer reaches port ${port}…`,
  unreachedHere: (port: number) =>
    `This computer does not reach Core’s port ${port}: something else answers there, or nothing does. On the Core host itself it opens directly. From another computer whose tunnel reaches Core (a Mac), that tunnel must forward Core’s service ports too; see “Connect from another computer” in the guide.`,
  unreachedRemote: (port: number) =>
    `Project services are not available through this page’s connection: Core’s port ${port} could not be confirmed from here. They open on the Core host, or on a computer with a tunnel to Core; see “Connect from another computer” in the guide.`,
  name: "Name",
  machine: "Machine",
  portThere: "Port there",
  path: "Path",
  formHint: "The service listens on that port on the machine’s own loopback. It opens on one of Core’s own ports, shown once it is open. A page that names its own port (for example Vite with hmr.clientPort set, or a redirect to an address with a port) must name Core’s port instead, and a WebSocket on a separate port is a service of its own. Never put a token or password in the path: every agent can read it.",
  cancel: "Cancel",
  addService: "Add service",
}, {
  states: {
    closed: "未打开",
    opening: "正在打开…",
    available: "有响应",
    notRunning: "未运行",
    notReady: "尚无响应",
    portInUse: "没有空闲端口",
    machineUnreachable: "机器无法访问",
    tunnelFailed: "SSH 失败",
    disconnected: "已断开",
  },
  title: "服务",
  add: "添加",
  hint: "已在此项目机器上运行的 Web 服务，例如开发服务器、Jupyter 或 TensorBoard。Agent 也可以添加。打开时会在该机器上连接它；Yuzuno 从不启动或停止服务。",
  loading: "正在加载服务…",
  empty: "还没有服务。",
  coreHost: "Core 主机",
  where: (machine, port) => `${machine} · 端口 ${port}`,
  byAgent: (name) => `由 ${name} 添加`,
  byYou: "由你添加",
  checkAgain: "再次检查",
  open: "打开",
  close: "关闭",
  deleteName: (name) => `删除 ${name}`,
  deleteTip: "删除（在这里关闭它；服务本身继续运行）",
  corePort: (port) => ` · Core 端口 ${port}`,
  checking: (port) => `正在检查这台电脑能否访问端口 ${port}…`,
  unreachedHere: (port) =>
    `这台电脑访问不到 Core 的端口 ${port}：那里有别的程序在响应，或者没有任何响应。在 Core 主机上会直接打开。从另一台通过隧道连到 Core 的电脑（例如 Mac）访问时，该隧道也必须转发 Core 的服务端口；参见指南中的 “Connect from another computer”。`,
  unreachedRemote: (port) =>
    `通过此页面的连接无法使用项目服务：从这里无法确认 Core 的端口 ${port}。它们在 Core 主机上，或在有通往 Core 隧道的电脑上打开；参见指南中的 “Connect from another computer”。`,
  name: "名称",
  machine: "机器",
  portThere: "该机器上的端口",
  path: "路径",
  formHint: "服务在该机器自身回环地址的那个端口上监听。它会在 Core 自己的某个端口上打开，打开后显示。自己写明端口的页面（例如设置了 hmr.clientPort 的 Vite，或重定向到带端口的地址）必须改写为 Core 的端口；另一个端口上的 WebSocket 是单独的服务。不要在路径里放令牌或密码：所有 Agent 都能读到它。",
  cancel: "取消",
  addService: "添加服务",
});

/** The page's own check, from this browser: Core's port answers the
 * reserved request with exactly the answer Core gave this page. Anything
 * else on that port here (another program with the same number) cannot. */
async function proves(port: number, proof: { challenge: string; answer: string }) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/.well-known/yuzuno-service/${encodeURIComponent(proof.challenge)}`,
      { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal },
    );
    return response.ok && (await response.text()) === proof.answer;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/** A project's web services (T-151): registered by the user or an Agent,
 * opened only here, by the user. */
export function ProjectServices({
  projectId,
  machines,
  disabled,
  onOpened,
}: {
  projectId: string;
  machines: WorkspaceMachine[];
  disabled: boolean;
  /** Once a service is opened (in the Portal or the browser). */
  onOpened?: () => void;
}) {
  const t = useStrings(text);
  const [services, setServices] = useState<ProjectService[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reach, setReach] = useState<Record<string, Reach>>({});
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", machineId: "local", port: "", path: "/" });
  const mounted = useRef(true);
  const path = `/projects/${encodeURIComponent(projectId)}/services`;
  const load = useCallback(async () => {
    try {
      const page = await api<{ services: ProjectService[] }>(path);
      if (!mounted.current) return;
      setServices(page.services);
      setError("");
      // A way that closed or changed port is no longer proven.
      setReach((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id, value]) => {
            const port = page.services.find((s) => s.id === id)?.connection.localPort;
            return port !== undefined && (value.kind !== "unproven" || value.port === port) &&
              (value.kind !== "proven" || value.url.startsWith(`http://127.0.0.1:${port}/`));
          }),
        ),
      );
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    }
  }, [path]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 5000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [load]);
  const act = async (name: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(name);
    setError("");
    try {
      await action();
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      if (mounted.current) setBusy("");
      void load();
    }
  };
  const open = (service: ProjectService) =>
    act(service.id, async () => {
      const opened = await post<Opened>(`/services/${encodeURIComponent(service.id)}/open`);
      const port = opened.connection.localPort;
      setServices((current) => current?.map((s) => (s.id === opened.id ? { ...s, connection: opened.connection } : s)) ?? null);
      if (port === undefined || !opened.proof) return;
      setReach((current) => ({ ...current, [service.id]: { kind: "checking" } }));
      const proven = await proves(port, opened.proof);
      if (!mounted.current) return;
      setReach((current) => ({
        ...current,
        [service.id]: proven ? { kind: "proven", url: `http://127.0.0.1:${port}${service.path}` } : { kind: "unproven", port },
      }));
    });
  const machineName = (id: string) =>
    machines.find((m) => m.id === id)?.name || (id === "local" ? t.coreHost : id);
  const sshOrLocal = machines.filter((m) => m.kind === "local" || m.kind === "ssh");
  return (
    <section className="services-panel" aria-label={t.title}>
      <header>
        <h4>
          <Globe size={16} />
          {t.title}
        </h4>
        {!disabled && !adding && (
          <button type="button" className="quiet-button" onClick={() => setAdding(true)}>
            {t.add}
          </button>
        )}
      </header>
      <p className="services-hint">{t.hint}</p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {!services && !error && (
        <p className="services-hint">
          <LoaderCircle size={13} className="spin" /> {t.loading}
        </p>
      )}
      {services && !services.length && !adding && <p className="services-hint">{t.empty}</p>}
      <ul className="services-list">
        {services?.map((service) => {
          const c = service.connection;
          const listening = c.localPort !== undefined;
          const shown = reach[service.id];
          return (
            <li key={service.id} className="services-entry" data-state={c.state}>
              <div className="services-entry-top">
                <span className="services-name">
                  <strong>{service.name}</strong>
                  <small>
                    {service.machineId === "local" ? <Monitor size={12} /> : <Server size={12} />}
                    {t.where(machineName(service.machineId), service.port)}
                    {service.path !== "/" ? ` · ${service.path}` : ""}
                    {" · "}
                    {service.author.kind === "agent" ? t.byAgent(service.author.name) : t.byYou}
                  </small>
                </span>
                <span className="services-actions">
                  {!disabled && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!!busy}
                      onClick={() => void open(service)}
                    >
                      {busy === service.id ? <LoaderCircle size={13} className="spin" /> : <PlugZap size={13} />}
                      {listening ? t.checkAgain : t.open}
                    </button>
                  )}
                  {listening && (
                    <button
                      type="button"
                      className="quiet-button"
                      disabled={!!busy}
                      onClick={() =>
                        void act(service.id, () => post(`/services/${encodeURIComponent(service.id)}/close`))
                      }
                    >
                      <Plug size={13} />
                      {t.close}
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t.deleteName(service.name)}
                    title={t.deleteTip}
                    disabled={!!busy}
                    onClick={() => void act(service.id, () => remove(`/services/${encodeURIComponent(service.id)}`))}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
              <p className="services-state">
                <span className="services-dot" />
                {t.states[c.state]}
                {c.state === "available" && c.httpStatus ? ` (HTTP ${c.httpStatus})` : ""}
                {listening ? t.corePort(c.localPort!) : ""}
                {c.reason ? <span className="services-reason"> · {c.reason}</span> : null}
              </p>
              {shown?.kind === "checking" && (
                <p className="services-hint">
                  <LoaderCircle size={13} className="spin" /> {t.checking(c.localPort)}
                </p>
              )}
              {shown?.kind === "proven" && c.state === "available" && (
                <div className="services-open">
                  <OpenChoice
                    target={() => ({ kind: "service", service, url: shown.url, where: t.where(machineName(service.machineId), service.port) })}
                    onOpened={onOpened}
                  />
                  <small>{shown.url.replace(/^http:\/\//, "")}</small>
                </div>
              )}
              {shown?.kind === "unproven" && (
                <p className="services-unreached" role="status">
                  {loopbackPage() ? t.unreachedHere(shown.port) : t.unreachedRemote(shown.port)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {adding && (
        <form
          className="services-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act("add", async () => {
              await post(path, {
                name: form.name.trim(),
                machineId: form.machineId,
                port: Number(form.port),
                path: form.path.trim() || "/",
              });
              if (mounted.current) {
                setForm({ name: "", machineId: form.machineId, port: "", path: "/" });
                setAdding(false);
              }
            });
          }}
        >
          <label>
            {t.name}
            <input
              required
              maxLength={80}
              value={form.name}
              placeholder="Vite dev server"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            {t.machine}
            <select value={form.machineId} onChange={(e) => setForm({ ...form, machineId: e.target.value })}>
              {sshOrLocal.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t.portThere}
            <input
              required
              inputMode="numeric"
              pattern="[0-9]{1,5}"
              value={form.port}
              placeholder="5173"
              onChange={(e) => setForm({ ...form, port: e.target.value })}
            />
          </label>
          <label>
            {t.path}
            <input
              value={form.path}
              placeholder="/"
              spellCheck={false}
              onChange={(e) => setForm({ ...form, path: e.target.value })}
            />
          </label>
          <p className="services-hint">{t.formHint}</p>
          <div className="services-form-actions">
            <button type="button" className="quiet-button" onClick={() => setAdding(false)}>
              {t.cancel}
            </button>
            <button className="secondary-button" disabled={!!busy || !form.name.trim() || !form.port}>
              {busy === "add" ? <LoaderCircle size={13} className="spin" /> : null}
              {t.addService}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
