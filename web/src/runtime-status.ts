import { api } from "./api";
import { desktopShell, type DesktopUpdateStatus } from "./DesktopUpdate";
import { checkAge, harnessName, type HarnessCheck, type MachineCheck } from "./machine-checks";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import type { Agent, Workspace } from "./types";
import { loadedRelease } from "./updates";

/**
 * The runtime and versions this Workspace runs on (T-191): Core's version,
 * each machine's stored last check, Codex's connection on the Core host as
 * Core holds it now, the Core host's Jobs budget, and this client's own
 * version. Reading them signs nothing in, reconnects nothing, updates
 * nothing and runs no machine check (that is the Machines page's). Reading
 * the Jobs budget may have Core sample the GPUs (at most every ten seconds)
 * and keep that sample, as the status bar's own reads do.
 */

/** One fact as known: yes, no, or not known, never guessed. */
export type FactState = "yes" | "no" | "unknown";
export interface Fact {
  state: FactState;
  text: string;
  /** Where it came from, or why it isn't known. */
  detail?: string;
}
const fact = (state: FactState, text: string, detail?: string): Fact => ({ state, text, ...(detail ? { detail } : {}) });

/** GET /api/health: Core's identity, read only. */
export interface CoreHealth {
  version?: string;
  releaseId?: string;
  apiReady?: boolean;
  storageReady?: boolean;
}
/** GET /api/jobs/budget, as far as this view reads it. */
export interface JobsBudget {
  machine: { name: string; scope?: string };
  windows?: { available: boolean; reason?: string | null };
}

/** What one read gathered, each with whether it could be read. */
export interface RuntimeRead {
  /** When this client had all four answers, by its own clock; each was
   * answered on its own, so this isn't one snapshot. */
  at: string;
  health: { ok: true; value: CoreHealth } | { ok: false; error: string };
  machines: { ok: true; value: WorkspaceMachine[] } | { ok: false; error: string };
  runtime: { ok: true; value: Workspace["runtime"] } | { ok: false; error: string };
  /** The Workspace's Agents from the same answer; null when it failed. */
  agents?: Agent[] | null;
  budget: { ok: true; value: JobsBudget } | { ok: false; error: string };
  /** Null: not the desktop app. */
  desktop: null | { ok: true; value: DesktopUpdateStatus } | { ok: false; error: string };
  /** The release this page was built from, if it says. */
  page: string | null;
}

const settle = async <T>(read: () => Promise<T>) => {
  try {
    return { ok: true as const, value: await read() };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
};

/** Every request is a GET (or the desktop app's local status); none starts
 * a machine check, a sign-in, a reconnect or an update. The four answers
 * come separately: `at` is when this client had them all, not one snapshot. */
export async function readRuntime(signal?: AbortSignal): Promise<RuntimeRead> {
  const invoke = desktopShell.invoke();
  const [health, machines, workspace, budget, desktop] = await Promise.all([
    settle(() => api<CoreHealth>("/health", { signal })),
    settle(async () => (await api<{ machines: WorkspaceMachine[] }>("/machines", { signal })).machines),
    settle(() => api<Workspace>("/workspace", { signal })),
    settle(() => api<JobsBudget>("/jobs/budget", { signal })),
    invoke ? settle(async () => (await invoke("desktop_update_status")) as DesktopUpdateStatus) : Promise.resolve(null),
  ]);
  return {
    at: new Date().toISOString(), health, machines,
    runtime: workspace.ok ? { ok: true, value: workspace.value.runtime } : workspace,
    agents: workspace.ok ? workspace.value.agents ?? [] : null,
    budget, desktop, page: loadedRelease(),
  };
}

export interface HarnessFacts {
  harness: string;
  name: string;
  cli: Fact;
  signedIn: Fact;
  models: Fact;
}
export interface MachineFacts {
  id: string;
  name: string;
  kind: "local" | "ssh";
  target?: string;
  /** The stored check these facts come from; null: never checked. */
  checkedAt: string | null;
  age: string | null;
  stale: boolean;
  reachable: Fact;
  /** Codex's connection on the Core host, as Core holds it now. */
  codexConnection?: Fact;
  harnesses: HarnessFacts[];
  jobs: Fact;
  windowsJobs?: Fact;
}
export interface RuntimeView {
  at: string;
  core: { version: Fact; release: Fact; ready: Fact };
  client: { page: Fact; desktop: Fact; iphone: Fact };
  machines: MachineFacts[];
  machinesError?: string;
}

const HARNESSES = ["codex", "claude"] as const;
function cliFact(check: HarnessCheck | undefined, machineCheck: MachineCheck | null | undefined): Fact {
  if (!machineCheck) return fact("unknown", "Not checked yet", "Check the machine on the Machines page.");
  // A check that didn't reach the machine says nothing about its CLIs, even
  // where Core keeps a placeholder entry for one.
  if (!machineCheck.reachable) return fact("unknown", "Not known", "The last check didn't reach this machine.");
  if (!check) return fact("unknown", "Not part of the last check", "The last check didn't look for it.");
  if (!check.supported) return fact("no", "Not supported on this machine", check.error);
  const found = check.version ? `Found · ${check.version}` : "Found";
  if (check.found) return fact("yes", found, check.executable);
  // Core counts a signed-out CLI as not usable; its sign-in says why, so the
  // CLI itself is found.
  if (check.signIn?.state === "signedOut") return fact("yes", found, check.executable);
  // Found where it looked, but Core can't use it: its own reason.
  if (check.executable) return fact("no", check.version ? `Not usable · ${check.version}` : "Not usable", check.error);
  return fact("no", "Not found", check.error);
}

function signInFact(
  harness: string,
  check: HarnessCheck | undefined,
  machine: WorkspaceMachine,
  runtime: RuntimeRead["runtime"],
): Fact {
  if (harness === "claude") {
    const signIn = check?.signIn;
    if (!signIn) {
      if (machine.kind !== "local") return fact("unknown", "Not known", "Checks of SSH machines don't report sign-in by itself; a sign-in problem shows on the CLI line.");
      return machine.lastCheck
        ? fact("unknown", "Not known", "Sign-in is read only when the CLI can run.")
        : fact("unknown", "Not known", "Sign-in is checked with the CLI on the Machines page.");
    }
    if (signIn.state === "signedIn") return fact("yes", "Signed in", signIn.method);
    if (signIn.state === "signedOut") return fact("no", "Signed out", check?.error ?? signIn.detail);
    return fact("unknown", "Could not be checked", signIn.detail);
  }
  if (harness === "codex" && machine.kind === "local") {
    if (!runtime.ok) return fact("unknown", "Not known", `Core's Codex state could not be read: ${runtime.error}`);
    if (!runtime.value.connected) return fact("unknown", "Not known", "Codex is not connected on the Core host.");
    return runtime.value.account
      ? fact("yes", "Signed in", runtime.value.account)
      : fact("unknown", "No account reported", "Codex answered without naming an account.");
  }
  return fact("unknown", "Not known", "Machine checks don't read Codex's sign-in; Core knows it only on its own host.");
}

function jobsFact(machine: WorkspaceMachine, budget: RuntimeRead["budget"]): Fact {
  if (machine.kind === "local") {
    if (budget.ok) return fact("yes", "Managed Jobs run here", budget.value.machine.scope);
    // Core names no kind for a host that can't run them: its reason is shown, not guessed at.
    return fact("unknown", "Couldn't be confirmed", budget.error);
  }
  if (machine.limitMode === "strict") return fact("yes", "Managed · limits enforced", "Whether the machine can hold them is checked when a Job starts.");
  if (machine.limitMode === "limited") return fact("yes", "Managed · limits recorded where they can't be held", "Checked when a Job starts.");
  return fact("yes", "Record only", "Saved before Job limits: nothing is held there.");
}

/** The facts to show, from one read, at `now`. */
export function runtimeView(read: RuntimeRead, now = Date.now()): RuntimeView {
  const health = read.health;
  const core = health.ok
    ? {
        version: health.value.version ? fact("yes", health.value.version) : fact("unknown", "Not reported"),
        release:
          !health.value.releaseId
            ? fact("unknown", "Not reported")
            : health.value.releaseId === "development"
              ? fact("no", "A development build", "Not installed as a release; updates don't apply to it.")
              : fact("yes", health.value.releaseId),
        // A Core without its update manager reports neither: not known, not
        // "not ready" (it answered).
        ready:
          health.value.apiReady === false || health.value.storageReady === false
            ? fact("no", "Not ready", [health.value.apiReady === false && "API", health.value.storageReady === false && "storage"].filter(Boolean).join(" and ") + " not ready")
            : health.value.apiReady && health.value.storageReady
              ? fact("yes", "Ready")
              : fact("unknown", "Not reported", "This Core doesn't report whether its API and storage are ready."),
      }
    : {
        version: fact("unknown", "Not known", `Core could not be read: ${health.error}`),
        release: fact("unknown", "Not known"),
        ready: fact("unknown", "Not known"),
      };
  const page =
    !read.page
      ? fact("unknown", "This page doesn't say which release it is")
      : !health.ok || !health.value.releaseId
        ? fact("unknown", read.page, "Core's release isn't known to compare.")
        : read.page === health.value.releaseId
          ? fact("yes", read.page, "The same release as Core.")
          : fact("no", read.page, `Core runs ${health.value.releaseId}: reload this page to use it.`);
  const desktop =
    read.desktop === null
      ? fact("unknown", "Not known here", "This page isn't open in the desktop app, so it can't read the app's version.")
      : read.desktop.ok
        ? fact(
            "yes",
            read.desktop.value.version,
            // As the Desktop app card says it: why it can't update comes first.
            read.desktop.value.unavailable ??
              (read.desktop.value.channel === "installer"
                ? "Installed by the Yuzuno installer; it updates from the Desktop app card."
                : "Not installed by the Yuzuno installer, so it can't update itself."),
          )
        : fact("unknown", "Not known", `The desktop app didn't say: ${read.desktop.error}`);
  const iphone = fact("unknown", "Not reported", "The iPhone app doesn't report its version to this page.");

  const machines = read.machines.ok
    ? read.machines.value.map((machine): MachineFacts => {
        const check = machine.lastCheck ?? null;
        const age = check ? checkAge(check, now) : null;
        const reachable = !check
          ? fact("unknown", "Not checked yet", "Check the machine on the Machines page.")
          : check.reachable
            ? fact("yes", "Reached")
            : fact("no", "Not reached", check.error);
        const harnesses = HARNESSES.map((harness) => {
          const harnessCheck = check?.harnesses.find((h) => h.harness === harness);
          return {
            harness,
            name: harnessName(harness),
            cli: cliFact(harnessCheck, check),
            signedIn: signInFact(harness, harnessCheck, machine, read.runtime),
            models: fact("unknown", "Not checked here", "Models are listed when you choose one for an Agent."),
          };
        });
        const codexConnection =
          machine.kind !== "local"
            ? undefined
            : !read.runtime.ok
              ? fact("unknown", "Not known", read.runtime.error)
              : read.runtime.value.connected
                ? fact("yes", "Connected")
                : fact("no", "Not connected", read.runtime.value.error);
        const windows =
          machine.kind === "local" && read.budget.ok && read.budget.value.windows
            ? read.budget.value.windows.available
              ? fact("yes", "Windows Jobs available")
              : fact("no", "Windows Jobs not available", read.budget.value.windows.reason ?? undefined)
            : undefined;
        return {
          id: machine.id,
          name: machine.name,
          kind: machine.kind,
          ...(machine.target ? { target: machine.target } : {}),
          checkedAt: check?.checkedAt ?? null,
          age: age?.label ?? null,
          stale: age?.stale ?? false,
          reachable,
          ...(codexConnection ? { codexConnection } : {}),
          harnesses,
          jobs: jobsFact(machine, read.budget),
          ...(windows ? { windowsJobs: windows } : {}),
        };
      })
    : [];
  return {
    at: read.at,
    core,
    client: { page, desktop, iphone },
    machines,
    ...(read.machines.ok ? {} : { machinesError: read.machines.error }),
  };
}
