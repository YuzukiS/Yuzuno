# Claude account management: reuse claude-swap

Assessed 2026-10-12. The user requested claude-swap as the account manager.
**Reuse its account management and profile lifecycle; keep Yuzuno's integration
small.** Account metadata can use its existing CLI JSON interface. Launching
account-bound Agent SDK sessions needs a short compatibility experiment first.
No account integration has been implemented or verified with real accounts yet.

## Inspected upstream

- Canonical project: [realiti4/claude-swap](https://github.com/realiti4/claude-swap).
- Exact inspected main revision:
  [`3a4e5c14873eb5b32f182d55c68da98ac8c0db45`](https://github.com/realiti4/claude-swap/commit/3a4e5c14873eb5b32f182d55c68da98ac8c0db45),
  committed **2026-09-28**. GitHub repository metadata reported a later push on
  **2026-10-05**; a push date is not this commit's date.
- Latest published package checked: [claude-swap 0.26.0](https://pypi.org/project/claude-swap/0.26.0/),
  uploaded **2026-09-02 18:29:37 UTC**, Python **3.12+**, MIT.
  Published wheel source was also inspected in memory; do not assume every
  subsequent main-branch fix is included in that release.
- [License](https://github.com/realiti4/claude-swap/blob/3a4e5c14873eb5b32f182d55c68da98ac8c0db45/LICENSE)
  and recent published/source activity support treating it as an actively
  maintained dependency. Its session launcher nevertheless calls itself
  experimental; maintenance is not evidence of complete SDK compatibility.

The current WSL `PATH` did not contain `cswap`. Searches in the earlier project and
this repository found no prior claude-swap integration notes. This does not establish
whether it is installed in Windows, another shell environment, or another host.
This assessment did not install or execute claude-swap, switch accounts, read
credential files, or inspect token values.

## What can be reused

| Upstream interface | Intended use |
| --- | --- |
| `cswap list --json` | Account labels, organization, alias, usage and current-account marker. |
| `cswap status --json` | Current native login and its managed-account status. |
| `cswap run ACCOUNT --require-session -- CLAUDE_ARGS…` | Launch an explicitly selected account through an isolated native profile, when supported. |
| `cswap switch ACCOUNT` | A machine's shared default-login change; **not** an Agent-local selection. |

The [documented JSON contract](https://github.com/realiti4/claude-swap/blob/3a4e5c14873eb5b32f182d55c68da98ac8c0db45/README.md#json-output-for-scripting)
has `schemaVersion: 1`, structured errors with nonzero exit codes, and additive
fields. The [JSON projection](https://github.com/realiti4/claude-swap/blob/3a4e5c14873eb5b32f182d55c68da98ac8c0db45/src/claude_swap/json_output.py)
returns account metadata and usage, not raw credentials. Ignore unknown additive
fields and preserve unknown/stale usage rather than rendering it as zero.

`list`/`status` are not guaranteed to be strictly side-effect-free: their usage
collection can access the network, update caches, and invoke upstream credential
maintenance. Yuzuno should let claude-swap own those mechanisms instead of reading
its backing files or recreating token refresh. Inventory is refreshed through
the CLI at a modest cadence, not on every UI render.

Bind an Agent to a machine plus `(email, organizationUuid)` and resolve the
current slot before launch. A slot number or alias alone is mutable. Keep the
native Claude session ID separate from both account identity and Yuzuno Agent ID.

## Concurrent sessions and the default-login exception

The [session implementation](https://github.com/realiti4/claude-swap/blob/3a4e5c14873eb5b32f182d55c68da98ac8c0db45/src/claude_swap/session.py)
creates persistent per-account profiles beneath its backup directory and exports
`CLAUDE_CONFIG_DIR` for the launched native Claude. It owns profile bootstrap,
refresh-token bookkeeping, sharing and concurrency protections. The published
0.26.0 source already includes session mode and `--require-session`.

For an account that is already the default native login, ordinary `run` launches
plain Claude on that default profile. It deliberately avoids making another
copy of a rotating login. **`--require-session` refuses this case instead of
pretending it is isolated.** Do not bypass that guard using a dummy config
environment variable or private profile-creation calls. The GUI must distinguish
“current native login” from an isolated account profile and explain a refusal.

Global `switch` updates the live default login. On Linux/WSL, existing native
Claude processes can observe that change on a later request. It must not be
called implicitly when creating another Agent or used for automatic rotation in
this initial integration. Upstream credential locks prevent certain file/refresh
races; they do not make a global switch local to one Agent.

Session history is per account by default; `--share-history` is opt-in. Resume
must retain the original account/profile binding. Do not silently enable shared
history or switch an existing session's account. Native settings and skills are
shared by the upstream launcher according to its own rules; that does not imply
every plugin or MCP OAuth login is also shared.

## Proposed SDK launcher adapter — not yet verified

The installed official TypeScript SDK exposes `spawnClaudeCodeProcess`. That is
the appropriate seam for letting claude-swap choose the native account profile
while the SDK still owns Claude's streaming/control protocol.

There is a concrete stdio obstacle: the upstream `run` command prints launch
notices to stdout, and its [argument parser](https://github.com/realiti4/claude-swap/blob/3a4e5c14873eb5b32f182d55c68da98ac8c0db45/src/claude_swap/cli.py)
has no `run --quiet` or `run --json` option. Those notices would contaminate the
SDK's expected native JSON stream. `list --json` does not solve launch output.

A candidate small WSL launcher can invoke the package's CLI entry point with the
normal `run` arguments while directing **Python's `sys.stdout`** notices to
stderr. On POSIX, upstream then uses `os.execvpe`: the native process can inherit
the original OS stdout descriptor for JSON. This is an inference from source,
not a tested integration. Two details need explicit verification:

- Redirecting OS descriptor 1 would also redirect the exec'd Claude's JSON and
  break the protocol. Redirect the Python notice stream only, with immediate
  flushing; buffered notices can otherwise disappear when `exec` replaces Python.
- Confirm every pre-exec message and failure follows that stream arrangement,
  and preserve native stdin, exit status, signals and process ownership. Do not
  solve this by filtering arbitrary stdout lines, scraping the TUI, monkeypatching
  private account APIs, or copying upstream credential logic.

Prefer a future upstream machine-safe launcher flag if available. Until then,
pin the dependency used by this tiny adapter and test the exact published
version; do not assume arbitrary upstream changes preserve internal behavior.

## Next acceptance boundary

The existing single-account Claude Slice continues with the user's native WSL
login. Account integration is a separate, bounded follow-up: install the chosen
version only when that implementation work is authorized, connect inventory,
then verify two registered accounts running concurrently, native approval and
interrupt, process restart/resume on the same account, token-refresh behavior,
and refusal of the default-account isolation exception. Confirm the ordinary
native login and other running Agents remain on their original accounts.

Yuzuno stores account references and session metadata; claude-swap owns account
material. This assessment establishes a practical reuse direction, not completed
two-account acceptance.
