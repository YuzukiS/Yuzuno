import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Globe,
  LoaderCircle,
  Monitor,
  Plug,
  PlugZap,
  Server,
  Trash2,
} from "lucide-react";
import { api, errorText, post, remove } from "./api";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import "./project-services.css";

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
  reason?: string;
  since: string;
};
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
};
type Opened = ProjectService & { proof?: { challenge: string; answer: string } };
/** Whether this browser reaches Core's port for the service (checked here,
 * never assumed from Core's side). */
type Reach =
  | { kind: "checking" }
  | { kind: "proven"; url: string }
  | { kind: "unproven"; port: number };

const states: Record<ServiceConnection["state"], string> = {
  closed: "Not open",
  opening: "Opening…",
  available: "Answering",
  notRunning: "Not running",
  notReady: "Not answering yet",
  portInUse: "No free port",
  machineUnreachable: "Machine unreachable",
  tunnelFailed: "SSH failed",
  disconnected: "Disconnected",
};

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
}: {
  projectId: string;
  machines: WorkspaceMachine[];
  disabled: boolean;
}) {
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
    machines.find((m) => m.id === id)?.name || (id === "local" ? "Core host" : id);
  const sshOrLocal = machines.filter((m) => m.kind === "local" || m.kind === "ssh");
  return (
    <section className="services-panel" aria-label="Services">
      <header>
        <h4>
          <Globe size={16} />
          Services
        </h4>
        {!disabled && !adding && (
          <button type="button" className="quiet-button" onClick={() => setAdding(true)}>
            Add
          </button>
        )}
      </header>
      <p className="services-hint">
        Web services that already run on this project’s machines, such as a dev
        server, Jupyter or TensorBoard. Agents can add them too. Opening one
        connects to it on the machine; Yuzuno never starts or stops a service.
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {!services && !error && (
        <p className="services-hint">
          <LoaderCircle size={13} className="spin" /> Loading services…
        </p>
      )}
      {services && !services.length && !adding && <p className="services-hint">No services yet.</p>}
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
                    {machineName(service.machineId)} · port {service.port}
                    {service.path !== "/" ? ` · ${service.path}` : ""}
                    {" · "}
                    {service.author.kind === "agent" ? `added by ${service.author.name}` : "added by you"}
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
                      {listening ? "Check again" : "Open"}
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
                      Close
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Delete ${service.name}`}
                    title="Delete (closes it here; the service keeps running)"
                    disabled={!!busy}
                    onClick={() => void act(service.id, () => remove(`/services/${encodeURIComponent(service.id)}`))}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
              <p className="services-state">
                <span className="services-dot" />
                {states[c.state]}
                {c.state === "available" && c.httpStatus ? ` (HTTP ${c.httpStatus})` : ""}
                {listening ? ` · Core port ${c.localPort}` : ""}
                {c.reason ? <span className="services-reason"> · {c.reason}</span> : null}
              </p>
              {shown?.kind === "checking" && (
                <p className="services-hint">
                  <LoaderCircle size={13} className="spin" /> Checking that this computer reaches port {c.localPort}…
                </p>
              )}
              {shown?.kind === "proven" && c.state === "available" && (
                <a className="services-open" href={shown.url} target="_blank" rel="noopener noreferrer">
                  Open {shown.url.replace(/^http:\/\//, "")}
                  <ArrowUpRight size={13} />
                </a>
              )}
              {shown?.kind === "unproven" && (
                <p className="services-unreached" role="status">
                  This computer does not reach Core’s port {shown.port}: something else answers there, or nothing
                  does. On the Core host itself it opens directly. From another computer whose tunnel reaches Core
                  (a Mac), that tunnel must forward Core’s service ports too; see “Connect from another computer”
                  in the guide.
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
            Name
            <input
              required
              maxLength={80}
              value={form.name}
              placeholder="Vite dev server"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Machine
            <select value={form.machineId} onChange={(e) => setForm({ ...form, machineId: e.target.value })}>
              {sshOrLocal.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Port there
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
            Path
            <input
              value={form.path}
              placeholder="/"
              spellCheck={false}
              onChange={(e) => setForm({ ...form, path: e.target.value })}
            />
          </label>
          <p className="services-hint">
            The service listens on that port on the machine’s own loopback. It opens on one of Core’s own ports,
            shown once it is open. A page that names its own port (for example Vite with hmr.clientPort set, or a
            redirect to an address with a port) must name Core’s port instead, and a WebSocket on a separate port is
            a service of its own. Never put a token or password in the path: every agent can read it.
          </p>
          <div className="services-form-actions">
            <button type="button" className="quiet-button" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="secondary-button" disabled={!!busy || !form.name.trim() || !form.port}>
              {busy === "add" ? <LoaderCircle size={13} className="spin" /> : null}
              Add service
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
