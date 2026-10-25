import { post } from "./api";
import { strings, type Language } from "./i18n";

/** Whether a Harness CLI answered `--version`, and for Claude Code what its
 * sign-in check said (`signIn`). */
export interface HarnessCheck {
  harness: "codex" | "claude" | string;
  supported: boolean;
  found: boolean;
  executable?: string;
  version?: string;
  error?: string;
  /** Claude Code: what its `claude auth status` said, on the Core host as Core
   * runs it, on an SSH machine as SSH runs it there. A clear signed-out answer
   * also makes it unavailable, with `error` saying where to sign in; unknown
   * leaves it found and keeps the reason here. Absent where it wasn't asked or
   * didn't say. */
  signIn?: { state: "signedIn" | "signedOut" | "unknown"; method?: string; folder?: string; detail?: string };
}

// A check's harness words, in the interface language where a page passes it
// (T-189). Harness names, versions, methods and Core's reasons stay as written.
const harnessWords = strings({
  signedIn: (method?: string) => `The CLI answered --version and reports it is signed in${method ? ` (${method})` : ""}.`,
  signInUnknown: (detail?: string) => `The CLI answered --version. Whether it is signed in could not be checked: ${detail ?? "no reason given"}`,
  signInUnchecked: "The CLI answered --version. Sign-in is not checked.",
  coreHostOnly: (name: string) => `${name} · Core host only`,
  found: (name: string, version?: string) => `${name} found${version ? ` · ${version}` : ""}`,
  unavailable: (name: string) => `${name} unavailable`,
}, {
  signedIn: (method) => `CLI 响应了 --version，并报告已登录${method ? `（${method}）` : ""}。`,
  signInUnknown: (detail) => `CLI 响应了 --version。无法检查是否已登录：${detail ?? "未说明原因"}`,
  signInUnchecked: "CLI 响应了 --version。未检查登录状态。",
  coreHostOnly: (name) => `${name} · 仅限 Core 主机`,
  found: (name, version) => `已找到 ${name}${version ? ` · ${version}` : ""}`,
  unavailable: (name) => `${name} 不可用`,
});

/** The found chip's tip: what was checked, sign-in included where it was. */
export function harnessTip(check: HarnessCheck, language: Language = "en") {
  const t = harnessWords(language);
  if (check.signIn?.state === "signedIn") return t.signedIn(check.signIn.method);
  if (check.signIn?.state === "unknown") return t.signInUnknown(check.signIn.detail);
  return t.signInUnchecked;
}
/** What Core could reach and run at one moment. Never a live status. */
export interface MachineCheck {
  machineId: string;
  startedAt: string;
  checkedAt: string;
  durationMs: number;
  reachable: boolean;
  error?: string;
  host?: { hostname: string; platform: string; home: string };
  harnesses: HarnessCheck[];
  defaultFolder?: { path: string; resolved?: string; error?: string };
}

/** Older results are labelled; age alone never means a machine is offline. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

export function runMachineCheck(machineId: string) {
  return post<MachineCheck>(`/machines/${encodeURIComponent(machineId)}/check`);
}

// How long ago, in the interface language where a page passes it (T-189).
const ages = strings({
  unknown: "at an unknown time",
  justNow: "just now",
  minutes: (n: number) => `${n} min ago`,
  hours: (n: number) => `${n} h ago`,
  days: (n: number) => `${n} d ago`,
}, {
  unknown: "时间未知",
  justNow: "刚刚",
  minutes: (n) => `${n} 分钟前`,
  hours: (n) => `${n} 小时前`,
  days: (n) => `${n} 天前`,
});

export function checkAge(check: MachineCheck, now = Date.now(), language: Language = "en") {
  const t = ages(language);
  const at = Date.parse(check.checkedAt);
  if (Number.isNaN(at)) return { label: t.unknown, stale: true };
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const label =
    seconds < 45
      ? t.justNow
      : seconds < 3600
        ? t.minutes(Math.max(1, Math.round(seconds / 60)))
        : seconds < 86400
          ? t.hours(Math.round(seconds / 3600))
          : t.days(Math.round(seconds / 86400));
  return { label, stale: now - at > STALE_AFTER_MS };
}

export const harnessName = (harness: string) =>
  harness === "claude"
    ? "Claude Code"
    : harness === "codex"
      ? "Codex"
      : harness === "opencode"
        ? "OpenCode"
        : harness;

/** The harness an Agent runs; Agents from before harnesses were named ran Codex. */
export const agentHarnessName = (agent: { harness?: string }) => harnessName(agent.harness || "codex");

/** The native session an Agent continues, once its harness has one. */
export const nativeSession = (agent: { harness?: string; claudeSessionId?: string; opencodeSessionId?: string; threadId?: string }) =>
  agent.harness === "claude" ? agent.claudeSessionId : agent.harness === "opencode" ? agent.opencodeSessionId : agent.threadId;

export function harnessLabel(check: HarnessCheck, language: Language = "en") {
  const t = harnessWords(language);
  const name = harnessName(check.harness);
  if (!check.supported) return t.coreHostOnly(name);
  if (check.found) return t.found(name, check.version);
  // Missing, failing and timing out all mean it cannot be used; the reason
  // is shown beside it.
  return t.unavailable(name);
}
