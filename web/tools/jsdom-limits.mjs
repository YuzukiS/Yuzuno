// When a jsdom test may run here (T-29): pure decisions, no side effects,
// so tests can check them with fixtures. jsdom-guard.mjs applies them.
//
// Why: a failing strict assertion on a live DOM node makes Node inspect it
// (depth 1000, getters on) and, through React's fiber properties on every
// node, the whole app; the output grows without practical bound. Once that
// took a shared host down. So a jsdom test runs only where its memory is
// bounded: under a confirmed cgroup v2 limit of at most 4096 MiB with no
// swap, or on a GitHub-hosted runner, a disposable VM. Nothing here turns
// the check off.
import { readFileSync } from "node:fs";

/** The most a local jsdom test may have: 4096 MiB, no swap. */
export const MAX_MEMORY_BYTES = 4096 * 1024 * 1024;

const value = (text) => (text === "max" ? Infinity : /^\d+$/.test(text) ? Number(text) : NaN);

/**
 * The tightest memory.max and memory.swap.max on this process's cgroup v2
 * path, from its own level up to the root, or why they could not be read.
 * `read(path)` returns a file's text or throws; a level without a file
 * (the root has none) limits nothing.
 */
export function cgroupLimits(read = (path) => readFileSync(path, "utf8")) {
  let membership;
  try {
    membership = read("/proc/self/cgroup");
  } catch (error) {
    return { error: `cannot read /proc/self/cgroup (${error.code || error.message})` };
  }
  const entry = membership.split("\n").find((line) => line.startsWith("0::"));
  if (!entry || membership.split("\n").filter(Boolean).length !== 1)
    return { error: "this process is not in a cgroup v2 hierarchy alone" };
  let path = entry.slice(3).trim();
  if (!path.startsWith("/")) return { error: `unexpected cgroup path ${JSON.stringify(path)}` };
  const limits = { memory: Infinity, swap: Infinity };
  for (;;) {
    const dir = path === "/" ? "/sys/fs/cgroup" : `/sys/fs/cgroup${path}`;
    for (const [file, key] of [["memory.max", "memory"], ["memory.swap.max", "swap"]]) {
      let text;
      try {
        text = read(`${dir}/${file}`).trim();
      } catch {
        continue;
      }
      const limit = value(text);
      if (Number.isNaN(limit)) return { error: `unreadable ${dir}/${file}: ${JSON.stringify(text)}` };
      limits[key] = Math.min(limits[key], limit);
    }
    if (path === "/") break;
    path = path.slice(0, path.lastIndexOf("/")) || "/";
  }
  return limits;
}

const mib = (bytes) => (bytes === Infinity ? "unlimited" : `${Math.round(bytes / 1048576)} MiB`);

/**
 * Whether a jsdom test may run, and why. `limits` is cgroupLimits() on
 * Linux, unused elsewhere. GitHub's own runner variables are how this
 * project's CI is recognised; they are its convention, not proof.
 */
export function verdict({ platform, env, limits }) {
  if (env.GITHUB_ACTIONS === "true" && env.RUNNER_ENVIRONMENT === "github-hosted")
    return { ok: true, why: "a GitHub-hosted runner; its VM bounds memory" };
  const where = "Run them in a Linux Job limited to at most 4096 MiB with no swap, or let GitHub CI run them.";
  if (platform !== "linux")
    return { ok: false, why: `${platform} has no cgroup v2 memory limit to confirm. ${where}` };
  if (!limits || limits.error) return { ok: false, why: `${limits?.error || "no limits read"}. ${where}` };
  if (!(limits.memory <= MAX_MEMORY_BYTES))
    return { ok: false, why: `memory is limited to ${mib(limits.memory)}, not at most 4096 MiB. ${where}` };
  if (limits.swap !== 0) return { ok: false, why: `swap is ${mib(limits.swap)}, not 0. ${where}` };
  return { ok: true, why: `a cgroup limit of ${mib(limits.memory)} with no swap` };
}
