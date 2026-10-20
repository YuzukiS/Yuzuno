# Claude Slice: reuse decisions

Research checked on 2026-10-12. This records choices and observed upstream behavior, not a claim that every upstream feature has passed Yuzuno acceptance.

## Selected dependency

Use the official TypeScript `@anthropic-ai/claude-agent-sdk` in a small, independent WSL runtime. The npm `latest` version observed was **0.3.296**. Pin the dependency and its lockfile under the Claude runtime; do not change the project's other dependency locks or globally upgrade Claude Code.

The SDK owns the Claude subprocess/control protocol. Yuzuno only needs to carry native events and its own commands between Rust Core and that runtime. Use the stable `query()` interface with streaming input, `includePartialMessages`, `canUseTool`, `Query.interrupt()`, and native `resume` references. A persistent query can serve successive turns; a `result` ends a turn, not necessarily the subprocess or background work.

The installed WSL CLI was previously verified as **2.1.280**. The selected SDK is newer. `pathToClaudeCodeExecutable` can select the existing executable, but cross-version behavior must be verified with real conversation, approvals, interrupt, and resume before acceptance. Do not assume matching option names establish compatibility. If it fails, select a compatible SDK version or explicitly isolated official binary rather than silently upgrading the user's CLI.

Sources: [official SDK repository](https://github.com/anthropics/claude-agent-sdk-typescript), [versioned npm package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.296), [TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript), [SDK changelog snapshot](https://github.com/anthropics/claude-agent-sdk-typescript/blob/85d8f8e0772199ec7965a0c2e874ac88343f2a01/CHANGELOG.md).

The TypeScript SDK is governed by Anthropic's Commercial Terms; it is not an MIT/Apache library merely because its public repository is on GitHub. Its license and authentication conditions must be considered separately from the licenses of open-source wrappers. Keep the official WSL authentication flow and do not extract credentials or impersonate another entrypoint.

## Maintained implementations inspected

| Project / snapshot | Maintenance evidence observed | License | Decision |
| --- | --- | --- | --- |
| [Official TypeScript SDK](https://github.com/anthropics/claude-agent-sdk-typescript/tree/85d8f8e0772199ec7965a0c2e874ac88343f2a01) | Not archived; repository pushed 2026-10-09; npm 0.3.296 | Anthropic Commercial Terms | Depend on the official package. |
| [Claude Agent ACP](https://github.com/agentclientprotocol/claude-agent-acp/tree/1137df33aa4fe387916596ff489c02ee48ccbba3) | Not archived; pushed 2026-10-12; package 0.89.1 pins SDK 0.3.293 and ACP SDK 1.8.0 | Apache-2.0 | Consult lifecycle, cancellation, and permission handling. Do not add ACP translation to this Slice. |
| [Happy](https://github.com/slopus/happy/tree/99f415fa0d12d233a80a77fd88122bfb19b17477) | Not archived; pushed 2026-10-11; current source directly wraps the official SDK | MIT | Consult interactive streaming and correlated permission requests. Do not import its complete server or authentication layer. |
| [CloudCLI / Claude Code UI](https://github.com/siteboon/claudecodeui/tree/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014) | Not archived; pushed 2026-10-12; package 1.37.3 depends on SDK ^0.3.165 | AGPL-3.0-or-later | Read for behavioral lessons. No source copied into Yuzuno. |
| [Official Python SDK](https://github.com/anthropics/claude-agent-sdk-python/tree/b6e9d12fe1cc98dde988ab7b7713c1feeee50c6c) | Not archived; pushed 2026-10-09 | MIT wrapper; Claude Code has separate terms | Useful inspectable protocol/lifecycle reference; no second SDK implementation needed in this Slice. |

Maintenance evidence above comes from GitHub repository metadata and the inspected source snapshots, not star counts. It does not establish a support SLA. The historical `zed-industries/claude-code-acp` repository redirects to `agentclientprotocol/claude-agent-acp`; use the current package and repository when following upstream work.

## Specific lessons to reuse

1. **Use native SDK operations.** Happy's [query wrapper](https://github.com/slopus/happy/blob/99f415fa0d12d233a80a77fd88122bfb19b17477/packages/happy-cli/src/claude/sdk/query.ts) delegates to the official SDK and passes native `resume`, model, permission, and `canUseTool` options. There is no reason for this Slice to reimplement Claude's stdin control protocol.
2. **Resolve or cancel each approval exactly once.** Happy's [permission handler](https://github.com/slopus/happy/blob/99f415fa0d12d233a80a77fd88122bfb19b17477/packages/happy-cli/src/claude/utils/permissionHandler.ts) tracks outstanding requests and cleans up AbortSignal listeners. Yuzuno also needs generation-bound IDs so an old UI cannot approve a new process's request.
3. **Broadcast approval settlement.** CloudCLI's [runtime](https://github.com/siteboon/claudecodeui/blob/7c3049fe8e157f12b7add3e496d8d2fe6fa5c014/server/modules/providers/list/claude/claude-runtime.provider.js) records permission resolution on the outgoing stream, preventing reconnect replay from resurrecting an already answered request. This is a behavioral reference, not copied AGPL implementation.
4. **Keep turn, background work, and process state distinct.** The same CloudCLI runtime treats native `result` as turn completion while separately tracking outstanding background tasks. A live subprocess alone must not leave Yuzuno displaying Working forever.
5. **Interrupt is asynchronous.** The ACP adapter's [cancellation path](https://github.com/agentclientprotocol/claude-agent-acp/blob/1137df33aa4fe387916596ff489c02ee48ccbba3/src/acp-agent.ts) distinguishes ended queries, pending turns, and a control request that may stall. Record the request immediately; report native acknowledgement/result or a truthful unknown state. Process termination is a separate escalation, not normal Interrupt.
6. **Choose permission behavior explicitly.** The SDK changelog says that from 0.3.286 an omitted `permissionMode` inherits Claude settings and can resolve to auto. Start this Slice with explicit `permissionMode: 'default'`. Claude's own rules can still allow tools without a callback. `AskUserQuestion` requires an answer UI; it is not an ordinary yes/no tool approval.
7. **Do not infer native session persistence from an in-memory ID.** A session may announce its ID before its transcript is written. Preserve the native ID, persist received events, and verify resume after a completed first turn. Resume does not promise continuation of interrupted tool execution.
8. **Do not copy wrapper-specific environment tricks.** Happy overrides `CLAUDE_CODE_ENTRYPOINT` to affect native resume-picker visibility. Yuzuno should preserve official SDK behavior and use an explicit native session reference; it must not change identity/entrypoint to evade product or account restrictions.

ACP is a viable maintained interoperability choice when an ACP client is actually wanted. Its current adapter includes extensive client tool delegation, subagent, settings, and provider behavior. Introducing it here would add another event/permission translation layer before Yuzuno has established its own Claude UX. The narrower reuse is the official SDK plus a small process bridge.

## Acceptance consequences

- Native assistant text stays prominent; tool events remain structured and retain native IDs.
- Verify a GUI approval survives UI reconnect, settles once, and cannot be reused after interruption or runtime replacement.
- Verify interrupt during execution and during pending approval; neither silently destroys the persistent Agent identity.
- Verify a second turn and a new runtime resuming the same native session.
- Keep SDK raw events for inspection alongside the UI projection; unknown event types must remain inspectable.
- Run all probes with separate ports, data, files, and process ownership. Do not restart the daily Core or rebuild its `web/dist`.
