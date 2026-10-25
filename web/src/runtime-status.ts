import { api } from "./api";
import { desktopShell, type DesktopUpdateStatus } from "./DesktopUpdate";
import { checkAge, harnessName, type HarnessCheck, type MachineCheck } from "./machine-checks";
import type { WorkspaceMachine } from "./RemoteCreateAgent";
import type { Agent, Model, Workspace } from "./types";
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

/** Where a prepared copy's SDK files came from, as its receipt says. */
export type SdkSource =
  | { from: "registry"; host: string | null }
  | { from: "release"; release: string | null }
  | { from: "preparedCopy" }
  | { from: "unknown" };
export interface SdkCopy {
  version: string | null;
  source: SdkSource;
  at: string | null;
}
/** GET /api/claude-sdk (T-191): the Claude Agent SDK Core's Claude bridge
 * runs, read by Core without preparing, copying or downloading anything. */
export interface ClaudeSdkStatus {
  format: number;
  readAt: string;
  runtime: { kind: "release"; release: string | null } | { kind: "other" } | { kind: "missing" };
  sdk:
    | { state: "locked"; version: string | null; registry: string | null }
    | { state: "inRuntime"; version: string | null }
    | { state: "none" }
    | { state: "unreadable"; reason: string }
    | { state: "unknown" };
  copy:
    | { state: "inUse"; copy: SdkCopy | null }
    | { state: "found"; copies: number; newest: SdkCopy; limited: boolean }
    | { state: "none"; limited: boolean }
    | { state: "notNeeded" }
    | { state: "unknown" };
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
  /** The Claude Agent SDK, as Core says it; absent from reads made before it. */
  sdk?: { ok: true; value: ClaudeSdkStatus } | { ok: false; error: string };
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
  const [health, machines, workspace, budget, sdk, desktop] = await Promise.all([
    settle(() => api<CoreHealth>("/health", { signal })),
    settle(async () => (await api<{ machines: WorkspaceMachine[] }>("/machines", { signal })).machines),
    settle(() => api<Workspace>("/workspace", { signal })),
    settle(() => api<JobsBudget>("/jobs/budget", { signal })),
    settle(() => api<ClaudeSdkStatus>("/claude-sdk", { signal })),
    invoke ? settle(async () => (await invoke("desktop_update_status")) as DesktopUpdateStatus) : Promise.resolve(null),
  ]);
  return {
    at: new Date().toISOString(), health, machines,
    runtime: workspace.ok ? { ok: true, value: workspace.value.runtime } : workspace,
    agents: workspace.ok ? workspace.value.agents ?? [] : null,
    budget, sdk, desktop, page: loadedRelease(),
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
  core: { version: Fact; release: Fact; ready: Fact; sdk: Fact; sdkCopy: Fact };
  client: { page: Fact; desktop: Fact; iphone: Fact };
  machines: MachineFacts[];
  machinesError?: string;
}

const HARNESSES = ["codex", "claude"] as const;

/** One explicit model check on the Core host (T-191): the catalog requests
 * the New Agent dialog makes when it opens, nothing else. */
export type ModelCheck = { at: string } & ({ ok: true; count: number; defaultName?: string } | { ok: false; error: string });
export type ModelChecks = Partial<Record<(typeof HARNESSES)[number], ModelCheck>>;

export async function checkModels(): Promise<ModelChecks> {
  const one = async (path: string): Promise<ModelCheck> => {
    try {
      const models = (await api<{ models?: Model[] }>(path)).models ?? [];
      const preset = models.find((m) => m.isDefault);
      return { at: new Date().toISOString(), ok: true, count: models.length, ...(preset ? { defaultName: preset.displayName || preset.model } : {}) };
    } catch (error) {
      return { at: new Date().toISOString(), ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const [codex, claude] = await Promise.all([one("/models"), one("/models?harness=claude")]);
  return { codex, claude };
}

function modelsFact(machine: WorkspaceMachine, check: ModelCheck | undefined): Fact {
  if (machine.kind !== "local") return fact("unknown", "Not checked here", "An SSH machine's models are listed when an Agent there chooses one.");
  if (!check) return fact("unknown", "Not checked yet", "Check models lists them from the Core host's CLIs, as the New Agent dialog does.");
  const when = `checked ${new Date(check.at).toLocaleTimeString()}`;
  if (!check.ok) return fact("no", "Couldn't list models", `${check.error} · ${when}`);
  if (!check.count) return fact("no", "No models listed", when);
  return fact("yes", `${check.count} ${check.count === 1 ? "model" : "models"}`, `${check.defaultName ? `Default ${check.defaultName} · ` : ""}${when}`);
}
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
      if (machine.kind !== "local") {
        if (!machine.lastCheck) return fact("unknown", "Not checked yet", "Check the machine on the Machines page.");
        if (!machine.lastCheck.reachable) return fact("unknown", "Not known", "The last check didn't reach this machine.");
        return fact("unknown", "Not known", "The last check didn't report it: `claude auth status` there gave no answer, Claude Code couldn't run, or the check was made before SSH checks reported sign-in. A sign-in problem shows on the CLI line.");
      }
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

const when = (iso: string | null) => {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleString() : "at a time it doesn't say";
};
function sourceText(source: SdkSource) {
  if (source.from === "registry") return source.host ? `downloaded from ${source.host}` : "downloaded from its registry";
  if (source.from === "release") return source.release ? `copied from release ${source.release}` : "copied from another release";
  if (source.from === "preparedCopy") return "copied from another prepared copy";
  return "from a source its receipt doesn't name";
}
const copyText = (copy: SdkCopy) =>
  `${copy.version ? `SDK ${copy.version}, ` : ""}${sourceText(copy.source)}, prepared ${when(copy.at)}`;

/** The SDK Core's Claude bridge runs (T-191): the version its runtime locks
 * or declares, and the copy it runs from. The bridge has no version of its
 * own, and Claude Code's CLI is another program (under Machines). */
function sdkFacts(read: RuntimeRead["sdk"]): { sdk: Fact; sdkCopy: Fact } {
  if (!read) return { sdk: fact("unknown", "Not read"), sdkCopy: fact("unknown", "Not read") };
  if (!read.ok) return { sdk: fact("unknown", "Not known", `Core didn't say: ${read.error}`), sdkCopy: fact("unknown", "Not known") };
  const status = read.value;
  if (status.format !== 1) return { sdk: fact("unknown", "Not known", "Core answered in a form this page doesn't read."), sdkCopy: fact("unknown", "Not known") };
  const checked = `Core read it ${when(status.readAt)}.`;
  if (status.runtime.kind === "missing")
    return { sdk: fact("unknown", "Not known", `Core has no Claude runtime set up, so no SDK is known. ${checked}`), sdkCopy: fact("unknown", "Not known") };
  const runtime = status.runtime.kind === "release" && status.runtime.release ? `release ${status.runtime.release}` : "this Core's runtime (not an installed release's)";
  const sdk = status.sdk;
  const sdkFact =
    sdk.state === "locked"
      ? sdk.version
        ? fact("yes", `Locked ${sdk.version}`, `As claude-agent-sdk.json in ${runtime} locks it${sdk.registry ? `, from ${sdk.registry}` : ""}. ${checked}`)
        : fact("unknown", "Locked, version not readable", `claude-agent-sdk.json in ${runtime} names no version this page shows. ${checked}`)
      : sdk.state === "inRuntime"
        ? sdk.version
          ? fact("yes", `${sdk.version} · in the runtime`, `The version the SDK package in ${runtime} declares: that runtime carries the SDK itself. ${checked}`)
          : fact("unknown", "In the runtime, version not declared", `The SDK package in ${runtime} doesn't declare a version. ${checked}`)
        : sdk.state === "none"
          ? fact("no", "Not in the runtime", `Neither the SDK nor claude-agent-sdk.json is in ${runtime}. ${checked}`)
          : sdk.state === "unreadable"
            ? fact("unknown", "Can't be read", `claude-agent-sdk.json in ${runtime}: ${sdk.reason}. ${checked}`)
            : fact("unknown", "Not known", checked);
  const copy = status.copy;
  const sdkCopy =
    copy.state === "notNeeded"
      ? sdk.state === "none"
        ? fact("no", "Nothing to prepare", "Core runs this runtime as it is, and it has no SDK for its Claude bridge.")
        : fact("yes", "Not needed", "The runtime carries the SDK, so Core runs it as it is.")
      : copy.state === "inUse"
        ? fact("yes", "In use", `${copy.copy ? `${copyText(copy.copy)}. ` : ""}Core prepared or found this copy in this run; its Claude bridges run from it.`)
        : copy.state === "found"
          ? fact(
              "unknown",
              "Not used yet in this run",
              `${copy.copies === 1 ? "A copy" : `${copy.copies} copies`} of this SDK on the Core host, the newest ${copyText(copy.newest)}. ` +
                "Core checks it when a Claude Agent first starts." +
                (copy.limited ? " Only the first copies were looked at." : ""),
            )
          : copy.state === "none"
            ? fact(
                "no",
                "Not prepared",
                "Core prepares a copy when a Claude Agent first starts: from another installed release, or by downloading the locked package. Reading this downloads nothing." +
                  (copy.limited ? " Only the first copies were looked at." : ""),
              )
            : fact("unknown", "Not known", sdk.state === "unreadable" ? "Not known while claude-agent-sdk.json can't be read." : undefined);
  return { sdk: sdkFact, sdkCopy };
}

/** The facts to show, from one read, at `now`. */
export function runtimeView(read: RuntimeRead, now = Date.now(), models: ModelChecks = {}): RuntimeView {
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
  const sdk = sdkFacts(read.sdk);
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
            models: modelsFact(machine, models[harness]),
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
    core: { ...core, ...sdk },
    client: { page, desktop, iphone },
    machines,
    ...(read.machines.ok ? {} : { machinesError: read.machines.error }),
  };
}
