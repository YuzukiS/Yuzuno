# Claude Slice — isolated acceptance

Checked 2026-10-12. **Implemented and accepted in an independent source snapshot; not merged into the shared Core/UI.** The user explicitly requested that merge wait until the other Agent releases the shared files.

The running test workspace is <http://127.0.0.1:4337/?shell=desktop>. It uses `acceptance/claude/core-data`, `acceptance/claude/source/web/dist`, and `/tmp/yuzuno-next-claude-target/debug/yuzuno-workspace`. The main workspace remains on 4317; the earlier remote lab remains on 4327. No user window was opened, attached to, refreshed, or closed.

## Implementation

- Official `@anthropic-ai/claude-agent-sdk` **0.3.296**, pinned with its own lockfile in `runtimes/claude`, calls the existing WSL Claude Code **2.1.280**. Existing native login is retained; no Windows Claude login, credential extraction, global upgrade, or new account billing configuration is needed.
- Small Node NDJSON bridge owns the SDK query. Rust keeps stable Agent identity, native Claude Session reference, received events, pending actions and conversation projections. Claude's session ID is separate from Codex's thread ID. Legacy Agents default to Codex.
- Native assistant text appears outside folded tool activity. Claude tool cards expose the native tool name, arguments and results. Write approvals show the proposed path and actual text; command approvals show the command. Approval is one action only. Native question options and free-text answers have a dedicated form.
- Interrupt uses the SDK control operation and revokes pending approval callbacks. Native result evidence determines completion or interruption. A result does not imply that every tool succeeded. Lost execution remains unconfirmed; original tasks are not silently resent.
- Resume uses the same native Session and its transcript. It does not claim to resume an interrupted OS command. Native Claude permission settings remain distinct from Codex sandbox/approval settings.

The SDK and maintained open-source implementations were inspected first: [reuse assessment](claude-reuse.md), [runtime contract and official documentation](../runtimes/claude/README.md).

## Real acceptance

All GUI operations below ran in a new headless Chromium profile against the real test Core and WSL Claude, without mocked execution.

| Check | Evidence |
| --- | --- |
| Create Claude Agent, send task, native Write approval survives GUI reload, allow once, tool result, copy final reply, preview artifact at line 2 | `acceptance/claude/gui-create-report.json` |
| Native AskUserQuestion, GUI answer, correct subsequent reply | `acceptance/claude/gui-question-report.json` |
| Stop and restart only the owned test Core; new SDK process resumes exact native Session and recalls prior marker without reading files | `acceptance/claude/gui-resume-report.json` |
| Interrupt an executing turn, reject old approval, continue same Session and recall earlier context | `acceptance/claude/gui-interrupt-report.json` |
| Interrupt while Write awaits approval, verify target file never exists, reject delayed approval | `acceptance/claude/gui-cancel-report.json` |
| Real SDK compatibility, approval, question, interruption and new-process resume | `acceptance/claude/runtime-task/results.json` |
| 1440/900px, light/dark, 20px text, no horizontal overflow or browser errors | `acceptance/claude/visual-report.json` |
| Daily Core process and daily web assets unchanged | `acceptance/claude/daily-verification.json` |

The accepted Agent is `37f564c7-3be9-4417-a220-aa9adbfcef18`; its native Session is `3ce601f6-be75-425e-a81c-852ac93244e0`. It ends idle with no pending action. Real transcript and failed experiments are retained in the test workspace.

Initial automation attempts exposed an incorrect button locator and a long foreground wait rejected by Claude's native tool policy. Their reports are retained as `gui-interrupt-first-attempt.json` and `gui-interrupt-native-block.json`. The final run uses an accepted short task and the actual GUI Interrupt control; no native tool restriction was disabled.

Automated checks passed: **53 Rust tests** (one pre-existing opt-in test ignored), **8 bridge tests**, **20 existing UI tests**, **5 remote UI tests**, **3 Claude approval/question UI tests**, TypeScript compilation and isolated production build. These apply to the isolated snapshot, not to a future merge with the other Agent's changes.

This is a real WSL Harness and browser acceptance. It is **not** a fresh Windows WebView2/DPI acceptance, a remote Claude acceptance, a two-account test, or a claim of complete native CLI feature parity. Unknown SDK events remain in the journal; this slice does not yet present every native feature.

## Handoff

- `acceptance/claude/integration.patch`: reviewable source changes, deliberately not applied.
- `acceptance/claude/integration-manifest.json`: baseline and slice hashes plus shared-file changes observed during this work.
- `acceptance/claude/baseline`: original source used for three-way reconciliation.
- `acceptance/claude/source`: complete buildable implementation and UI tests.
- `runtimes/claude`: independent reusable SDK runtime, already outside shared source files.

Do not replace main files with the snapshot. The other Agent changed `model.rs`, `workspace.rs`, `server.rs`, `App.tsx`, `components.tsx` and `types.ts` in parallel. Preserve its settings, message receipts, direct question submission and context usage; integrate the minimal Claude routes/discriminator separately. The Claude UI test at `source/web/tools/claude-ui.test.mjs` should also be carried across. Root dependencies and locks were not changed by this slice.

After the user announces the merge window: reconcile these files, rerun both sets of checks, then validate the combined build on a separate port before updating the daily UI/Core. Next account work should reuse claude-swap as described in [the account integration assessment](claude-swap.md), beginning with a bounded two-account isolation/Resume probe. No account switching or claude-swap installation occurred in this slice.

Test Core lifecycle commands (process identity and fixed port are checked):

```sh
python3 acceptance/claude/lab.py status
python3 acceptance/claude/lab.py stop
python3 acceptance/claude/lab.py start
python3 acceptance/claude/lab.py verify-daily
```

The browser acceptance runner submits real model tasks. It is not a passive preview and does not automatically retry failed tasks.
