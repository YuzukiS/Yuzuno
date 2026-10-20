import test from "node:test";
import assert from "node:assert/strict";
import { claudeCodeFacts } from "../src/claude-runtime.ts";

const sdk = { version: "0.3.296", builtInCli: "2.1.296" };
const cli = { path: "/home/u/.local/lib/claude.exe", found: "/home/u/.local/bin/claude", source: "path", version: "2.1.280", versionSource: "init" };

test("the row names the version and its standing; the title says where each fact came from", () => {
  const facts = claudeCodeFacts({ version: "2.1.280", provenance: { cli, sdk, compatibility: "verified" } });
  assert.equal(facts.text, "2.1.280 · checked with this SDK");
  assert.deepEqual(facts.title.split("\n"), [
    "Runs /home/u/.local/lib/claude.exe",
    "Found on PATH as /home/u/.local/bin/claude",
    "Version reported by Claude Code when it started.",
    "Agent SDK 0.3.296, built with Claude Code 2.1.296. Yuzuno runs the installed Claude Code, not the SDK's built-in copy.",
    "Yuzuno has run this version with this Agent SDK: start, resume, Workspace tools, approvals and reviews.",
  ]);
});

test("older, unchecked and unknown versions say so without claiming more", () => {
  const older = claudeCodeFacts({ provenance: { cli: { ...cli, version: "2.0.5", versionSource: "--version" }, sdk, compatibility: "older" } });
  assert.equal(older.text, "2.0.5 · older than checked");
  assert.match(older.title, /Version printed by claude --version\./);
  assert.match(older.title, /Sessions still start/);
  assert.match(older.title, /never installs or updates Claude Code/);
  assert.equal(claudeCodeFacts({ provenance: { cli: { ...cli, version: "2.1.290" }, sdk, compatibility: "unverified" } }).text,
    "2.1.290 · not checked with this SDK");
  assert.equal(claudeCodeFacts({ provenance: { cli: { ...cli, version: "2.1.296" }, sdk, compatibility: "built-in" } }).text,
    "2.1.296 · SDK's own version");
  const unknown = claudeCodeFacts({ provenance: { cli: { path: "/x/claude", source: "explicit" }, sdk, compatibility: "unknown" } });
  assert.equal(unknown.text, "Version unknown");
  assert.match(unknown.title, /reported no version at startup/);
  assert.match(unknown.title, /Chosen explicitly, not from PATH/);
  // Unknown at startup, then reported by the turn's system/init: the version
  // shows without a standing it was never checked for (review 426831fd).
  const later = claudeCodeFacts({ version: "2.1.280", provenance: { cli: { path: "/x/claude", source: "path", found: "/x/claude" }, sdk, compatibility: "unknown" } });
  assert.equal(later.text, "2.1.280");
  assert.match(later.title, /reported this version after startup/);
  assert.doesNotMatch(later.title, /reported no version|version unknown/);
});

test("a session from an older Core shows only its reported version, and nothing reported shows no row", () => {
  assert.deepEqual(claudeCodeFacts({ version: "2.1.280" }), { text: "2.1.280", title: "Reported by Claude Code when the session started." });
  assert.equal(claudeCodeFacts({ account: { email: "a@b.c" } }), null);
  assert.equal(claudeCodeFacts(null), null);
});
