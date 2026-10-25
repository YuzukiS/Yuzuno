import { api } from "./api";
import { strings, type Language } from "./i18n";
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
  /** What the iPhone app says of itself (T-191). Null or absent: not the
   * iPhone app, or one that doesn't report it (an older one). */
  iphone?: null | { ok: true; version: string } | { ok: false };
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

/**
 * The version the iPhone app's window script gives every page it opens
 * (ios/src/app_version.js): a value, read here with no request and no call
 * into the app. Anything but a version is not taken for one.
 */
function iphoneApp(): RuntimeRead["iphone"] {
  const app = (globalThis as { __YUZUNO_IPHONE_APP__?: unknown }).__YUZUNO_IPHONE_APP__;
  if (app === undefined) return null;
  const version = app !== null && typeof app === "object" ? (app as { version?: unknown }).version : undefined;
  return typeof version === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(version) ? { ok: true, version } : { ok: false };
}

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
    budget, sdk, desktop, iphone: iphoneApp(), page: loadedRelease(),
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

// What the facts say, in the interface language (T-189). Versions, release
// IDs, paths, accounts, sign-in methods, the SDK registry and what Core, a
// CLI or the desktop app said are shown as they come.
const words = strings({
  notCheckedHere: "Not checked here",
  sshModels: "An SSH machine's models are listed when an Agent there chooses one.",
  notCheckedYet: "Not checked yet",
  checkModelsHelp: "Check models lists them from the Core host's CLIs, as the New Agent dialog does.",
  checkedAt: (time: string) => `checked ${time}`,
  couldNotList: "Couldn't list models",
  noModels: "No models listed",
  modelCount: (n: number) => `${n} ${n === 1 ? "model" : "models"}`,
  defaultModel: (name: string) => `Default ${name} · `,
  checkMachine: "Check the machine on the Machines page.",
  notKnown: "Not known",
  notReached: "The last check didn't reach this machine.",
  notInCheck: "Not part of the last check",
  notLookedFor: "The last check didn't look for it.",
  unsupported: "Not supported on this machine",
  found: (version: string | undefined) => (version ? `Found · ${version}` : "Found"),
  notUsable: (version: string | undefined) => (version ? `Not usable · ${version}` : "Not usable"),
  notFound: "Not found",
  claudeNotReported:
    "The last check didn't report it: `claude auth status` there gave no answer, Claude Code couldn't run, or the check was made before SSH checks reported sign-in. A sign-in problem shows on the CLI line.",
  signInWhenRunnable: "Sign-in is read only when the CLI can run.",
  signInOnMachines: "Sign-in is checked with the CLI on the Machines page.",
  signedIn: "Signed in",
  signedOut: "Signed out",
  notChecked: "Could not be checked",
  codexStateUnread: (error: string) => `Core's Codex state could not be read: ${error}`,
  codexNotConnected: "Codex is not connected on the Core host.",
  noAccount: "No account reported",
  noAccountHelp: "Codex answered without naming an account.",
  codexSignInElsewhere: "Machine checks don't read Codex's sign-in; Core knows it only on its own host.",
  jobsHere: "Managed Jobs run here",
  notConfirmed: "Couldn't be confirmed",
  strict: "Managed · limits enforced",
  strictHelp: "Whether the machine can hold them is checked when a Job starts.",
  limited: "Managed · limits recorded where they can't be held",
  limitedHelp: "Checked when a Job starts.",
  recordOnly: "Record only",
  recordOnlyHelp: "Saved before Job limits: nothing is held there.",
  unknownTime: "at a time it doesn't say",
  fromRegistry: (host: string | null) => (host ? `downloaded from ${host}` : "downloaded from its registry"),
  fromRelease: (release: string | null) => (release ? `copied from release ${release}` : "copied from another release"),
  fromCopy: "copied from another prepared copy",
  fromUnknown: "from a source its receipt doesn't name",
  copy: (version: string | null, source: string, at: string) => `${version ? `SDK ${version}, ` : ""}${source}, prepared ${at}`,
  notRead: "Not read",
  coreDidNotSay: (error: string) => `Core didn't say: ${error}`,
  unreadableForm: "Core answered in a form this page doesn't read.",
  coreRead: (at: string) => `Core read it ${at}.`,
  noRuntime: (checked: string) => `Core has no Claude runtime set up, so no SDK is known. ${checked}`,
  release: (release: string) => `release ${release}`,
  ownRuntime: "this Core's runtime (not an installed release's)",
  locked: (version: string) => `Locked ${version}`,
  lockedHelp: (runtime: string, registry: string | null, checked: string) =>
    `As claude-agent-sdk.json in ${runtime} locks it${registry ? `, from ${registry}` : ""}. ${checked}`,
  lockedNoVersion: "Locked, version not readable",
  lockedNoVersionHelp: (runtime: string, checked: string) => `claude-agent-sdk.json in ${runtime} names no version this page shows. ${checked}`,
  inRuntime: (version: string) => `${version} · in the runtime`,
  inRuntimeHelp: (runtime: string, checked: string) =>
    `The version the SDK package in ${runtime} declares: that runtime carries the SDK itself. ${checked}`,
  inRuntimeNoVersion: "In the runtime, version not declared",
  inRuntimeNoVersionHelp: (runtime: string, checked: string) => `The SDK package in ${runtime} doesn't declare a version. ${checked}`,
  noSdk: "Not in the runtime",
  noSdkHelp: (runtime: string, checked: string) => `Neither the SDK nor claude-agent-sdk.json is in ${runtime}. ${checked}`,
  unreadable: "Can't be read",
  unreadableHelp: (runtime: string, reason: string, checked: string) => `claude-agent-sdk.json in ${runtime}: ${reason}. ${checked}`,
  nothingToPrepare: "Nothing to prepare",
  nothingToPrepareHelp: "Core runs this runtime as it is, and it has no SDK for its Claude bridge.",
  notNeeded: "Not needed",
  notNeededHelp: "The runtime carries the SDK, so Core runs it as it is.",
  inUse: "In use",
  inUseHelp: (copy: string | null) =>
    `${copy ? `${copy}. ` : ""}Core prepared or found this copy in this run; its Claude bridges run from it.`,
  notUsedYet: "Not used yet in this run",
  notUsedYetHelp: (copies: number, newest: string, limited: boolean) =>
    `${copies === 1 ? "A copy" : `${copies} copies`} of this SDK on the Core host, the newest ${newest}. ` +
    "Core checks it when a Claude Agent first starts." +
    (limited ? " Only the first copies were looked at." : ""),
  notPrepared: "Not prepared",
  notPreparedHelp: (limited: boolean) =>
    "Core prepares a copy when a Claude Agent first starts: from another installed release, or by downloading the locked package. Reading this downloads nothing." +
    (limited ? " Only the first copies were looked at." : ""),
  unknownWhileUnreadable: "Not known while claude-agent-sdk.json can't be read.",
  notReported: "Not reported",
  developmentBuild: "A development build",
  developmentHelp: "Not installed as a release; updates don't apply to it.",
  notReady: "Not ready",
  notReadyParts: (api: boolean, storage: boolean) => `${[api && "API", storage && "storage"].filter(Boolean).join(" and ")} not ready`,
  ready: "Ready",
  readinessUnreported: "This Core doesn't report whether its API and storage are ready.",
  coreUnread: (error: string) => `Core could not be read: ${error}`,
  pageUnnamed: "This page doesn't say which release it is",
  coreReleaseUnknown: "Core's release isn't known to compare.",
  sameRelease: "The same release as Core.",
  otherRelease: (release: string) => `Core runs ${release}: reload this page to use it.`,
  notKnownHere: "Not known here",
  notDesktop: "This page isn't open in the desktop app, so it can't read the app's version.",
  installer: "Installed by the Yuzuno installer; it updates from the Desktop app card.",
  notInstaller: "Not installed by the Yuzuno installer, so it can't update itself.",
  desktopDidNotSay: (error: string) => `The desktop app didn't say: ${error}`,
  iphoneBuilt: "As this iPhone app reports it: the version it was built as.",
  notIphone: "This page isn't open in the iPhone app, or that app is older and doesn't report its version.",
  iphoneUnreadable: "The iPhone app's report of its version couldn't be read.",
  reached: "Reached",
  notReachedText: "Not reached",
  connected: "Connected",
  notConnected: "Not connected",
  windowsJobs: "Windows Jobs available",
  noWindowsJobs: "Windows Jobs not available",
}, {
  notCheckedHere: "未在此检查",
  sshModels: "SSH 机器的模型会在那里的 Agent 选择模型时列出。",
  notCheckedYet: "尚未检查",
  checkModelsHelp: "“检查模型”会像“新建 Agent”对话框那样，从 Core 主机的 CLI 列出它们。",
  checkedAt: (time) => `检查于 ${time}`,
  couldNotList: "无法列出模型",
  noModels: "没有列出模型",
  modelCount: (n) => `${n} 个模型`,
  defaultModel: (name) => `默认 ${name} · `,
  checkMachine: "请在“机器”页面检查这台机器。",
  notKnown: "未知",
  notReached: "上次检查没有连到这台机器。",
  notInCheck: "不在上次检查中",
  notLookedFor: "上次检查没有查找它。",
  unsupported: "此机器不支持",
  found: (version) => (version ? `已找到 · ${version}` : "已找到"),
  notUsable: (version) => (version ? `不可用 · ${version}` : "不可用"),
  notFound: "未找到",
  claudeNotReported:
    "上次检查没有报告它：那里的 `claude auth status` 没有回答、Claude Code 无法运行，或者这次检查早于 SSH 检查开始报告登录状态。登录问题会显示在 CLI 一行。",
  signInWhenRunnable: "只有 CLI 能运行时才会读取登录状态。",
  signInOnMachines: "登录状态会在“机器”页面随 CLI 一起检查。",
  signedIn: "已登录",
  signedOut: "已退出登录",
  notChecked: "无法检查",
  codexStateUnread: (error) => `无法读取 Core 的 Codex 状态：${error}`,
  codexNotConnected: "Codex 未在 Core 主机上连接。",
  noAccount: "未报告账户",
  noAccountHelp: "Codex 回答了，但没有说明账户。",
  codexSignInElsewhere: "机器检查不读取 Codex 的登录状态；Core 只知道它自己主机上的。",
  jobsHere: "托管 Job 在这里运行",
  notConfirmed: "无法确认",
  strict: "托管 · 强制限制",
  strictHelp: "机器能否承受会在 Job 启动时检查。",
  limited: "托管 · 无法强制的限制只做记录",
  limitedHelp: "在 Job 启动时检查。",
  recordOnly: "只做记录",
  recordOnlyHelp: "在有 Job 限制之前保存：那里不强制任何限制。",
  unknownTime: "未注明的时间",
  fromRegistry: (host) => (host ? `从 ${host} 下载` : "从其 registry 下载"),
  fromRelease: (release) => (release ? `从发布 ${release} 复制` : "从另一个发布复制"),
  fromCopy: "从另一份已准备的副本复制",
  fromUnknown: "来源未在其记录中注明",
  copy: (version, source, at) => `${version ? `SDK ${version}，` : ""}${source}，准备于 ${at}`,
  notRead: "未读取",
  coreDidNotSay: (error) => `Core 没有说明：${error}`,
  unreadableForm: "Core 回答的格式此页面无法读取。",
  coreRead: (at) => `Core 读取于 ${at}。`,
  noRuntime: (checked) => `Core 没有设置 Claude 运行环境，因此不知道 SDK。${checked}`,
  release: (release) => `发布 ${release}`,
  ownRuntime: "此 Core 的运行环境（不是已安装发布的）",
  locked: (version) => `已锁定 ${version}`,
  lockedHelp: (runtime, registry, checked) => `按${runtime} 中的 claude-agent-sdk.json 锁定${registry ? `，来自 ${registry}` : ""}。${checked}`,
  lockedNoVersion: "已锁定，版本无法读取",
  lockedNoVersionHelp: (runtime, checked) => `${runtime} 中的 claude-agent-sdk.json 没有写明此页面能显示的版本。${checked}`,
  inRuntime: (version) => `${version} · 在运行环境中`,
  inRuntimeHelp: (runtime, checked) => `${runtime} 中 SDK 包声明的版本：该运行环境自带 SDK。${checked}`,
  inRuntimeNoVersion: "在运行环境中，未声明版本",
  inRuntimeNoVersionHelp: (runtime, checked) => `${runtime} 中的 SDK 包没有声明版本。${checked}`,
  noSdk: "不在运行环境中",
  noSdkHelp: (runtime, checked) => `${runtime} 中既没有 SDK，也没有 claude-agent-sdk.json。${checked}`,
  unreadable: "无法读取",
  unreadableHelp: (runtime, reason, checked) => `${runtime} 中的 claude-agent-sdk.json：${reason}。${checked}`,
  nothingToPrepare: "无需准备",
  nothingToPrepareHelp: "Core 按原样运行此运行环境，它没有供 Claude bridge 使用的 SDK。",
  notNeeded: "不需要",
  notNeededHelp: "运行环境自带 SDK，因此 Core 按原样运行它。",
  inUse: "使用中",
  inUseHelp: (copy) => `${copy ? `${copy}。` : ""}Core 在本次运行中准备或找到了这份副本；它的 Claude bridge 从这里运行。`,
  notUsedYet: "本次运行尚未使用",
  notUsedYetHelp: (copies, newest, limited) =>
    `Core 主机上有${copies === 1 ? "一份" : ` ${copies} 份`}此 SDK 的副本，最新的一份：${newest}。Core 会在 Claude Agent 首次启动时检查它。` +
    (limited ? "只查看了前几份副本。" : ""),
  notPrepared: "未准备",
  notPreparedHelp: (limited) =>
    "Core 会在 Claude Agent 首次启动时准备一份副本：从另一个已安装的发布复制，或下载已锁定的包。读取这里不会下载任何内容。" +
    (limited ? "只查看了前几份副本。" : ""),
  unknownWhileUnreadable: "claude-agent-sdk.json 无法读取时未知。",
  notReported: "未报告",
  developmentBuild: "开发构建",
  developmentHelp: "不是作为发布安装的；更新不适用于它。",
  notReady: "未就绪",
  notReadyParts: (api, storage) => `${[api && "API", storage && "存储"].filter(Boolean).join("和")}未就绪`,
  ready: "已就绪",
  readinessUnreported: "此 Core 不报告其 API 和存储是否就绪。",
  coreUnread: (error) => `无法读取 Core：${error}`,
  pageUnnamed: "此页面没有说明它是哪个发布",
  coreReleaseUnknown: "不知道 Core 的发布，无法比较。",
  sameRelease: "与 Core 是同一个发布。",
  otherRelease: (release) => `Core 运行的是 ${release}：重新加载此页面即可使用它。`,
  notKnownHere: "此处未知",
  notDesktop: "此页面不是在桌面应用中打开的，因此无法读取应用的版本。",
  installer: "由 Yuzuno 安装程序安装；它从“桌面应用”卡片更新。",
  notInstaller: "不是由 Yuzuno 安装程序安装的，因此无法自行更新。",
  desktopDidNotSay: (error) => `桌面应用没有说明：${error}`,
  iphoneBuilt: "由此 iPhone 应用报告：它构建时的版本。",
  notIphone: "此页面不是在 iPhone 应用中打开的，或该应用较旧，不会报告它的版本。",
  iphoneUnreadable: "无法读取 iPhone 应用报告的版本。",
  reached: "已连到",
  notReachedText: "未连到",
  connected: "已连接",
  notConnected: "未连接",
  windowsJobs: "Windows Job 可用",
  noWindowsJobs: "Windows Job 不可用",
});
type Words = ReturnType<typeof words>;

function modelsFact(machine: WorkspaceMachine, check: ModelCheck | undefined, w: Words): Fact {
  if (machine.kind !== "local") return fact("unknown", w.notCheckedHere, w.sshModels);
  if (!check) return fact("unknown", w.notCheckedYet, w.checkModelsHelp);
  const when = w.checkedAt(new Date(check.at).toLocaleTimeString());
  if (!check.ok) return fact("no", w.couldNotList, `${check.error} · ${when}`);
  if (!check.count) return fact("no", w.noModels, when);
  return fact("yes", w.modelCount(check.count), `${check.defaultName ? w.defaultModel(check.defaultName) : ""}${when}`);
}
function cliFact(check: HarnessCheck | undefined, machineCheck: MachineCheck | null | undefined, w: Words): Fact {
  if (!machineCheck) return fact("unknown", w.notCheckedYet, w.checkMachine);
  // A check that didn't reach the machine says nothing about its CLIs, even
  // where Core keeps a placeholder entry for one.
  if (!machineCheck.reachable) return fact("unknown", w.notKnown, w.notReached);
  if (!check) return fact("unknown", w.notInCheck, w.notLookedFor);
  if (!check.supported) return fact("no", w.unsupported, check.error);
  const found = w.found(check.version);
  if (check.found) return fact("yes", found, check.executable);
  // Core counts a signed-out CLI as not usable; its sign-in says why, so the
  // CLI itself is found.
  if (check.signIn?.state === "signedOut") return fact("yes", found, check.executable);
  // Found where it looked, but Core can't use it: its own reason.
  if (check.executable) return fact("no", w.notUsable(check.version), check.error);
  return fact("no", w.notFound, check.error);
}

function signInFact(
  harness: string,
  check: HarnessCheck | undefined,
  machine: WorkspaceMachine,
  runtime: RuntimeRead["runtime"],
  w: Words,
): Fact {
  if (harness === "claude") {
    const signIn = check?.signIn;
    if (!signIn) {
      if (machine.kind !== "local") {
        if (!machine.lastCheck) return fact("unknown", w.notCheckedYet, w.checkMachine);
        if (!machine.lastCheck.reachable) return fact("unknown", w.notKnown, w.notReached);
        return fact("unknown", w.notKnown, w.claudeNotReported);
      }
      return machine.lastCheck
        ? fact("unknown", w.notKnown, w.signInWhenRunnable)
        : fact("unknown", w.notKnown, w.signInOnMachines);
    }
    if (signIn.state === "signedIn") return fact("yes", w.signedIn, signIn.method);
    if (signIn.state === "signedOut") return fact("no", w.signedOut, check?.error ?? signIn.detail);
    return fact("unknown", w.notChecked, signIn.detail);
  }
  if (harness === "codex" && machine.kind === "local") {
    if (!runtime.ok) return fact("unknown", w.notKnown, w.codexStateUnread(runtime.error));
    if (!runtime.value.connected) return fact("unknown", w.notKnown, w.codexNotConnected);
    return runtime.value.account
      ? fact("yes", w.signedIn, runtime.value.account)
      : fact("unknown", w.noAccount, w.noAccountHelp);
  }
  return fact("unknown", w.notKnown, w.codexSignInElsewhere);
}

function jobsFact(machine: WorkspaceMachine, budget: RuntimeRead["budget"], w: Words): Fact {
  if (machine.kind === "local") {
    if (budget.ok) return fact("yes", w.jobsHere, budget.value.machine.scope);
    // Core names no kind for a host that can't run them: its reason is shown, not guessed at.
    return fact("unknown", w.notConfirmed, budget.error);
  }
  if (machine.limitMode === "strict") return fact("yes", w.strict, w.strictHelp);
  if (machine.limitMode === "limited") return fact("yes", w.limited, w.limitedHelp);
  return fact("yes", w.recordOnly, w.recordOnlyHelp);
}

const whenText = (iso: string | null, w: Words) => {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleString() : w.unknownTime;
};
function sourceText(source: SdkSource, w: Words) {
  if (source.from === "registry") return w.fromRegistry(source.host);
  if (source.from === "release") return w.fromRelease(source.release);
  if (source.from === "preparedCopy") return w.fromCopy;
  return w.fromUnknown;
}
const copyText = (copy: SdkCopy, w: Words) => w.copy(copy.version, sourceText(copy.source, w), whenText(copy.at, w));

/** The SDK Core's Claude bridge runs (T-191): the version its runtime locks
 * or declares, and the copy it runs from. The bridge has no version of its
 * own, and Claude Code's CLI is another program (under Machines). */
function sdkFacts(read: RuntimeRead["sdk"], w: Words): { sdk: Fact; sdkCopy: Fact } {
  if (!read) return { sdk: fact("unknown", w.notRead), sdkCopy: fact("unknown", w.notRead) };
  if (!read.ok) return { sdk: fact("unknown", w.notKnown, w.coreDidNotSay(read.error)), sdkCopy: fact("unknown", w.notKnown) };
  const status = read.value;
  if (status.format !== 1) return { sdk: fact("unknown", w.notKnown, w.unreadableForm), sdkCopy: fact("unknown", w.notKnown) };
  const checked = w.coreRead(whenText(status.readAt, w));
  if (status.runtime.kind === "missing")
    return { sdk: fact("unknown", w.notKnown, w.noRuntime(checked)), sdkCopy: fact("unknown", w.notKnown) };
  const runtime = status.runtime.kind === "release" && status.runtime.release ? w.release(status.runtime.release) : w.ownRuntime;
  const sdk = status.sdk;
  const sdkFact =
    sdk.state === "locked"
      ? sdk.version
        ? fact("yes", w.locked(sdk.version), w.lockedHelp(runtime, sdk.registry, checked))
        : fact("unknown", w.lockedNoVersion, w.lockedNoVersionHelp(runtime, checked))
      : sdk.state === "inRuntime"
        ? sdk.version
          ? fact("yes", w.inRuntime(sdk.version), w.inRuntimeHelp(runtime, checked))
          : fact("unknown", w.inRuntimeNoVersion, w.inRuntimeNoVersionHelp(runtime, checked))
        : sdk.state === "none"
          ? fact("no", w.noSdk, w.noSdkHelp(runtime, checked))
          : sdk.state === "unreadable"
            ? fact("unknown", w.unreadable, w.unreadableHelp(runtime, sdk.reason, checked))
            : fact("unknown", w.notKnown, checked);
  const copy = status.copy;
  const sdkCopy =
    copy.state === "notNeeded"
      ? sdk.state === "none"
        ? fact("no", w.nothingToPrepare, w.nothingToPrepareHelp)
        : fact("yes", w.notNeeded, w.notNeededHelp)
      : copy.state === "inUse"
        ? fact("yes", w.inUse, w.inUseHelp(copy.copy ? copyText(copy.copy, w) : null))
        : copy.state === "found"
          ? fact("unknown", w.notUsedYet, w.notUsedYetHelp(copy.copies, copyText(copy.newest, w), copy.limited))
          : copy.state === "none"
            ? fact("no", w.notPrepared, w.notPreparedHelp(copy.limited))
            : fact("unknown", w.notKnown, sdk.state === "unreadable" ? w.unknownWhileUnreadable : undefined);
  return { sdk: sdkFact, sdkCopy };
}

/** The facts to show, from one read, at `now`, in `language` (English unless
 * a page passes its own). */
export function runtimeView(read: RuntimeRead, now = Date.now(), models: ModelChecks = {}, language: Language = "en"): RuntimeView {
  const w = words(language);
  const health = read.health;
  const core = health.ok
    ? {
        version: health.value.version ? fact("yes", health.value.version) : fact("unknown", w.notReported),
        release:
          !health.value.releaseId
            ? fact("unknown", w.notReported)
            : health.value.releaseId === "development"
              ? fact("no", w.developmentBuild, w.developmentHelp)
              : fact("yes", health.value.releaseId),
        // A Core without its update manager reports neither: not known, not
        // "not ready" (it answered).
        ready:
          health.value.apiReady === false || health.value.storageReady === false
            ? fact("no", w.notReady, w.notReadyParts(health.value.apiReady === false, health.value.storageReady === false))
            : health.value.apiReady && health.value.storageReady
              ? fact("yes", w.ready)
              : fact("unknown", w.notReported, w.readinessUnreported),
      }
    : {
        version: fact("unknown", w.notKnown, w.coreUnread(health.error)),
        release: fact("unknown", w.notKnown),
        ready: fact("unknown", w.notKnown),
      };
  const sdk = sdkFacts(read.sdk, w);
  const page =
    !read.page
      ? fact("unknown", w.pageUnnamed)
      : !health.ok || !health.value.releaseId
        ? fact("unknown", read.page, w.coreReleaseUnknown)
        : read.page === health.value.releaseId
          ? fact("yes", read.page, w.sameRelease)
          : fact("no", read.page, w.otherRelease(health.value.releaseId));
  const desktop =
    read.desktop === null
      ? fact("unknown", w.notKnownHere, w.notDesktop)
      : read.desktop.ok
        ? fact(
            "yes",
            read.desktop.value.version,
            // As the Desktop app card says it: why it can't update comes first.
            read.desktop.value.unavailable ?? (read.desktop.value.channel === "installer" ? w.installer : w.notInstaller),
          )
        : fact("unknown", w.notKnown, w.desktopDidNotSay(read.desktop.error));
  const iphone =
    !read.iphone
      ? fact("unknown", w.notKnownHere, w.notIphone)
      : read.iphone.ok
        ? fact("yes", read.iphone.version, w.iphoneBuilt)
        : fact("unknown", w.notKnown, w.iphoneUnreadable);

  const machines = read.machines.ok
    ? read.machines.value.map((machine): MachineFacts => {
        const check = machine.lastCheck ?? null;
        const age = check ? checkAge(check, now, language) : null;
        const reachable = !check
          ? fact("unknown", w.notCheckedYet, w.checkMachine)
          : check.reachable
            ? fact("yes", w.reached)
            : fact("no", w.notReachedText, check.error);
        const harnesses = HARNESSES.map((harness) => {
          const harnessCheck = check?.harnesses.find((h) => h.harness === harness);
          return {
            harness,
            name: harnessName(harness),
            cli: cliFact(harnessCheck, check, w),
            signedIn: signInFact(harness, harnessCheck, machine, read.runtime, w),
            models: modelsFact(machine, models[harness], w),
          };
        });
        const codexConnection =
          machine.kind !== "local"
            ? undefined
            : !read.runtime.ok
              ? fact("unknown", w.notKnown, read.runtime.error)
              : read.runtime.value.connected
                ? fact("yes", w.connected)
                : fact("no", w.notConnected, read.runtime.value.error);
        const windows =
          machine.kind === "local" && read.budget.ok && read.budget.value.windows
            ? read.budget.value.windows.available
              ? fact("yes", w.windowsJobs)
              : fact("no", w.noWindowsJobs, read.budget.value.windows.reason ?? undefined)
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
          jobs: jobsFact(machine, read.budget, w),
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
