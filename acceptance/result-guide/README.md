# T-86: result_publish's short entry and the full guide

## Problem

Claude Code 2.1.280 keeps the first 2048 UTF-16 code units of an MCP tool's
description and of a server's instructions. It appends "… [truncated]" and
drops the rest. The limit is `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH ?? 2048`,
applied as `Tool "<name>" description` and `Server instructions`; read from the
CLI's bundled source.

`result_publish`'s description was 3250 code units, so everything from the
Table signature onward was lost: BarChart, Sources, Continue and the closing
rules. Input-schema property descriptions are not cut.

## Change

- **Short entry.** `web/src/intelligent-ui/contract.ts` generates the entry,
  which stays within `MAX_DESCRIPTION_LENGTH` (2048). It names `result_guide`
  in its second sentence, so a client that cuts harder still keeps the pointer.
- **Full guide.** The same file generates the full guide in parts: a header,
  the usage, each component and the rules. Both come from the same catalog
  (`componentProps`, `COMPONENT_DESCRIPTIONS`, the limits); nothing is
  hand-written twice. The signatures state every limit the validator checks:
  - `?` marks an optional prop;
  - `[a-b]` is an array's item count;
  - `≤n` is a string's longest length;
  - Clarification shows each field type's own props.
- **Guide tool.** Core serves the guide as the read-only MCP tool `result_guide`,
  from `contract.json`, with no Node needed. `components` returns only the
  named parts, with the usage and rules.
- **Rejections.** Every `result_publish` rejection carries
  `guide: {tool: "result_guide", components}`: the components its problems are
  in.
- **Other text.** The MCP server instructions, the capability notice and the
  yuzuno skill name the guide.
- **Length checks.** Rust and web tests keep every listed tool description, the
  notice and the server instructions at or under 2048 code units.
- **Shared formatter.** `formatComponentGuide` is exported for other catalogs:
  Home's Brief guide (T-85) reuses it.

## Live lab

```sh
YUZUNO_LAB_CORE=... YUZUNO_LAB_OLD_CORE=... YUZUNO_LAB_OLD_BRIDGE=... \
  python3 acceptance/result-guide/live.py <empty lab folder>
```

The lab runs real Claude (Sonnet) with the normal login, through lab Cores on
ports 4541 and 4542. Each has its own data. The Agents work in an empty folder
outside any checkout. The daily Core is never used; the lab compares its
listener and web/dist, and `~/.claude/settings.json`, before and after.

`cli_view.mjs` shows what Claude Code itself did, with no model turn. It
connects the lab MCP server to an SDK query the way the bridge does, with
`--debug-file`, and returns every "… truncated from X to Y chars" record that
Claude Code wrote. `mcpServerStatus` lists tool names only.

## Results (2026-10-17)

The final run was Yuzuno Job f4ebb38f with a Git guard, on commit
7bc480916918855946170e5249a7b38ba819d6fb with no tracked changes.
- Lab Core: `target/debug`, sha256 `7af4655c…`.
- Bridge: `7abe124d…`.
- `contract.json`: `5e1b9ed4…`.
- Claude Code: 2.1.280.
- The "old" Core is T-23's frozen lab build `fa38bb17…` (from 38bfa6b) with
  its bridge `fc109d7b…`. Its contract files and MCP server code are identical
  to c40b836's, so it serves the old 3250-unit description and 420-unit
  instructions.
- All 14 checks passed. The receipt is `evidence.json` in the lab folder:
  local only, not in Git.

| Phase | Claude Code's own record (`--debug-file`) | What the model did |
| --- | --- | --- |
| old | `Tool "result_publish" description truncated from 3250 to 2048 chars`; no `result_guide` | Saw the description end at `- Table {id, titl… [truncated]` |
| new | 40 Yuzuno tools including `result_guide`; no truncation of any description or of the instructions (463 units) | Saw the entry whole (no mark; quoted its final paragraph), called `result_guide`, and answered from it (below) |
| new, publish | | A Table + BarChart + Sources + Continue result was accepted on the first call |
| new, reject and fix | | A Table row missing a column was rejected: `row_mismatch` with `guide: {tool: "result_guide", components: ["Table"]}`. The fix was accepted |
| new, after a lab Core restart | | Same session: `result_guide` with `components: ["BarChart"]`, answered BarChart's unit is at most 30, and published a BarChart |
| strict (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH=400`) | `Tool "result_publish" description truncated from 1648 to 400 chars`, after the guide's name (character 183) | A fresh Agent saw the entry cut, found `result_guide` named in it, and answered Table rows ≤ 100 and `selectable` |

Answers taken from the guide, with no source code in the Agent's folder:
- Table: up to 8 columns and 100 rows.
- BarChart: up to 24 points.
- Sources: up to 30 items.
- Continue's props: label, instruction, requiresSelection.
- Clarification: 1–8 fields.
- At most one Continue or Clarification per result.
- A form does not authorize permissions.

The lab denied every permission request; none was needed. The daily Core's
listener and web/dist, and `~/.claude/settings.json`, were unchanged. Every lab
Core exited and left no bridge.

Earlier runs, kept as history:
- **Lab-2 (5da46dce, fe5018b).** The model rightly said the guide never stated
  BarChart's unit limit. Signatures now show each string's `≤n` (67a7154).
- **Lab-3 (9afb958c, 67a7154).** The guide's name sat at character 403, past a
  400-unit cut. It moved to 183 (6492ad4).
- **Lab-4 (b2dfb917, 6492ad4).** The behaviour was right, but two of the lab's
  checks tested the model's wording. They now test what the model sees
  (7bc4809).

## Known limits

- **Older sessions.** A session that loaded Yuzuno's tools before this Core
  keeps its old list until it reconnects. It has no `result_guide`, and its
  `result_publish` description is still the old, cut one. A rejection names
  `result_guide` either way. A new session or a reconnect lists the guide.
- **Codex.** The tool is listed for Codex too, through `enabled_tools`. Codex
  was not run in this lab; T-86's window is for Claude only.
- **Other limits.** The 2048 limit is Claude Code 2.1.280's default.
  `MAX_DESCRIPTION_LENGTH` in `contract.ts` is the single place to change if a
  supported client keeps less.
