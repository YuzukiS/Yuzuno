import { post } from "./api";

/** Whether a Harness CLI answered `--version`, and for Claude Code on the
 * Core host what its sign-in check said (`signIn`). */
export interface HarnessCheck {
  harness: "codex" | "claude" | string;
  supported: boolean;
  found: boolean;
  executable?: string;
  version?: string;
  error?: string;
  /** Claude Code on the Core host: what its `claude auth status` said. A
   * clear signed-out answer also makes it unavailable, with `error` saying
   * where to sign in; unknown leaves it found and keeps the reason here. */
  signIn?: { state: "signedIn" | "signedOut" | "unknown"; method?: string; folder?: string; detail?: string };
}

/** The found chip's tip: what was checked, sign-in included where it was. */
export function harnessTip(check: HarnessCheck) {
  if (check.signIn?.state === "signedIn")
    return `The CLI answered --version and reports it is signed in${check.signIn.method ? ` (${check.signIn.method})` : ""}.`;
  if (check.signIn?.state === "unknown")
    return `The CLI answered --version. Whether it is signed in could not be checked: ${check.signIn.detail ?? "no reason given"}`;
  return "The CLI answered --version. Sign-in is not checked.";
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

export function checkAge(check: MachineCheck, now = Date.now()) {
  const at = Date.parse(check.checkedAt);
  if (Number.isNaN(at)) return { label: "at an unknown time", stale: true };
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const label =
    seconds < 45
      ? "just now"
      : seconds < 3600
        ? `${Math.max(1, Math.round(seconds / 60))} min ago`
        : seconds < 86400
          ? `${Math.round(seconds / 3600)} h ago`
          : `${Math.round(seconds / 86400)} d ago`;
  return { label, stale: now - at > STALE_AFTER_MS };
}

export const harnessName = (harness: string) =>
  harness === "claude"
    ? "Claude Code"
    : harness === "codex"
      ? "Codex"
      : harness;

export function harnessLabel(check: HarnessCheck) {
  const name = harnessName(check.harness);
  if (!check.supported) return `${name} · Core host only`;
  if (check.found)
    return `${name} found${check.version ? ` · ${check.version}` : ""}`;
  // Missing, failing and timing out all mean it cannot be used; the reason
  // is shown beside it.
  return `${name} unavailable`;
}
