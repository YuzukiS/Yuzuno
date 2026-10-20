# Public examples and historical evidence

The public copy of this repository uses generic account names, documentation
addresses and illustrative paths in acceptance notes, saved reports and UI
fixtures. They do not identify the machines used in the original runs. Historical
pass/fail results remain observations of those original runs; replacing an
address does not mean the example endpoint was tested.

Acceptance scripts derive local home paths at runtime. Remote experiments need
an explicitly authorized target and installation paths appropriate to that
machine; example addresses are not live test hosts. Native scripts can send paid
model requests or create isolated processes, so a syntax check is not a reason to
run their live paths.

The remote acceptance scripts use `YUZUNO_SSH_TARGET` and `YUZUNO_REMOTE_CODEX`.
The machine-check lab accepts `YUZUNO_REMOTE_CWD`; the credential lab uses it as
the parent for a fresh isolated directory (default `/tmp`). The multi-agent recovery
check requires `YUZUNO_REMOTE_HOME` to verify the authorized user's runtime namespace
before process control. The standalone remote runtime
probe requires `--target`. Select the existing Windows Claude executable with
`YUZUNO_WINDOWS_CLAUDE`, or let Windows resolve `claude.cmd` from its own PATH.

Private raw logs, databases, source excerpts and audit inventories stay outside
tracked source. Research scenarios in the Catch-up write-up are labelled synthetic;
the original unrelated project metrics are not published. Git author attribution,
third-party copyright notices and generic test addresses are preserved.

This cleanup changes the current tree only. The public repository starts from a
snapshot of it without history; the private repository's commits, tags, branch and
PR refs, cached diffs, Actions logs/artifacts and release files can still contain the
original values and stay private. See [the public-readiness checklist](public-readiness.md).

The Linux release-input builder remaps source, Cargo-cache and target paths in
Rust binaries to generic build paths. It enables `bundled-release`, which removes
compile-time checkout fallbacks for the Claude bridge and result validator.
Installed bundles supply their verified runtime paths; development builds keep
their source-tree fallback. The builder also checks every staged file for its
actual home, checkout, Cargo-cache and target paths before creating the archive.
This does not sanitize old binaries, logs,
source maps or arbitrary text assets; inspect the exact new release files before
publishing them.
