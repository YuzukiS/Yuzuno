import type { ClaudeRuntime } from "./types";

const standing: Record<string, [string, string]> = {
  "built-in": ["SDK's own version", "The version this Agent SDK ships with."],
  verified: ["checked with this SDK", "Yuzuno has run this version with this Agent SDK: start, resume, Workspace tools, approvals and reviews."],
  older: ["older than checked", "Older than every version checked with this Agent SDK. Sessions still start; a feature this version lacks fails with Claude Code's own error. Yuzuno never installs or updates Claude Code."],
  unverified: ["not checked with this SDK", "Not checked with this Agent SDK. Sessions still start; a feature this version lacks fails with Claude Code's own error. Yuzuno never installs or updates Claude Code."],
  unknown: ["version unknown", "Claude Code reported no version at startup, and claude --version printed none."],
};

/** The Claude Code row: version and standing, with where it came from. */
export function claudeCodeFacts(runtime?: ClaudeRuntime | null): { text: string; title: string } | null {
  const facts = runtime?.provenance;
  const cli = facts?.cli;
  const version = cli?.version || runtime?.version;
  if (!facts && !version) return null;
  // A Core or bridge from before provenance reports only the version.
  if (!facts) return { text: version!, title: "Reported by Claude Code when the session started." };
  // The standing was worked out from the version known at startup. One that
  // Claude Code reported only later (its system/init) has none.
  const [label, meaning] = cli?.version ? standing[facts.compatibility || ""] || ["", ""]
    : version ? ["", "Claude Code reported this version after startup, so its standing with this Agent SDK was not worked out."]
    : standing.unknown;
  const sdk = facts.sdk;
  return {
    text: version ? [version, label].filter(Boolean).join(" · ") : "Version unknown",
    title: [
      cli?.path && `Runs ${cli.path}`,
      cli?.source === "path" ? cli.found && `Found on PATH as ${cli.found}` : cli?.source === "explicit" ? "Chosen explicitly, not from PATH" : "",
      cli?.versionSource === "init" ? "Version reported by Claude Code when it started." : cli?.versionSource === "--version" ? "Version printed by claude --version." : "",
      sdk?.version && `Agent SDK ${sdk.version}${sdk.builtInCli ? `, built with Claude Code ${sdk.builtInCli}` : ""}. Yuzuno runs the installed Claude Code, not the SDK's built-in copy.`,
      meaning,
    ].filter(Boolean).join("\n"),
  };
}
