# T-87: which Claude Code and Agent SDK a session runs

`lab.py` checks, through an isolated lab Core built from this worktree (port
4471, its own data directory), that sessions report the Claude Code and Agent
SDK they run: `claudeRuntime.provenance` and review records' `provenance`
(see `runtimes/claude/README.md`, "Claude Code versions"). It uses the real
installed Claude Code with the user's own login and configuration, unchanged,
and Claude Haiku. It never installs a CLI, and never touches the daily Core,
its data or processes.

The steps, in order:

1. **Default `PATH`.** A new Agent reports:
   - the CLI's real path and the `PATH` entry that matched;
   - version 2.1.280 from `--version` (this CLI leaves it out of the SDK's
     initialization result; the first turn's `system/init` reports the same);
   - SDK 0.3.296 with its built-in 2.1.296;
   - `verified`.

   A turn calls a Workspace MCP tool. A file write is approved through Yuzuno.
2. **A custom executable first on `PATH`** (a symlink in a lab directory), after
   a restart. Reconnecting reports that entry, and the same session answers.
3. **A fake old CLI (2.0.5), then one whose version can't be read.**
   Reconnecting fails, and the error names the CLI, its version or "version
   unknown", and the SDK.
4. **Back on the default `PATH`.** The same facts as step 1, and the same
   session.
5. **The packaged runtime layout.** `runtimes/claude` is installed with the
   flags `tools/build-core-artifact.py` uses, and its bridge serves the Agent.
   The facts are the same.
6. **A Haiku review of the PR.** It records the same provenance, with the
   version from `--version`, and the CLI version Claude Code reported at init.

`target/t87/lab-check.sh` (local, not in Git) builds the lab binary, checking
that it was compiled from this worktree. It installs the packaged layout and
runs `lab.py <binary> <out> <packaged bridge.mjs> <PR url> <head sha>`. Its
output directory holds `report.json`, `snapshots/`, `source.txt` and the logs.

Not covered:

- Claude Agents run only on the Core machine.
- No session was run on 2.1.296. It would need the user's login and
  configuration; its version and MCP limits were only read (static check, see
  the PR).
- macOS and native Windows packaged Cores.
